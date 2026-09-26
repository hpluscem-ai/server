import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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

  beforeEach(() => {
    delete process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED;
    process.env.DATABASE_PATH = ':memory:';
    process.env.MILEAGE_OCR_CLOVA_DAILY_LIMIT = '10';
    process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT = '10';
    database = new DatabaseService();
    repository = new MileageRepository(database);
    database.db
      .insert(logisticsCompanies)
      .values({
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
      })
      .run();
    database.db
      .insert(users)
      .values({
        id: userId,
        role: 'driver',
        email: 'ocr@example.com',
        name: '기사',
        phone: '010-1111-2222',
        logisticsCompanyId: companyId,
        passwordHash: 'test-hash',
        serviceTermsConsent: true,
        privacyTermsConsent: true,
      })
      .run();
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
    applicationId = createApplication();
  });

  afterEach(() => {
    delete process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED;
    database.onModuleDestroy();
    delete process.env.DATABASE_PATH;
    delete process.env.MILEAGE_OCR_CLOVA_DAILY_LIMIT;
    delete process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function createApplication(requestHash = 'a'.repeat(64), ownerId = userId) {
    const id = randomUUID();
    repository.commit({
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
      const job = database.db.select().from(mileageOcrJobs).get()!;
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
      createApplication('c'.repeat(64));
      await worker.processOne();
      expect(call).toHaveBeenCalledTimes(limit);
    },
  );

  it('sends a single combined image once and retains unknown outcomes without paid retry', async () => {
    database.db
      .delete(mileagePhotos)
      .where(eq(mileagePhotos.kind, 'meter'))
      .run();
    database.db.update(mileageApplications).set({ photoMode: 'single' }).run();
    const row = repository.findOne(userId, applicationId)!;
    database.db
      .update(mileageOcrJobs)
      .set({ sourceVersion: repository.submissionVersion(row) })
      .run();
    const call = jest
      .spyOn(ocr, 'readApplication')
      .mockRejectedValue(new Error('timeout'));
    await worker.processOne();
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toHaveLength(1);
    expect(
      database.db.select().from(mileageOcrJobs).get()?.lunaRetryReservedAt,
    ).toBeNull();
    expect(
      database.db.select().from(mileageApplications).get()?.approvalStatus,
    ).toBe('pending');
  });

  it('records both readings but keeps matched applications pending', async () => {
    expect(await worker.processOne()).toBe(true);
    const application = database.db
      .select()
      .from(mileageApplications)
      .where(eq(mileageApplications.id, applicationId))
      .get()!;
    expect(application).toMatchObject({
      receiptAmount: 11700,
      meterAmount: 11700,
      receiptAt: null,
      matchStatus: 'matched',
      approvalStatus: 'pending',
      finalAmount: null,
      mileageAmount: null,
    });
    expect(database.db.select().from(mileageOcrJobs).get()).toMatchObject({
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
    expect(database.db.select().from(mileageApplications).get()).toMatchObject({
      receiptAmount: null,
      meterAmount: null,
      matchStatus: 'ocr_failed',
      approvalStatus: 'pending',
    });
    expect(database.db.select().from(mileageOcrJobs).get()).toMatchObject({
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
    expect(database.db.select().from(mileageApplications).get()).toMatchObject({
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
        database.db
          .update(mileageOcrJobs)
          .set({ extractorVersion: 'old-reader' })
          .run();
      else
        database.db
          .update(mileagePhotos)
          .set({
            storageKey: 'mileage/replaced/receipt.jpg',
          })
          .where(eq(mileagePhotos.kind, 'receipt'))
          .run();
      await worker.processOne();
      expect(database.db.select().from(mileageOcrJobs).get()).toMatchObject({
        status: 'failed',
        errorCode: 'STALE_SOURCE',
      });
      expect(receiptCall).not.toHaveBeenCalled();
      expect(meterCall).not.toHaveBeenCalled();
    },
  );

  it('reserves each provider once and stops at the daily call limit', async () => {
    process.env.MILEAGE_OCR_CLOVA_DAILY_LIMIT = '1';
    process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT = '1';
    createApplication('b'.repeat(64));
    await worker.processOne();
    await worker.processOne();
    expect(receiptCall).toHaveBeenCalledTimes(1);
    expect(meterCall).toHaveBeenCalledTimes(1);
    expect(
      database.db
        .select()
        .from(mileageOcrJobs)
        .all()
        .map((job) => job.status)
        .sort(),
    ).toEqual(['completed', 'failed']);
  });

  it('keeps an interrupted running call unknown instead of recharging it', async () => {
    const job = repository.claimOcrJob()!;
    expect(repository.reserveOcrCall(job.id, 10)).toBe(true);
    repository.interruptRunningOcrJobs();
    expect(await worker.processOne()).toBe(false);
    expect(database.db.select().from(mileageOcrJobs).get()).toMatchObject({
      status: 'unknown',
      errorCode: 'INTERRUPTED',
    });
    expect(receiptCall).not.toHaveBeenCalled();
  });

  it('does not overwrite an administrator decision completed during OCR', async () => {
    meterCall.mockImplementation(() => {
      database.db
        .update(mileageApplications)
        .set({
          approvalStatus: 'rejected',
          rejectionReason: '사진 재확인',
          decidedAt: new Date().toISOString(),
        })
        .where(eq(mileageApplications.id, applicationId))
        .run();
      return Promise.resolve({
        reading: {
          amountText: '11700',
          litersText: '11.000 L',
          unitPriceText: null,
          issues: [],
        },
        durationMs: 1,
      });
    });
    await worker.processOne();
    expect(database.db.select().from(mileageApplications).get()).toMatchObject({
      approvalStatus: 'rejected',
      rejectionReason: '사진 재확인',
      receiptAmount: null,
      meterAmount: null,
      matchStatus: 'pending',
    });
  });

  it('compares current submissions instead of retained creation hashes or old OCR readings', async () => {
    await worker.processOne();
    database.db
      .update(mileageApplications)
      .set({ approvalStatus: 'rejected', decidedAt: new Date().toISOString() })
      .where(eq(mileageApplications.id, applicationId))
      .run();
    const current = repository.findOne(userId, applicationId)!;
    const oldReceipt = current.photos.find(
      (photo) => photo.kind === 'receipt',
    )!;
    repository.commitResubmission({
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
    receiptCall.mockResolvedValue(reading('2026-09-24', '11700'));
    await worker.processOne();
    const differentHash = createApplication('b'.repeat(64));
    receiptCall.mockResolvedValue(reading('2026-09-23', '11700'));
    await worker.processOne();
    expect(repository.findOne(userId, differentHash)?.matchStatus).toBe(
      'matched',
    );
    const retainedHash = createApplication('a'.repeat(64));
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
    expect(repository.findOne(userId, retainedHash)?.matchStatus).toBe(
      'matched',
    );
  });

  it('flags the same photo pair submitted again as a duplicate', async () => {
    const second = createApplication();
    await worker.processOne();
    await worker.processOne();
    expect(
      database.db
        .select()
        .from(mileageApplications)
        .where(eq(mileageApplications.id, second))
        .get()?.matchStatus,
    ).toBe('duplicate_suspected');
  });

  it('flags different photos with matching totals and printed transaction time', async () => {
    await worker.processOne();
    const second = createApplication('b'.repeat(64));
    await worker.processOne();
    expect(
      database.db
        .select()
        .from(mileageApplications)
        .where(eq(mileageApplications.id, second))
        .get()?.matchStatus,
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
  function application() {
    return database.db
      .select()
      .from(mileageApplications)
      .where(eq(mileageApplications.id, applicationId))
      .get()!;
  }
  function balance() {
    return new SettlementsService(
      database,
      new AdminAuthRepository(database),
    ).balance(userId).accumulatedMileage;
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
    const before = review().detail(applicationId);
    const result = validResult();
    receiptCall.mockResolvedValue({ reading: result.receipt!, durationMs: 1 });
    meterCall.mockResolvedValue({ reading: result.meter!, durationMs: 1 });
    await worker.processOne();
    const decided = application();
    expect(decided).toMatchObject({
      approvalStatus: 'approved',
      finalAmount: 11700,
      mileageAmount: 220,
      receiptAt: '2026-09-23T03:34:56.000Z',
    });
    expect(decided.decidedAt).not.toBeNull();
    expect(balance()).toBe(220);
    const job = database.db.select().from(mileageOcrJobs).get()!;
    expect(job.status).toBe('completed');
    jest.useFakeTimers({ now: new Date('2030-01-01T00:00:00.000Z') });
    const replay = validResult();
    replay.meter!.litersText = '99 L';
    repository.finishOcrJob(job, replay);
    expect(application()).toEqual(decided);
    expect(database.db.select().from(mileageOcrJobs).get()).toEqual(job);
    expect(balance()).toBe(220);
    expect(() =>
      review().reject(applicationId, { reviewVersion: before.reviewVersion }),
    ).toThrow();
    expect(await worker.processOne()).toBe(false);
    expect(receiptCall).toHaveBeenCalledTimes(1);
    expect(meterCall).toHaveBeenCalledTimes(1);
  });

  it.each(['false', 'TRUE', '', undefined])(
    'leaves approvals disabled for %s without retroactively approving completed jobs',
    (flag) => {
      if (flag !== undefined)
        process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = flag;
      const job = repository.claimOcrJob()!;
      repository.finishOcrJob(job, validResult());
      const before = application();
      expect(before).toMatchObject({
        approvalStatus: 'pending',
        finalAmount: null,
        mileageAmount: null,
        decidedAt: null,
      });
      process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
      repository.finishOcrJob(job, validResult());
      expect(application()).toEqual(before);
      expect(balance()).toBe(0);
    },
  );

  it.each([
    'time',
    'seconds',
    'timezone',
    'calendar',
    'mismatch',
    'receiptIssue',
    'meterIssue',
    'cancel',
    'liters',
    'receiptMissing',
    'meterMissing',
    'clovaError',
    'lunaError',
    'emptyError',
    'jobError',
  ])('keeps %s evidence pending', (kind) => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    const result = validResult();
    if (kind === 'time') result.receipt!.transactionTimeText = null;
    if (kind === 'seconds') result.receipt!.transactionTimeText = '12:34+09:00';
    if (kind === 'timezone') result.receipt!.transactionTimeText = '12:34:56';
    if (kind === 'calendar') result.receipt!.transactionDateText = '2026-02-30';
    if (kind === 'mismatch') result.meter!.amountText = '12000';
    if (kind === 'receiptIssue')
      result.receipt!.issues = ['REPRINTED_DOCUMENT'];
    if (kind === 'meterIssue') result.meter!.issues = ['unclear'];
    if (kind === 'cancel') result.receipt!.documentKind = 'cancel';
    if (kind === 'liters') result.meter!.litersText = '11';
    if (kind === 'receiptMissing') result.receipt = null;
    if (kind === 'meterMissing') result.meter = null;
    if (kind === 'clovaError') result.clovaError = 'CLOVA_FAILED';
    if (kind === 'lunaError') result.lunaError = 'LUNA_FAILED';
    if (kind === 'emptyError') {
      result.clovaError = '';
      result.lunaError = 'LUNA_FAILED';
    }
    repository.finishOcrJob(
      repository.claimOcrJob()!,
      result,
      kind === 'jobError' ? 'PHOTO_READ_FAILED' : undefined,
    );
    expect(application()).toMatchObject({
      approvalStatus: 'pending',
      finalAmount: null,
      mileageAmount: null,
      decidedAt: null,
    });
    expect(balance()).toBe(0);
  });

  it.each([
    ['0.025 L', 1],
    ['0.024 L', 0],
  ] as const)('stores exact rounded mileage for %s', (liters, expected) => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    const result = validResult();
    result.meter!.litersText = liters;
    repository.finishOcrJob(repository.claimOcrJob()!, result);
    expect(application()).toMatchObject({
      approvalStatus: 'approved',
      finalAmount: 11700,
      mileageAmount: expected,
    });
    expect(balance()).toBe(expected);
  });

  it.each([
    'rejected',
    'approved',
    'settled',
    'photo',
    'deletedPhoto',
    'extractor',
    'jobVersion',
    'jobIdentity',
  ])('does not alter a decision or obsolete %s result', (kind) => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    const job = repository.claimOcrJob()!;
    if (kind === 'rejected')
      review().reject(applicationId, {
        reviewVersion: review().detail(applicationId).reviewVersion,
      });
    if (kind === 'approved')
      database.db
        .update(mileageApplications)
        .set({
          approvalStatus: 'approved',
          finalAmount: 444,
          mileageAmount: 123,
          decidedAt: '2026-01-01T00:00:00.000Z',
        })
        .where(eq(mileageApplications.id, applicationId))
        .run();
    if (kind === 'settled') {
      database.db
        .insert(settlements)
        .values({
          id: 'snapshot',
          logisticsCompanyId: companyId,
          settlementMonth: '2026-09',
          transferStatus: 'pending',
        })
        .run();
      database.db
        .update(mileageApplications)
        .set({
          settlementId: 'snapshot',
          approvalStatus: 'approved',
          finalAmount: 444,
          mileageAmount: 123,
          decidedAt: '2026-01-01T00:00:00.000Z',
        })
        .where(eq(mileageApplications.id, applicationId))
        .run();
    }
    if (kind === 'photo')
      database.db
        .update(mileagePhotos)
        .set({ storageKey: 'replaced' })
        .where(eq(mileagePhotos.kind, 'meter'))
        .run();
    if (kind === 'deletedPhoto')
      database.db
        .delete(mileagePhotos)
        .where(eq(mileagePhotos.kind, 'meter'))
        .run();
    if (kind === 'extractor')
      database.db
        .update(mileageOcrJobs)
        .set({ extractorVersion: 'old-reader' })
        .where(eq(mileageOcrJobs.id, job.id))
        .run();
    if (kind === 'jobVersion')
      database.db
        .update(mileageOcrJobs)
        .set({ sourceVersion: 'f'.repeat(64) })
        .where(eq(mileageOcrJobs.id, job.id))
        .run();
    if (kind === 'jobIdentity') job.applicationId = randomUUID();
    const before = application();
    repository.finishOcrJob(job, validResult());
    expect(application()).toEqual(before);
  });

  it('ignores a late result after resubmission and only applies the current job once', () => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    const oldJob = repository.claimOcrJob()!;
    review().reject(applicationId, {
      reviewVersion: review().detail(applicationId).reviewVersion,
    });
    const current = repository.findOne(userId, applicationId)!;
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
    repository.commitResubmission(input);
    const before = application();
    repository.finishOcrJob(oldJob, validResult());
    expect(application()).toEqual(before);
    const job = repository.claimOcrJob()!;
    repository.finishOcrJob(job, validResult());
    expect(balance()).toBe(220);
    const approved = application();
    expect(repository.commitResubmission(input).committed).toBe(false);
    repository.finishOcrJob(oldJob, validResult());
    repository.finishOcrJob(job, validResult());
    expect(application()).toEqual(approved);
    expect(balance()).toBe(220);
  });

  it('serializes two in-flight duplicate submissions across users and retains withdrawn history', () => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    const first = repository.claimOcrJob()!;
    const secondUser = randomUUID();
    database.db
      .insert(users)
      .values({
        ...database.db.select().from(users).get()!,
        id: secondUser,
        email: 'second@example.com',
        phone: '010-9999-9999',
      })
      .run();
    const secondId = createApplication('b'.repeat(64), secondUser);
    const second = repository.claimOcrJob()!;
    repository.finishOcrJob(first, validResult());
    database.db
      .update(users)
      .set({ deactivatedAt: new Date().toISOString(), passwordHash: null })
      .where(eq(users.id, userId))
      .run();
    const result = validResult();
    result.receipt!.transactionDateText = '2026/9/23';
    result.receipt!.transactionTimeText = '03:34:56Z';
    repository.finishOcrJob(second, result);
    expect(application().approvalStatus).toBe('approved');
    expect(
      database.db
        .select()
        .from(mileageApplications)
        .where(eq(mileageApplications.id, secondId))
        .get(),
    ).toMatchObject({
      approvalStatus: 'pending',
      matchStatus: 'duplicate_suspected',
      mileageAmount: null,
    });
    expect(balance()).toBe(220);
  });

  it('normalizes old current evidence without re-reading or approving that completed job', () => {
    const first = repository.claimOcrJob()!;
    const oldResult = validResult();
    oldResult.receipt!.transactionDateText = '2026/9/23';
    repository.finishOcrJob(first, oldResult);
    database.db
      .update(mileageOcrJobs)
      .set({ extractorVersion: 'clova-general-v2+luna-meter-v1' })
      .where(eq(mileageOcrJobs.id, first.id))
      .run();
    database.db
      .update(mileageApplications)
      .set({ receiptAt: null })
      .where(eq(mileageApplications.id, applicationId))
      .run();
    const secondId = createApplication('b'.repeat(64));
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    repository.finishOcrJob(repository.claimOcrJob()!, validResult());
    expect(
      database.db
        .select()
        .from(mileageApplications)
        .where(eq(mileageApplications.id, secondId))
        .get(),
    ).toMatchObject({
      approvalStatus: 'pending',
      matchStatus: 'duplicate_suspected',
    });
    expect(application().approvalStatus).toBe('pending');
    expect(balance()).toBe(0);
  });

  it('rolls back approval, evidence and job completion together on a write failure', () => {
    process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = 'true';
    const job = repository.claimOcrJob()!;
    database.connection.exec(
      "CREATE TRIGGER fail_ocr BEFORE UPDATE ON mileage_ocr_jobs BEGIN SELECT RAISE(ABORT, 'failure'); END",
    );
    const before = application();
    expect(() => repository.finishOcrJob(job, validResult())).toThrow();
    expect(application()).toEqual(before);
    expect(database.db.select().from(mileageOcrJobs).get()!.status).toBe(
      'running',
    );
    expect(balance()).toBe(0);
  });
});
