import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import {
  ADMIN_WEB_SESSION_COOKIE,
  assertWebOrigin,
  readWebSession,
} from '../auth';

import { AdminAuthService } from './admin-auth.service';

export type AdminAuthenticatedRequest = Request & {
  authMethod: 'bearer' | 'cookie';
  adminSession: NonNullable<ReturnType<AdminAuthService['authenticate']>>;
};

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(private readonly auth: AdminAuthService) {}
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<AdminAuthenticatedRequest>();
    const response = http.getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    request.authMethod =
      request.headers.authorization === undefined ? 'cookie' : 'bearer';
    const token =
      request.authMethod === 'bearer'
        ? request.headers.authorization?.match(
            /^Bearer +([A-Za-z0-9_-]{43})$/i,
          )?.[1]
        : readWebSession(request, ADMIN_WEB_SESSION_COOKIE);
    if (
      request.authMethod === 'cookie' &&
      token &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    ) {
      assertWebOrigin(request);
    }
    const session = this.auth.authenticate(token);
    if (!session) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException({
        code: 'INVALID_ADMIN_SESSION',
        message: '관리자 로그인이 필요합니다.',
      });
    }
    request.adminSession = session;
    return true;
  }
}
