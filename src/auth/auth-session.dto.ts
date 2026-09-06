import { ApiProperty } from '@nestjs/swagger';

export class CurrentUserResponseDto {
  @ApiProperty({ description: '인증된 기사 식별자', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: '기사 이메일', example: 'driver@example.com' })
  email!: string;

  @ApiProperty({ description: '기사 이름', example: '김기사' })
  name!: string;

  @ApiProperty({ description: '현재 소속 물류사 식별자', format: 'uuid' })
  logisticsCompanyId!: string;
}
