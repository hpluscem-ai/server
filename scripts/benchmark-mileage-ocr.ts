import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  amountValue,
  automaticApprovalAmounts,
  transactionAt,
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
    transactionAt?: string | null;
    documentKind?: ReceiptReading['documentKind'] | null;
    uncertain?: boolean | null;
    autoApprove?: boolean | null;
  };
};

type ReadingResult = {
  receipt: ReceiptReading | null;
  meter: MeterReading | null;
  clovaError: string | null;
  lunaError: string | null;
};

export function evaluateReading(result: ReadingResult, truth: Case['truth']) {
  const receipt = amountValue(result.receipt?.amountText ?? null);
  const meter = amountValue(result.meter?.amountText ?? null);
  const liters = litersValue(result.meter?.litersText ?? null);
  const at = transactionAt(result.receipt);
  const candidate =
    result.clovaError === null &&
    result.lunaError === null &&
    automaticApprovalAmounts(result.receipt, result.meter) !== null;
  const receiptExact =
    truth.receiptAmount !== null && receipt === truth.receiptAmount;
  const meterExact = truth.meterAmount !== null && meter === truth.meterAmount;
  const litersExact =
    truth.liters !== null &&
    liters !== null &&
    Number(liters) === Number(truth.liters);
  const transactionExact = Boolean(
    truth.transactionAt && at === truth.transactionAt,
  );
  const complete =
    truth.receiptAmount !== null &&
    truth.meterAmount !== null &&
    truth.liters !== null &&
    typeof truth.autoApprove === 'boolean';
  const wrong =
    (truth.receiptAmount !== null && !receiptExact) ||
    (truth.meterAmount !== null && !meterExact) ||
    (truth.liters !== null && !litersExact) ||
    truth.uncertain === true ||
    truth.autoApprove === false;
  return {
    receiptExact,
    meterExact,
    litersExact,
    transactionExact,
    candidate,
    falseMatch:
      receipt !== null &&
      receipt === meter &&
      ((truth.receiptAmount !== null && !receiptExact) ||
        (truth.meterAmount !== null && !meterExact)),
    falseApproval: candidate && wrong,
    missedApproval: !candidate && truth.autoApprove === true,
    decisionExact:
      typeof truth.autoApprove === 'boolean' && candidate === truth.autoApprove,
    verifiedApproval: candidate && complete && !wrong,
    unverifiedApproval: candidate && !complete && !wrong,
  };
}

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
    (item.truth.liters === null ||
      (typeof item.truth.liters === 'string' &&
        litersValue(item.truth.liters + ' L') !== null)) &&
    (item.truth.transactionAt == null ||
      (typeof item.truth.transactionAt === 'string' &&
        Number.isFinite(Date.parse(item.truth.transactionAt)) &&
        new Date(item.truth.transactionAt).toISOString() ===
          item.truth.transactionAt)) &&
    (item.truth.documentKind == null ||
      ['sale', 'cancel', 'mixed', 'unknown'].includes(
        item.truth.documentKind,
      )) &&
    (item.truth.uncertain == null ||
      typeof item.truth.uncertain === 'boolean') &&
    (item.truth.autoApprove == null ||
      typeof item.truth.autoApprove === 'boolean')
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
  const replayPath = option('results');
  const live = process.argv.includes('--live');
  if (
    replayPath &&
    (live || !isAbsolute(replayPath) || !outsideRepository(replayPath))
  )
    throw new Error(
      '--results requires an outside-repository absolute path and cannot use --live',
    );
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  const cases = (manifest as { cases?: unknown })?.cases;
  if (!Array.isArray(cases) || !cases.every(caseRecord))
    throw new Error(
      'Manifest must contain cases with absolute image paths and truth',
    );
  if (new Set(cases.map((item) => item.id)).size !== cases.length)
    throw new Error('Duplicate case ids');
  if (replayPath) {
    const saved = JSON.parse(await readFile(replayPath, 'utf8')) as {
      results?: unknown[];
    };
    if (!Array.isArray(saved.results))
      throw new Error('Saved results are missing');
    const evaluations = saved.results.map((raw) => {
      const result = raw as ReadingResult & { id: string };
      const item = cases.find((item) => item.id === result.id);
      if (!item || !validSavedReading(result))
        throw new Error('Invalid saved reading or missing truth case');
      return { id: item.id, ...evaluateReading(result, item.truth) };
    });
    if (new Set(evaluations.map((item) => item.id)).size !== evaluations.length)
      throw new Error('Duplicate result ids');
    const report = {
      mode: 'replay',
      source: replayPath,
      evaluatedAt: new Date().toISOString(),
      clovaCalls: 0,
      lunaCalls: 0,
      missingResults: cases.length - evaluations.length,
      evaluations,
    };
    await writeFile(outputPath, JSON.stringify(report, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    process.stdout.write(
      JSON.stringify({
        mode: 'replay',
        evaluated: evaluations.length,
        clovaCalls: 0,
        lunaCalls: 0,
        output: outputPath,
      }) + '\n',
    );
    return;
  }
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
    const previous = unique.get(hash);
    if (previous && !isDeepStrictEqual(previous.item.truth, item.truth))
      throw new Error('Conflicting truth for identical image pairs');
    if (!previous) unique.set(hash, { item, receipt, meter });
  }
  const count = unique.size;
  process.stdout.write(
    JSON.stringify({
      mode: live ? 'live' : 'dry-run',
      samples: cases.length,
      uniquePairs: count,
      maxClovaCalls: 0,
      maxLunaCalls: count,
    }) + '\n',
  );
  if (!live) return;
  const lunaLimit = limit('max-luna-calls');
  const clovaUsed = 0;
  const lunaUsed = limit('used-luna-calls');
  if (lunaLimit - lunaUsed < count)
    throw new Error(
      'Remaining approved provider calls are lower than unique pairs',
    );
  if (!process.env.OPENAI_API_KEY)
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
  // Reserve attempts durably before calling; a crash must not silently restore paid budget.
  let reservedPairs = 0;
  const writeReport = async (report: object, initial = false) => {
    const contents = JSON.stringify(report, null, 2);
    if (initial)
      await writeFile(outputPath, contents, { mode: 0o600, flag: 'wx' });
    else {
      await writeFile(outputPath + '.next', contents, {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(outputPath + '.next', outputPath);
    }
  };
  const save = (initial = false) =>
    writeReport(
      {
        evaluatedAt: new Date().toISOString(),
        clovaCalls: 0,
        lunaCalls: reservedPairs,
        cumulativeClovaCalls: clovaUsed,
        cumulativeLunaCalls: lunaUsed + reservedPairs,
        results,
      },
      initial,
    );
  await save(true);
  for (const { item, receipt, meter } of unique.values()) {
    reservedPairs++;
    await save();
    const [luna] = await Promise.allSettled([
      service.readApplication(
        receipt.equals(meter) ? [receipt] : [receipt, meter],
      ),
    ]);
    results.push({
      id: item.id,
      receipt: luna.status === 'fulfilled' ? luna.value.reading.receipt : null,
      meter: luna.status === 'fulfilled' ? luna.value.reading.meter : null,
      clovaError: null,
      lunaError: luna.status === 'rejected' ? 'LUNA_FAILED' : null,
      clovaDurationMs: null,
      lunaDurationMs:
        luna.status === 'fulfilled' ? luna.value.durationMs : null,
      lunaInputTokens:
        luna.status === 'fulfilled' ? (luna.value.usage?.inputTokens ?? 0) : 0,
      lunaOutputTokens:
        luna.status === 'fulfilled' ? (luna.value.usage?.outputTokens ?? 0) : 0,
    });
    await save();
  }
  const truths = new Map(
    [...unique.values()].map(({ item }) => [item.id, item.truth]),
  );
  const stats = {
    receiptExact: 0,
    meterExact: 0,
    litersExact: 0,
    falseMatches: 0,
    transactionExact: 0,
    falseApprovals: 0,
    missedApprovals: 0,
    decisionExact: 0,
    verifiedApprovals: 0,
    unverifiedApprovals: 0,
    manualReview: 0,
    clovaCalls: 0,
    lunaCalls: results.length,
    lunaInputTokens: 0,
    lunaOutputTokens: 0,
  };
  for (const result of results) {
    const truth = truths.get(result.id)!;
    const evaluation = evaluateReading(result, truth);
    if (evaluation.receiptExact) stats.receiptExact++;
    if (evaluation.meterExact) stats.meterExact++;
    if (evaluation.litersExact) stats.litersExact++;
    if (evaluation.transactionExact) stats.transactionExact++;
    if (evaluation.falseMatch) stats.falseMatches++;
    if (evaluation.falseApproval) stats.falseApprovals++;
    if (evaluation.missedApproval) stats.missedApprovals++;
    if (evaluation.decisionExact) stats.decisionExact++;
    if (evaluation.verifiedApproval) stats.verifiedApprovals++;
    if (evaluation.unverifiedApproval) stats.unverifiedApprovals++;
    if (!evaluation.candidate) stats.manualReview++;
    stats.lunaInputTokens += result.lunaInputTokens;
    stats.lunaOutputTokens += result.lunaOutputTokens;
  }
  await writeReport({
    evaluatedAt: new Date().toISOString(),
    uniquePairs: count,
    stats,
    cumulativeClovaCalls: clovaUsed,
    cumulativeLunaCalls: lunaUsed + reservedPairs,
    billing: 'Use actual account usage and invoices; no fixed-price estimate',
    results,
  });
  process.stdout.write(
    JSON.stringify({ ...stats, output: resolve(outputPath) }) + '\n',
  );
}

if (require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(
      (error instanceof Error ? error.message : 'Benchmark failed') + '\n',
    );
    process.exitCode = 1;
  });

function validSavedReading(value: ReadingResult): boolean {
  const strings = (object: object, keys: string[]) =>
    keys.every((key) => {
      const field = (object as Record<string, unknown>)[key];
      return field === null || typeof field === 'string';
    });
  const issues = (reading: { issues: unknown }) =>
    Array.isArray(reading.issues) &&
    reading.issues.every((issue) => typeof issue === 'string');
  return (
    (value.clovaError === null || typeof value.clovaError === 'string') &&
    (value.lunaError === null || typeof value.lunaError === 'string') &&
    (value.receipt === null ||
      (typeof value.receipt === 'object' &&
        strings(value.receipt, [
          'amountText',
          'transactionDateText',
          'transactionTimeText',
          'quantityText',
          'unitPriceText',
        ]) &&
        ['sale', 'cancel', 'mixed', 'unknown'].includes(
          value.receipt.documentKind,
        ) &&
        issues(value.receipt))) &&
    (value.meter === null ||
      (typeof value.meter === 'object' &&
        strings(value.meter, ['amountText', 'litersText', 'unitPriceText']) &&
        issues(value.meter)))
  );
}
