import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';

import {
  LoginRequestDto,
  LoginResponseDto,
  MISSING_USER_PASSWORD_HASH,
} from '../auth';
import { AdminAuthRepository } from './admin-auth.repository';

@Injectable()
export class AdminAuthService {
  constructor(private readonly repository: AdminAuthRepository) {}

  async login(input: LoginRequestDto): Promise<LoginResponseDto> {
    // 미정인 관리자 유지기간을 기사 정책이나 임의 기본값으로 채우지 않는다.
    const setting = process.env.ADMIN_SESSION_TTL_SECONDS?.trim() ?? '';
    const lifetime = Number(setting) * 1000;
    if (
      !/^[1-9]\d*$/.test(setting) ||
      !Number.isSafeInteger(lifetime) ||
      Number.isNaN(new Date(Date.now() + lifetime).getTime())
    ) {
      throw new ServiceUnavailableException({
        code: 'ADMIN_AUTH_NOT_CONFIGURED',
        message: '관리자 세션 유지기간 설정이 준비되지 않았습니다.',
      });
    }
    const user = this.repository.findCredentials(input.email);
    const matches = await argon2.verify(
      user?.passwordHash ?? MISSING_USER_PASSWORD_HASH,
      input.password,
    );
    if (!user || !matches) this.throwCredentialsInvalid();
    const token = randomBytes(32).toString('base64url');
    const createdAt = new Date(Date.now());
    const expiresAt = new Date(createdAt.getTime() + lifetime);
    if (
      !this.repository.createSession({
        userId: user.id,
        passwordHash: user.passwordHash,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        createdAt,
        expiresAt,
      })
    ) {
      this.throwCredentialsInvalid();
    }
    return { token, expiresAt: expiresAt.toISOString() };
  }

  authenticate(token: string | undefined) {
    if (!token) return undefined;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const user = this.repository.findSession(tokenHash);
    return user ? { tokenHash, user } : undefined;
  }

  logout(tokenHash: string): void {
    this.repository.deleteSession(tokenHash);
  }

  private throwCredentialsInvalid(): never {
    throw new UnauthorizedException({
      code: 'INVALID_CREDENTIALS',
      message: '이메일 또는 비밀번호가 일치하지 않습니다.',
    });
  }
}
