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
  passwordResetTokens,
  phoneVerifications,
  users,
} from '../src/database/schema';
import {
  AuthRepository,
  LoginUnavailableError,
} from '../src/auth/auth.repository';
import { createTestApp } from './helpers/create-test-app';
import { seedAdminSession } from './helpers/seed-admin-session';

const path = '/api/v1/admin/drivers';
const email = 'Former.Driver@example.com';
const phone = '010-1234-5678';
const password = 'OldPassword!1';
const newPassword = 'NewPassword!2';
const hashToken = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('Driver withdrawal and re-registration (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let authorization: string;
  let userId: string;
  let otherId: string;
  let companyId: string;
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  });
  beforeEach(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
    authorization = await seedAdminSession(database);
    companyId = randomUUID();
    await database.db.insert(logisticsCompanies).values({
      id: companyId,
      businessName: '보존 물류',
      businessNumber: '123-45-67890',
      corporateRegistrationNumber: '123456-1234567',
      businessAddress: '서울시',
      managerName: '담당자',
      managerPhone: phone,
      bankCode: '19',
      accountNumber: '123456',
      accountHolder: '물류사',
    });
    userId = await seedDriver(email, phone);
    otherId = await seedDriver('other@example.com', '010-9999-8888');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  async function seedDriver(address: string, number: string) {
    const id = randomUUID();
    await database.db.insert(users).values({
      id,
      role: 'driver',
      email: address,
      phone: number,
      passwordHash,
      name: '보존 기사',
      logisticsCompanyId: companyId,
      serviceTermsConsent: true,
      privacyTermsConsent: true,
    });
    return id;
  }
  async function saved(id = userId) {
    const [user] = await database.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!user) throw new Error('Expected user');
    return user;
  }
  function withdraw(id = userId, auth = authorization) {
    return request(app.getHttpServer())
      .delete(`${path}/${id}`)
      .set('Authorization', auth);
  }
  async function proof(
    overrides: Partial<typeof phoneVerifications.$inferInsert> = {},
  ) {
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    await database.db.insert(phoneVerifications).values({
      id,
      purpose: 'sign_up',
      phone,
      codeHash: '0'.repeat(64),
      proofHash: hashToken(token),
      verifiedAt: '2026-01-01 00:00:00',
      expiresAt: '2099-01-01 00:00:00',
      ...overrides,
    });
    return { id, token };
  }
  function signup(token: string, overrides: object = {}) {
    return request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({
        email: email.toLowerCase(),
        phone,
        password: newPassword,
        name: '새 기사',
        logisticsCompanyId: companyId,
        serviceTerms: true,
        privacyTerms: true,
        marketingTerms: false,
        verificationProof: token,
        ...overrides,
      });
  }
  async function login(address = email, value = password) {
    return request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: address, password: value });
  }
  function sessionToken(response: { body: unknown }): string {
    return (response.body as { token: string }).token;
  }
  async function resetLink(id = userId) {
    const token = randomBytes(32).toString('base64url');
    await database.db.insert(passwordResetTokens).values({
      id: randomUUID(),
      userId: id,
      tokenHash: hashToken(token),
      expiresAt: '2099-01-01 00:00:00',
    });
    return token;
  }

  async function createFailureTrigger(
    name: string,
    operation: string,
    table: string,
  ) {
    await database.connection.unsafe(`
      CREATE FUNCTION app.${name}_function() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test storage failure'; END;
      $$;
      CREATE TRIGGER ${name} BEFORE ${operation} ON app.${table}
      FOR EACH ROW EXECUTE FUNCTION app.${name}_function();
    `);
  }

  async function dropFailureTrigger(name: string, table: string) {
    await database.connection.unsafe(
      `DROP TRIGGER IF EXISTS ${name} ON app.${table}; DROP FUNCTION IF EXISTS app.${name}_function();`,
    );
  }

  it('preserves identity, clears credentials and sessions, and excludes the withdrawn driver', async () => {
    const old = await saved();
    const other = await saved(otherId);
    const first = await login();
    const second = await login();
    expect([first.status, second.status]).toEqual([200, 200]);
    const otherLogin = await login('other@example.com');
    const reset = await resetLink();
    const otherReset = await resetLink(otherId);
    const oldProof = await proof();
    const ownChange = await proof({
      purpose: 'change_phone',
      scopeUserId: userId,
      phone: '010-1111-2222',
    });
    const otherChange = await proof({
      purpose: 'change_phone',
      scopeUserId: otherId,
    });
    await withdraw().expect(204).expect('Cache-Control', 'no-store');
    expect(await saved()).toEqual({
      ...old,
      passwordHash: null,
      deactivatedAt: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
    });
    expect(await saved(otherId)).toEqual(other);
    expect(
      await database.db
        .select()
        .from(authSessions)
        .where(eq(authSessions.userId, userId)),
    ).toEqual([]);
    for (const token of [sessionToken(first), sessionToken(second)])
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .auth(token, { type: 'bearer' })
        .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .auth(sessionToken(otherLogin), { type: 'bearer' })
      .expect(200);
    for (const id of [oldProof.id, ownChange.id])
      expect(
        await database.db
          .select()
          .from(phoneVerifications)
          .where(eq(phoneVerifications.id, id))
          .limit(1),
      ).toEqual([]);
    expect(
      await database.db
        .select()
        .from(phoneVerifications)
        .where(eq(phoneVerifications.id, otherChange.id))
        .limit(1),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.tokenHash, hashToken(reset)))
        .limit(1),
    ).toEqual([]);
    expect(
      await database.db
        .select()
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.tokenHash, hashToken(otherReset)))
        .limit(1),
    ).toHaveLength(1);
    const listed = await request(app.getHttpServer())
      .get(path)
      .set('Authorization', authorization)
      .expect(200);
    expect((listed.body as { id: string }[]).map((row) => row.id)).toEqual([
      otherId,
    ]);
    expect((await login()).status).toBe(401);
  });

  it('creates a new identity with the same email and phone, preserving the old identity and rejecting old proof', async () => {
    const oldProof = await proof();
    await withdraw().expect(204);
    await signup(oldProof.token)
      .expect(400)
      .expect(({ body }: { body: { code: string } }) =>
        expect(body.code).toBe('PHONE_VERIFICATION_INVALID'),
      );
    const fresh = await proof();
    const created = await signup(fresh.token).expect(201);
    const newId = (created.body as { id: string }).id;
    expect(newId).not.toBe(userId);
    expect((await saved()).email).toBe(email);
    expect((await saved()).phone).toBe(phone);
    expect((await saved(newId)).deactivatedAt).toBeNull();
    const logged = await login(email.toLowerCase(), newPassword);
    expect(logged.status).toBe(200);
    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .auth(sessionToken(logged), { type: 'bearer' })
      .expect(200);
    expect((me.body as { id: string }).id).toBe(newId);
    expect((await login()).status).toBe(401);
    const lookup = await proof({ purpose: 'find_email' });
    await request(app.getHttpServer())
      .post('/api/v1/auth/find-email')
      .send({ phone, verificationProof: lookup.token })
      .expect(200);
    await signup((await proof()).token).expect(409);
    const nextProof = await proof();
    await withdraw(userId).expect(404);
    expect(
      await database.db
        .select()
        .from(phoneVerifications)
        .where(eq(phoneVerifications.id, nextProof.id))
        .limit(1),
    ).toHaveLength(1);
    expect((await saved(newId)).deactivatedAt).toBeNull();
  });

  it('preserves receipts, photos and completed settlements without transferring ownership on re-registration', async () => {
    await database.connection.unsafe(`
      INSERT INTO app.settlements (id, logistics_company_id, settlement_month) VALUES ('settlement', '${companyId}', '2026-08');
      INSERT INTO app.mileage_applications (id, user_id, logistics_company_id, idempotency_key) VALUES ('receipt', '${userId}', '${companyId}', 'once');
      INSERT INTO app.mileage_application_photos (id, mileage_application_id, kind, storage_key, content_type, byte_size)
        VALUES ('photo1', 'receipt', 'receipt', 'private/receipt', 'image/jpeg', 100), ('photo2', 'receipt', 'meter', 'private/meter', 'image/jpeg', 100);
      UPDATE app.mileage_applications SET approval_status = 'approved', final_amount = 1000, mileage_amount = 20, decided_at = CURRENT_TIMESTAMP, settlement_id = 'settlement' WHERE id = 'receipt';
      UPDATE app.settlements SET transfer_status = 'completed', transferred_at = CURRENT_TIMESTAMP WHERE id = 'settlement';
    `);
    const tables = [
      'mileage_applications',
      'mileage_application_photos',
      'settlements',
    ];
    const before = await Promise.all(
      tables.map((table) =>
        database.connection.unsafe(`SELECT * FROM app.${table}`),
      ),
    );
    await withdraw().expect(204);
    await signup((await proof()).token).expect(201);
    expect(
      await Promise.all(
        tables.map((table) =>
          database.connection.unsafe(`SELECT * FROM app.${table}`),
        ),
      ),
    ).toEqual(before);
    await expect(
      database.connection.unsafe(
        "UPDATE app.mileage_applications SET user_id = $1 WHERE id = 'receipt'",
        [otherId],
      ),
    ).rejects.toThrow();
  });

  it('requires an admin, validates identifiers, and never withdraws an administrator', async () => {
    const old = await saved();
    const driver = await login();
    await request(app.getHttpServer()).delete(`${path}/${userId}`).expect(401);
    await withdraw(userId, `Bearer ${sessionToken(driver)}`).expect(401);
    await withdraw('invalid').expect(400);
    await withdraw(randomUUID()).expect(404);
    const admin = (await database.db.select().from(users)).find(
      (row) => row.role === 'admin',
    )!;
    await withdraw(admin.id).expect(404);
    expect(await saved()).toEqual(old);
    expect(await saved(admin.id)).toEqual(admin);
  });

  it('withdraws an inactive-company driver and treats simultaneous or repeated withdrawal as not found', async () => {
    await database.db
      .update(logisticsCompanies)
      .set({ active: false })
      .where(eq(logisticsCompanies.id, companyId));
    const results = await Promise.all([withdraw(), withdraw()]);
    expect(results.map((result) => result.status).sort()).toEqual([204, 404]);
    const retired = await saved();
    await withdraw().expect(404);
    expect(await saved()).toEqual(retired);
  });

  it.each([
    ['users', 'UPDATE'],
    ['auth_sessions', 'DELETE'],
    ['password_reset_tokens', 'DELETE'],
    ['phone_verifications', 'DELETE'],
  ])(
    'rolls back every credential change when %s %s fails',
    async (table, operation) => {
      await login();
      await resetLink();
      await proof();
      const tables = [
        'users',
        'auth_sessions',
        'password_reset_tokens',
        'phone_verifications',
      ];
      const before = await Promise.all(
        tables.map((name) =>
          database.connection.unsafe(`SELECT * FROM app.${name}`),
        ),
      );
      await createFailureTrigger('fail_withdrawal', operation, table);
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        await withdraw()
          .expect(500)
          .expect(({ body }: { body: { code: string } }) =>
            expect(body.code).toBe('INTERNAL_SERVER_ERROR'),
          );
        expect(
          await Promise.all(
            tables.map((name) =>
              database.connection.unsafe(`SELECT * FROM app.${name}`),
            ),
          ),
        ).toEqual(before);
        expect(JSON.stringify(log.mock.calls)).not.toContain(email);
      } finally {
        await dropFailureTrigger('fail_withdrawal', table);
      }
    },
  );

  it('clears every related public proof including pending sends, but preserves unrelated and other-owner proofs', async () => {
    const removed = [
      await proof(),
      await proof({ purpose: 'find_email' }),
      await proof({
        purpose: 'reset_password',
        scopeEmail: email.toLowerCase(),
        phone: '010-5555-6666',
      }),
      await proof({
        verifiedAt: null,
        proofHash: null,
        expiresAt: '1970-01-01 00:00:00',
      }),
      await proof({
        purpose: 'change_phone',
        scopeUserId: userId,
        phone: '010-7777-6666',
      }),
    ];
    const preserved = [
      await proof({ phone: '010-0000-9999' }),
      await proof({ purpose: 'change_phone', scopeUserId: otherId }),
    ];
    await withdraw().expect(204);
    const ids = (await database.db.select().from(phoneVerifications)).map(
      (row) => row.id,
    );
    expect(ids.sort()).toEqual(preserved.map((row) => row.id).sort());
    const repository = app.get(AuthRepository);
    expect(
      await repository.activatePhoneVerification(removed[3].id, 'sign_up'),
    ).toBeUndefined();
    await expect(
      repository.beginPhoneVerification(
        randomUUID(),
        phone,
        'a'.repeat(64),
        'change_phone',
        undefined,
        userId,
      ),
    ).rejects.toThrow(LoginUnavailableError);
  });

  it('can assign a withdrawn phone to another active driver, but never shares an active identity', async () => {
    const other = await login('other@example.com');
    await withdraw().expect(204);
    const token = await proof({
      purpose: 'change_phone',
      scopeUserId: otherId,
    });
    await request(app.getHttpServer())
      .post('/api/v1/auth/change-phone')
      .auth(sessionToken(other), { type: 'bearer' })
      .send({ phone, verificationProof: token.token })
      .expect(204);
    expect((await saved(otherId)).phone).toBe(phone);
    await signup((await proof()).token).expect(409);
    await expect(
      database.db
        .update(users)
        .set({ deactivatedAt: null })
        .where(eq(users.id, userId)),
    ).rejects.toThrow();
  });

  it('ignores a late SMS acknowledgement after withdrawal and accepts a newly verified signup', async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      SOLAPI_API_KEY: 'test-key',
      SOLAPI_API_SECRET: 'test-secret',
      SOLAPI_SENDER_PHONE: '0212345678',
      PHONE_VERIFICATION_SECRET:
        'test-only-phone-secret-with-at-least-32-bytes',
    });
    let finish!: (value: Response) => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const accepted = () =>
      Response.json({
        failedMessageList: [],
        messageList: [{ messageId: 'test-id', statusCode: '2000' }],
      });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => {
        began();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
    const sending = request(app.getHttpServer())
      .post('/api/v1/auth/phone-verifications')
      .send({ phone, purpose: 'sign_up' })
      .then((result) => result);
    await started;
    await withdraw().expect(204);
    finish(accepted());
    expect((await sending).status).toBe(409);
    expect(await database.db.select().from(phoneVerifications)).toEqual([]);
    fetchMock.mockResolvedValueOnce(accepted());
    const sent = await request(app.getHttpServer())
      .post('/api/v1/auth/phone-verifications')
      .send({ phone, purpose: 'sign_up' })
      .expect(201);
    const sms = JSON.parse(fetchMock.mock.calls[1][1]!.body as string) as {
      messages: { text: string }[];
    };
    const code = sms.messages[0].text.match(/\[(\d{6})\]/)![1];
    const confirmed = await request(app.getHttpServer())
      .post(
        `/api/v1/auth/phone-verifications/${(sent.body as { verificationId: string }).verificationId}/confirm`,
      )
      .send({ purpose: 'sign_up', code })
      .expect(200);
    await signup(
      (confirmed.body as { verificationProof: string }).verificationProof,
    ).expect(201);
  });

  it('targets the newly registered identity for recovery and cannot revive an in-flight old reset email', async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      RESEND_API_KEY: 're_test_only',
      RESEND_FROM_EMAIL: 'sender@example.com',
      RESEND_FROM_NAME: '테스트',
      PASSWORD_RESET_URL: 'https://app.example.com/reset-password',
    });
    let finish!: (value: Response) => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const accepted = () =>
      Response.json({
        id: randomUUID(),
      });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => {
        began();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
    const oldReset = await resetLink();
    const oldProof = await proof({
      purpose: 'reset_password',
      scopeEmail: email.toLowerCase(),
    });
    const sending = request(app.getHttpServer())
      .post('/api/v1/auth/password-reset-emails')
      .send({ email, phone, verificationProof: oldProof.token })
      .then((result) => result);
    await started;
    await withdraw().expect(204);
    const created = await signup((await proof()).token).expect(201);
    finish(accepted());
    expect((await sending).status).toBe(400);
    expect(await database.db.select().from(passwordResetTokens)).toEqual([]);
    await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token: oldReset, newPassword })
      .expect(400);
    fetchMock.mockResolvedValueOnce(accepted());
    const fresh = await proof({
      purpose: 'reset_password',
      scopeEmail: email.toLowerCase(),
    });
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset-emails')
      .send({ email, phone, verificationProof: fresh.token })
      .expect(202);
    const links = await database.db.select().from(passwordResetTokens);
    expect(links).toHaveLength(1);
    expect(links[0].userId).toBe((created.body as { id: string }).id);
    expect((await saved()).passwordHash).toBeNull();
  });

  it('publishes the protected withdrawal response contract in Swagger', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const operation = (response.body as OpenAPIObject).paths[`${path}/{id}`]
      .delete!;
    expect(operation.security).toEqual([
      { admin: [] },
      { 'admin-session': [] },
    ]);
    expect(Object.keys(operation.responses).sort()).toEqual([
      '204',
      '400',
      '401',
      '403',
      '404',
      '500',
    ]);
    const self = (response.body as OpenAPIObject).paths['/api/v1/users/me']
      .delete!;
    expect(self.security).toEqual(
      expect.arrayContaining([{ bearer: [] }, { 'driver-session': [] }]),
    );
    expect(Object.keys(self.responses).sort()).toEqual([
      '204',
      '401',
      '403',
      '404',
      '500',
    ]);
  });

  it('withdraws only the authenticated driver and permits a fresh identity after re-verification', async () => {
    const before = await saved();
    const other = await saved(otherId);
    const first = sessionToken(await login());
    const second = sessionToken(await login());
    const otherToken = sessionToken(await login('other@example.com'));
    const oldProof = await proof();
    const oldReset = await resetLink();

    await request(app.getHttpServer())
      .delete('/api/v1/users/me')
      .auth(first, { type: 'bearer' })
      .send({ id: otherId, userId: otherId })
      .expect(204)
      .expect('Cache-Control', 'no-store');
    expect(await saved()).toEqual({
      ...before,
      passwordHash: null,
      deactivatedAt: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
    });
    expect(await saved(otherId)).toEqual(other);
    for (const token of [first, second]) {
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .auth(token, { type: 'bearer' })
        .expect(401);
    }
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .auth(otherToken, { type: 'bearer' })
      .expect(200);
    expect(await database.db.select().from(phoneVerifications)).toEqual([]);
    expect(await database.db.select().from(passwordResetTokens)).toEqual([]);
    await signup(oldProof.token).expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token: oldReset, newPassword })
      .expect(400);
    expect((await login()).status).toBe(401);
    await request(app.getHttpServer())
      .delete('/api/v1/users/me')
      .auth(first, { type: 'bearer' })
      .expect(401);
    const fresh = await signup((await proof()).token).expect(201);
    expect((fresh.body as { id: string }).id).not.toBe(userId);
    expect((await saved()).deactivatedAt).not.toBeNull();
  });

  it('requires a driver session for self-withdrawal and never accepts an admin token', async () => {
    const before = await database.db.select().from(users);
    await request(app.getHttpServer()).delete('/api/v1/users/me').expect(401);
    await request(app.getHttpServer())
      .delete('/api/v1/users/me')
      .set('Authorization', authorization)
      .expect(401);
    expect(await database.db.select().from(users)).toEqual(before);
  });

  it('protects cookie self-withdrawal from CSRF, rolls back storage faults, and clears the cookie only on success', async () => {
    const origin = 'http://localhost:4000';
    jest.replaceProperty(process, 'env', {
      ...process.env,
      WEB_ORIGINS: origin,
    });
    const browser = request.agent(app.getHttpServer());
    await browser
      .post('/api/v1/auth/web/login')
      .set('Origin', origin)
      .send({ email, password })
      .expect(200);
    for (const untrusted of [undefined, 'https://untrusted.example']) {
      const pending = browser.delete('/api/v1/users/me');
      if (untrusted) pending.set('Origin', untrusted);
      const denied = await pending.expect(403);
      expect(denied.body).toMatchObject({ code: 'WEB_ORIGIN_NOT_ALLOWED' });
    }
    const before = await saved();
    const verification = await proof();
    await resetLink();
    const resets = await database.db.select().from(passwordResetTokens);
    await createFailureTrigger(
      'fail_self_withdrawal',
      'DELETE',
      'phone_verifications',
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const failed = await browser
        .delete('/api/v1/users/me')
        .set('Origin', origin)
        .expect(500);
      expect(failed.body).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
      expect(failed.headers['set-cookie']).toBeUndefined();
      expect(await saved()).toEqual(before);
      expect(await database.db.select().from(passwordResetTokens)).toEqual(
        resets,
      );
      expect(await database.db.select().from(phoneVerifications)).toHaveLength(
        1,
      );
      expect((await database.db.select().from(phoneVerifications))[0].id).toBe(
        verification.id,
      );
      await browser.get('/api/v1/auth/me').expect(200);
    } finally {
      await dropFailureTrigger('fail_self_withdrawal', 'phone_verifications');
    }
    const result = await browser
      .delete('/api/v1/users/me')
      .set('Origin', origin)
      .expect(204);
    expect(String(result.headers['set-cookie'])).toContain(
      'Expires=Thu, 01 Jan 1970',
    );
    await browser.get('/api/v1/auth/me').expect(401);
    expect((await saved()).passwordHash).toBeNull();
  });
});
