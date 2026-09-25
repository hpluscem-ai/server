import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateReading } from '../../scripts/benchmark-mileage-ocr';
import {
  amountValue,
  automaticApprovalAmounts,
  mileageFromLiters,
  transactionAt,
  type ReceiptReading,
  type MeterReading,
  litersValue,
  MileageOcrService,
  OcrFailure,
  parseReceiptFields,
} from './mileage-ocr.service';

const field = (inferText: string, x: number, y: number) => ({
  inferText,
  boundingPoly: {
    vertices: [
      { x, y },
      { x: x + 30, y },
      { x: x + 30, y: y + 12 },
      { x, y: y + 12 },
    ],
  },
});

describe('mileage OCR', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CLOVA_OCR_INVOKE_URL;
    delete process.env.CLOVA_OCR_SECRET;
    delete process.env.OPENAI_API_KEY;
  });

  it('uses only labelled receipt amount and transaction time, not nearby numeric text', () => {
    const result = parseReceiptFields([
      field('승인', 0, 0),
      field('결제금액', 0, 20),
      field('12,650원', 100, 20),
      field('계기판', 0, 40),
      field('7,356원', 100, 40),
      field('거래일시', 0, 60),
      field('2026-09-23', 70, 60),
      field('12:34:56', 170, 60),
      field('수량', 0, 80),
      field('11개', 100, 80),
    ]);
    expect(result).toMatchObject({
      amountText: '12650',
      quantityText: '11',
      quantityUnit: 'count',
      documentKind: 'sale',
      transactionDateText: '2026-09-23',
      transactionTimeText: '12:34:56',
      issues: ['MIXED_DOCUMENT'],
    });
  });

  it('leaves ambiguous or cancelled receipts for review', () => {
    const result = parseReceiptFields([
      field('승인취소', 0, 0),
      field('합계 444원', 0, 20),
      field('결제금액 1,200원', 0, 40),
    ]);
    expect(result.amountText).toBeNull();
    expect(result.documentKind).toBe('mixed');
    expect(result.issues).toContain('AMOUNT_AMBIGUOUS');
  });

  it('validates exact amount and litre units', () => {
    expect(amountValue('11,700원')).toBe(11700);
    expect(amountValue('11.7')).toBeNull();
    expect(litersValue('11.000 L')).toBe('11.000');
    expect(litersValue('11개')).toBeNull();
    expect(litersValue('11')).toBeNull();
  });

  it('sends one private CLOVA General V2 request and checks inferResult', async () => {
    process.env.CLOVA_OCR_INVOKE_URL = 'https://test.apigw.ntruss.com/general';
    process.env.CLOVA_OCR_SECRET = 'secret';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          images: [{ inferResult: 'SUCCESS', fields: [field('승인', 0, 0)] }],
        }),
    }) as typeof fetch;
    await new MileageOcrService().readReceipt(Buffer.from('private'));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const call = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      version: 'V2',
      lang: 'ko',
      enableTableDetection: false,
    });
    expect(body.images).toEqual([
      {
        format: 'jpg',
        name: 'receipt',
        data: Buffer.from('private').toString('base64'),
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('https://storage');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ images: [{ inferResult: 'FAILURE', fields: [] }] }),
    }) as typeof fetch;
    await expect(
      new MileageOcrService().readReceipt(Buffer.from('x')),
    ).rejects.toMatchObject({
      code: 'CLOVA_INFER_FAILED',
    } satisfies Partial<OcrFailure>);
  });

  it('parses one completed Luna output and rejects incomplete or refused outputs', async () => {
    process.env.OPENAI_API_KEY = 'secret';
    const good = {
      status: 'completed',
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                amountText: '7,356원',
                litersText: '11.000 L',
                unitPriceText: null,
                issues: [],
              }),
            },
          ],
        },
      ],
      usage: { input_tokens: 1200, output_tokens: 65 },
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(good),
    }) as typeof fetch;
    const result = await new MileageOcrService().readMeter(
      Buffer.from('meter'),
    );
    expect(result.reading.amountText).toBe('7,356원');
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 65 });
    const call = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'gpt-5.6-luna', store: false });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...good, status: 'incomplete' }),
    }) as typeof fetch;
    await expect(
      new MileageOcrService().readMeter(Buffer.from('meter')),
    ).rejects.toMatchObject({ code: 'LUNA_INCOMPLETE' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ...good,
          output: [{ content: [{ type: 'refusal', refusal: 'no' }] }],
        }),
    }) as typeof fetch;
    await expect(
      new MileageOcrService().readMeter(Buffer.from('meter')),
    ).rejects.toMatchObject({ code: 'LUNA_REFUSAL' });
  });
});

