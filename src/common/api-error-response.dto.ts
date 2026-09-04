import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiErrorResponseDto {
  @ApiProperty({ description: 'HTTP 상태 코드', example: 400 })
  statusCode!: number;

  @ApiProperty({ description: '서버 오류 코드', example: 'VALIDATION_ERROR' })
  code!: string;

  @ApiProperty({
    description: '사용자에게 표시할 오류 메시지',
    example: '입력값을 확인해 주세요.',
  })
  message!: string;

  @ApiPropertyOptional({
    additionalProperties: {
      items: { type: 'string' },
      type: 'array',
    },
    description: '필드별 입력 오류 메시지',
    example: { email: ['email must be an email'] },
    type: 'object',
  })
  fieldErrors?: Record<string, string[]>;
}
