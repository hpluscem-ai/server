import {
  BadRequestException,
  INestApplication,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

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
    .build();

  SwaggerModule.setup('docs', app, () =>
    SwaggerModule.createDocument(app, swaggerConfig, {
      extraModels: [ApiErrorResponseDto],
    }),
  );
}
