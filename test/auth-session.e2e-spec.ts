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

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-06T00:00:00.000Z');
const invalidSession = {
  statusCode: 401,
  code: 'INVALID_SESSION',
  message: '로그인이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.',
};

describe('Auth sessions (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let companyId: string;
  let userId: string;
  let passwordHash: string;
  let sequence = 0;

  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
    passwordHash = await argon2.hash('Password!1', { type: argon2.argon2id });
  });

  beforeEach(() => {
    database.db.delete(users).run();
    database.db.delete(logisticsCompanies).run();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    companyId = seedCompany();
    userId = seedDriver(companyId);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  function seedCompany() {
    const id = randomUUID();
    sequence += 1;
    database.db
      .insert(logisticsCompanies)
      .values({
        id,
        businessName: '(주)경인물류',
        businessNumber: `${String(sequence).padStart(3, '0')}-45-67890`,
        corporateRegistrationNumber: `${String(sequence).padStart(6, '0')}-1234567`,
        businessAddress: '서울시 강남구',
        managerName: '김담당',
        managerPhone: '010-1111-2222',
        bankCode: '19',
        accountNumber: '110-123-456789',
        accountHolder: '김담당',
      })
      .run();
    return id;
  }

  function seedDriver(forCompanyId: string) {
    const id = randomUUID();
    sequence += 1;
    database.db
      .insert(users)
      .values({
        id,
        role: 'driver',
        email: `${id}@example.com`,
        passwordHash,
        name: '김기사',
        phone: `010-${String(sequence).padStart(4, '0')}-5678`,
        logisticsCompanyId: forCompanyId,
        serviceTermsConsent: true,
        privacyTermsConsent: true,
      })
      .run();
    return id;
  }

  function seedSession({
    forUserId = userId,
    createdAt = new Date(NOW - 2 * DAY),
    lastUsedAt = new Date(NOW - DAY),
    expiresAt = new Date(createdAt.getTime() + 30 * DAY),
  }: {
    forUserId?: string;
    createdAt?: Date;
    lastUsedAt?: Date;
    expiresAt?: Date;
  } = {}) {
    const token = randomBytes(32).toString('base64url');
    const row = {
      tokenHash: createHash('sha256').update(token).digest('hex'),
      userId: forUserId,
      createdAt,
      lastUsedAt,
      expiresAt,
    };
    database.db.insert(authSessions).values(row).run();
    return { token, row };
  }

  function storedSession(tokenHash: string) {
    return database.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.tokenHash, tokenHash))
      .get();
  }

  function me(token: string) {
    return request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
  }

  it('authenticates a real login token and logs out the current session', async () => {
    jest.spyOn(Date, 'now').mockRestore();
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: `${userId}@example.com`,
        password: 'Password!1',
      })
      .expect(200);
    const { token } = login.body as { token: string };

    await me(token)
      .expect(200)
      .expect('Cache-Control', 'no-store')
      .expect({
        id: userId,
        email: `${userId}@example.com`,
        name: '김기사',
        logisticsCompanyId: companyId,
      });
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(204)
      .expect('');
    await me(token).expect(401).expect(invalidSession);
    expect(database.db.select().from(authSessions).all()).toHaveLength(0);
  });

  it('returns current user data and touches only the requesting session', async () => {
    const current = seedSession();
    const other = seedSession();
    database.db
      .update(users)
      .set({ name: '이기사' })
      .where(eq(users.id, userId))
      .run();

    await me(current.token)
      .query({ userId: seedDriver(companyId) })
      .expect(200)
      .expect({
        id: userId,
        email: `${userId}@example.com`,
        name: '이기사',
        logisticsCompanyId: companyId,
      });
    expect(storedSession(current.row.tokenHash)).toEqual({
      ...current.row,
      lastUsedAt: new Date(NOW),
    });
    expect(storedSession(other.row.tokenHash)).toEqual(other.row);
  });

  it.each([
    undefined,
    'Basic abc',
    'Bearer',
    `Bearer ${'a'.repeat(42)}`,
    `Bearer ${'a'.repeat(44)}`,
    `Bearer ${'a'.repeat(64)}`,
    `Bearer ${'a'.repeat(43)}=`,
    `Bearer ${'a'.repeat(43)} extra`,
    `Bearer ${'a'.repeat(43)}`,
  ])(
    'rejects a missing, malformed, or unknown authorization header: %p',
    async (header) => {
      const current = seedSession();
      const pending = request(app.getHttpServer()).get('/api/v1/auth/me');
      if (header !== undefined) pending.set('Authorization', header);
      await pending
        .expect(401)
        .expect(invalidSession)
        .expect('Cache-Control', 'no-store')
        .expect('WWW-Authenticate', 'Bearer');
      expect(storedSession(current.row.tokenHash)).toEqual(current.row);
    },
  );

  it('does not accept a token from the query string or cookies', async () => {
    const current = seedSession();
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .query({ token: current.token })
      .set('Cookie', `token=${current.token}`)
      .expect(401)
      .expect(invalidSession);
    expect(storedSession(current.row.tokenHash)).toEqual(current.row);
  });

  it('accepts a case-insensitive Bearer scheme with spaces', async () => {
    const current = seedSession();
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `bEaReR   ${current.token}`)
      .expect(200);
  });

  it.each([
    ['absolute boundary', NOW - 30 * DAY, NOW - DAY, 401],
    ['absolute expired', NOW - 31 * DAY, NOW - 2 * DAY, 401],
    ['absolute just valid', NOW - 30 * DAY + 1, NOW - DAY, 200],
    ['idle boundary', NOW - 10 * DAY, NOW - 7 * DAY, 401],
    ['idle expired', NOW - 10 * DAY, NOW - 7 * DAY - 1, 401],
    ['idle just valid', NOW - 10 * DAY, NOW - 7 * DAY + 1, 200],
  ] as const)('enforces %s', async (_name, createdAt, lastUsedAt, status) => {
    const current = seedSession({
      createdAt: new Date(createdAt),
      lastUsedAt: new Date(lastUsedAt),
    });
    const response = await me(current.token).expect(status);
    if (status === 401) {
      expect(response.body).toEqual(invalidSession);
      expect(storedSession(current.row.tokenHash)).toBeUndefined();
    } else {
      expect(storedSession(current.row.tokenHash)).toEqual({
        ...current.row,
        lastUsedAt: new Date(NOW),
      });
    }
  });

  it('never extends the absolute deadline when activity extends the idle deadline', async () => {
    const current = seedSession({
      createdAt: new Date(NOW - 28 * DAY),
      lastUsedAt: new Date(NOW - 6 * DAY),
    });
    await me(current.token).expect(200);
    jest.spyOn(Date, 'now').mockReturnValue(NOW + DAY);
    await me(current.token).expect(200);
    expect(storedSession(current.row.tokenHash)?.expiresAt).toEqual(
      current.row.expiresAt,
    );
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 2 * DAY);
    await me(current.token).expect(401).expect(invalidSession);
  });

  it('does not move last use backwards if the server clock moves backwards', async () => {
    const current = seedSession({ lastUsedAt: new Date(NOW + 1000) });
    await me(current.token).expect(200);
    expect(storedSession(current.row.tokenHash)).toEqual(current.row);
  });

  it.each(['user', 'company', 'role'])(
    'rechecks the current %s state on every request',
    async (target) => {
      const current = seedSession();
      if (target === 'company')
        database.db.update(logisticsCompanies).set({ active: false }).run();
      else if (target === 'user')
        database.db
          .update(users)
          .set({ deactivatedAt: new Date(NOW).toISOString() })
          .run();
      else database.db.update(users).set({ role: 'admin' }).run();

      await me(current.token).expect(401).expect(invalidSession);
      expect(storedSession(current.row.tokenHash)).toBeUndefined();
    },
  );

  it('logs out only the authenticated session, ignoring other tokens in the body', async () => {
    const current = seedSession();
    const other = seedSession();
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${current.token}`)
      .send({ token: other.token })
      .expect(204)
      .expect('Cache-Control', 'no-store')
      .expect('');
    expect(storedSession(current.row.tokenHash)).toBeUndefined();
    expect(storedSession(other.row.tokenHash)).toEqual(other.row);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${current.token}`)
      .expect(401)
      .expect(invalidSession);
    await me(other.token).expect(200);
  });

  it('revokes all drivers in a deactivated company immediately, but preserves other companies', async () => {
    const first = seedSession();
    const second = seedSession();
    const colleague = seedSession({ forUserId: seedDriver(companyId) });
    const unrelated = seedSession({ forUserId: seedDriver(seedCompany()) });

    await request(app.getHttpServer())
      .delete(`/api/v1/admin/logistics-companies/${companyId}`)
      .expect(204);
    expect(database.db.select().from(authSessions).all()).toEqual([
      unrelated.row,
    ]);
    expect(database.db.select().from(users).all()).toHaveLength(3);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `${userId}@example.com`, password: 'Password!1' })
      .expect(403);
    expect(login.body).toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' });

    // 비활성화 후 재활성화되더라도 폐기된 토큰을 되살리지 않는다.
    database.db
      .update(logisticsCompanies)
      .set({ active: true })
      .where(eq(logisticsCompanies.id, companyId))
      .run();
    for (const session of [first, second, colleague]) {
      await me(session.token).expect(401).expect(invalidSession);
    }
    await me(unrelated.token).expect(200);
  });

  it('rolls back company deactivation if deleting sessions fails', async () => {
    const first = seedSession();
    const second = seedSession();
    const company = database.db
      .select()
      .from(logisticsCompanies)
      .where(eq(logisticsCompanies.id, companyId))
      .get();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    database.connection
      .exec(`CREATE TRIGGER fail_session_revocation AFTER DELETE ON auth_sessions
      BEGIN SELECT RAISE(FAIL, 'forced revocation failure'); END;`);
    try {
      const response = await request(app.getHttpServer())
        .delete(`/api/v1/admin/logistics-companies/${companyId}`)
        .expect(500);
      expect(response.body).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
      expect(
        database.db
          .select()
          .from(logisticsCompanies)
          .where(eq(logisticsCompanies.id, companyId))
          .get(),
      ).toEqual(company);
      expect(storedSession(first.row.tokenHash)).toEqual(first.row);
      expect(storedSession(second.row.tokenHash)).toEqual(second.row);
    } finally {
      database.connection.exec('DROP TRIGGER fail_session_revocation');
    }
  });

  it('returns a server error and rolls back a failed last-use update', async () => {
    const current = seedSession();
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    database.connection
      .exec(`CREATE TRIGGER fail_session_touch AFTER UPDATE OF last_used_at ON auth_sessions
      BEGIN SELECT RAISE(FAIL, 'forced session update failure'); END;`);
    try {
      const response = await me(current.token)
        .expect(500)
        .expect('Cache-Control', 'no-store');
      expect(response.body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: '서버 오류가 발생했습니다.',
      });
      expect(storedSession(current.row.tokenHash)).toEqual(current.row);
      expect(log).toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain(current.token);
    } finally {
      database.connection.exec('DROP TRIGGER fail_session_touch');
    }
    await me(current.token).expect(200);
  });

  it('does not report logout success when deleting the session fails', async () => {
    const current = seedSession();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    database.connection
      .exec(`CREATE TRIGGER fail_logout BEFORE DELETE ON auth_sessions
      BEGIN SELECT RAISE(ABORT, 'forced logout failure'); END;`);
    try {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${current.token}`)
        .expect(500);
      expect(response.body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: '서버 오류가 발생했습니다.',
      });
      expect(storedSession(current.row.tokenHash)?.userId).toBe(userId);
    } finally {
      database.connection.exec('DROP TRIGGER fail_logout');
    }
    await me(current.token).expect(200);
  });

  it('documents Bearer auth only on protected driver routes', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = response.body as OpenAPIObject;
    expect(document.components?.securitySchemes?.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'opaque',
    });
    expect(document.paths['/api/v1/auth/me']?.get).toMatchObject({
      security: [{ bearer: [] }],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CurrentUserResponseDto' },
            },
          },
        },
        '401': { description: 'INVALID_SESSION' },
        '500': { description: 'INTERNAL_SERVER_ERROR' },
      },
    });
    expect(document.paths['/api/v1/auth/logout']?.post).toMatchObject({
      security: [{ bearer: [] }],
      responses: {
        '204': { description: '현재 세션 로그아웃 완료' },
        '401': { description: 'INVALID_SESSION' },
        '500': { description: 'INTERNAL_SERVER_ERROR' },
      },
    });
    expect(
      document.paths['/api/v1/auth/login']?.post?.security,
    ).toBeUndefined();
    expect(
      document.paths['/api/v1/auth/signup']?.post?.security,
    ).toBeUndefined();
    const schema = document.components?.schemas?.CurrentUserResponseDto;
    expect(schema).toMatchObject({
      required: ['id', 'email', 'name', 'logisticsCompanyId'],
    });
    for (const field of ['id', 'email', 'name', 'logisticsCompanyId']) {
      expect(schema).toHaveProperty(
        ['properties', field, 'description'],
        expect.stringMatching(/[가-힣]/),
      );
    }
  });
});