describe('automatic approval evidence', () => {
  const receipt: ReceiptReading = {
    amountText: '11,700원',
    transactionDateText: '2026-09-23',
    transactionTimeText: '12:34:56+09:00',
    quantityText: '11',
    quantityUnit: 'count',
    unitPriceText: null,
    documentKind: 'sale',
    issues: [],
  };
  const meter: MeterReading = {
    amountText: '11700',
    litersText: '11.000 L',
    unitPriceText: null,
    issues: [],
  };
  it.each<[string, number | null]>([
    ['0.025 L', 1],
    ['0.024 L', 0],
    ['11.000 L', 220],
    ['1.025 ℓ', 21],
    ['99999.999 L', 2000000],
    ['11개', null],
    ['11', null],
    ['-1 L', null],
    ['1.0001 L', null],
    ['1e3 L', null],
  ])('rounds exact decimal liters %s', (raw, expected) => {
    expect(mileageFromLiters(raw)).toBe(expected);
  });
  it.each([
    ['2026-9-23', '12:34:56+09:00', '2026-09-23T03:34:56.000Z'],
    ['2026/09/23', '03:34:56Z', '2026-09-23T03:34:56.000Z'],
    ['2024.02.29', '00:00:00Z', '2024-02-29T00:00:00.000Z'],
    ['2026-02-29', '12:00:00Z', null],
    ['2026-04-31', '12:00:00Z', null],
    ['2026-00-01', '12:00:00Z', null],
    ['2026-09-23', '24:00:00Z', null],
    ['2026-09-23', '12:60:00Z', null],
    ['2026-09-23', '12:00:60Z', null],
    ['2026-09-23', '12:00:00+24:00', null],
    ['2026-09-23', '12:00:00+09:60', null],
    ['2026-09-23', '12:00+09:00', null],
    ['2026-09-23', '12:00:00', null],
  ])('validates calendar and explicit time %s %s', (date, time, expected) => {
    expect(
      transactionAt({
        ...receipt,
        transactionDateText: date,
        transactionTimeText: time,
      }),
    ).toBe(expected);
  });
  it('uses meter liters and matching total, regardless of receipt quantity', () => {
    expect(
      automaticApprovalAmounts(receipt, meter, transactionAt(receipt)),
    ).toEqual({ finalAmount: 11700, mileageAmount: 220 });
    expect(
      automaticApprovalAmounts(
        { ...receipt, quantityText: null, quantityUnit: 'unknown' },
        meter,
        transactionAt(receipt),
      ),
    ).toEqual({ finalAmount: 11700, mileageAmount: 220 });
  });
  it('requires the actual complete evidence, including the same valid timestamp', () => {
    for (const invalid of [
      null,
      { ...receipt, issues: ['unclear'] },
      { ...receipt, documentKind: 'cancel' as const },
      { ...receipt, amountText: '12000' },
      { ...receipt, transactionTimeText: null },
    ]) {
      expect(
        automaticApprovalAmounts(invalid, meter, transactionAt(receipt)),
      ).toBeNull();
    }
    for (const invalid of [
      null,
      { ...meter, issues: ['unclear'] },
      { ...meter, litersText: '11' },
      { ...meter, amountText: '12000' },
    ]) {
      expect(
        automaticApprovalAmounts(receipt, invalid, transactionAt(receipt)),
      ).toBeNull();
    }
    expect(automaticApprovalAmounts(receipt, meter, null)).toBeNull();
    expect(
      automaticApprovalAmounts(receipt, meter, '2026-09-23T03:34:57.000Z'),
    ).toBeNull();
  });
  it.each([
    '재출력',
    '재발행',
    '외상',
    '미수',
    '주유 안내',
    '결제 취소',
    '영수증 사본',
  ])('keeps %s out of automatic approval', (heading) => {
    const reading = parseReceiptFields([
      field(heading, 0, 0),
      field('결제금액 11700원', 0, 20),
      field('거래일시 2026-09-23 12:34:56+09:00', 0, 40),
    ]);
    expect(
      automaticApprovalAmounts(reading, meter, transactionAt(reading)),
    ).toBeNull();
  });
  it.each(['-11700원', '11700.0원', '11700abc', '11700원 / 12000원'])(
    'does not turn unclear amount %s into a positive total',
    (amount) => {
      const reading = parseReceiptFields([
        field('승인', 0, 0),
        field('결제금액 ' + amount, 0, 20),
        field('거래일시 2026-09-23 12:34:56+09:00', 0, 40),
      ]);
      expect(
        automaticApprovalAmounts(reading, meter, transactionAt(reading)),
      ).toBeNull();
    },
  );
  it('does not combine incomplete timestamps from separate labelled rows', () => {
    const reading = parseReceiptFields([
      field('승인', 0, 0),
      field('결제금액 11700원', 0, 20),
      field('거래일시 2026-09-23', 0, 40),
      field('승인일시 12:34:56+09:00', 0, 60),
    ]);
    expect(
      automaticApprovalAmounts(reading, meter, transactionAt(reading)),
    ).toBeNull();
  });
  it('keeps truncated documents pending instead of ignoring their unread remainder', () => {
    const reading = parseReceiptFields([
      field('승인', 0, 0),
      field('결제금액 11700원', 0, 20),
      field('거래일시 2026-09-23 12:34:56+09:00', 0, 40),
      field('a'.repeat(121) + '취소', 0, 60),
      ...Array.from({ length: 2000 }, () => field('문자', 0, 80)),
    ]);
    expect(
      automaticApprovalAmounts(reading, meter, transactionAt(reading)),
    ).toBeNull();
  });
  it.each([
    '29:12:34+09:00',
    '12:34:99+09:00',
    '12:34:56+99:00',
    '12:34:56.123+09:00',
  ])('does not truncate malformed time %s into a valid one', (time) => {
    const reading = parseReceiptFields([
      field('승인', 0, 0),
      field('결제금액 11700원', 0, 20),
      field('거래일시 2026-09-23 ' + time, 0, 40),
    ]);
    expect(
      automaticApprovalAmounts(reading, meter, transactionAt(reading)),
    ).toBeNull();
  });
});

