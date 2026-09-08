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
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
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
  MyPasswordResetEmailResponseDto,
  PasswordResetEmailResponseDto,
  RequestPasswordResetEmailDto,
  ResetPasswordRequestDto,
} from './reset-password.dto';
import { FindEmailRequestDto, FindEmailResponseDto } from './find-email.dto';
import {
  ChangePhoneRequestDto,
  ConfirmPhoneChangeVerificationDto,
  SendPhoneChangeVerificationDto,
} from './change-phone.dto';
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
      'SOLAPI 접수 성공 후 3분간 유효합니다. 같은 목적·휴대폰의 재발송은 이메일 변경 여부와 관계없이 이전 인증번호와 증명을 즉시 무효화하며 발송 실패 시에도 복구하지 않습니다. 비밀번호 찾기는 이메일·휴대폰 조합에 묶습니다. 이 API는 계정 존재 여부를 조회하지 않습니다. find-email 또는 password-reset-emails에서 목적별 증명을 소비합니다.',
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

  @Post('reset-password')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '일회용 토큰으로 기사 비밀번호 재설정',
    description:
      '메일 발송 접수 후 저장된 30분 일회용 토큰을 소비하고 새 Argon2id 비밀번호·본인 전체 세션 폐기·다른 기존 링크 무효화를 원자적으로 처리합니다. 저장된 만료 시각을 검증하며 회원가입·SMS 인증 증명과 기사/관리자 세션 토큰은 사용할 수 없습니다.',
  })
  @ApiNoContentResponse({
    description: '비밀번호 재설정·기존 링크 무효화·전체 세션 폐기 완료',
  })
  @ApiBadRequestResponse({
    description: 'VALIDATION_ERROR | PASSWORD_RESET_INVALID',
    type: ApiErrorResponseDto,
  })
  @ApiInternalServerErrorResponse({
    description: 'INTERNAL_SERVER_ERROR',
    type: ApiErrorResponseDto,
  })
  resetPassword(@Body() input: ResetPasswordRequestDto): Promise<void> {
    return this.authService.resetPassword(input);
  }

  @Post('password-reset-emails')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'SMS 인증 후 비밀번호 재설정 메일 요청',
    description:
      'reset_password 목적·이메일·연락처에 묶인 증명을 발송 전에 한 번 소비합니다. 활성 기사·소속의 일치 계정에만 Postmark로 발송하며 계정 불일치도 동일한 접수 응답입니다. 설정 누락·발송 실패·저장 오류는 성공으로 바꾸지 않습니다. Postmark 접수 후 30분 링크를 활성화하고 이전 링크를 무효화합니다. 메일 실패 시 기존 링크를 유지하고 재요청은 SMS 재인증이 필요합니다. 토큰 원문을 반환하지 않고 실제 배달 완료를 보장하지 않습니다.',
  })
  @ApiAcceptedResponse({ type: PasswordResetEmailResponseDto })
  @ApiBadRequestResponse({
    type: ApiErrorResponseDto,
    description:
      'VALIDATION_ERROR | PHONE_VERIFICATION_INVALID | PASSWORD_RESET_REQUEST_INVALID',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponseDto,
    description: 'PASSWORD_RESET_EMAIL_NOT_CONFIGURED',
  })
  @ApiBadGatewayResponse({
    type: ApiErrorResponseDto,
    description: 'PASSWORD_RESET_EMAIL_SEND_FAILED',
  })
  @ApiInternalServerErrorResponse({
    type: ApiErrorResponseDto,
    description: 'INTERNAL_SERVER_ERROR',
  })
  async requestPasswordResetEmail(
    @Body() input: RequestPasswordResetEmailDto,
  ): Promise<PasswordResetEmailResponseDto> {
    await this.authService.requestPasswordResetEmail(input);
    return {
      message:
        '요청을 접수했습니다. 입력한 정보와 일치하는 계정이 있다면 메일을 확인해 주세요.',
    };
  }

  @Post('me/password-reset-emails')
  @HttpCode(200)
  @UseGuards(AuthSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '마이페이지 SMS 재인증 후 본인 재설정 메일 요청',
    description:
      '본인 이메일과 가입 연락처로 reset_password SMS를 발송·확인한 증명이 필요합니다. 수신 이메일은 기사 세션에서만 결정하며 요청에 이메일을 허용하지 않습니다. Postmark 접수·토큰 저장 성공 시 본인 이메일을 반환합니다. 링크 30분·증명 일회용·기존 링크 무효화와 실패 정책은 공개 재설정 메일 API와 같습니다.',
  })
  @ApiOkResponse({ type: MyPasswordResetEmailResponseDto })
  @ApiBadRequestResponse({
    type: ApiErrorResponseDto,
    description:
      'VALIDATION_ERROR | PHONE_VERIFICATION_INVALID | PASSWORD_RESET_REQUEST_INVALID',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorResponseDto,
    description: 'INVALID_SESSION',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponseDto,
    description: 'PASSWORD_RESET_EMAIL_NOT_CONFIGURED',
  })
  @ApiBadGatewayResponse({
    type: ApiErrorResponseDto,
    description: 'PASSWORD_RESET_EMAIL_SEND_FAILED',
  })
  @ApiInternalServerErrorResponse({
    type: ApiErrorResponseDto,
    description: 'INTERNAL_SERVER_ERROR',
  })
  async requestMyPasswordResetEmail(
    @Req() request: AuthenticatedRequest,
    @Body() input: FindEmailRequestDto,
  ): Promise<MyPasswordResetEmailResponseDto> {
    const email = request.authSession.user.email;
    await this.authService.requestPasswordResetEmail(
      { ...input, email },
      request.authSession,
    );
    return { email };
  }

  @Post('find-email')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'SMS 인증 후 기사 이메일 찾기',
    description:
      'find_email 목적·휴대폰에 묶인 유효한 증명을 한 번 소비하고 마스킹한 이메일과 연락처 끝 4자리만 반환합니다. 미가입·탈퇴·관리자 계정은 동일한 미가입 안내를 반환하며 증명을 소비합니다. 소속 비활성화는 로그인 제한이며 이 조회를 막지 않습니다.',
  })
  @ApiOkResponse({ type: FindEmailResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_ERROR | PHONE_VERIFICATION_INVALID',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'ACCOUNT_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  @ApiInternalServerErrorResponse({
    description: 'INTERNAL_SERVER_ERROR',
    type: ApiErrorResponseDto,
  })
  findEmail(@Body() input: FindEmailRequestDto): FindEmailResponseDto {
    return this.authService.findEmail(input);
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

  @Post('phone-change/verifications')
  @UseGuards(AuthSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '본인 연락처 변경용 SMS 발송',
    description:
      '기사 세션의 본인과 새 연락처에 인증을 묶습니다. 같은 기사가 재발송하면 새 번호가 달라도 이전 변경 증명을 무효화합니다. 기존 SMS의 3분 만료·6자리·횟수 제한 없음 정책을 사용합니다.',
  })
  @ApiCreatedResponse({ type: SendPhoneVerificationResponseDto })
  @ApiBadRequestResponse({
    type: ApiErrorResponseDto,
    description: 'VALIDATION_ERROR',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorResponseDto,
    description: 'INVALID_SESSION',
  })
  @ApiConflictResponse({
    type: ApiErrorResponseDto,
    description: 'PHONE_VERIFICATION_SUPERSEDED',
  })
  @ApiBadGatewayResponse({
    type: ApiErrorResponseDto,
    description: 'SMS_SEND_FAILED',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponseDto,
    description: 'SMS_NOT_CONFIGURED | PHONE_VERIFICATION_NOT_CONFIGURED',
  })
  @ApiInternalServerErrorResponse({
    type: ApiErrorResponseDto,
    description: 'INTERNAL_SERVER_ERROR',
  })
  sendPhoneChangeVerification(
    @Req() request: AuthenticatedRequest,
    @Body() input: SendPhoneChangeVerificationDto,
  ): Promise<SendPhoneVerificationResponseDto> {
    return this.authService.sendPhoneChangeVerification(
      request.authSession,
      input.phone,
    );
  }

  @Post('phone-change/verifications/:verificationId/confirm')
  @HttpCode(200)
  @UseGuards(AuthSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '본인 연락처 변경용 SMS 확인',
    description:
      '같은 기사가 발송한 미사용 인증만 확인합니다. 발송 시의 만료 시각은 연장하지 않습니다.',
  })
  @ApiOkResponse({ type: ConfirmPhoneVerificationResponseDto })
  @ApiBadRequestResponse({
    type: ApiErrorResponseDto,
    description:
      'VALIDATION_ERROR | PHONE_VERIFICATION_INVALID | PHONE_VERIFICATION_CODE_MISMATCH',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorResponseDto,
    description: 'INVALID_SESSION',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponseDto,
    description: 'PHONE_VERIFICATION_NOT_CONFIGURED',
  })
  @ApiInternalServerErrorResponse({
    type: ApiErrorResponseDto,
    description: 'INTERNAL_SERVER_ERROR',
  })
  confirmPhoneChangeVerification(
    @Req() request: AuthenticatedRequest,
    @Param() params: PhoneVerificationParamsDto,
    @Body() input: ConfirmPhoneChangeVerificationDto,
  ): ConfirmPhoneVerificationResponseDto {
    return this.authService.confirmPhoneVerification(
      params.verificationId,
      input.code,
      'change_phone',
      request.authSession.user.id,
    );
  }

  @Post('change-phone')
  @HttpCode(204)
  @UseGuards(AuthSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'SMS 인증 후 본인 연락처 변경',
    description:
      '본인·새 연락처·변경 목적에 묶인 증명을 한 번 소비하고 연락처를 같은 트랜잭션에서 저장합니다. 이메일·소속·비밀번호를 변경하지 않으며 추가 비밀번호 재인증이나 세션 폐기 정책은 적용하지 않습니다.',
  })
  @ApiNoContentResponse({ description: '연락처 변경 완료' })
  @ApiBadRequestResponse({
    type: ApiErrorResponseDto,
    description: 'VALIDATION_ERROR | PHONE_VERIFICATION_INVALID',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorResponseDto,
    description: 'INVALID_SESSION',
  })
  @ApiConflictResponse({
    type: ApiErrorResponseDto,
    description: 'PHONE_ALREADY_EXISTS',
  })
  @ApiInternalServerErrorResponse({
    type: ApiErrorResponseDto,
    description: 'INTERNAL_SERVER_ERROR',
  })
  changePhone(
    @Req() request: AuthenticatedRequest,
    @Body() input: ChangePhoneRequestDto,
  ): void {
    this.authService.changePhone(request.authSession, input);
  }
}
