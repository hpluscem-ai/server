import {
  Body,
  Controller,
  Get,
  INestApplication,
  Logger,
  Post,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt } from 'class-validator';
import request from 'supertest';
import { App } from 'supertest/types';

import { DatabaseService } from '../src/database/database.service';
import { createTestApp } from './helpers/create-test-app';

class ValidationProbeDto {
  @Type(() => Number)
  @IsInt()
  count!: number;
}

class UnknownValueProbeDto {
  value!: string;
}

@Controller('validation-probe')
class ValidationProbeController {
  @Post()
  validate(@Body() body: ValidationProbeDto) {
    return {
      count: body.count,
      transformed: body instanceof ValidationProbeDto,
    };
  }

  @Post('unknown-value')
  validateUnknownValue(@Body() body: UnknownValueProbeDto) {
    return body;
  }

  @Get('error')
  throwUnexpectedError() {
    throw new Error('sensitive internal details');
  }
}

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp([ValidationProbeController]);
  });

  it('serves application routes below /api/v1', async () => {
    await request(app.getHttpServer()).get('/').expect(404);

    return request(app.getHttpServer())
      .get('/api/v1')
      .expect(200)
      .expect('Hello World!');
  });

  it('validates, transforms, and rejects unknown request fields', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/validation-probe')
      .send({ count: '2' })
      .expect(201)
      .expect({ count: 2, transformed: true });

    const response = await request(app.getHttpServer())
      .post('/api/v1/validation-probe')
      .send({ count: '2', unknown: true })
      .expect(400);

    expect(response.body).toEqual({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: '입력값을 확인해 주세요.',
      fieldErrors: {
        unknown: ['property unknown should not exist'],
      },
    });

    const invalidValueResponse = await request(app.getHttpServer())
      .post('/api/v1/validation-probe')
      .send({ count: 'not-a-number' })
      .expect(400);

    expect(invalidValueResponse.body).toEqual({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: '입력값을 확인해 주세요.',
      fieldErrors: {
        count: ['count must be an integer number'],
      },
    });
  });

  it('rejects DTOs without validation metadata', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/validation-probe/unknown-value')
      .send({})
      .expect(400);

    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  it('returns every HTTP error in the shared response shape', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/missing')
      .expect(404);

    expect(response.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Cannot GET /api/v1/missing',
    });

    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    try {
      const unexpectedErrorResponse = await request(app.getHttpServer())
        .get('/api/v1/validation-probe/error')
        .expect(500);

      expect(unexpectedErrorResponse.body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: '서버 오류가 발생했습니다.',
      });
      expect(JSON.stringify(unexpectedErrorResponse.body)).not.toContain(
        'sensitive internal details',
      );
    } finally {
      logger.mockRestore();
    }
  });

  it('uses an isolated PostgreSQL database', async () => {
    const database = app.get(DatabaseService).connection;
    const [result] = await database<{ name: string; version: string }[]>`
      SELECT current_database() AS name, version() AS version
    `;
    expect(result.name).toMatch(/^hpluseco_test_/);
    expect(result.version).toContain('PostgreSQL');
  });

  it('never uses or changes the runtime DATABASE_URL for test applications', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://unused.invalid/preserved';
    let isolatedApp: INestApplication<App> | undefined;

    try {
      isolatedApp = await createTestApp();
      expect(process.env.DATABASE_URL).toBe(
        'postgresql://unused.invalid/preserved',
      );
      const [first] = await app.get(DatabaseService)
        .connection`SELECT current_database() AS name`;
      const [second] = await isolatedApp.get(DatabaseService)
        .connection`SELECT current_database() AS name`;
      expect(first.name).not.toBe(second.name);
    } finally {
      await isolatedApp?.close();

      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });

  it('serves Swagger UI and an OpenAPI document', async () => {
    await request(app.getHttpServer())
      .get('/docs/')
      .expect(200)
      .expect('Content-Type', /html/);

    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const openApiDocument = response.body as unknown as {
      components: {
        schemas: Record<string, unknown>;
      };
      info: { title: string; version: string };
      paths: Record<string, unknown>;
    };

    expect(openApiDocument.info).toMatchObject({
      title: 'H Plus Eco API',
      version: '1.0',
    });
    expect(openApiDocument.paths).toHaveProperty('/api/v1');
    const apiErrorSchema = openApiDocument.components.schemas
      .ApiErrorResponseDto as {
      properties: Record<string, unknown>;
      required: string[];
      type: string;
    };

    expect(apiErrorSchema).toMatchObject({
      properties: {
        code: { type: 'string' },
        fieldErrors: {
          additionalProperties: {
            items: { type: 'string' },
            type: 'array',
          },
          type: 'object',
        },
        message: { type: 'string' },
        statusCode: { type: 'number' },
      },
      type: 'object',
    });
    expect(apiErrorSchema.required).toHaveLength(3);
    expect(apiErrorSchema.required).toEqual(
      expect.arrayContaining(['statusCode', 'code', 'message']),
    );
  });

  afterAll(async () => {
    await app.close();
  });
});
