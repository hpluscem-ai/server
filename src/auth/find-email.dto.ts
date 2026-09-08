import { ApiProperty, PickType } from '@nestjs/swagger';
import { SignUpRequestDto } from './auth-signup.dto';

export class FindEmailRequestDto extends PickType(SignUpRequestDto, [
  'phone',
  'verificationProof',
] as const) {}

export class FindEmailResponseDto {
  @ApiProperty({
    description:
      '이메일 로컬 부분 앞 2자만 표시하고 나머지를 가린 값. 2자 이하면 모두 가립니다.',
  })
  maskedEmail!: string;

  @ApiProperty({
    description: '인증한 가입 연락처의 마지막 4자리',
    example: '5678',
  })
  phoneLastFour!: string;
}
