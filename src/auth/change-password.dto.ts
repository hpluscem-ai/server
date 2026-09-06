import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ChangePasswordRequestDto {
  @ApiProperty({
    description: '본인 확인을 위한 현재 비밀번호. 공백도 원문 그대로 확인',
    maxLength: 128,
    writeOnly: true,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword!: string;

  @ApiProperty({
    description: '새 비밀번호. 영문·숫자·특수문자를 각각 포함한 8~128자',
    minLength: 8,
    maxLength: 128,
    writeOnly: true,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z\d\s]).{8,}$/)
  newPassword!: string;
}
