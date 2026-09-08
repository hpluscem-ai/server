import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { normalizeDateRange } from '../common/date-range-query';
import {
  AdminStationListQueryDto,
  CreateStationDto,
  StationBoundsQueryDto,
  StationResponseDto,
  UpdateStationDto,
} from './station.dto';
import {
  StationDevicesConflictError,
  StationNotFoundError,
  StationRecord,
  StationsRepository,
} from './stations.repository';

@Injectable()
export class StationsService {
  constructor(private readonly stations: StationsRepository) {}

  findAdminList(query: AdminStationListQueryDto): StationResponseDto[] {
    return this.stations
      .findAll({ ...query, ...normalizeDateRange(query) })
      .map((station) => this.present(station));
  }

  findAppList(): StationResponseDto[] {
    return this.stations
      .findAll({}, true)
      .map((station) => this.present(station));
  }

  findMap(bounds: StationBoundsQueryDto): StationResponseDto[] {
    if (bounds.south > bounds.north)
      throw new BadRequestException({
        code: 'INVALID_MAP_BOUNDS',
        message: '남쪽 위도는 북쪽 위도보다 클 수 없습니다.',
      });
    return this.stations
      .findAll({}, true, bounds)
      .map((station) => this.present(station));
  }

  findOne(id: string, appOnly: boolean): StationResponseDto {
    const station = this.stations.findOne(id, appOnly);
    if (!station) throw this.notFound();
    return this.present(station);
  }

  create(input: CreateStationDto): StationResponseDto {
    return this.present(this.stations.create(input));
  }

  update(id: string, input: UpdateStationDto): StationResponseDto {
    try {
      return this.present(this.stations.update(id, input));
    } catch (error) {
      if (error instanceof StationNotFoundError) throw this.notFound();
      if (error instanceof StationDevicesConflictError)
        throw new ConflictException({
          code: error.reason,
          message: '이 주유소의 기기 식별자를 중복 없이 입력해 주세요.',
        });
      throw error;
    }
  }

  private notFound() {
    return new NotFoundException({
      code: 'STATION_NOT_FOUND',
      message: '주유소를 찾을 수 없습니다.',
    });
  }

  remove(id: string): void {
    if (!this.stations.remove(id)) throw this.notFound();
  }

  private present(station: StationRecord): StationResponseDto {
    const verifiedAt =
      station.coordinateVerifiedAt === null
        ? null
        : isoTimestamp(station.coordinateVerifiedAt);
    const coordinateVerified =
      station.latitude !== null &&
      station.longitude !== null &&
      Boolean(station.coordinateSource?.trim()) &&
      verifiedAt !== null;
    const createdAt = isoTimestamp(station.createdAt);
    const updatedAt = isoTimestamp(station.updatedAt);
    if (createdAt === null || updatedAt === null)
      throw new Error('Invalid station timestamps');
    return {
      id: station.id,
      pole: station.pole,
      businessName: station.businessName,
      area: station.area,
      roadAddress: station.roadAddress,
      siteType: station.siteType,
      note: station.note,
      active: station.active,
      createdAt,
      updatedAt,
      latitude: station.latitude,
      longitude: station.longitude,
      coordinateVerified,
      coordinateSource: station.coordinateSource,
      coordinateVerifiedAt: verifiedAt,
      devices: station.devices.map(({ id, model, capacityLiters, active }) => ({
        id,
        model,
        capacityLiters,
        active,
      })),
    };
  }
}

function isoTimestamp(value: string): string | null {
  const normalized = value.replace(' ', 'T');
  const withZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const milliseconds = Date.parse(withZone);
  return isISO8601(withZone, { strict: true, strictSeparator: true }) &&
    Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}
