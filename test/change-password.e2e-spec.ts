import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { INestApplication, Logger } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import * as argon2 from 'argon2';
import { eq, isNull } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { AuthRepository } from '../src/auth';
import { DatabaseService } from '../src/database/database.service';
import {
  authSessions,
  logisticsCompanies,
  passwordResetTokens,
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
  beforeEach(async () => {
    await database.db.delete(users);
    await database.db.delete(logisticsCompanies);
    companyId = randomUUID();
    await database.db.insert(logisticsCompanies).values({
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
    });
    userId = await seedDriver('010-1234-5678');
    token = await seedSession(userId);
  });
  afterEach(async () => {
    await database.connection.unsafe(
      'DROP TRIGGER IF EXISTS fail_password_change ON app.users',
    );
    await database.connection.unsafe(
      'DROP TRIGGER IF EXISTS fail_password_change ON app.password_reset_tokens',
    );
    await database.connection.unsafe(
      'DROP TRIGGER IF EXISTS fail_password_change ON app.auth_sessions',
    );
    await database.connection.unsafe(
      'DROP FUNCTION IF EXISTS app.fail_password_change()',
    );
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await app.close();
  });

  async function seedDriver(phone: string) {
    const id = randomUUID();
    await database.db.insert(users).values({
      id,
      role: 'driver',
      email: `${id}@example.com`,
      passwordHash: oldHash,
      name: '기사',
      phone,
      logisticsCompanyId: companyId,
      serviceTermsConsent: true,
      privacyTermsConsent: true,
    });
    return id;
  }
  async function seedSession(forUserId: string) {
    const value = randomBytes(32).toString('base64url');
    const now = new Date();
    await database.db.insert(authSessions).values({
      tokenHash: createHash('sha256').update(value).digest('hex'),
      userId: forUserId,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 86400000),
    });
    return value;
  }
  async function savedPassword() {
    const [user] = await database.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return user.passwordHash!;
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
    async function seedReset(forUser = userId) {
      const value = randomBytes(32).toString('base64url');
      await database.db.insert(passwordResetTokens).values({
        id: randomUUID(),
        userId: forUser,
        tokenHash: createHash('sha256').update(value).digest('hex'),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
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
    async function unused() {
      return {
        count: (
          await database.db
            .select({ id: passwordResetTokens.id })
            .from(passwordResetTokens)
            .where(isNull(passwordResetTokens.usedAt))
        ).length,
      };
    }

    it('validates repeatedly without changing tokens, passwords or sessions', async () => {
      const link = await seedReset();
      const links = () =>
        database.connection.unsafe('SELECT * FROM app.password_reset_tokens');
      const before = await links();
      const sessions = await database.db.select().from(authSessions);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await validate(link)
          .expect(204)
          .expect('')
          .expect('Cache-Control', 'no-store');
      }
      expect(await links()).toEqual(before);
      expect(await savedPassword()).toBe(oldHash);
      expect(await database.db.select().from(authSessions)).toEqual(sessions);
      await validate(token).expect(400);
      await request(app.getHttpServer())
        .post(`${resetPath}/validate`)
        .send({ token: link, newPassword: NEXT })
        .expect(400);
      await reset(link).expect(204);
      await validate(link).expect(400);
    });

    it('returns a server error without consuming the link when validation lookup fails', async () => {
      const link = await seedReset();
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
      expect(await unused()).toEqual({ count: 1 });
      expect(await savedPassword()).toBe(oldHash);
      expect(JSON.stringify(log.mock.calls)).not.toContain(link);
      await validate(link).expect(204);
    });

    it('atomically changes the password, consumes own links and revokes all own sessions', async () => {
      const link = await seedReset();
      const secondLink = await seedReset();
      const secondSession = await seedSession(userId);
      const other = await seedDriver('010-9999-8888');
      const otherSession = await seedSession(other);
      const otherLink = await seedReset(other);
      await reset(link)
        .expect(204)
        .expect('')
        .expect('Cache-Control', 'no-store');
      expect(await savedPassword()).toMatch(/^\$argon2id\$/);
      expect(await argon2.verify(await savedPassword(), NEXT)).toBe(true);
      await me(token).expect(401);
      await me(secondSession).expect(401);
      await me(otherSession).expect(200);
      await reset(link).expect(400);
      await reset(secondLink).expect(400);
      expect(await unused()).toEqual({ count: 1 });
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `${userId}@example.com`, password: NEXT })
        .expect(200);
      await reset(otherLink).expect(204);
    });

    it('invalidates existing reset links when a logged-in password change succeeds', async () => {
      const link = await seedReset();
      await change().expect(204);
      expect(await unused()).toEqual({ count: 0 });
      await reset(link).expect(400);
    });

    it.each([null, '', 'invalid', 123, 'a'.repeat(43)])(
      'rejects malformed or unknown tokens: %p',
      async (value) => {
        await validate(value).expect(400);
        await reset(value).expect(400);
        expect(await savedPassword()).toBe(oldHash);
        await me(token).expect(200);
      },
    );

    it('rejects invalid new passwords and client-selected user identities without consuming the token', async () => {
      const link = await seedReset();
      await reset(link, 'short').expect(400);
      await request(app.getHttpServer())
        .post(resetPath)
        .send({ token: link, newPassword: NEXT, userId })
        .expect(400);
      expect(await unused()).toEqual({ count: 1 });
    });

    it.each(['expired', 'used', 'admin', 'deactivated', 'company'])(
      'rejects unavailable %s tokens or accounts',
      async (state) => {
        const link = await seedReset();
        await validate(link).expect(204);
        if (state === 'expired')
          await database.db
            .update(passwordResetTokens)
            .set({ expiresAt: new Date().toISOString() });
        if (state === 'used')
          await database.db
            .update(passwordResetTokens)
            .set({ usedAt: new Date().toISOString() });
        if (state === 'admin')
          await database.db.update(users).set({ role: 'admin' });
        if (state === 'deactivated')
          await database.db
            .update(users)
            .set({ deactivatedAt: '2026-09-08 00:00:00' });
        if (state === 'company') {
          await database.db.update(logisticsCompanies).set({ active: false });
          const [company] = await database.db
            .select({ active: logisticsCompanies.active })
            .from(logisticsCompanies)
            .where(eq(logisticsCompanies.id, companyId));
          expect(company).toEqual({ active: false });
        }
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
        expect(await savedPassword()).toBe(oldHash);
      },
    );

    it.each([false, true])(
      'allows only one concurrent token consumption (different links: %s)',
      async (different) => {
        const link = await seedReset();
        const responses = await Promise.all([
          reset(link),
          reset(different ? await seedReset() : link, 'OtherPassword!3'),
        ]);
        expect(responses.map(({ status }) => status).sort()).toEqual([
          204, 400,
        ]);
        expect(await unused()).toEqual({ count: 0 });
        expect(
          await argon2.verify(
            await savedPassword(),
            responses[0].status === 204 ? NEXT : 'OtherPassword!3',
          ),
        ).toBe(true);
      },
    );

    it.each(['expired', 'used', 'admin', 'deactivated', 'company', 'password'])(
      'rechecks %s during reset hashing',
      async (state) => {
        const link = await seedReset();
        const repository = app.get(AuthRepository);
        const find = repository.findPasswordReset.bind(repository);
        jest
          .spyOn(repository, 'findPasswordReset')
          .mockImplementationOnce(async (hash) => {
            const snapshot = await find(hash);
            if (state === 'expired')
              await database.db
                .update(passwordResetTokens)
                .set({ expiresAt: new Date().toISOString() });
            if (state === 'used')
              await database.db
                .update(passwordResetTokens)
                .set({ usedAt: new Date().toISOString() });
            if (state === 'admin')
              await database.db.update(users).set({ role: 'admin' });
            if (state === 'deactivated')
              await database.db
                .update(users)
                .set({ deactivatedAt: '2026-09-08 00:00:00' });
            if (state === 'company')
              await database.db
                .update(logisticsCompanies)
                .set({ active: false });
            if (state === 'password')
              await database.db
                .update(users)
                .set({ passwordHash: 'concurrently-changed' });
            return snapshot;
          });
        await reset(link)
          .expect(400)
          .expect(({ body }: { body: { code: string } }) =>
            expect(body.code).toBe('PASSWORD_RESET_INVALID'),
          );
        expect(await savedPassword()).toBe(
          state === 'password' ? 'concurrently-changed' : oldHash,
        );
        expect(await database.db.select().from(authSessions)).toHaveLength(1);
      },
    );

    it('does not accept a session as a reset token or consume a link on hashing failure', async () => {
      await reset(token).expect(400);
      const link = await seedReset();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest
        .spyOn(jest.requireActual<typeof argon2>('argon2'), 'hash')
        .mockRejectedValueOnce(new Error('hash unavailable'));
      await reset(link).expect(500);
      expect(await unused()).toEqual({ count: 1 });
      expect(await savedPassword()).toBe(oldHash);
      await me(token).expect(200);
    });

    it('rolls back logged-in password change if existing link invalidation fails', async () => {
      await seedReset();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await database.connection.unsafe(
        "CREATE OR REPLACE FUNCTION app.fail_password_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-failure'; END; $$",
      );
      await database.connection.unsafe(
        'CREATE TRIGGER fail_password_change AFTER UPDATE ON app.password_reset_tokens FOR EACH ROW EXECUTE FUNCTION app.fail_password_change()',
      );
      await change().expect(500);
      expect(await unused()).toEqual({ count: 1 });
      expect(await savedPassword()).toBe(oldHash);
      await me(token).expect(200);
    });

    it.each(['password-write', 'token-consume', 'session-delete'])(
      'rolls everything back on %s failure',
      async (point) => {
        const link = await seedReset();
        await seedSession(userId);
        const log = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
        const [operation, table] =
          point === 'password-write'
            ? ['AFTER UPDATE OF password_hash', 'users']
            : point === 'token-consume'
              ? ['AFTER UPDATE', 'password_reset_tokens']
              : ['AFTER DELETE', 'auth_sessions'];
        await database.connection.unsafe(
          "CREATE OR REPLACE FUNCTION app.fail_password_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-failure'; END; $$",
        );
        await database.connection.unsafe(
          `CREATE TRIGGER fail_password_change ${operation} ON app.${table} FOR EACH ROW EXECUTE FUNCTION app.fail_password_change()`,
        );
        await reset(link).expect(500);
        expect(await savedPassword()).toBe(oldHash);
        expect(await unused()).toEqual({ count: 1 });
        expect(await database.db.select().from(authSessions)).toHaveLength(2);
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
    const second = await seedSession(userId);
    const otherId = await seedDriver('010-9999-8888');
    const other = await seedSession(otherId);
    await change().expect(204).expect('').expect('Cache-Control', 'no-store');
    const hash = await savedPassword();
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
    expect(await savedPassword()).toBe(oldHash);
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
      expect(await savedPassword()).toBe(oldHash);
      await me(token).expect(200);
    },
  );

  it('requires an active driver session', async () => {
    await request(app.getHttpServer())
      .post(PATH)
      .send({ currentPassword: OLD, newPassword: NEXT })
      .expect(401);
    await database.db
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, userId));
    await change().expect(401);
    expect(await savedPassword()).toBe(oldHash);
  });

  it('rejects reuse of the session after a successful change', async () => {
    await change().expect(204);
    const hash = await savedPassword();
    await change({
      currentPassword: NEXT,
      newPassword: 'ThirdPassword!3',
    }).expect(401);
    expect(await savedPassword()).toBe(hash);
  });

  it('allows only one of two concurrent changes using the old password', async () => {
    const second = await seedSession(userId);
    const responses = await Promise.all([
      change(),
      change({ currentPassword: OLD, newPassword: 'OtherPassword!3' }, second),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      204, 401,
    ]);
    expect(await database.db.select().from(authSessions)).toHaveLength(0);
    const winningPassword =
      responses[0].status === 204 ? NEXT : 'OtherPassword!3';
    await expect(
      argon2.verify(await savedPassword(), winningPassword),
    ).resolves.toBe(true);
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
      .mockImplementationOnce(async (id) => {
        const snapshot = await find(id);
        if (state === 'revoked') await database.db.delete(authSessions);
        if (state === 'expired')
          await database.db.update(authSessions).set({
            createdAt: new Date(Date.now() - 86400000),
            lastUsedAt: new Date(Date.now() - 86400000),
            expiresAt: new Date(Date.now() - 1),
          });
        if (state === 'idle')
          await database.db.update(authSessions).set({
            createdAt: new Date(Date.now() - 8 * 86400000),
            lastUsedAt: new Date(Date.now() - 8 * 86400000),
          });
        if (state === 'user')
          await database.db
            .update(users)
            .set({ deactivatedAt: '2026-09-07 00:00:00' });
        if (state === 'company')
          await database.db.update(logisticsCompanies).set({ active: false });
        if (state === 'role')
          await database.db.update(users).set({ role: 'admin' });
        if (state === 'password')
          await database.db
            .update(users)
            .set({ passwordHash: 'concurrently-changed' });
        return snapshot;
      });
    await change().expect(401);
    expect(await savedPassword()).toBe(
      state === 'password' ? 'concurrently-changed' : oldHash,
    );
  });

  it.each(['password-write', 'session-delete'])(
    'rolls back password and session changes on %s failure',
    async (point) => {
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      await seedSession(userId);
      const [operation, table] =
        point === 'password-write'
          ? ['AFTER UPDATE OF password_hash', 'users']
          : ['AFTER DELETE', 'auth_sessions'];
      await database.connection.unsafe(
        "CREATE OR REPLACE FUNCTION app.fail_password_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sensitive-storage-error'; END; $$",
      );
      await database.connection.unsafe(
        `CREATE TRIGGER fail_password_change ${operation} ON app.${table} FOR EACH ROW EXECUTE FUNCTION app.fail_password_change()`,
      );
      await change()
        .expect(500)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' }),
        );
      expect(await savedPassword()).toBe(oldHash);
      expect(await database.db.select().from(authSessions)).toHaveLength(2);
      expect(log).toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain(oldHash);
      expect(JSON.stringify(log.mock.calls)).not.toContain(NEXT);
    },
  );

  it('fails closed on a corrupt stored hash without revoking sessions', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await database.db.update(users).set({ passwordHash: 'broken' });
    await change().expect(500);
    expect(await savedPassword()).toBe('broken');
    expect(await database.db.select().from(authSessions)).toHaveLength(1);
  });

  it('does not change the password or sessions when new hash generation fails', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest
      .spyOn(jest.requireActual<typeof argon2>('argon2'), 'hash')
      .mockRejectedValueOnce(new Error('hash unavailable'));
    await change().expect(500);
    expect(await savedPassword()).toBe(oldHash);
    expect(await database.db.select().from(authSessions)).toHaveLength(1);
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
