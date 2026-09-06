import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginRequestDto {
  @ApiProperty({
    description: '로그인 이메일',
    example: 'driver@example.com',
    maxLength: 254,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    description: '비밀번호. 영문·숫자·특수문자를 각각 포함한 8~128자',
    example: 'Password!1',
    minLength: 8,
    maxLength: 128,
    writeOnly: true,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z\d\s]).{8,}$/)
  password!: string;
}

export class LoginResponseDto {
  @ApiProperty({
    description:
      '서버가 발급한 로그인 세션 토큰. 원문은 DB에 저장하지 않습니다.',
  })
  token!: string;

  @ApiProperty({
    description:
      '로그인 시점부터 30일 뒤의 최대 만료 시각. 미사용 만료 시각과 다릅니다.',
    format: 'date-time',
  })
  expiresAt!: string;
}
