import type { OpenAPIObject } from '@nestjs/swagger';
import type { AdminMileageResponseDto } from '../src/admin-mileage/admin-mileage.dto';
import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ADMIN_WEB_SESSION_COOKIE } from '../src/auth';
import { DatabaseService } from '../src/database/database.service';
import {
  adminSessions,
  authSessions,
  logisticsCompanies,
  mileageApplications,
  mileagePhotos,
  mileageOcrJobs,
  settlements,
  users,
} from '../src/database/schema';
import {
  PhotoStorageService,
  MileageRepository,
  OCR_VERSION,
} from '../src/mileage';
import { seedAdminSession } from './helpers/seed-admin-session';

const URL = '/api/v1/admin/mileage/applications';

describe('Admin mileage reads and rejection (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let authorization: string;
  let companyId: string;
  let userId: string;
  let applicationId: string;
  let jpeg: Buffer;
  let beforeGet: (() => void) | undefined;
  let storageFailure: boolean;
  const storedKeys: string[] = [];

  beforeAll(async () => {
    jpeg = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#eee' },
    })
      .jpeg()
      .toBuffer();
  });
  beforeEach(async () => {
    const previousPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = ':memory:';
    beforeGet = undefined;
    storageFailure = false;
    storedKeys.length = 0;
    try {
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PhotoStorageService)
        .useValue({
          get: (key: string) => {
            storedKeys.push(key);
            beforeGet?.();
            if (storageFailure)
              return Promise.reject(
                new ServiceUnavailableException({
                  code: 'PHOTO_STORAGE_UNAVAILABLE',
                }),
              );
            return Promise.resolve(jpeg);
          },
        })
        .compile();
      app = module.createNestApplication<INestApplication<App>>();
      configureApp(app);
      await app.init();
    } finally {
      if (previousPath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousPath;
    }
    database = app.get(DatabaseService);
    authorization = seedAdminSession(database);
    companyId = addCompany();
    userId = randomUUID();
    database.db
      .insert(users)
      .values({
        id: userId,
        role: 'driver',
        email: 'driver@example.test',
        name: '김 %_ 기사',
        phone: '010-1234-5678',
        passwordHash: 'unused-test-hash',
        logisticsCompanyId: companyId,
        serviceTermsConsent: true,
        privacyTermsConsent: true,
      })
      .run();
    applicationId = randomUUID();
    database.db
      .insert(mileageApplications)
      .values({
        id: applicationId,
        userId,
        logisticsCompanyId: companyId,
        idempotencyKey: randomUUID(),
        submittedAt: '2026-09-22T00:00:00Z',
      })
      .run();
    for (const kind of ['receipt', 'meter'] as const) {
      database.db
        .insert(mileagePhotos)
        .values({
          id: randomUUID(),
          mileageApplicationId: applicationId,
          kind,
          storageKey: `private/${kind}.jpg`,
          originalStorageKey: `private/original-${kind}.png`,
          contentType: 'image/jpeg',
          byteSize: jpeg.length,
        })
        .run();
    }
  });
  afterEach(async () => {
    await app?.close();
  });

  function addCompany() {
    const id = randomUUID();
    database.db
      .insert(logisticsCompanies)
      .values({
        id,
        businessName: '같은 회사명',
        businessNumber: randomUUID(),
        corporateRegistrationNumber: randomUUID(),
        businessAddress: '서울',
        managerName: '담당자',
        managerPhone: '010-2222-3333',
        bankCode: '19',
        accountNumber: '001',
        accountHolder: 'QA',
      })
      .run();
    return id;
  }

  it('requires an administrator for every read and accepts the existing admin cookie', async () => {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    database.db
      .insert(authSessions)
      .values({
        tokenHash: createHash('sha256').update(token).digest('hex'),
        userId,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + 600000),
      })
      .run();
    for (const path of [
      '',
      `/${applicationId}`,
      `/${applicationId}/photos/receipt`,
    ]) {
      const missing = await request(app.getHttpServer())
        .get(URL + path)
        .expect(401);
      expect((missing.body as { code: string }).code).toBe(
        'INVALID_ADMIN_SESSION',
      );
      await request(app.getHttpServer())
        .get(URL + path)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    }
    await request(app.getHttpServer())
      .get(URL)
      .set('Cookie', `${ADMIN_WEB_SESSION_COOKIE}=${authorization.slice(7)}`)
      .expect(200);
    expect(storedKeys).toEqual([]);
  });

  it('returns actual data, preserves unknown values and never exposes storage or authentication fields', async () => {
    const list = await request(app.getHttpServer())
      .get(URL)
      .set('Authorization', authorization)
      .expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toHaveLength(1);
    expect((list.body as AdminMileageResponseDto[])[0]).toMatchObject({
      id: applicationId,
      userId,
      logisticsCompanyId: companyId,
      name: '김 %_ 기사',
      receiptAmount: null,
      meterAmount: null,
      finalAmount: null,
      mileageAmount: null,
      receiptAt: null,
      status: 'pending',
      matchStatus: 'pending',
      photos: {
        receipt: `${URL}/${applicationId}/photos/receipt`,
        meter: `${URL}/${applicationId}/photos/meter`,
      },
    });
    const detail = await request(app.getHttpServer())
      .get(`${URL}/${applicationId}`)
      .set('Authorization', authorization)
      .expect(200);
    expect(detail.body).toEqual((list.body as AdminMileageResponseDto[])[0]);
    expect(JSON.stringify(detail.body)).not.toMatch(
      /private\/|storageKey|password|tokenHash|requestHash|email/,
    );
  });

  it('filters literal names and company IDs without conflating equal company names', async () => {
    const secondCompany = addCompany();
    for (const nameQuery of ['%_', ' 김 ', '기사']) {
      const result = await request(app.getHttpServer())
        .get(URL)
        .query({ nameQuery, logisticsCompanyId: companyId })
        .set('Authorization', authorization)
        .expect(200);
      expect(
        (result.body as AdminMileageResponseDto[]).map(
          (row: { id: string }) => row.id,
        ),
      ).toEqual([applicationId]);
    }
    for (const query of [
      { nameQuery: '없음' },
      { logisticsCompanyId: secondCompany },
    ]) {
      const result = await request(app.getHttpServer())
        .get(URL)
        .query(query)
        .set('Authorization', authorization)
        .expect(200);
      expect(result.body).toEqual([]);
    }
    for (const query of [
      { logisticsCompanyId: 'wrong' },
      { nameQuery: 'a'.repeat(101) },
      { userId },
      { status: 'approved' },
    ]) {
      await request(app.getHttpServer())
        .get(URL)
        .query(query)
        .set('Authorization', authorization)
        .expect(400);
    }
  });

  it('retains withdrawn, inactive and completed history using the original application owner', async () => {
    database.db
      .update(mileageApplications)
      .set({
        approvalStatus: 'approved',
        finalAmount: 10000,
        mileageAmount: 200,
        decidedAt: '2026-09-22T01:00:00Z',
      })
      .where(eq(mileageApplications.id, applicationId))
      .run();
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
      .set({ settlementId })
      .where(eq(mileageApplications.id, applicationId))
      .run();
    database.db
      .update(settlements)
      .set({
        transferStatus: 'completed',
        transferredAt: '2026-09-22T02:00:00Z',
      })
      .where(eq(settlements.id, settlementId))
      .run();
    database.db
      .update(users)
      .set({ deactivatedAt: '2026-09-22T03:00:00Z', passwordHash: null })
      .where(eq(users.id, userId))
      .run();
    database.db
      .update(logisticsCompanies)
      .set({ active: false })
      .where(eq(logisticsCompanies.id, companyId))
      .run();
    const result = await request(app.getHttpServer())
      .get(URL)
      .set('Authorization', authorization)
      .expect(200);
    expect((result.body as AdminMileageResponseDto[])[0]).toMatchObject({
      id: applicationId,
      userId,
      status: 'approved',
      finalAmount: 10000,
      mileageAmount: 200,
      settlementId,
      logisticsCompanyId: companyId,
    });
    await request(app.getHttpServer())
      .get(`${URL}/${applicationId}/photos/receipt`)
      .set('Authorization', authorization)
      .expect(200);
  });

  it('returns only the normalized JPEG and marks missing photos without fabricated URLs', async () => {
    const photo = await request(app.getHttpServer())
      .get(`${URL}/${applicationId}/photos/receipt`)
      .set('Authorization', authorization)
      .expect(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');
    expect(photo.headers['cache-control']).toBe('no-store');
    expect(photo.headers['x-content-type-options']).toBe('nosniff');
    expect(photo.body).toEqual(jpeg);
    expect(storedKeys).toEqual(['private/receipt.jpg']);
    database.db
      .delete(mileagePhotos)
      .where(eq(mileagePhotos.mileageApplicationId, applicationId))
      .run();
    const detail = await request(app.getHttpServer())
      .get(`${URL}/${applicationId}`)
      .set('Authorization', authorization)
      .expect(200);
    expect((detail.body as AdminMileageResponseDto).photos).toEqual({
      receipt: null,
      meter: null,
    });
    for (const path of [
      `/${applicationId}/photos/receipt`,
      `/${applicationId}/photos/original`,
      `/${randomUUID()}`,
    ]) {
      await request(app.getHttpServer())
        .get(URL + path)
        .set('Authorization', authorization)
        .expect(404);
    }
    await request(app.getHttpServer())
      .get(`${URL}/not-a-uuid`)
      .set('Authorization', authorization)
      .expect(400);
  });

  it('rejects a session revoked during storage access and does not return the photo', async () => {
    beforeGet = () => {
      database.db.delete(adminSessions).run();
    };
    const result = await request(app.getHttpServer())
      .get(`${URL}/${applicationId}/photos/receipt`)
      .set('Authorization', authorization)
      .expect(401);
    expect((result.body as { code: string }).code).toBe(
      'INVALID_ADMIN_SESSION',
    );
    expect(result.headers['content-type']).toMatch(/application\/json/);
  });

  it('rejects changed photo identity during storage access and propagates storage failures', async () => {
    beforeGet = () => {
      database.db
        .update(mileagePhotos)
        .set({ storageKey: 'replaced.jpg' })
        .where(eq(mileagePhotos.storageKey, 'private/receipt.jpg'))
        .run();
    };
    await request(app.getHttpServer())
      .get(`${URL}/${applicationId}/photos/receipt`)
      .set('Authorization', authorization)
      .expect(404);
    beforeGet = undefined;
    storageFailure = true;
    const failure = await request(app.getHttpServer())
      .get(`${URL}/${applicationId}/photos/receipt`)
      .set('Authorization', authorization)
      .expect(503);
    expect((failure.body as { code: string }).code).toBe(
      'PHOTO_STORAGE_UNAVAILABLE',
    );
  });

  async function snapshot() {
    const result = await request(app.getHttpServer())
      .get(`${URL}/${applicationId}`)
      .set('Authorization', authorization)
      .expect(200);
    return result.body as AdminMileageResponseDto;
  }
  function reject(input: object, auth = authorization) {
    return request(app.getHttpServer())
      .post(`${URL}/${applicationId}/reject`)
      .set('Authorization', auth)
      .send(input);
  }

  function ocrJob() {
    const repository = app.get(MileageRepository);
    const record = repository.findOne(userId, applicationId)!;
    return database.db
      .insert(mileageOcrJobs)
      .values({
        id: randomUUID(),
        applicationId,
        sourceVersion: repository.submissionVersion(record),
        extractorVersion: OCR_VERSION,
        status: 'running',
      })
      .returning()
      .get();
  }

  const reading = {
    receipt: {
      amountText: '10000원',
      transactionDateText: null,
      transactionTimeText: null,
      quantityText: null,
      quantityUnit: 'unknown' as const,
      unitPriceText: null,
      documentKind: 'sale' as const,
      issues: [],
    },
    meter: {
      amountText: '10000원',
      litersText: '5.125 리터',
      unitPriceText: null,
      issues: [],
    },
    clovaError: null,
    lunaError: null,
    clovaDurationMs: null,
    lunaDurationMs: null,
    lunaInputTokens: null,
    lunaOutputTokens: null,
  };

  it('includes stored OCR liters in the review version even when amount and timestamps are unchanged', async () => {
    const job = ocrJob();
    app.get(MileageRepository).finishOcrJob(job, reading);
    const before = await snapshot();
    database.db
      .update(mileageOcrJobs)
      .set({
        result: {
          ...reading,
          meter: { ...reading.meter, litersText: '6.125 리터' },
        },
      })
      .where(eq(mileageOcrJobs.id, job.id))
      .run();
    const after = await snapshot();
    expect(after.reviewVersion).not.toBe(before.reviewVersion);
    expect(after.meterAmount).toBe(before.meterAmount);
    await reject({ reviewVersion: before.reviewVersion }).expect(409);
  });

  it('preserves a reasonless rejection replay after late OCR finishes without applying its readings', async () => {
    const job = ocrJob();
    const before = await snapshot();
    const rejected = await reject({
      reviewVersion: before.reviewVersion,
    }).expect(200);
    app.get(MileageRepository).finishOcrJob(job, reading);
    await reject({ reviewVersion: before.reviewVersion })
      .expect(200)
      .expect(rejected.body);
    expect((await snapshot()).meterAmount).toBeNull();
  });

  it('requires only the current review version and stores no new rejection reason', async () => {
    const { reviewVersion } = await snapshot();
    for (const input of [
      {},
      { reviewVersion: 'wrong' },
      { reviewVersion, rejectionReason: '사유' },
      { reviewVersion, rejectionReason: null },
      { reviewVersion, finalAmount: 100 },
      { reviewVersion, status: 'approved' },
    ]) {
      await reject(input).expect(400);
    }
    const result = await reject({ reviewVersion }).expect(200);
    const body = result.body as AdminMileageResponseDto;
    expect(body).toMatchObject({
      status: 'rejected',
      rejectionReason: null,
      finalAmount: null,
      mileageAmount: null,
      settlementId: null,
      reviewVersion,
    });
    expect(Date.parse(body.decidedAt!)).toBeLessThanOrEqual(Date.now());
    await reject({ reviewVersion }).expect(200).expect(body);
    expect(await snapshot()).toEqual(body);
  });

  it('preserves a historical rejection reason and decision timestamp on reasonless replay', async () => {
    database.db
      .update(mileageApplications)
      .set({
        approvalStatus: 'rejected',
        rejectionReason: '과거 사유',
        decidedAt: '2026-09-22T01:00:00Z',
      })
      .where(eq(mileageApplications.id, applicationId))
      .run();
    const before = await snapshot();
    await reject({ reviewVersion: before.reviewVersion })
      .expect(200)
      .expect(before);
    expect(await snapshot()).toEqual(before);
  });

  it('requires administrator authentication and exact Origin for cookie rejection', async () => {
    const { reviewVersion } = await snapshot();
    const body = { reviewVersion };
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    database.db
      .insert(authSessions)
      .values({
        tokenHash: createHash('sha256').update(token).digest('hex'),
        userId,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + 600000),
      })
      .run();
    await request(app.getHttpServer())
      .post(`${URL}/${applicationId}/reject`)
      .send(body)
      .expect(401);
    await reject(body, `Bearer ${token}`).expect(401);
    const previousOrigins = process.env.WEB_ORIGINS;
    process.env.WEB_ORIGINS = 'http://localhost:5173';
    try {
      for (const origin of [
        null,
        'https://evil.example',
        'http://localhost:5173.evil.example',
      ]) {
        const req = request(app.getHttpServer())
          .post(`${URL}/${applicationId}/reject`)
          .set(
            'Cookie',
            `${ADMIN_WEB_SESSION_COOKIE}=${authorization.slice(7)}`,
          )
          .send(body);
        if (origin) req.set('Origin', origin);
        await req.expect(403);
      }
      expect((await snapshot()).status).toBe('pending');
      await request(app.getHttpServer())
        .post(`${URL}/${applicationId}/reject`)
        .set('Cookie', `${ADMIN_WEB_SESSION_COOKIE}=${authorization.slice(7)}`)
        .set('Origin', 'http://localhost:5173')
        .send(body)
        .expect(200);
    } finally {
      if (previousOrigins === undefined) delete process.env.WEB_ORIGINS;
      else process.env.WEB_ORIGINS = previousOrigins;
    }
  });

  it('serializes identical reasonless rejections and preserves the first decision', async () => {
    const { reviewVersion } = await snapshot();
    const secondAdmin = seedAdminSession(database);
    const responses = await Promise.all(
      [authorization, secondAdmin].map((auth) =>
        reject({ reviewVersion }, auth),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses[0].body).toEqual(responses[1].body);
    const before = await snapshot();
    await reject({ reviewVersion }).expect(200).expect(before);
  });

  it('blocks stale reviews after photo replacement or changed OCR input, even with unchanged timestamps', async () => {
    const old = await snapshot();
    database.db
      .update(mileagePhotos)
      .set({ storageKey: 'private/new-receipt.jpg' })
      .where(eq(mileagePhotos.storageKey, 'private/receipt.jpg'))
      .run();
    await reject({
      reviewVersion: old.reviewVersion,
    }).expect(409);
    const changed = await snapshot();
    database.db
      .update(mileageApplications)
      .set({ meterAmount: 12345 })
      .where(eq(mileageApplications.id, applicationId))
      .run();
    await reject({
      reviewVersion: changed.reviewVersion,
    }).expect(409);
    expect((await snapshot()).status).toBe('pending');
  });

  it('does not apply an old rejection to a replaced-photo pending submission', async () => {
    const old = await snapshot();
    await reject({
      reviewVersion: old.reviewVersion,
    }).expect(200);
    // Models the atomic DB result of re-registration; no driver endpoint is claimed here.
    database.db.transaction(
      (tx) => {
        tx.update(mileagePhotos)
          .set({ storageKey: 'private/resubmitted.jpg' })
          .where(eq(mileagePhotos.storageKey, 'private/receipt.jpg'))
          .run();
        tx.update(mileageApplications)
          .set({
            approvalStatus: 'pending',
            rejectionReason: null,
            decidedAt: null,
          })
          .where(eq(mileageApplications.id, applicationId))
          .run();
      },
      { behavior: 'immediate' },
    );
    await reject({
      reviewVersion: old.reviewVersion,
    }).expect(409);
    const fresh = await snapshot();
    expect(fresh.status).toBe('pending');
    expect(fresh.reviewVersion).not.toBe(old.reviewVersion);
    await reject({
      reviewVersion: fresh.reviewVersion,
    }).expect(200);
  });

  it('never changes approved or settlement-attached applications', async () => {
    const old = await snapshot();
    database.db
      .update(mileageApplications)
      .set({
        approvalStatus: 'approved',
        finalAmount: 10000,
        mileageAmount: 200,
        decidedAt: '2026-09-22T01:00:00Z',
      })
      .where(eq(mileageApplications.id, applicationId))
      .run();
    await reject({
      reviewVersion: old.reviewVersion,
    }).expect(409);
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
      .set({ settlementId })
      .where(eq(mileageApplications.id, applicationId))
      .run();
    for (const complete of [false, true]) {
      if (complete)
        database.db
          .update(settlements)
          .set({
            transferStatus: 'completed',
            transferredAt: new Date().toISOString(),
          })
          .where(eq(settlements.id, settlementId))
          .run();
      const before = await snapshot();
      await reject({
        reviewVersion: before.reviewVersion,
      }).expect(409);
      expect(await snapshot()).toEqual(before);
    }
  });

  it('rolls back database failures instead of reporting rejection success', async () => {
    const before = await snapshot();
    database.connection.exec(
      "CREATE TRIGGER reject_failure BEFORE UPDATE ON mileage_applications BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
    );
    await reject({
      reviewVersion: before.reviewVersion,
    }).expect(500);
    expect(await snapshot()).toEqual(before);
  });

  it('publishes read and rejection contracts without promising approval', async () => {
    const swagger = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = swagger.body as OpenAPIObject;
    expect(document.paths[URL]?.get).toBeDefined();
    expect(document.paths[URL + '/{id}']?.get).toBeDefined();
    expect(
      JSON.stringify(
        document.paths[URL + '/{id}/photos/{kind}']?.get?.responses['200'],
      ),
    ).toContain('image/jpeg');
    expect(document.paths[URL + '/{id}/reject']?.post).toBeDefined();
    expect(document.paths[URL + '/{id}/approve']?.post).toBeUndefined();
  });
});
