import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  HttpCode,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import {
  AdminSessionGuard,
  type AdminAuthenticatedRequest,
} from '../admin-auth';
import { invalid } from './settlement-policy';
import { maxFileBytes } from './settlement-excel';
import { ApiErrorResponseDto } from '../common/api-error-response.dto';
import {
  SettlementCompanyDto,
  SettlementImportDto,
  DashboardResponseDto,
} from './settlement-response.dto';
import { SettlementsService } from './settlements.service';

class MonthQuery {
  @ApiProperty({ example: '2026-08' })
  @IsString()
  @Matches(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/)
  month!: string;
}
class DashboardQuery {
  @ApiProperty({ example: '2026-08-01' }) @IsString() from!: string;
  @ApiProperty({ example: '2026-08-31' }) @IsString() through!: string;
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      '차트의 소속 계열에만 적용. 카드·최근 내역·공통 계열은 전체 소속.',
  })
  @IsOptional()
  @IsUUID('4')
  logisticsCompanyId?: string;
}

@ApiBadRequestResponse({
  type: ApiErrorResponseDto,
  description:
    'VALIDATION_ERROR | SETTLEMENT_FILE_INVALID | SETTLEMENT_ROW_MISMATCH | SETTLEMENT_DUPLICATE_ROW | SETTLEMENT_EXPORT_EMPTY | SETTLEMENT_SNAPSHOT_MISSING | SETTLEMENT_ACCOUNT_INVALID | SETTLEMENT_AMOUNT_INVALID | SETTLEMENT_IMPORT_BUSY',
})
@ApiUnauthorizedResponse({
  type: ApiErrorResponseDto,
  description: 'INVALID_ADMIN_SESSION',
})
@ApiForbiddenResponse({
  type: ApiErrorResponseDto,
  description: 'WEB_ORIGIN_NOT_ALLOWED',
})
@ApiInternalServerErrorResponse({ type: ApiErrorResponseDto })
@Controller('admin')
@ApiTags('Admin settlements and dashboard')
@ApiCookieAuth('admin-session')
@ApiBearerAuth('admin')
@UseGuards(AdminSessionGuard)
export class SettlementsController {
  constructor(private readonly service: SettlementsService) {}

  @ApiOkResponse({ type: SettlementCompanyDto, isArray: true })
  @Get('settlements')
  @ApiOperation({
    summary: '월별 물류사 정산 조회',
    description:
      'KST 최초 신청 등록월 기준 승인·미정산 건. 해당 물류사의 등록월 파일이 이미 고정된 경우 다음 미확정 월로 이월하며, 미확정 월을 건너뛰지 않음. 첫 다운로드에 대상·마일리지(1=1원)·계좌를 고정하고 기존 정산 이력을 보존.',
  })
  list(@Query() query: MonthQuery) {
    return this.service.list(query.month);
  }

  @Post('settlements/export')
  @HttpCode(200)
  @ApiOperation({
    summary: '대량이체 XLS 다운로드 및 정산 대상 확정',
    description:
      '조회와 같은 KST 등록월·이월 조건으로 대상 확정. 월 마감 전에도 다운로드 가능. 물류사별 첫 다운로드에 정산 대상을 고정하며 다운로드는 지급 완료가 아님. 이후 추가 승인 건은 다음 미확정 월로 이월. 재다운로드는 동일한 미완료 대상. CMS코드에 정산 식별키 포함.',
  })
  @ApiProduces('application/vnd.ms-excel')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async export(
    @Query() query: MonthQuery,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const bytes = await this.service.export(
      query.month,
      request.adminSession.user.id,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(bytes, {
      type: 'application/vnd.ms-excel',
      disposition: `attachment; filename="settlements-${query.month}.xls"`,
      length: bytes.length,
    });
  }

  @ApiOkResponse({ type: SettlementImportDto })
  @Post('settlements/import')
  @HttpCode(200)
  @ApiOperation({
    summary: '지급 완료한 행의 XLS/XLSX 업로드',
    description:
      '운영자가 실제 송금 완료한 행만 제출. 은행·수취인·정수 금액을 고정 대상과 대조하며 계좌번호와 CMS코드는 대조하지 않음. 전체 이력에서 같은 은행·수취인·금액 조합이 하나여야 함. 한 행이라도 오류면 전체 미반영. 정상 일부 행만 업로드 가능. 같은 완료 행 재업로드는 변경 없음. 5MiB/10,000행. 수식·외부 링크·매크로 금지.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: maxFileBytes, files: 1, fields: 0, parts: 2 },
    }),
  )
  import(
    @Query() query: MonthQuery,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    if (!file || !/\.xlsx?$/i.test(file.originalname)) invalid();
    return this.service.import(
      query.month,
      file.buffer,
      request.adminSession.tokenHash,
    );
  }

  @ApiOkResponse({ type: DashboardResponseDto })
  @Get('dashboard')
  @ApiOperation({
    summary: '대시보드 전체 집합 집계',
    description:
      'KST 일자 양끝 포함. 누적=기간 내 승인·미정산, 예정=종료일까지 승인·미정산, 차트=기간 내 승인일별 적립(정산 완료 포함), 일치/미일치=신청일·정확한 판독 상태, 최근=신청일 최신 5건. 소속은 신청에 고정된 물류사.',
  })
  dashboard(@Query() query: DashboardQuery) {
    return this.service.dashboard(
      query.from,
      query.through,
      query.logisticsCompanyId,
    );
  }
}
