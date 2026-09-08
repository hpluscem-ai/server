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
import { createTestApp } from './helpers/create-test-app';

const path = '/api/v1/auth/password-reset-emails';
const mine = '/api/v1/auth/me/password-reset-emails';
const email = 'Driver@example.com';
const phone = '010-1234-5678';
const oldPassword = 'OldPassword!1';
const newPassword = 'NewPassword!2';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const accepted = () =>
  Response.json({
    ErrorCode: 0,
    Message: 'OK',
    MessageID: randomUUID(),
    To: email,
    SubmittedAt: new Date().toISOString(),
  });

describe('Postmark password reset email (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let userId: string;
  let companyId: string;
  let sessionToken: string;
  let oldHash: string;

  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
    oldHash = await argon2.hash(oldPassword, { type: argon2.argon2id });
  });
  beforeEach(() => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      POSTMARK_SERVER_TOKEN: 'test-only-postmark-server-token',
      POSTMARK_FROM_EMAIL: 'sender@example.com',
      POSTMARK_FROM_NAME: '테스트 발신자',
      PASSWORD_RESET_URL: 'https://app.example.com/reset-password',
    });
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(accepted()));
    database.connection.exec(
      'DELETE FROM users; DELETE FROM phone_verifications; DELETE FROM logistics_companies;',
    );
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
        managerPhone: phone,
        bankCode: '19',
        accountNumber: '123456',
        accountHolder: '물류사',
      })
      .run();
    userId = randomUUID();
    database.db
      .insert(users)
      .values({
        id: userId,
        role: 'driver',
        email,
        passwordHash: oldHash,
        name: '기사',
        phone,
        logisticsCompanyId: companyId,
        serviceTermsConsent: true,
        privacyTermsConsent: true,
      })
      .run();
    sessionToken = randomBytes(32).toString('base64url');
    const now = new Date();
    database.db
      .insert(authSessions)
      .values({
        tokenHash: hash(sessionToken),
        userId,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + 3600000),
      })
      .run();
  });
  afterEach(() => {
    database.connection.exec('DROP TRIGGER IF EXISTS fail_reset_mail;');
    jest.restoreAllMocks();
  });
  afterAll(async () => app.close());

  function proof(
    overrides: Partial<typeof phoneVerifications.$inferInsert> = {},
  ) {
    const value = randomBytes(32).toString('base64url');
    const id = randomUUID();
    database.db
      .insert(phoneVerifications)
      .values({
        id,
        purpose: 'reset_password',
        phone,
        scopeEmail: email.toLowerCase(),
        codeHash: '0'.repeat(64),
        proofHash: hash(value),
        verifiedAt: '2026-01-01 00:00:00',
        expiresAt: '2099-01-01 00:00:00',
        ...overrides,
      })
      .run();
    return { id, value };
  }
  function send(value: string, overrides: object = {}) {
    return request(app.getHttpServer())
      .post(path)
      .send({ email, phone, verificationProof: value, ...overrides });
  }
  function sendMine(
    value: string,
    token = sessionToken,
    overrides: object = {},
  ) {
    return request(app.getHttpServer())
      .post(mine)
      .set('Authorization', `Bearer ${token}`)
      .send({ phone, verificationProof: value, ...overrides });
  }
  function reset(token: string) {
    return request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword });
  }
  function payload(index = fetchMock.mock.calls.length - 1) {
    return JSON.parse(fetchMock.mock.calls[index][1]!.body as string) as {
      From: string;
      To: string;
      TextBody: string;
      TrackLinks: string;
      TrackOpens: boolean;
    };
  }
  function sentToken(index?: number) {
    const link = payload(index)
      .TextBody.split('\n')
      .find(
        (line) => line.startsWith('https:') || line.startsWith('hpluseco:'),
      )!;
    return new URL(link).searchParams.get('token')!;
  }
  function storedProof(id: string) {
    return database.db
      .select()
      .from(phoneVerifications)
      .where(eq(phoneVerifications.id, id))
      .get()!;
  }
  function links() {
    return database.db.select().from(passwordResetTokens).all();
  }
  function seedOldLink() {
    const value = randomBytes(32).toString('base64url');
    database.db
      .insert(passwordResetTokens)
      .values({
        id: randomUUID(),
        userId,
        tokenHash: hash(value),
        expiresAt: '2099-01-01 00:00:00',
      })
      .run();
    return value;
  }

  it('sends to the matched driver and completes real reset and session revocation', async () => {
    const item = proof();
    const response = await send(item.value)
      .expect('Cache-Control', 'no-store')
      .expect(202);
    const token = sentToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(response.body as object)).toEqual(['message']);
    expect(JSON.stringify(response.body)).not.toContain(token);
    expect(payload()).toMatchObject({
      To: email,
      From: '"테스트 발신자" <sender@example.com>',
      TrackOpens: false,
      TrackLinks: 'None',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.postmarkapp.com/email',
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'X-Postmark-Server-Token': 'test-only-postmark-server-token' },
    });
    expect(storedProof(item.id).consumedAt).not.toBeNull();
    expect(links()).toHaveLength(1);
    expect(links()[0].tokenHash).toBe(hash(token));
    const remaining =
      Date.parse(links()[0].expiresAt.replace(' ', 'T') + 'Z') - Date.now();
    expect(remaining).toBeGreaterThan(29 * 60000);
    expect(remaining).toBeLessThanOrEqual(30 * 60000);
    await reset(token).expect(204);
    await reset(token).expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(401);
    const saved = database.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .get()!;
    expect(await argon2.verify(saved.passwordHash, newPassword)).toBe(true);
    expect(await argon2.verify(saved.passwordHash, oldPassword)).toBe(false);
  });

  it('returns only the current user email for an authenticated SMS-proven request', async () => {
    expect((await sendMine(proof().value).expect(200)).body).toEqual({ email });
    expect(payload().To).toBe(email);
  });

  it.each([
    ['public', email, ' DRIVER@EXAMPLE.COM '],
    ['public', 'ÉLODIE@example.com', 'ÉLODIE@example.com'],
    ['public', 'ÉLODIE@example.com', 'élodie@example.com'],
    ['public', 'driver@EXÄMPLE.com', 'driver@exämple.com'],
    ['mine', 'ÉLODIE@example.com', 'ÉLODIE@example.com'],
    ['mine', 'ÉLODIE@example.com', 'élodie@example.com'],
    ['mine', 'driver@EXÄMPLE.com', 'driver@exämple.com'],
  ])(
    'connects SMS → %s email → reset for %s entered as %s',
    async (mode, storedEmail, inputEmail) => {
      database.db
        .update(users)
        .set({ email: storedEmail })
        .where(eq(users.id, userId))
        .run();
      jest.replaceProperty(process, 'env', {
        ...process.env,
        SOLAPI_API_KEY: 'test-key',
        SOLAPI_API_SECRET: 'test-secret',
        SOLAPI_SENDER_PHONE: '0212345678',
        PHONE_VERIFICATION_SECRET:
          'test-only-phone-secret-with-at-least-32-bytes',
      });
      fetchMock.mockResolvedValueOnce(
        Response.json({
          failedMessageList: [],
          messageList: [{ messageId: 'test-id', statusCode: '2000' }],
        }),
      );
      fetchMock.mockResolvedValueOnce(
        Response.json({
          ErrorCode: 0,
          MessageID: randomUUID(),
          To: storedEmail,
          SubmittedAt: new Date().toISOString(),
        }),
      );
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/phone-verifications')
        .send({ purpose: 'reset_password', email: inputEmail, phone })
        .expect(201);
      const id = (response.body as { verificationId: string }).verificationId;
      const sms = JSON.parse(fetchMock.mock.calls[0][1]!.body as string) as {
        messages: { text: string }[];
      };
      const code = sms.messages[0].text.match(/\[(\d{6})\]/)![1];
      const confirmation = await request(app.getHttpServer())
        .post(`/api/v1/auth/phone-verifications/${id}/confirm`)
        .send({ purpose: 'reset_password', code })
        .expect(200);
      const value = (confirmation.body as { verificationProof: string })
        .verificationProof;
      if (mode === 'mine')
        expect((await sendMine(value).expect(200)).body).toEqual({
          email: storedEmail,
        });
      else await send(value, { email: inputEmail }).expect(202);
      expect(payload().To).toBe(storedEmail);
      await reset(sentToken()).expect(204);
      expect(storedProof(id).consumedAt).not.toBeNull();
    },
  );

  it('preserves another drivers reset links when reissuing this drivers link', async () => {
    const otherId = randomUUID();
    database.db
      .insert(users)
      .values({
        id: otherId,
        role: 'driver',
        email: 'other@example.com',
        passwordHash: oldHash,
        name: '다른기사',
        phone: '010-9999-9999',
        logisticsCompanyId: companyId,
        serviceTermsConsent: true,
        privacyTermsConsent: true,
      })
      .run();
    const otherToken = randomBytes(32).toString('base64url');
    database.db
      .insert(passwordResetTokens)
      .values({
        id: randomUUID(),
        userId: otherId,
        tokenHash: hash(otherToken),
        expiresAt: '2099-01-01 00:00:00',
      })
      .run();
    await send(proof().value).expect(202);
    expect(links().find((row) => row.userId === otherId)!.usedAt).toBeNull();
    await reset(otherToken).expect(204);
    await reset(sentToken()).expect(204);
  });

  it('does not consume the proof or send if required configuration is missing', async () => {
    delete process.env.PASSWORD_RESET_URL;
    const item = proof();
    expect((await send(item.value).expect(503)).body).toMatchObject({
      code: 'PASSWORD_RESET_EMAIL_NOT_CONFIGURED',
    });
    expect(storedProof(item.id).consumedAt).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(links()).toEqual([]);
  });

  it.each([
    'POSTMARK_SERVER_TOKEN',
    'POSTMARK_FROM_EMAIL',
    'POSTMARK_FROM_NAME',
    'PASSWORD_RESET_URL',
  ])('requires %s before consuming a proof', async (key) => {
    delete process.env[key];
    const item = proof();
    await send(item.value).expect('Cache-Control', 'no-store').expect(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedProof(item.id).consumedAt).toBeNull();
  });
  it.each([
    ['POSTMARK_SERVER_TOKEN', 'POSTMARK_API_TEST'],
    ['POSTMARK_SERVER_TOKEN', 'token\r\nInjected: value'],
    ['POSTMARK_FROM_EMAIL', 'sender@example.com,other@example.com'],
    ['POSTMARK_FROM_NAME', 'Name\r\nBcc: other@example.com'],
    ['PASSWORD_RESET_URL', 'not-a-url'],
    ['PASSWORD_RESET_URL', 'http://app.example.com/reset-password'],
    ['PASSWORD_RESET_URL', 'javascript:alert(1)'],
    [
      'PASSWORD_RESET_URL',
      'https://user:password@app.example.com/reset-password',
    ],
    ['PASSWORD_RESET_URL', 'https://app.example.com/reset-password?token=old'],
    ['PASSWORD_RESET_URL', 'https://app.example.com/reset-password#fragment'],
  ])('rejects invalid configuration %s=%s', async (key, value) => {
    process.env[key] = value;
    const item = proof();
    expect((await send(item.value).expect(503)).body).toMatchObject({
      code: 'PASSWORD_RESET_EMAIL_NOT_CONFIGURED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedProof(item.id).consumedAt).toBeNull();
  });
  it('allows an explicitly configured existing app scheme, without selecting it as a default', async () => {
    process.env.PASSWORD_RESET_URL = 'hpluseco://reset-password';
    await send(proof().value).expect(202);
    expect(payload().TextBody).toContain('hpluseco://reset-password?token=');
    await reset(sentToken()).expect(204);
  });
  it.each(['sign_up', 'find_email', 'change_phone'])(
    'rejects a %s proof',
    async (purpose) => {
      const item = proof({ purpose, scopeEmail: null });
      expect((await send(item.value).expect(400)).body).toMatchObject({
        code: 'PHONE_VERIFICATION_INVALID',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(storedProof(item.id).consumedAt).toBeNull();
    },
  );
  it.each([
    { scopeEmail: 'other@example.com' },
    { phone: '010-9999-9999' },
    { expiresAt: '1970-01-01 00:00:00' },
    { verifiedAt: null },
    { consumedAt: '2026-01-01 00:00:00' },
    { invalidatedAt: '2026-01-01 00:00:00' },
  ])('rejects invalid proof bindings/state %j', async (overrides) => {
    const item = proof(overrides);
    expect((await send(item.value).expect(400)).body).toMatchObject({
      code: 'PHONE_VERIFICATION_INVALID',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { email, phone },
    { email, phone, verificationProof: null },
    { email: 'invalid', phone, verificationProof: 'proof' },
    { email, phone: '01012345678', verificationProof: 'proof' },
    { email, phone, verificationProof: 'x'.repeat(513) },
    {
      email,
      phone,
      verificationProof: 'proof',
      redirectUrl: 'https://evil.example.com',
    },
  ])('rejects invalid or unapproved request fields %j', async (input) => {
    expect(
      (await request(app.getHttpServer()).post(path).send(input).expect(400))
        .body,
    ).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    'absent',
    'admin',
    'deactivated',
    'inactive_company',
    'wrong_phone',
    'wrong_email',
  ])(
    'returns the same generic acceptance for %s, without sending',
    async (kind) => {
      if (kind === 'absent') database.db.delete(users).run();
      else if (kind === 'inactive_company')
        database.db.update(logisticsCompanies).set({ active: false }).run();
      else
        database.db
          .update(users)
          .set(
            kind === 'admin'
              ? { role: 'admin' }
              : kind === 'deactivated'
                ? { deactivatedAt: '2026-01-01 00:00:00' }
                : kind === 'wrong_phone'
                  ? { phone: '010-9999-9999' }
                  : { email: 'other@example.com' },
          )
          .run();
      const item = proof();
      expect((await send(item.value).expect(202)).body).toEqual({
        message:
          '요청을 접수했습니다. 입력한 정보와 일치하는 계정이 있다면 메일을 확인해 주세요.',
      });
      expect(storedProof(item.id).consumedAt).not.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(links()).toEqual([]);
      await send(item.value).expect(400);
    },
  );

  it('blocks simultaneous and later reuse before a second external send', async () => {
    const item = proof();
    const results = await Promise.all([send(item.value), send(item.value)]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 400]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await send(item.value).expect(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('keeps old links active until the external acceptance and rejects the candidate beforehand', async () => {
    const old = seedOldLink();
    let finish!: (response: Response) => void;
    let started!: () => void;
    const sent = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetchMock.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const response = send(proof().value).then((result) => result);
    await sent;
    const candidate = sentToken();
    expect(links()).toHaveLength(1);
    expect(links()[0]).toMatchObject({ tokenHash: hash(old), usedAt: null });
    await reset(candidate).expect(400);
    finish(accepted());
    expect((await response).status).toBe(202);
    expect(
      links().find((row) => row.tokenHash === hash(old))!.usedAt,
    ).not.toBeNull();
    await reset(old).expect(400);
    await reset(candidate).expect(204);
  });
  it('makes only the last activated link usable across distinct simultaneous proofs', async () => {
    const results = await Promise.all([
      send(proof().value),
      send(proof().value),
    ]);
    expect(results.map((r) => r.status)).toEqual([202, 202]);
    const active = links().filter((row) => row.usedAt === null);
    expect(active).toHaveLength(1);
    const tokens = [sentToken(0), sentToken(1)];
    const winner = tokens.find((token) => hash(token) === active[0].tokenHash)!;
    const loser = tokens.find((token) => token !== winner)!;
    await reset(loser).expect(400);
    await reset(winner).expect(204);
  });

  it.each([
    'http_error',
    'provider_error',
    'missing_id',
    'invalid_id',
    'wrong_recipient',
    'missing_timestamp',
    'malformed_json',
    'timeout',
  ])(
    'keeps old links and consumes the proof on %s without retry or sensitive logs',
    async (failure) => {
      const old = seedOldLink();
      const item = proof();
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const good = {
        ErrorCode: 0,
        MessageID: randomUUID(),
        To: email,
        SubmittedAt: new Date().toISOString(),
      };
      if (failure === 'timeout')
        fetchMock.mockRejectedValueOnce(
          new Error('provider secret driver@example.com token'),
        );
      else
        fetchMock.mockResolvedValueOnce(
          failure === 'malformed_json'
            ? new Response('private token')
            : Response.json(
                {
                  ...good,
                  ...(failure === 'provider_error'
                    ? { ErrorCode: 406, Message: 'private data' }
                    : {}),
                  ...(failure === 'missing_id' ? { MessageID: undefined } : {}),
                  ...(failure === 'invalid_id'
                    ? { MessageID: 'not-a-message-id' }
                    : {}),
                  ...(failure === 'wrong_recipient'
                    ? { To: 'other@example.com' }
                    : {}),
                  ...(failure === 'missing_timestamp'
                    ? { SubmittedAt: undefined }
                    : {}),
                },
                { status: failure === 'http_error' ? 503 : 200 },
              ),
        );
      expect((await send(item.value).expect(502)).body).toEqual({
        statusCode: 502,
        code: 'PASSWORD_RESET_EMAIL_SEND_FAILED',
        message:
          '메일 발송을 확인하지 못했습니다. 휴대폰 인증 후 다시 요청해 주세요.',
      });
      expect(storedProof(item.id).consumedAt).not.toBeNull();
      expect(links()).toHaveLength(1);
      expect(links()[0]).toMatchObject({ tokenHash: hash(old), usedAt: null });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      await send(item.value).expect(400);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await reset(old).expect(204);
    },
  );

  it.each(['proof', 'invalidate', 'insert'])(
    'does not hide a %s database failure and rolls back its transaction',
    async (operation) => {
      const old = seedOldLink();
      const item = proof();
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const target =
        operation === 'proof'
          ? 'UPDATE ON phone_verifications'
          : operation === 'invalidate'
            ? 'UPDATE ON password_reset_tokens'
            : 'INSERT ON password_reset_tokens';
      database.connection.exec(
        `CREATE TRIGGER fail_reset_mail BEFORE ${target} BEGIN SELECT RAISE(ABORT, 'private@example.com token'); END;`,
      );
      expect((await send(item.value).expect(500)).body).toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
      expect(links()).toHaveLength(1);
      expect(links()[0]).toMatchObject({ tokenHash: hash(old), usedAt: null });
      expect(fetchMock).toHaveBeenCalledTimes(operation === 'proof' ? 0 : 1);
      if (operation === 'proof')
        expect(storedProof(item.id).consumedAt).toBeNull();
      else {
        expect(storedProof(item.id).consumedAt).not.toBeNull();
        await reset(sentToken()).expect(400);
      }
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /private@example.com|token/,
      );
      database.connection.exec('DROP TRIGGER fail_reset_mail;');
      await reset(old).expect(204);
    },
  );

  it.each(['password', 'email', 'phone', 'deactivated', 'company', 'role'])(
    'cannot activate a link after %s changes during delivery',
    async (change) => {
      fetchMock.mockImplementationOnce(() => {
        if (change === 'company')
          database.db.update(logisticsCompanies).set({ active: false }).run();
        else
          database.db
            .update(users)
            .set(
              change === 'password'
                ? { passwordHash: 'changed-password-hash' }
                : change === 'email'
                  ? { email: 'other@example.com' }
                  : change === 'phone'
                    ? { phone: '010-9999-9999' }
                    : change === 'deactivated'
                      ? { deactivatedAt: '2026-01-01 00:00:00' }
                      : { role: 'admin' },
            )
            .run();
        return Promise.resolve(accepted());
      });
      expect((await send(proof().value).expect(400)).body).toMatchObject({
        code: 'PASSWORD_RESET_REQUEST_INVALID',
      });
      expect(links()).toEqual([]);
      await reset(sentToken()).expect(400);
    },
  );
  it('cannot revive a link after a real current-password change while mail is in flight', async () => {
    fetchMock.mockImplementationOnce(async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${sessionToken}`)
        .send({ currentPassword: oldPassword, newPassword })
        .expect(204);
      return accepted();
    });
    expect((await send(proof().value).expect(400)).body).toMatchObject({
      code: 'PASSWORD_RESET_REQUEST_INVALID',
    });
    expect(links()).toEqual([]);
  });
  it('cannot revive a link after another real reset while mail is in flight', async () => {
    const old = seedOldLink();
    fetchMock.mockImplementationOnce(async () => {
      await reset(old).expect(204);
      return accepted();
    });
    await send(proof().value).expect(400);
    await reset(sentToken()).expect(400);
    expect(links().every((row) => row.usedAt !== null)).toBe(true);
  });
  it('requires fresh SMS proof to reissue and immediately rejects a newly issued expired link', async () => {
    const item = proof();
    await send(item.value).expect(202);
    await send(item.value).expect(400);
    await send(proof().value).expect(202);
    const token = sentToken();
    database.db
      .update(passwordResetTokens)
      .set({ expiresAt: '1970-01-01 00:00:00' })
      .where(eq(passwordResetTokens.tokenHash, hash(token)))
      .run();
    await reset(token).expect(400);
  });

  it.each(['missing', 'revoked', 'expired', 'admin', 'company', 'deactivated'])(
    'blocks MyPage for a %s session',
    async (kind) => {
      if (kind === 'revoked') database.db.delete(authSessions).run();
      else if (kind === 'expired')
        database.db
          .update(authSessions)
          .set({
            createdAt: new Date(0),
            lastUsedAt: new Date(1),
            expiresAt: new Date(2),
          })
          .run();
      else if (kind === 'admin')
        database.db.update(users).set({ role: 'admin' }).run();
      else if (kind === 'company')
        database.db.update(logisticsCompanies).set({ active: false }).run();
      else if (kind === 'deactivated')
        database.db
          .update(users)
          .set({ deactivatedAt: '2026-01-01 00:00:00' })
          .run();
      const item = proof();
      await sendMine(item.value, kind === 'missing' ? '' : sessionToken)
        .expect('Cache-Control', 'no-store')
        .expect(401);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(storedProof(item.id).consumedAt).toBeNull();
    },
  );
  it('does not allow MyPage to choose the recipient, use another email proof, or skip SMS', async () => {
    const item = proof();
    await sendMine(item.value, sessionToken, {
      email: 'other@example.com',
    }).expect(400);
    await sendMine(item.value, sessionToken, {
      verificationProof: null,
    }).expect(400);
    await sendMine(proof({ scopeEmail: 'other@example.com' }).value).expect(
      400,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedProof(item.id).consumedAt).toBeNull();
  });

  it('rejects a MyPage proof for a phone that is not the current account phone', async () => {
    const wrongPhone = '010-9999-9999';
    const item = proof({ phone: wrongPhone });
    expect(
      (
        await sendMine(item.value, sessionToken, { phone: wrongPhone }).expect(
          400,
        )
      ).body,
    ).toMatchObject({ code: 'PHONE_VERIFICATION_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedProof(item.id).consumedAt).toBeNull();
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(200);
  });
  it('does not activate after the requesting MyPage session logs out during delivery', async () => {
    fetchMock.mockImplementationOnce(() => {
      database.db.delete(authSessions).run();
      return Promise.resolve(accepted());
    });
    expect((await sendMine(proof().value).expect(400)).body).toMatchObject({
      code: 'PASSWORD_RESET_REQUEST_INVALID',
    });
    expect(links()).toEqual([]);
  });
  it('documents both APIs, request scopes and failures', async () => {
    const docs = (
      await request(app.getHttpServer()).get('/docs-json').expect(200)
    ).body as OpenAPIObject;
    expect(Object.keys(docs.paths[path].post!.responses).sort()).toEqual([
      '202',
      '400',
      '500',
      '502',
      '503',
    ]);
    expect(Object.keys(docs.paths[mine].post!.responses).sort()).toEqual([
      '200',
      '400',
      '401',
      '500',
      '502',
      '503',
    ]);
    expect(docs.paths[mine].post!.security).toEqual([{ bearer: [] }]);
    expect(
      docs.components!.schemas!.RequestPasswordResetEmailDto,
    ).toMatchObject({ required: ['phone', 'verificationProof', 'email'] });
    expect(
      docs.components!.schemas!.MyPasswordResetEmailResponseDto,
    ).toMatchObject({ required: ['email'] });
  });
});
