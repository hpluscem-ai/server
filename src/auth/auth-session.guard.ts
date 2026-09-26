import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuthService, type AuthenticatedSession } from './auth.service';
import { assertWebOrigin, readWebSession } from './auth-web-session';

export type AuthenticatedRequest = Request & {
  authSession: AuthenticatedSession;
  authMethod: 'bearer' | 'cookie';
};

@Injectable()
export class AuthSessionGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();
    // 인증 실패 응답에도 적용되도록 컨트롤러 실행 전에 설정한다.
    response.setHeader('Cache-Control', 'no-store');
    request.authMethod =
      request.headers.authorization === undefined ? 'cookie' : 'bearer';
    const token =
      request.authMethod === 'bearer'
        ? request.headers.authorization?.match(
            /^Bearer +([A-Za-z0-9_-]{43})$/i,
          )?.[1]
        : readWebSession(request);
    if (
      request.authMethod === 'cookie' &&
      token &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    ) {
      assertWebOrigin(request);
    }
    const session = await this.authService.authenticateSession(token);

    if (!session) {
      // A late 401 must not delete the cookie issued by a newer login.
      response.setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException({
        code: 'INVALID_SESSION',
        message:
          '로그인이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.',
      });
    }

    request.authSession = session;
    return true;
  }
}
