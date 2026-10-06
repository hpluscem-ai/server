import {
  BadRequestException,
  Injectable,
  NotFoundException,
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

  async findDrivers(
    query: AdminDriverListQueryDto,
  ): Promise<AdminDriverResponseDto[]> {
    const rows = await this.users.findDrivers({
      ...query,
      ...normalizeDateRange(query),
    });
    return rows.map((row) => {
      if (row.phone === null)
        throw new Error('Driver phone invariant violated');
      const totalAmount = Number(row.totalAmount);
      const mileage = Number(row.mileage);
      if (
        !Number.isSafeInteger(totalAmount) ||
        totalAmount < 0 ||
        !Number.isSafeInteger(mileage) ||
        mileage < 0
      )
        throw new Error('Driver totals invariant violated');
      return {
        ...row,
        totalAmount,
        mileage,
        phone: row.phone,
        joinedAt: isoTimestamp(row.joinedAt),
      };
    });
  }

  async findProfile(userId: string): Promise<DriverProfileResponseDto> {
    return this.requireProfile(await this.users.findProfile(userId));
  }

  async withdrawDriver(userId: string): Promise<void> {
    if (!(await this.users.withdrawDriver(userId))) {
      throw new NotFoundException({
        code: 'DRIVER_NOT_FOUND',
        message: '탈퇴 처리할 기사를 찾을 수 없습니다.',
      });
    }
  }

  async updateProfile(
    userId: string,
    input: UpdateDriverProfileDto,
  ): Promise<DriverProfileResponseDto> {
    if (input.name === undefined && input.marketingConsent === undefined) {
      throw new BadRequestException({
        code: 'PROFILE_CHANGES_REQUIRED',
        message: '변경할 성함 또는 마케팅 수신 동의 여부를 입력해 주세요.',
      });
    }
    return this.requireProfile(await this.users.updateProfile(userId, input));
  }

  private requireProfile(
    profile: Awaited<ReturnType<UsersRepository['findProfile']>>,
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

function isoTimestamp(value: string): string {
  const normalized = value.replace(' ', 'T');
  const withZone = /[+-]\d{2}$/.test(normalized)
    ? `${normalized}:00`
    : /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(normalized)
      ? normalized
      : `${normalized}Z`;
  const timestamp = new Date(withZone);
  if (!Number.isFinite(timestamp.getTime()))
    throw new Error('Invalid driver timestamp');
  return timestamp.toISOString();
}
