import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsISO8601,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const timestamp =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export class AdminDriverListQueryDto {
  @ApiPropertyOptional({
    description:
      '기사 이름 부분 검색. 앞뒤 공백과 대소문자를 무시하고 특수문자는 문자 그대로 검색합니다.',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  nameQuery?: string;

  @ApiPropertyOptional({
    description: '소속 물류사 식별자 일치 필터',
    format: 'uuid',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID('4')
  logisticsCompanyId?: string;

  @ApiPropertyOptional({
    description:
      '가입 시각 시작(포함). UTC 또는 명시적 시간대 오프셋이 있는 ISO 시각',
    format: 'date-time',
    example: '2026-09-01T00:00:00+09:00',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(timestamp)
  createdFrom?: string;

  @ApiPropertyOptional({
    description:
      '가입 시각 끝(제외). 날짜 양 끝을 포함하려면 선택한 끝 날짜의 다음 날 00:00을 해당 시간대 오프셋과 함께 전달합니다.',
    format: 'date-time',
    example: '2026-10-01T00:00:00+09:00',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(timestamp)
  createdBefore?: string;
}

export class AdminDriverResponseDto {
  @ApiProperty({ description: '기사 식별자', format: 'uuid' })
  id!: string;
  @ApiProperty({ description: '소속 물류사 식별자', format: 'uuid' })
  logisticsCompanyId!: string;
  @ApiProperty({ description: '소속 물류사명' })
  logisticsCompanyName!: string;
  @ApiProperty({ description: '기사 이름' })
  name!: string;
  @ApiProperty({ description: '기사 연락처' })
  phone!: string;
  @ApiProperty({ description: '가입 이메일' })
  email!: string;
  @ApiProperty({ description: '가입 시각(UTC)', format: 'date-time' })
  joinedAt!: string;
}
