import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class AdminMileageQueryDto {
  @ApiPropertyOptional({
    description:
      '기사 이름 부분 검색. 공백·대소문자를 무시하고 특수문자는 그대로 검색합니다.',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  nameQuery?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: '신청에 보존된 소속 물류사 식별자',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID('4')
  logisticsCompanyId?: string;
}

export class RejectAdminMileageDto {
  @ApiProperty({
    description:
      '조회한 신청·사진의 reviewVersion. 인증 토큰이 아닌 변경 감지 값입니다.',
  })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  reviewVersion!: string;
}

export class AdminMileagePhotoPathsDto {
  @ApiProperty({ type: String, nullable: true }) receipt!: string | null;
  @ApiProperty({ type: String, nullable: true }) meter!: string | null;
}

export class AdminMileageResponseDto {
  @ApiProperty({
    description:
      '심사 입력·사진 식별자의 변경 감지 값. 변경된 신청은 재조회 후 심사해야 합니다.',
  })
  reviewVersion!: string;
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ format: 'uuid' }) logisticsCompanyId!: string;
  @ApiProperty() logisticsCompanyName!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ type: Number, nullable: true }) receiptAmount!: number | null;
  @ApiProperty({ type: Number, nullable: true }) meterAmount!: number | null;
  @ApiProperty({ type: Number, nullable: true }) finalAmount!: number | null;
  @ApiProperty({ type: Number, nullable: true }) mileageAmount!: number | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  receiptAt!: string | null;
  @ApiProperty({
    enum: [
      'pending',
      'matched',
      'mismatched',
      'ocr_failed',
      'duplicate_suspected',
    ],
  })
  matchStatus!:
    'pending' | 'matched' | 'mismatched' | 'ocr_failed' | 'duplicate_suspected';
  @ApiProperty({ enum: ['pending', 'approved', 'rejected'] }) status!:
    'pending' | 'approved' | 'rejected';
  @ApiProperty({ type: String, nullable: true }) rejectionReason!:
    string | null;
  @ApiProperty({ format: 'date-time' }) submittedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  decidedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) settlementId!:
    string | null;
  @ApiProperty({ type: AdminMileagePhotoPathsDto })
  photos!: AdminMileagePhotoPathsDto;
}
