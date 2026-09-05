import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiTags,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../common/api-error-response.dto';
import { SignUpRequestDto, SignUpResponseDto } from './auth-signup.dto';
import { AuthService } from './auth.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
