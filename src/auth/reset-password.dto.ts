import { ApiProperty, PickType } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

import { ChangePasswordRequestDto } from './change-password.dto';

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
