import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
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
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { Request, Response } from 'express';

import {
  ADMIN_WEB_SESSION_COOKIE,
  assertWebOrigin,
  clearWebSession,
  LoginRequestDto,
  LoginResponseDto,
  setWebSession,
  WebLoginResponseDto,
} from '../auth';
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
      '기존 활성 관리자 계정만 로그인할 수 있습니다. ADMIN_SESSION_TTL_SECONDS에 명시한 8시간 이하의 최대 유지기간을 적용하며 기본값은 없습니다. 초기 관리자 생성·추가 미사용 만료·로그인 횟수 제한은 미제공입니다. 기사 토큰과 별도 세션을 발급하며 만료 시각을 연장하지 않습니다.',
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

  @Post('web/login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '웹 관리자 로그인',
    description:
      '허용된 Origin에서 관리자 전용 HttpOnly 쿠키를 발급합니다. 최대 8시간이며 자동 연장하지 않습니다. JSON에 세션 토큰을 포함하지 않습니다.',
  })
  @ApiOkResponse({ type: WebLoginResponseDto })
  @ApiBadRequestResponse({
    type: ApiErrorResponseDto,
    description: 'VALIDATION_ERROR',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorResponseDto,
    description: 'INVALID_CREDENTIALS',
  })
  @ApiForbiddenResponse({
    type: ApiErrorResponseDto,
    description: 'WEB_ORIGIN_NOT_ALLOWED',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponseDto,
    description: 'ADMIN_AUTH_NOT_CONFIGURED',
  })
  async webLogin(
    @Body() input: LoginRequestDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WebLoginResponseDto> {
    assertWebOrigin(request);
    const session = await this.auth.login(input);
    setWebSession(
      response,
      session.token,
      session.expiresAt,
      ADMIN_WEB_SESSION_COOKIE,
      '/api/v1/admin',
    );
    return { expiresAt: session.expiresAt };
  }

  @Get('me')
  @UseGuards(AdminSessionGuard)
  @ApiCookieAuth('admin-session')
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
  @ApiForbiddenResponse({
    type: ApiErrorResponseDto,
    description: 'WEB_ORIGIN_NOT_ALLOWED',
  })
  @HttpCode(204)
  @UseGuards(AdminSessionGuard)
  @ApiCookieAuth('admin-session')
  @ApiBearerAuth('admin')
  @ApiOperation({
    summary: '현재 관리자 세션 로그아웃',
    description:
      'Bearer 또는 쿠키로 인증한 현재 관리자 세션만 폐기합니다. 쿠키 인증 변경 요청은 허용된 Origin을 요구합니다.',
  })
  @ApiNoContentResponse({ description: '현재 관리자 세션 폐기 완료' })
  @ApiUnauthorizedResponse({
    type: ApiErrorResponseDto,
    description: 'INVALID_ADMIN_SESSION',
  })
  async logout(
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(request.adminSession.tokenHash);
    if (request.authMethod === 'cookie')
      clearWebSession(response, ADMIN_WEB_SESSION_COOKIE, '/api/v1/admin');
  }
}
