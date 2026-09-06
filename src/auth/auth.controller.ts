import {
  Body,
  Controller,
  Header,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../common/api-error-response.dto';
import { LoginRequestDto, LoginResponseDto } from './auth-login.dto';
import { SignUpRequestDto, SignUpResponseDto } from './auth-signup.dto';
import { AuthService } from './auth.service';
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
      '이메일과 비밀번호를 확인하고 활성 기사·소속에만 세션을 발급합니다. 다중 기기 로그인을 허용하며 최대 만료 시각은 로그인 시점부터 30일입니다. 세션 검증·미사용 7일 만료·로그아웃은 다음 단계에서 구현합니다.',
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

  @Post('phone-verifications')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '회원가입용 SMS 인증번호 발송',
    description:
      'SOLAPI 접수 성공 후 3분간 유효합니다. 재발송 요청 시 이전 인증번호와 증명을 즉시 무효화하며, 발송 실패 시에도 복구하지 않습니다. 다른 인증 목적은 아직 지원하지 않습니다.',
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
    return this.authService.sendPhoneVerification(input.phone);
  }

  @Post('phone-verifications/:verificationId/confirm')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '회원가입용 SMS 인증번호 확인',
    description:
      '확인 성공 시 일회용 가입 증명을 발급합니다. 원래 3분 만료 시각은 연장하지 않으며 같은 인증번호를 다시 확인할 수 없습니다.',
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
