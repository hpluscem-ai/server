import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiInternalServerErrorResponse,
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
@ApiBearerAuth('admin')
export class AdminDriversController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({
    summary: '관리자 기사 기본 목록',
    description:
      '탈퇴 처리되지 않은 기사를 최신 가입순으로 조회하며 같은 시각은 식별자로 정렬합니다. 물류사가 비활성 상태여도 기사는 조회할 수 있습니다. 이름·소속·기간만 필터링하며 기간 생략 시 임의 기본 기간을 적용하지 않습니다. 금액·마일리지 합계와 탈퇴 API는 정책 미정으로 미제공입니다. 현재 화면에 없는 페이지 처리와 추가 정렬 옵션은 제공하지 않습니다.',
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
}
