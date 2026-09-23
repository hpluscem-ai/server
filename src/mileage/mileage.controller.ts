import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthSessionGuard, type AuthenticatedRequest } from '../auth';
import { ApiErrorResponseDto } from '../common/api-error-response.dto';
import {
  CreateMileageDto,
  ResubmitMileageDto,
  MileageDetailDto,
  MileageListDto,
  MileageListQueryDto,
} from './mileage.dto';
import { MileageService } from './mileage.service';
import { MileageUploadInterceptor } from './mileage-upload.interceptor';

@Controller('mileage/applications')
@ApiTags('Driver mileage')
@UseGuards(AuthSessionGuard)
@ApiBearerAuth()
@ApiCookieAuth('driver-session')
@ApiUnauthorizedResponse({
  type: ApiErrorResponseDto,
  description: 'INVALID_SESSION',
})
@ApiBadRequestResponse({
  type: ApiErrorResponseDto,
  description:
    'VALIDATION_ERROR | INVALID_DATE_RANGE | INVALID_CURSOR | INVALID_PHOTO | PHOTO_PIXEL_LIMIT',
})
@ApiInternalServerErrorResponse({
  type: ApiErrorResponseDto,
  description: 'INTERNAL_SERVER_ERROR',
})
export class MileageController {
  constructor(private readonly mileage: MileageService) {}

