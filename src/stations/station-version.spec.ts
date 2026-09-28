import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateStationDto } from './station.dto';
import { StationRecord, stationVersion } from './stations.repository';

const station = (): StationRecord => {
  return {
    id: 'station-1',
    pole: 'GSC',
    businessName: '테스트주유소',
    roadAddress: '서울시 테스트로 1',
    note: null,
    latitude: 37.5,
    longitude: 127.0,
    coordinateSource: null,
    coordinateVerifiedAt: null,
    active: true,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    devices: [
      {
        id: 'device-a',
        installationSiteId: 'station-1',
        model: 'ST2140S',
        capacityLiters: 1400,
        active: true,
        createdAt: '2026-09-29T00:00:00.000Z',
        updatedAt: '2026-09-29T00:00:00.000Z',
      },
      {
        id: 'device-b',
        installationSiteId: 'station-1',
        model: 'HG1000S',
        capacityLiters: 2500,
        active: true,
        createdAt: '2026-09-29T00:00:00.000Z',
        updatedAt: '2026-09-29T00:00:00.000Z',
      },
    ],
  };
};

describe('stationVersion', () => {
  it('ignores device order and changes for editable parent or device state', () => {
    const current = station();
    const version = stationVersion(current);

    expect(
      stationVersion({ ...current, devices: [...current.devices].reverse() }),
    ).toBe(version);
    expect(
      stationVersion({ ...current, roadAddress: '서울시 변경로 1' }),
    ).not.toBe(version);
    expect(
      stationVersion({
        ...current,
        devices: current.devices.map((device) =>
          device.id === 'device-a' ? { ...device, model: 'ST2140' } : device,
        ),
      }),
    ).not.toBe(version);
    expect(
      stationVersion({ ...current, devices: current.devices.slice(1) }),
    ).not.toBe(version);
  });
});

describe('UpdateStationDto coordinates', () => {
  const validateCoordinates = (
    latitude: number | null,
    longitude: number | null,
  ) =>
    validateSync(
      plainToInstance(UpdateStationDto, {
        pole: 'GSC',
        businessName: '테스트주유소',
        roadAddress: '서울시 테스트로 1',
        latitude,
        longitude,
        devices: [{ model: 'ST2140S', capacityLiters: 1400 }],
      }),
    );

  it('accepts a numeric pair or both null coordinates, but rejects a half-null pair', () => {
    expect(validateCoordinates(null, null)).toEqual([]);
    expect(validateCoordinates(37.5, 127)).toEqual([]);
    expect(
      validateCoordinates(null, 127).map((error) => error.property),
    ).toContain('latitude');
    expect(
      validateCoordinates(37.5, null).map((error) => error.property),
    ).toContain('longitude');
  });
});
