import { createHash, createHmac, randomUUID } from 'node:crypto';

import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import { DatabaseService } from '../src/database/database.service';
import { createTestApp } from './helpers/create-test-app';

const phone = '010-1234-5678';
const secret = 'test-only-phone-verification-secret-32-bytes';
const basePath = '/api/v1/auth/phone-verifications';
const accepted = {
  failedMessageList: [],
  messageList: [{ messageId: 'test-message-id', statusCode: '2000' }],
};

type SentVerification = { verificationId: string; expiresAt: string };
type ConfirmedVerification = { verificationProof: string; expiresAt: string };
type VerificationRow = {
  id: string;
  phone: string;
  purpose: string;
  code_hash: string;
  proof_hash: string | null;
  expires_at: string;
  verified_at: string | null;
  consumed_at: string | null;
  invalidated_at: string | null;
};

describe('SOLAPI phone verification (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
  });

  beforeEach(() => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      SOLAPI_API_KEY: 'test-api-key',
      SOLAPI_API_SECRET: 'test-api-secret',
      SOLAPI_SENDER_PHONE: '0212345678',
      PHONE_VERIFICATION_SECRET: secret,
    });
    // Only the paid external HTTP boundary is mocked; Nest, crypto and DB stay real.
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(Response.json(accepted)));
    database.connection.exec(`
      DELETE FROM users;
      DELETE FROM phone_verifications;
      DELETE FROM logistics_companies;
    `);
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => app.close());

  function sentMessage(index = fetchMock.mock.calls.length - 1) {
    return (
      JSON.parse(fetchMock.mock.calls[index][1]?.body as string) as {
        messages: { to: string; from: string; text: string; type: string }[];
      }
    ).messages[0];
  }

  function sentCode(index?: number): string {
    const match = sentMessage(index).text.match(/\[(\d{6})\]/);
    expect(match).not.toBeNull();
    return match![1];
  }

  function row(id: string): VerificationRow {
    return database.connection
      .prepare('SELECT * FROM phone_verifications WHERE id = ?')
      .get(id) as VerificationRow;
  }

  async function send(to = phone): Promise<SentVerification> {
    const response = await request(app.getHttpServer())
      .post(basePath)
      .send({ phone: to })
      .expect('Cache-Control', 'no-store')
      .expect(201);
    return response.body as SentVerification;
  }

  function confirm(id: string, code: unknown) {
    return request(app.getHttpServer())
      .post(`${basePath}/${id}/confirm`)
      .send({ code });
  }

  function signUp(proof: string, companyId = randomUUID(), withPhone = phone) {
    return request(app.getHttpServer()).post('/api/v1/auth/signup').send({
      email: 'driver@example.com',
      password: 'Password!123',
      logisticsCompanyId: companyId,
      name: '홍길동',
      phone: withPhone,
      verificationProof: proof,
      serviceTerms: true,
      privacyTerms: true,
      marketingTerms: false,
    });
  }

  it.each(['find_email', 'reset_password'])(
    'binds %s proofs to their purpose and input, never signup',
    async (purpose) => {
      const input = {
        phone,
        purpose,
        ...(purpose === 'reset_password'
          ? { email: ' Driver@Example.com ' }
          : {}),
      };
      const sent = await request(app.getHttpServer())
        .post(basePath)
        .send(input)
        .expect(201);
      const id = (sent.body as SentVerification).verificationId;
      const code = sentCode();
      await confirm(id, code).expect(400);
      const result = await request(app.getHttpServer())
        .post(`${basePath}/${id}/confirm`)
        .send({ code, purpose })
        .expect(200);
      expect(row(id)).toMatchObject({
        purpose,
        phone,
        scope_email: purpose === 'reset_password' ? 'driver@example.com' : null,
      });
      await signUp((result.body as ConfirmedVerification).verificationProof)
        .expect(400)
        .expect(({ body }: { body: { code: string } }) =>
          expect(body.code).toBe('PHONE_VERIFICATION_INVALID'),
        );
      expect(row(id).consumed_at).toBeNull();
      await request(app.getHttpServer())
        .post(`${basePath}/${id}/confirm`)
        .send({ code, purpose })
        .expect(400);
    },
  );

  it('invalidates the previous reset scope when its email changes without invalidating signup', async () => {
    const signup = await send();
    const signupCode = sentCode();
    const first = await request(app.getHttpServer())
      .post(basePath)
      .send({ phone, purpose: 'reset_password', email: 'first@example.com' })
      .expect(201);
    const firstId = (first.body as SentVerification).verificationId;
    const code = sentCode();
    await request(app.getHttpServer())
      .post(`${basePath}/${firstId}/confirm`)
      .send({ code, purpose: 'reset_password' })
      .expect(200);
    await request(app.getHttpServer())
      .post(basePath)
      .send({ phone, purpose: 'reset_password', email: 'second@example.com' })
      .expect(201);
    expect(row(firstId).invalidated_at).not.toBeNull();
    await confirm(signup.verificationId, signupCode).expect(200);
  });

  it.each([
    { phone, purpose: null },
    { phone, purpose: 'change_phone' },
    { phone, purpose: 'reset_password' },
    { phone, purpose: 'reset_password', email: null },
    { phone, purpose: 'reset_password', email: 'invalid' },
    { phone, purpose: 'find_email', email: 'driver@example.com' },
    { phone, email: 'driver@example.com' },
    { phone, scopeUserId: randomUUID() },
  ])('rejects mismatched public authentication inputs: %j', async (input) => {
    await request(app.getHttpServer()).post(basePath).send(input).expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs one SMS request, stores only its HMAC and starts a 3-minute expiry after acceptance', async () => {
    const sent = await send(` ${phone} `);
    const code = sentCode();
    const verification = row(sent.verificationId);
    expect(Object.keys(sent).sort()).toEqual(['expiresAt', 'verificationId']);
    expect(Date.parse(sent.expiresAt) - Date.now()).toBeGreaterThan(178_000);
    expect(Date.parse(sent.expiresAt) - Date.now()).toBeLessThanOrEqual(
      180_000,
    );
    expect(verification).toMatchObject({
      purpose: 'sign_up',
      phone,
      code_hash: createHmac('sha256', secret)
        .update(`sign_up:${sent.verificationId}:${code}`)
        .digest('hex'),
      proof_hash: null,
      verified_at: null,
      consumed_at: null,
      invalidated_at: null,
    });
    expect(verification.code_hash).not.toBe(code);

    const [url, options] = fetchMock.mock.calls[0];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url).toBe('https://api.solapi.com/messages/v4/send-many/detail');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options?.body as string)).toMatchObject({
      messages: [
        {
          to: '01012345678',
          from: '0212345678',
          type: 'SMS',
          autoTypeDetect: false,
        },
      ],
      showMessageList: true,
    });
    expect(Buffer.byteLength(sentMessage().text)).toBeLessThanOrEqual(90);
    const authorization = new Headers(options?.headers).get('Authorization');
    const parts = authorization?.match(
      /^HMAC-SHA256 apiKey=test-api-key, date=(.+), salt=([a-f0-9]{32}), signature=([a-f0-9]{64})$/,
    );
    expect(parts).toBeTruthy();
    expect(parts![3]).toBe(
      createHmac('sha256', 'test-api-secret')
        .update(parts![1] + parts![2])
        .digest('hex'),
    );
    expect(authorization).not.toContain('test-api-secret');
  });

  it('issues a phone-bound proof once, consumes it at signup and rejects replay', async () => {
    const sent = await send();
    const code = sentCode();
    const response = await confirm(sent.verificationId, code)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    const confirmed = response.body as ConfirmedVerification;
    expect(Object.keys(confirmed).sort()).toEqual([
      'expiresAt',
      'verificationProof',
    ]);
    expect(confirmed.expiresAt).toBe(sent.expiresAt);
    expect(confirmed.verificationProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row(sent.verificationId).proof_hash).toBe(
      createHash('sha256').update(confirmed.verificationProof).digest('hex'),
    );
    await confirm(sent.verificationId, code).expect(400);

    const companyId = randomUUID();
    database.connection
      .prepare(
        `
      INSERT INTO logistics_companies (
        id, business_name, business_number, corporate_registration_number,
        business_address, manager_name, manager_phone, bank_code,
        account_number, account_holder
      ) VALUES (?, '테스트물류', '123-45-67890', '123456-1234567',
        '서울시 강남구', '김관리', '010-9876-5432', '19', '12345678', '테스트물류')
    `,
      )
      .run(companyId);
    await signUp(confirmed.verificationProof, companyId, '010-1111-2222')
      .expect(400)
      .expect(({ body }: { body: { code: string } }) =>
        expect(body.code).toBe('PHONE_VERIFICATION_INVALID'),
      );
    expect(row(sent.verificationId).consumed_at).toBeNull();
    await signUp(confirmed.verificationProof, companyId).expect(201);
    expect(row(sent.verificationId).consumed_at).not.toBeNull();
    await signUp(confirmed.verificationProof, companyId).expect(400);
    await send();
    expect(row(sent.verificationId).invalidated_at).toBeNull();
  });

  it('allows correcting a wrong code without minting a proof or adding an attempt limit', async () => {
    const sent = await send();
    const code = sentCode();
    const wrongCode = code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await confirm(sent.verificationId, wrongCode)
        .expect(400)
        .expect(({ body }: { body: { code: string } }) =>
          expect(body.code).toBe('PHONE_VERIFICATION_CODE_MISMATCH'),
        );
    }
    expect(row(sent.verificationId).proof_hash).toBeNull();
    await confirm(sent.verificationId, code).expect(200);
  });

  it('issues only one proof when two confirmation requests race', async () => {
    const sent = await send();
    const code = sentCode();
    const results = await Promise.all([
      confirm(sent.verificationId, code),
      confirm(sent.verificationId, code),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    const success = results.find((result) => result.status === 200)!;
    const { verificationProof } = success.body as ConfirmedVerification;
    expect(row(sent.verificationId).proof_hash).toBe(
      createHash('sha256').update(verificationProof).digest('hex'),
    );
  });

  it('preserves leading zeroes in a six-digit code', async () => {
    const sent = await send();
    const code = '000012';
    const hash = createHmac('sha256', secret)
      .update(`sign_up:${sent.verificationId}:${code}`)
      .digest('hex');
    database.connection
      .prepare('UPDATE phone_verifications SET code_hash = ? WHERE id = ?')
      .run(hash, sent.verificationId);
    await confirm(sent.verificationId, code).expect(200);
  });

  it.each([
    'expires_at = CURRENT_TIMESTAMP',
    'invalidated_at = CURRENT_TIMESTAMP',
    'consumed_at = CURRENT_TIMESTAMP',
    "purpose = 'find_email'",
  ])('rejects an unavailable verification (%s)', async (assignment) => {
    const sent = await send();
    // assignment is a fixed test case above, never user input.
    database.connection
      .prepare(`UPDATE phone_verifications SET ${assignment} WHERE id = ?`)
      .run(sent.verificationId);
    await confirm(sent.verificationId, sentCode())
      .expect(400)
      .expect(({ body }: { body: { code: string } }) =>
        expect(body.code).toBe('PHONE_VERIFICATION_INVALID'),
      );
    expect(row(sent.verificationId).proof_hash).toBeNull();
  });

  it('does not extend a confirmed proof past the original expiry', async () => {
    const sent = await send();
    const confirmed = (
      await confirm(sent.verificationId, sentCode()).expect(200)
    ).body as ConfirmedVerification;
    database.connection
      .prepare(
        'UPDATE phone_verifications SET expires_at = CURRENT_TIMESTAMP WHERE id = ?',
      )
      .run(sent.verificationId);
    await signUp(confirmed.verificationProof)
      .expect(400)
      .expect(({ body }: { body: { code: string } }) =>
        expect(body.code).toBe('PHONE_VERIFICATION_INVALID'),
      );
  });

  it('invalidates the previous code on resend while keeping other phones separate', async () => {
    const first = await send();
    const firstCode = sentCode();
    const other = await send('010-9999-8888');
    const otherCode = sentCode();
    const latest = await send();
    await confirm(first.verificationId, firstCode).expect(400);
    await confirm(latest.verificationId, sentCode()).expect(200);
    await confirm(other.verificationId, otherCode).expect(200);
  });

  it('keeps previous proofs invalidated even when the resend fails', async () => {
    const sent = await send();
    const confirmed = (
      await confirm(sent.verificationId, sentCode()).expect(200)
    ).body as ConfirmedVerification;
    fetchMock.mockRejectedValueOnce(new Error('private provider failure'));
    await request(app.getHttpServer())
      .post(basePath)
      .send({ phone })
      .expect(502);
    expect(row(sent.verificationId).invalidated_at).not.toBeNull();
    await signUp(confirmed.verificationProof)
      .expect(400)
      .expect(({ body }: { body: { code: string } }) =>
        expect(body.code).toBe('PHONE_VERIFICATION_INVALID'),
      );
    await send();
  });

  it('never activates a pending or superseded send when provider responses arrive out of order', async () => {
    let entered!: () => void;
    let finishFirst!: (response: Response) => void;
    const providerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fetchMock.mockImplementationOnce(() => {
      entered();
      return new Promise<Response>((resolve) => {
        finishFirst = resolve;
      });
    });
    const first = request(app.getHttpServer())
      .post(basePath)
      .send({ phone })
      .then((response) => response);
    await providerEntered;
    try {
      const pending = database.connection
        .prepare('SELECT * FROM phone_verifications')
        .get() as VerificationRow;
      const firstCode = sentCode();
      expect(pending.expires_at).toBe('1970-01-01 00:00:00');
      await confirm(pending.id, firstCode).expect(400);
      const latest = await send();
      const latestCode = sentCode();
      finishFirst(Response.json(accepted));
      const superseded = await first;
      expect(superseded.status).toBe(409);
      expect(superseded.body).toMatchObject({
        code: 'PHONE_VERIFICATION_SUPERSEDED',
      });
      await confirm(pending.id, firstCode).expect(400);
      await confirm(latest.verificationId, latestCode).expect(200);
    } finally {
      finishFirst(Response.json(accepted));
      await first;
    }
  });

  it.each([
    {
      name: 'HTTP failure',
      status: 403,
      body: { error: 'private provider failure' },
    },
    {
      name: 'rejected message in HTTP 200',
      body: {
        failedMessageList: [{ statusCode: '3040' }],
        messageList: accepted.messageList,
      },
    },
    {
      name: 'unsuccessful status',
      body: {
        failedMessageList: [],
        messageList: [{ messageId: 'test-id', statusCode: '4000' }],
      },
    },
    {
      name: 'missing message identifier',
      body: { failedMessageList: [], messageList: [{ statusCode: '2000' }] },
    },
    {
      name: 'empty message list',
      body: { failedMessageList: [], messageList: [] },
    },
    {
      name: 'missing failure list',
      body: { messageList: accepted.messageList },
    },
    { name: 'null response', body: null },
  ])(
    'does not issue an active code on $name or expose provider details',
    async ({ body, status = 200 }) => {
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      fetchMock.mockResolvedValueOnce(Response.json(body, { status }));
      await request(app.getHttpServer())
        .post(basePath)
        .send({ phone })
        .expect(502)
        .expect({
          statusCode: 502,
          code: 'SMS_SEND_FAILED',
          message: '인증번호 발송을 확인하지 못했습니다. 다시 요청해 주세요.',
        });
      const failed = database.connection
        .prepare('SELECT * FROM phone_verifications')
        .get() as VerificationRow;
      expect(failed.proof_hash).toBeNull();
      await confirm(failed.id, sentCode()).expect(400);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    },
  );

  it.each(['invalid JSON', 'network timeout'])(
    'fails closed on %s without retrying',
    async (failure) => {
      if (failure === 'invalid JSON') {
        fetchMock.mockResolvedValueOnce(new Response('not JSON'));
      } else {
        fetchMock.mockRejectedValueOnce(
          new DOMException('private timeout details', 'TimeoutError'),
        );
      }
      await request(app.getHttpServer())
        .post(basePath)
        .send({ phone })
        .expect(502);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const failed = database.connection
        .prepare('SELECT * FROM phone_verifications')
        .get() as VerificationRow;
      await confirm(failed.id, sentCode()).expect(400);
    },
  );

  it.each([
    'SOLAPI_API_KEY',
    'SOLAPI_API_SECRET',
    'SOLAPI_SENDER_PHONE',
    'PHONE_VERIFICATION_SECRET',
  ])('rejects missing %s instead of reporting success', async (key) => {
    delete process.env[key];
    await request(app.getHttpServer())
      .post(basePath)
      .send({ phone })
      .expect(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a weak OTP secret and an invalid sender configuration', async () => {
    process.env.PHONE_VERIFICATION_SECRET = 'short';
    await request(app.getHttpServer())
      .post(basePath)
      .send({ phone })
      .expect(503);
    process.env.PHONE_VERIFICATION_SECRET = secret;
    process.env.SOLAPI_SENDER_PHONE = 'invalid';
    await request(app.getHttpServer())
      .post(basePath)
      .send({ phone })
      .expect(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates recipient, code, identifier and rejects unimplemented purposes and client overrides', async () => {
    for (const input of [
      {},
      { phone: '01012345678' },
      { phone: 1012345678 },
      { phone, purpose: 'reset_password' },
      { phone, from: '0211112222', text: 'client content' },
    ]) {
      await request(app.getHttpServer()).post(basePath).send(input).expect(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    for (const code of [
      '12345',
      '1234567',
      'abcdef',
      123456,
      null,
      ' 123456 ',
    ]) {
      await confirm(randomUUID(), code).expect(400);
    }
    await confirm('not-a-uuid', '123456').expect(400);
    await confirm(randomUUID(), '123456').expect(400);
  });

  it('documents both endpoints, failures and Korean DTO field descriptions in Swagger', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = response.body as {
      paths: Record<
        string,
        {
          post: {
            responses: Record<string, unknown>;
            parameters?: { name: string }[];
          };
        }
      >;
      components: {
        schemas: Record<
          string,
          { properties: Record<string, { description: string }> }
        >;
      };
    };
    expect(Object.keys(document.paths[basePath].post.responses).sort()).toEqual(
      ['201', '400', '409', '502', '503'],
    );
    const confirmation =
      document.paths[`${basePath}/{verificationId}/confirm`].post;
    expect(Object.keys(confirmation.responses).sort()).toEqual([
      '200',
      '400',
      '503',
    ]);
    expect(confirmation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'verificationId' }),
      ]),
    );
    for (const name of [
      'SendPhoneVerificationRequestDto',
      'SendPhoneVerificationResponseDto',
      'ConfirmPhoneVerificationRequestDto',
      'ConfirmPhoneVerificationResponseDto',
    ]) {
      for (const property of Object.values(
        document.components.schemas[name].properties,
      )) {
        expect(property.description).toMatch(/[가-힣]/);
      }
    }
  });
});
