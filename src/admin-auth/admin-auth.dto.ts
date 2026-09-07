import { ApiProperty } from '@nestjs/swagger';

export class CurrentAdminResponseDto {
  @ApiProperty({ description: '인증된 관리자 식별자', format: 'uuid' })
  id!: string;
  @ApiProperty({ description: '인증된 관리자 이메일' })
  email!: string;
  @ApiProperty({ description: '인증된 관리자 이름' })
  name!: string;
}
