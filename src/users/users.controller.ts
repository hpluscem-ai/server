import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthSessionGuard, type AuthenticatedRequest } from '../auth';
import { ApiErrorResponseDto } from '../common/api-error-response.dto';
import {
  DriverProfileResponseDto,
  UpdateDriverProfileDto,
} from './driver-profile.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(AuthSessionGuard)
@ApiUnauthorizedResponse({
  description: 'INVALID_SESSION',
  type: ApiErrorResponseDto,
})
@ApiInternalServerErrorResponse({
  description: 'INTERNAL_SERVER_ERROR',
  type: ApiErrorResponseDto,
})
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({
    summary: '기사 본인 정보 조회',
    description:
      '기사 세션의 본인 이메일·성함·연락처·마케팅 동의만 반환합니다. 요청에서 사용자 식별자를 받지 않습니다.',
  })
  @ApiOkResponse({ type: DriverProfileResponseDto })
  findProfile(@Req() request: AuthenticatedRequest): DriverProfileResponseDto {
    return this.users.findProfile(request.authSession.user.id);
  }

  @Patch('me')
  @ApiOperation({
    summary: '기사 본인 일반 정보 수정',
    description:
      '성함 또는 마케팅 동의를 하나 이상 전달합니다. 생략한 필드는 유지하며 null과 다른 필드는 허용하지 않습니다. 이메일·연락처·비밀번호·소속은 변경하지 않습니다.',
  })
  @ApiOkResponse({ type: DriverProfileResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_ERROR | PROFILE_CHANGES_REQUIRED',
    type: ApiErrorResponseDto,
  })
  updateProfile(
    @Req() request: AuthenticatedRequest,
    @Body() input: UpdateDriverProfileDto,
  ): DriverProfileResponseDto {
    return this.users.updateProfile(request.authSession.user.id, input);
  }
}
