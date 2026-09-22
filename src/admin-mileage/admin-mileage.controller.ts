import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  AdminSessionGuard,
  type AdminAuthenticatedRequest,
} from '../admin-auth';
import { ApiErrorResponseDto } from '../common/api-error-response.dto';
import {
  AdminMileageQueryDto,
  AdminMileageResponseDto,
  RejectAdminMileageDto,
} from './admin-mileage.dto';
import { AdminMileageService } from './admin-mileage.service';

@Controller('admin/mileage/applications')
@ApiTags('Admin mileage')
@UseGuards(AdminSessionGuard)
@ApiCookieAuth('admin-session')
@ApiBearerAuth('admin')
@ApiUnauthorizedResponse({
  type: ApiErrorResponseDto,
  description: 'INVALID_ADMIN_SESSION',
})
@ApiBadRequestResponse({
  type: ApiErrorResponseDto,
  description: 'VALIDATION_ERROR | BAD_REQUEST',
})
@ApiInternalServerErrorResponse({
  type: ApiErrorResponseDto,
  description: 'INTERNAL_SERVER_ERROR',
})
export class AdminMileageController {
  constructor(private readonly mileage: AdminMileageService) {}

  @Get()
  @ApiOperation({
    summary: '관리자 영수 신청 목록',
    description:
      '신청 시각·ID 최신순. 이름과 신청 소속으로 검색합니다. 탈퇴 기사·비활성 물류사·정산 완료 이력을 포함합니다. 미확정 금액은 null이며 OCR·심사 결과를 생성하지 않습니다. 현재 관리자 목록과 같이 페이지 처리 없이 반환합니다.',
  })
  @ApiOkResponse({ type: AdminMileageResponseDto, isArray: true })
  list(@Query() query: AdminMileageQueryDto): AdminMileageResponseDto[] {
    return this.mileage.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: '관리자 영수 신청 상세',
    description:
      '사진은 관리자 인증 경로만 제공하며 저장소 키·원본 URL은 노출하지 않습니다.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminMileageResponseDto })
  @ApiNotFoundResponse({
    type: ApiErrorResponseDto,
    description: 'MILEAGE_APPLICATION_NOT_FOUND',
  })
  detail(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): AdminMileageResponseDto {
    return this.mileage.detail(id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({
    summary: '대기 신청 반려',
    description:
      '필수 사유와 조회 시 reviewVersion을 제출합니다. 대기·정산 미편입 신청만 원자적으로 반려합니다. 같은 사진·입력에 대한 동일 사유 재전송은 기존 결과를 반환하며 decidedAt을 다시 쓰지 않습니다. 다른 사유·심사 결과·사진/입력 변경은 409입니다. 승인·승인 취소는 지원하지 않습니다.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminMileageResponseDto })
  @ApiForbiddenResponse({
    type: ApiErrorResponseDto,
    description: 'WEB_ORIGIN_NOT_ALLOWED',
  })
  @ApiConflictResponse({
    type: ApiErrorResponseDto,
    description: 'MILEAGE_REVIEW_CONFLICT',
  })
  @ApiNotFoundResponse({
    type: ApiErrorResponseDto,
    description: 'MILEAGE_APPLICATION_NOT_FOUND',
  })
  reject(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: RejectAdminMileageDto,
  ): AdminMileageResponseDto {
    return this.mileage.reject(id, body);
  }

  @Get(':id/photos/:kind')
  @ApiOperation({
    summary: '관리자 제출 사진 열람',
    description:
      '기존 비공개 저장소의 정규화 JPEG만 반환합니다. 읽기 후 관리자 세션과 사진 연결을 다시 검사합니다. 파일 유실·저장소 장애는 503이며 원본은 제공하지 않습니다.',
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
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('kind') kind: string,
  ): Promise<StreamableFile> {
    const content = await this.mileage.photo(request.adminSession, id, kind);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(content, {
      type: 'image/jpeg',
      disposition: `inline; filename="${kind}.jpg"`,
      length: content.length,
    });
  }
}
