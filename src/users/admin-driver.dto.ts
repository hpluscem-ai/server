import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';

import { DateRangeQueryDto } from '../common/date-range-query';

export class AdminDriverListQueryDto extends DateRangeQueryDto {
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
  @ApiProperty({
    description: '정산 여부와 관계없는 전체 기간 승인 확정 금액 누적(원)',
    type: 'integer',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  })
  totalAmount!: number;
  @ApiProperty({
    description: '정산 여부와 관계없는 전체 기간 승인 적립 마일리지 누적',
    type: 'integer',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  })
  mileage!: number;
}
