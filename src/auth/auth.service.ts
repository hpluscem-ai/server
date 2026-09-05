import { createHash, randomUUID } from 'node:crypto';

import * as argon2 from 'argon2';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';

import { SignUpRequestDto, SignUpResponseDto } from './auth-signup.dto';
import {
  AuthRepository,
  EmailAlreadyExistsError,
  LogisticsCompanyUnavailableError,
  PhoneAlreadyExistsError,
  PhoneVerificationInvalidError,
} from './auth.repository';

@Injectable()
export class AuthService {
  // ponytail: one-process guard only; use a DB-backed proof claim when Postgres runs across instances.
  private readonly signUpProofsInFlight = new Set<string>();

  constructor(private readonly authRepository: AuthRepository) {}

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

  private throwPhoneVerificationInvalid(): never {
    throw new BadRequestException({
      code: 'PHONE_VERIFICATION_INVALID',
      message: '휴대폰 인증이 만료되었거나 유효하지 않습니다.',
    });
  }
}
