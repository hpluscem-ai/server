import { createHash, randomBytes, randomUUID } from 'node:crypto';

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
  users,
} from '../src/database/schema';
import { createTestApp } from './helpers/create-test-app';

const PATH = '/api/v1/auth/change-password';
const OLD = 'OldPassword!1';
const NEXT = ' NewPassword!2 ';

describe('Driver password change (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let userId: string;
  let companyId: string;
  let token: string;
  let oldHash: string;

  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
    oldHash = await argon2.hash(OLD, { type: argon2.argon2id });
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
    database.connection.exec('DROP TRIGGER IF EXISTS fail_password_change');
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
        passwordHash: oldHash,
        name: '기사',
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
  function savedPassword() {
    return database.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .get()!.passwordHash!;
  }
  function change(
    input: unknown = { currentPassword: OLD, newPassword: NEXT },
    authToken = token,
  ) {
    return request(app.getHttpServer())
      .post(PATH)
      .set('Authorization', `Bearer ${authToken}`)
      .send(input as object);
  }
  function me(authToken: string) {
    return request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${authToken}`);
  }

  describe('one-use reset token consumer', () => {
    const resetPath = '/api/v1/auth/reset-password';
    function seedReset(forUser = userId) {
      const value = randomBytes(32).toString('base64url');
      database.connection
        .prepare(
          `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
        VALUES (?, ?, ?, datetime('now', '+1 minute'))`,
        )
        .run(
          randomUUID(),
          forUser,
          createHash('sha256').update(value).digest('hex'),
        );
      return value;
    }
    function reset(value: unknown, password = NEXT) {
      return request(app.getHttpServer())
        .post(resetPath)
        .send({ token: value, newPassword: password });
    }
    function validate(value: unknown) {
      return request(app.getHttpServer())
        .post(`${resetPath}/validate`)
        .send({ token: value });
    }
    function unused() {
      return database.connection
        .prepare(
          'SELECT COUNT(*) AS count FROM password_reset_tokens WHERE used_at IS NULL',
        )
        .get();
    }

    it('validates repeatedly without changing tokens, passwords or sessions', async () => {
      const link = seedReset();
      const links = () =>
        database.connection
          .prepare('SELECT * FROM password_reset_tokens')
          .all();
      const before = links();
      const sessions = database.db.select().from(authSessions).all();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await validate(link)
          .expect(204)
          .expect('')
          .expect('Cache-Control', 'no-store');
      }
      expect(links()).toEqual(before);
      expect(savedPassword()).toBe(oldHash);
      expect(database.db.select().from(authSessions).all()).toEqual(sessions);
      await validate(token).expect(400);
      await request(app.getHttpServer())
        .post(`${resetPath}/validate`)
        .send({ token: link, newPassword: NEXT })
        .expect(400);
      await reset(link).expect(204);
      await validate(link).expect(400);
    });

    it('returns a server error without consuming the link when validation lookup fails', async () => {
      const link = seedReset();
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      jest
        .spyOn(app.get(AuthRepository), 'findPasswordReset')
        .mockImplementationOnce(() => {
          throw new Error('private database failure');
        });
      await validate(link)
        .expect(500)
        .expect(({ body }: { body: { code: string } }) =>
          expect(body.code).toBe('INTERNAL_SERVER_ERROR'),
        );
      expect(unused()).toEqual({ count: 1 });
      expect(savedPassword()).toBe(oldHash);
      expect(JSON.stringify(log.mock.calls)).not.toContain(link);
      await validate(link).expect(204);
    });

    it('atomically changes the password, consumes own links and revokes all own sessions', async () => {
      const link = seedReset();
      const secondLink = seedReset();
      const secondSession = seedSession(userId);
      const other = seedDriver('010-9999-8888');
      const otherSession = seedSession(other);
      const otherLink = seedReset(other);
      await reset(link)
        .expect(204)
        .expect('')
        .expect('Cache-Control', 'no-store');
      expect(savedPassword()).toMatch(/^\$argon2id\$/);
      expect(await argon2.verify(savedPassword(), NEXT)).toBe(true);
      await me(token).expect(401);
      await me(secondSession).expect(401);
      await me(otherSession).expect(200);
      await reset(link).expect(400);
      await reset(secondLink).expect(400);
      expect(unused()).toEqual({ count: 1 });
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `${userId}@example.com`, password: NEXT })
        .expect(200);
      await reset(otherLink).expect(204);
    });

    it('invalidates existing reset links when a logged-in password change succeeds', async () => {
      const link = seedReset();
      await change().expect(204);
      expect(unused()).toEqual({ count: 0 });
      await reset(link).expect(400);
    });

    it.each([null, '', 'invalid', 123, 'a'.repeat(43)])(
      'rejects malformed or unknown tokens: %p',
      async (value) => {
        await validate(value).expect(400);
        await reset(value).expect(400);
        expect(savedPassword()).toBe(oldHash);
        await me(token).expect(200);
      },
    );

    it('rejects invalid new passwords and client-selected user identities without consuming the token', async () => {
      const link = seedReset();
      await reset(link, 'short').expect(400);
      await request(app.getHttpServer())
        .post(resetPath)
        .send({ token: link, newPassword: NEXT, userId })
        .expect(400);
      expect(unused()).toEqual({ count: 1 });
    });

    it.each(['expired', 'used', 'admin', 'deactivated', 'company'])(
      'rejects unavailable %s tokens or accounts',
      async (state) => {
        const link = seedReset();
        await validate(link).expect(204);
        if (state === 'expired')
          database.connection.exec(
            'UPDATE password_reset_tokens SET expires_at = CURRENT_TIMESTAMP',
          );
        if (state === 'used')
          database.connection.exec(
            'UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP',
          );
        if (state === 'admin')
          database.db.update(users).set({ role: 'admin' }).run();
        if (state === 'deactivated')
          database.db
            .update(users)
            .set({ deactivatedAt: '2026-09-08 00:00:00' })
            .run();
        if (state === 'company')
          database.db.update(logisticsCompanies).set({ active: false }).run();
        await validate(link)
          .expect(400)
          .expect(({ body }: { body: { code: string } }) =>
            expect(body.code).toBe('PASSWORD_RESET_INVALID'),
          );
        await reset(link)
          .expect(400)
          .expect(({ body }: { body: { code: string } }) =>
            expect(body.code).toBe('PASSWORD_RESET_INVALID'),
          );
        expect(savedPassword()).toBe(oldHash);
      },
    );

    it.each([false, true])(
      'allows only one concurrent token consumption (different links: %s)',
      async (different) => {
        const link = seedReset();
        const responses = await Promise.all([
          reset(link),
          reset(different ? seedReset() : link, 'OtherPassword!3'),
        ]);
        expect(responses.map(({ status }) => status).sort()).toEqual([
          204, 400,
        ]);
        expect(unused()).toEqual({ count: 0 });
        expect(
          await argon2.verify(
            savedPassword(),
            responses[0].status === 204 ? NEXT : 'OtherPassword!3',
          ),
        ).toBe(true);
      },
    );

    it.each(['expired', 'used', 'admin', 'deactivated', 'company', 'password'])(
      'rechecks %s during reset hashing',
      async (state) => {
        const link = seedReset();
        const repository = app.get(AuthRepository);
        const find = repository.findPasswordReset.bind(repository);
        jest
          .spyOn(repository, 'findPasswordReset')
          .mockImplementationOnce((hash) => {
            const snapshot = find(hash);
            if (state === 'expired')
              database.connection.exec(
                'UPDATE password_reset_tokens SET expires_at = CURRENT_TIMESTAMP',
              );
            if (state === 'used')
              database.connection.exec(
                'UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP',
              );
            if (state === 'admin')
              database.db.update(users).set({ role: 'admin' }).run();
            if (state === 'deactivated')
              database.db
                .update(users)
                .set({ deactivatedAt: '2026-09-08 00:00:00' })
                .run();
            if (state === 'company')
              database.db
                .update(logisticsCompanies)
                .set({ active: false })
                .run();
            if (state === 'password')
              database.db
                .update(users)
                .set({ passwordHash: 'concurrently-changed' })
                .run();
            return snapshot;
          });
        await reset(link)
          .expect(400)
          .expect(({ body }: { body: { code: string } }) =>
            expect(body.code).toBe('PASSWORD_RESET_INVALID'),
          );
        expect(savedPassword()).toBe(
          state === 'password' ? 'concurrently-changed' : oldHash,
        );
        expect(database.db.select().from(authSessions).all()).toHaveLength(1);
      },
    );

    it('does not accept a session as a reset token or consume a link on hashing failure', async () => {
      await reset(token).expect(400);
      const link = seedReset();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest
        .spyOn(jest.requireActual<typeof argon2>('argon2'), 'hash')
        .mockRejectedValueOnce(new Error('hash unavailable'));
      await reset(link).expect(500);
      expect(unused()).toEqual({ count: 1 });
      expect(savedPassword()).toBe(oldHash);
      await me(token).expect(200);
    });

    it('rolls back logged-in password change if existing link invalidation fails', async () => {
      seedReset();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      database.connection.exec(
        "CREATE TRIGGER fail_password_change AFTER UPDATE ON password_reset_tokens BEGIN SELECT RAISE(FAIL, 'private-failure'); END;",
      );
      await change().expect(500);
      expect(unused()).toEqual({ count: 1 });
      expect(savedPassword()).toBe(oldHash);
      await me(token).expect(200);
    });

    it.each(['password-write', 'token-consume', 'session-delete'])(
      'rolls everything back on %s failure',
      async (point) => {
        const link = seedReset();
        seedSession(userId);
        const log = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
        const operation =
          point === 'password-write'
            ? 'AFTER UPDATE OF password_hash ON users'
            : point === 'token-consume'
              ? 'AFTER UPDATE ON password_reset_tokens'
              : 'AFTER DELETE ON auth_sessions';
        database.connection.exec(
          `CREATE TRIGGER fail_password_change ${operation} BEGIN SELECT RAISE(FAIL, 'private-failure'); END;`,
        );
        await reset(link).expect(500);
        expect(savedPassword()).toBe(oldHash);
        expect(unused()).toEqual({ count: 1 });
        expect(database.db.select().from(authSessions).all()).toHaveLength(2);
        expect(JSON.stringify(log.mock.calls)).not.toContain(link);
        expect(JSON.stringify(log.mock.calls)).not.toContain(NEXT);
      },
    );

    it('documents the consumer and the separately implemented email issuer', async () => {
      const response = await request(app.getHttpServer())
        .get('/docs-json')
        .expect(200);
      const document = response.body as OpenAPIObject;
      const operation = document.paths[resetPath]?.post;
      for (const code of ['204', '400', '500'])
        expect(operation?.responses[code]).toBeDefined();
      expect(operation?.description).toContain('30분');
      const validation = document.paths[`${resetPath}/validate`]?.post;
      for (const code of ['204', '400', '500'])
        expect(validation?.responses[code]).toBeDefined();
      expect(validation?.security).toBeUndefined();
      const validationSchema =
        document.components?.schemas?.ValidatePasswordResetRequestDto;
      const validationProperties =
        validationSchema && 'properties' in validationSchema
          ? validationSchema.properties
          : undefined;
      expect(Object.keys(validationProperties ?? {})).toEqual(['token']);
      expect(validationProperties?.token).toMatchObject({ writeOnly: true });
      expect(
        document.paths['/api/v1/auth/password-reset-emails']?.post,
      ).toBeDefined();
      const schema = document.components?.schemas?.ResetPasswordRequestDto;
      expect(
        schema && 'properties' in schema && schema.properties,
      ).toMatchObject({
        token: { writeOnly: true },
        newPassword: { writeOnly: true },
      });
    });
  });

  it('saves Argon2id, preserves password whitespace, revokes all own sessions, and allows only the new password', async () => {
    const second = seedSession(userId);
    const otherId = seedDriver('010-9999-8888');
    const other = seedSession(otherId);
    await change().expect(204).expect('').expect('Cache-Control', 'no-store');
    const hash = savedPassword();
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toBe(oldHash);
    await expect(argon2.verify(hash, NEXT)).resolves.toBe(true);
    await me(token).expect(401);
    await me(second).expect(401);
    await me(other).expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `${userId}@example.com`, password: OLD })
      .expect(401);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `${userId}@example.com`, password: NEXT })
      .expect(200);
    await me((login.body as { token: string }).token).expect(200);
  });

  it('rejects a wrong current password without changing credentials or revoking sessions', async () => {
    await change({ currentPassword: 'Wrong!123', newPassword: NEXT })
      .expect(400)
      .expect(({ body }: { body: unknown }) =>
        expect(body).toMatchObject({ code: 'CURRENT_PASSWORD_MISMATCH' }),
      );
    expect(savedPassword()).toBe(oldHash);
    await me(token).expect(200);
  });

  it.each([
    {},
    { currentPassword: OLD },
    { newPassword: NEXT },
    { currentPassword: null, newPassword: NEXT },
    { currentPassword: 123, newPassword: NEXT },
    { currentPassword: '', newPassword: NEXT },
    { currentPassword: 'a'.repeat(129), newPassword: NEXT },
    { currentPassword: OLD, newPassword: null },
    { currentPassword: OLD, newPassword: 'Short!1' },
    { currentPassword: OLD, newPassword: 'NoNumbers!' },
    { currentPassword: OLD, newPassword: 'NoSpecial12' },
    { currentPassword: OLD, newPassword: '1234567!' },
    { currentPassword: OLD, newPassword: 'A1!'.repeat(43) },
    { currentPassword: OLD, newPassword: NEXT, userId: randomUUID() },
  ])(
    'rejects invalid inputs without changing credentials: %p',
    async (input) => {
      await change(input).expect(400);
      expect(savedPassword()).toBe(oldHash);
      await me(token).expect(200);
    },
  );

  it('requires an active driver session', async () => {
    await request(app.getHttpServer())
      .post(PATH)
      .send({ currentPassword: OLD, newPassword: NEXT })
      .expect(401);
    database.db
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, userId))
      .run();
    await change().expect(401);
    expect(savedPassword()).toBe(oldHash);
  });

  it('rejects reuse of the session after a successful change', async () => {
    await change().expect(204);
    const hash = savedPassword();
    await change({
      currentPassword: NEXT,
      newPassword: 'ThirdPassword!3',
    }).expect(401);
    expect(savedPassword()).toBe(hash);
  });

  it('allows only one of two concurrent changes using the old password', async () => {
    const second = seedSession(userId);
    const responses = await Promise.all([
      change(),
      change({ currentPassword: OLD, newPassword: 'OtherPassword!3' }, second),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      204, 401,
    ]);
    expect(database.db.select().from(authSessions).all()).toHaveLength(0);
    const winningPassword =
      responses[0].status === 204 ? NEXT : 'OtherPassword!3';
    await expect(argon2.verify(savedPassword(), winningPassword)).resolves.toBe(
      true,
    );
  });

  it.each([
    'revoked',
    'expired',
    'idle',
    'user',
    'company',
    'role',
    'password',
  ])('rechecks %s changes made during password verification', async (state) => {
    const repository = app.get(AuthRepository);
    const find = repository.findDriverPassword.bind(repository);
    jest
      .spyOn(repository, 'findDriverPassword')
      .mockImplementationOnce((id) => {
        const snapshot = find(id);
        if (state === 'revoked') database.db.delete(authSessions).run();
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
        if (state === 'user')
          database.db
            .update(users)
            .set({ deactivatedAt: '2026-09-07 00:00:00' })
            .run();
        if (state === 'company')
          database.db.update(logisticsCompanies).set({ active: false }).run();
        if (state === 'role')
          database.db.update(users).set({ role: 'admin' }).run();
        if (state === 'password')
          database.db
            .update(users)
            .set({ passwordHash: 'concurrently-changed' })
            .run();
        return snapshot;
      });
    await change().expect(401);
    expect(savedPassword()).toBe(
      state === 'password' ? 'concurrently-changed' : oldHash,
    );
  });

  it.each(['password-write', 'session-delete'])(
    'rolls back password and session changes on %s failure',
    async (point) => {
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      seedSession(userId);
      const operation =
        point === 'password-write'
          ? 'AFTER UPDATE OF password_hash ON users'
          : 'AFTER DELETE ON auth_sessions';
      database.connection.exec(`CREATE TRIGGER fail_password_change ${operation}
      BEGIN SELECT RAISE(FAIL, 'sensitive-storage-error'); END;`);
      await change()
        .expect(500)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' }),
        );
      expect(savedPassword()).toBe(oldHash);
      expect(database.db.select().from(authSessions).all()).toHaveLength(2);
      expect(log).toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain(oldHash);
      expect(JSON.stringify(log.mock.calls)).not.toContain(NEXT);
    },
  );

  it('fails closed on a corrupt stored hash without revoking sessions', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    database.db.update(users).set({ passwordHash: 'broken' }).run();
    await change().expect(500);
    expect(savedPassword()).toBe('broken');
    expect(database.db.select().from(authSessions).all()).toHaveLength(1);
  });

  it('does not change the password or sessions when new hash generation fails', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest
      .spyOn(jest.requireActual<typeof argon2>('argon2'), 'hash')
      .mockRejectedValueOnce(new Error('hash unavailable'));
    await change().expect(500);
    expect(savedPassword()).toBe(oldHash);
    expect(database.db.select().from(authSessions).all()).toHaveLength(1);
  });

  it('documents both write-only inputs, authentication and failure responses', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = response.body as OpenAPIObject;
    const operation = document.paths[PATH]?.post;
    expect(operation?.security).toEqual([
      { bearer: [] },
      { 'driver-session': [] },
    ]);
    for (const code of ['204', '400', '401', '500'])
      expect(operation?.responses[code]).toBeDefined();
    const schema = document.components?.schemas?.ChangePasswordRequestDto;
    expect(schema && 'properties' in schema && schema.properties).toMatchObject(
      {
        currentPassword: { writeOnly: true },
        newPassword: { writeOnly: true },
      },
    );
  });
});
