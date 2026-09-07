import { BadRequestException } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, Matches, ValidateIf } from 'class-validator';

const timestamp =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export class DateRangeQueryDto {
  @ApiPropertyOptional({
    description:
      '등록 시각 시작(포함). UTC 또는 명시적 시간대 오프셋이 있는 ISO 시각',
    format: 'date-time',
    example: '2026-09-01T00:00:00+09:00',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(timestamp)
  createdFrom?: string;

  @ApiPropertyOptional({
    description:
      '등록 시각 끝(제외). 날짜 양 끝을 포함하려면 선택한 끝 날짜의 다음 날 00:00을 해당 시간대 오프셋과 함께 전달합니다.',
    format: 'date-time',
    example: '2026-10-01T00:00:00+09:00',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(timestamp)
  createdBefore?: string;
}

// SQLite와 JavaScript의 오프셋 지원 범위 차이를 조회 전에 없앤다.
export function normalizeDateRange(
  query: DateRangeQueryDto,
): DateRangeQueryDto {
  const from =
    query.createdFrom === undefined ? undefined : Date.parse(query.createdFrom);
  const before =
    query.createdBefore === undefined
      ? undefined
      : Date.parse(query.createdBefore);
  if (
    [from, before].some(
      (value) => value !== undefined && !Number.isFinite(value),
    )
  ) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: '유효한 조회 시각을 입력해 주세요.',
    });
  }
  if (from !== undefined && before !== undefined && from >= before) {
    throw new BadRequestException({
      code: 'INVALID_DATE_RANGE',
      message: '조회 시작 시각은 끝 시각보다 빨라야 합니다.',
    });
  }
  return {
    createdFrom: from === undefined ? undefined : new Date(from).toISOString(),
    createdBefore:
      before === undefined ? undefined : new Date(before).toISOString(),
  };
}