  @Post()
  @UseInterceptors(MileageUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: '사진 두 장과 마일리지 신청 접수',
    description:
      '영수증·계기판 각 50MiB 이하, 원본 최대 60,000,000픽셀. JPEG/PNG/HEIC/HEIF를 실제 디코딩하고 방향 보정·sRGB JPEG 품질 90·긴 변 4096px 이하로 정규화합니다. 원본·정규화본은 비공개 보관합니다. 두 사진과 신청 DB 저장이 모두 성공하면 pending입니다. OCR·자동 승인·금액 계산은 하지 않습니다. 같은 사용자/UUID/원본 바이트는 기존 신청을 반환하며 다른 바이트는 409입니다. 키는 신청 기록과 함께 유지합니다. 동시 처리 제한·일시 장애에는 같은 키와 원본으로 재시도합니다.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['idempotencyKey', 'receipt', 'meter'],
      properties: {
        idempotencyKey: { type: 'string', format: 'uuid' },
        receipt: { type: 'string', format: 'binary' },
        meter: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiCreatedResponse({
    type: MileageDetailDto,
    description:
      '신규 접수 또는 동일 요청 재전송의 기존 신청. 미확정 금액은 null.',
  })
  @ApiConflictResponse({
    type: ApiErrorResponseDto,
    description: 'IDEMPOTENCY_CONFLICT',
  })
  @ApiForbiddenResponse({
    type: ApiErrorResponseDto,
    description: 'WEB_ORIGIN_NOT_ALLOWED',
  })
  @ApiNotFoundResponse({
    type: ApiErrorResponseDto,
    description:
      'MILEAGE_APPLICATION_NOT_FOUND (이미 정산 완료된 요청 재전송 포함)',
  })
  @ApiResponse({
    status: 413,
    type: ApiErrorResponseDto,
    description: 'PHOTO_TOO_LARGE',
  })
  @ApiResponse({
    status: 415,
    type: ApiErrorResponseDto,
    description: 'MULTIPART_REQUIRED | UNSUPPORTED_PHOTO_TYPE',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponseDto,
    description:
      'PHOTO_STORAGE_UNAVAILABLE | PHOTO_PROCESSING_BUSY | PHOTO_PROCESSING_TIMEOUT',
  })
  create(
    @Req() request: AuthenticatedRequest,
    @Body() input: CreateMileageDto,
    @UploadedFiles()
    files: { receipt?: Express.Multer.File[]; meter?: Express.Multer.File[] },
  ): Promise<MileageDetailDto> {
    return this.mileage.create(request.authSession, input, files);
  }

  @Post(':id/resubmit')
  @HttpCode(200)
  @UseInterceptors(MileageUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: '본인 반려 신청 재등록',
    description:
      '본인 소유·반려·정산 미편입·현재 submissionVersion을 확인합니다. 선택한 사진 한 장 또는 두 장만 교체하고 같은 신청 ID와 최초 신청일을 유지합니다. 동일 파일 재선택도 허용합니다. 심사/OCR 파생값 초기화와 설정된 OCR 작업 등록은 원자적입니다. 원신청 키는 유지하며 재등록 키는 별도 보관합니다. 같은 키/버전/원본 바이트 재전송은 추가 처리 없이 최신 상세를 반환합니다. 과거 요청 재전송은 최신 상태를 되돌리지 않습니다. 새 선택에는 새 키를 사용합니다.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['idempotencyKey', 'submissionVersion'],
      anyOf: [{ required: ['receipt'] }, { required: ['meter'] }],
      properties: {
        idempotencyKey: { type: 'string', format: 'uuid' },
        submissionVersion: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        receipt: { type: 'string', format: 'binary' },
        meter: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOkResponse({ type: MileageDetailDto })
  @ApiConflictResponse({
    type: ApiErrorResponseDto,
    description: 'IDEMPOTENCY_CONFLICT | MILEAGE_RESUBMISSION_CONFLICT',
  })
  @ApiNotFoundResponse({
    type: ApiErrorResponseDto,
    description: 'MILEAGE_APPLICATION_NOT_FOUND',
  })
  @ApiForbiddenResponse({
    type: ApiErrorResponseDto,
    description: 'WEB_ORIGIN_NOT_ALLOWED',
  })
  @ApiResponse({
    status: 413,
    type: ApiErrorResponseDto,
    description: 'PHOTO_TOO_LARGE',
  })
  @ApiResponse({
    status: 415,
    type: ApiErrorResponseDto,
    description: 'MULTIPART_REQUIRED | UNSUPPORTED_PHOTO_TYPE',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponseDto,
    description:
      'PHOTO_STORAGE_UNAVAILABLE | PHOTO_PROCESSING_BUSY | PHOTO_PROCESSING_TIMEOUT',
  })
  resubmit(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: ResubmitMileageDto,
    @UploadedFiles()
    files: { receipt?: Express.Multer.File[]; meter?: Express.Multer.File[] },
  ): Promise<MileageDetailDto> {
    return this.mileage.resubmit(request.authSession, id, input, files);
  }

  @Get()
  @ApiOperation({
    summary: '본인 신청 목록',
    description:
      '신청 시각 기준 시작 포함·끝 제외. UTC/명시적 오프셋을 사용하며 기간 생략 시 제한하지 않습니다. 기본 최신순 20건, 최대 100건. 시각과 ID를 같은 방향으로 정렬합니다. nextCursor는 동일 기간·정렬에만 사용합니다. 본인 내역 중 정산 완료 건만 제외하며 정산 대기 건은 유지합니다. 조회 실패를 빈 내역으로 반환하지 않습니다.',
  })
  @ApiOkResponse({ type: MileageListDto })
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: MileageListQueryDto,
  ): MileageListDto {
    return this.mileage.findList(request.authSession.user.id, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: '본인 신청 상세',
    description:
      '타인·없는 신청·정산 완료는 모두 404입니다. 사진 경로는 인증이 필요한 서버 경로이며 공개 URL이나 저장소 키를 반환하지 않습니다.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: MileageDetailDto })
  @ApiNotFoundResponse({
    type: ApiErrorResponseDto,
    description: 'MILEAGE_APPLICATION_NOT_FOUND',
  })
  detail(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): MileageDetailDto {
    return this.mileage.findOne(request.authSession.user.id, id);
  }

  @Get(':id/photos/:kind')
  @ApiOperation({
    summary: '본인 제출 사진 열람',
    description:
      '매 요청과 저장소 읽기 후 세션·소유권을 검사합니다. 정규화된 JPEG만 반환합니다. 타인·없는 신청·정산 완료는 404, 파일 유실·저장소 장애는 503입니다. 원본 열람·자동 삭제 API는 제공하지 않습니다.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'kind', enum: ['receipt', 'meter'] })
  @ApiProduces('image/jpeg')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @ApiNotFoundResponse({
    type: ApiErrorResponseDto,
    description: 'MILEAGE_APPLICATION_NOT_FOUND',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponseDto,
    description: 'PHOTO_STORAGE_UNAVAILABLE',
  })
  async photo(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('kind') kind: string,
  ): Promise<StreamableFile> {
    const content = await this.mileage.photo(request.authSession, id, kind);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(content, {
      type: 'image/jpeg',
      disposition: `inline; filename="${kind}.jpg"`,
      length: content.length,
    });
  }
}
