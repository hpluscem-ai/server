import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { DateRangeQueryDto } from '../common/date-range-query';

export class CreateMileageDto {
  @ApiPropertyOptional({
    enum: ['single', 'separate'],
    default: 'separate',
    description:
      'single: combined image in receipt; separate: receipt and meter images.',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['single', 'separate'])
  photoMode?: 'single' | 'separate';

  @ApiProperty({
    format: 'uuid',
    description:
      'UUID v4. Same user/key/files returns the existing application; different files return 409.',
  })
  @IsUUID('4')
  idempotencyKey!: string;
}

export class ResubmitMileageDto extends CreateMileageDto {
  @ApiProperty({
    description: 'Opaque submissionVersion returned by the current detail.',
    pattern: '^[0-9a-f]{64}$',
  })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  submissionVersion!: string;
}

export class MileageListQueryDto extends DateRangeQueryDto {
  @ApiPropertyOptional({ enum: ['desc', 'asc'], default: 'desc' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['desc', 'asc'])
  order?: 'desc' | 'asc';

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Opaque nextCursor from the same date range and order.',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(1024)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
}

export class MileageResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['pending', 'approved', 'rejected'] }) status!:
    'pending' | 'approved' | 'rejected';
  @ApiProperty({ format: 'date-time' }) submittedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  decidedAt!: string | null;
  @ApiProperty({ type: Number, nullable: true }) mileageAmount!: number | null;
  @ApiProperty({ type: Number, nullable: true }) finalAmount!: number | null;
  @ApiProperty({ type: String, nullable: true }) rejectionReason!:
    string | null;
}

export class MileagePhotoPathsDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Authenticated API path, never a public storage URL.',
  })
  receipt!: string | null;
  @ApiProperty({ type: String, nullable: true }) meter!: string | null;
}

export class MileageDetailDto extends MileageResponseDto {
  @ApiProperty({ enum: ['single', 'separate'] }) photoMode!:
    'single' | 'separate';
  @ApiProperty({
    description: 'Opaque version of the current submitted photos.',
    pattern: '^[0-9a-f]{64}$',
  })
  submissionVersion!: string;
  @ApiProperty({ type: MileagePhotoPathsDto }) photos!: MileagePhotoPathsDto;
}

export class MileageListDto {
  @ApiProperty({ type: MileageResponseDto, isArray: true })
  items!: MileageResponseDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
