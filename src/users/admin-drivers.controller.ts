import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AdminSessionGuard } from '../admin-auth';
import { ApiErrorResponseDto } from '../common/api-error-response.dto';
import {
  AdminDriverListQueryDto,
  AdminDriverResponseDto,
} from './admin-driver.dto';
import { UsersService } from './users.service';

@Controller('admin/drivers')
@ApiTags('Admin drivers')
@UseGuards(AdminSessionGuard)
@ApiCookieAuth('admin-session')
@ApiBearerAuth('admin')
export class AdminDriversController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({
    summary: '관리자 기사 기본 목록',
    description:
      '탈퇴 처리되지 않은 기사를 최신 가입순으로 조회하며 같은 시각은 식별자로 정렬합니다. 물류사가 비활성 상태여도 기사는 조회할 수 있습니다. 이름·소속·기간만 필터링하며 기간 생략 시 임의 기본 기간을 적용하지 않습니다. 금액·마일리지 합계는 정책 미정으로 미제공입니다. 현재 화면에 없는 페이지 처리와 추가 정렬 옵션은 제공하지 않습니다.',
  })
  @ApiOkResponse({ type: AdminDriverResponseDto, isArray: true })
  @ApiBadRequestResponse({
    type: ApiErrorResponseDto,
    description: 'VALIDATION_ERROR | INVALID_DATE_RANGE',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorResponseDto,
    description: 'INVALID_ADMIN_SESSION',
  })
  @ApiInternalServerErrorResponse({
    type: ApiErrorResponseDto,
    description: 'INTERNAL_SERVER_ERROR',
  })
  findAll(@Query() query: AdminDriverListQueryDto): AdminDriverResponseDto[] {
    return this.users.findDrivers(query);
  }

  @Delete(':id')
  @ApiForbiddenResponse({
    type: ApiErrorResponseDto,
    description: 'WEB_ORIGIN_NOT_ALLOWED',
  })
  @HttpCode(204)
  @ApiOperation({
    summary: '관리자 기사 탈퇴 처리',
    description:
      '이름·이메일 원문·전화번호 원문·소속과 기존 영수·정산을 보존합니다. 비밀번호·모든 세션·재설정 링크·관련 SMS 증명은 함께 폐기합니다. 재가입은 새 인증 후 새 회원 식별자로 생성하며 기존 이력을 이전하지 않습니다. 이미 탈퇴한 기사와 관리자 식별자는 404입니다.',
  })
  @ApiNoContentResponse({ description: '기사 탈퇴 및 인증 정보 폐기 완료' })
  @ApiBadRequestResponse({
    type: ApiErrorResponseDto,
    description: 'BAD_REQUEST',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorResponseDto,
    description: 'INVALID_ADMIN_SESSION',
  })
  @ApiNotFoundResponse({
    type: ApiErrorResponseDto,
    description: 'DRIVER_NOT_FOUND',
  })
  @ApiInternalServerErrorResponse({
    type: ApiErrorResponseDto,
    description: 'INTERNAL_SERVER_ERROR',
  })
  withdraw(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): void {
    this.users.withdrawDriver(id);
  }
}
