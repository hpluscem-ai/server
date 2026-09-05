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
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import { SignUpRequestDto, SignUpResponseDto } from './auth-signup.dto';
import {
  AuthRepository,
  EmailAlreadyExistsError,
  LogisticsCompanyUnavailableError,
  PhoneAlreadyExistsError,
  PhoneVerificationInvalidError,
} from './auth.repository';
import {
  ConfirmPhoneVerificationResponseDto,
  SendPhoneVerificationResponseDto,
} from './phone-verification.dto';
import { SolapiSmsService } from './solapi-sms.service';

@Injectable()
export class AuthService {
  // ponytail: one-process guard only; use a DB-backed proof claim when Postgres runs across instances.
  private readonly signUpProofsInFlight = new Set<string>();

  constructor(
    private readonly authRepository: AuthRepository,
    private readonly smsService: SolapiSmsService,
  ) {}

  async sendPhoneVerification(
    phone: string,
  ): Promise<SendPhoneVerificationResponseDto> {
    const verificationId = randomUUID();
    const code = randomInt(1_000_000).toString().padStart(6, '0');
    const codeHash = this.hashVerificationCode(verificationId, code);

    this.authRepository.beginPhoneVerification(verificationId, phone, codeHash);
    await this.smsService.sendVerificationCode(phone, code);
    const expiresAt =
      this.authRepository.activatePhoneVerification(verificationId);

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
  ): ConfirmPhoneVerificationResponseDto {
    const codeHash = this.hashVerificationCode(verificationId, code);
    const pending =
      this.authRepository.findPendingPhoneVerification(verificationId);

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

  private hashVerificationCode(verificationId: string, code: string): string {
    const secret = process.env.PHONE_VERIFICATION_SECRET?.trim();
    if (!secret || Buffer.byteLength(secret) < 32) {
      throw new ServiceUnavailableException({
        code: 'PHONE_VERIFICATION_NOT_CONFIGURED',
        message: '휴대폰 인증 설정이 준비되지 않았습니다.',
      });
    }

    return createHmac('sha256', secret)
      .update(`sign_up:${verificationId}:${code}`)
      .digest('hex');
  }

  private throwPhoneVerificationInvalid(): never {
    throw new BadRequestException({
      code: 'PHONE_VERIFICATION_INVALID',
      message: '휴대폰 인증이 만료되었거나 유효하지 않습니다.',
    });
  }
}
