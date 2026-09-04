import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'VALIDATION_ERROR' })
  code!: string;

  @ApiProperty({ example: '입력값을 확인해 주세요.' })
  message!: string;

  @ApiPropertyOptional({
    additionalProperties: {
      items: { type: 'string' },
      type: 'array',
    },
    example: { email: ['email must be an email'] },
    type: 'object',
  })
  fieldErrors?: Record<string, string[]>;
}