describe('OCR benchmark approval truth', () => {
  const receipt: ReceiptReading = {
    amountText: '11700',
    transactionDateText: '2026-09-23',
    transactionTimeText: '12:34:56+09:00',
    quantityText: null,
    quantityUnit: 'unknown',
    unitPriceText: null,
    documentKind: 'sale',
    issues: [],
  };
  const meter: MeterReading = {
    amountText: '11700',
    litersText: '11.000 L',
    unitPriceText: null,
    issues: [],
  };
  const truth = {
    receiptAmount: 11700,
    meterAmount: 11700,
    liters: '11',
    transactionAt: '2026-09-23T03:34:56.000Z',
    documentKind: 'sale' as const,
    uncertain: false,
    autoApprove: true,
  };
  it('recognizes a correct approval candidate using every known truth field', () => {
    expect(
      evaluateReading(
        { receipt, meter, clovaError: null, lunaError: null },
        truth,
      ),
    ).toMatchObject({
      candidate: true,
      verifiedApproval: true,
      falseApproval: false,
      unverifiedApproval: false,
      receiptExact: true,
      meterExact: true,
      litersExact: true,
      transactionExact: true,
    });
  });
  it.each(['amount', 'liters', 'time', 'sale', 'uncertainty', 'decision'])(
    'flags a wrong %s even if both OCR totals match',
    (kind) => {
      const expected = { ...truth };
      if (kind === 'amount')
        expected.receiptAmount = expected.meterAmount = 12000;
      if (kind === 'liters') expected.liters = '12';
      if (kind === 'time') expected.transactionAt = '2026-09-23T03:35:56.000Z';
      if (kind === 'sale') expected.documentKind = 'cancel' as 'sale';
      if (kind === 'uncertainty') expected.uncertain = true;
      if (kind === 'decision') expected.autoApprove = false;
      expect(
        evaluateReading(
          { receipt, meter, clovaError: null, lunaError: null },
          expected,
        ),
      ).toMatchObject({
        candidate: true,
        verifiedApproval: false,
        falseApproval: true,
      });
    },
  );
  it('does not count missing truth or null readings as exact or verified', () => {
    const missing = { receiptAmount: null, meterAmount: null, liters: null };
    expect(
      evaluateReading(
        { receipt: null, meter: null, clovaError: null, lunaError: null },
        missing,
      ),
    ).toMatchObject({
      receiptExact: false,
      meterExact: false,
      litersExact: false,
      transactionExact: false,
      verifiedApproval: false,
    });
    expect(
      evaluateReading(
        { receipt, meter, clovaError: null, lunaError: null },
        missing,
      ),
    ).toMatchObject({
      candidate: true,
      verifiedApproval: false,
      unverifiedApproval: true,
    });
  });
  it.each([
    { clovaError: 'CLOVA_FAILED', lunaError: null },
    { clovaError: '', lunaError: null },
    { clovaError: null, lunaError: '' },
  ])(
    'excludes provider failures %j even when cached readings look valid',
    (errors) => {
      expect(
        evaluateReading({ receipt, meter, ...errors }, truth),
      ).toMatchObject({
        candidate: false,
        verifiedApproval: false,
      });
    },
  );
});

