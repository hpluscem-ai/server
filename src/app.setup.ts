import {
  BadRequestException,
  INestApplication,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import {
  ADMIN_WEB_SESSION_COOKIE,
  getWebOrigins,
  WEB_SESSION_COOKIE,
} from './auth';
import { ApiErrorResponseDto } from './common/api-error-response.dto';
import { ApiExceptionFilter } from './common/api-exception.filter';

function collectFieldErrors(
  errors: ValidationError[],
  parentPath = '',
  result: Record<string, string[]> = {},
): Record<string, string[]> {
  for (const error of errors) {
    const property = error.property || '_request';
    const path = parentPath ? `${parentPath}.${property}` : property;
    const messages = Object.values(error.constraints ?? {});

    if (messages.length > 0) {
      result[path] = messages;
    }

    if (error.children?.length) {
      collectFieldErrors(error.children, path, result);
    }
  }

  return result;
}

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  const webOrigins = getWebOrigins();
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow: boolean) => void,
    ) => callback(null, Boolean(origin && webOrigins.includes(origin))),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      validationError: { target: false, value: false },
      whitelist: true,
      exceptionFactory: (errors) =>
        new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: '입력값을 확인해 주세요.',
          fieldErrors: collectFieldErrors(errors),
        }),
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('H Plus Eco API')
    .setVersion('1.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'opaque',
      description: '기사 로그인 응답의 세션 토큰을 입력합니다.',
    })
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'opaque',
        description:
          '관리자 로그인 응답의 별도 세션 토큰을 입력합니다. 기사 토큰은 허용하지 않습니다.',
      },
      'admin',
    )
    .addCookieAuth(
      WEB_SESSION_COOKIE,
      {
        type: 'apiKey',
        in: 'cookie',
        description: '웹 로그인에서 발급한 HttpOnly 기사 세션 쿠키.',
      },
      'driver-session',
    )
    .addCookieAuth(
      ADMIN_WEB_SESSION_COOKIE,
      {
        type: 'apiKey',
        in: 'cookie',
        description:
          '웹 관리자 로그인에서 발급한 HttpOnly 관리자 전용 세션 쿠키.',
      },
      'admin-session',
    )
    .build();

  SwaggerModule.setup('docs', app, () =>
    SwaggerModule.createDocument(app, swaggerConfig, {
      extraModels: [ApiErrorResponseDto],
    }),
  );
}
