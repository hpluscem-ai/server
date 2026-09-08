import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { DatabaseService } from '../src/database/database.service';
import {
  logisticsCompanies,
  phoneVerifications,
  users,
} from '../src/database/schema';
import { createTestApp } from './helpers/create-test-app';

const path = '/api/v1/auth/find-email';
const phone = '010-1234-5678';

describe('Find email (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let userId: string;
  let companyId: string;

  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
  });
  beforeEach(() => {
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
        email: 'driver@example.com',
        passwordHash: 'test-only-unused-hash',
        name: '기사',
        phone,
        logisticsCompanyId: companyId,
        serviceTermsConsent: true,
        privacyTermsConsent: true,
      })
      .run();
  });
  afterEach(() => {
    database.connection.exec('DROP TRIGGER IF EXISTS fail_find_email;');
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
        purpose: 'find_email',
        phone,
        codeHash: '0'.repeat(64),
        proofHash: createHash('sha256').update(value).digest('hex'),
        verifiedAt: new Date().toISOString(),
        expiresAt: '2099-01-01 00:00:00',
        ...overrides,
      })
      .run();
    return { id, value };
  }
  function find(value: string, extra: object = {}) {
    return request(app.getHttpServer())
      .post(path)
      .send({ phone, verificationProof: value, ...extra });
  }
  function saved(id: string) {
    return database.db
      .select()
      .from(phoneVerifications)
      .where(eq(phoneVerifications.id, id))
      .get()!;
  }

  it('uses a real purpose-scoped SMS proof and returns only the masked result once', async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      SOLAPI_API_KEY: 'test-key',
      SOLAPI_API_SECRET: 'test-secret',
      SOLAPI_SENDER_PHONE: '0212345678',
      PHONE_VERIFICATION_SECRET:
        'test-only-phone-secret-with-at-least-32-bytes',
    });
    const sent = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        failedMessageList: [],
        messageList: [{ messageId: 'test-id', statusCode: '2000' }],
      }),
    );
    const start = await request(app.getHttpServer())
      .post('/api/v1/auth/phone-verifications')
      .send({ phone, purpose: 'find_email' })
      .expect(201);
    const id = (start.body as { verificationId: string }).verificationId;
    const payload = JSON.parse(sent.mock.calls[0][1]!.body as string) as {
      messages: { text: string }[];
    };
    const code = payload.messages[0].text.match(/\[(\d{6})\]/)![1];
    const confirmation = await request(app.getHttpServer())
      .post(`/api/v1/auth/phone-verifications/${id}/confirm`)
      .send({ purpose: 'find_email', code })
      .expect(200);
    const value = (confirmation.body as { verificationProof: string })
      .verificationProof;
    const result = await find(value)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(result.body).toEqual({
      maskedEmail: 'dr****@example.com',
      phoneLastFour: '5678',
    });
    expect(saved(id).consumedAt).not.toBeNull();
    expect((await find(value).expect(400)).body).toMatchObject({
      code: 'PHONE_VERIFICATION_INVALID',
    });
  });

  it.each([
    ['a@example.com', '*@example.com'],
    ['ab@example.com', '**@example.com'],
    ['abc@example.com', 'ab*@example.com'],
  ])('masks %s', async (email, maskedEmail) => {
    database.db.update(users).set({ email }).where(eq(users.id, userId)).run();
    expect((await find(proof().value).expect(200)).body).toEqual({
      maskedEmail,
      phoneLastFour: '5678',
    });
  });

  it.each(['sign_up', 'reset_password', 'change_phone'])(
    'rejects a %s proof without consumption',
    async (purpose) => {
      const item = proof({
        purpose,
        ...(purpose === 'reset_password'
          ? { scopeEmail: 'driver@example.com' }
          : {}),
      });
      expect((await find(item.value).expect(400)).body).toMatchObject({
        code: 'PHONE_VERIFICATION_INVALID',
      });
      expect(saved(item.id).consumedAt).toBeNull();
    },
  );

  it.each([
    { phone: '010-9999-9999' },
    { expiresAt: '1970-01-01 00:00:00' },
    { verifiedAt: null },
    { consumedAt: '2026-01-01 00:00:00' },
    { invalidatedAt: '2026-01-01 00:00:00' },
  ])('rejects an invalid proof scope/state: %j', async (overrides) => {
    expect((await find(proof(overrides).value).expect(400)).body).toMatchObject(
      { code: 'PHONE_VERIFICATION_INVALID' },
    );
  });

  it.each([
    {},
    { phone },
    { phone, verificationProof: null },
    { phone: '01012345678', verificationProof: 'proof' },
    { phone, verificationProof: 'x'.repeat(513) },
    { phone, verificationProof: 'proof', email: 'someone@example.com' },
  ])('rejects malformed inputs %j', async (input) => {
    expect(
      (await request(app.getHttpServer()).post(path).send(input).expect(400))
        .body,
    ).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it.each(['absent', 'admin', 'deactivated'])(
    'does not expose %s accounts and consumes the proof',
    async (state) => {
      if (state === 'absent') database.db.delete(users).run();
      else
        database.db
          .update(users)
          .set(
            state === 'admin'
              ? { role: 'admin' }
              : { deactivatedAt: '2026-01-01 00:00:00' },
          )
          .run();
      const item = proof();
      expect((await find(item.value).expect(404)).body).toEqual({
        statusCode: 404,
        code: 'ACCOUNT_NOT_FOUND',
        message: '일치하는 회원정보를 찾을 수 없습니다.',
      });
      expect(saved(item.id).consumedAt).not.toBeNull();
      await find(item.value).expect(400);
    },
  );

  it('keeps identity lookup available when the company cannot log in', async () => {
    database.db.update(logisticsCompanies).set({ active: false }).run();
    await find(proof().value).expect(200);
  });
  it('allows only one simultaneous consumption', async () => {
    const item = proof();
    const results = await Promise.all([find(item.value), find(item.value)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });
  it('does not hide a database failure or leak sensitive error text', async () => {
    const item = proof();
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    database.connection.exec(
      "CREATE TRIGGER fail_find_email BEFORE UPDATE ON phone_verifications BEGIN SELECT RAISE(ABORT, 'driver@example.com private-proof'); END;",
    );
    expect((await find(item.value).expect(500)).body).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(saved(item.id).consumedAt).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /driver@example.com|private-proof/,
    );
    database.connection.exec('DROP TRIGGER fail_find_email;');
    await find(item.value).expect(200);
  });
  it('documents request, result and failures in Swagger', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const docs = response.body as OpenAPIObject;
    expect(Object.keys(docs.paths[path].post!.responses).sort()).toEqual([
      '200',
      '400',
      '404',
      '500',
    ]);
    expect(docs.components!.schemas!.FindEmailResponseDto).toMatchObject({
      required: ['maskedEmail', 'phoneLastFour'],
    });
  });
});
