import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { App } from 'supertest/types';
import { DatabaseService } from '../src/database/database.service';
import {
  authSessions,
  logisticsCompanies,
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
  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
  });
  beforeEach(() => {
    database.db.delete(users).run();
    database.db.delete(logisticsCompanies).run();
    authorization = seedAdminSession(database);
    companyId = randomUUID();
    userId = randomUUID();
    database.db
      .insert(logisticsCompanies)
      .values({
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
      })
      .run();
    database.db
      .insert(users)
      .values({
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
      })
      .run();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => app.close());
  function list(query: object = {}, auth = authorization) {
    return request(app.getHttpServer())
      .get(PATH)
      .set('Authorization', auth)
      .query(query);
  }

  it('returns only approved basic fields, including drivers of inactive companies', async () => {
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
          joinedAt: '2026-09-07T15:00:00Z',
        },
      ]);
  });
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
    await list({}, `Bearer ${token}`).expect(401);
  });
  it('does not expose deactivated users or privileged account fields', async () => {
    database.connection.exec(
      "UPDATE users SET deactivated_at = CURRENT_TIMESTAMP WHERE role = 'driver'",
    );
    await list().expect(200).expect([]);
  });
  it('propagates DB failure instead of returning an empty list', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    database.connection.exec(
      'ALTER TABLE logistics_companies RENAME TO unavailable_companies',
    );
    try {
      await list().expect(500);
    } finally {
      database.connection.exec(
        'ALTER TABLE unavailable_companies RENAME TO logistics_companies',
      );
    }
  });
  it('documents admin protection and deferred totals and withdrawal', async () => {
    const result = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = result.body as OpenAPIObject;
    expect(document.paths[PATH]?.get?.security).toEqual([
      { admin: [] },
      { 'admin-session': [] },
    ]);
    expect(document.paths[PATH]?.get?.description).toContain('미제공');
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
      'name',
      'phone',
    ]);
    await request(app.getHttpServer())
      .delete(`${PATH}/${userId}`)
      .set('Authorization', authorization)
      .expect(204);
  });
});
