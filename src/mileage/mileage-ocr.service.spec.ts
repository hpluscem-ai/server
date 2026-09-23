import {
  amountValue,
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
      issues: [],
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
