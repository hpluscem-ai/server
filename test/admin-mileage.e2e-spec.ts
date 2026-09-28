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
import { SettlementsService } from '../src/settlements';
import { createTestDatabase } from './helpers/create-test-database';

const URL = '/api/v1/admin/mileage/applications';

describe('Admin mileage reads and review (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let authorization: string;
  let companyId: string;
  let userId: string;
  let applicationId: string;
  let jpeg: Buffer;
  let beforeGet: (() => Promise<void>) | undefined;
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
    beforeGet = undefined;
    storageFailure = false;
    storedKeys.length = 0;
    database = await createTestDatabase();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue(database)
      .overrideProvider(PhotoStorageService)
      .useValue({
        get: async (key: string) => {
          storedKeys.push(key);
          await beforeGet?.();
          if (storageFailure)
            throw new ServiceUnavailableException({
              code: 'PHOTO_STORAGE_UNAVAILABLE',
            });
          return jpeg;
        },
      })
      .compile();
    app = module.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    authorization = await seedAdminSession(database);
    companyId = await addCompany();
    userId = randomUUID();
    await database.db.insert(users).values({
      id: userId,
      role: 'driver',
      email: 'driver@example.test',
      name: '김 %_ 기사',
      phone: '010-1234-5678',
      passwordHash: 'unused-test-hash',
      logisticsCompanyId: companyId,
      serviceTermsConsent: true,
      privacyTermsConsent: true,
    });
    applicationId = randomUUID();
    await database.db.insert(mileageApplications).values({
      id: applicationId,
      userId,
      logisticsCompanyId: companyId,
      idempotencyKey: randomUUID(),
      submittedAt: '2026-09-22T00:00:00Z',
    });
    for (const kind of ['receipt', 'meter'] as const) {
      await database.db.insert(mileagePhotos).values({
        id: randomUUID(),
        mileageApplicationId: applicationId,
        kind,
        storageKey: `private/${kind}.jpg`,
        originalStorageKey: `private/original-${kind}.png`,
        contentType: 'image/jpeg',
        byteSize: jpeg.length,
      });
    }
  });
  afterEach(async () => {
    await app?.close();
    await database?.onApplicationShutdown();
  });

  async function addCompany() {
    const id = randomUUID();
    await database.db.insert(logisticsCompanies).values({
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
    });
    return id;
  }

  it('requires an administrator for every read and accepts the existing admin cookie', async () => {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await database.db.insert(authSessions).values({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      userId,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 600000),
    });
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
    const secondCompany = await addCompany();
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
    await database.db
      .update(mileageApplications)
      .set({
        approvalStatus: 'approved',
        finalAmount: 10000,
        mileageAmount: 200,
        decidedAt: '2026-09-22T01:00:00Z',
      })
      .where(eq(mileageApplications.id, applicationId));
    const settlementId = randomUUID();
    await database.db.insert(settlements).values({
      id: settlementId,
      logisticsCompanyId: companyId,
      settlementMonth: '2026-09',
      transferStatus: 'pending',
    });
    await database.db
      .update(mileageApplications)
      .set({ settlementId })
      .where(eq(mileageApplications.id, applicationId));
    await database.db
      .update(settlements)
      .set({
        transferStatus: 'completed',
        transferredAt: '2026-09-22T02:00:00Z',
      })
      .where(eq(settlements.id, settlementId));
    await database.db
      .update(users)
      .set({ deactivatedAt: '2026-09-22T03:00:00Z', passwordHash: null })
      .where(eq(users.id, userId));
    await database.db
      .update(logisticsCompanies)
      .set({ active: false })
      .where(eq(logisticsCompanies.id, companyId));
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
    await database.db
      .delete(mileagePhotos)
      .where(eq(mileagePhotos.mileageApplicationId, applicationId));
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
    beforeGet = async () => {
      await database.db.delete(adminSessions);
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
    beforeGet = async () => {
      await database.db
        .update(mileagePhotos)
        .set({ storageKey: 'replaced.jpg' })
        .where(eq(mileagePhotos.storageKey, 'private/receipt.jpg'));
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
      .send({ rejectionReason: '금액 불일치', ...input });
  }
  function approve(input: object, auth = authorization) {
    return request(app.getHttpServer())
      .post(`${URL}/${applicationId}/approve`)
      .set('Authorization', auth)
      .send(input);
  }

  async function adminSessionDiagnostic() {
    const token = authorization.slice('Bearer '.length);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return (
      await database.db
        .select({
          userId: users.id,
          role: users.role,
          deactivatedAt: users.deactivatedAt,
          createdAt: adminSessions.createdAt,
          expiresAt: adminSessions.expiresAt,
        })
        .from(adminSessions)
        .innerJoin(users, eq(adminSessions.userId, users.id))
        .where(eq(adminSessions.tokenHash, tokenHash))
        .limit(1)
    )[0];
  }

  it.each([
    ['5.124', 102],
    ['5.125', 103],
    ['11', 220],
    ['0', 0],
  ])(
    'approves admin-confirmed values using exact rounding for %s L',
    async (liters, mileageAmount) => {
      await database.db
        .update(mileageApplications)
        .set({
          receiptAmount: 10000,
          meterAmount: 8000,
          matchStatus: 'mismatched',
        })
        .where(eq(mileageApplications.id, applicationId));
      const before = await snapshot();
      const result = await approve({
        reviewVersion: before.reviewVersion,
        finalAmount: 10000,
        liters,
      }).expect(200);
      expect(result.body).toMatchObject({
        status: 'approved',
        finalAmount: 10000,
        mileageAmount,
        receiptAmount: 10000,
        meterAmount: 8000,
        matchStatus: 'mismatched',
        rejectionReason: null,
      });
      expect((result.body as AdminMileageResponseDto).reviewVersion).not.toBe(
        before.reviewVersion,
      );
      expect((result.body as AdminMileageResponseDto).decidedAt).not.toBeNull();
      expect(await snapshot()).toEqual(result.body);
      expect(await app.get(SettlementsService).balance(userId)).toEqual({
        accumulatedMileage: mileageAmount,
      });
    },
  );

  it('validates manual approval inputs and refuses client-supplied mileage', async () => {
    const reviewVersion = (await snapshot()).reviewVersion;
    const valid = { reviewVersion, finalAmount: 10000, liters: '5.125' };
    for (const input of [
      {},
      { reviewVersion },
      ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10000', null].map(
        (finalAmount) => ({ ...valid, finalAmount }),
      ),
      ...['', '-1', '1e2', '5 L', '1.2345', '100000', 5, null].map(
        (liters) => ({ ...valid, liters }),
      ),
      { ...valid, reviewVersion: 'wrong' },
      { ...valid, mileageAmount: 999 },
    ]) {
      const response = await approve(input);
      if (response.status !== 400) {
        throw new Error(
          `Expected 400 for manual approval validation, got ${response.status}; ` +
            `session=${JSON.stringify(await adminSessionDiagnostic())}`,
        );
      }
      expect(response.status).toBe(400);
    }
    expect((await snapshot()).status).toBe('pending');
    await approve({ ...valid, finalAmount: 0, liters: '0' }).expect(200);
  });

  it('preserves repeated approval and rejects different decisions or late OCR overwrites', async () => {
    const job = await ocrJob();
    const reviewVersion = (await snapshot()).reviewVersion;
    const body = { reviewVersion, finalAmount: 10000, liters: '5.125' };
    const responses = await Promise.all(
      [authorization, await seedAdminSession(database)].map((auth) =>
        approve(body, auth),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses[0].body).toEqual(responses[1].body);
    await app.get(MileageRepository).finishOcrJob(job, reading);
    await approve(body).expect(200).expect(responses[0].body);
    await approve({ ...body, finalAmount: 20000 }).expect(409);
    await approve({ ...body, liters: '10' }).expect(409);
    await reject({ reviewVersion }).expect(409);
    expect(await snapshot()).toEqual(responses[0].body);
  });

  it('reverses approval and rejection before settlement without replaying earlier decisions', async () => {
    const original = await snapshot();
    const firstInput = {
      reviewVersion: original.reviewVersion,
      finalAmount: 10000,
      liters: '5',
    };
    const first = (await approve(firstInput).expect(200))
      .body as AdminMileageResponseDto;
    const rejectInput = {
      reviewVersion: first.reviewVersion,
      rejectionReason: '금액 재확인',
    };
    const rejected = (await reject(rejectInput).expect(200))
      .body as AdminMileageResponseDto;
    expect(rejected).toMatchObject({
      status: 'rejected',
      finalAmount: null,
      mileageAmount: null,
      rejectionReason: '금액 재확인',
    });
    expect(await app.get(SettlementsService).balance(userId)).toEqual({
      accumulatedMileage: 0,
    });
    await reject(rejectInput).expect(200).expect(rejected);
    await approve(firstInput).expect(409);
    const secondInput = {
      reviewVersion: rejected.reviewVersion,
      finalAmount: 20000,
      liters: '10',
    };
    const second = (await approve(secondInput).expect(200))
      .body as AdminMileageResponseDto;
    expect(second).toMatchObject({
      status: 'approved',
      finalAmount: 20000,
      mileageAmount: 200,
      rejectionReason: null,
    });
    expect(
      new Set([
        original.reviewVersion,
        first.reviewVersion,
        rejected.reviewVersion,
        second.reviewVersion,
      ]).size,
    ).toBe(4);
    expect(await app.get(SettlementsService).balance(userId)).toEqual({
      accumulatedMileage: 200,
    });
    await approve(secondInput).expect(200).expect(second);
    await reject(rejectInput).expect(409);
    await approve(firstInput).expect(409);
    await approve({
      ...secondInput,
      reviewVersion: second.reviewVersion,
      finalAmount: 30000,
    }).expect(409);
    expect(await snapshot()).toEqual(second);
    expect(second).not.toHaveProperty('reviewReplay');
    const third = (
      await reject({
        reviewVersion: second.reviewVersion,
        rejectionReason: '금액 재확인',
      }).expect(200)
    ).body as AdminMileageResponseDto;
    await approve(secondInput).expect(409);
    await reject(rejectInput).expect(409);
    expect(await snapshot()).toEqual(third);
  });

  it('does not replay a decision after its photo evidence changes', async () => {
    const before = await snapshot();
    const input = {
      reviewVersion: before.reviewVersion,
      rejectionReason: '사진 확인',
    };
    await reject(input).expect(200);
    await database.db
      .update(mileagePhotos)
      .set({ storageKey: 'private/replacement.jpg' })
      .where(eq(mileagePhotos.storageKey, 'private/receipt.jpg'));
    await reject(input).expect(409);
  });

  it('blocks reversal after the transfer file captures an approved application', async () => {
    await database.db
      .update(mileageApplications)
      .set({
        approvalStatus: 'approved',
        finalAmount: 10000,
        mileageAmount: 100,
        decidedAt: '2020-09-22T00:00:00Z',
      })
      .where(eq(mileageApplications.id, applicationId));
    const before = await snapshot();
    const admin = await adminSessionDiagnostic();
    await app.get(SettlementsService).export('2020-09', admin.userId);
    const captured = await snapshot();
    expect(captured.settlementId).not.toBeNull();
    await reject({ reviewVersion: before.reviewVersion }).expect(409);
    await reject({ reviewVersion: captured.reviewVersion }).expect(409);
    expect(await snapshot()).toEqual(captured);
    expect(await app.get(SettlementsService).balance(userId)).toEqual({
      accumulatedMileage: 100,
    });
  });

  it('serializes competing reversals and refuses the stale competing decision', async () => {
    const initial = await snapshot();
    const approved = (
      await approve({
        reviewVersion: initial.reviewVersion,
        finalAmount: 10000,
        liters: '5',
      }).expect(200)
    ).body as AdminMileageResponseDto;
    const responses = await Promise.all(
      ['사유 A', '사유 B'].map((rejectionReason) =>
        reject({ reviewVersion: approved.reviewVersion, rejectionReason }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(await snapshot()).toEqual(
      responses.find((response) => response.status === 200)!.body,
    );
    expect(await app.get(SettlementsService).balance(userId)).toEqual({
      accumulatedMileage: 0,
    });
  });

  it('approves more concurrent reviews than the database pool has connections', async () => {
    const applicationIds = [applicationId];
    for (let index = 0; index < 5; index++) {
      const id = randomUUID();
      applicationIds.push(id);
      await database.db.insert(mileageApplications).values({
        id,
        userId,
        logisticsCompanyId: companyId,
        idempotencyKey: randomUUID(),
        submittedAt: '2026-09-22T00:00:00Z',
      });
      await database.db.insert(mileagePhotos).values(
        (['receipt', 'meter'] as const).map((kind) => ({
          id: randomUUID(),
          mileageApplicationId: id,
          kind,
          storageKey: `private/${id}/${kind}.jpg`,
          contentType: 'image/jpeg',
          byteSize: jpeg.length,
        })),
      );
    }

    const details = await Promise.all(
      applicationIds.map(async (id) => {
        const response = await request(app.getHttpServer())
          .get(`${URL}/${id}`)
          .set('Authorization', authorization)
          .expect(200);
        return response.body as AdminMileageResponseDto;
      }),
    );
    const responses = await Promise.all(
      details.map((detail) =>
        request(app.getHttpServer())
          .post(`${URL}/${detail.id}/approve`)
          .set('Authorization', authorization)
          .send({
            reviewVersion: detail.reviewVersion,
            finalAmount: 10000,
            liters: '5',
          }),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual(
      Array(applicationIds.length).fill(200),
    );
    for (const [index, response] of responses.entries()) {
      expect(response.body).toMatchObject({
        id: applicationIds[index],
        status: 'approved',
        finalAmount: 10000,
        mileageAmount: 100,
      });
    }
  });

  it('blocks stale, missing-photo and settlement-attached approval', async () => {
    const old = await snapshot();
    await database.db
      .update(mileagePhotos)
      .set({ storageKey: 'private/replaced.jpg' })
      .where(eq(mileagePhotos.storageKey, 'private/receipt.jpg'));
    await approve({
      reviewVersion: old.reviewVersion,
      finalAmount: 10000,
      liters: '5',
    }).expect(409);
    let current = await snapshot();
    await reject({ reviewVersion: current.reviewVersion }).expect(200);
    await approve({
      reviewVersion: current.reviewVersion,
      finalAmount: 10000,
      liters: '5',
    }).expect(409);
    await database.db
      .update(mileageApplications)
      .set({ approvalStatus: 'pending', decidedAt: null })
      .where(eq(mileageApplications.id, applicationId));
    current = await snapshot();
    await approve({
      reviewVersion: current.reviewVersion,
      finalAmount: 10000,
      liters: '5',
    }).expect(200);
    const settlementId = randomUUID();
    await database.db.insert(settlements).values({
      id: settlementId,
      logisticsCompanyId: companyId,
      settlementMonth: '2026-09',
      transferStatus: 'pending',
    });
    await database.db
      .update(mileageApplications)
      .set({ settlementId })
      .where(eq(mileageApplications.id, applicationId));
    current = await snapshot();
    await approve({
      reviewVersion: current.reviewVersion,
      finalAmount: 10000,
      liters: '5',
    }).expect(409);
    expect(await snapshot()).toEqual(current);
    await database.db
      .update(mileageApplications)
      .set({
        settlementId: null,
        approvalStatus: 'pending',
        finalAmount: null,
        mileageAmount: null,
        decidedAt: null,
      })
      .where(eq(mileageApplications.id, applicationId));
    await database.db
      .delete(mileagePhotos)
      .where(eq(mileagePhotos.kind, 'meter'));
    current = await snapshot();
    await approve({
      reviewVersion: current.reviewVersion,
      finalAmount: 10000,
      liters: '5',
    }).expect(409);
    expect(await snapshot()).toEqual(current);
  });

  async function ocrJob() {
    const repository = app.get(MileageRepository);
    const record = (await repository.findOne(userId, applicationId))!;
    await database.db.insert(mileageOcrJobs).values({
      id: randomUUID(),
      applicationId,
      sourceVersion: repository.submissionVersion(record),
      extractorVersion: OCR_VERSION,
    });
    return (await repository.claimOcrJob())!;
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
    const job = await ocrJob();
    await app.get(MileageRepository).finishOcrJob(job, reading);
    const before = await snapshot();
    await database.db
      .update(mileageOcrJobs)
      .set({
        result: {
          ...reading,
          meter: { ...reading.meter, litersText: '6.125 리터' },
        },
      })
      .where(eq(mileageOcrJobs.id, job.id));
    const after = await snapshot();
    expect(after.reviewVersion).not.toBe(before.reviewVersion);
    expect(after.meterAmount).toBe(before.meterAmount);
    await reject({ reviewVersion: before.reviewVersion }).expect(409);
  });

  it('preserves a rejection reason on replay after late OCR finishes without applying its readings', async () => {
    const job = await ocrJob();
    const before = await snapshot();
    const rejected = await reject({
      reviewVersion: before.reviewVersion,
    }).expect(200);
    await app.get(MileageRepository).finishOcrJob(job, reading);
    await reject({ reviewVersion: before.reviewVersion })
      .expect(200)
      .expect(rejected.body);
    expect((await snapshot()).meterAmount).toBeNull();
  });

  it('requires a nonblank reason of at most 150 characters and stores trimmed multiline text', async () => {
    const { reviewVersion } = await snapshot();
    for (const input of [
      {},
      { reviewVersion: 'wrong' },
      ...[undefined, null, '', ' \n ', 1, [], '가'.repeat(151)].map(
        (rejectionReason) => ({ reviewVersion, rejectionReason }),
      ),
      { reviewVersion, finalAmount: 100 },
      { reviewVersion, status: 'approved' },
    ])
      await reject(input).expect(400);
    expect((await snapshot()).status).toBe('pending');
    const rejectionReason = '가'.repeat(148) + '\n나';
    const result = await reject({
      reviewVersion,
      rejectionReason: `  ${rejectionReason}  `,
    }).expect(200);
    const body = result.body as AdminMileageResponseDto;
    expect(body).toMatchObject({
      status: 'rejected',
      rejectionReason,
      finalAmount: null,
      mileageAmount: null,
      settlementId: null,
    });
    expect(body.reviewVersion).not.toBe(reviewVersion);
    expect(Date.parse(body.decidedAt!)).toBeLessThanOrEqual(Date.now());
    await reject({ reviewVersion, rejectionReason }).expect(200).expect(body);
    await reject({ reviewVersion, rejectionReason: '다른 사유' }).expect(409);
    expect(await snapshot()).toEqual(body);
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await database.db.insert(authSessions).values({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      userId,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 600000),
    });
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/mileage/applications/${applicationId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(detail.body).toMatchObject({ status: 'rejected', rejectionReason });
  });

  it('preserves historical reasons and prevents rewriting an existing rejection', async () => {
    await database.db
      .update(mileageApplications)
      .set({
        approvalStatus: 'rejected',
        rejectionReason: '과거 사유',
        decidedAt: '2026-09-22T01:00:00Z',
      })
      .where(eq(mileageApplications.id, applicationId));
    const before = await snapshot();
    await reject({
      reviewVersion: before.reviewVersion,
      rejectionReason: '과거 사유',
    })
      .expect(200)
      .expect(before);
    await reject({ reviewVersion: before.reviewVersion }).expect(409);
    expect(await snapshot()).toEqual(before);
  });

  it.each(['approve', 'reject'])(
    'requires administrator authentication and exact Origin for cookie %s',
    async (action) => {
      const { reviewVersion } = await snapshot();
      const body =
        action === 'approve'
          ? { reviewVersion, finalAmount: 10000, liters: '5' }
          : { reviewVersion, rejectionReason: '금액 불일치' };
      const send = action === 'approve' ? approve : reject;
      const token = randomBytes(32).toString('base64url');
      const now = new Date();
      await database.db.insert(authSessions).values({
        tokenHash: createHash('sha256').update(token).digest('hex'),
        userId,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + 600000),
      });
      await request(app.getHttpServer())
        .post(`${URL}/${applicationId}/${action}`)
        .send(body)
        .expect(401);
      await send(body, `Bearer ${token}`).expect(401);
      const previousOrigins = process.env.WEB_ORIGINS;
      process.env.WEB_ORIGINS = 'http://localhost:5173';
      try {
        for (const origin of [
          null,
          'https://evil.example',
          'http://localhost:5173.evil.example',
        ]) {
          const req = request(app.getHttpServer())
            .post(`${URL}/${applicationId}/${action}`)
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
          .post(`${URL}/${applicationId}/${action}`)
          .set(
            'Cookie',
            `${ADMIN_WEB_SESSION_COOKIE}=${authorization.slice(7)}`,
          )
          .set('Origin', 'http://localhost:5173')
          .send(body)
          .expect(200);
      } finally {
        if (previousOrigins === undefined) delete process.env.WEB_ORIGINS;
        else process.env.WEB_ORIGINS = previousOrigins;
      }
    },
  );

  it('serializes identical rejections and preserves the first decision', async () => {
    const { reviewVersion } = await snapshot();
    const secondAdmin = await seedAdminSession(database);
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
    await database.db
      .update(mileagePhotos)
      .set({ storageKey: 'private/new-receipt.jpg' })
      .where(eq(mileagePhotos.storageKey, 'private/receipt.jpg'));
    await reject({
      reviewVersion: old.reviewVersion,
    }).expect(409);
    const changed = await snapshot();
    await database.db
      .update(mileageApplications)
      .set({ meterAmount: 12345 })
      .where(eq(mileageApplications.id, applicationId));
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
    await database.db.transaction(async (tx) => {
      await tx
        .update(mileagePhotos)
        .set({ storageKey: 'private/resubmitted.jpg' })
        .where(eq(mileagePhotos.storageKey, 'private/receipt.jpg'));
      await tx
        .update(mileageApplications)
        .set({
          approvalStatus: 'pending',
          rejectionReason: null,
          decidedAt: null,
        })
        .where(eq(mileageApplications.id, applicationId));
    });
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

  it('never changes applications from a stale decision or after settlement attachment', async () => {
    const old = await snapshot();
    await database.db
      .update(mileageApplications)
      .set({
        approvalStatus: 'approved',
        finalAmount: 10000,
        mileageAmount: 200,
        decidedAt: '2026-09-22T01:00:00Z',
      })
      .where(eq(mileageApplications.id, applicationId));
    await reject({
      reviewVersion: old.reviewVersion,
    }).expect(409);
    const settlementId = randomUUID();
    await database.db.insert(settlements).values({
      id: settlementId,
      logisticsCompanyId: companyId,
      settlementMonth: '2026-09',
      transferStatus: 'pending',
    });
    await database.db
      .update(mileageApplications)
      .set({ settlementId })
      .where(eq(mileageApplications.id, applicationId));
    for (const complete of [false, true]) {
      if (complete)
        await database.db
          .update(settlements)
          .set({
            transferStatus: 'completed',
            transferredAt: new Date().toISOString(),
          })
          .where(eq(settlements.id, settlementId));
      const before = await snapshot();
      await reject({
        reviewVersion: before.reviewVersion,
      }).expect(409);
      expect(await snapshot()).toEqual(before);
    }
  });

  it.each(['approve', 'reject'])(
    'rolls back database failures instead of reporting %s success',
    async (action) => {
      const before = await snapshot();
      await database.connection.unsafe(
        `CREATE FUNCTION app.reject_failure() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'test failure'; END;
         $$`,
      );
      await database.connection.unsafe(
        'CREATE TRIGGER reject_failure BEFORE UPDATE ON app.mileage_applications FOR EACH ROW EXECUTE FUNCTION app.reject_failure()',
      );
      try {
        const body =
          action === 'approve'
            ? {
                reviewVersion: before.reviewVersion,
                finalAmount: 10000,
                liters: '5',
              }
            : { reviewVersion: before.reviewVersion };
        await (action === 'approve' ? approve(body) : reject(body)).expect(500);
        expect(await snapshot()).toEqual(before);
      } finally {
        await database.connection.unsafe(
          'DROP TRIGGER reject_failure ON app.mileage_applications',
        );
        await database.connection.unsafe('DROP FUNCTION app.reject_failure()');
      }
    },
  );

  it('publishes read and both review contracts', async () => {
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
    expect(document.paths[URL + '/{id}/approve']?.post).toBeDefined();
    expect(document.components?.schemas?.RejectAdminMileageDto).toMatchObject({
      required: ['reviewVersion', 'rejectionReason'],
      properties: { rejectionReason: { minLength: 1, maxLength: 150 } },
    });
    expect(document.components?.schemas?.ApproveAdminMileageDto).toMatchObject({
      required: ['reviewVersion', 'finalAmount', 'liters'],
    });
  });
});