describe('benchmark CLI without external calls', () => {
  let folder: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'hplus-ocr-benchmark-'));
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });
  const reading = {
    receipt: {
      amountText: '12000',
      transactionDateText: '2026-09-23',
      transactionTimeText: '12:34:56+09:00',
      quantityText: null,
      quantityUnit: 'unknown',
      unitPriceText: null,
      documentKind: 'sale',
      issues: [],
    },
    meter: {
      amountText: '12000',
      litersText: '11 L',
      unitPriceText: null,
      issues: [],
    },
    clovaError: null,
    lunaError: null,
  };
  function setup() {
    const receiptPath = join(folder, 'receipt.jpg'),
      meterPath = join(folder, 'meter.jpg');
    writeFileSync(receiptPath, 'synthetic receipt');
    writeFileSync(meterPath, 'synthetic meter');
    const item = {
      id: 'one',
      receiptPath,
      meterPath,
      truth: {
        receiptAmount: 11700,
        meterAmount: 11700,
        liters: '11',
        transactionAt: '2026-09-23T03:34:56.000Z',
        documentKind: 'sale',
        uncertain: false,
        autoApprove: true,
      },
    };
    const manifest = join(folder, 'manifest.json');
    writeFileSync(
      manifest,
      JSON.stringify({ cases: [item, { ...item, id: 'duplicate' }] }),
    );
    const preload = join(folder, 'fake-fetch.cjs');
    writeFileSync(
      preload,
      `const fs = require('node:fs'); global.fetch = async () => { fs.appendFileSync(${JSON.stringify(join(folder, 'calls'))}, 'call\\n'); throw new Error('simulated timeout'); };`,
    );
    return { item, manifest, preload, output: join(folder, 'output.json') };
  }
  function run(args: string[], preload: string) {
    return spawnSync(
      process.execPath,
      [
        '-r',
        require.resolve('ts-node/register'),
        '-r',
        preload,
        resolve(__dirname, '../../scripts/benchmark-mileage-ocr.ts'),
        ...args,
      ],
      {
        cwd: resolve(__dirname, '../..'),
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          TS_NODE_TRANSPILE_ONLY: 'true',
          CLOVA_OCR_INVOKE_URL: 'https://example.invalid/general',
          CLOVA_OCR_SECRET: 'mock',
          OPENAI_API_KEY: 'mock',
        },
      },
    );
  }
  it('dry-runs unique pairs and rejects exhausted or unspecified prior budgets before calling', () => {
    const { manifest, output, preload } = setup();
    const args = ['--manifest', manifest, '--output', output];
    const dry = run(args, preload);
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({
      samples: 2,
      uniquePairs: 1,
    });
    const budget = [
      '--live',
      '--max-clova-calls',
      '11',
      '--max-luna-calls',
      '11',
    ];
    expect(run([...args, ...budget], preload).status).toBe(1);
    expect(
      run(
        [
          ...args,
          ...budget,
          '--used-clova-calls',
          '11',
          '--used-luna-calls',
          '10',
        ],
        preload,
      ).status,
    ).toBe(1);
    expect(existsSync(join(folder, 'calls'))).toBe(false);
    expect(existsSync(output)).toBe(false);
  });
  it('counts failed calls once and refuses an existing output before another charge', () => {
    const { manifest, output, preload } = setup();
    const args = [
      '--manifest',
      manifest,
      '--output',
      output,
      '--live',
      '--max-clova-calls',
      '11',
      '--max-luna-calls',
      '11',
      '--used-clova-calls',
      '10',
      '--used-luna-calls',
      '10',
    ];
    const result = run(args, preload);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(readFileSync(output, 'utf8')) as {
      results: unknown[];
      evaluations: unknown[];
    };
    expect(report).toMatchObject({
      cumulativeClovaCalls: 11,
      cumulativeLunaCalls: 11,
      stats: { clovaCalls: 1, lunaCalls: 1, verifiedApprovals: 0 },
    });
    expect(report.results[0]).toMatchObject({
      clovaError: 'CLOVA_FAILED',
      lunaError: 'LUNA_FAILED',
    });
    const calls = readFileSync(join(folder, 'calls'), 'utf8');
    expect(calls.split('call').length - 1).toBe(2);
    expect(run(args, preload).status).toBe(1);
    expect(readFileSync(join(folder, 'calls'), 'utf8')).toBe(calls);
  });
  it('replays existing readings against truth without opening images or calling providers', () => {
    const { item, manifest, output, preload } = setup();
    writeFileSync(
      manifest,
      JSON.stringify({
        cases: [
          {
            ...item,
            receiptPath: join(folder, 'absent'),
            meterPath: join(folder, 'absent-meter'),
          },
        ],
      }),
    );
    const results = join(folder, 'readings.json');
    writeFileSync(
      results,
      JSON.stringify({ results: [{ id: 'one', ...reading }] }),
    );
    expect(
      run(
        ['--manifest', manifest, '--output', output, '--results', results],
        preload,
      ).status,
    ).toBe(0);
    const report = JSON.parse(readFileSync(output, 'utf8')) as {
      results: unknown[];
      evaluations: unknown[];
    };
    expect(report.evaluations[0]).toMatchObject({
      falseMatch: true,
      falseApproval: true,
      verifiedApproval: false,
    });
    expect(report).toMatchObject({ clovaCalls: 0, lunaCalls: 0 });
    expect(existsSync(join(folder, 'calls'))).toBe(false);
  });
  it('rejects conflicting truth for the same image pair before calling', () => {
    const { item, manifest, output, preload } = setup();
    writeFileSync(
      manifest,
      JSON.stringify({
        cases: [
          item,
          {
            ...item,
            id: 'conflict',
            truth: { ...item.truth, receiptAmount: 12000 },
          },
        ],
      }),
    );
    const result = run(['--manifest', manifest, '--output', output], preload);
    expect(result.status).toBe(1);
    expect(existsSync(join(folder, 'calls'))).toBe(false);
  });
});
