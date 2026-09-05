import { createHash, randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import request from 'supertest';
import { App } from 'supertest/types';

import { DatabaseService } from '../src/database/database.service';
import { createTestApp } from './helpers/create-test-app';

type SignUpInput = {
  email: string;
  logisticsCompanyId: string;
  marketingTerms: boolean;
  name: string;
  password: string;
  phone: string;
  privacyTerms: boolean;
  serviceTerms: boolean;
  verificationProof: string;
};

type ErrorResponse = {
  code: string;
  fieldErrors?: Record<string, string[]>;
  message: string;
  statusCode: number;
};

type SwaggerSchema = {
  properties?: Record<string, { description?: string }>;
};

type SwaggerOperation = {
  requestBody?: {
    content: Record<string, { schema: { $ref?: string } }>;
  };
  responses: Record<
    string,
    {
      content?: Record<
        string,
        { schema: { $ref?: string; items?: { $ref?: string } } }
      >;
      description?: string;
    }
  >;
};

const errorMessages: Record<string, string> = {
  EMAIL_ALREADY_EXISTS: '이미 가입된 이메일입니다.',
  LOGISTICS_COMPANY_UNAVAILABLE: '선택할 수 없는 소속입니다.',
  PHONE_ALREADY_EXISTS: '이미 가입된 연락처입니다.',
  PHONE_VERIFICATION_INVALID: '휴대폰 인증이 만료되었거나 유효하지 않습니다.',
  VALIDATION_ERROR: '입력값을 확인해 주세요.',
};

function proofHash(proof: string): string {
  return createHash('sha256').update(proof).digest('hex');
}

function expectKoreanDescriptions(
  properties: Record<string, { description?: string }> | undefined,
  fields: string[],
) {
  for (const field of fields) {
    expect(properties?.[field]?.description).toMatch(/[가-힣]/);
  }
}

describe('Sign up (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let companySequence = 0;

  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
  });

  beforeEach(() => {
    database.connection.exec(`
      DELETE FROM mileage_application_photos;
      DELETE FROM mileage_applications;
      DELETE FROM settlements;
      DELETE FROM password_reset_tokens;
      DELETE FROM users;
      DELETE FROM phone_verifications;
      DELETE FROM logistics_companies;
    `);
  });

  function seedCompany({
    active = true,
    businessName = '(주)경인물류',
    id = randomUUID(),
  }: {
    active?: boolean;
    businessName?: string;
    id?: string;
  } = {}) {
    companySequence += 1;
    database.connection
      .prepare(
        `INSERT INTO logistics_companies (
          id,
          business_name,
          business_number,
          corporate_registration_number,
          business_address,
          manager_name,
          manager_phone,
          bank_code,
          account_number,
          account_holder,
          active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        businessName,
        `${String(companySequence).padStart(3, '0')}-45-67890`,
        `${String(companySequence).padStart(6, '0')}-0012345`,
        '서울시 강남구 역삼동 123',
        '김민수',
        '010-1234-5678',
        '19',
        '110-456-789012',
        '김민수',
        Number(active),
      );

    return { businessName, id };
  }

  function seedVerification({
    consumedAt = null,
    expiresAt = '2099-01-01 00:00:00',
    invalidatedAt = null,
    phone = '010-1234-5678',
    proof = randomUUID(),
    purpose = 'sign_up',
    verifiedAt = '2026-01-01 00:00:00',
  }: {
    consumedAt?: string | null;
    expiresAt?: string;
    invalidatedAt?: string | null;
    phone?: string;
    proof?: string;
    purpose?: string;
    verifiedAt?: string | null;
  } = {}) {
    database.connection
      .prepare(
        `INSERT INTO phone_verifications (
          id,
          purpose,
          phone,
          code_hash,
          proof_hash,
          expires_at,
          verified_at,
          consumed_at,
          invalidated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        purpose,
        phone,
        'verification-code-hash',
        proofHash(proof),
        expiresAt,
        verifiedAt,
        consumedAt,
        invalidatedAt,
      );

    return { proof, proofHash: proofHash(proof) };
  }

  function seedDriver({
    email = 'existing@example.com',
    logisticsCompanyId,
    phone = '010-9999-9999',
  }: {
    email?: string;
    logisticsCompanyId: string;
    phone?: string;
  }) {
    database.connection
      .prepare(
        `INSERT INTO users (
          id,
          role,
          email,
          password_hash,
          name,
          phone,
          logistics_company_id,
          service_terms_consent,
          privacy_terms_consent,
          marketing_consent
        ) VALUES (?, 'driver', ?, ?, ?, ?, ?, 1, 1, 0)`,
      )
      .run(
        randomUUID(),
        email,
        'not-used-by-this-test',
        '기존 기사',
        phone,
        logisticsCompanyId,
      );
  }

  function signUpInput(
    companyId: string,
    overrides: Partial<SignUpInput> = {},
  ): SignUpInput {
    return {
      email: `driver-${randomUUID()}@example.com`,
      logisticsCompanyId: companyId,
      marketingTerms: false,
      name: '홍길동',
      password: 'Password !123',
      phone: '010-1234-5678',
      privacyTerms: true,
      serviceTerms: true,
      verificationProof: randomUUID(),
      ...overrides,
    };
  }

  function expectError(error: ErrorResponse, code: string, statusCode: number) {
    expect(error).toMatchObject({
      code,
      message: errorMessages[code],
      statusCode,
    });
  }

  it('lists only active logistics companies as signup choices in name order', async () => {
    const second = seedCompany({ businessName: '나래물류' });
    const first = seedCompany({ businessName: '가람물류' });
    seedCompany({ active: false, businessName: '비활성물류' });

    await request(app.getHttpServer())
      .get('/api/v1/logistics-companies')
      .expect(200)
      .expect([
        { id: first.id, businessName: first.businessName },
        { id: second.id, businessName: second.businessName },
      ]);
  });

  it('creates a driver, saves its consents, hashes its password, and consumes its proof', async () => {
    const company = seedCompany();
    const verification = seedVerification();
    const input = signUpInput(company.id, {
      verificationProof: verification.proof,
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send(input)
      .expect(201);
    const body = response.body as { id: string };

    expect(Object.keys(body).sort()).toEqual(['id']);
    expect(body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(JSON.stringify(response.body)).not.toContain(input.password);
    expect(JSON.stringify(response.body)).not.toContain(
      input.verificationProof,
    );

    const user = database.connection
      .prepare(
        `SELECT
          role,
          email,
          password_hash AS passwordHash,
          name,
          phone,
          logistics_company_id AS logisticsCompanyId,
          service_terms_consent AS serviceTerms,
          privacy_terms_consent AS privacyTerms,
          marketing_consent AS marketingTerms
        FROM users
        WHERE id = ?`,
      )
      .get(body.id) as {
      email: string;
      logisticsCompanyId: string;
      marketingTerms: number;
      name: string;
      passwordHash: string;
      phone: string;
      privacyTerms: number;
      role: string;
      serviceTerms: number;
    };

    expect(user).toMatchObject({
      email: input.email,
      logisticsCompanyId: input.logisticsCompanyId,
      marketingTerms: 0,
      name: input.name,
      phone: input.phone,
      privacyTerms: 1,
      role: 'driver',
      serviceTerms: 1,
    });
    expect(user.passwordHash).not.toBe(input.password);
    await expect(
      argon2.verify(user.passwordHash, input.password),
    ).resolves.toBe(true);

    const verificationRow = database.connection
      .prepare(
        `SELECT proof_hash AS proofHash, consumed_at AS consumedAt
        FROM phone_verifications
        WHERE proof_hash = ?`,
      )
      .get(verification.proofHash) as {
      consumedAt: string | null;
      proofHash: string;
    };

    expect(verificationRow).toMatchObject({
      proofHash: verification.proofHash,
    });
    expect(verificationRow.consumedAt).toBeTruthy();
  });

  it('rejects malformed and unknown signup fields before persisting a user', async () => {
    const company = seedCompany();
    const verification = seedVerification();
    const input = signUpInput(company.id, {
      email: 'not-an-email',
      logisticsCompanyId: 'not-a-uuid',
      password: 'short',
      verificationProof: verification.proof,
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({
        ...input,
        passwordConfirmation: input.password,
        verificationCode: '123456',
      })
      .expect(400);
    const error = response.body as ErrorResponse;

    expectError(error, 'VALIDATION_ERROR', 400);
    for (const field of [
      'email',
      'logisticsCompanyId',
      'password',
      'passwordConfirmation',
      'verificationCode',
    ]) {
      expect(error.fieldErrors?.[field]).toBeDefined();
    }
    expect(
      database.connection.prepare('SELECT COUNT(*) AS count FROM users').get(),
    ).toEqual({ count: 0 });
    expect(
      database.connection
        .prepare(
          'SELECT consumed_at AS consumedAt FROM phone_verifications WHERE proof_hash = ?',
        )
        .get(verification.proofHash),
    ).toEqual({ consumedAt: null });
  });

  it('requires a complete password and both mandatory terms', async () => {
    const company = seedCompany();
    const cases: { field: string; input: Partial<SignUpInput> }[] = [
      { field: 'password', input: { password: 'Password' } },
      { field: 'serviceTerms', input: { serviceTerms: false } },
      { field: 'privacyTerms', input: { privacyTerms: false } },
    ];

    for (const { field, input } of cases) {
      const verification = seedVerification();
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/signup')
        .send(
          signUpInput(company.id, {
            ...input,
            verificationProof: verification.proof,
          }),
        )
        .expect(400);
      const error = response.body as ErrorResponse;

      expectError(error, 'VALIDATION_ERROR', 400);
      expect(error.fieldErrors?.[field]).toBeDefined();
      expect(
        database.connection
          .prepare('SELECT COUNT(*) AS count FROM users')
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database.connection
          .prepare(
            'SELECT consumed_at AS consumedAt FROM phone_verifications WHERE proof_hash = ?',
          )
          .get(verification.proofHash),
      ).toEqual({ consumedAt: null });
    }
  });

  it('rejects inactive and missing logistics companies', async () => {
    const inactiveCompany = seedCompany({ active: false });

    for (const companyId of [inactiveCompany.id, randomUUID()]) {
      const verification = seedVerification();
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/signup')
        .send(
          signUpInput(companyId, {
            verificationProof: verification.proof,
          }),
        )
        .expect(400);

      expectError(
        response.body as ErrorResponse,
        'LOGISTICS_COMPANY_UNAVAILABLE',
        400,
      );
      expect(
        database.connection
          .prepare(
            'SELECT consumed_at AS consumedAt FROM phone_verifications WHERE proof_hash = ?',
          )
          .get(verification.proofHash),
      ).toEqual({ consumedAt: null });
    }
  });

  it('releases a proof after a correctable signup failure', async () => {
    const inactiveCompany = seedCompany({ active: false });
    const activeCompany = seedCompany();
    const verification = seedVerification();
    const input = signUpInput(inactiveCompany.id, {
      verificationProof: verification.proof,
    });

    await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send(input)
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({ ...input, logisticsCompanyId: activeCompany.id })
      .expect(201);
  });

  it('rejects unavailable, expired, phone-mismatched, and already-used proofs', async () => {
    const company = seedCompany();
    const expired = seedVerification({ expiresAt: '2000-01-01 00:00:00' });
    const phoneMismatched = seedVerification({ phone: '010-9999-9999' });
    const consumed = seedVerification({ consumedAt: '2026-01-02 00:00:00' });
    const wrongPurpose = seedVerification({ purpose: 'find_email' });
    const unverified = seedVerification({ verifiedAt: null });
    const invalidated = seedVerification({
      invalidatedAt: '2026-01-02 00:00:00',
    });
    const proofs = [
      randomUUID(),
      expired.proof,
      phoneMismatched.proof,
      consumed.proof,
      wrongPurpose.proof,
      unverified.proof,
      invalidated.proof,
    ];

    for (const proof of proofs) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/signup')
        .send(signUpInput(company.id, { verificationProof: proof }))
        .expect(400);

      expectError(
        response.body as ErrorResponse,
        'PHONE_VERIFICATION_INVALID',
        400,
      );
      expect(
        database.connection
          .prepare('SELECT COUNT(*) AS count FROM users')
          .get(),
      ).toEqual({ count: 0 });
    }
  });

  it('returns conflicts for an existing email or phone', async () => {
    const company = seedCompany();
    seedDriver({
      email: 'existing-email@example.com',
      logisticsCompanyId: company.id,
      phone: '010-9999-9999',
    });
    const emailVerification = seedVerification({ phone: '010-1111-1111' });
    const phoneVerification = seedVerification({ phone: '010-9999-9999' });
    const emailConflict = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send(
        signUpInput(company.id, {
          email: 'EXISTING-EMAIL@EXAMPLE.COM',
          phone: '010-1111-1111',
          verificationProof: emailVerification.proof,
        }),
      )
      .expect(409);
    const phoneConflict = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send(
        signUpInput(company.id, {
          phone: '010-9999-9999',
          verificationProof: phoneVerification.proof,
        }),
      )
      .expect(409);

    expectError(
      emailConflict.body as ErrorResponse,
      'EMAIL_ALREADY_EXISTS',
      409,
    );
    expectError(
      phoneConflict.body as ErrorResponse,
      'PHONE_ALREADY_EXISTS',
      409,
    );
    expect(
      database.connection
        .prepare(
          'SELECT consumed_at AS consumedAt FROM phone_verifications WHERE proof_hash = ?',
        )
        .get(emailVerification.proofHash),
    ).toEqual({ consumedAt: null });
    expect(
      database.connection
        .prepare(
          'SELECT consumed_at AS consumedAt FROM phone_verifications WHERE proof_hash = ?',
        )
        .get(phoneVerification.proofHash),
    ).toEqual({ consumedAt: null });
    expect(
      database.connection.prepare('SELECT COUNT(*) AS count FROM users').get(),
    ).toEqual({ count: 1 });
  });

  it('allows only one concurrent signup to consume a proof', async () => {
    const company = seedCompany();
    const verification = seedVerification();
    const input = signUpInput(company.id, {
      verificationProof: verification.proof,
    });

    const responses = await Promise.all([
      request(app.getHttpServer()).post('/api/v1/auth/signup').send(input),
      request(app.getHttpServer())
        .post('/api/v1/auth/signup')
        .send({ ...input, email: `concurrent-${randomUUID()}@example.com` }),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    const rejected = responses.find((response) => response.status === 400);

    expect(statuses).toEqual([201, 400]);
    expectError(
      rejected?.body as ErrorResponse,
      'PHONE_VERIFICATION_INVALID',
      400,
    );
    expect(
      database.connection.prepare('SELECT COUNT(*) AS count FROM users').get(),
    ).toEqual({ count: 1 });
    const storedProof = database.connection
      .prepare(
        'SELECT consumed_at AS consumedAt FROM phone_verifications WHERE proof_hash = ?',
      )
      .get(verification.proofHash) as { consumedAt: string | null };

    expect(typeof storedProof.consumedAt).toBe('string');
  });

  it('makes a successful signup proof unusable for the next signup', async () => {
    const company = seedCompany();
    const verification = seedVerification();
    const input = signUpInput(company.id, {
      verificationProof: verification.proof,
    });

    await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send(input)
      .expect(201);

    const replay = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({ ...input, email: `replay-${randomUUID()}@example.com` })
      .expect(400);

    expectError(
      replay.body as ErrorResponse,
      'PHONE_VERIFICATION_INVALID',
      400,
    );
    expect(
      database.connection.prepare('SELECT COUNT(*) AS count FROM users').get(),
    ).toEqual({ count: 1 });
  });

  it('documents public choices and signup without exposing password fields', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = response.body as {
      components: { schemas: Record<string, SwaggerSchema> };
      paths: Record<string, Record<string, SwaggerOperation>>;
    };
    const choices = document.paths['/api/v1/logistics-companies'];
    const signup = document.paths['/api/v1/auth/signup'];

    expect(Object.keys(choices)).toEqual(['get']);
    expect(Object.keys(signup)).toEqual(['post']);
    expect(Object.keys(choices.get.responses)).toEqual(['200']);
    expect(Object.keys(signup.post.responses).sort()).toEqual([
      '201',
      '400',
      '409',
    ]);
    expect(signup.post.responses['400'].description).toBe(
      'VALIDATION_ERROR | PHONE_VERIFICATION_INVALID | LOGISTICS_COMPANY_UNAVAILABLE',
    );
    expect(signup.post.responses['409'].description).toBe(
      'EMAIL_ALREADY_EXISTS | PHONE_ALREADY_EXISTS',
    );

    const choicesSchemaReference =
      choices.get.responses['200'].content?.['application/json'].schema.items
        ?.$ref;
    const signupRequestReference =
      signup.post.requestBody?.content['application/json'].schema.$ref;
    const signupResponseReference =
      signup.post.responses['201'].content?.['application/json'].schema.$ref;
    const schemaFromReference = (reference: string | undefined) =>
      reference
        ? document.components.schemas[reference.split('/').at(-1)!]
        : undefined;
    const choicesSchema = schemaFromReference(choicesSchemaReference);
    const signupRequestSchema = schemaFromReference(signupRequestReference);
    const signupResponseSchema = schemaFromReference(signupResponseReference);

    expectKoreanDescriptions(choicesSchema?.properties, ['businessName', 'id']);
    expectKoreanDescriptions(signupRequestSchema?.properties, [
      'email',
      'logisticsCompanyId',
      'marketingTerms',
      'name',
      'password',
      'phone',
      'privacyTerms',
      'serviceTerms',
      'verificationProof',
    ]);
    expect(Object.keys(signupRequestSchema?.properties ?? {}).sort()).toEqual([
      'email',
      'logisticsCompanyId',
      'marketingTerms',
      'name',
      'password',
      'phone',
      'privacyTerms',
      'serviceTerms',
      'verificationProof',
    ]);
    expectKoreanDescriptions(signupResponseSchema?.properties, ['id']);
    expect(signupResponseSchema?.properties).not.toHaveProperty('password');
    expect(signupResponseSchema?.properties).not.toHaveProperty('passwordHash');
  });

  afterAll(async () => {
    await app.close();
  });
});
