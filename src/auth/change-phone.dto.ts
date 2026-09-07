import { PickType } from '@nestjs/swagger';

import { SignUpRequestDto } from './auth-signup.dto';
import {
  ConfirmPhoneVerificationRequestDto,
  SendPhoneVerificationRequestDto,
} from './phone-verification.dto';

export class SendPhoneChangeVerificationDto extends PickType(
  SendPhoneVerificationRequestDto,
  ['phone'] as const,
) {}
export class ConfirmPhoneChangeVerificationDto extends PickType(
  ConfirmPhoneVerificationRequestDto,
  ['code'] as const,
) {}
export class ChangePhoneRequestDto extends PickType(SignUpRequestDto, [
  'phone',
  'verificationProof',
] as const) {}
