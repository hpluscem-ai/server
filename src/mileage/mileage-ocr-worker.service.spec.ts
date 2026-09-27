import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { eq, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import {
  logisticsCompanies,
  mileageApplications,
  mileageOcrJobs,
  mileagePhotos,
  settlements,
  users,
} from '../database/schema';
import { AdminAuthRepository } from '../admin-auth';
import { AdminMileageService } from '../admin-mileage/admin-mileage.service';
import { SettlementsService } from '../settlements';
import { MileageRepository, type OcrResult } from './mileage.repository';
import {
  MileageOcrService,
  type ProviderResult,
  type ReceiptReading,
  type MeterReading,
} from './mileage-ocr.service';
import { MileageOcrWorkerService } from './mileage-ocr-worker.service';
import { PhotoStorageService } from './photo-storage.service';
import { createTestDatabase } from '../../test/helpers/create-test-database';

describe('MileageOcrWorkerService', () => {
  let database: DatabaseService;
  let repository: MileageRepository;
  let ocr: MileageOcrService;
  let worker: MileageOcrWorkerService;
  let receiptCall: jest.Mock<Promise<ProviderResult<ReceiptReading>>, []>;
  let meterCall: jest.Mock<Promise<ProviderResult<MeterReading>>, []>;
  let applicationId: string;
  const userId = randomUUID();
  const companyId = randomUUID();

  beforeEach(async () => {
    delete process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED;
    process.env.MILEAGE_OCR_CLOVA_DAILY_LIMIT = '10';
    process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT = '10';
    database = await createTestDatabase();
    repository = new MileageRepository(database);
    await database.db.insert(logisticsCompanies).values({
      id: companyId,
      businessName: '테스트',
      businessNumber: randomUUID(),
      corporateRegistrationNumber: randomUUID(),
      businessAddress: '주소',
      managerName: '담당자',
      managerPhone: '010',
      bankCode: '19',
      accountNumber: '123',
      accountHolder: '테스트',
    });
    await database.db.insert(users).values({
      id: userId,
      role: 'driver',
      email: 'ocr@example.com',
      name: '기사',
      phone: '010-1111-2222',
      logisticsCompanyId: companyId,
      passwordHash: 'test-hash',
      serviceTermsConsent: true,
      privacyTermsConsent: true,
    });
    ocr = new MileageOcrService();
    jest.spyOn(ocr, 'isConfigured').mockReturnValue(true);
    receiptCall = jest
      .fn<Promise<ProviderResult<ReceiptReading>>, []>()
      .mockResolvedValue({
        reading: {
          amountText: '11700',
          transactionDateText: '2026-09-23',
          transactionTimeText: '12:34:56',
          quantityText: '11.000',
          quantityUnit: 'L',
          unitPriceText: null,
          documentKind: 'sale',
          issues: [],
        },
        durationMs: 10,
      });
    meterCall = jest
      .fn<Promise<ProviderResult<MeterReading>>, []>()
      .mockResolvedValue({
        reading: {
          amountText: '11,700원',
          litersText: '11.000 L',
          unitPriceText: null,
          issues: [],
        },
        durationMs: 12,
        usage: { inputTokens: 1000, outputTokens: 50 },
      });
    jest.spyOn(ocr, 'readApplication').mockImplementation(async (images) => {
      const [receipt, meter] = await Promise.all([receiptCall(), meterCall()]);
      return {
        reading: {
          receipt: receipt.reading,
          meter: meter.reading,
          mirroredImages: images.map(() => false),
        },
        durationMs: 22,
        usage: meter.usage,
      };
    });
    const storage = {
      get: jest.fn().mockResolvedValue(Buffer.from('private photo')),
    } as unknown as PhotoStorageService;
    worker = new MileageOcrWorkerService(repository, ocr, storage);
    applicationId = await createApplication();
  });

  afterEach(async () => {
    await worker?.onModuleDestroy();
    delete process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED;
    jest.useRealTimers();
    if (database) await database.onApplicationShutdown();
    delete process.env.MILEAGE_OCR_CLOVA_DAILY_LIMIT;
    delete process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT;
    jest.restoreAllMocks();
  });

  async function createApplication(
    requestHash = 'a'.repeat(64),
    ownerId = userId,
  ) {
    const id = randomUUID();
    await repository.commit({
      id,
      userId: ownerId,
      logisticsCompanyId: companyId,
      idempotencyKey: randomUUID(),
      requestHash,
      queueOcr: true,
      photos: (['receipt', 'meter'] as const).map((kind) => ({
        kind,
        storageKey: 'mileage/' + id + '/' + kind + '.jpg',
        contentType: 'image/jpeg',
        byteSize: 100,
        originalStorageKey: 'mileage/' + id + '/' + kind + '-original',
        originalContentType: 'image/jpeg',
        originalByteSize: 100,
      })),
    });
    return id;
  }

  it.each([1, 2])(
    'bounds mirrored correction and accounts every reserved request (budget %i)',
    async (limit) => {
      process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT = String(limit);
      const image = await sharp({
        create: { width: 2, height: 1, channels: 3, background: '#112233' },
      })
        .jpeg()
        .toBuffer();
      const storage = {
        get: jest.fn().mockResolvedValue(image),
      } as unknown as PhotoStorageService;
      worker = new MileageOcrWorkerService(repository, ocr, storage);
      const before = Buffer.from(image);
      const call = jest
        .spyOn(ocr, 'readApplication')
        .mockImplementation(async (images) => ({
          reading: {
            receipt: (await receiptCall()).reading,
            meter: (await meterCall()).reading,
            mirroredImages: images.map(
              (_image, index) => call.mock.calls.length === 1 && index === 0,
            ),
          },
          durationMs: 2,
          usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 80 },
        }));
      await worker.processOne();
      expect(call).toHaveBeenCalledTimes(limit);
      const job = (await database.db.select().from(mileageOcrJobs).limit(1))[0];
      expect(job.lunaReservedAt).toBeTruthy();
      expect(Boolean(job.lunaRetryReservedAt)).toBe(limit === 2);
      expect(job.clovaReservedAt).toBeNull();
      expect(job.lunaInputTokens).toBe(limit * 100);
      expect(job.status).toBe(limit === 2 ? 'completed' : 'failed');
      expect(image.equals(before)).toBe(true);
      if (limit === 2) {
        expect(call.mock.calls[1][0][0]).not.toBe(image);
        expect(call.mock.calls[1][0][1]).toBe(image);
      }
      await createApplication('c'.repeat(64));
      await worker.processOne();
      expect(call).toHaveBeenCalledTimes(limit);
    },
  );

  it('sends a single combined image once and retains unknown outcomes without paid retry', async () => {
    await database.db
      .delete(mileagePhotos)
      .where(eq(mileagePhotos.kind, 'meter'));
    await database.db.update(mileageApplications).set({ photoMode: 'single' });
    const row = (await repository.findOne(userId, applicationId))!;
    await database.db
      .update(mileageOcrJobs)
      .set({ sourceVersion: repository.submissionVersion(row) });
    const call = jest
      .spyOn(ocr, 'readApplication')
      .mockRejectedValue(new Error('timeout'));
    await worker.processOne();
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toHaveLength(1);
    expect(
      (await database.db.select().from(mileageOcrJobs).limit(1))[0]
        ?.lunaRetryReservedAt,
    ).toBeNull();
    expect(
      (await database.db.select().from(mileageApplications).limit(1))[0]
        ?.approvalStatus,
    ).toBe('pending');
  });

  it('records both readings but keeps matched applications pending', async () => {
    expect(await worker.processOne()).toBe(true);
    const application = (
      await database.db
        .select()
        .from(mileageApplications)
        .where(eq(mileageApplications.id, applicationId))
        .limit(1)
    )[0];
    expect(application).toMatchObject({
      receiptAmount: 11700,
      meterAmount: 11700,
      receiptAt: '2026-09-23T03:34:56.000Z',
      matchStatus: 'matched',
      approvalStatus: 'pending',
      finalAmount: null,
      mileageAmount: null,
    });
    expect(
      (await database.db.select().from(mileageOcrJobs).limit(1))[0],
    ).toMatchObject({
      status: 'completed',
      lunaInputTokens: 1000,
      lunaOutputTokens: 50,
    });
    expect(await worker.processOne()).toBe(false);
    expect(receiptCall).toHaveBeenCalledTimes(1);
    expect(meterCall).toHaveBeenCalledTimes(1);
  });

  it('does not use a failed receipt reading as proof of a match', async () => {
    receiptCall.mockRejectedValue(new Error('offline'));
    await worker.processOne();
    expect(
      (await database.db.select().from(mileageApplications).limit(1))[0],
    ).toMatchObject({
      receiptAmount: null,
      meterAmount: null,
      matchStatus: 'ocr_failed',
      approvalStatus: 'pending',
    });
    expect(
      (await database.db.select().from(mileageOcrJobs).limit(1))[0],
    ).toMatchObject({
      status: 'failed',
      errorCode: 'LUNA_FAILED',
    });
  });

  it('keeps differing receipt and meter totals for manual review', async () => {
    receiptCall.mockResolvedValue({
      reading: {
        amountText: '12650',
        transactionDateText: '2026-09-23',
        transactionTimeText: '12:34:56',
        quantityText: null,
        quantityUnit: 'unknown',
        unitPriceText: null,
        documentKind: 'sale',
        issues: [],
      },
      durationMs: 1,
    });
    meterCall.mockResolvedValue({
      reading: {
        amountText: '7,356원',
        litersText: '11.000 L',
        unitPriceText: null,
        issues: [],
      },
      durationMs: 1,
    });
    await worker.processOne();
    expect(
      (await database.db.select().from(mileageApplications).limit(1))[0],
    ).toMatchObject({
      receiptAmount: 12650,
      meterAmount: 7356,
      matchStatus: 'mismatched',
      approvalStatus: 'pending',
    });
  });

  it.each(['photo', 'extractor'])(
    'discards an obsolete %s before paying providers',
    async (change) => {
      if (change === 'extractor')
        await database.db
          .update(mileageOcrJobs)
          .set({ extractorVersion: 'old-reader' });
      else
        await database.db
          .update(mileagePhotos)
          .set({
            storageKey: 'mileage/replaced/receipt.jpg',
          })
          .where(eq(mileagePhotos.kind, 'receipt'));
      await worker.processOne();
      expect(
        (await database.db.select().from(mileageOcrJobs).limit(1))[0],
      ).toMatchObject({
        status: 'failed',
        errorCode: 'STALE_SOURCE',
      });
      expect(receiptCall).not.toHaveBeenCalled();
      expect(meterCall).not.toHaveBeenCalled();
    },
  );

  it('reserves each provider once under concurrent jobs at the daily call limit', async () => {
    process.env.MILEAGE_OCR_CLOVA_DAILY_LIMIT = '1';
    process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT = '1';
    await createApplication('b'.repeat(64));
    await Promise.all([worker.processOne(), worker.processOne()]);
    expect(receiptCall).toHaveBeenCalledTimes(1);
    expect(meterCall).toHaveBeenCalledTimes(1);
    expect(
      (await database.db.select().from(mileageOcrJobs))
        .map((job) => job.status)
        .sort(),
    ).toEqual(['completed', 'failed']);
  });

  it.each([true, false])(
    'preserves another worker response when a second worker starts (enabled %s)',
    async (enabled) => {
      let release!: () => void;
      const responseReady = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const requestSent = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const result = validResult();
      const call = jest
        .spyOn(ocr, 'readApplication')
        .mockImplementation(async () => {
          entered();
          await responseReady;
          return {
            reading: {
              receipt: result.receipt!,
              meter: result.meter!,
              mirroredImages: [false, false],
            },
            durationMs: 1,
          };
        });
      const processing = worker.processOne();
      await requestSent;
      const secondOcr = new MileageOcrService();
      jest.spyOn(secondOcr, 'isConfigured').mockReturnValue(enabled);
      const secondCall = jest.spyOn(secondOcr, 'readApplication');
      const secondWorker = new MileageOcrWorkerService(
        new MileageRepository(database),
        secondOcr,
        { get: jest.fn() } as unknown as PhotoStorageService,
      );
      try {
        await secondWorker.onModuleInit();
        expect(
          (await database.db.select().from(mileageOcrJobs))[0].status,
        ).toBe('running');
        release();
        await processing;
        expect(
          (await database.db.select().from(mileageOcrJobs))[0].status,
        ).toBe('completed');
        expect(await application()).toMatchObject({
          receiptAmount: 11700,
          meterAmount: 11700,
        });
        expect(call).toHaveBeenCalledTimes(1);
        expect(secondCall).not.toHaveBeenCalled();
      } finally {
        release();
        await processing;
        await secondWorker.onModuleDestroy();
      }
    },
  );

  it('claims distinct jobs concurrently and renews only a live database-clock lease', async () => {
    await createApplication('b'.repeat(64));
    const jobs = await Promise.all([
      repository.claimOcrJob(),
      repository.claimOcrJob(),
    ]);
    expect(new Set(jobs.map((job) => job!.id)).size).toBe(2);
    for (const job of jobs) {
      expect(
        job!.leaseExpiresAt!.getTime() - Date.parse(job!.startedAt!),
      ).toBeCloseTo(120000, -1);
    }
    const job = jobs[0]!;
    await database.db
      .update(mileageOcrJobs)
      .set({ leaseExpiresAt: sql`clock_timestamp() + interval '20 seconds'` })
      .where(eq(mileageOcrJobs.id, job.id));
    expect(await repository.renewOcrLease(job.id)).toBe(true);
    const [lease] = await database.connection<{ live: boolean }[]>`
      select lease_expires_at > clock_timestamp() + interval '110 seconds' as live
      from app.mileage_ocr_jobs where id = ${job.id}
    `;
    expect(lease.live).toBe(true);
    await repository.interruptExpiredOcrJobs();
    expect(
      (await database.db.select().from(mileageOcrJobs)).every(
        (row) => row.status === 'running',
      ),
    ).toBe(true);
  });

  it.each(['expired', 'legacy'])(
    'blocks %s leases before cleanup from renewal, paid calls and late approval',
    async (kind) => {
      process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
      const job = (await repository.claimOcrJob())!;
      await database.db
        .update(mileageOcrJobs)
        .set({
          leaseExpiresAt:
            kind === 'legacy'
              ? null
              : sql`clock_timestamp() - interval '1 second'`,
        })
        .where(eq(mileageOcrJobs.id, job.id));
      expect(await repository.renewOcrLease(job.id)).toBe(false);
      expect(await repository.ocrSource(job)).toBeNull();
      expect(await repository.reserveOcrCall(job.id, 10)).toBe(false);
      await repository.finishOcrJob(job, validResult());
      expect(await application()).toMatchObject({
        approvalStatus: 'pending',
        receiptAmount: null,
        mileageAmount: null,
      });
      await repository.interruptExpiredOcrJobs();
      expect(
        (await database.db.select().from(mileageOcrJobs))[0],
      ).toMatchObject({
        status: 'unknown',
        errorCode: 'INTERRUPTED',
        result: null,
      });
    },
  );

  it('keeps an expired paid call unknown and preserves its daily reservation', async () => {
    const job = (await repository.claimOcrJob())!;
    expect(await repository.reserveOcrCall(job.id, 10)).toBe(true);
    const reserved = (await database.db.select().from(mileageOcrJobs))[0]
      .lunaReservedAt;
    await database.db
      .update(mileageOcrJobs)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(mileageOcrJobs.id, job.id));
    expect(await repository.reserveOcrCall(job.id, 10, true)).toBe(false);
    await repository.interruptExpiredOcrJobs();
    await repository.finishOcrJob(job, validResult());
    expect(await worker.processOne()).toBe(false);
    expect(
      (await database.db.select().from(mileageOcrJobs).limit(1))[0],
    ).toMatchObject({
      status: 'unknown',
      errorCode: 'INTERRUPTED',
      lunaReservedAt: reserved,
      result: null,
    });
    await createApplication('b'.repeat(64));
    const next = (await repository.claimOcrJob())!;
    expect(await repository.reserveOcrCall(next.id, 1)).toBe(false);
    expect(receiptCall).not.toHaveBeenCalled();
  });

  it('does not overwrite an administrator decision completed during OCR', async () => {
    meterCall.mockImplementation(async () => {
      await database.db
        .update(mileageApplications)
        .set({
          approvalStatus: 'rejected',
          rejectionReason: '사진 재확인',
          decidedAt: new Date().toISOString(),
        })
        .where(eq(mileageApplications.id, applicationId));
      return {
        reading: {
          amountText: '11700',
          litersText: '11.000 L',
          unitPriceText: null,
          issues: [],
        },
        durationMs: 1,
      };
    });
    await worker.processOne();
    expect(
      (await database.db.select().from(mileageApplications).limit(1))[0],
    ).toMatchObject({
      approvalStatus: 'rejected',
      rejectionReason: '사진 재확인',
      receiptAmount: null,
      meterAmount: null,
      matchStatus: 'pending',
    });
  });

  it('compares current submissions instead of retained creation hashes or old OCR readings', async () => {
    await worker.processOne();
    await database.db
      .update(mileageApplications)
      .set({ approvalStatus: 'rejected', decidedAt: new Date().toISOString() })
      .where(eq(mileageApplications.id, applicationId));
    const current = (await repository.findOne(userId, applicationId))!;
    const oldReceipt = current.photos.find(
      (photo) => photo.kind === 'receipt',
    )!;
    await repository.commitResubmission({
      id: applicationId,
      userId,
      attemptId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestHash: 'c'.repeat(64),
      submissionVersion: repository.submissionVersion(current),
      queueOcr: true,
      photos: [
        {
          ...oldReceipt,
          storageKey: 'replacement/receipt',
          originalStorageKey: 'replacement/original',
        },
      ],
    });
    const reading = (date: string, amount: string) => ({
      reading: {
        amountText: amount,
        transactionDateText: date,
        transactionTimeText: '12:34:56',
        quantityText: null,
        quantityUnit: 'unknown' as const,
        unitPriceText: null,
        documentKind: 'sale' as const,
        issues: [],
      },
      durationMs: 1,
    });
    receiptCall.mockResolvedValue(reading('2026-09-24', '12000'));
    meterCall.mockResolvedValue({
      reading: {
        amountText: '12000',
        litersText: '11 L',
        unitPriceText: null,
        issues: [],
      },
      durationMs: 1,
    });
    await worker.processOne();
    const differentHash = await createApplication('b'.repeat(64));
    receiptCall.mockResolvedValue(reading('2026-09-23', '11700'));
    meterCall.mockResolvedValue({
      reading: {
        amountText: '11700',
        litersText: '11 L',
        unitPriceText: null,
        issues: [],
      },
      durationMs: 1,
    });
    await worker.processOne();
    expect((await repository.findOne(userId, differentHash))?.matchStatus).toBe(
      'matched',
    );
    const retainedHash = await createApplication('a'.repeat(64));
    receiptCall.mockResolvedValue(reading('2026-09-25', '25000'));
    meterCall.mockResolvedValue({
      reading: {
        amountText: '25000',
        litersText: '11.000 L',
        unitPriceText: null,
        issues: [],
      },
      durationMs: 1,
    });
    await worker.processOne();
    expect((await repository.findOne(userId, retainedHash))?.matchStatus).toBe(
      'matched',
    );
  });

  it('flags the same photo pair submitted again as a duplicate', async () => {
    const second = await createApplication();
    await worker.processOne();
    await worker.processOne();
    expect(
      (
        await database.db
          .select()
          .from(mileageApplications)
          .where(eq(mileageApplications.id, second))
          .limit(1)
      )[0]?.matchStatus,
    ).toBe('duplicate_suspected');
  });

  it('flags different photos with matching totals and printed transaction time', async () => {
    await worker.processOne();
    const second = await createApplication('b'.repeat(64));
    await worker.processOne();
    expect(
      (
        await database.db
          .select()
          .from(mileageApplications)
          .where(eq(mileageApplications.id, second))
          .limit(1)
      )[0]?.matchStatus,
    ).toBe('duplicate_suspected');
  });

  const validResult = (): OcrResult => ({
    receipt: {
      amountText: '11700',
      transactionDateText: '2026-09-23',
      transactionTimeText: '12:34:56+09:00',
      quantityText: '11',
      quantityUnit: 'count',
      unitPriceText: null,
      documentKind: 'sale',
      issues: [],
    },
    meter: {
      amountText: '11700',
      litersText: '11.000 L',
      unitPriceText: null,
      issues: [],
    },
    clovaError: null,
    lunaError: null,
    clovaDurationMs: 1,
    lunaDurationMs: 1,
    lunaInputTokens: 10,
    lunaOutputTokens: 10,
  });
  async function application() {
    return (
      await database.db
        .select()
        .from(mileageApplications)
        .where(eq(mileageApplications.id, applicationId))
        .limit(1)
    )[0];
  }
  async function balance() {
    return (
      await new SettlementsService(
        database,
        new AdminAuthRepository(database),
      ).balance(userId)
    ).accumulatedMileage;
  }
  function review() {
    return new AdminMileageService(
      database,
      {} as PhotoStorageService,
      new AdminAuthRepository(database),
    );
  }

  it('approves atomically, exposes the balance once and rejects the old review version', async () => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    const before = await review().detail(applicationId);
    const result = validResult();
    receiptCall.mockResolvedValue({ reading: result.receipt!, durationMs: 1 });
    meterCall.mockResolvedValue({ reading: result.meter!, durationMs: 1 });
    await worker.processOne();
    const decided = await application();
    expect(decided).toMatchObject({
      approvalStatus: 'approved',
      finalAmount: 11700,
      mileageAmount: 220,
      receiptAt: '2026-09-23T03:34:56.000Z',
    });
    expect(decided.decidedAt).not.toBeNull();
    expect(await balance()).toBe(220);
    const job = (await database.db.select().from(mileageOcrJobs).limit(1))[0];
    expect(job.status).toBe('completed');
    jest.useFakeTimers({
      now: new Date('2030-01-01T00:00:00.000Z'),
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    const replay = validResult();
    replay.meter!.litersText = '99 L';
    await repository.finishOcrJob(job, replay);
    expect(await application()).toEqual(decided);
    expect(
      (await database.db.select().from(mileageOcrJobs).limit(1))[0],
    ).toEqual(job);
    expect(await balance()).toBe(220);
    await expect(
      review().reject(applicationId, {
        rejectionReason: '금액 불일치',
        reviewVersion: before.reviewVersion,
      }),
    ).rejects.toThrow();
    expect(await worker.processOne()).toBe(false);
    expect(receiptCall).toHaveBeenCalledTimes(1);
    expect(meterCall).toHaveBeenCalledTimes(1);
  });

  it.each(['false', 'TRUE', '', undefined])(
    'leaves approvals disabled for %s without retroactively approving completed jobs',
    async (flag) => {
      if (flag !== undefined)
        process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = flag;
      const job = (await repository.claimOcrJob())!;
      await repository.finishOcrJob(job, validResult());
      const before = await application();
      expect(before).toMatchObject({
        approvalStatus: 'pending',
        finalAmount: null,
        mileageAmount: null,
        decidedAt: null,
      });
      process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
      await repository.finishOcrJob(job, validResult());
      expect(await application()).toEqual(before);
      expect(await balance()).toBe(0);
    },
  );

  it.each([
    'mismatch',
    'receiptAmount',
    'meterAmount',
    'liters',
    'receiptMissing',
    'meterMissing',
    'clovaError',
    'lunaError',
    'emptyError',
    'jobError',
  ])('keeps %s evidence pending', async (kind) => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    const result = validResult();
    if (kind === 'mismatch') result.meter!.amountText = '12000';
    if (kind === 'receiptAmount') result.receipt!.amountText = null;
    if (kind === 'meterAmount') result.meter!.amountText = null;
    if (kind === 'liters') result.meter!.litersText = '11';
    if (kind === 'receiptMissing') result.receipt = null;
    if (kind === 'meterMissing') result.meter = null;
    if (kind === 'clovaError') result.clovaError = 'CLOVA_FAILED';
    if (kind === 'lunaError') result.lunaError = 'LUNA_FAILED';
    if (kind === 'emptyError') {
      result.clovaError = '';
      result.lunaError = 'LUNA_FAILED';
    }
    await repository.finishOcrJob(
      (await repository.claimOcrJob())!,
      result,
      kind === 'jobError' ? 'PHOTO_READ_FAILED' : undefined,
    );
    expect(await application()).toMatchObject({
      approvalStatus: 'pending',
      finalAmount: null,
      mileageAmount: null,
      decidedAt: null,
    });
    expect(await balance()).toBe(0);
  });

  it.each(['sale', 'cancel', 'mixed', 'unknown'] as const)(
    'approves matching readable amounts despite %s metadata, reprints or absent transaction time',
    async (documentKind) => {
      process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
      const result = validResult();
      Object.assign(result.receipt!, {
        documentKind,
        reprinted: null,
        transactionTimeText: null,
        issues: [
          'REPRINT_UNCLEAR',
          '영수증 하단이 잘려 재발행 표시를 확인할 수 없음',
        ],
      });
      result.meter!.issues = ['단가 표시 없음'];
      await repository.finishOcrJob((await repository.claimOcrJob())!, result);
      expect(await application()).toMatchObject({
        approvalStatus: 'approved',
        matchStatus: 'matched',
        finalAmount: 11700,
        mileageAmount: 220,
        receiptAt: null,
      });
      expect(await balance()).toBe(220);
    },
  );

  it('uses only the same driver’s immediately previous current OCR result for the amount-only duplicate rule', async () => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    jest.useFakeTimers({
      now: new Date('2026-09-26T00:00:00Z'),
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    const finish = async (
      hash: string,
      amount: string,
      time: string,
      owner = userId,
    ) => {
      jest.advanceTimersByTime(1000);
      const id = await createApplication(hash.repeat(64), owner);
      const result = validResult();
      result.receipt!.amountText = result.meter!.amountText = amount;
      result.receipt!.transactionTimeText = time;
      await repository.finishOcrJob((await repository.claimOcrJob())!, result);
      return (await repository.findOne(owner, id))!;
    };
    await repository.finishOcrJob(
      (await repository.claimOcrJob())!,
      validResult(),
    );
    expect((await finish('b', '11700', '13:00:00')).matchStatus).toBe(
      'duplicate_suspected',
    );
    expect((await finish('c', '11701', '14:00:00')).approvalStatus).toBe(
      'approved',
    );
    expect((await finish('d', '11700', '15:00:00')).approvalStatus).toBe(
      'approved',
    );

    const otherUser = randomUUID();
    await database.db.insert(users).values({
      ...(await database.db.select().from(users).limit(1))[0],
      id: otherUser,
      email: 'other@example.com',
      phone: '010-9999-9999',
    });
    expect(
      (await finish('e', '11700', '16:00:00', otherUser)).approvalStatus,
    ).toBe('approved');
    // Another driver's intervening result must not hide this driver's previous total.
    expect((await finish('f', '11700', '17:00:00')).matchStatus).toBe(
      'duplicate_suspected',
    );

    jest.advanceTimersByTime(1000);
    await createApplication('1'.repeat(64));
    const failed = validResult();
    failed.receipt = failed.meter = null;
    await repository.finishOcrJob(
      (await repository.claimOcrJob())!,
      failed,
      'LUNA_FAILED',
    );
    expect((await finish('2', '11700', '18:00:00')).approvalStatus).toBe(
      'approved',
    );
  });

  it('uses completed-result order when the same driver has two OCR jobs in flight', async () => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    const first = (await repository.claimOcrJob())!;
    const secondId = await createApplication('b'.repeat(64));
    const second = (await repository.claimOcrJob())!;
    const result = validResult();
    result.receipt!.transactionTimeText = '13:00:00';
    await repository.finishOcrJob(second, result);
    await repository.finishOcrJob(first, validResult());
    expect((await repository.findOne(userId, secondId))?.approvalStatus).toBe(
      'approved',
    );
    expect(await application()).toMatchObject({
      approvalStatus: 'pending',
      matchStatus: 'duplicate_suspected',
    });
    expect(await balance()).toBe(220);
  });

  it.each([
    ['0.025 L', 1],
    ['0.024 L', 0],
  ] as const)(
    'stores exact rounded mileage for %s',
    async (liters, expected) => {
      process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
      const result = validResult();
      result.meter!.litersText = liters;
      await repository.finishOcrJob((await repository.claimOcrJob())!, result);
      expect(await application()).toMatchObject({
        approvalStatus: 'approved',
        finalAmount: 11700,
        mileageAmount: expected,
      });
      expect(await balance()).toBe(expected);
    },
  );

  it.each([
    'rejected',
    'approved',
    'settled',
    'photo',
    'deletedPhoto',
    'extractor',
    'jobVersion',
    'jobIdentity',
  ])('does not alter a decision or obsolete %s result', async (kind) => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    const job = (await repository.claimOcrJob())!;
    if (kind === 'rejected')
      await review().reject(applicationId, {
        rejectionReason: '금액 불일치',
        reviewVersion: (await review().detail(applicationId)).reviewVersion,
      });
    if (kind === 'approved')
      await database.db
        .update(mileageApplications)
        .set({
          approvalStatus: 'approved',
          finalAmount: 444,
          mileageAmount: 123,
          decidedAt: '2026-01-01T00:00:00.000Z',
        })
        .where(eq(mileageApplications.id, applicationId));
    if (kind === 'settled') {
      await database.db.insert(settlements).values({
        id: 'snapshot',
        logisticsCompanyId: companyId,
        settlementMonth: '2026-09',
        transferStatus: 'pending',
      });
      await database.db
        .update(mileageApplications)
        .set({
          settlementId: 'snapshot',
          approvalStatus: 'approved',
          finalAmount: 444,
          mileageAmount: 123,
          decidedAt: '2026-01-01T00:00:00.000Z',
        })
        .where(eq(mileageApplications.id, applicationId));
    }
    if (kind === 'photo')
      await database.db
        .update(mileagePhotos)
        .set({ storageKey: 'replaced' })
        .where(eq(mileagePhotos.kind, 'meter'));
    if (kind === 'deletedPhoto')
      await database.db
        .delete(mileagePhotos)
        .where(eq(mileagePhotos.kind, 'meter'));
    if (kind === 'extractor')
      await database.db
        .update(mileageOcrJobs)
        .set({ extractorVersion: 'old-reader' })
        .where(eq(mileageOcrJobs.id, job.id));
    if (kind === 'jobVersion')
      await database.db
        .update(mileageOcrJobs)
        .set({ sourceVersion: 'f'.repeat(64) })
        .where(eq(mileageOcrJobs.id, job.id));
    if (kind === 'jobIdentity') job.applicationId = randomUUID();
    const before = await application();
    await repository.finishOcrJob(job, validResult());
    expect(await application()).toEqual(before);
  });

  it('ignores a late result after resubmission and only applies the current job once', async () => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    const oldJob = (await repository.claimOcrJob())!;
    await review().reject(applicationId, {
      rejectionReason: '금액 불일치',
      reviewVersion: (await review().detail(applicationId)).reviewVersion,
    });
    const current = (await repository.findOne(userId, applicationId))!;
    const input = {
      id: applicationId,
      userId,
      attemptId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestHash: 'd'.repeat(64),
      submissionVersion: repository.submissionVersion(current),
      queueOcr: true,
      photos: [
        {
          ...current.photos[0],
          storageKey: 'replacement',
          originalStorageKey: 'replacement-original',
        },
      ],
    };
    await repository.commitResubmission(input);
    const before = await application();
    await repository.finishOcrJob(oldJob, validResult());
    expect(await application()).toEqual(before);
    const job = (await repository.claimOcrJob())!;
    await repository.finishOcrJob(job, validResult());
    expect(await balance()).toBe(220);
    const approved = await application();
    expect((await repository.commitResubmission(input)).committed).toBe(false);
    await repository.finishOcrJob(oldJob, validResult());
    await repository.finishOcrJob(job, validResult());
    expect(await application()).toEqual(approved);
    expect(await balance()).toBe(220);
  });

  it('serializes concurrent cross-driver duplicate completions', async () => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    const secondUser = randomUUID();
    await database.db.insert(users).values({
      ...(await database.db.select().from(users).limit(1))[0],
      id: secondUser,
      email: 'concurrent@example.com',
      phone: '010-7777-8888',
    });
    const first = (await repository.claimOcrJob())!;
    const secondId = await createApplication('b'.repeat(64), secondUser);
    const second = (await repository.claimOcrJob())!;

    await Promise.all([
      repository.finishOcrJob(first, validResult()),
      repository.finishOcrJob(second, validResult()),
    ]);

    const rows = await database.db
      .select({
        id: mileageApplications.id,
        approvalStatus: mileageApplications.approvalStatus,
        matchStatus: mileageApplications.matchStatus,
      })
      .from(mileageApplications)
      .where(
        or(
          eq(mileageApplications.id, applicationId),
          eq(mileageApplications.id, secondId),
        ),
      );
    expect(
      rows.filter((row) => row.approvalStatus === 'approved'),
    ).toHaveLength(1);
    expect(
      rows.filter((row) => row.matchStatus === 'duplicate_suspected'),
    ).toHaveLength(1);
  });

  it('serializes two in-flight duplicate submissions across users and retains withdrawn history', async () => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    const first = (await repository.claimOcrJob())!;
    const secondUser = randomUUID();
    await database.db.insert(users).values({
      ...(await database.db.select().from(users).limit(1))[0],
      id: secondUser,
      email: 'second@example.com',
      phone: '010-9999-9999',
    });
    const secondId = await createApplication('b'.repeat(64), secondUser);
    const second = (await repository.claimOcrJob())!;
    await repository.finishOcrJob(first, validResult());
    await database.db
      .update(users)
      .set({ deactivatedAt: new Date().toISOString(), passwordHash: null })
      .where(eq(users.id, userId));
    const result = validResult();
    result.receipt!.transactionDateText = '2026/9/23';
    result.receipt!.transactionTimeText = '03:34:56Z';
    await repository.finishOcrJob(second, result);
    expect((await application()).approvalStatus).toBe('approved');
    expect(
      (
        await database.db
          .select()
          .from(mileageApplications)
          .where(eq(mileageApplications.id, secondId))
          .limit(1)
      )[0],
    ).toMatchObject({
      approvalStatus: 'pending',
      matchStatus: 'duplicate_suspected',
      mileageAmount: null,
    });
    expect(await balance()).toBe(220);
  });

  it('normalizes old current evidence without re-reading or approving that completed job', async () => {
    const first = (await repository.claimOcrJob())!;
    const oldResult = validResult();
    oldResult.receipt!.transactionDateText = '2026/9/23';
    await repository.finishOcrJob(first, oldResult);
    await database.db
      .update(mileageOcrJobs)
      .set({ extractorVersion: 'clova-general-v2+luna-meter-v1' })
      .where(eq(mileageOcrJobs.id, first.id));
    await database.db
      .update(mileageApplications)
      .set({ receiptAt: null })
      .where(eq(mileageApplications.id, applicationId));
    const secondId = await createApplication('b'.repeat(64));
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    await repository.finishOcrJob(
      (await repository.claimOcrJob())!,
      validResult(),
    );
    expect(
      (
        await database.db
          .select()
          .from(mileageApplications)
          .where(eq(mileageApplications.id, secondId))
          .limit(1)
      )[0],
    ).toMatchObject({
      approvalStatus: 'pending',
      matchStatus: 'duplicate_suspected',
    });
    expect((await application()).approvalStatus).toBe('pending');
    expect(await balance()).toBe(0);
  });

  it('rolls back approval, evidence and job completion together on a write failure', async () => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    const job = (await repository.claimOcrJob())!;
    await database.connection.unsafe(
      `CREATE FUNCTION app.fail_ocr() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'failure'; END;
       $$;
       CREATE TRIGGER fail_ocr BEFORE UPDATE ON app.mileage_ocr_jobs
       FOR EACH ROW EXECUTE FUNCTION app.fail_ocr();`,
    );
    const before = await application();
    let error: unknown;
    try {
      await repository.finishOcrJob(job, validResult());
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as { cause?: { message?: string } }).cause?.message).toBe(
      'failure',
    );
    expect(await application()).toEqual(before);
    expect(
      (await database.db.select().from(mileageOcrJobs).limit(1))[0].status,
    ).toBe('running');
    expect(await balance()).toBe(0);
  });
});
