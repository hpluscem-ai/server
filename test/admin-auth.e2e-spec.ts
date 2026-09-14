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

const PATH = '/api/v1/admin/auth';
const password = 'AdminPassword!1';
const ORIGIN = 'http://localhost:5173';
const COOKIE = 'hpluseco_admin_session';

describe('Admin authentication (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let adminId: string;
  let hash: string;
  const previousOrigins = process.env.WEB_ORIGINS;
  beforeAll(async () => {
    process.env.WEB_ORIGINS = ORIGIN;
    app = await createTestApp();
    database = app.get(DatabaseService);
    hash = await argon2.hash(password, { type: argon2.argon2id });
  });
  beforeEach(() => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      ADMIN_SESSION_TTL_SECONDS: '600',
    });
    database.db.delete(users).run();
    database.db.delete(logisticsCompanies).run();
    adminId = randomUUID();
    database.db
      .insert(users)
      .values({
        id: adminId,
        role: 'admin',
        email: 'admin@example.com',
        name: '관리자',
        passwordHash: hash,
      })
      .run();
  });
  afterEach(() => {
    database.connection.exec('DROP TRIGGER IF EXISTS fail_admin_session');
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await app.close();
    if (previousOrigins === undefined) delete process.env.WEB_ORIGINS;
    else process.env.WEB_ORIGINS = previousOrigins;
  });
  function login(input: unknown = { email: 'admin@example.com', password }) {
    return request(app.getHttpServer())
      .post(`${PATH}/login`)
      .send(input as object);
  }
  async function token() {
    const response = await login().expect(200);
    return (response.body as { token: string }).token;
  }
  function me(value: string) {
    return request(app.getHttpServer())
      .get(`${PATH}/me`)
      .set('Authorization', `Bearer ${value}`);
  }
  function count() {
    return database.connection
      .prepare('SELECT COUNT(*) AS count FROM admin_sessions')
      .get();
  }

  it('issues a separately stored opaque session using the explicitly configured expiry', async () => {
    const before = Date.now();
    const response = await login()
      .expect(200)
      .expect('Cache-Control', 'no-store');
    const body = response.body as { token: string; expiresAt: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(body.expiresAt)).toBeGreaterThanOrEqual(before + 600000);
    expect(Date.parse(body.expiresAt)).toBeLessThanOrEqual(Date.now() + 600000);
    expect(
      database.connection
        .prepare('SELECT token_hash FROM admin_sessions')
        .get(),
    ).toEqual({
      token_hash: createHash('sha256').update(body.token).digest('hex'),
    });
    expect(database.db.select().from(authSessions).all()).toEqual([]);
    await me(body.token)
      .expect(200)
      .expect({ id: adminId, email: 'admin@example.com', name: '관리자' });
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${body.token}`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/admin/logistics-companies')
      .set('Authorization', `Bearer ${body.token}`)
      .expect(200);
  });

  it.each([
    '',
    '0',
    '-1',
    'abc',
    '1.5',
    'Infinity',
    '28801',
    '9007199254740991',
  ])('fails closed for unconfigured/invalid TTL %p', async (ttl) => {
    process.env.ADMIN_SESSION_TTL_SECONDS = ttl;
    await login()
      .expect(503)
      .expect(({ body }: { body: { code: string } }) =>
        expect(body.code).toBe('ADMIN_AUTH_NOT_CONFIGURED'),
      );
    expect(count()).toEqual({ count: 0 });
  });

  it.each([
    { email: 'missing@example.com', password },
    { email: 'admin@example.com', password: 'WrongPassword!1' },
  ])('rejects invalid credentials identically: %j', async (input) => {
    await login(input)
      .expect(401)
      .expect(({ body }: { body: { code: string } }) =>
        expect(body.code).toBe('INVALID_CREDENTIALS'),
      );
    expect(count()).toEqual({ count: 0 });
  });

  it('blocks every existing admin method without an admin session', async () => {
    const base = '/api/v1/admin/logistics-companies';
    for (const [method, path] of [
      ['get', base],
      ['post', base],
      ['get', `${base}/${randomUUID()}`],
      ['put', `${base}/${randomUUID()}`],
      ['delete', `${base}/${randomUUID()}`],
    ] as const) {
      await request(app.getHttpServer())
        [method](path)
        .expect(401)
        .expect('Cache-Control', 'no-store');
    }
    await request(app.getHttpServer())
      .get('/api/v1/logistics-companies')
      .expect(200);
  });

  it('rejects driver credentials and tokens, including a driver token after role promotion', async () => {
    const companyId = randomUUID();
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
      })
      .run();
    database.db
      .update(users)
      .set({
        role: 'driver',
        phone: '010-1234-5678',
        logisticsCompanyId: companyId,
        serviceTermsConsent: true,
        privacyTermsConsent: true,
      })
      .run();
    await login().expect(401);
    const driverToken = randomBytes(32).toString('base64url');
    const now = new Date();
    database.db
      .insert(authSessions)
      .values({
        tokenHash: createHash('sha256').update(driverToken).digest('hex'),
        userId: adminId,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + 60000),
      })
      .run();
    await me(driverToken).expect(401);
    database.db.update(users).set({ role: 'admin' }).run();
    await me(driverToken).expect(401);
  });

  it('revokes only the current admin session on logout', async () => {
    const first = await token();
    const second = await token();
    await request(app.getHttpServer())
      .post(`${PATH}/logout`)
      .set('Authorization', `Bearer ${first}`)
      .expect(204)
      .expect('');
    await me(first).expect(401);
    await me(second).expect(200);
  });

  it('distinguishes storage failure from an invalid session', async () => {
    const value = await token();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    database.connection.exec(
      'ALTER TABLE admin_sessions RENAME TO unavailable_admin_sessions',
    );
    try {
      await me(value)
        .expect(500)
        .expect(({ body }: { body: { code: string } }) =>
          expect(body.code).toBe('INTERNAL_SERVER_ERROR'),
        );
    } finally {
      database.connection.exec(
        'ALTER TABLE unavailable_admin_sessions RENAME TO admin_sessions',
      );
    }
    await me(value).expect(200);
  });

  it.each([
    {},
    { email: 'invalid', password },
    { email: 'admin@example.com', password: null },
    { email: 'admin@example.com', password: 'short' },
    { email: 'admin@example.com', password, role: 'admin' },
  ])('rejects invalid login inputs: %j', async (input) => {
    await login(input).expect(400);
    expect(count()).toEqual({ count: 0 });
  });

  it('rejects login by an inactive admin and rejects an issued token after loss of admin role', async () => {
    const value = await token();
    database.db
      .update(users)
      .set({ deactivatedAt: '2026-09-08 00:00:00' })
      .run();
    await login().expect(401);
    // A role transition must satisfy the existing driver DB constraints too.
    const companyId = randomUUID();
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
      })
      .run();
    database.db
      .update(users)
      .set({
        role: 'driver',
        deactivatedAt: null,
        phone: '010-1234-5678',
        logisticsCompanyId: companyId,
        serviceTermsConsent: true,
        privacyTermsConsent: true,
      })
      .run();
    await me(value).expect(401);
  });

  it.each(['expired', 'deactivated', 'deleted'])(
    'rejects %s sessions at the next request',
    async (state) => {
      const value = await token();
      if (state === 'expired')
        database.connection
          .prepare('UPDATE admin_sessions SET created_at = ?, expires_at = ?')
          .run(Date.now() - 1000, Date.now() - 1);
      if (state === 'deactivated')
        database.db
          .update(users)
          .set({ deactivatedAt: '2026-09-08 00:00:00' })
          .run();
      if (state === 'deleted')
        database.db.delete(users).where(eq(users.id, adminId)).run();
      await me(value).expect(401);
    },
  );

  it('does not issue a session if credentials change during verification', async () => {
    const verify = argon2.verify;
    jest
      .spyOn(jest.requireActual<typeof argon2>('argon2'), 'verify')
      .mockImplementationOnce(async (...args) => {
        const result = await verify(...args);
        database.db
          .update(users)
          .set({ passwordHash: 'concurrently-changed' })
          .run();
        return result;
      });
    await login().expect(401);
    expect(count()).toEqual({ count: 0 });
  });

  it('propagates session insert and deletion failures without false success or secret logs', async () => {
    const value = await token();
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    database.connection.exec(
      "CREATE TRIGGER fail_admin_session AFTER DELETE ON admin_sessions BEGIN SELECT RAISE(FAIL, 'secret'); END;",
    );
    await request(app.getHttpServer())
      .post(`${PATH}/logout`)
      .set('Authorization', `Bearer ${value}`)
      .expect(500);
    expect(count()).toEqual({ count: 1 });
    database.connection.exec(
      "DROP TRIGGER fail_admin_session; CREATE TRIGGER fail_admin_session AFTER INSERT ON admin_sessions BEGIN SELECT RAISE(FAIL, 'secret'); END;",
    );
    await login().expect(500);
    expect(count()).toEqual({ count: 1 });
    expect(JSON.stringify(log.mock.calls)).not.toContain(value);
    expect(JSON.stringify(log.mock.calls)).not.toContain(hash);
  });

  it('documents a distinct admin bearer scheme on all protected admin routes', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = response.body as OpenAPIObject;
    for (const [path, operations] of Object.entries(document.paths)) {
      if (
        !path.startsWith('/api/v1/admin/') ||
        path === `${PATH}/login` ||
        path === `${PATH}/web/login`
      )
        continue;
      for (const method of ['get', 'post', 'put', 'delete'] as const) {
        const operation = operations?.[method];
        if (operation) {
          expect(operation.security).toEqual([
            { admin: [] },
            { 'admin-session': [] },
          ]);
          if (['post', 'put', 'delete'].includes(method)) {
            expect(operation.responses['403']).toBeDefined();
          }
        }
      }
    }
    expect(document.paths[`${PATH}/login`]?.post?.description).toContain(
      'ADMIN_SESSION_TTL_SECONDS',
    );
    expect(document.components?.securitySchemes?.admin).toBeDefined();
    expect(
      document.components?.securitySchemes?.['admin-session'],
    ).toMatchObject({ type: 'apiKey', in: 'cookie', name: COOKIE });
    expect(document.paths[`${PATH}/web/login`]?.post?.security).toBeUndefined();
  });

  it('uses a separate HttpOnly web cookie with fixed 8-hour expiry and current-session logout', async () => {
    process.env.ADMIN_SESSION_TTL_SECONDS = '28800';
    const browser = request.agent(app.getHttpServer());
    const before = Date.now();
    const result = await browser
      .post(`${PATH}/web/login`)
      .set('Origin', ORIGIN)
      .send({ email: 'admin@example.com', password })
      .expect(200)
      .expect('Cache-Control', 'no-store');
    const body = result.body as { expiresAt: string };
    expect(Object.keys(body)).toEqual(['expiresAt']);
    expect(Date.parse(body.expiresAt)).toBeGreaterThanOrEqual(
      before + 28800000,
    );
    expect(Date.parse(body.expiresAt)).toBeLessThanOrEqual(
      Date.now() + 28800000,
    );
    const cookie = String(result.headers['set-cookie']);
    for (const flag of [
      `${COOKIE}=`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/api/v1/admin',
    ])
      expect(cookie).toContain(flag);
    expect(cookie).not.toContain('hpluseco_driver_session');
    expect(cookie).not.toContain('Domain=');
    expect(cookie).not.toContain('Secure');
    const stored = database.connection
      .prepare('SELECT * FROM admin_sessions')
      .all();
    await browser
      .get(`${PATH}/me`)
      .expect(200)
      .expect({ id: adminId, email: 'admin@example.com', name: '관리자' });
    expect(
      database.connection.prepare('SELECT * FROM admin_sessions').all(),
    ).toEqual(stored);
    await browser.get('/api/v1/admin/drivers').expect(200);
    await browser.get('/api/v1/admin/stations').expect(200);
    await browser.get('/api/v1/admin/logistics-companies').expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', cookie.split(';')[0])
      .expect(401);
    const other = await token();
    const logout = await browser
      .post(`${PATH}/logout`)
      .set('Origin', ORIGIN)
      .expect(204);
    expect(String(logout.headers['set-cookie'])).toContain(
      'Expires=Thu, 01 Jan 1970',
    );
    expect(String(logout.headers['set-cookie'])).not.toContain(
      'hpluseco_driver_session',
    );
    await browser.get(`${PATH}/me`).expect(401);
    await me(other).expect(200);
  });

  it.each([undefined, 'null', 'http://localhost:5173.evil.test'])(
    'rejects cookie login and mutations from Origin %p',
    async (origin) => {
      const value = await token();
      for (const path of [
        `${PATH}/web/login`,
        `${PATH}/logout`,
        '/api/v1/admin/logistics-companies',
      ]) {
        const pending = request(app.getHttpServer())
          .post(path)
          .set('Cookie', `${COOKIE}=${value}`)
          .send(
            path.endsWith('/login')
              ? { email: 'admin@example.com', password }
              : {},
          );
        if (origin !== undefined) pending.set('Origin', origin);
        const result = await pending.expect(403);
        expect(result.body).toMatchObject({ code: 'WEB_ORIGIN_NOT_ALLOWED' });
        expect(result.headers['set-cookie']).toBeUndefined();
      }
      await me(value).expect(200);
      expect(count()).toEqual({ count: 1 });
    },
  );

  it('supports exact-origin credential CORS and secure production cookies', async () => {
    const cors = await request(app.getHttpServer())
      .options(`${PATH}/web/login`)
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);
    expect(cors.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(cors.headers['access-control-allow-credentials']).toBe('true');
    const denied = await request(app.getHttpServer())
      .options(`${PATH}/web/login`)
      .set('Origin', `${ORIGIN}.evil.test`)
      .set('Access-Control-Request-Method', 'POST');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    process.env.NODE_ENV = 'production';
    const result = await request(app.getHttpServer())
      .post(`${PATH}/web/login`)
      .set('Origin', ORIGIN)
      .send({ email: 'admin@example.com', password })
      .expect(200);
    expect(String(result.headers['set-cookie'])).toContain('Secure');
  });

  it('rejects malformed Bearer, ambiguous cookies, and driver tokens without deleting a newer cookie', async () => {
    const value = await token();
    const cookie = `${COOKIE}=${value}`;
    for (const header of ['Bearer invalid', 'Basic invalid']) {
      const result = await request(app.getHttpServer())
        .get(`${PATH}/me`)
        .set('Authorization', header)
        .set('Cookie', cookie)
        .expect(401);
      expect(result.headers['set-cookie']).toBeUndefined();
    }
    for (const cookies of [
      `${cookie}; ${cookie}`,
      `hpluseco_driver_session=${value}`,
      `${COOKIE}=invalid`,
    ]) {
      const result = await request(app.getHttpServer())
        .get(`${PATH}/me`)
        .set('Cookie', cookies)
        .expect(401);
      expect(result.headers['set-cookie']).toBeUndefined();
    }
    const driverToken = randomBytes(32).toString('base64url');
    database.db
      .insert(authSessions)
      .values({
        tokenHash: createHash('sha256').update(driverToken).digest('hex'),
        userId: adminId,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      })
      .run();
    await request(app.getHttpServer())
      .get(`${PATH}/me`)
      .set('Cookie', `${COOKIE}=${driverToken}`)
      .expect(401);
    database.connection
      .prepare('UPDATE admin_sessions SET created_at = ?, expires_at = ?')
      .run(Date.now() - 1000, Date.now() - 1);
    const newer = await token();
    const expired = await request(app.getHttpServer())
      .get(`${PATH}/me`)
      .set('Cookie', cookie)
      .expect(401);
    expect(expired.headers['set-cookie']).toBeUndefined();
    await me(newer).expect(200);
  });

  it('preserves cookies and sessions on storage failures and clears only after successful logout', async () => {
    const value = await token();
    const cookie = `${COOKIE}=${value}`;
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    database.connection.exec(
      'ALTER TABLE admin_sessions RENAME TO unavailable_admin_sessions',
    );
    try {
      const result = await request(app.getHttpServer())
        .get(`${PATH}/me`)
        .set('Cookie', cookie)
        .expect(500);
      expect(result.headers['set-cookie']).toBeUndefined();
    } finally {
      database.connection.exec(
        'ALTER TABLE unavailable_admin_sessions RENAME TO admin_sessions',
      );
    }
    database.connection.exec(
      "CREATE TRIGGER fail_admin_session AFTER DELETE ON admin_sessions BEGIN SELECT RAISE(FAIL, 'forced failure'); END;",
    );
    const result = await request(app.getHttpServer())
      .post(`${PATH}/logout`)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .expect(500);
    expect(result.headers['set-cookie']).toBeUndefined();
    await request(app.getHttpServer())
      .get(`${PATH}/me`)
      .set('Cookie', cookie)
      .expect(200);
  });
});
