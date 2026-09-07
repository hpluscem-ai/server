import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiInternalServerErrorResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { LoginRequestDto, LoginResponseDto } from '../auth';
import { ApiErrorResponseDto } from '../common/api-error-response.dto';
import { CurrentAdminResponseDto } from './admin-auth.dto';
import { AdminAuthService } from './admin-auth.service';
import {
  AdminSessionGuard,
  type AdminAuthenticatedRequest,
} from './admin-session.guard';

@ApiTags('Admin auth')
@ApiInternalServerErrorResponse({
  type: ApiErrorResponseDto,
  description: 'INTERNAL_SERVER_ERROR',
})
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '관리자 로그인',
    description:
      '기존 활성 관리자 계정만 로그인할 수 있습니다. ADMIN_SESSION_TTL_SECONDS에 명시한 최대 유지기간을 적용하며 기본값은 없습니다. 초기 관리자 생성·추가 미사용 만료·로그인 횟수 제한은 미제공입니다. 기사 토큰과 별도 세션을 발급하며 만료 시각을 연장하지 않습니다.',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiBadRequestResponse({
    type: ApiErrorResponseDto,
    description: 'VALIDATION_ERROR',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorResponseDto,
    description: 'INVALID_CREDENTIALS',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponseDto,
    description: 'ADMIN_AUTH_NOT_CONFIGURED',
  })
  login(@Body() input: LoginRequestDto): Promise<LoginResponseDto> {
    return this.auth.login(input);
  }

  @Get('me')
  @UseGuards(AdminSessionGuard)
  @ApiBearerAuth('admin')
  @ApiOperation({ summary: '현재 관리자 확인' })
  @ApiOkResponse({ type: CurrentAdminResponseDto })
  @ApiUnauthorizedResponse({
    type: ApiErrorResponseDto,
    description: 'INVALID_ADMIN_SESSION',
  })
  me(@Req() request: AdminAuthenticatedRequest): CurrentAdminResponseDto {
    return request.adminSession.user;
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AdminSessionGuard)
  @ApiBearerAuth('admin')
  @ApiOperation({
    summary: '현재 관리자 세션 로그아웃',
    description: '헤더의 현재 관리자 세션만 폐기합니다.',
  })
  @ApiNoContentResponse({ description: '현재 관리자 세션 폐기 완료' })
  @ApiUnauthorizedResponse({
    type: ApiErrorResponseDto,
    description: 'INVALID_ADMIN_SESSION',
  })
  logout(@Req() request: AdminAuthenticatedRequest): void {
    this.auth.logout(request.adminSession.tokenHash);
  }
}
