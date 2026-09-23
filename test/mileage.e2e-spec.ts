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
import { seedAdminSession } from './helpers/seed-admin-session';

const URL = '/api/v1/mileage/applications';
class TestStorage {
  objects = new Map<string, Buffer>();
  writes = 0;
  failAt = 0;
  failCleanup = false;
  beforePut?: () => Promise<void>;
  beforeGet?: () => void;
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
  get(key: string) {
    this.beforeGet?.();
    const data = this.objects.get(key);
    return data
      ? Promise.resolve(data)
      : Promise.reject(
          new ServiceUnavailableException({
            code: 'PHOTO_STORAGE_UNAVAILABLE',
          }),
        );
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
    const previousPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = ':memory:';
    storage = new TestStorage();
    try {
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PhotoStorageService)
        .useValue(storage)
        .compile();
      app = module.createNestApplication<INestApplication<App>>();
      configureApp(app);
      await app.init();
    } finally {
      if (previousPath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousPath;
    }
    database = app.get(DatabaseService);
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
  beforeEach(() => {
    // Also clears approved rows while respecting the production photo protection trigger.
    database.connection.exec(
      "UPDATE mileage_applications SET approval_status='pending', settlement_id=NULL; DELETE FROM mileage_application_photos; DELETE FROM mileage_applications; DELETE FROM mileage_upload_attempts; DELETE FROM settlements; DELETE FROM users; DELETE FROM logistics_companies;",
    );
    storage.objects.clear();
    storage.writes = 0;
    storage.failAt = 0;
    storage.failCleanup = false;
    storage.beforePut = undefined;
    storage.beforeGet = undefined;
    key = randomUUID();
    companyId = randomUUID();
    userId = randomUUID();
    database.db
      .insert(logisticsCompanies)
      .values({
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
      })
      .run();
    authorization = driver(userId, 'first');
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app.close();
    if (previousOrigin === undefined) delete process.env.WEB_ORIGINS;
    else process.env.WEB_ORIGINS = previousOrigin;
  });

  function driver(id: string, suffix: string) {
    database.db
      .insert(users)
      .values({
        id,
        role: 'driver',
        email: `${suffix}@example.com`,
        name: '테스트 기사',
        phone: `010-${suffix}`,
        passwordHash: 'isolated-unused-hash',
        logisticsCompanyId: companyId,
        serviceTermsConsent: true,
        privacyTermsConsent: true,
      })
      .run();
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    database.db
      .insert(authSessions)
      .values({
        tokenHash: createHash('sha256').update(token).digest('hex'),
        userId: id,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + 600000),
      })
      .run();
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
    expect(database.db.select().from(mileageApplications).all()).toHaveLength(
      1,
    );
    expect(database.db.select().from(mileagePhotos).all()).toHaveLength(2);
    expect(database.db.select().from(mileageUploadAttempts).all()).toHaveLength(
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

  it('runs saved photos through OCR and exposes review values without approving', async () => {
    const ocr = app.get(MileageOcrService);
    jest.spyOn(ocr, 'isConfigured').mockReturnValue(true);
    jest.spyOn(ocr, 'readReceipt').mockResolvedValue({
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
      durationMs: 1,
    });
    jest.spyOn(ocr, 'readMeter').mockResolvedValue({
      reading: {
        amountText: '11,700원',
        litersText: '11.000 L',
        unitPriceText: null,
        issues: [],
      },
      durationMs: 1,
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    process.env.MILEAGE_OCR_CLOVA_DAILY_LIMIT = '10';
    process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT = '10';
    try {
      const accepted = await saved();
      expect(accepted.status).toBe('pending');
      expect(database.db.select().from(mileageOcrJobs).get()?.status).toBe(
        'queued',
      );
      expect(await app.get(MileageOcrWorkerService).processOne()).toBe(true);
      expect(app.get(AdminMileageService).detail(accepted.id)).toMatchObject({
        receiptAmount: 11700,
        meterAmount: 11700,
        matchStatus: 'matched',
        status: 'pending',
      });
      const userDetail = await get(URL + '/' + accepted.id).expect(200);
      expect(userDetail.body).toMatchObject({
        status: 'pending',
        mileageAmount: null,
        finalAmount: null,
      });
    } finally {
      delete process.env.MILEAGE_OCR_CLOVA_DAILY_LIMIT;
      delete process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT;
    }
  });

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
    await submit(receipt, meter, key, seedAdminSession(database)).expect(401);
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
    expect(database.db.select().from(mileageApplications).all()).toHaveLength(
      1,
    );
  });
  it('isolates the same key by owner and hides other users applications and photos', async () => {
    const first = await saved();
    const other = driver(randomUUID(), 'second');
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
    expect(database.db.select().from(mileageApplications).all()).toHaveLength(
      1,
    );
    await get(first.photos.receipt!).expect(401);
    const newAuth = driver(randomUUID(), 'rejoined');
    await get(URL, newAuth).expect(200).expect({ items: [], nextCursor: null });
  });
  it('rolls back a failed storage write and keeps its attempt for reconciliation', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    storage.failAt = 2;
    await submit().expect(503);
    expect(database.db.select().from(mileageApplications).all()).toHaveLength(
      0,
    );
    expect(database.db.select().from(mileagePhotos).all()).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
    expect(database.db.select().from(mileageUploadAttempts).all()).toHaveLength(
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
    const attempt = database.db.select().from(mileageUploadAttempts).get()!;
    expect(attempt.storageKeys).toHaveLength(4);
    expect(storage.objects.size).toBe(1);
    expect(database.db.select().from(mileageApplications).all()).toHaveLength(
      0,
    );
  });
  it('rolls back both metadata rows if the second photo insert fails', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    database.connection.exec(
      "CREATE TRIGGER reject_meter BEFORE INSERT ON mileage_application_photos WHEN NEW.kind='meter' BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
    );
    try {
      await submit().expect(500);
    } finally {
      database.connection.exec('DROP TRIGGER reject_meter');
    }
    expect(database.db.select().from(mileageApplications).all()).toHaveLength(
      0,
    );
    expect(database.db.select().from(mileagePhotos).all()).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });
  it('rejects a session revoked during upload and cleans only uncommitted files', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    storage.beforePut = () => {
      database.db.delete(authSessions).run();
      return Promise.resolve();
    };
    await submit().expect(401);
    expect(database.db.select().from(mileageApplications).all()).toHaveLength(
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
    expect(database.db.select().from(mileageApplications).all()).toHaveLength(
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
    expect(database.db.select().from(mileageApplications).all()).toHaveLength(
      1,
    );
    expect(storage.objects.size).toBe(4);
    expect(database.db.select().from(mileageUploadAttempts).all()).toHaveLength(
      0,
    );
  });
  it('uses stable cursor pagination and inclusive/exclusive date boundaries', async () => {
    const one = await saved();
    key = randomUUID();
    const two = await saved();
    database.db
      .update(mileageApplications)
      .set({ submittedAt: '2026-09-01T00:00:00.000Z' })
      .where(eq(mileageApplications.id, one.id))
      .run();
    database.db
      .update(mileageApplications)
      .set({ submittedAt: '2026-09-02T00:00:00.000Z' })
      .where(eq(mileageApplications.id, two.id))
      .run();
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
    storage.beforeGet = () => {
      database.db.delete(authSessions).run();
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
    database.db
      .insert(settlements)
      .values({
        id: settlementId,
        logisticsCompanyId: companyId,
        settlementMonth: '2026-09',
        transferStatus: 'pending',
      })
      .run();
    database.db
      .update(mileageApplications)
      .set({
        approvalStatus: 'approved',
        finalAmount: 1000,
        mileageAmount: 200,
        decidedAt: new Date().toISOString(),
        settlementId,
      })
      .where(eq(mileageApplications.id, application.id))
      .run();
    await get()
      .expect(200)
      .expect(({ body }: { body: MileageListDto }) =>
        expect(body.items[0]).toMatchObject({
          status: 'approved',
          mileageAmount: 200,
        }),
      );
    database.db
      .update(settlements)
      .set({
        transferStatus: 'completed',
        transferredAt: new Date().toISOString(),
      })
      .where(eq(settlements.id, settlementId))
      .run();
    await get().expect(200).expect({ items: [], nextCursor: null });
    await get(`${URL}/${application.id}`).expect(404);
    await get(application.photos.receipt!).expect(404);
    // Complete settlements are immutable; this test is last to retain the production trigger.
  });
});
