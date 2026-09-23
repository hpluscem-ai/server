import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import {
  logisticsCompanies,
  mileageApplications,
  mileageOcrJobs,
  mileagePhotos,
  users,
} from '../database/schema';
import { MileageRepository } from './mileage.repository';
import { MileageOcrService } from './mileage-ocr.service';
import { MileageOcrWorkerService } from './mileage-ocr-worker.service';
import { PhotoStorageService } from './photo-storage.service';

describe('MileageOcrWorkerService', () => {
  let database: DatabaseService;
  let repository: MileageRepository;
  let ocr: MileageOcrService;
  let worker: MileageOcrWorkerService;
  let receiptCall: jest.SpyInstance;
  let meterCall: jest.SpyInstance;
  let applicationId: string;
  const userId = randomUUID();
  const companyId = randomUUID();

  beforeEach(() => {
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
    receiptCall = jest.spyOn(ocr, 'readReceipt').mockResolvedValue({
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
    meterCall = jest.spyOn(ocr, 'readMeter').mockResolvedValue({
      reading: {
        amountText: '11,700원',
        litersText: '11.000 L',
        unitPriceText: null,
        issues: [],
      },
      durationMs: 12,
      usage: { inputTokens: 1000, outputTokens: 50 },
    });
    const storage = {
      get: jest.fn().mockResolvedValue(Buffer.from('private photo')),
    } as unknown as PhotoStorageService;
    worker = new MileageOcrWorkerService(repository, ocr, storage);
    applicationId = createApplication();
  });

  afterEach(() => {
    database.onModuleDestroy();
    delete process.env.DATABASE_PATH;
    delete process.env.MILEAGE_OCR_CLOVA_DAILY_LIMIT;
    delete process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT;
    jest.restoreAllMocks();
  });

  function createApplication(requestHash = 'a'.repeat(64)) {
    const id = randomUUID();
    repository.commit({
      id,
      userId,
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
    jest.spyOn(ocr, 'readReceipt').mockRejectedValue(new Error('offline'));
    await worker.processOne();
    expect(database.db.select().from(mileageApplications).get()).toMatchObject({
      receiptAmount: null,
      meterAmount: 11700,
      matchStatus: 'ocr_failed',
      approvalStatus: 'pending',
    });
    expect(database.db.select().from(mileageOcrJobs).get()).toMatchObject({
      status: 'failed',
      errorCode: 'CLOVA_FAILED',
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

  it('discards a job when its saved photo identity changes', async () => {
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
  });

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
    expect(repository.reserveOcrCalls(job.id, 10, 10)).toBe(true);
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
    const second = createApplication('b'.repeat(64));
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
});
