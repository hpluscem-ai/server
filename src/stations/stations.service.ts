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
  StationVersionConflictError,
  StationsRepository,
  stationVersion,
} from './stations.repository';

@Injectable()
export class StationsService {
  constructor(private readonly stations: StationsRepository) {}

  async findAdminList(
    query: AdminStationListQueryDto,
  ): Promise<StationResponseDto[]> {
    return (
      await this.stations.findAll({ ...query, ...normalizeDateRange(query) })
    ).map((station) => this.present(station));
  }

  async findAppList(): Promise<StationResponseDto[]> {
    return (await this.stations.findAll({}, true)).map((station) =>
      this.present(station),
    );
  }

  async findMap(bounds: StationBoundsQueryDto): Promise<StationResponseDto[]> {
    if (bounds.south > bounds.north)
      throw new BadRequestException({
        code: 'INVALID_MAP_BOUNDS',
        message: '남쪽 위도는 북쪽 위도보다 클 수 없습니다.',
      });
    return (await this.stations.findAll({}, true, bounds)).map((station) =>
      this.present(station),
    );
  }

  async findOne(id: string, appOnly: boolean): Promise<StationResponseDto> {
    const station = await this.stations.findOne(id, appOnly);
    if (!station) throw this.notFound();
    return this.present(station);
  }

  async create(input: CreateStationDto): Promise<StationResponseDto> {
    return this.present(await this.stations.create(input));
  }

  async update(
    id: string,
    input: UpdateStationDto,
  ): Promise<StationResponseDto> {
    try {
      return this.present(await this.stations.update(id, input));
    } catch (error) {
      if (error instanceof StationNotFoundError) throw this.notFound();
      if (error instanceof StationDevicesConflictError)
        throw new ConflictException({
          code: error.reason,
          message: '이 주유소의 기기 식별자를 중복 없이 입력해 주세요.',
        });
      if (error instanceof StationVersionConflictError)
        throw new ConflictException({
          code: 'STATION_VERSION_CONFLICT',
          message:
            '주유소 또는 기기 정보가 변경되었습니다. 최신 정보를 다시 조회해 주세요.',
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

  async remove(id: string, expectedVersion?: string): Promise<void> {
    try {
      if (!(await this.stations.remove(id, expectedVersion)))
        throw this.notFound();
    } catch (error) {
      if (error instanceof StationVersionConflictError)
        throw new ConflictException({
          code: 'STATION_VERSION_CONFLICT',
          message:
            '주유소 또는 기기 정보가 변경되었습니다. 최신 정보를 다시 조회해 주세요.',
        });
      throw error;
    }
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
      version: stationVersion(station),
      pole: station.pole,
      businessName: station.businessName,
      roadAddress: station.roadAddress,
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
  const withZone = /[+-]\d{2}$/.test(normalized)
    ? `${normalized}:00`
    : /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(normalized)
      ? normalized
      : `${normalized}Z`;
  const milliseconds = Date.parse(withZone);
  return isISO8601(withZone, { strict: true, strictSeparator: true }) &&
    Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}
