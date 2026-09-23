import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  amountValue,
  litersValue,
  MileageOcrService,
  type MeterReading,
  type ReceiptReading,
} from '../src/mileage/mileage-ocr.service';

type Case = {
  id: string;
  receiptPath: string;
  meterPath: string;
  truth: {
    receiptAmount: number | null;
    meterAmount: number | null;
    liters: string | null;
  };
};

function option(name: string): string | undefined {
  const position = process.argv.indexOf('--' + name);
  return position < 0 ? undefined : process.argv[position + 1];
}

function outsideRepository(path: string): boolean {
  return relative(process.cwd(), path).startsWith('..' + sep);
}

function limit(name: string): number {
  const value = option(name);
  if (!value || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error('Invalid --' + name);
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error('Invalid --' + name);
  return count;
}

function caseRecord(value: unknown): value is Case {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<Case>;
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.receiptPath === 'string' &&
    isAbsolute(item.receiptPath) &&
    typeof item.meterPath === 'string' &&
    isAbsolute(item.meterPath) &&
    !!item.truth &&
    (item.truth.receiptAmount === null ||
      (Number.isSafeInteger(item.truth.receiptAmount) &&
        item.truth.receiptAmount >= 0)) &&
    (item.truth.meterAmount === null ||
      (Number.isSafeInteger(item.truth.meterAmount) &&
        item.truth.meterAmount >= 0)) &&
    (item.truth.liters === null || typeof item.truth.liters === 'string')
  );
}

async function main(): Promise<void> {
  const manifestPath = option('manifest');
  const outputPath = option('output');
  if (
    !manifestPath ||
    !isAbsolute(manifestPath) ||
    !outputPath ||
    !isAbsolute(outputPath) ||
    !outsideRepository(manifestPath) ||
    !outsideRepository(outputPath)
  )
    throw new Error(
      'Absolute --manifest and --output paths outside the repository are required',
    );
  const clovaLimit = limit('max-clova-calls');
  const lunaLimit = limit('max-luna-calls');
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  const cases = (manifest as { cases?: unknown })?.cases;
  if (!Array.isArray(cases) || !cases.every(caseRecord))
    throw new Error(
      'Manifest must contain cases with absolute image paths and truth',
    );
  const unique = new Map<
    string,
    { item: Case; receipt: Buffer; meter: Buffer }
  >();
  for (const item of cases) {
    if (
      !outsideRepository(item.receiptPath) ||
      !outsideRepository(item.meterPath)
    )
      throw new Error('Sample images must stay outside the repository');
    const [receipt, meter] = await Promise.all([
      readFile(item.receiptPath),
      readFile(item.meterPath),
    ]);
    const hash = createHash('sha256')
      .update(receipt)
      .update(meter)
      .digest('hex');
    if (!unique.has(hash)) unique.set(hash, { item, receipt, meter });
  }
  const live = process.argv.includes('--live');
  const count = unique.size;
  process.stdout.write(
    JSON.stringify({
      mode: live ? 'live' : 'dry-run',
      samples: cases.length,
      uniquePairs: count,
      maxClovaCalls: count,
      maxLunaCalls: count,
    }) + '\n',
  );
  if (!live) return;
  if (clovaLimit < count || lunaLimit < count)
    throw new Error(
      'Explicit provider call limits are lower than unique pairs',
    );
  if (
    !process.env.CLOVA_OCR_INVOKE_URL ||
    !process.env.CLOVA_OCR_SECRET ||
    !process.env.OPENAI_API_KEY
  )
    throw new Error('Provider credentials are missing');
  const service = new MileageOcrService();
  const results: Array<{
    id: string;
    receipt: ReceiptReading | null;
    meter: MeterReading | null;
    clovaError: string | null;
    lunaError: string | null;
    lunaInputTokens: number;
    lunaOutputTokens: number;
    clovaDurationMs: number | null;
    lunaDurationMs: number | null;
  }> = [];
  for (const { item, receipt, meter } of unique.values()) {
    const [clova, luna] = await Promise.allSettled([
      service.readReceipt(receipt),
      service.readMeter(meter),
    ]);
    results.push({
      id: item.id,
      receipt: clova.status === 'fulfilled' ? clova.value.reading : null,
      meter: luna.status === 'fulfilled' ? luna.value.reading : null,
      clovaError: clova.status === 'rejected' ? 'CLOVA_FAILED' : null,
      lunaError: luna.status === 'rejected' ? 'LUNA_FAILED' : null,
      clovaDurationMs:
        clova.status === 'fulfilled' ? clova.value.durationMs : null,
      lunaDurationMs:
        luna.status === 'fulfilled' ? luna.value.durationMs : null,
      lunaInputTokens:
        luna.status === 'fulfilled' ? (luna.value.usage?.inputTokens ?? 0) : 0,
      lunaOutputTokens:
        luna.status === 'fulfilled' ? (luna.value.usage?.outputTokens ?? 0) : 0,
    });
  }
  const truths = new Map(
    [...unique.values()].map(({ item }) => [item.id, item.truth]),
  );
  const stats = {
    receiptExact: 0,
    meterExact: 0,
    litersExact: 0,
    falseMatches: 0,
    manualReview: 0,
    clovaCalls: results.length,
    lunaCalls: results.length,
    lunaInputTokens: 0,
    lunaOutputTokens: 0,
  };
  for (const result of results) {
    const truth = truths.get(result.id)!;
    const receipt = amountValue(result.receipt?.amountText ?? null);
    const meter = amountValue(result.meter?.amountText ?? null);
    const liters = litersValue(result.meter?.litersText ?? null);
    if (receipt === truth.receiptAmount) stats.receiptExact++;
    if (meter === truth.meterAmount) stats.meterExact++;
    if (liters === truth.liters) stats.litersExact++;
    const matched =
      receipt !== null &&
      meter !== null &&
      receipt === meter &&
      result.receipt?.documentKind === 'sale' &&
      result.receipt.issues.length === 0 &&
      result.meter?.issues.length === 0 &&
      liters !== null;
    if (!matched) stats.manualReview++;
    if (matched && truth.receiptAmount !== truth.meterAmount)
      stats.falseMatches++;
    stats.lunaInputTokens += result.lunaInputTokens;
    stats.lunaOutputTokens += result.lunaOutputTokens;
  }
  const lunaUsdEstimate =
    (stats.lunaInputTokens * 0.2 + stats.lunaOutputTokens * 1.2) / 1000000;
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        evaluatedAt: new Date().toISOString(),
        uniquePairs: count,
        stats,
        lunaUsdEstimate,
        clovaBilling:
          'Check account invoice; free tier and API Gateway charges vary',
        results,
      },
      null,
      2,
    ),
    { mode: 0o600, flag: 'wx' },
  );
  process.stdout.write(
    JSON.stringify({ ...stats, lunaUsdEstimate, output: resolve(outputPath) }) +
      '\n',
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? error.message : 'Benchmark failed') + '\n',
  );
  process.exitCode = 1;
});
