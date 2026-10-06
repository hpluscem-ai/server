import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { DatabaseService } from '../src/database/database.service';
import {
  authSessions,
  logisticsCompanies,
  mileageApplications,
  mileagePhotos,
  settlements,
  users,
} from '../src/database/schema';
import { createTestApp } from './helpers/create-test-app';
import { seedAdminSession } from './helpers/seed-admin-session';

const PATH = '/api/v1/admin/drivers';
describe('Admin driver list (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let authorization: string;
  let companyId: string;
  let userId: string;
  beforeEach(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
    authorization = await seedAdminSession(database);
    companyId = randomUUID();
    userId = randomUUID();
    await database.db.insert(logisticsCompanies).values({
      id: companyId,
      businessName: '물류사',
      businessNumber: '123-45-67890',
      corporateRegistrationNumber: '123456-1234567',
      businessAddress: '서울시',
      managerName: '담당자',
      managerPhone: '010-1234-5678',
      bankCode: '19',
      accountNumber: '12345',
      accountHolder: '물류사',
      active: false,
    });
    await database.db.insert(users).values({
      id: userId,
      role: 'driver',
      email: 'driver@example.com',
      name: 'ÉLODIE 기사',
      passwordHash: 'private-hash',
      phone: '010-8888-9999',
      logisticsCompanyId: companyId,
      serviceTermsConsent: true,
      privacyTermsConsent: true,
      createdAt: '2026-09-07 15:00:00',
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });
  function list(query: object = {}, auth = authorization) {
    return request(app.getHttpServer())
      .get(PATH)
      .set('Authorization', auth)
      .query(query);
  }

  it('returns driver fields and zero totals, including inactive companies', async () => {
    await list()
      .expect(200)
      .expect('Cache-Control', 'no-store')
      .expect([
        {
          id: userId,
          logisticsCompanyId: companyId,
          logisticsCompanyName: '물류사',
          name: 'ÉLODIE 기사',
          phone: '010-8888-9999',
          email: 'driver@example.com',
          joinedAt: '2026-09-07T15:00:00.000Z',
          totalAmount: 0,
          mileage: 0,
        },
      ]);
  });
  async function addApplication(
    driverId: string,
    status: 'pending' | 'approved' | 'rejected',
    finalAmount: number | null,
    mileageAmount: number | null,
  ) {
    const id = randomUUID();
    await database.db.insert(mileageApplications).values({
      id,
      userId: driverId,
      logisticsCompanyId: companyId,
      idempotencyKey: randomUUID(),
      submittedAt: '2026-01-01T00:00:00Z',
    });
    for (const kind of ['receipt', 'meter'] as const) {
      await database.db.insert(mileagePhotos).values({
        id: randomUUID(),
        mileageApplicationId: id,
        kind,
        storageKey: `private/${id}/${kind}.jpg`,
        contentType: 'image/jpeg',
        byteSize: 10,
      });
    }
    await database.db
      .update(mileageApplications)
      .set({
        approvalStatus: status,
        finalAmount,
        mileageAmount,
        decidedAt: status === 'pending' ? null : '2026-01-02T00:00:00Z',
      })
      .where(eq(mileageApplications.id, id));
    return id;
  }

  it('keeps lifetime approved totals before and after settlement completion', async () => {
    const settled = await addApplication(userId, 'approved', 10000, 200);
    const unpaid = await addApplication(userId, 'approved', 5000, 100);
    await addApplication(userId, 'pending', 9000, 900);
    await addApplication(userId, 'rejected', 8000, 800);
    const settlementId = randomUUID();
    await database.db.insert(settlements).values({
      id: settlementId,
      logisticsCompanyId: companyId,
      settlementMonth: '2026-01',
    });
    await database.db
      .update(mileageApplications)
      .set({ settlementId })
      .where(eq(mileageApplications.id, settled));
    await database.db
      .update(settlements)
      .set({
        transferStatus: 'completed',
        transferredAt: '2026-02-01T00:00:00Z',
      })
      .where(eq(settlements.id, settlementId));
    const expected = { totalAmount: 15000, mileage: 300 };
    const before = await list().expect(200);
    expect((before.body as unknown[])[0]).toMatchObject(expected);
    const nextSettlementId = randomUUID();
    await database.db.insert(settlements).values({
      id: nextSettlementId,
      logisticsCompanyId: companyId,
      settlementMonth: '2026-02',
    });
    await database.db
      .update(mileageApplications)
      .set({ settlementId: nextSettlementId })
      .where(eq(mileageApplications.id, unpaid));
    await database.db
      .update(settlements)
      .set({
        transferStatus: 'completed',
        transferredAt: '2026-03-01T00:00:00Z',
      })
      .where(eq(settlements.id, nextSettlementId));
    const after = await list({
      createdFrom: '2026-09-07T00:00:00Z',
      createdBefore: '2026-09-08T00:00:00Z',
    }).expect(200);
    expect((after.body as unknown[])[0]).toMatchObject(expected);
  });

  it('separates same-name drivers and preserves old account totals after rejoining', async () => {
    const returningId = randomUUID();
    await database.db.insert(users).values({
      id: returningId,
      role: 'driver',
      email: 'returning@example.com',
      name: 'ÉLODIE 기사',
      phone: '010-7777-9999',
      passwordHash: 'unused-test-hash',
      logisticsCompanyId: companyId,
      serviceTermsConsent: true,
      privacyTermsConsent: true,
    });
    await addApplication(userId, 'approved', 10000, 200);
    await addApplication(returningId, 'approved', 5000, 100);
    let result = await list().expect(200);
    expect(result.body as unknown[]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: userId,
          totalAmount: 10000,
          mileage: 200,
        }),
        expect.objectContaining({
          id: returningId,
          totalAmount: 5000,
          mileage: 100,
        }),
      ]),
    );
    await database.db
      .update(users)
      .set({ deactivatedAt: '2026-10-01T00:00:00Z' })
      .where(eq(users.id, userId));
    const rejoinedId = randomUUID();
    await database.db.insert(users).values({
      id: rejoinedId,
      role: 'driver',
      email: 'driver@example.com',
      name: 'ÉLODIE 기사',
      phone: '010-8888-9999',
      passwordHash: 'unused-test-hash',
      logisticsCompanyId: companyId,
      serviceTermsConsent: true,
      privacyTermsConsent: true,
    });
    result = await list().expect(200);
    expect(result.body as unknown[]).toHaveLength(2);
    expect(result.body as unknown[]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: returningId,
          totalAmount: 5000,
          mileage: 100,
        }),
        expect.objectContaining({ id: rejoinedId, totalAmount: 0, mileage: 0 }),
      ]),
    );
  });

  it.each(['totalAmount', 'mileage'] as const)(
    'rejects unsafe accumulated %s instead of rounding or returning zero',
    async (field) => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await addApplication(
        userId,
        'approved',
        field === 'totalAmount' ? Number.MAX_SAFE_INTEGER : 0,
        field === 'mileage' ? Number.MAX_SAFE_INTEGER : 0,
      );
      await addApplication(userId, 'approved', 1, 1);
      await list().expect(500);
    },
  );
  it('filters by literal case-insensitive name and stable company id', async () => {
    await list({ nameQuery: ' élodie ', logisticsCompanyId: companyId })
      .expect(200)
      .expect(({ body }: { body: unknown[] }) => expect(body).toHaveLength(1));
    for (const query of [
      { nameQuery: '%' },
      { nameQuery: "' OR 1=1 --" },
      { nameQuery: '_' },
      { logisticsCompanyId: randomUUID() },
    ])
      await list(query).expect(200).expect([]);
  });
  it('uses explicit offset instants with inclusive start and exclusive end', async () => {
    await list({
      createdFrom: '2026-09-08T00:00:00+09:00',
      createdBefore: '2026-09-09T00:00:00+09:00',
    })
      .expect(200)
      .expect(({ body }: { body: unknown[] }) => expect(body).toHaveLength(1));
    await list({ createdBefore: '2026-09-08T00:00:00+09:00' })
      .expect(200)
      .expect([]);
  });

  it.each([
    {
      createdFrom: '2026-09-08T00:00:00+15:00',
      utc: '2026-09-07T09:00:00Z',
      key: 'createdFrom',
    },
    {
      createdBefore: '2026-09-07T23:00:00-15:00',
      utc: '2026-09-08T14:00:00Z',
      key: 'createdBefore',
    },
  ])(
    'normalizes equivalent instants before SQLite filtering: $key',
    async ({ key, utc, ...query }) => {
      const offset = await list(query).expect(200);
      const normalized = await list({ [key]: utc }).expect(200);
      expect(offset.body as unknown).toEqual(normalized.body as unknown);
      expect(offset.body as unknown[]).toHaveLength(1);
    },
  );
  it.each([
    { createdFrom: '2026-09-08' },
    { createdFrom: '2026-02-30T00:00:00Z' },
    { createdFrom: '2026-09-08T00:00:00' },
    {
      createdFrom: '2026-09-09T00:00:00Z',
      createdBefore: '2026-09-08T00:00:00Z',
    },
    { logisticsCompanyId: 'not-uuid' },
    { nameQuery: ['a', 'b'] },
    { includeTotals: true },
    { page: 1 },
  ])('rejects invalid or unsupported query %j', async (query) => {
    await list(query).expect(400);
  });
  it('requires admin authentication and rejects a driver token', async () => {
    await list({}, '').expect(401);
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await database.db.insert(authSessions).values({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      userId,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 600000),
    });
    await list({}, `Bearer ${token}`).expect(401);
  });
  it('does not expose deactivated users or privileged account fields', async () => {
    await database.db
      .update(users)
      .set({ deactivatedAt: '2026-09-01 00:00:00' })
      .where(eq(users.role, 'driver'));
    await list().expect(200).expect([]);
  });
  it('propagates DB failure instead of returning an empty list', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await database.connection.unsafe(
      'ALTER TABLE app.logistics_companies RENAME TO unavailable_companies',
    );
    try {
      await list().expect(500);
    } finally {
      await database.connection.unsafe(
        'ALTER TABLE app.unavailable_companies RENAME TO logistics_companies',
      );
    }
  });
  it('documents admin protection, lifetime totals and withdrawal', async () => {
    const result = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = result.body as OpenAPIObject;
    expect(document.paths[PATH]?.get?.security).toEqual([
      { admin: [] },
      { 'admin-session': [] },
    ]);
    expect(document.paths[PATH]?.get?.description).toContain(
      '정산 여부와 관계없이',
    );
    const schema = document.components?.schemas?.AdminDriverResponseDto;
    expect(
      schema &&
        'properties' in schema &&
        Object.keys(schema.properties ?? {}).sort(),
    ).toEqual([
      'email',
      'id',
      'joinedAt',
      'logisticsCompanyId',
      'logisticsCompanyName',
      'mileage',
      'name',
      'phone',
      'totalAmount',
    ]);
    await request(app.getHttpServer())
      .delete(`${PATH}/${userId}`)
      .set('Authorization', authorization)
      .expect(204);
  });
});
