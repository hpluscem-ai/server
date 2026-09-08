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
    authorization = seedAdminSession(database);
    companyId = randomUUID();
    database.db
      .insert(logisticsCompanies)
      .values({
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
      })
      .run();
    userId = seedDriver(email, phone);
    otherId = seedDriver('other@example.com', '010-9999-8888');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  function seedDriver(address: string, number: string) {
    const id = randomUUID();
    database.db
      .insert(users)
      .values({
        id,
        role: 'driver',
        email: address,
        phone: number,
        passwordHash,
        name: '보존 기사',
        logisticsCompanyId: companyId,
        serviceTermsConsent: true,
        privacyTermsConsent: true,
      })
      .run();
    return id;
  }
  function saved(id = userId) {
    return database.db.select().from(users).where(eq(users.id, id)).get()!;
  }
  function withdraw(id = userId, auth = authorization) {
    return request(app.getHttpServer())
      .delete(`${path}/${id}`)
      .set('Authorization', auth);
  }
  function proof(
    overrides: Partial<typeof phoneVerifications.$inferInsert> = {},
  ) {
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    database.db
      .insert(phoneVerifications)
      .values({
        id,
        purpose: 'sign_up',
        phone,
        codeHash: '0'.repeat(64),
        proofHash: hashToken(token),
        verifiedAt: '2026-01-01 00:00:00',
        expiresAt: '2099-01-01 00:00:00',
        ...overrides,
      })
      .run();
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
  function resetLink(id = userId) {
    const token = randomBytes(32).toString('base64url');
    database.db
      .insert(passwordResetTokens)
      .values({
        id: randomUUID(),
        userId: id,
        tokenHash: hashToken(token),
        expiresAt: '2099-01-01 00:00:00',
      })
      .run();
    return token;
  }

  it('preserves identity, clears credentials and sessions, and excludes the withdrawn driver', async () => {
    const old = saved();
    const other = saved(otherId);
    const first = await login();
    const second = await login();
    expect([first.status, second.status]).toEqual([200, 200]);
    const otherLogin = await login('other@example.com');
    const reset = resetLink();
    const otherReset = resetLink(otherId);
    const oldProof = proof();
    const ownChange = proof({
      purpose: 'change_phone',
      scopeUserId: userId,
      phone: '010-1111-2222',
    });
    const otherChange = proof({
      purpose: 'change_phone',
      scopeUserId: otherId,
    });
    await withdraw().expect(204).expect('Cache-Control', 'no-store');
    expect(saved()).toEqual({
      ...old,
      passwordHash: null,
      deactivatedAt: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
    });
    expect(saved(otherId)).toEqual(other);
    expect(
      database.db
        .select()
        .from(authSessions)
        .where(eq(authSessions.userId, userId))
        .all(),
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
        database.db
          .select()
          .from(phoneVerifications)
          .where(eq(phoneVerifications.id, id))
          .get(),
      ).toBeUndefined();
    expect(
      database.db
        .select()
        .from(phoneVerifications)
        .where(eq(phoneVerifications.id, otherChange.id))
        .get(),
    ).toBeDefined();
    expect(
      database.db
        .select()
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.tokenHash, hashToken(reset)))
        .get(),
    ).toBeUndefined();
    expect(
      database.db
        .select()
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.tokenHash, hashToken(otherReset)))
        .get(),
    ).toBeDefined();
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
    const oldProof = proof();
    await withdraw().expect(204);
    await signup(oldProof.token)
      .expect(400)
      .expect(({ body }: { body: { code: string } }) =>
        expect(body.code).toBe('PHONE_VERIFICATION_INVALID'),
      );
    const fresh = proof();
    const created = await signup(fresh.token).expect(201);
    const newId = (created.body as { id: string }).id;
    expect(newId).not.toBe(userId);
    expect(saved().email).toBe(email);
    expect(saved().phone).toBe(phone);
    expect(saved(newId).deactivatedAt).toBeNull();
    const logged = await login(email.toLowerCase(), newPassword);
    expect(logged.status).toBe(200);
    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .auth(sessionToken(logged), { type: 'bearer' })
      .expect(200);
    expect((me.body as { id: string }).id).toBe(newId);
    expect((await login()).status).toBe(401);
    const lookup = proof({ purpose: 'find_email' });
    await request(app.getHttpServer())
      .post('/api/v1/auth/find-email')
      .send({ phone, verificationProof: lookup.token })
      .expect(200);
    await signup(proof().token).expect(409);
    const nextProof = proof();
    await withdraw(userId).expect(404);
    expect(
      database.db
        .select()
        .from(phoneVerifications)
        .where(eq(phoneVerifications.id, nextProof.id))
        .get(),
    ).toBeDefined();
    expect(saved(newId).deactivatedAt).toBeNull();
  });

  it('preserves receipts, photos and completed settlements without transferring ownership on re-registration', async () => {
    database.connection.exec(`
      INSERT INTO settlements (id, logistics_company_id, settlement_month) VALUES ('settlement', '${companyId}', '2026-08');
      INSERT INTO mileage_applications (id, user_id, logistics_company_id, idempotency_key) VALUES ('receipt', '${userId}', '${companyId}', 'once');
      INSERT INTO mileage_application_photos (id, mileage_application_id, kind, storage_key, content_type, byte_size)
        VALUES ('photo1', 'receipt', 'receipt', 'private/receipt', 'image/jpeg', 100), ('photo2', 'receipt', 'meter', 'private/meter', 'image/jpeg', 100);
      UPDATE mileage_applications SET approval_status = 'approved', final_amount = 1000, mileage_amount = 20, decided_at = CURRENT_TIMESTAMP, settlement_id = 'settlement' WHERE id = 'receipt';
      UPDATE settlements SET transfer_status = 'completed', transferred_at = CURRENT_TIMESTAMP WHERE id = 'settlement';
    `);
    const tables = [
      'mileage_applications',
      'mileage_application_photos',
      'settlements',
    ];
    const before = tables.map((table) =>
      database.connection.prepare(`SELECT * FROM ${table}`).all(),
    );
    await withdraw().expect(204);
    await signup(proof().token).expect(201);
    expect(
      tables.map((table) =>
        database.connection.prepare(`SELECT * FROM ${table}`).all(),
      ),
    ).toEqual(before);
    expect(
      database.connection.prepare('PRAGMA foreign_key_check').all(),
    ).toEqual([]);
    expect(() =>
      database.connection
        .prepare('UPDATE mileage_applications SET user_id = ?')
        .run(otherId),
    ).toThrow();
  });

  it('requires an admin, validates identifiers, and never withdraws an administrator', async () => {
    const old = saved();
    const driver = await login();
    await request(app.getHttpServer()).delete(`${path}/${userId}`).expect(401);
    await withdraw(userId, `Bearer ${sessionToken(driver)}`).expect(401);
    await withdraw('invalid').expect(400);
    await withdraw(randomUUID()).expect(404);
    const admin = database.db
      .select()
      .from(users)
      .all()
      .find((row) => row.role === 'admin')!;
    await withdraw(admin.id).expect(404);
    expect(saved()).toEqual(old);
    expect(saved(admin.id)).toEqual(admin);
  });

  it('withdraws an inactive-company driver and treats simultaneous or repeated withdrawal as not found', async () => {
    database.db
      .update(logisticsCompanies)
      .set({ active: false })
      .where(eq(logisticsCompanies.id, companyId))
      .run();
    const results = await Promise.all([withdraw(), withdraw()]);
    expect(results.map((result) => result.status).sort()).toEqual([204, 404]);
    const retired = saved();
    await withdraw().expect(404);
    expect(saved()).toEqual(retired);
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
      resetLink();
      proof();
      const tables = [
        'users',
        'auth_sessions',
        'password_reset_tokens',
        'phone_verifications',
      ];
      const before = tables.map((name) =>
        database.connection.prepare(`SELECT * FROM ${name}`).all(),
      );
      database.connection.exec(
        `CREATE TRIGGER fail_withdrawal BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'test storage failure'); END;`,
      );
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
          tables.map((name) =>
            database.connection.prepare(`SELECT * FROM ${name}`).all(),
          ),
        ).toEqual(before);
        expect(JSON.stringify(log.mock.calls)).not.toContain(email);
      } finally {
        database.connection.exec('DROP TRIGGER fail_withdrawal;');
      }
    },
  );

  it('clears every related public proof including pending sends, but preserves unrelated and other-owner proofs', async () => {
    const removed = [
      proof(),
      proof({ purpose: 'find_email' }),
      proof({
        purpose: 'reset_password',
        scopeEmail: email.toLowerCase(),
        phone: '010-5555-6666',
      }),
      proof({
        verifiedAt: null,
        proofHash: null,
        expiresAt: '1970-01-01 00:00:00',
      }),
      proof({
        purpose: 'change_phone',
        scopeUserId: userId,
        phone: '010-7777-6666',
      }),
    ];
    const preserved = [
      proof({ phone: '010-0000-9999' }),
      proof({ purpose: 'change_phone', scopeUserId: otherId }),
    ];
    await withdraw().expect(204);
    const ids = database.db
      .select()
      .from(phoneVerifications)
      .all()
      .map((row) => row.id);
    expect(ids.sort()).toEqual(preserved.map((row) => row.id).sort());
    const repository = app.get(AuthRepository);
    expect(
      repository.activatePhoneVerification(removed[3].id, 'sign_up'),
    ).toBeUndefined();
    expect(() =>
      repository.beginPhoneVerification(
        randomUUID(),
        phone,
        'a'.repeat(64),
        'change_phone',
        undefined,
        userId,
      ),
    ).toThrow(LoginUnavailableError);
  });

  it('can assign a withdrawn phone to another active driver, but never shares an active identity', async () => {
    const other = await login('other@example.com');
    await withdraw().expect(204);
    const token = proof({ purpose: 'change_phone', scopeUserId: otherId });
    await request(app.getHttpServer())
      .post('/api/v1/auth/change-phone')
      .auth(sessionToken(other), { type: 'bearer' })
      .send({ phone, verificationProof: token.token })
      .expect(204);
    expect(saved(otherId).phone).toBe(phone);
    await signup(proof().token).expect(409);
    expect(() =>
      database.db
        .update(users)
        .set({ deactivatedAt: null })
        .where(eq(users.id, userId))
        .run(),
    ).toThrow();
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
    expect(database.db.select().from(phoneVerifications).all()).toEqual([]);
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
      POSTMARK_SERVER_TOKEN: 'test-only',
      POSTMARK_FROM_EMAIL: 'sender@example.com',
      POSTMARK_FROM_NAME: '테스트',
      PASSWORD_RESET_URL: 'https://app.example.com/reset-password',
    });
    let finish!: (value: Response) => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const accepted = () =>
      Response.json({
        ErrorCode: 0,
        MessageID: randomUUID(),
        To: email,
        SubmittedAt: new Date().toISOString(),
      });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => {
        began();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
    const oldReset = resetLink();
    const oldProof = proof({
      purpose: 'reset_password',
      scopeEmail: email.toLowerCase(),
    });
    const sending = request(app.getHttpServer())
      .post('/api/v1/auth/password-reset-emails')
      .send({ email, phone, verificationProof: oldProof.token })
      .then((result) => result);
    await started;
    await withdraw().expect(204);
    const created = await signup(proof().token).expect(201);
    finish(accepted());
    expect((await sending).status).toBe(400);
    expect(database.db.select().from(passwordResetTokens).all()).toEqual([]);
    await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token: oldReset, newPassword })
      .expect(400);
    fetchMock.mockResolvedValueOnce(accepted());
    const fresh = proof({
      purpose: 'reset_password',
      scopeEmail: email.toLowerCase(),
    });
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset-emails')
      .send({ email, phone, verificationProof: fresh.token })
      .expect(202);
    const links = database.db.select().from(passwordResetTokens).all();
    expect(links).toHaveLength(1);
    expect(links[0].userId).toBe((created.body as { id: string }).id);
    expect(saved().passwordHash).toBeNull();
  });

  it('publishes the protected withdrawal response contract in Swagger', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const operation = (response.body as OpenAPIObject).paths[`${path}/{id}`]
      .delete!;
    expect(operation.security).toEqual([{ admin: [] }]);
    expect(Object.keys(operation.responses).sort()).toEqual([
      '204',
      '400',
      '401',
      '404',
      '500',
    ]);
  });
});
