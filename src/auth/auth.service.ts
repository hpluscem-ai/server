import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import * as argon2 from 'argon2';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { LoginRequestDto, LoginResponseDto } from './auth-login.dto';
import { CurrentUserResponseDto } from './auth-session.dto';
import { SignUpRequestDto, SignUpResponseDto } from './auth-signup.dto';
import {
  AuthRepository,
  EmailAlreadyExistsError,
  LogisticsCompanyUnavailableError,
  LoginUnavailableError,
  PhoneAlreadyExistsError,
  PhoneVerificationInvalidError,
} from './auth.repository';
import {
  ConfirmPhoneVerificationResponseDto,
  PublicVerificationPurpose,
  SendPhoneVerificationRequestDto,
  SendPhoneVerificationResponseDto,
} from './phone-verification.dto';
import { SolapiSmsService } from './solapi-sms.service';
import { ChangePasswordRequestDto } from './change-password.dto';
import { ResetPasswordRequestDto } from './reset-password.dto';
import { MISSING_USER_PASSWORD_HASH } from './password.constants';

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

export type AuthenticatedSession = {
  tokenHash: string;
  user: CurrentUserResponseDto;
};

@Injectable()
export class AuthService {
  // ponytail: one-process guard only; use a DB-backed proof claim when Postgres runs across instances.
  private readonly signUpProofsInFlight = new Set<string>();

  constructor(
    private readonly authRepository: AuthRepository,
    private readonly smsService: SolapiSmsService,
  ) {}

