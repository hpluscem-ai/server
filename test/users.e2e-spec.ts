import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { INestApplication, Logger } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { DatabaseService } from '../src/database/database.service';
import {
  authSessions,
  logisticsCompanies,
  users,
} from '../src/database/schema';
import { createTestApp } from './helpers/create-test-app';

const PATH = '/api/v1/users/me';

describe('Current driver profile (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let companyId: string;
  let userId: string;
  let token: string;
  let passwordHash: string;

  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
    passwordHash = await argon2.hash('Password!1', { type: argon2.argon2id });
  });

  beforeEach(() => {
    database.db.delete(users).run();
    database.db.delete(logisticsCompanies).run();
    companyId = randomUUID();
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
        accountNumber: '123456',
        accountHolder: '물류사',
      })
      .run();
    userId = seedDriver('010-1234-5678');
    token = seedSession(userId);
  });

  afterEach(() => {
    database.connection.exec('DROP TRIGGER IF EXISTS fail_profile_update');
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  function seedDriver(phone: string) {
    const id = randomUUID();
    database.db
      .insert(users)
      .values({
        id,
        role: 'driver',
        email: `${id}@example.com`,
        passwordHash,
        name: '김기사',
        phone,
        logisticsCompanyId: companyId,
        serviceTermsConsent: true,
        privacyTermsConsent: true,
      })
      .run();
    return id;
  }

  function seedSession(forUserId: string) {
    const value = randomBytes(32).toString('base64url');
    const now = new Date();
    database.db
      .insert(authSessions)
      .values({
        tokenHash: createHash('sha256').update(value).digest('hex'),
        userId: forUserId,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + 30 * 86400000),
      })
      .run();
    return value;
  }

  function storedUser(id = userId) {
    return database.db.select().from(users).where(eq(users.id, id)).get();
  }

  function read(authToken = token) {
    return request(app.getHttpServer())
      .get(PATH)
      .set('Authorization', `Bearer ${authToken}`);
  }

  function update(input: unknown, authToken = token) {
    return request(app.getHttpServer())
      .patch(PATH)
      .set('Authorization', `Bearer ${authToken}`)
      .send(input as object);
  }

  it('uses a real login token to read exactly the four current profile fields', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `${userId}@example.com`, password: 'Password!1' })
      .expect(200);
    const result = await read((login.body as { token: string }).token)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(result.body).toEqual({
      email: `${userId}@example.com`,
      name: '김기사',
      phone: '010-1234-5678',
      marketingConsent: false,
    });
  });

  it('saves both editable fields, trims the name, and preserves other data and sessions', async () => {
    const before = storedUser();
    database.db
      .update(users)
      .set({ updatedAt: '2000-01-01 00:00:00' })
      .where(eq(users.id, userId))
      .run();
    seedSession(userId);
    await update({ name: '  이 기사  ', marketingConsent: true })
      .expect(200)
      .expect('Cache-Control', 'no-store')
      .expect({
        email: `${userId}@example.com`,
        name: '이 기사',
        phone: '010-1234-5678',
        marketingConsent: true,
      });
    expect(storedUser()).toEqual({
      ...before,
      name: '이 기사',
      marketingConsent: true,
      updatedAt: expect.any(String) as unknown,
    });
    expect(storedUser()?.updatedAt).not.toBe('2000-01-01 00:00:00');
    expect(database.db.select().from(authSessions).all()).toHaveLength(2);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect({
        id: userId,
        email: `${userId}@example.com`,
        name: '이 기사',
        logisticsCompanyId: companyId,
      });
  });

  it('changes only supplied fields and accepts false without erasing the name', async () => {
    await update({ marketingConsent: true }).expect(200);
    await update({ name: '새기사' }).expect(200);
    expect(storedUser()).toMatchObject({
      name: '새기사',
      marketingConsent: true,
    });
    await update({ marketingConsent: false }).expect(200);
    expect(storedUser()).toMatchObject({
      name: '새기사',
      marketingConsent: false,
    });
  });

  it('keeps simultaneous independent field updates and repeated requests safe', async () => {
    await Promise.all([
      update({ name: '새기사' }).expect(200),
      update({ marketingConsent: true }).expect(200),
    ]);
    await update({ name: '새기사' }).expect(200);
    expect(storedUser()).toMatchObject({
      name: '새기사',
      marketingConsent: true,
    });
  });

  it('cannot read or modify another driver through query parameters', async () => {
    const otherId = seedDriver('010-9999-8888');
    const other = storedUser(otherId);
    await read()
      .query({ userId: otherId })
      .expect(200)
      .expect(({ body }: { body: unknown }) =>
        expect(body).toMatchObject({ email: `${userId}@example.com` }),
      );
    await update({ name: '변경기사' }).query({ userId: otherId }).expect(200);
    expect(storedUser(otherId)).toEqual(other);
  });

  it.each([
    { name: '' },
    { name: '   ' },
    { name: null },
    { name: 123 },
    { name: '기사1' },
    { name: 'a'.repeat(101) },
    { marketingConsent: null },
    { marketingConsent: 'false' },
    { marketingConsent: 1 },
    { name: '기사', email: 'other@example.com' },
    { name: '기사', phone: '010-9999-8888' },
    { name: '기사', password: 'OtherPass!1' },
    { name: '기사', role: 'admin' },
    { name: '기사', userId: randomUUID() },
    { name: '기사', logisticsCompanyId: randomUUID() },
  ])(
    'rejects invalid or protected fields without any update: %p',
    async (input) => {
      const before = storedUser();
      await update(input)
        .expect(400)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({ code: 'VALIDATION_ERROR' }),
        );
      expect(storedUser()).toEqual(before);
    },
  );

  it('rejects an empty change', async () => {
    await update({})
      .expect(400)
      .expect(({ body }: { body: unknown }) =>
        expect(body).toMatchObject({ code: 'PROFILE_CHANGES_REQUIRED' }),
      );
  });

  it('accepts the existing name maximum of 100 characters', async () => {
    await update({ name: '김'.repeat(100) }).expect(200);
  });

  it('requires a Bearer session for reads and writes', async () => {
    await request(app.getHttpServer())
      .get(PATH)
      .expect(401)
      .expect('Cache-Control', 'no-store');
    await request(app.getHttpServer())
      .patch(PATH)
      .send({ name: '기사' })
      .expect(401);
    await read('unknown').expect(401);
    await update({ name: '기사' }, 'unknown').expect(401);
  });

  it.each([
    'expired',
    'idle',
    'revoked',
    'driver-inactive',
    'company-inactive',
    'admin',
  ])(
    'rejects %s sessions on both operations without changing profile data',
    async (state) => {
      if (state === 'expired')
        database.db
          .update(authSessions)
          .set({
            createdAt: new Date(Date.now() - 86400000),
            lastUsedAt: new Date(Date.now() - 86400000),
            expiresAt: new Date(Date.now() - 1),
          })
          .run();
      if (state === 'idle')
        database.db
          .update(authSessions)
          .set({
            createdAt: new Date(Date.now() - 8 * 86400000),
            lastUsedAt: new Date(Date.now() - 8 * 86400000),
          })
          .run();
      if (state === 'revoked') database.db.delete(authSessions).run();
      if (state === 'driver-inactive')
        database.db
          .update(users)
          .set({ deactivatedAt: '2026-09-01 00:00:00' })
          .where(eq(users.id, userId))
          .run();
      if (state === 'company-inactive')
        database.db.update(logisticsCompanies).set({ active: false }).run();
      if (state === 'admin')
        database.db
          .update(users)
          .set({ role: 'admin' })
          .where(eq(users.id, userId))
          .run();
      const before = storedUser();
      await update({ name: '기사' }).expect(401);
      await read().expect(401);
      expect(storedUser()).toEqual(before);
    },
  );

  it('rolls back both changes on an actual SQLite write failure and does not expose data', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const before = storedUser();
    database.connection
      .exec(`CREATE TRIGGER fail_profile_update AFTER UPDATE OF name, marketing_consent ON users
      BEGIN SELECT RAISE(ABORT, 'private-database-error'); END;`);
    await update({ name: '변경기사', marketingConsent: true })
      .expect(500)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
        expect(JSON.stringify(body)).not.toMatch(
          /private-database-error|변경기사|password_hash/,
        );
      });
    expect(storedUser()).toEqual(before);
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /private-database-error|변경기사|password_hash/,
    );
  });

  it('publishes the authenticated operations, DTO fields and failure responses in Swagger', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = response.body as OpenAPIObject;
    const path = document.paths[PATH];
    for (const method of ['get', 'patch'] as const) {
      expect(path?.[method]?.security).toEqual([
        { bearer: [] },
        { 'driver-session': [] },
      ]);
      for (const status of ['200', '401', '500'])
        expect(path?.[method]?.responses?.[status]).toBeDefined();
    }
    expect(path?.patch?.responses?.['400']).toBeDefined();
    const schema = document.components?.schemas?.DriverProfileResponseDto;
    expect(
      schema &&
        'properties' in schema &&
        Object.keys(schema.properties ?? {}).sort(),
    ).toEqual(['email', 'marketingConsent', 'name', 'phone']);
  });
});
