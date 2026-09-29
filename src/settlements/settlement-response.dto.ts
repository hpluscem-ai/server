import { ApiProperty, OmitType } from '@nestjs/swagger';
import { LogisticsCompanyResponseDto } from '../logistics-companies/logistics-company.dto';

export class SettlementCompanyDto extends OmitType(
  LogisticsCompanyResponseDto,
  ['createdAt', 'updatedAt'] as const,
) {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '영수증 원금이 아닌 정산 마일리지. 1마일리지=1원.',
  })
  mileage!: number;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '선택한 KST 월에 최초 등록된 승인 신청의 전체 마일리지.',
  })
  registeredMileage!: number;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description:
      '선택 월의 고정 이체 파일이 있을 때, 그 파일에 포함되지 않은 등록 건 중 아직 지급 완료되지 않은 마일리지.',
  })
  additionalUnpaidMileage!: number;
  @ApiProperty({ enum: ['pending', 'completed'], nullable: true })
  transferStatus!: 'pending' | 'completed' | null;
}
export class SettlementImportDto {
  @ApiProperty({ type: 'integer', minimum: 0 }) completed!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) alreadyCompleted!: number;
}
class ChartPointDto {
  @ApiProperty({ format: 'date' }) date!: string;
  @ApiProperty({ type: 'integer', minimum: 0 }) common!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) affiliation!: number;
}
class RecentReceiptDto {
  @ApiProperty() id!: string;
  @ApiProperty() driverName!: string;
  @ApiProperty({ format: 'date' }) date!: string;
  @ApiProperty({ enum: ['approved', 'pending', 'rejected'] }) status!: string;
  @ApiProperty({ type: 'integer', nullable: true }) mileage!: number | null;
}
class AffiliationDto {
  @ApiProperty() value!: string;
  @ApiProperty() label!: string;
}
export class DashboardResponseDto {
  @ApiProperty({ type: 'integer', minimum: 0 }) accumulatedMileage!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) settlementMileage!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) matchedCount!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) mismatchedCount!: number;
  @ApiProperty({ type: [ChartPointDto] }) chart!: ChartPointDto[];
  @ApiProperty({ type: [RecentReceiptDto] }) receipts!: RecentReceiptDto[];
  @ApiProperty({ type: [AffiliationDto] }) affiliations!: AffiliationDto[];
}
