import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const bankCodes = `
  1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 19 20 21 22 23 24 25 26
  27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 48 49 50
  51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 71 72 73 74 75 76
  81 82 83 84 88 89 90 91 92 93 94 95 96 99 101 102 103 104 105 106 209
  218 230 238 240 243 247 261 262 263 265 266 267 268 269 270 278 279 280
  287 289 290 291
`
  .trim()
  .split(/\s+/);

export class LogisticsCompanyInputDto {
  @ApiProperty({ description: '사업자명', example: '(주)경인물류' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  businessName!: string;

  @ApiProperty({ description: '사업자등록번호', example: '123-45-67890' })
  @Transform(trim)
  @IsString()
  @Matches(/^\d{3}-\d{2}-\d{5}$/)
  businessNumber!: string;

  @ApiProperty({ description: '법인등록번호', example: '110111-0012345' })
  @Transform(trim)
  @IsString()
  @Matches(/^\d{6}-\d{7}$/)
  corporateRegistrationNumber!: string;

  @ApiProperty({
    description: '사업장 소재지',
    example: '서울시 강남구 역삼동 123',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/[가-힣]+(?:시|군|구)(?:\s|$)/)
  businessAddress!: string;

  @ApiProperty({ description: '담당자명', example: '김민수' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  managerName!: string;

  @ApiProperty({ description: '담당자 연락처', example: '010-1234-5678' })
  @Transform(trim)
  @IsString()
  @Matches(/^010-\d{4}-\d{4}$/)
  managerPhone!: string;

  @ApiProperty({
    description: '정산 계좌 은행 코드',
    enum: bankCodes,
    example: '19',
  })
  @Transform(trim)
  @IsString()
  @IsIn(bankCodes)
  bankCode!: string;

  @ApiProperty({ description: '정산 계좌번호', example: '110-456-789012' })
  @Transform(trim)
  @IsString()
  @Matches(/^(?=.*\d)[\d-]+$/)
  @MaxLength(50)
  accountNumber!: string;

  @ApiProperty({ description: '정산 계좌 예금주', example: '김민수' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  accountHolder!: string;
}

export class LogisticsCompanyResponseDto extends LogisticsCompanyInputDto {
  @ApiProperty({ description: '물류사 식별자', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: '활성 여부' })
  active!: boolean;

  @ApiProperty({ description: '등록 일시', format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ description: '수정 일시', format: 'date-time' })
  updatedAt!: string;
}

export class SignupLogisticsCompanyChoiceResponseDto {
  @ApiProperty({ description: '물류사 식별자', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: '회원가입 시 선택할 물류사 사업자명' })
  businessName!: string;
}