  async login(input: LoginRequestDto): Promise<LoginResponseDto> {
    const user = this.authRepository.findDriverCredentials(input.email);
    const passwordMatches = await argon2.verify(
      user?.passwordHash ?? MISSING_USER_PASSWORD_HASH,
      input.password,
    );

    if (!user || !passwordMatches) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: '이메일 또는 비밀번호가 일치하지 않습니다.',
      });
    }

    const token = randomBytes(32).toString('base64url');
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + SESSION_LIFETIME_MS);

    try {
      this.authRepository.createLoginSession({
        userId: user.id,
        passwordHash: user.passwordHash,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        createdAt,
        expiresAt,
      });
    } catch (error) {
      if (error instanceof LoginUnavailableError) {
        throw new ForbiddenException({
          code: 'ACCOUNT_UNAVAILABLE',
          message: '로그인할 수 없는 계정입니다. 관리자에게 문의해 주세요.',
        });
      }
      throw error;
    }

    return { token, expiresAt: expiresAt.toISOString() };
  }

  authenticateSession(
    token: string | undefined,
  ): AuthenticatedSession | undefined {
    if (!token) return undefined;

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = new Date(Date.now());
    const user = this.authRepository.useSession(
      tokenHash,
      now,
      new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS),
    );

    return user ? { tokenHash, user } : undefined;
  }

  logout(tokenHash: string): void {
    this.authRepository.deleteSession(tokenHash);
  }

  async changePassword(
    session: AuthenticatedSession,
    input: ChangePasswordRequestDto,
  ): Promise<void> {
    const user = this.authRepository.findDriverPassword(session.user.id);
    if (!user) this.throwSessionInvalid();
    if (!(await argon2.verify(user.passwordHash, input.currentPassword))) {
      throw new BadRequestException({
        code: 'CURRENT_PASSWORD_MISMATCH',
        message: '현재 비밀번호가 일치하지 않습니다.',
      });
    }

    const passwordHash = await argon2.hash(input.newPassword, {
      type: argon2.argon2id,
    });
    const now = new Date(Date.now());
    const changed = this.authRepository.changeDriverPassword({
      userId: session.user.id,
      tokenHash: session.tokenHash,
      previousPasswordHash: user.passwordHash,
      passwordHash,
      now,
      idleCutoff: new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS),
    });
    if (!changed) this.throwSessionInvalid();
  }

  private throwSessionInvalid(): never {
    throw new UnauthorizedException({
      code: 'INVALID_SESSION',
      message: '로그인이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.',
    });
  }

  async resetPassword(input: ResetPasswordRequestDto): Promise<void> {
    const tokenHash = createHash('sha256').update(input.token).digest('hex');
    const user = this.authRepository.findPasswordReset(tokenHash);
    if (!user) this.throwPasswordResetInvalid();
    const passwordHash = await argon2.hash(input.newPassword, {
      type: argon2.argon2id,
    });
    if (
      !this.authRepository.resetDriverPassword(
        tokenHash,
        user.passwordHash,
        passwordHash,
      )
    ) {
      this.throwPasswordResetInvalid();
    }
  }

  private throwPasswordResetInvalid(): never {
    throw new BadRequestException({
      code: 'PASSWORD_RESET_INVALID',
      message: '비밀번호 재설정 링크가 만료되었거나 유효하지 않습니다.',
    });
  }

  async sendPhoneVerification(
    input: SendPhoneVerificationRequestDto,
  ): Promise<SendPhoneVerificationResponseDto> {
    const { phone, purpose, email } = input;
    if (
      purpose === 'reset_password' ? email === undefined : email !== undefined
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: '비밀번호 찾기 목적에서만 이메일을 함께 입력해 주세요.',
      });
    }
    const verificationId = randomUUID();
    const code = randomInt(1_000_000).toString().padStart(6, '0');
    const codeHash = this.hashVerificationCode(verificationId, code, purpose);

    this.authRepository.beginPhoneVerification(
      verificationId,
      phone,
      codeHash,
      purpose,
      email,
    );
    await this.smsService.sendVerificationCode(phone, code);
    const expiresAt = this.authRepository.activatePhoneVerification(
      verificationId,
      purpose,
    );

    if (!expiresAt) {
      throw new ConflictException({
        code: 'PHONE_VERIFICATION_SUPERSEDED',
        message:
          '새 인증번호가 요청되었습니다. 가장 최근 인증번호를 사용해 주세요.',
      });
    }

    return { verificationId, expiresAt };
  }

  confirmPhoneVerification(
    verificationId: string,
    code: string,
    purpose: PublicVerificationPurpose,
  ): ConfirmPhoneVerificationResponseDto {
    const codeHash = this.hashVerificationCode(verificationId, code, purpose);
    const pending = this.authRepository.findPendingPhoneVerification(
      verificationId,
      purpose,
    );

    if (!pending) {
      this.throwPhoneVerificationInvalid();
    }

    const storedHash = Buffer.from(pending.codeHash, 'hex');
    const candidateHash = Buffer.from(codeHash, 'hex');
    if (
      storedHash.length !== candidateHash.length ||
      !timingSafeEqual(storedHash, candidateHash)
    ) {
      throw new BadRequestException({
        code: 'PHONE_VERIFICATION_CODE_MISMATCH',
        message: '인증번호가 일치하지 않습니다.',
      });
    }

    const verificationProof = randomBytes(32).toString('base64url');
    const proofHash = createHash('sha256')
      .update(verificationProof)
      .digest('hex');
    const expiresAt = this.authRepository.confirmPhoneVerification(
      verificationId,
      proofHash,
      purpose,
    );

    if (!expiresAt) {
      this.throwPhoneVerificationInvalid();
    }

    return { verificationProof, expiresAt };
  }

  async signUp(input: SignUpRequestDto): Promise<SignUpResponseDto> {
    const proofHash = createHash('sha256')
      .update(input.verificationProof)
      .digest('hex');

    if (this.signUpProofsInFlight.has(proofHash)) {
      this.throwPhoneVerificationInvalid();
    }

    this.signUpProofsInFlight.add(proofHash);

    try {
      await this.authRepository.assertSignUpPrerequisites(
        input.email,
        input.logisticsCompanyId,
        input.phone,
        proofHash,
      );

      const passwordHash = await argon2.hash(input.password, {
        type: argon2.argon2id,
      });
      const id = this.authRepository.createDriver({
        email: input.email,
        id: randomUUID(),
        logisticsCompanyId: input.logisticsCompanyId,
        marketingTerms: input.marketingTerms,
        name: input.name,
        passwordHash,
        phone: input.phone,
        privacyTerms: input.privacyTerms,
        proofHash,
        serviceTerms: input.serviceTerms,
      });

      return { id };
    } catch (error) {
      this.throwIfDomainError(error);
      throw error;
    } finally {
      this.signUpProofsInFlight.delete(proofHash);
    }
  }

  private throwIfDomainError(error: unknown): void {
    if (error instanceof PhoneVerificationInvalidError) {
      this.throwPhoneVerificationInvalid();
    }

    if (error instanceof LogisticsCompanyUnavailableError) {
      throw new BadRequestException({
        code: 'LOGISTICS_COMPANY_UNAVAILABLE',
        message: '선택할 수 없는 소속입니다.',
      });
    }

    if (error instanceof EmailAlreadyExistsError) {
      throw new ConflictException({
        code: 'EMAIL_ALREADY_EXISTS',
        message: '이미 가입된 이메일입니다.',
      });
    }

    if (error instanceof PhoneAlreadyExistsError) {
      throw new ConflictException({
        code: 'PHONE_ALREADY_EXISTS',
        message: '이미 가입된 연락처입니다.',
      });
    }
  }

  private hashVerificationCode(
    verificationId: string,
    code: string,
    purpose: PublicVerificationPurpose,
  ): string {
    const secret = process.env.PHONE_VERIFICATION_SECRET?.trim();
    if (!secret || Buffer.byteLength(secret) < 32) {
      throw new ServiceUnavailableException({
        code: 'PHONE_VERIFICATION_NOT_CONFIGURED',
        message: '휴대폰 인증 설정이 준비되지 않았습니다.',
      });
    }

    return createHmac('sha256', secret)
      .update(`${purpose}:${verificationId}:${code}`)
      .digest('hex');
  }

  private throwPhoneVerificationInvalid(): never {
    throw new BadRequestException({
      code: 'PHONE_VERIFICATION_INVALID',
      message: '휴대폰 인증이 만료되었거나 유효하지 않습니다.',
    });
  }
}
