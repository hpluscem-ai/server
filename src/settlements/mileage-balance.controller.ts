import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthSessionGuard, type AuthenticatedRequest } from '../auth';
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
    summary: '본인의 전체 미정산 적립 합계',
    description:
      '기간·페이지와 무관하게 approved이고 정산 미완료인 신청만 서버에서 합산. 완료 파일 반영과 같은 DB 상태를 조회한다.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['accumulatedMileage'],
      properties: { accumulatedMileage: { type: 'integer', minimum: 0 } },
    },
  })
  balance(@Req() request: AuthenticatedRequest) {
    return this.settlements.balance(request.authSession.user.id);
  }
}
