import { createHash, randomUUID } from 'node:crypto';

import { INestApplication, Logger } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { AuthRepository } from '../src/auth';
import { DatabaseService } from '../src/database/database.service';
import {
  authSessions,
  logisticsCompanies,
  phoneVerifications,
  users,
} from '../src/database/schema';
import { createTestApp } from './helpers/create-test-app';

type LoginResponse = { token: string; expiresAt: string };
type ErrorResponse = {
  statusCode: number;
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
};

const credentials = { email: 'driver@example.com', password: 'Password!1' };

describe('Login (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let companyId: string;
  let userId: string;
  let passwordHash: string;
  let replacementPasswordHash: string;

  const previousWebOrigins = process.env.WEB_ORIGINS;

  beforeAll(async () => {
    process.env.WEB_ORIGINS = 'http://localhost:8081';
    app = await createTestApp();
    database = app.get(DatabaseService);
    passwordHash = await argon2.hash(credentials.password, {
      type: argon2.argon2id,
    });
    replacementPasswordHash = await argon2.hash('Changed!2', {
      type: argon2.argon2id,
    });
  });

  beforeEach(async () => {
    await database.db.delete(users);
    await database.db.delete(phoneVerifications);
    await database.db.delete(logisticsCompanies);
    companyId = randomUUID();
    userId = randomUUID();
    await database.db.insert(logisticsCompanies).values({
      id: companyId,
      businessName: '(주)경인물류',
      businessNumber: '123-45-67890',
      corporateRegistrationNumber: '123456-1234567',
      businessAddress: '서울시 강남구',
      managerName: '김담당',
      managerPhone: '010-1111-2222',
      bankCode: '19',
      accountNumber: '110-123-456789',
      accountHolder: '김담당',
    });
    await database.db.insert(users).values({
      id: userId,
      role: 'driver',
      email: credentials.email,
      passwordHash,
      name: '김기사',
      phone: '010-1234-5678',
      logisticsCompanyId: companyId,
      serviceTermsConsent: true,
      privacyTermsConsent: true,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    if (previousWebOrigins === undefined) delete process.env.WEB_ORIGINS;
    else process.env.WEB_ORIGINS = previousWebOrigins;
  });

  it('issues a non-cacheable token and stores only its hash for 30 days', async () => {
    const startedAt = Date.now();
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(credentials)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    const body = response.body as LoginResponse;

    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'token']);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sessions = await database.db.select().from(authSessions);
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session.userId).toBe(userId);
    expect(session.tokenHash).toBe(
      createHash('sha256').update(body.token).digest('hex'),
    );
    expect(session.tokenHash).not.toBe(body.token);
    expect(session.createdAt.getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(session.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(session.lastUsedAt).toEqual(session.createdAt);
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
    expect(body.expiresAt).toBe(session.expiresAt.toISOString());
  });

  it('keeps independent sessions for multiple logins', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(credentials)
      .expect(200);
    const [firstSession] = await database.db
      .select()
      .from(authSessions)
      .limit(1);
    const second = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(credentials)
      .expect(200);
    const firstBody = first.body as LoginResponse;
    const secondBody = second.body as LoginResponse;

    expect(firstBody.token).not.toBe(secondBody.token);
    const sessions = await database.db.select().from(authSessions);
    expect(sessions).toHaveLength(2);
    expect(sessions).toContainEqual(firstSession);
  });

  it('trims email and accepts its case-insensitive match', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ ...credentials, email: ' DRIVER@EXAMPLE.COM ' })
      .expect(200);
  });

  it.each([
    ['unknown email', { ...credentials, email: 'unknown@example.com' }],
    ['incorrect password', { ...credentials, password: 'Incorrect!1' }],
    ['untrimmed password', { ...credentials, password: ' Password!1 ' }],
  ])('returns the same error for %s', async (_name, input) => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(input)
      .expect(401);

    expect(response.body).toEqual({
      statusCode: 401,
      code: 'INVALID_CREDENTIALS',
      message: '이메일 또는 비밀번호가 일치하지 않습니다.',
    });
    expect(await database.db.select().from(authSessions)).toHaveLength(0);
  });

  it.each(['user', 'company'])(
    'blocks a deactivated %s without issuing a session',
    async (target) => {
      if (target === 'user') {
        await database.db
          .update(users)
          .set({ deactivatedAt: new Date().toISOString() })
          .where(eq(users.id, userId));
      } else {
        await database.db
          .update(logisticsCompanies)
          .set({ active: false })
          .where(eq(logisticsCompanies.id, companyId));
      }

      const rejected = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ ...credentials, password: 'Incorrect!1' })
        .expect(401);
      expect(rejected.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send(credentials)
        .expect(target === 'user' ? 401 : 403);
      expect(response.body).toMatchObject({
        code: target === 'user' ? 'INVALID_CREDENTIALS' : 'ACCOUNT_UNAVAILABLE',
      });
      expect(await database.db.select().from(authSessions)).toHaveLength(0);
    },
  );

  it('does not issue a driver session to an admin', async () => {
    await database.db.update(users).set({ role: 'admin' });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(credentials)
      .expect(401);
    expect(response.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(await database.db.select().from(authSessions)).toHaveLength(0);
  });

  it.each<[string, unknown]>([
    ['email', undefined],
    ['email', null],
    ['email', 123],
    ['email', ''],
    ['email', 'not-an-email'],
    ['email', `${'a'.repeat(255)}@example.com`],
    ['password', undefined],
    ['password', null],
    ['password', 12345678],
    ['password', ''],
    ['password', 'Short!1'],
    ['password', 'PasswordOnly'],
    ['password', 'Password1'],
    ['password', 'Password!'],
    ['password', '1234567!'],
    ['password', `Password!1${'a'.repeat(119)}`],
    ['role', 'admin'],
    ['userId', 'another-user'],
    ['expiresAt', '2099-01-01T00:00:00.000Z'],
  ])('validates %s=%p without creating a session', async (field, value) => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ ...credentials, [field]: value })
      .expect(400);
    const body = response.body as ErrorResponse;

    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.fieldErrors?.[field]?.length).toBeGreaterThan(0);
    expect(await database.db.select().from(authSessions)).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain(credentials.password);
  });

  it('allows a newly signed-up driver to log in with the saved Argon2id password', async () => {
    const phone = '010-9999-8888';
    const verificationProof = randomUUID();
    await database.db.insert(phoneVerifications).values({
      id: randomUUID(),
      purpose: 'sign_up',
      phone,
      codeHash: 'test-only-already-verified-code',
      proofHash: createHash('sha256').update(verificationProof).digest('hex'),
      verifiedAt: '2026-01-01 00:00:00',
      expiresAt: '2099-01-01 00:00:00',
    });
    const signup = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({
        email: 'new-driver@example.com',
        password: credentials.password,
        logisticsCompanyId: companyId,
        name: '새기사',
        phone,
        verificationProof,
        serviceTerms: true,
        privacyTerms: true,
        marketingTerms: false,
      })
      .expect(201);
    const signedUp = signup.body as { id: string };

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ ...credentials, email: 'new-driver@example.com' })
      .expect(200);
    expect(await database.db.select().from(authSessions)).toEqual([
      expect.objectContaining({ userId: signedUp.id }),
    ]);
  });

  it.each(['Passwo!1', `A1!${'a'.repeat(125)}`, ' Password!1 '])(
    'accepts valid password boundaries and preserves spaces: %p',
    async (password) => {
      const storedHash = await argon2.hash(password, { type: argon2.argon2id });
      await database.db.update(users).set({ passwordHash: storedHash });

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ ...credentials, password })
        .expect(200);
      expect(await database.db.select().from(authSessions)).toHaveLength(1);
    },
  );

  it.each(['company', 'user', 'password', 'role', 'deleted user'])(
    'rechecks %s changes between credential lookup and session insertion',
    async (target) => {
      const repository = app.get(AuthRepository);
      const findCredentials = repository.findDriverCredentials.bind(repository);
      jest
        .spyOn(repository, 'findDriverCredentials')
        .mockImplementationOnce(async (email) => {
          const snapshot = await findCredentials(email);
          // 비동기 비밀번호 검증 중에 상태가 바뀌는 상황을 지연 타이머 없이 재현한다.
          if (target === 'company') {
            await database.db.update(logisticsCompanies).set({ active: false });
          } else if (target === 'user') {
            await database.db
              .update(users)
              .set({ deactivatedAt: new Date().toISOString() });
          } else if (target === 'password') {
            await database.db
              .update(users)
              .set({ passwordHash: replacementPasswordHash });
          } else if (target === 'role') {
            await database.db.update(users).set({ role: 'admin' });
          } else {
            await database.db.delete(users);
          }
          return snapshot;
        });

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send(credentials)
        .expect(403);
      expect(response.body).toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' });
      expect(await database.db.select().from(authSessions)).toHaveLength(0);
    },
  );

  it('rolls back a failed session insert and never returns a token', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await database.connection.unsafe(
      "CREATE OR REPLACE FUNCTION app.fail_login_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced login storage failure'; END; $$",
    );
    await database.connection.unsafe(
      'CREATE TRIGGER fail_login_session AFTER INSERT ON app.auth_sessions FOR EACH ROW EXECUTE FUNCTION app.fail_login_session()',
    );

    try {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send(credentials)
        .expect(500);
      expect(response.body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: '서버 오류가 발생했습니다.',
      });
      expect(await database.db.select().from(authSessions)).toHaveLength(0);
      expect(log).toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        credentials.password,
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(passwordHash);
    } finally {
      await database.connection.unsafe(
        'DROP TRIGGER fail_login_session ON app.auth_sessions',
      );
      await database.connection.unsafe(
        'DROP FUNCTION app.fail_login_session()',
      );
    }
  });

  it('fails closed when a stored password hash cannot be verified', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await database.db.update(users).set({ passwordHash: 'broken hash' });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(credentials)
      .expect(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: 'INTERNAL_SERVER_ERROR',
      message: '서버 오류가 발생했습니다.',
    });
    expect(await database.db.select().from(authSessions)).toHaveLength(0);
  });

  it('documents login request, response, and failures in Swagger', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = response.body as OpenAPIObject;

    expect(document.paths['/api/v1/auth/login']?.post).toMatchObject({
      requestBody: {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/LoginRequestDto' },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LoginResponseDto' },
            },
          },
        },
        '400': { description: 'VALIDATION_ERROR' },
        '401': { description: 'INVALID_CREDENTIALS' },
        '403': { description: 'ACCOUNT_UNAVAILABLE' },
        '500': { description: 'INTERNAL_SERVER_ERROR' },
      },
    });
    expect(document.components?.schemas?.LoginRequestDto).toMatchObject({
      required: ['email', 'password'],
    });
    for (const field of ['email', 'password']) {
      expect(document.components?.schemas?.LoginRequestDto).toHaveProperty(
        ['properties', field, 'description'],
        expect.stringMatching(/[가-힣]/),
      );
    }
    expect(document.components?.schemas?.LoginResponseDto).toMatchObject({
      required: ['token', 'expiresAt'],
      properties: { expiresAt: { format: 'date-time' } },
    });
    for (const field of ['token', 'expiresAt']) {
      expect(document.components?.schemas?.LoginResponseDto).toHaveProperty(
        ['properties', field, 'description'],
        expect.stringMatching(/[가-힣]/),
      );
    }
  });

  it('uses an HttpOnly cookie for web login, restoration and current-session logout', async () => {
    const browser = request.agent(app.getHttpServer());
    const response = await browser
      .post('/api/v1/auth/web/login')
      .set('Origin', 'http://localhost:8081')
      .send(credentials)
      .expect(200);
    expect(Object.keys(response.body as { expiresAt: string })).toEqual([
      'expiresAt',
    ]);
    expect(response.headers['cache-control']).toBe('no-store');
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain('hpluseco_driver_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api/v1');
    expect(cookie).not.toContain('Domain=');
    expect(cookie).not.toContain('Secure');
    const me = await browser.get('/api/v1/auth/me').expect(200);
    expect(me.body).toMatchObject({ id: userId, email: credentials.email });
    const failed = await browser
      .post('/api/v1/auth/web/login')
      .set('Origin', 'http://localhost:8081')
      .send({ ...credentials, password: 'Wrong!234' })
      .expect(401);
    expect(failed.headers['set-cookie']).toBeUndefined();
    await browser.get('/api/v1/auth/me').expect(200);
    const logout = await browser
      .post('/api/v1/auth/logout')
      .set('Origin', 'http://localhost:8081')
      .expect(204);
    expect(String(logout.headers['set-cookie'])).toContain(
      'Expires=Thu, 01 Jan 1970',
    );
    await browser.get('/api/v1/auth/me').expect(401);
  });

  it.each([
    undefined,
    'null',
    'https://untrusted.example',
    'http://localhost:8081.evil.example',
  ])('rejects web login from an untrusted Origin: %p', async (origin) => {
    const pending = request(app.getHttpServer())
      .post('/api/v1/auth/web/login')
      .send(credentials);
    if (origin !== undefined) pending.set('Origin', origin);
    const response = await pending.expect(403);
    expect(response.body).toMatchObject({ code: 'WEB_ORIGIN_NOT_ALLOWED' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await database.db.select().from(authSessions)).toHaveLength(0);
  });

  it('allows credentials only for configured CORS origins', async () => {
    const allowed = await request(app.getHttpServer())
      .options('/api/v1/auth/web/login')
      .set('Origin', 'http://localhost:8081')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://localhost:8081',
    );
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const denied = await request(app.getHttpServer())
      .options('/api/v1/auth/web/login')
      .set('Origin', 'https://untrusted.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets Secure cookies outside explicit development and test environments', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/web/login')
        .set('Origin', 'http://localhost:8081')
        .send(credentials)
        .expect(200);
      expect(String(response.headers['set-cookie'])).toContain('Secure');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
