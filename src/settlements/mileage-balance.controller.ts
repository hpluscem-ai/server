import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthSessionGuard, type AuthenticatedRequest } from '../auth';
import { ApiErrorResponseDto } from '../common/api-error-response.dto';
import { DateRangeQueryDto } from '../common/date-range-query';
import { SettlementsService } from './settlements.service';

@Controller('mileage/summary')
@UseGuards(AuthSessionGuard)
@ApiTags('Driver mileage')
@ApiBearerAuth()
@ApiCookieAuth('driver-session')
export class MileageBalanceController {
  constructor(private readonly settlements: SettlementsService) {}
  @Get()
  @ApiOperation({
    summary: '본인의 기간별 전체 적립 합계',
    description:
      '신청일 기준 시작 포함·끝 제외. 기간 내 approved 신청의 마일리지를 정산 완료 여부와 관계없이 서버에서 모두 합산한다. 대기·반려는 제외하며 목록 페이지·정렬에 영향받지 않는다. 기간 생략 시 전체 기간을 합산한다.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['accumulatedMileage'],
      properties: { accumulatedMileage: { type: 'integer', minimum: 0 } },
    },
  })
  @ApiBadRequestResponse({
    type: ApiErrorResponseDto,
    description: 'VALIDATION_ERROR | INVALID_DATE_RANGE',
  })
  async balance(
    @Req() request: AuthenticatedRequest,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.settlements.balance(request.authSession.user.id, query);
  }
}
