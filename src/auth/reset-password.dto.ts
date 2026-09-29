import { ApiProperty, IntersectionType, PickType } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

import { ChangePasswordRequestDto } from './change-password.dto';
import { FindEmailRequestDto } from './find-email.dto';
import { SignUpRequestDto } from './auth-signup.dto';

export class RequestPasswordResetEmailDto extends IntersectionType(
  FindEmailRequestDto,
  PickType(SignUpRequestDto, ['email'] as const),
) {}

export class PasswordResetEmailResponseDto {
  @ApiProperty({
    description:
      '계정 존재 여부를 노출하지 않는 공통 접수 안내. 메일 배달 완료를 보장하지 않습니다.',
  })
  message!: string;
}

export class MyPasswordResetEmailResponseDto {
  @ApiProperty({
    description: '재설정 메일 발송이 접수된 본인의 이메일',
  })
  email!: string;
}

export class ResetPasswordRequestDto extends PickType(
  ChangePasswordRequestDto,
  ['newPassword'] as const,
) {
  @ApiProperty({
    description: '서버에 저장된 유효한 일회용 비밀번호 재설정 토큰 원문',
    writeOnly: true,
    pattern: '^[A-Za-z0-9_-]{43}$',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;
}

export class ValidatePasswordResetRequestDto extends PickType(
  ResetPasswordRequestDto,
  ['token'] as const,
) {}
