import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export type PublicVerificationPurpose =
  'sign_up' | 'find_email' | 'reset_password';

export type VerificationPurpose = PublicVerificationPurpose | 'change_phone';

class PublicVerificationPurposeDto {
  @ApiPropertyOptional({
    description: '인증 목적. 생략 시 기존 회원가입 계약을 유지합니다.',
    enum: ['sign_up', 'find_email', 'reset_password'],
    default: 'sign_up',
  })
  @IsIn(['sign_up', 'find_email', 'reset_password'])
  purpose: PublicVerificationPurpose = 'sign_up';
}

export class SendPhoneVerificationRequestDto extends PublicVerificationPurposeDto {
  @ApiProperty({
    description: '인증번호를 받을 휴대폰 번호',
    example: '010-1234-5678',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/^010-\d{4}-\d{4}$/)
  phone!: string;

  @ApiPropertyOptional({
    description:
      '비밀번호 찾기 목적에서만 반드시 필요한 이메일. 다른 목적에서는 보내지 않습니다.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}

export class PhoneVerificationParamsDto {
  @ApiProperty({
    description: '발송 요청으로 받은 인증 식별자',
    format: 'uuid',
  })
  @IsUUID('4')
  verificationId!: string;
}

export class ConfirmPhoneVerificationRequestDto extends PublicVerificationPurposeDto {
  @ApiProperty({ description: '문자로 받은 6자리 인증번호', example: '012345' })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class SendPhoneVerificationResponseDto {
  @ApiProperty({
    description: '인증번호 확인에 사용할 인증 식별자',
    format: 'uuid',
  })
  verificationId!: string;

  @ApiProperty({
    description: '발송 접수 성공 시점부터 3분 뒤인 인증 만료 시각(UTC)',
    format: 'date-time',
  })
  expiresAt!: string;
}

export class ConfirmPhoneVerificationResponseDto {
  @ApiProperty({
    description:
      '발송 목적과 입력 범위에 묶인 일회용 휴대폰 인증 증명. 재확인 성공 시 이전 증명을 대체합니다. 이메일 찾기는 find-email, 재설정 메일 발송은 password-reset-emails에서 소비합니다.',
  })
  verificationProof!: string;

  @ApiProperty({
    description:
      '인증 증명 만료 시각(UTC). 인증번호의 원래 만료 시각을 유지한다.',
    format: 'date-time',
  })
  expiresAt!: string;
}
