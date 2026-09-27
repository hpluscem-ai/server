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
import sharp from 'sharp';
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

  it('reads one or two private photos with Luna and rejects incomplete, refused or malformed outputs', async () => {
    process.env.OPENAI_API_KEY = 'secret';
    const reading = {
      receipt: {
        amountText: '158',
        transactionDateText: '2026-09-10',
        transactionTimeText: '15:26:38',
        quantityText: '0.132',
        quantityUnit: 'L',
        unitPriceText: '1200',
        documentKind: 'mixed',
        approvalNumber: '05697078',
        reprinted: false,
        issues: [],
      },
      meter: {
        amountText: '158',
        litersText: '0.132 L',
        unitPriceText: '1200',
        issues: [],
      },
      mirroredImages: [false],
    };
    const good = (value: unknown = reading) => ({
      status: 'completed',
      output: [
        { content: [{ type: 'output_text', text: JSON.stringify(value) }] },
      ],
      usage: {
        input_tokens: 1200,
        output_tokens: 80,
        input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 0 },
      },
    });
    const respond = (body: unknown) => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(body),
      }) as typeof fetch;
    };
    const service = new MileageOcrService();
    const smallImage = await sharp({
      create: { width: 32, height: 16, channels: 3, background: 'white' },
    })
      .jpeg()
      .toBuffer();
    for (const sizes of [
      [[32, 16]],
      [
        [4096, 2048],
        [2048, 4096],
      ],
      [
        [4096, 4096],
        [2048, 1024],
      ],
    ]) {
      const images = await Promise.all(
        sizes.map(([width, height]) =>
          sharp({ create: { width, height, channels: 3, background: 'white' } })
            .jpeg({ quality: 90 })
            .toBuffer(),
        ),
      );
      const savedImages = images.map((image) => Buffer.from(image));
      const count = images.length;
      respond(good({ ...reading, mirroredImages: Array(count).fill(false) }));
      const result = await service.readApplication(images);
      expect(result.reading.receipt.amountText).toBe('158');
      expect(result.usage).toMatchObject({
        inputTokens: 1200,
        cachedTokens: 1024,
        outputTokens: 80,
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, options] = (global.fetch as jest.Mock).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toBe('https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body as string) as {
        model: string;
        store: boolean;
        input: { content: { image_url: string; detail: string }[] }[];
      };
      expect(body).toMatchObject({ model: 'gpt-6-luna', store: false });
      expect(body.input[1].content).toHaveLength(count);
      expect(JSON.stringify(body)).not.toContain('https://storage');
      for (const [index, [width, height]] of sizes.entries()) {
        const content = body.input[1].content[index];
        expect(content.detail).toBe('high');
        expect(content.image_url).toMatch(/^data:image\/jpeg;base64,/);
        const sentImage = Buffer.from(
          content.image_url.split(',')[1],
          'base64',
        );
        const scale = Math.min(1, 2048 / Math.max(width, height));
        expect(await sharp(sentImage).metadata()).toMatchObject({
          format: 'jpeg',
          width: Math.round(width * scale),
          height: Math.round(height * scale),
        });
        if (scale === 1) expect(sentImage).toEqual(savedImages[index]);
        expect(images[index]).toEqual(savedImages[index]);
      }
    }
    respond({ ...good(), status: 'incomplete' });
    await expect(service.readApplication([smallImage])).rejects.toMatchObject({
      code: 'LUNA_INCOMPLETE',
    });
    respond({ ...good(), output: [{ content: [{ type: 'refusal' }] }] });
    await expect(service.readApplication([smallImage])).rejects.toMatchObject({
      code: 'LUNA_REFUSAL',
    });
    for (const invalid of [
      { ...reading, mirroredImages: [] },
      { ...reading, receipt: {} },
      { ...reading, extra: 1 },
    ]) {
      respond(good(invalid));
      await expect(service.readApplication([smallImage])).rejects.toMatchObject(
        { code: 'LUNA_INVALID_RESPONSE' },
      );
    }
    respond(
      good({
        ...reading,
        receipt: { ...reading.receipt, reprinted: null },
        meter: { ...reading.meter, issues: ['unit_missing'] },
        mirroredImages: [null],
      }),
    );
    const uncertain = await service.readApplication([smallImage]);
    expect(uncertain.reading.meter.litersText).toBeNull();
    expect(uncertain.reading.receipt.issues).toContain('REPRINT_UNCLEAR');
    expect(uncertain.reading.meter.issues).toContain(
      'IMAGE_ORIENTATION_UNCERTAIN',
    );
    respond(good());
    await expect(
      service.readApplication([Buffer.from('invalid image')]),
    ).rejects.toMatchObject({ code: 'LUNA_INVALID_INPUT' });
    expect(global.fetch).not.toHaveBeenCalled();
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
    ['2026-09-23', '12:00:00', '2026-09-23T03:00:00.000Z'],
    ['2026-09-23', '00:00:00', '2026-09-22T15:00:00.000Z'],
  ])(
    'normalizes Korean time and validates explicit offsets %s %s',
    (date, time, expected) => {
      expect(
        transactionAt({
          ...receipt,
          transactionDateText: date,
          transactionTimeText: time,
        }),
      ).toBe(expected);
    },
  );
  it('uses meter liters and matching total, regardless of receipt quantity', () => {
    expect(automaticApprovalAmounts(receipt, meter)).toEqual({
      finalAmount: 11700,
      mileageAmount: 220,
    });
    expect(
      automaticApprovalAmounts(
        { ...receipt, quantityText: null, quantityUnit: 'unknown' },
        meter,
      ),
    ).toEqual({ finalAmount: 11700, mileageAmount: 220 });
  });
  it('requires readable matching amounts and meter liters, not ancillary metadata', () => {
    for (const invalid of [
      null,
      { ...receipt, amountText: null },
      { ...receipt, amountText: '12000' },
    ]) {
      expect(automaticApprovalAmounts(invalid, meter)).toBeNull();
    }
    for (const invalid of [
      null,
      { ...meter, litersText: null },
      { ...meter, litersText: '11' },
      { ...meter, amountText: null },
      { ...meter, amountText: '12000' },
    ]) {
      expect(automaticApprovalAmounts(receipt, invalid)).toBeNull();
    }
    expect(
      automaticApprovalAmounts(
        {
          ...receipt,
          transactionDateText: null,
          transactionTimeText: null,
          documentKind: 'unknown',
          reprinted: null,
          approvalNumber: null,
          issues: ['REPRINT_UNCLEAR'],
        },
        { ...meter, unitPriceText: null, issues: ['단가 판독 불가'] },
      ),
    ).toEqual({ finalAmount: 11700, mileageAmount: 220 });
  });
  it.each([
    '재출력',
    '재발행',
    '외상',
    '미수',
    '주유 안내',
    '결제 취소',
    '영수증 사본',
  ])(
    'does not use %s document metadata to block readable amounts',
    (heading) => {
      const reading = parseReceiptFields([
        field(heading, 0, 0),
        field('결제금액 11700원', 0, 20),
        field('거래일시 2026-09-23 12:34:56+09:00', 0, 40),
      ]);
      expect(automaticApprovalAmounts(reading, meter)).toEqual({
        finalAmount: 11700,
        mileageAmount: 220,
      });
    },
  );
  it.each(['-11700원', '11700.0원', '11700abc', '11700원 / 12000원'])(
    'does not turn unclear amount %s into a positive total',
    (amount) => {
      const reading = parseReceiptFields([
        field('승인', 0, 0),
        field('결제금액 ' + amount, 0, 20),
        field('거래일시 2026-09-23 12:34:56+09:00', 0, 40),
      ]);
      expect(automaticApprovalAmounts(reading, meter)).toBeNull();
    },
  );
  it('does not combine incomplete timestamps from separate labelled rows', () => {
    const reading = parseReceiptFields([
      field('승인', 0, 0),
      field('결제금액 11700원', 0, 20),
      field('거래일시 2026-09-23', 0, 40),
      field('승인일시 12:34:56+09:00', 0, 60),
    ]);
    expect(transactionAt(reading)).toBeNull();
    expect(automaticApprovalAmounts(reading, meter)).toEqual({
      finalAmount: 11700,
      mileageAmount: 220,
    });
  });
  it('retains truncation warnings without blocking clear totals', () => {
    const reading = parseReceiptFields([
      field('승인', 0, 0),
      field('결제금액 11700원', 0, 20),
      field('거래일시 2026-09-23 12:34:56+09:00', 0, 40),
      field('a'.repeat(121) + '취소', 0, 60),
      ...Array.from({ length: 2000 }, () => field('문자', 0, 80)),
    ]);
    expect(automaticApprovalAmounts(reading, meter)).toEqual({
      finalAmount: 11700,
      mileageAmount: 220,
    });
  });
  it.each([
    '29:12:34+09:00',
    '12:34:99+09:00',
    '12:34:56+99:00',
    '12:34:56.123+09:00',
  ])(
    'does not turn malformed time %s into a valid one or block clear amounts',
    (time) => {
      const reading = parseReceiptFields([
        field('승인', 0, 0),
        field('결제금액 11700원', 0, 20),
        field('거래일시 2026-09-23 ' + time, 0, 40),
      ]);
      expect(transactionAt(reading)).toBeNull();
      expect(automaticApprovalAmounts(reading, meter)).toEqual({
        finalAmount: 11700,
        mileageAmount: 220,
      });
    },
  );
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
  it('reports time accuracy separately from amount-based approval truth', () => {
    expect(
      evaluateReading(
        {
          receipt: {
            ...receipt,
            transactionTimeText: null,
            documentKind: 'unknown',
            issues: ['REPRINT_UNCLEAR'],
          },
          meter,
          clovaError: null,
          lunaError: null,
        },
        { ...truth, documentKind: 'unknown' },
      ),
    ).toMatchObject({
      candidate: true,
      verifiedApproval: true,
      falseApproval: false,
      transactionExact: false,
    });
  });
  it.each(['amount', 'liters', 'uncertainty', 'decision'])(
    'flags a wrong %s even if both OCR totals match',
    (kind) => {
      const expected = { ...truth };
      if (kind === 'amount')
        expected.receiptAmount = expected.meterAmount = 12000;
      if (kind === 'liters') expected.liters = '12';
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
  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), 'hplus-ocr-benchmark-'));
    for (const [name, background] of [
      ['receipt', 'white'],
      ['meter', 'black'],
    ])
      await sharp({
        create: { width: 32, height: 16, channels: 3, background },
      })
        .jpeg()
        .toFile(join(folder, name + '.jpg'));
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
          '11',
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
      cumulativeClovaCalls: 0,
      cumulativeLunaCalls: 11,
      stats: { clovaCalls: 0, lunaCalls: 1, verifiedApprovals: 0 },
    });
    expect(report.results[0]).toMatchObject({
      clovaError: null,
      lunaError: 'LUNA_FAILED',
    });
    const calls = readFileSync(join(folder, 'calls'), 'utf8');
    expect(calls.split('call').length - 1).toBe(1);
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
