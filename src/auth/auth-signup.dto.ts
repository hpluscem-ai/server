import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class SignUpRequestDto {
  @ApiProperty({ description: '가입 이메일', example: 'driver@example.com' })
  @Transform(trim)
  @IsString()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    description: '비밀번호. 영문·숫자·특수문자를 각각 포함한 8~128자',
    example: 'Password!1',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z\d\s]).{8,}$/)
  password!: string;

  @ApiProperty({ description: '선택한 물류사 식별자', format: 'uuid' })
  @IsString()
  @IsUUID('4')
  logisticsCompanyId!: string;

  @ApiProperty({ description: '기사 이름', example: '김기사' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[\p{L} ]+$/u)
  name!: string;

  @ApiProperty({ description: '휴대폰 번호', example: '010-1234-5678' })
  @Transform(trim)
  @IsString()
  @Matches(/^010-\d{4}-\d{4}$/)
  phone!: string;

  @ApiProperty({ description: '서버가 발급한 휴대폰 인증 증명' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  verificationProof!: string;

  @ApiProperty({ description: '서비스 이용약관 동의 여부', example: true })
  @IsBoolean()
  @Equals(true)
  serviceTerms!: boolean;

  @ApiProperty({ description: '개인정보 처리방침 동의 여부', example: true })
  @IsBoolean()
  @Equals(true)
  privacyTerms!: boolean;

  @ApiProperty({ description: '마케팅 정보 수신 동의 여부', example: false })
  @IsBoolean()
  marketingTerms!: boolean;
}

export class SignUpResponseDto {
  @ApiProperty({ description: '가입된 사용자 식별자', format: 'uuid' })
  id!: string;
}
