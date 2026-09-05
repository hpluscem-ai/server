import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsUUID, Matches } from 'class-validator';

export class SendPhoneVerificationRequestDto {
  @ApiProperty({
    description: '회원가입 인증번호를 받을 휴대폰 번호',
    example: '010-1234-5678',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/^010-\d{4}-\d{4}$/)
  phone!: string;
}

export class PhoneVerificationParamsDto {
  @ApiProperty({
    description: '발송 요청으로 받은 인증 식별자',
    format: 'uuid',
  })
  @IsUUID('4')
  verificationId!: string;
}

export class ConfirmPhoneVerificationRequestDto {
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
  @ApiProperty({ description: '회원가입에 한 번만 사용할 휴대폰 인증 증명' })
  verificationProof!: string;

  @ApiProperty({
    description:
      '인증 증명 만료 시각(UTC). 인증번호의 원래 만료 시각을 유지한다.',
    format: 'date-time',
  })
  expiresAt!: string;
}
