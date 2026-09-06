import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdateDriverProfileDto {
  @ApiPropertyOptional({
    description: '변경할 기사 성함. 앞뒤 공백을 제외한 문자·공백 1~100자',
    maxLength: 100,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[\p{L} ]+$/u)
  name?: string;

  @ApiPropertyOptional({
    description: '변경할 마케팅 정보 수신 동의 여부',
    example: false,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  marketingConsent?: boolean;
}

export class DriverProfileResponseDto {
  @ApiProperty({
    description: '변경할 수 없는 가입 이메일',
    example: 'driver@example.com',
  })
  email!: string;

  @ApiProperty({ description: '현재 기사 성함', example: '김기사' })
  name!: string;

  @ApiProperty({
    description: '현재 인증된 휴대폰 번호. 일반 정보 변경에서는 수정 불가',
    example: '010-1234-5678',
  })
  phone!: string;

  @ApiProperty({
    description: '현재 마케팅 정보 수신 동의 여부',
    example: false,
  })
  marketingConsent!: boolean;
}
