import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../common/api-error-response.dto';
import { LoginRequestDto, LoginResponseDto } from './auth-login.dto';
import { CurrentUserResponseDto } from './auth-session.dto';
import {
  AuthSessionGuard,
  type AuthenticatedRequest,
} from './auth-session.guard';
import { SignUpRequestDto, SignUpResponseDto } from './auth-signup.dto';
import { AuthService } from './auth.service';
import { ChangePasswordRequestDto } from './change-password.dto';
import {
  ConfirmPhoneVerificationRequestDto,
  ConfirmPhoneVerificationResponseDto,
  PhoneVerificationParamsDto,
  SendPhoneVerificationRequestDto,
  SendPhoneVerificationResponseDto,
} from './phone-verification.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '기사 로그인',
    description:
      '이메일과 비밀번호를 확인하고 활성 기사·소속에만 세션을 발급합니다. 다중 기기 로그인을 허용하며 로그인 시점부터 최대 30일 또는 미사용 7일 중 먼저 도달하는 시점에 만료됩니다. 보호된 기사 API는 Authorization: Bearer <token> 헤더를 사용합니다.',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_ERROR',
    type: ApiErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'INVALID_CREDENTIALS',
    type: ApiErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'ACCOUNT_UNAVAILABLE',
    type: ApiErrorResponseDto,
  })
  @ApiInternalServerErrorResponse({
    description: 'INTERNAL_SERVER_ERROR',
    type: ApiErrorResponseDto,
  })
  login(@Body() input: LoginRequestDto): Promise<LoginResponseDto> {
    return this.authService.login(input);
  }

  @Get('me')
  @UseGuards(AuthSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '현재 기사 세션 확인',
    description:
      '세션의 만료·기사·소속 상태를 확인하고 현재 기사 정보를 반환합니다. 정상 인증 시 마지막 사용 시각만 갱신하며 최대 만료 시각은 연장하지 않습니다.',
  })
  @ApiOkResponse({ type: CurrentUserResponseDto })
  @ApiUnauthorizedResponse({
    description: 'INVALID_SESSION',
    type: ApiErrorResponseDto,
  })
  @ApiInternalServerErrorResponse({
    description: 'INTERNAL_SERVER_ERROR',
    type: ApiErrorResponseDto,
  })
  me(@Req() request: AuthenticatedRequest): CurrentUserResponseDto {
    return request.authSession.user;
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '현재 기사 세션 로그아웃',
    description:
      '헤더로 인증한 현재 세션만 폐기합니다. 다른 기기의 세션은 유지하며 이미 폐기되거나 만료된 세션으로 요청하면 401을 반환합니다.',
  })
  @ApiNoContentResponse({ description: '현재 세션 로그아웃 완료' })
  @ApiUnauthorizedResponse({
    description: 'INVALID_SESSION',
    type: ApiErrorResponseDto,
  })
  @ApiInternalServerErrorResponse({
    description: 'INTERNAL_SERVER_ERROR',
    type: ApiErrorResponseDto,
  })
  logout(@Req() request: AuthenticatedRequest): void {
    this.authService.logout(request.authSession.tokenHash);
  }

  @Post('change-password')
  @HttpCode(204)
  @UseGuards(AuthSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '로그인한 기사의 비밀번호 변경',
    description:
      '현재 비밀번호를 확인하고 새 Argon2id 해시 저장과 모든 기기 세션 폐기를 함께 처리합니다. 성공하면 다시 로그인해야 합니다. 이메일 링크를 사용하는 비밀번호 찾기·재설정과 별개입니다.',
  })
  @ApiNoContentResponse({ description: '비밀번호 변경 및 전체 세션 폐기 완료' })
  @ApiBadRequestResponse({
    description: 'VALIDATION_ERROR | CURRENT_PASSWORD_MISMATCH',
    type: ApiErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'INVALID_SESSION',
    type: ApiErrorResponseDto,
  })
  @ApiInternalServerErrorResponse({
    description: 'INTERNAL_SERVER_ERROR',
    type: ApiErrorResponseDto,
  })
  changePassword(
    @Req() request: AuthenticatedRequest,
    @Body() input: ChangePasswordRequestDto,
  ): Promise<void> {
    return this.authService.changePassword(request.authSession, input);
  }

  @Post('phone-verifications')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '회원가입·이메일 찾기·비밀번호 찾기 SMS 인증번호 발송',
    description:
      'SOLAPI 접수 성공 후 3분간 유효합니다. 같은 목적·휴대폰의 재발송은 이메일 변경 여부와 관계없이 이전 인증번호와 증명을 즉시 무효화하며 발송 실패 시에도 복구하지 않습니다. 비밀번호 찾기는 이메일·휴대폰 조합에 묶습니다. 이 API는 계정 존재 여부를 조회하지 않습니다. 이메일 찾기 결과·재설정 메일 발송은 미제공입니다.',
  })
  @ApiCreatedResponse({ type: SendPhoneVerificationResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_ERROR',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'PHONE_VERIFICATION_SUPERSEDED',
    type: ApiErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'SMS_SEND_FAILED',
    type: ApiErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'SMS_NOT_CONFIGURED | PHONE_VERIFICATION_NOT_CONFIGURED',
    type: ApiErrorResponseDto,
  })
  sendPhoneVerification(
    @Body() input: SendPhoneVerificationRequestDto,
  ): Promise<SendPhoneVerificationResponseDto> {
    return this.authService.sendPhoneVerification(input);
  }

  @Post('phone-verifications/:verificationId/confirm')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '목적별 SMS 인증번호 확인',
    description:
      '발송 목적이 일치할 때 해당 목적·입력 범위에 묶인 일회용 증명을 발급합니다. 원래 3분 만료 시각은 연장하지 않으며 같은 인증번호를 다시 확인할 수 없습니다.',
  })
  @ApiOkResponse({ type: ConfirmPhoneVerificationResponseDto })
  @ApiBadRequestResponse({
    description:
      'VALIDATION_ERROR | PHONE_VERIFICATION_INVALID | PHONE_VERIFICATION_CODE_MISMATCH',
    type: ApiErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'PHONE_VERIFICATION_NOT_CONFIGURED',
    type: ApiErrorResponseDto,
  })
  confirmPhoneVerification(
    @Param() params: PhoneVerificationParamsDto,
    @Body() input: ConfirmPhoneVerificationRequestDto,
  ): ConfirmPhoneVerificationResponseDto {
    return this.authService.confirmPhoneVerification(
      params.verificationId,
      input.code,
      input.purpose,
    );
  }

  @Post('signup')
  @ApiBadRequestResponse({
    description:
      'VALIDATION_ERROR | PHONE_VERIFICATION_INVALID | LOGISTICS_COMPANY_UNAVAILABLE',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'EMAIL_ALREADY_EXISTS | PHONE_ALREADY_EXISTS',
    type: ApiErrorResponseDto,
  })
  @ApiCreatedResponse({ type: SignUpResponseDto })
  signUp(@Body() input: SignUpRequestDto): Promise<SignUpResponseDto> {
    return this.authService.signUp(input);
  }
}
