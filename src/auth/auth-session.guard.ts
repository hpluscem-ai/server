import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuthService, type AuthenticatedSession } from './auth.service';

export type AuthenticatedRequest = Request & {
  authSession: AuthenticatedSession;
};

@Injectable()
export class AuthSessionGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();
    // 인증 실패 응답에도 적용되도록 컨트롤러 실행 전에 설정한다.
    response.setHeader('Cache-Control', 'no-store');
    const token = request.headers.authorization?.match(
      /^Bearer +([A-Za-z0-9_-]{43})$/i,
    )?.[1];
    const session = this.authService.authenticateSession(token);

    if (!session) {
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
