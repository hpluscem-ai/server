import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import {
  DriverProfileResponseDto,
  UpdateDriverProfileDto,
} from './driver-profile.dto';
import { UsersRepository } from './users.repository';
import {
  AdminDriverListQueryDto,
  AdminDriverResponseDto,
} from './admin-driver.dto';
import { normalizeDateRange } from '../common/date-range-query';

@Injectable()
export class UsersService {
  constructor(private readonly users: UsersRepository) {}

  findDrivers(query: AdminDriverListQueryDto): AdminDriverResponseDto[] {
    return this.users
      .findDrivers({
        ...query,
        ...normalizeDateRange(query),
      })
      .map((row) => {
        if (row.phone === null)
          throw new Error('Driver phone invariant violated');
        return {
          ...row,
          phone: row.phone,
          joinedAt: `${row.joinedAt.replace(' ', 'T')}Z`,
        };
      });
  }

  findProfile(userId: string): DriverProfileResponseDto {
    return this.requireProfile(this.users.findProfile(userId));
  }

  updateProfile(
    userId: string,
    input: UpdateDriverProfileDto,
  ): DriverProfileResponseDto {
    if (input.name === undefined && input.marketingConsent === undefined) {
      throw new BadRequestException({
        code: 'PROFILE_CHANGES_REQUIRED',
        message: '변경할 성함 또는 마케팅 수신 동의 여부를 입력해 주세요.',
      });
    }
    return this.requireProfile(this.users.updateProfile(userId, input));
  }

  private requireProfile(
    profile: ReturnType<UsersRepository['findProfile']>,
  ): DriverProfileResponseDto {
    if (!profile) {
      throw new UnauthorizedException({
        code: 'INVALID_SESSION',
        message:
          '로그인이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.',
      });
    }
    // 기사 전화번호는 DB CHECK로 필수다. 불일치를 가짜 연락처로 숨기지 않는다.
    if (profile.phone === null)
      throw new Error('Driver phone invariant violated');
    return { ...profile, phone: profile.phone };
  }
}
