import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { DateRangeQueryDto } from '../common/date-range-query';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const queryNumber = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value)
    : value;

export class CreateStationDeviceDto {
  @ApiProperty({ description: '설치 기기 모델명' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model!: string;

  @ApiProperty({
    description: '설치 기기 용량(L). 단위와 쉼표가 없는 양의 정수',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  capacityLiters!: number;
}

export class UpdateStationDeviceDto extends CreateStationDeviceDto {
  @ApiPropertyOptional({
    description: '기존 기기 식별자. 새 기기를 추가할 때만 생략',
    format: 'uuid',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID('4')
  id?: string;
}

export class CreateStationDto {
  @ApiProperty({ description: 'Pole(주유소 브랜드)' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  pole!: string;

  @ApiProperty({ description: '주유소 업체명' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  businessName!: string;

  @ApiProperty({
    description: '소재지. 실제 값을 입력하며 주소에서 임의 추출하지 않음',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  area!: string;

  @ApiProperty({ description: '시/군/구가 포함된 설치 도로명 주소' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/[가-힣]+(?:시|군|구)(?:\s|$)/)
  roadAddress!: string;

  @ApiProperty({
    description: '주유소 또는 직판 구분',
    enum: ['station', 'direct_sales'],
  })
  @IsIn(['station', 'direct_sales'])
  siteType!: 'station' | 'direct_sales';

  @ApiPropertyOptional({
    description: '비고(예: 셀프). 생략하면 비고 없음으로 저장',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiProperty({
    description: '입력한 WGS84 위도. 입력만으로 좌표 검증 완료가 되지 않음',
    minimum: -90,
    maximum: 90,
  })
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @ApiProperty({
    description: '입력한 WGS84 경도. 입력만으로 좌표 검증 완료가 되지 않음',
    minimum: -180,
    maximum: 180,
  })
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @ApiProperty({
    description: '이 주유소에 함께 등록할 설치 기기',
    type: [CreateStationDeviceDto],
    minItems: 1,
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => CreateStationDeviceDto)
  devices!: CreateStationDeviceDto[];
}

export class UpdateStationDto extends OmitType(CreateStationDto, [
  'devices',
] as const) {
  @ApiProperty({
    description:
      '저장할 기기 전체: 기존 기기는 ID 포함, 추가 기기는 ID 생략. 빠진 기존 기기는 실제 삭제. 최소 1개 필수',
    type: [UpdateStationDeviceDto],
    minItems: 1,
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => UpdateStationDeviceDto)
  devices!: UpdateStationDeviceDto[];
}

export class StationDeviceResponseDto extends CreateStationDeviceDto {
  @ApiProperty({ description: '설치 기기 식별자', format: 'uuid' })
  id!: string;

  @ApiProperty({
    description: '기기 운영 여부. 이 API에서 임의로 변경하지 않음',
  })
  active!: boolean;
}

export class StationResponseDto extends OmitType(CreateStationDto, [
  'devices',
  'note',
  'latitude',
  'longitude',
] as const) {
  @ApiProperty({
    description: '명칭·주소가 바뀌어도 유지되는 주유소 식별자',
    format: 'uuid',
  })
  id!: string;

  @ApiProperty({ description: '비고', type: String, nullable: true })
  note!: string | null;

  @ApiProperty({
    description:
      '입력된 WGS84 위도. 별도 검수 없이 제공하며 실제 좌표가 없으면 null',
    type: Number,
    nullable: true,
  })
  latitude!: number | null;

  @ApiProperty({
    description:
      '입력된 WGS84 경도. 별도 검수 없이 제공하며 실제 좌표가 없으면 null',
    type: Number,
    nullable: true,
  })
  longitude!: number | null;

  @ApiProperty({
    description: '좌표·검증 출처·유효한 확인 시각이 모두 있는지 여부',
  })
  coordinateVerified!: boolean;

  @ApiProperty({
    description: '기존 좌표 검증 출처. 등록·수정 요청에서 임의 생성하지 않음',
    type: String,
    nullable: true,
  })
  coordinateSource!: string | null;

  @ApiProperty({
    description: '기존 좌표 마지막 확인 시각(UTC)',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  coordinateVerifiedAt!: string | null;

  @ApiProperty({
    description: '주유소 운영 여부. 기사 조회에는 운영 중인 주유소만 포함',
  })
  active!: boolean;

  @ApiProperty({
    description: '설치 기기 배열. 각 기기의 운영 여부를 포함',
    type: [StationDeviceResponseDto],
  })
  devices!: StationDeviceResponseDto[];

  @ApiProperty({ description: '등록 시각(UTC)', format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    description: '주유소 또는 기기 변경 시각(UTC)',
    format: 'date-time',
  })
  updatedAt!: string;
}

export class AdminStationListQueryDto extends DateRangeQueryDto {
  @ApiPropertyOptional({
    description:
      '주유소명 부분 검색. 앞뒤 공백·대소문자를 무시하고 특수문자는 그대로 검색',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  stationQuery?: string;
}

export class StationBoundsQueryDto {
  @ApiProperty({ description: '남서쪽 위도(포함)', minimum: -90, maximum: 90 })
  @Transform(queryNumber)
  @IsNumber()
  @Min(-90)
  @Max(90)
  south!: number;

  @ApiProperty({
    description: '남서쪽 경도(포함). west > east는 날짜변경선을 지나는 범위',
    minimum: -180,
    maximum: 180,
  })
  @Transform(queryNumber)
  @IsNumber()
  @Min(-180)
  @Max(180)
  west!: number;

  @ApiProperty({ description: '북동쪽 위도(포함)', minimum: -90, maximum: 90 })
  @Transform(queryNumber)
  @IsNumber()
  @Min(-90)
  @Max(90)
  north!: number;

  @ApiProperty({
    description: '북동쪽 경도(포함)',
    minimum: -180,
    maximum: 180,
  })
  @Transform(queryNumber)
  @IsNumber()
  @Min(-180)
  @Max(180)
  east!: number;
}
