import {
  INestApplication,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { OpenAPIObject } from '@nestjs/swagger';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { AdminMileageService } from '../src/admin-mileage';
import { configureApp } from '../src/app.setup';
import { WEB_SESSION_COOKIE } from '../src/auth';
import { DatabaseService } from '../src/database/database.service';
import {
  authSessions,
  logisticsCompanies,
  mileageApplications,
  mileageOcrJobs,
  mileagePhotos,
  mileageUploadAttempts,
  settlements,
  users,
} from '../src/database/schema';
import {
  MileageOcrService,
  MileageOcrWorkerService,
  MileageRepository,
  PhotoStorageService,
} from '../src/mileage';
import type {
  MileageDetailDto,
  MileageListDto,
} from '../src/mileage/mileage.dto';
import { createTestDatabase } from './helpers/create-test-database';
import { seedAdminSession } from './helpers/seed-admin-session';

const URL = '/api/v1/mileage/applications';
class TestStorage {
  objects = new Map<string, Buffer>();
  writes = 0;
  failAt = 0;
  failCleanup = false;
  beforePut?: () => Promise<void>;
  beforeGet?: () => Promise<void>;
  ensureConfigured() {}
  async put(key: string, path: string) {
    this.writes++;
    await this.beforePut?.();
    if (this.failAt === this.writes)
      throw new ServiceUnavailableException({
        code: 'PHOTO_STORAGE_UNAVAILABLE',
      });
    this.objects.set(key, await readFile(path));
  }
  remove(key: string) {
    if (this.failCleanup)
      return Promise.reject(new Error('test cleanup failure'));
    this.objects.delete(key);
    return Promise.resolve();
  }
  async get(key: string) {
    await this.beforeGet?.();
    const data = this.objects.get(key);
    if (data) return data;
    throw new ServiceUnavailableException({
      code: 'PHOTO_STORAGE_UNAVAILABLE',
    });
  }
}

describe('Mileage applications (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let storage: TestStorage;
  let receipt: Buffer;
  let meter: Buffer;
  let authorization: string;
  let userId: string;
  let companyId: string;
  let key: string;
  const previousOrigin = process.env.WEB_ORIGINS;
  beforeAll(async () => {
    process.env.WEB_ORIGINS = 'http://localhost:4000';
    storage = new TestStorage();
    database = await createTestDatabase();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue(database)
      .overrideProvider(PhotoStorageService)
      .useValue(storage)
      .compile();
    app = module.createNestApplication<INestApplication<App>>();
    configureApp(app);
    // Never start a paid OCR worker from an environment configured on this machine.
    const configured = jest
      .spyOn(app.get(MileageOcrService), 'isConfigured')
      .mockReturnValue(false);
    await app.init();
    configured.mockRestore();
    receipt = await sharp({
      create: { width: 64, height: 32, channels: 3, background: '#cc3322' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    meter = await sharp({
      create: { width: 48, height: 24, channels: 3, background: '#2244cc' },
    })
      .png()
      .toBuffer();
  });
  beforeEach(async () => {
    jest
      .spyOn(app.get(MileageOcrService), 'isConfigured')
      .mockReturnValue(false);
    // Also clears approved rows while respecting the production photo protection trigger.
    for (const statement of [
      "UPDATE app.mileage_applications SET approval_status='pending', settlement_id=NULL",
      'DELETE FROM app.mileage_application_photos',
      'DELETE FROM app.mileage_applications',
      'DELETE FROM app.mileage_upload_attempts',
      'DELETE FROM app.settlements',
      'DELETE FROM app.users',
      'DELETE FROM app.logistics_companies',
    ])
      await database.connection.unsafe(statement);
    storage.objects.clear();
    storage.writes = 0;
    storage.failAt = 0;
    storage.failCleanup = false;
    storage.beforePut = undefined;
    storage.beforeGet = undefined;
    key = randomUUID();
    companyId = randomUUID();
    userId = randomUUID();
    await database.db.insert(logisticsCompanies).values({
      id: companyId,
      businessName: '테스트 물류사',
      businessNumber: randomUUID(),
      corporateRegistrationNumber: randomUUID(),
      businessAddress: '서울시',
      managerName: '담당자',
      managerPhone: '010-1111-2222',
      bankCode: '19',
      accountNumber: '123',
      accountHolder: '테스트',
    });
    authorization = await driver(userId, 'first');
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app.close();
    await database.onModuleDestroy();
    if (previousOrigin === undefined) delete process.env.WEB_ORIGINS;
    else process.env.WEB_ORIGINS = previousOrigin;
  });

  async function driver(id: string, suffix: string) {
    await database.db.insert(users).values({
      id,
      role: 'driver',
      email: `${suffix}@example.com`,
      name: '테스트 기사',
      phone: `010-${suffix}`,
      passwordHash: 'isolated-unused-hash',
      logisticsCompanyId: companyId,
      serviceTermsConsent: true,
      privacyTermsConsent: true,
    });
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await database.db.insert(authSessions).values({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      userId: id,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 600000),
    });
    return `Bearer ${token}`;
  }
  function submit(
    first = receipt,
    second = meter,
    requestKey = key,
    auth = authorization,
  ) {
    return request(app.getHttpServer())
      .post(URL)
      .set('Authorization', auth)
      .field('idempotencyKey', requestKey)
      .attach('receipt', first, {
        filename: 'untrusted-name.png',
        contentType: 'image/png',
      })
      .attach('meter', second, {
        filename: 'meter.jpg',
        contentType: 'image/jpeg',
      });
  }
  async function saved() {
    return (await submit().expect(201)).body as MileageDetailDto;
  }
  function get(path = URL, auth = authorization) {
    return request(app.getHttpServer()).get(path).set('Authorization', auth);
  }

  async function rejected() {
    const result = await saved();
    await database.db
      .update(mileageApplications)
      .set({
        approvalStatus: 'rejected',
        rejectionReason: '기존에 저장된 사유',
        receiptAmount: 100,
        meterAmount: 200,
        receiptAt: '2026-09-20T00:00:00.000Z',
        matchStatus: 'mismatched',
        decidedAt: '2026-09-23T00:00:00.000Z',
      })
      .where(eq(mileageApplications.id, result.id));
    return (await get(`${URL}/${result.id}`).expect(200))
      .body as MileageDetailDto;
  }
  function resubmit(
    detail: MileageDetailDto,
    resubmitKey: string = randomUUID(),
    first?: Buffer,
    second?: Buffer,
  ) {
    const operation = request(app.getHttpServer())
      .post(`${URL}/${detail.id}/resubmit`)
      .set('Authorization', authorization)
      .field('idempotencyKey', resubmitKey)
      .field('submissionVersion', detail.submissionVersion);
    if (first) operation.attach('receipt', first, { filename: 'receipt.jpg' });
    if (second) operation.attach('meter', second, { filename: 'meter.png' });
    return operation;
  }

  it('resubmits only the selected photo, preserving originals, the first date and creation key', async () => {
    const original = await rejected();
    const before = (
      await database.db.select().from(mileageApplications).limit(1)
    )[0];
    const photos = await database.db.select().from(mileagePhotos);
    const objects = new Map(storage.objects);
    const result = await resubmit(original, randomUUID(), receipt).expect(200);
    expect(result.body).toMatchObject({
      id: original.id,
      status: 'pending',
      submittedAt: original.submittedAt,
      rejectionReason: null,
    });
    const updated = result.body as MileageDetailDto;
    expect(updated.submissionVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(updated.submissionVersion).not.toBe(original.submissionVersion);
    expect(
      (await database.db.select().from(mileageApplications).limit(1))[0],
    ).toMatchObject({
      idempotencyKey: before.idempotencyKey,
      requestHash: before.requestHash,
      receiptAmount: null,
      meterAmount: null,
      receiptAt: null,
      decidedAt: null,
      finalAmount: null,
      mileageAmount: null,
      matchStatus: 'pending',
    });
    const after = await database.db.select().from(mileagePhotos);
    expect(after.find((photo) => photo.kind === 'meter')).toEqual(
      photos.find((photo) => photo.kind === 'meter'),
    );
    expect(after.find((photo) => photo.kind === 'receipt')?.id).not.toBe(
      photos.find((photo) => photo.kind === 'receipt')?.id,
    );
    expect(storage.writes).toBe(6);
    for (const [path, content] of objects)
      expect(storage.objects.get(path)).toEqual(content);
    expect(
      (
        await database.connection.unsafe(
          'SELECT previous_rejection_reason FROM app.mileage_resubmissions',
        )
      )[0],
    ).toMatchObject({ previous_rejection_reason: '기존에 저장된 사유' });
    expect(await database.db.select().from(mileageUploadAttempts)).toHaveLength(
      0,
    );
  });

  it('replays resubmissions without more uploads and rejects changed inputs and stale versions', async () => {
    jest
      .spyOn(app.get(MileageOcrService), 'isConfigured')
      .mockReturnValue(true);
    const original = await rejected();
    const resubmitKey = randomUUID();
    const current = await resubmit(
      original,
      resubmitKey,
      receipt,
      meter,
    ).expect(200);
    await resubmit(original, resubmitKey, receipt, meter)
      .expect(200)
      .expect(current.body);
    expect(storage.writes).toBe(8);
    await resubmit(original, resubmitKey, meter, meter).expect(409);
    await resubmit(original, randomUUID(), receipt).expect(409);
    expect(storage.writes).toBe(8);
    await submit().expect(201).expect(current.body);
    expect(await database.db.select().from(mileageApplications)).toHaveLength(
      1,
    );
    expect(await database.db.select().from(mileageOcrJobs)).toHaveLength(2);
  });

  it('does not treat missing legacy creation hashes and failed OCR as duplicate evidence', async () => {
    const original = await rejected();
    await database.db
      .update(mileageApplications)
      .set({ requestHash: null })
      .where(eq(mileageApplications.id, original.id));
    key = randomUUID();
    await saved();
    const legacy = (await get(`${URL}/${original.id}`).expect(200))
      .body as MileageDetailDto;
    jest
      .spyOn(app.get(MileageOcrService), 'isConfigured')
      .mockReturnValue(true);
    await resubmit(legacy, randomUUID(), receipt).expect(200);
    const repository = app.get(MileageRepository);
    const job = (await repository.claimOcrJob())!;
    await repository.finishOcrJob(job, {
      receipt: null,
      meter: null,
      clovaError: 'test failure',
      lunaError: 'test failure',
      clovaDurationMs: null,
      lunaDurationMs: null,
      lunaInputTokens: null,
      lunaOutputTokens: null,
    });
    expect((await repository.findOne(userId, original.id))?.matchStatus).toBe(
      'ocr_failed',
    );
  });

  it('validates resubmission input, owner, rejected state and current version', async () => {
    const original = await rejected();
    await resubmit(original).expect(400);
    await resubmit(
      { ...original, submissionVersion: 'invalid' },
      randomUUID(),
      receipt,
    ).expect(400);
    await resubmit(original, 'invalid', receipt).expect(400);
    await resubmit(original, randomUUID(), receipt)
      .field('approvalStatus', 'approved')
      .expect(400);
    await resubmit(original, randomUUID(), receipt)
      .set('Authorization', '')
      .expect(401);
    await resubmit(original, randomUUID(), receipt)
      .set('Authorization', await driver(randomUUID(), 'other'))
      .expect(404);
    await resubmit(
      { ...original, id: randomUUID() },
      randomUUID(),
      receipt,
    ).expect(404);
    await resubmit(
      { ...original, submissionVersion: '0'.repeat(64) },
      randomUUID(),
      receipt,
    ).expect(409);
    const cookie = `${WEB_SESSION_COOKIE}=${authorization.slice(7)}`;
    await resubmit(original, randomUUID(), receipt)
      .unset('Authorization')
      .set('Cookie', cookie)
      .set('Origin', 'https://untrusted.test')
      .expect(403);
    await database.db
      .update(mileageApplications)
      .set({ approvalStatus: 'pending' });
    await resubmit(original, randomUUID(), receipt).expect(409);
    await database.db.update(mileageApplications).set({
      approvalStatus: 'approved',
      finalAmount: 1000,
      mileageAmount: 100,
      decidedAt: new Date().toISOString(),
    });
    await resubmit(original, randomUUID(), receipt).expect(409);
    expect(storage.writes).toBe(4);
  });

  it('does not restore old photos or state when an earlier resubmission is replayed', async () => {
    const original = await rejected();
    const firstKey = randomUUID();
    await resubmit(original, firstKey, receipt).expect(200);
    const admin = app.get(AdminMileageService);
    await admin.reject(original.id, {
      rejectionReason: '금액 불일치',
      reviewVersion: (await admin.detail(original.id)).reviewVersion,
    });
    const next = (await get(`${URL}/${original.id}`).expect(200))
      .body as MileageDetailDto;
    const latest = await resubmit(next, randomUUID(), undefined, meter).expect(
      200,
    );
    const photos = await database.db.select().from(mileagePhotos);
    await resubmit(original, firstKey, receipt).expect(200).expect(latest.body);
    expect(await database.db.select().from(mileagePhotos)).toEqual(photos);
    expect(storage.writes).toBe(8);
    expect(
      await database.connection.unsafe(
        'SELECT previous_rejection_reason FROM app.mileage_resubmissions ORDER BY id',
      ),
    ).toEqual([
      { previous_rejection_reason: '기존에 저장된 사유' },
      { previous_rejection_reason: '금액 불일치' },
    ]);
  });

  it.each(['storage', 'transaction', 'session'])(
    'keeps old photos and state on resubmission %s failure',
    async (failure) => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const original = await rejected();
      const row = (
        await database.db.select().from(mileageApplications).limit(1)
      )[0];
      const photos = await database.db.select().from(mileagePhotos);
      const objects = new Map(storage.objects);
      if (failure === 'storage') storage.failAt = 6;
      if (failure === 'session')
        storage.beforePut = async () => {
          await database.db.delete(authSessions);
        };
      if (failure === 'transaction')
        await database.connection.unsafe(
          `CREATE FUNCTION app.fail_resubmit() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN RAISE EXCEPTION 'test failure'; END;
           $$`,
        );
      if (failure === 'transaction')
        await database.connection.unsafe(
          'CREATE TRIGGER fail_resubmit BEFORE INSERT ON app.mileage_resubmissions FOR EACH ROW EXECUTE FUNCTION app.fail_resubmit()',
        );
      try {
        await resubmit(original, randomUUID(), receipt).expect(
          failure === 'storage' ? 503 : failure === 'session' ? 401 : 500,
        );
      } finally {
        if (failure === 'transaction')
          await database.connection.unsafe(
            'DROP TRIGGER fail_resubmit ON app.mileage_resubmissions',
          );
        if (failure === 'transaction')
          await database.connection.unsafe('DROP FUNCTION app.fail_resubmit()');
      }
      expect(
        (await database.db.select().from(mileageApplications).limit(1))[0],
      ).toEqual(row);
      expect(await database.db.select().from(mileagePhotos)).toEqual(photos);
      expect(storage.objects).toEqual(objects);
      expect(
        await database.connection.unsafe(
          'SELECT * FROM app.mileage_resubmissions',
        ),
      ).toHaveLength(0);
      expect(
        await database.db.select().from(mileageUploadAttempts),
      ).toHaveLength(1);
    },
  );

  it('keeps committed replacement objects when the response fails and supports a safe retry', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const original = await rejected();
    const repository = app.get(MileageRepository);
    const find = repository.findOne.bind(repository);
    jest
      .spyOn(repository, 'findOne')
      .mockImplementationOnce(find)
      .mockImplementationOnce(() => {
        throw new Error('lost response');
      })
      .mockImplementation(find);
    const resubmitKey = randomUUID();
    await resubmit(original, resubmitKey, receipt).expect(500);
    expect(storage.objects.size).toBe(6);
    expect(await database.db.select().from(mileageUploadAttempts)).toHaveLength(
      0,
    );
    await resubmit(original, resubmitKey, receipt).expect(200);
    expect(storage.writes).toBe(6);
  });

  it.each([true, false])(
    'serializes overlapping resubmissions (same key: %s)',
    async (sameKey) => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const original = await rejected();
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let calls = 0;
      storage.beforePut = async () => {
        if (++calls === 1) {
          started();
          await gate;
        }
      };
      const resubmitKey = randomUUID();
      const first = resubmit(original, resubmitKey, receipt).then(
        (response) => response,
      );
      await ready;
      let second;
      try {
        second = await resubmit(
          original,
          sameKey ? resubmitKey : randomUUID(),
          receipt,
        );
      } finally {
        release();
      }
      const firstResult = await first;
      expect(second.status).toBe(200);
      expect(firstResult.status).toBe(sameKey ? 200 : 409);
      expect(storage.objects.size).toBe(6);
      expect(
        await database.connection.unsafe(
          'SELECT * FROM app.mileage_resubmissions',
        ),
      ).toHaveLength(1);
      expect(await database.db.select().from(mileageApplications)).toHaveLength(
        1,
      );
    },
  );

  it('queues the current photo version atomically and ignores previous OCR and administrator decisions', async () => {
    jest
      .spyOn(app.get(MileageOcrService), 'isConfigured')
      .mockReturnValue(true);
    const original = await rejected();
    const repository = app.get(MileageRepository);
    const oldJob = (await repository.claimOcrJob())!;
    const admin = app.get(AdminMileageService);
    const reviewVersion = (await admin.detail(original.id)).reviewVersion;
    const current = (
      await resubmit(original, randomUUID(), receipt).expect(200)
    ).body as MileageDetailDto;
    const before = (
      await database.db.select().from(mileageApplications).limit(1)
    )[0];
    expect(await repository.ocrSource(oldJob)).toBeNull();
    await repository.finishOcrJob(oldJob, {
      receipt: null,
      meter: null,
      clovaError: null,
      lunaError: null,
      clovaDurationMs: null,
      lunaDurationMs: null,
      lunaInputTokens: null,
      lunaOutputTokens: null,
    });
    expect(
      (await database.db.select().from(mileageApplications).limit(1))[0],
    ).toEqual(before);
    await expect(
      admin.reject(original.id, {
        rejectionReason: '금액 불일치',
        reviewVersion,
      }),
    ).rejects.toThrow();
    const nextJob = (await repository.claimOcrJob())!;
    expect(nextJob.sourceVersion).toBe(current.submissionVersion);
    expect((await repository.ocrSource(nextJob))?.receiptKey).toContain(
      '/resubmissions/',
    );
    expect((await repository.ocrSource(nextJob))?.meterKey).toBe(
      `mileage/${original.id}/meter.jpg`,
    );
    expect(await database.db.select().from(mileageOcrJobs)).toHaveLength(2);
  });

  it('commits both photos as pending, normalizes orientation/metadata and protects original keys', async () => {
    const result = await saved();
    expect(result).toMatchObject({
      status: 'pending',
      mileageAmount: null,
      finalAmount: null,
      decidedAt: null,
      rejectionReason: null,
    });
    expect(result).not.toHaveProperty('requestHash');
    expect(JSON.stringify(result)).not.toContain('original');
    expect(storage.objects.size).toBe(4);
    expect(await database.db.select().from(mileageApplications)).toHaveLength(
      1,
    );
    expect(await database.db.select().from(mileagePhotos)).toHaveLength(2);
    expect(await database.db.select().from(mileageUploadAttempts)).toHaveLength(
      0,
    );
    const normalized = storage.objects.get(`mileage/${result.id}/receipt.jpg`)!;
    const metadata = await sharp(normalized).metadata();
    expect(metadata).toMatchObject({
      format: 'jpeg',
      width: 32,
      height: 64,
      space: 'srgb',
    });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(
      storage.objects.get(`mileage/${result.id}/receipt-original`),
    ).toEqual(receipt);
    await get(result.photos.receipt!)
      .expect(200)
      .expect('Content-Type', /image\/jpeg/)
      .expect('Cache-Control', 'no-store')
      .expect('X-Content-Type-Options', 'nosniff');
    await get(`${URL}/${result.id}`)
      .expect(200)
      .expect(({ body }: { body: MileageDetailDto }) =>
        expect(body).toEqual(result),
      );
  });

  it('stores a combined photo once, aliases protected meter access and supports idempotent mode changes', async () => {
    const single = () =>
      request(app.getHttpServer())
        .post(URL)
        .set('Authorization', authorization)
        .field('idempotencyKey', key)
        .field('photoMode', 'single')
        .attach('receipt', receipt, 'combined.jpg');
    const first = (await single().expect(201)).body as MileageDetailDto;
    expect(first.photoMode).toBe('single');
    expect(storage.writes).toBe(2);
    expect(await database.db.select().from(mileagePhotos)).toHaveLength(1);
    await single().expect(201).expect(first);
    expect(storage.writes).toBe(2);
    const one = await get(`${URL}/${first.id}/photos/receipt`).expect(200);
    const two = await get(`${URL}/${first.id}/photos/meter`).expect(200);
    expect(one.body).toEqual(two.body);
    const admin = app.get(AdminMileageService);
    expect((await admin.detail(first.id)).photos.meter).toBeTruthy();
    const reject = async () =>
      admin.reject(first.id, {
        rejectionReason: '금액 불일치',
        reviewVersion: (await admin.detail(first.id)).reviewVersion,
      });
    await reject();
    const original = (await get(`${URL}/${first.id}`).expect(200))
      .body as MileageDetailDto;
    await resubmit(original, randomUUID(), receipt)
      .field('photoMode', 'separate')
      .expect(400);
    const separateKey = randomUUID();
    const separate = (
      await resubmit(original, separateKey, receipt, meter)
        .field('photoMode', 'separate')
        .expect(200)
    ).body as MileageDetailDto;
    expect(separate.photoMode).toBe('separate');
    expect(await database.db.select().from(mileagePhotos)).toHaveLength(2);
    await reject();
    const combinedKey = randomUUID();
    const combined = (
      await resubmit(separate, combinedKey, receipt)
        .field('photoMode', 'single')
        .expect(200)
    ).body as MileageDetailDto;
    expect(combined.photoMode).toBe('single');
    expect(await database.db.select().from(mileagePhotos)).toHaveLength(1);
    const writes = storage.writes;
    await resubmit(original, separateKey, receipt, meter)
      .field('photoMode', 'separate')
      .expect(200)
      .expect(combined);
    expect(storage.writes).toBe(writes);
    expect(
      ((await get(`${URL}/${first.id}`).expect(200)).body as MileageDetailDto)
        .photoMode,
    ).toBe('single');
    await admin.approve(first.id, {
      reviewVersion: (await admin.detail(first.id)).reviewVersion,
      finalAmount: 13000,
      liters: '10',
    });
    expect(
      (await database.db.select().from(mileageApplications).limit(1))[0],
    ).toMatchObject({
      approvalStatus: 'approved',
      mileageAmount: 200,
    });
    await expect(
      database.db.update(mileageApplications).set({ photoMode: 'separate' }),
    ).rejects.toThrow();
  });

  it('rejects invalid photo mode/file combinations without storage writes', async () => {
    await submit().field('photoMode', 'single').expect(400);
    await submit().field('photoMode', 'invalid').expect(400);
    await request(app.getHttpServer())
      .post(URL)
      .set('Authorization', authorization)
      .field('idempotencyKey', key)
      .attach('receipt', receipt, 'receipt.jpg')
      .expect(400);
    expect(storage.writes).toBe(0);
  });

  it.each([
    [false, 'separate'],
    [true, 'separate'],
    [false, 'single'],
    [true, 'single'],
  ] as const)(
    'runs readable totals through OCR despite unknown reprint metadata, enabled=%s, mode=%s',
    async (enabled, photoMode) => {
      const previousAutoApprove = process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED;
      process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = String(enabled);
      const ocr = app.get(MileageOcrService);
      jest.spyOn(ocr, 'isConfigured').mockReturnValue(true);
      const read = jest.spyOn(ocr, 'readApplication').mockResolvedValue({
        reading: {
          mirroredImages: photoMode === 'single' ? [false] : [false, false],
          receipt: {
            amountText: '11700',
            transactionDateText: '2026-09-23',
            transactionTimeText: '12:34:56',
            quantityText: '11.000',
            quantityUnit: 'L',
            unitPriceText: null,
            documentKind: 'unknown',
            reprinted: null,
            issues: ['REPRINT_UNCLEAR'],
          },
          meter: {
            amountText: '11,700원',
            litersText: '11.000 L',
            unitPriceText: null,
            issues: [],
          },
        },
        durationMs: 1,
        usage: { inputTokens: 100, outputTokens: 20 },
      });
      process.env.MILEAGE_OCR_CLOVA_DAILY_LIMIT = '10';
      process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT = '10';
      try {
        const accepted =
          photoMode === 'separate'
            ? await saved()
            : ((
                await request(app.getHttpServer())
                  .post(URL)
                  .set('Authorization', authorization)
                  .field('idempotencyKey', key)
                  .field('photoMode', 'single')
                  .attach('receipt', receipt, 'combined.jpg')
                  .expect(201)
              ).body as MileageDetailDto);
        expect(accepted.status).toBe('pending');
        expect(
          (await database.db.select().from(mileageOcrJobs).limit(1))[0]?.status,
        ).toBe('queued');
        expect(await app.get(MileageOcrWorkerService).processOne()).toBe(true);
        expect(read).toHaveBeenCalledTimes(1);
        expect(read.mock.calls[0][0]).toHaveLength(
          photoMode === 'single' ? 1 : 2,
        );
        expect(
          await app.get(AdminMileageService).detail(accepted.id),
        ).toMatchObject({
          receiptAmount: 11700,
          meterAmount: 11700,
          matchStatus: 'matched',
          receiptAt: '2026-09-23T03:34:56.000Z',
          status: enabled ? 'approved' : 'pending',
        });
        const userDetail = await get(URL + '/' + accepted.id).expect(200);
        expect(userDetail.body).toMatchObject({
          status: enabled ? 'approved' : 'pending',
          mileageAmount: enabled ? 220 : null,
          finalAmount: enabled ? 11700 : null,
        });
        await get('/api/v1/mileage/summary')
          .expect(200)
          .expect({ accumulatedMileage: enabled ? 220 : 0 });
        expect(await app.get(MileageOcrWorkerService).processOne()).toBe(false);
        await get('/api/v1/mileage/summary')
          .expect(200)
          .expect({ accumulatedMileage: enabled ? 220 : 0 });
      } finally {
        if (previousAutoApprove === undefined)
          delete process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED;
        else process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED = previousAutoApprove;
        delete process.env.MILEAGE_OCR_CLOVA_DAILY_LIMIT;
        delete process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT;
      }
    },
  );

  it('decodes a synthetic real HEIC with an embedded color profile', async () => {
    const heic = await readFile(
      join(__dirname, 'fixtures/mileage-receipt.heic'),
    );
    const result = (await submit(heic).expect(201)).body as MileageDetailDto;
    const output = storage.objects.get(`mileage/${result.id}/receipt.jpg`)!;
    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.space).toBe('srgb');
    expect(metadata.exif).toBeUndefined();
    expect([metadata.width, metadata.height]).toEqual([32, 64]);
    const pixel = await sharp(output).removeAlpha().raw().toBuffer();
    for (const [index, expected] of [190, 60, 20].entries())
      expect(Math.abs(pixel[index] - expected)).toBeLessThanOrEqual(8);
  });

  it('accepts a static WebP image and stores a normalized JPEG', async () => {
    const webp = await sharp(receipt).webp().toBuffer();
    const result = (await submit(webp).expect(201)).body as MileageDetailDto;
    const output = storage.objects.get(`mileage/${result.id}/receipt.jpg`)!;
    expect((await sharp(output).metadata()).format).toBe('jpeg');
  });

  it('rejects animated WebP before storing an application', async () => {
    const frames = await Promise.all(
      ['red', 'blue'].map((background) =>
        sharp({ create: { width: 8, height: 8, channels: 3, background } })
          .png()
          .toBuffer(),
      ),
    );
    const animated = await sharp(frames, { join: { animated: true } })
      .webp()
      .toBuffer();
    await submit(animated).expect(415);
    expect(storage.writes).toBe(0);
  });

  it('shrinks the long edge to 4096 without upscaling smaller photos', async () => {
    const large = await sharp({
      create: { width: 5000, height: 10, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    const result = (await submit(large).expect(201)).body as MileageDetailDto;
    expect(
      (
        await sharp(
          storage.objects.get(`mileage/${result.id}/receipt.jpg`),
        ).metadata()
      ).width,
    ).toBe(4096);
  });

  it.each([
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    Buffer.from('not an image'),
  ])('rejects disguised unsupported bytes', async (bytes) => {
    await submit(bytes).expect(415);
    expect(storage.writes).toBe(0);
  });
  it('rejects an empty photo as invalid input', async () => {
    await submit(Buffer.alloc(0)).expect(400);
    expect(storage.writes).toBe(0);
  });
  it('rejects a sparse array field before form transformation', async () => {
    await request(app.getHttpServer())
      .post(URL)
      .set('Authorization', authorization)
      .field('idempotencyKey[999999999]', key)
      .attach('receipt', receipt, 'r.jpg')
      .attach('meter', meter, 'm.png')
      .expect(400);
    expect(storage.writes).toBe(0);
  });
  it('rejects damaged JPEG data', async () => {
    await submit(Buffer.from([255, 216, 255, 0, 1, 2, 3])).expect(400);
    expect(storage.writes).toBe(0);
  });
  it('rejects more than 60 million source pixels before decoding', async () => {
    const oversized = await sharp({
      create: { width: 8000, height: 8000, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const response = await submit(oversized).expect(400);
    expect((response.body as { code: string }).code).toBe('PHOTO_PIXEL_LIMIT');
    expect(storage.writes).toBe(0);
  });
  it('rejects a file over 50MiB', async () => {
    await submit(Buffer.alloc(50 * 1024 * 1024 + 1)).expect(413);
    expect(storage.writes).toBe(0);
  });
  it('requires both images and a valid key, and rejects extra fields', async () => {
    await request(app.getHttpServer())
      .post(URL)
      .set('Authorization', authorization)
      .field('idempotencyKey', key)
      .attach('receipt', receipt, 'r.jpg')
      .expect(400);
    await submit(receipt, meter, 'invalid').expect(400);
    await submit().field('userId', randomUUID()).expect(400);
    expect(storage.writes).toBe(0);
  });
  it('rejects an absent session and an administrator session', async () => {
    await get(URL, 'Bearer invalid').expect(401);
    await submit(receipt, meter, key, await seedAdminSession(database)).expect(
      401,
    );
  });
  it('enforces Origin for cookie writes and accepts the existing web session', async () => {
    const cookie = `${WEB_SESSION_COOKIE}=${authorization.slice(7)}`;
    await request(app.getHttpServer())
      .post(URL)
      .set('Cookie', cookie)
      .field('idempotencyKey', key)
      .attach('receipt', receipt, 'r.jpg')
      .attach('meter', meter, 'm.png')
      .expect(403);
    await request(app.getHttpServer())
      .post(URL)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:4000')
      .field('idempotencyKey', key)
      .attach('receipt', receipt, 'r.jpg')
      .attach('meter', meter, 'm.png')
      .expect(201);
  });
  it('replays identical files without more uploads and conflicts on changed bytes', async () => {
    const first = await saved();
    const count = storage.writes;
    expect(((await submit().expect(201)).body as MileageDetailDto).id).toBe(
      first.id,
    );
    expect(storage.writes).toBe(count);
    await submit(meter, meter).expect(409);
    expect(await database.db.select().from(mileageApplications)).toHaveLength(
      1,
    );
  });
  it('isolates the same key by owner and hides other users applications and photos', async () => {
    const first = await saved();
    const other = await driver(randomUUID(), 'second');
    await get(`${URL}/${first.id}`, other).expect(404);
    await get(first.photos.receipt!, other).expect(404);
    await get(URL, other).expect(200).expect({ items: [], nextCursor: null });
    const second = (await submit(receipt, meter, key, other).expect(201))
      .body as MileageDetailDto;
    expect(second.id).not.toBe(first.id);
  });
  it('keeps accepted records after withdrawal and does not transfer them to rejoined users', async () => {
    const first = await saved();
    await request(app.getHttpServer())
      .delete('/api/v1/users/me')
      .set('Authorization', authorization)
      .expect(204);
    expect(await database.db.select().from(mileageApplications)).toHaveLength(
      1,
    );
    await get(first.photos.receipt!).expect(401);
    const newAuth = await driver(randomUUID(), 'rejoined');
    await get(URL, newAuth).expect(200).expect({ items: [], nextCursor: null });
  });
  it('rolls back a failed storage write and keeps its attempt for reconciliation', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    storage.failAt = 2;
    await submit().expect(503);
    expect(await database.db.select().from(mileageApplications)).toHaveLength(
      0,
    );
    expect(await database.db.select().from(mileagePhotos)).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
    expect(await database.db.select().from(mileageUploadAttempts)).toHaveLength(
      1,
    );
    storage.failAt = 0;
    await submit().expect(201);
  });
  it('keeps failed cleanup keys durably without a partial application', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    storage.failAt = 2;
    storage.failCleanup = true;
    await submit().expect(503);
    const attempt = (
      await database.db.select().from(mileageUploadAttempts).limit(1)
    )[0];
    expect(attempt.storageKeys).toHaveLength(4);
    expect(storage.objects.size).toBe(1);
    expect(await database.db.select().from(mileageApplications)).toHaveLength(
      0,
    );
  });
  it('rolls back both metadata rows if the second photo insert fails', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await database.connection.unsafe(
      `CREATE FUNCTION app.reject_meter() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.kind = 'meter' THEN RAISE EXCEPTION 'test failure'; END IF;
           RETURN NEW;
         END;
       $$`,
    );
    await database.connection.unsafe(
      'CREATE TRIGGER reject_meter BEFORE INSERT ON app.mileage_application_photos FOR EACH ROW EXECUTE FUNCTION app.reject_meter()',
    );
    try {
      await submit().expect(500);
    } finally {
      await database.connection.unsafe(
        'DROP TRIGGER reject_meter ON app.mileage_application_photos',
      );
      await database.connection.unsafe('DROP FUNCTION app.reject_meter()');
    }
    expect(await database.db.select().from(mileageApplications)).toHaveLength(
      0,
    );
    expect(await database.db.select().from(mileagePhotos)).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });
  it('rejects a session revoked during upload and cleans only uncommitted files', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    storage.beforePut = async () => {
      await database.db.delete(authSessions);
    };
    await submit().expect(401);
    expect(await database.db.select().from(mileageApplications)).toHaveLength(
      0,
    );
    expect(storage.objects.size).toBe(0);
  });
  it('does not remove committed photos when response construction fails', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const repository = app.get(MileageRepository);
    const original = repository.findOne.bind(repository);
    jest
      .spyOn(repository, 'findOne')
      .mockImplementationOnce(() => {
        throw new Error('post-commit failure');
      })
      .mockImplementation(original);
    await submit().expect(500);
    expect(storage.objects.size).toBe(4);
    expect(await database.db.select().from(mileageApplications)).toHaveLength(
      1,
    );
    await submit().expect(201);
    expect(storage.objects.size).toBe(4);
  });
  it('handles overlapping identical requests with one committed application', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    storage.beforePut = async () => {
      if (++calls === 1) {
        started();
        await gate;
      }
    };
    const first = submit().then((response) => response);
    await ready;
    const second = await submit();
    release();
    const firstResult = await first;
    expect(second.status).toBe(201);
    expect(firstResult.status).toBe(201);
    expect((firstResult.body as MileageDetailDto).id).toBe(
      (second.body as MileageDetailDto).id,
    );
    expect(await database.db.select().from(mileageApplications)).toHaveLength(
      1,
    );
    expect(storage.objects.size).toBe(4);
    expect(await database.db.select().from(mileageUploadAttempts)).toHaveLength(
      0,
    );
  });
  it('uses stable cursor pagination and inclusive/exclusive date boundaries', async () => {
    const one = await saved();
    key = randomUUID();
    const two = await saved();
    await database.db
      .update(mileageApplications)
      .set({ submittedAt: '2026-09-01T00:00:00.000Z' })
      .where(eq(mileageApplications.id, one.id));
    await database.db
      .update(mileageApplications)
      .set({ submittedAt: '2026-09-02T00:00:00.000Z' })
      .where(eq(mileageApplications.id, two.id));
    const page = (await get().query({ limit: 1 }).expect(200))
      .body as MileageListDto;
    expect(page.items[0].id).toBe(two.id);
    expect(page.nextCursor).not.toBeNull();
    const next = (
      await get().query({ limit: 1, cursor: page.nextCursor }).expect(200)
    ).body as MileageListDto;
    expect(next.items[0].id).toBe(one.id);
    expect(next.nextCursor).toBeNull();
    await get()
      .query({ limit: 1, cursor: page.nextCursor, order: 'asc' })
      .expect(400);
    const bounded = (
      await get()
        .query({
          createdFrom: '2026-09-01T09:00:00+09:00',
          createdBefore: '2026-09-02T09:00:00+09:00',
          order: 'asc',
        })
        .expect(200)
    ).body as MileageListDto;
    expect(bounded.items.map((item) => item.id)).toEqual([one.id]);
    await get().query({ limit: 101 }).expect(400);
    await get().query({ cursor: 'bad' }).expect(400);
  });
  it('rechecks a revoked session after reading storage', async () => {
    const application = await saved();
    storage.beforeGet = async () => {
      await database.db.delete(authSessions);
    };
    await get(application.photos.receipt!).expect(401);
  });
  it('does not present a storage or DB failure as a missing record', async () => {
    const application = await saved();
    storage.objects.clear();
    await get(application.photos.receipt!).expect(503);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest
      .spyOn(app.get(MileageRepository), 'findList')
      .mockImplementation(() => {
        throw new Error('isolated DB failure');
      });
    await get().expect(500);
  });
  it('does not expose pending edit/cancel endpoints', async () => {
    const application = await saved();
    await request(app.getHttpServer())
      .patch(`${URL}/${application.id}`)
      .set('Authorization', authorization)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .delete(`${URL}/${application.id}`)
      .set('Authorization', authorization)
      .expect(404);
  });
  it('bounds concurrent multipart requests and releases capacity after completion', async () => {
    let release!: () => void;
    let firstReady!: () => void;
    let secondReady!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      firstReady = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      secondReady = resolve;
    });
    let calls = 0;
    storage.beforePut = async () => {
      if (++calls === 1) firstReady();
      else if (calls === 2) secondReady();
      await gate;
    };
    const first = submit().then((response) => response);
    await firstStarted;
    const second = submit(receipt, meter, randomUUID()).then(
      (response) => response,
    );
    await secondStarted;
    try {
      await submit(receipt, meter, randomUUID()).expect(503);
    } finally {
      release();
    }
    expect((await first).status).toBe(201);
    expect((await second).status).toBe(201);
    await submit().expect(201);
  });
  it('documents multipart and protected photo responses', async () => {
    const document = (
      await request(app.getHttpServer()).get('/docs-json').expect(200)
    ).body as OpenAPIObject;
    const resubmission = document.paths[`${URL}/{id}/resubmit`]?.post;
    expect(resubmission?.responses).toHaveProperty('200');
    expect(resubmission?.responses).not.toHaveProperty('201');
    expect(resubmission?.requestBody).toMatchObject({
      content: {
        'multipart/form-data': {
          schema: {
            required: ['idempotencyKey', 'submissionVersion'],
            anyOf: [{ required: ['receipt'] }, { required: ['meter'] }],
          },
        },
      },
    });
    expect(document.components?.schemas?.MileageDetailDto).toHaveProperty(
      'required',
      expect.arrayContaining(['submissionVersion']),
    );

    expect(document.paths[URL].post?.requestBody).toHaveProperty(
      'content.multipart/form-data',
    );
    expect(
      document.paths[`${URL}/{id}/photos/{kind}`].get?.responses,
    ).toHaveProperty('200');
  });
  it('retains transfer-pending approvals and hides completed settlements in list/detail/photo', async () => {
    const application = await saved();
    const settlementId = randomUUID();
    await database.db.insert(settlements).values({
      id: settlementId,
      logisticsCompanyId: companyId,
      settlementMonth: '2026-09',
      transferStatus: 'pending',
    });
    await database.db
      .update(mileageApplications)
      .set({
        approvalStatus: 'approved',
        finalAmount: 1000,
        mileageAmount: 200,
        decidedAt: new Date().toISOString(),
        settlementId,
      })
      .where(eq(mileageApplications.id, application.id));
    await resubmit(application, randomUUID(), receipt).expect(409);
    await get()
      .expect(200)
      .expect(({ body }: { body: MileageListDto }) =>
        expect(body.items[0]).toMatchObject({
          status: 'approved',
          mileageAmount: 200,
        }),
      );
    await database.db
      .update(settlements)
      .set({
        transferStatus: 'completed',
        transferredAt: new Date().toISOString(),
      })
      .where(eq(settlements.id, settlementId));
    await get().expect(200).expect({ items: [], nextCursor: null });
    await get(`${URL}/${application.id}`).expect(404);
    await get(application.photos.receipt!).expect(404);
    await resubmit(application, randomUUID(), receipt).expect(404);
    // Complete settlements are immutable; this test is last to retain the production trigger.
  });
});
