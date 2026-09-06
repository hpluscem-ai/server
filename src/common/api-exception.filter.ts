import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

type FieldErrors = Record<string, string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    const messages = value.filter(
      (message): message is string => typeof message === 'string',
    );

    if (messages.length > 0) {
      return messages.join(', ');
    }
  }

  return fallback;
}

function normalizeFieldErrors(value: unknown): FieldErrors | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const fieldErrors = Object.fromEntries(
    Object.entries(value).flatMap(([field, messages]) => {
      if (!Array.isArray(messages)) {
        return [];
      }

      const stringMessages = messages.filter(
        (message): message is string => typeof message === 'string',
      );

      return stringMessages.length > 0 ? [[field, stringMessages]] : [];
    }),
  );

  return Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (!(exception instanceof HttpException)) {
      // DB 오류 원문에는 SQL 바인딩 값(개인정보·비밀번호 해시)이 포함될 수 있다.
      this.logger.error('Unhandled exception');
    }

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const responseBody = isRecord(exceptionResponse)
      ? exceptionResponse
      : undefined;
    const fallbackMessage =
      statusCode === Number(HttpStatus.INTERNAL_SERVER_ERROR)
        ? '서버 오류가 발생했습니다.'
        : '요청을 처리할 수 없습니다.';
    const fieldErrors = normalizeFieldErrors(responseBody?.fieldErrors);
    const body = {
      statusCode,
      code:
        typeof responseBody?.code === 'string'
          ? responseBody.code
          : (HttpStatus[statusCode] ?? `HTTP_${statusCode}`),
      message: normalizeMessage(
        responseBody?.message ?? exceptionResponse,
        fallbackMessage,
      ),
      ...(fieldErrors ? { fieldErrors } : {}),
    };

    response.status(statusCode).json(body);
  }
}
