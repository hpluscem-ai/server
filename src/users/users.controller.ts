import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Req,
  Res,
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
import type { Response } from 'express';

import {
  AuthSessionGuard,
  clearWebSession,
  type AuthenticatedRequest,
} from '../auth';
import { ApiErrorResponseDto } from '../common/api-error-response.dto';
import {
  DriverProfileResponseDto,
  UpdateDriverProfileDto,
} from './driver-profile.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiCookieAuth('driver-session')
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
  findProfile(
    @Req() request: AuthenticatedRequest,
  ): Promise<DriverProfileResponseDto> {
    return this.users.findProfile(request.authSession.user.id);
  }

  @Delete('me')
  @HttpCode(204)
  @ApiOperation({
    summary: '기사 본인 회원탈퇴',
    description:
      '인증된 기사 본인만 탈퇴하며 요청의 사용자 식별자는 사용하지 않습니다. 기존 정보·영수·정산 이력은 보존하고 비밀번호·모든 세션·재설정 링크·관련 SMS 증명을 원자적으로 폐기합니다. 재가입은 새 회원 식별자로 생성하며 기존 이력을 이전하지 않습니다. 쿠키 인증은 허용된 Origin을 요구하며 성공 후 현재 쿠키를 지웁니다.',
  })
  @ApiNoContentResponse({
    description: '본인 탈퇴 및 모든 인증 정보 폐기 완료',
  })
  @ApiForbiddenResponse({
    description: 'WEB_ORIGIN_NOT_ALLOWED',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'DRIVER_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  withdraw(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    return this.users.withdrawDriver(request.authSession.user.id).then(() => {
      // 저장 실패 시 재시도할 수 있도록 트랜잭션 성공 뒤에만 쿠키를 지운다.
      if (request.authMethod === 'cookie') clearWebSession(response);
    });
  }

  @Patch('me')
  @ApiForbiddenResponse({
    description: 'WEB_ORIGIN_NOT_ALLOWED',
    type: ApiErrorResponseDto,
  })
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
  ): Promise<DriverProfileResponseDto> {
    return this.users.updateProfile(request.authSession.user.id, input);
  }
}
