import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import { DatabaseService } from '../src/database/database.service';
import { createTestApp } from './helpers/create-test-app';

const companyInput = {
  accountHolder: '김민수',
  accountNumber: '110-456-789012',
  bankCode: '19',
  businessAddress: '서울시 강남구 역삼동 123',
  businessName: '(주)경인물류',
  businessNumber: '123-45-67890',
  corporateRegistrationNumber: '110111-0012345',
  managerName: '김민수',
  managerPhone: '010-1234-5678',
};

type CompanyResponse = typeof companyInput & {
  active: boolean;
  createdAt: string;
  id: string;
  updatedAt: string;
};

type ErrorResponse = {
  code: string;
  fieldErrors?: Record<string, string[]>;
  message: string;
  statusCode: number;
};

const companyResponseKeys = [
  'accountHolder',
  'accountNumber',
  'active',
  'bankCode',
  'businessAddress',
  'businessName',
  'businessNumber',
  'corporateRegistrationNumber',
  'createdAt',
  'id',
  'managerName',
  'managerPhone',
  'updatedAt',
];

function expectCompanyResponse(
  company: CompanyResponse,
  expected: typeof companyInput & { id?: string },
) {
  expect(company).toMatchObject({ ...expected, active: true });
  expect(Object.keys(company).sort()).toEqual(companyResponseKeys);
  expect(company.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(company.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(company.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
}

describe('Logistics companies (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;

  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
  });

  beforeEach(() => {
    database.connection.exec('DELETE FROM logistics_companies');
  });

  function seedCompany(
    overrides: Partial<typeof companyInput> & {
      active?: boolean;
      id?: string;
    } = {},
  ) {
    const company = {
      ...companyInput,
      ...overrides,
      active: overrides.active ?? true,
      id: overrides.id ?? randomUUID(),
    };

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
        company.id,
        company.businessName,
        company.businessNumber,
        company.corporateRegistrationNumber,
        company.businessAddress,
        company.managerName,
        company.managerPhone,
        company.bankCode,
        company.accountNumber,
        company.accountHolder,
        Number(company.active),
      );

    return company;
  }

  it('creates, reads, replaces, and soft-deletes a logistics company', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/api/v1/admin/logistics-companies')
      .send({
        ...companyInput,
        businessName: `  ${companyInput.businessName}  `,
      })
      .expect(201);
    const createdCompany = createResponse.body as CompanyResponse;

    expectCompanyResponse(createdCompany, companyInput);

    const { id } = createdCompany;

    await request(app.getHttpServer())
      .get(`/api/v1/admin/logistics-companies/${id}`)
      .expect(200)
      .expect(createdCompany);

    const updatedInput = {
      ...companyInput,
      accountHolder: '(주)경인물류',
      managerName: '이영희',
    };
    database.connection
      .prepare(
        "UPDATE logistics_companies SET updated_at = '2000-01-01 00:00:00' WHERE id = ?",
      )
      .run(id);
    const updateResponse = await request(app.getHttpServer())
      .put(`/api/v1/admin/logistics-companies/${id}`)
      .send(updatedInput)
      .expect(200);
    const updatedCompany = updateResponse.body as CompanyResponse;

    expectCompanyResponse(updatedCompany, { ...updatedInput, id });
    expect(updatedCompany.createdAt).toBe(createdCompany.createdAt);
    expect(updatedCompany.updatedAt).not.toBe('2000-01-01T00:00:00Z');

    await request(app.getHttpServer())
      .delete(`/api/v1/admin/logistics-companies/${id}`)
      .expect(204)
      .expect('');

    const storedCompany = database.connection
      .prepare('SELECT active FROM logistics_companies WHERE id = ?')
      .get(id) as { active: number };

    expect(storedCompany.active).toBe(0);
    await request(app.getHttpServer())
      .get(`/api/v1/admin/logistics-companies/${id}`)
      .expect(404)
      .expect({
        code: 'LOGISTICS_COMPANY_NOT_FOUND',
        message: '물류사를 찾을 수 없습니다.',
        statusCode: 404,
      });
    await request(app.getHttpServer())
      .put(`/api/v1/admin/logistics-companies/${id}`)
      .send(updatedInput)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/admin/logistics-companies')
      .expect(200)
      .expect([]);
    await request(app.getHttpServer())
      .delete(`/api/v1/admin/logistics-companies/${id}`)
      .expect(404);
    expect(
      database.connection
        .prepare('SELECT active FROM logistics_companies WHERE id = ?')
        .get(id),
    ).toEqual({ active: 0 });
  });

  it('lists only active companies in business-name order', async () => {
    const second = seedCompany({
      businessName: '나래물류',
      businessNumber: '234-56-78901',
      corporateRegistrationNumber: '110111-0023456',
    });
    const first = seedCompany({
      businessName: '가람물류',
      businessNumber: '345-67-89012',
      corporateRegistrationNumber: '110111-0034567',
    });
    seedCompany({
      active: false,
      businessName: '비활성물류',
      businessNumber: '456-78-90123',
      corporateRegistrationNumber: '110111-0045678',
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/logistics-companies')
      .expect(200);
    const companies = response.body as CompanyResponse[];

    expect(companies.map((company) => company.id)).toEqual([
      first.id,
      second.id,
    ]);
    expectCompanyResponse(companies[0], { ...first, id: first.id });
    expectCompanyResponse(companies[1], { ...second, id: second.id });
  });

  it('rejects invalid and unknown fields', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/logistics-companies')
      .send({
        ...companyInput,
        accountNumber: '계좌번호',
        active: false,
        bankCode: '999',
        businessAddress: '온라인 전용',
        businessName: '   ',
        businessNumber: '1234567890',
        corporateRegistrationNumber: '1101110012345',
        accountHolder: '   ',
        managerName: '   ',
        managerPhone: '02-123-4567',
      })
      .expect(400);
    const error = response.body as ErrorResponse;

    expect(error).toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    for (const field of [
      'accountNumber',
      'active',
      'bankCode',
      'businessAddress',
      'businessName',
      'businessNumber',
      'corporateRegistrationNumber',
      'accountHolder',
      'managerName',
      'managerPhone',
    ]) {
      expect(error.fieldErrors?.[field]).toBeDefined();
    }

    const tooLongResponse = await request(app.getHttpServer())
      .post('/api/v1/admin/logistics-companies')
      .send({
        ...companyInput,
        accountHolder: '가'.repeat(101),
        accountNumber: '1'.repeat(51),
        businessAddress: `${'가'.repeat(200)}시`,
        businessName: '가'.repeat(101),
        managerName: '가'.repeat(101),
      })
      .expect(400);
    const tooLongError = tooLongResponse.body as ErrorResponse;

    for (const field of [
      'accountHolder',
      'accountNumber',
      'businessAddress',
      'businessName',
      'managerName',
    ]) {
      expect(tooLongError.fieldErrors?.[field]).toBeDefined();
    }
  });

  it('returns conflict for duplicate business identifiers', async () => {
    seedCompany({ active: false });

    const duplicateBusinessNumber = await request(app.getHttpServer())
      .post('/api/v1/admin/logistics-companies')
      .send({
        ...companyInput,
        corporateRegistrationNumber: '110111-0099999',
      })
      .expect(409);
    const duplicateError = duplicateBusinessNumber.body as ErrorResponse;

    expect(duplicateError).toEqual({
      code: 'LOGISTICS_COMPANY_DUPLICATE',
      message: '이미 등록된 사업자 정보입니다.',
      statusCode: 409,
    });

    await request(app.getHttpServer())
      .post('/api/v1/admin/logistics-companies')
      .send({
        ...companyInput,
        businessNumber: '999-99-99999',
      })
      .expect(409)
      .expect(duplicateError);
  });

  it('does not overwrite a company with duplicate identifiers', async () => {
    const first = seedCompany();
    const second = seedCompany({
      businessName: '대한물류',
      businessNumber: '234-56-78901',
      corporateRegistrationNumber: '110111-0023456',
    });

    await request(app.getHttpServer())
      .put(`/api/v1/admin/logistics-companies/${first.id}`)
      .send({ ...companyInput, businessNumber: second.businessNumber })
      .expect(409);

    await request(app.getHttpServer())
      .put(`/api/v1/admin/logistics-companies/${first.id}`)
      .send({
        ...companyInput,
        corporateRegistrationNumber: second.corporateRegistrationNumber,
      })
      .expect(409);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/logistics-companies/${first.id}`)
      .expect(200);

    expect(response.body as CompanyResponse).toMatchObject(companyInput);
  });

  it('returns not found for missing resources and rejects malformed ids', async () => {
    const missingId = '00000000-0000-4000-8000-000000000000';
    const notFoundResponse = await request(app.getHttpServer())
      .get(`/api/v1/admin/logistics-companies/${missingId}`)
      .expect(404)
      .expect({
        code: 'LOGISTICS_COMPANY_NOT_FOUND',
        message: '물류사를 찾을 수 없습니다.',
        statusCode: 404,
      });
    const notFoundError = notFoundResponse.body as ErrorResponse;

    await request(app.getHttpServer())
      .put(`/api/v1/admin/logistics-companies/${missingId}`)
      .send(companyInput)
      .expect(404)
      .expect(notFoundError);
    await request(app.getHttpServer())
      .delete(`/api/v1/admin/logistics-companies/${missingId}`)
      .expect(404)
      .expect(notFoundError);

    await request(app.getHttpServer())
      .get('/api/v1/admin/logistics-companies/not-a-uuid')
      .expect(400);
    await request(app.getHttpServer())
      .put('/api/v1/admin/logistics-companies/not-a-uuid')
      .send(companyInput)
      .expect(400);
    await request(app.getHttpServer())
      .delete('/api/v1/admin/logistics-companies/not-a-uuid')
      .expect(400);
  });

  it('documents the CRUD contract in Swagger', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = response.body as {
      components: {
        schemas: Record<
          string,
          {
            properties?: Record<
              string,
              { description?: string; enum?: string[] }
            >;
          }
        >;
      };
      paths: Record<
        string,
        Record<
          string,
          {
            parameters?: {
              description?: string;
              name: string;
              schema?: { format?: string };
            }[];
            requestBody?: {
              content: Record<
                string,
                {
                  schema: {
                    $ref?: string;
                    items?: { $ref?: string };
                    type?: string;
                  };
                }
              >;
            };
            responses: Record<
              string,
              {
                description?: string;
                content?: Record<
                  string,
                  {
                    schema: {
                      $ref?: string;
                      items?: { $ref?: string };
                      type?: string;
                    };
                  }
                >;
              }
            >;
          }
        >
      >;
    };
    const collection = document.paths['/api/v1/admin/logistics-companies'];
    const item = document.paths['/api/v1/admin/logistics-companies/{id}'];

    expect(Object.keys(collection).sort()).toEqual(['get', 'post']);
    expect(Object.keys(item).sort()).toEqual(['delete', 'get', 'put']);
    expect(Object.keys(collection.get.responses)).toEqual(['200']);
    expect(Object.keys(collection.post.responses).sort()).toEqual([
      '201',
      '400',
      '409',
    ]);
    expect(Object.keys(item.get.responses).sort()).toEqual([
      '200',
      '400',
      '404',
    ]);
    expect(Object.keys(item.put.responses).sort()).toEqual([
      '200',
      '400',
      '404',
      '409',
    ]);
    expect(Object.keys(item.delete.responses).sort()).toEqual([
      '204',
      '400',
      '404',
    ]);
    expect(item.delete.responses['204'].description).toContain('비활성화');
    expect(
      collection.post.requestBody?.content['application/json'].schema.$ref,
    ).toBe('#/components/schemas/LogisticsCompanyInputDto');
    expect(item.put.requestBody?.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/LogisticsCompanyInputDto',
    );
    expect(
      collection.get.responses['200'].content?.['application/json'].schema.items
        ?.$ref,
    ).toBe('#/components/schemas/LogisticsCompanyResponseDto');
    expect(
      collection.post.responses['201'].content?.['application/json'].schema
        .$ref,
    ).toBe('#/components/schemas/LogisticsCompanyResponseDto');
    expect(
      item.get.responses['200'].content?.['application/json'].schema.$ref,
    ).toBe('#/components/schemas/LogisticsCompanyResponseDto');
    expect(
      item.put.responses['200'].content?.['application/json'].schema.$ref,
    ).toBe('#/components/schemas/LogisticsCompanyResponseDto');
    for (const [operation, statusCodes] of [
      [collection.post, ['400', '409']],
      [item.get, ['400', '404']],
      [item.put, ['400', '404', '409']],
      [item.delete, ['400', '404']],
    ] as const) {
      for (const statusCode of statusCodes) {
        expect(
          operation.responses[statusCode].content?.['application/json'].schema
            .$ref,
        ).toBe('#/components/schemas/ApiErrorResponseDto');
      }
    }
    for (const operation of [item.get, item.put, item.delete]) {
      const idParameter = operation.parameters?.find(
        ({ name }) => name === 'id',
      );

      expect(idParameter).toMatchObject({
        description: '물류사 식별자',
        name: 'id',
      });
      expect(idParameter?.schema?.format).toBe('uuid');
    }
    expect(
      document.components.schemas.LogisticsCompanyInputDto.properties
        ?.businessName.description,
    ).toBe('사업자명');
    expect(
      document.components.schemas.LogisticsCompanyInputDto.properties?.bankCode
        .enum,
    ).toEqual(expect.arrayContaining(['19', '92']));
    expect(
      document.components.schemas.LogisticsCompanyInputDto.properties?.bankCode
        .enum,
    ).not.toContain('999');
    expect(
      document.components.schemas.LogisticsCompanyResponseDto.properties?.active
        .description,
    ).toBe('활성 여부');
    expect(
      document.components.schemas.ApiErrorResponseDto.properties?.code
        .description,
    ).toBe('서버 오류 코드');
    for (const schemaName of [
      'ApiErrorResponseDto',
      'LogisticsCompanyInputDto',
      'LogisticsCompanyResponseDto',
    ]) {
      for (const property of Object.values(
        document.components.schemas[schemaName].properties ?? {},
      )) {
        expect(property.description).toMatch(/[가-힣]/);
      }
    }
  });

  afterAll(async () => {
    await app.close();
  });
});
