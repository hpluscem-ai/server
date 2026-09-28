import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { DatabaseService } from '../src/database/database.service';
import {
  authSessions,
  installationSites,
  installationSiteDevices,
  logisticsCompanies,
  users,
} from '../src/database/schema';
import { StationResponseDto } from '../src/stations/station.dto';
import { createTestApp } from './helpers/create-test-app';
import { seedAdminSession } from './helpers/seed-admin-session';

const ADMIN_PATH = '/api/v1/admin/stations';
const APP_PATH = '/api/v1/stations';
const bounds = { south: 37, west: 127, north: 38, east: 128 };
const input = {
  businessName: '테스트 주유소',
  pole: 'S-OIL',
  roadAddress: '서울시 강남구 테스트로 1',
  latitude: 37.5,
  longitude: 127.1,
  devices: [{ model: '테스트 모델', capacityLiters: 2000 }],
};

describe('Stations (e2e)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let authorization: string;
  let driverAuthorization: string;
  let companyId: string;
  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
  });
  beforeEach(async () => {
    await database.db.delete(installationSites);
    await database.db.delete(users);
    await database.db.delete(logisticsCompanies);
    authorization = await seedAdminSession(database);
    companyId = randomUUID();
    const userId = randomUUID();
    await database.db.insert(logisticsCompanies).values({
      id: companyId,
      businessName: '테스트 물류사',
      businessNumber: '123-45-67890',
      corporateRegistrationNumber: '123456-1234567',
      businessAddress: '서울시',
      managerName: '담당자',
      managerPhone: '010-1234-5678',
      bankCode: '19',
      accountNumber: '12345',
      accountHolder: '물류사',
    });
    await database.db.insert(users).values({
      id: userId,
      role: 'driver',
      email: 'driver@example.com',
      name: '기사',
      passwordHash: 'test-only-unused-hash',
      phone: '010-2222-3333',
      logisticsCompanyId: companyId,
      serviceTermsConsent: true,
      privacyTermsConsent: true,
    });
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await database.db.insert(authSessions).values({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      userId,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 600000),
    });
    driverAuthorization = `Bearer ${token}`;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => app?.close());

  function create(body: object = input, auth = authorization) {
    return request(app.getHttpServer())
      .post(ADMIN_PATH)
      .set('Authorization', auth)
      .send(body);
  }
  async function saved(body: object = input): Promise<StationResponseDto> {
    const response = await create(body).expect(201);
    return response.body as StationResponseDto;
  }
  function update(id: string, body: object, auth = authorization) {
    return request(app.getHttpServer())
      .put(`${ADMIN_PATH}/${id}`)
      .set('Authorization', auth)
      .send(body);
  }
  function remove(id: string, auth = authorization, query: object = {}) {
    return request(app.getHttpServer())
      .delete(`${ADMIN_PATH}/${id}`)
      .set('Authorization', auth)
      .query(query);
  }
  function list(query: object = {}) {
    return request(app.getHttpServer())
      .get(ADMIN_PATH)
      .set('Authorization', authorization)
      .query(query);
  }
  function appGet(
    path = APP_PATH,
    query: object = {},
    auth = driverAuthorization,
  ) {
    return request(app.getHttpServer())
      .get(path)
      .set('Authorization', auth)
      .query(query);
  }
  async function snapshot() {
    return {
      stations: await database.db
        .select()
        .from(installationSites)
        .orderBy(installationSites.id),
      devices: await database.db
        .select()
        .from(installationSiteDevices)
        .orderBy(installationSiteDevices.id),
    };
  }
  function editBody(station: StationResponseDto) {
    return {
      ...input,
      devices: station.devices.map(({ id, model, capacityLiters }) => ({
        id,
        model,
        capacityLiters,
      })),
    };
  }
  async function verifyCoordinates(id: string) {
    // 실제 검수 워크플로를 흉내내는 런타임 API가 아니라, 격리 테스트의 기존 검증 데이터다.
    await database.db
      .update(installationSites)
      .set({
        coordinateSource: 'isolated-test-survey',
        coordinateVerifiedAt: '2026-09-01 01:00:00',
      })
      .where(eq(installationSites.id, id));
  }

  async function createFailureTrigger(
    name: string,
    timing: string,
    table: string,
    condition = '',
  ) {
    await database.connection.unsafe(`
      CREATE FUNCTION app.${name}_function() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test-only failure'; END;
      $$;
      CREATE TRIGGER ${name} ${timing} ON app.${table}
      FOR EACH ROW ${condition} EXECUTE FUNCTION app.${name}_function();
    `);
  }

  async function dropFailureTrigger(name: string, table: string) {
    await database.connection.unsafe(
      `DROP TRIGGER IF EXISTS ${name} ON app.${table}; DROP FUNCTION IF EXISTS app.${name}_function();`,
    );
  }

  it('saves a station and its devices together without fabricating coordinate verification', async () => {
    await request(app.getHttpServer())
      .post(ADMIN_PATH)
      .set('Authorization', authorization)
      .send(input)
      .expect(201)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body.businessName).toBe(input.businessName);
        expect(body).not.toHaveProperty('area');
        expect(body).not.toHaveProperty('siteType');
        expect(body.coordinateVerified).toBe(false);
        expect(body.coordinateSource).toBeNull();
        expect(body.coordinateVerifiedAt).toBeNull();
        expect(body.devices).toHaveLength(1);
      });
    const state = await snapshot();
    expect(state.stations).toHaveLength(1);
    expect(state.devices).toHaveLength(1);
    expect(state.devices[0].installationSiteId).toBe(state.stations[0].id);
    expect(state.devices[0].capacityLiters).toBe(2000);
  });

  it('updates stable station and device ids, adds a device, and returns only public device fields', async () => {
    const station = await saved({
      ...input,
      note: '셀프',
      devices: [input.devices[0], { model: '두번째', capacityLiters: 3000 }],
    });
    const response = await update(station.id, {
      ...editBody(station),
      businessName: '새 이름',
      devices: [
        {
          ...editBody(station).devices[0],
          model: '수정 모델',
          capacityLiters: 4000,
        },
        editBody(station).devices[1],
        { model: '추가', capacityLiters: 1000 },
      ],
    }).expect(200);
    const updated = response.body as StationResponseDto;
    expect(updated.id).toBe(station.id);
    expect(updated.businessName).toBe('새 이름');
    expect(updated.note).toBeNull();
    expect(updated.devices).toHaveLength(3);
    expect(
      updated.devices.find((device) => device.id === station.devices[0].id)
        ?.model,
    ).toBe('수정 모델');
    expect(Object.keys(updated.devices[0]).sort()).toEqual([
      'active',
      'capacityLiters',
      'id',
      'model',
    ]);
    const detail = await request(app.getHttpServer())
      .get(`${ADMIN_PATH}/${station.id}`)
      .set('Authorization', authorization)
      .expect(200);
    expect(
      (detail.body as StationResponseDto).devices
        .map((device) => device.id)
        .sort(),
    ).toEqual(updated.devices.map((device) => device.id).sort());
    expect(
      (await snapshot()).devices.every(
        (device) => device.installationSiteId === station.id,
      ),
    ).toBe(true);
  });

  it.each([
    { businessName: '' },
    { area: '서울' },
    { siteType: 'station' },
    { pole: ' ' },
    { roadAddress: 'no address' },
    { latitude: undefined },
    { latitude: null },
    { latitude: '37.5' },
    { latitude: 91 },
    { longitude: -181 },
    { longitude: null },
    { devices: [] },
    { devices: null },
    { devices: ['not-device'] },
    { devices: [null] },
    { devices: [{ model: '', capacityLiters: 1 }] },
    { devices: [{ model: 'A', capacityLiters: 0 }] },
    { devices: [{ model: 'A', capacityLiters: 1.5 }] },
    { devices: [{ model: 'A', capacityLiters: '2000L' }] },
    { devices: [{ model: 'A', capacityLiters: Number.MAX_SAFE_INTEGER + 1 }] },
    { devices: [{ model: 'A', capacityLiters: 1, id: randomUUID() }] },
    { devices: [{ model: 'A', capacityLiters: 1, active: false }] },
    { active: false },
    { coordinateSource: 'self' },
    { coordinateVerifiedAt: '2026-09-01T00:00:00Z' },
    { note: null },
    { businessName: 'a'.repeat(101) },
  ])(
    'rejects missing, invalid, or protected registration fields: %j',
    async (fields) => {
      await create({ ...input, ...fields }).expect(400);
      expect(await snapshot()).toEqual({ stations: [], devices: [] });
    },
  );

  it.each([{ devices: [[]] }, { devices: [[input.devices[0]]] }])(
    'rejects nested device arrays before persistence: %j',
    async ({ devices }) => {
      const station = await saved();
      const before = await snapshot();
      await create({ ...input, devices })
        .expect(400)
        .expect(({ body }: { body: { code: string } }) =>
          expect(body.code).toBe('VALIDATION_ERROR'),
        );
      await update(station.id, {
        ...editBody(station),
        devices: [...editBody(station).devices, ...devices],
      })
        .expect(400)
        .expect(({ body }: { body: { code: string } }) =>
          expect(body.code).toBe('VALIDATION_ERROR'),
        );
      expect(await snapshot()).toEqual(before);
    },
  );

  it('rejects foreign and duplicate existing device ids without any mutation', async () => {
    const station = await saved();
    const other = await saved({ ...input, businessName: '다른 주유소' });
    const before = await snapshot();
    for (const [devices, code] of [
      [[{ ...input.devices[0], id: other.devices[0].id }], 'UNKNOWN_DEVICE'],
      [[{ ...input.devices[0], id: randomUUID() }], 'UNKNOWN_DEVICE'],
      [
        [...editBody(station).devices, ...editBody(station).devices],
        'DUPLICATE_DEVICE_ID',
      ],
    ] as const) {
      await update(station.id, {
        ...input,
        businessName: '저장되면 안 됨',
        devices,
      })
        .expect(409)
        .expect(({ body }: { body: { code: string } }) =>
          expect(body.code).toBe(code),
        );
      expect(await snapshot()).toEqual(before);
    }
    await update(station.id, {
      ...editBody(station),
      devices: [{ ...input.devices[0], id: null }],
    }).expect(400);
    await update(station.id, { ...editBody(station), active: false }).expect(
      400,
    );
    await update(station.id, {
      ...editBody(station),
      devices: [
        {
          ...input.devices[0],
          id: station.devices[0].id,
          installationSiteId: other.id,
        },
      ],
    }).expect(400);
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back the new parent and every device when a later insert fails', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await createFailureTrigger(
      'fail_device',
      'BEFORE INSERT',
      'installation_site_devices',
      "WHEN (NEW.model = 'fail')",
    );
    try {
      await create({
        ...input,
        devices: [input.devices[0], { model: 'fail', capacityLiters: 1 }],
      }).expect(500);
      expect(await snapshot()).toEqual({ stations: [], devices: [] });
    } finally {
      await dropFailureTrigger('fail_device', 'installation_site_devices');
    }
  });

  it.each(['parent', 'device_update', 'device_insert'])(
    'rolls back a %s failure including coordinate verification and sibling devices',
    async (failure) => {
      const station = await saved();
      await verifyCoordinates(station.id);
      const before = await snapshot();
      const trigger =
        failure === 'parent'
          ? 'BEFORE UPDATE ON installation_sites'
          : failure === 'device_update'
            ? 'BEFORE UPDATE ON installation_site_devices'
            : 'BEFORE INSERT ON installation_site_devices';
      await createFailureTrigger(
        'fail_write',
        trigger.replace(/ ON installation_(sites|site_devices)$/, ''),
        trigger.endsWith('installation_sites')
          ? 'installation_sites'
          : 'installation_site_devices',
      );
      const logs = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        await update(station.id, {
          ...editBody(station),
          latitude: 38,
          devices: [
            { ...editBody(station).devices[0], model: '변경 모델' },
            { model: '추가 모델', capacityLiters: 500 },
          ],
        }).expect(500);
        expect(await snapshot()).toEqual(before);
        expect(JSON.stringify(logs.mock.calls)).not.toContain(
          input.roadAddress,
        );
      } finally {
        await dropFailureTrigger(
          'fail_write',
          trigger.endsWith('installation_sites')
            ? 'installation_sites'
            : 'installation_site_devices',
        );
      }
    },
  );

  it('keeps concurrent full replacements of parent and devices coherent', async () => {
    const station = await saved();
    const responses = await Promise.all(
      ['A', 'B'].map((label) =>
        update(station.id, {
          ...editBody(station),
          businessName: label,
          devices: [{ ...editBody(station).devices[0], model: label }],
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const state = await snapshot();
    expect(state.stations[0].businessName).toBe(state.devices[0].model);
    const additions = await Promise.all(
      ['C', 'D'].map((label) =>
        update(station.id, {
          ...editBody(station),
          businessName: label,
          devices: [
            ...editBody(station).devices,
            { model: label, capacityLiters: 1 },
          ],
        }),
      ),
    );
    expect(additions.map((response) => response.status).sort()).toEqual([
      200, 200,
    ]);
    expect((await snapshot()).devices).toHaveLength(2);
    const final = await snapshot();
    const addition = final.devices.find(
      (device) => device.id !== station.devices[0].id,
    )!;
    expect(final.stations[0].businessName).toBe(addition.model);
  });

  it('rejects a stale station version without losing a concurrent device edit or addition', async () => {
    const station = await saved({
      ...input,
      devices: [
        input.devices[0],
        { model: '기존 두번째', capacityLiters: 3000 },
      ],
    });
    expect(station.version).toMatch(/^[a-f0-9]{64}$/);

    const current = await update(station.id, {
      ...editBody(station),
      expectedVersion: station.version,
      businessName: '최신 변경',
      devices: [
        { ...editBody(station).devices[0], model: '최신 수정 모델' },
        editBody(station).devices[1],
        { model: '동시 추가 모델', capacityLiters: 500 },
      ],
    }).expect(200);
    const currentStation = current.body as StationResponseDto;

    await update(station.id, {
      ...editBody(station),
      expectedVersion: station.version,
      businessName: '오래된 변경',
      devices: [{ ...editBody(station).devices[0], model: '오래된 모델' }],
    })
      .expect(409)
      .expect(({ body }: { body: { code: string } }) =>
        expect(body.code).toBe('STATION_VERSION_CONFLICT'),
      );

    const persisted = await request(app.getHttpServer())
      .get(`${ADMIN_PATH}/${station.id}`)
      .set('Authorization', authorization)
      .expect(200)
      .then((response) => response.body as StationResponseDto);
    expect(persisted.businessName).toBe('최신 변경');
    expect(persisted.version).toBe(currentStation.version);
    expect(persisted.devices).toHaveLength(3);
    expect(
      persisted.devices
        .map(({ id, model }) => ({ id, model }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(
      expect.arrayContaining([
        { id: station.devices[0].id, model: '최신 수정 모델' },
        { id: station.devices[1].id, model: '기존 두번째' },
        expect.objectContaining({ model: '동시 추가 모델' }),
      ]),
    );
  });

  it('uses the current station version to remove exactly one omitted device', async () => {
    const station = await saved({
      ...input,
      devices: [input.devices[0], { model: '삭제 대상', capacityLiters: 3000 }],
    });

    const response = await update(station.id, {
      ...editBody(station),
      expectedVersion: station.version,
      devices: [editBody(station).devices[0]],
    }).expect(200);
    const updated = response.body as StationResponseDto;

    expect(updated.devices).toEqual([
      expect.objectContaining({ id: station.devices[0].id }),
    ]);
    expect(updated.version).toMatch(/^[a-f0-9]{64}$/);
    const state = await snapshot();
    expect(state.stations).toHaveLength(1);
    expect(state.devices).toHaveLength(1);
    expect(state.devices[0].id).toBe(station.devices[0].id);
  });

  it('allows clearing both coordinates on update while registration still rejects null coordinates', async () => {
    const station = await saved();
    const response = await update(station.id, {
      ...editBody(station),
      expectedVersion: station.version,
      latitude: null,
      longitude: null,
    }).expect(200);
    const updated = response.body as StationResponseDto;
    expect(updated.latitude).toBeNull();
    expect(updated.longitude).toBeNull();
    expect(updated.coordinateVerified).toBe(false);
    await create({
      ...input,
      businessName: '좌표 없는 신규 등록',
      latitude: null,
      longitude: null,
    }).expect(400);
    const state = await snapshot();
    expect(state.stations).toHaveLength(1);
    expect(state.stations[0].latitude).toBeNull();
    expect(state.stations[0].longitude).toBeNull();
  });

  it.each([
    { latitude: null, longitude: input.longitude },
    { latitude: input.latitude, longitude: null },
  ])('rejects half-null coordinates on update: %j', async (coordinates) => {
    const station = await saved();
    const before = await snapshot();

    await update(station.id, {
      ...editBody(station),
      expectedVersion: station.version,
      ...coordinates,
    }).expect(400);

    expect(await snapshot()).toEqual(before);
  });

  it.each(['roadAddress', 'latitude', 'longitude'])(
    'clears coordinate verification on %s changes',
    async (field) => {
      const station = await saved();
      await verifyCoordinates(station.id);
      const changes = {
        roadAddress: '서울시 강남구 새주소 2',
        latitude: 38,
        longitude: 128,
      };
      const response = await update(station.id, {
        ...editBody(station),
        [field]: changes[field as keyof typeof changes],
      }).expect(200);
      expect((response.body as StationResponseDto).coordinateVerified).toBe(
        false,
      );
      expect((await snapshot()).stations[0].coordinateSource).toBeNull();
      expect((await snapshot()).stations[0].coordinateVerifiedAt).toBeNull();
      await appGet(`${APP_PATH}/map`, bounds)
        .expect(200)
        .expect(({ body }: { body: StationResponseDto[] }) => {
          expect(body).toHaveLength(1);
          expect(body[0].coordinateVerified).toBe(false);
          expect(body[0].latitude).toBe(
            field === 'latitude' ? changes.latitude : input.latitude,
          );
        });
    },
  );

  it('preserves trusted location metadata and operating states for non-location edits', async () => {
    const station = await saved();
    await verifyCoordinates(station.id);
    await database.db
      .update(installationSites)
      .set({ active: false })
      .where(eq(installationSites.id, station.id));
    await database.db
      .update(installationSiteDevices)
      .set({ active: false })
      .where(eq(installationSiteDevices.id, station.devices[0].id));
    const result = await update(station.id, {
      ...editBody(station),
      businessName: '변경',
      note: '셀프',
    }).expect(200);
    const updated = result.body as StationResponseDto;
    expect(updated.coordinateVerified).toBe(true);
    expect(updated.coordinateVerifiedAt).toBe('2026-09-01T01:00:00.000Z');
    expect(updated.active).toBe(false);
    expect(updated.devices[0].active).toBe(false);
    await appGet().expect(200).expect([]);
    await appGet(`${APP_PATH}/${station.id}`).expect(404);
  });

  it('searches literal Unicode names and applies normalized half-open registration periods', async () => {
    const station = await saved({ ...input, businessName: 'ÉLODIE 주유소' });
    await database.db
      .update(installationSites)
      .set({ createdAt: '2026-09-07 15:00:00' })
      .where(eq(installationSites.id, station.id));
    await list({
      stationQuery: ' élodie ',
      createdFrom: '2026-09-08T00:00:00+09:00',
      createdBefore: '2026-09-09T00:00:00+09:00',
    })
      .expect(200)
      .expect(({ body }: { body: unknown[] }) => expect(body).toHaveLength(1));
    for (const stationQuery of ['%', '_', "' OR 1=1 --", '없음'])
      await list({ stationQuery }).expect(200).expect([]);
    await list({ createdBefore: '2026-09-08T00:00:00+09:00' })
      .expect(200)
      .expect([]);
    for (const [key, offset, utc] of [
      ['createdFrom', '2026-09-08T00:00:00+15:00', '2026-09-07T09:00:00Z'],
      ['createdBefore', '2026-09-07T23:00:00-15:00', '2026-09-08T14:00:00Z'],
    ]) {
      const response = await list({ [key]: offset }).expect(200);
      const normalized = await list({ [key]: utc }).expect(200);
      expect(response.body as unknown).toEqual(normalized.body as unknown);
      expect(response.body as unknown[]).toHaveLength(1);
    }
    for (const query of [
      { createdFrom: '2026-02-30T00:00:00Z' },
      { createdFrom: '2026-09-08' },
      { createdFrom: '2026-09-08T00:00:00' },
      {
        createdFrom: '2026-09-08T00:00:00Z',
        createdBefore: '2026-09-08T00:00:00Z',
      },
      { stationQuery: ['a', 'b'] },
      { page: 1 },
    ])
      await list(query).expect(400);
  });

  it('provides entered coordinates without marking them verified and groups all devices', async () => {
    const station = await saved({
      ...input,
      devices: [input.devices[0], { model: '두번째', capacityLiters: 4000 }],
    });
    for (const path of [APP_PATH, `${APP_PATH}/${station.id}`]) {
      const response = await appGet(path)
        .expect(200)
        .expect('Cache-Control', 'no-store');
      const result = (
        path === APP_PATH
          ? (response.body as StationResponseDto[])[0]
          : response.body
      ) as StationResponseDto;
      expect(result.latitude).toBe(input.latitude);
      expect(result.longitude).toBe(input.longitude);
      expect(result.coordinateVerified).toBe(false);
      expect(result.devices).toHaveLength(2);
    }
    await appGet(`${APP_PATH}/map`, bounds)
      .expect(200)
      .expect(({ body }: { body: StationResponseDto[] }) => {
        expect(body).toHaveLength(1);
        expect(body[0].coordinateVerified).toBe(false);
        expect(body[0].coordinateSource).toBeNull();
        expect(body[0].coordinateVerifiedAt).toBeNull();
      });
    await database.db
      .update(installationSites)
      .set({ latitude: null, longitude: null })
      .where(eq(installationSites.id, station.id));
    await appGet(`${APP_PATH}/${station.id}`)
      .expect(200)
      .expect(({ body }: { body: StationResponseDto }) =>
        expect(body.coordinateVerified).toBe(false),
      );
    await appGet(`${APP_PATH}/map`, bounds).expect(200).expect([]);
  });

  it('maps only active stations with trusted coordinates inside inclusive bounds', async () => {
    const station = await saved();
    await verifyCoordinates(station.id);
    const atEdge = {
      south: input.latitude,
      north: input.latitude,
      west: input.longitude,
      east: input.longitude,
    };
    await appGet(`${APP_PATH}/map`, atEdge)
      .expect(200)
      .expect(({ body }: { body: StationResponseDto[] }) => {
        expect(body).toHaveLength(1);
        expect(body[0].id).toBe(station.id);
        expect(body[0].latitude).toBe(input.latitude);
        expect(body[0].coordinateVerified).toBe(true);
      });
    await appGet(`${APP_PATH}/map`, { ...bounds, west: 127.2 })
      .expect(200)
      .expect([]);
    await database.db
      .update(installationSites)
      .set({ active: false })
      .where(eq(installationSites.id, station.id));
    await appGet(`${APP_PATH}/map`, bounds).expect(200).expect([]);
    await list()
      .expect(200)
      .expect(({ body }: { body: unknown[] }) => expect(body).toHaveLength(1));
  });

  it.each([
    { coordinateSource: '' },
    { coordinateSource: null },
    { coordinateVerifiedAt: null },
    { coordinateVerifiedAt: 'not-a-date' },
    { coordinateVerifiedAt: '2026-02-30 00:00:00' },
  ])(
    'does not treat incomplete or invalid provenance as verified: %j',
    async (changes) => {
      const station = await saved();
      await verifyCoordinates(station.id);
      await database.db
        .update(installationSites)
        .set(changes)
        .where(eq(installationSites.id, station.id));
      await appGet(`${APP_PATH}/map`, bounds)
        .expect(200)
        .expect(({ body }: { body: StationResponseDto[] }) => {
          expect(body).toHaveLength(1);
          expect(body[0].coordinateVerified).toBe(false);
        });
      await appGet(`${APP_PATH}/${station.id}`)
        .expect(200)
        .expect(({ body }: { body: StationResponseDto }) => {
          expect(body.coordinateVerified).toBe(false);
          expect(body.latitude).toBe(input.latitude);
        });
    },
  );

  it('supports zero, negative coordinates and bounds crossing the antimeridian', async () => {
    const a = await saved({ ...input, latitude: 0, longitude: 179 });
    const b = await saved({ ...input, latitude: -1, longitude: -179 });
    await verifyCoordinates(a.id);
    await verifyCoordinates(b.id);
    await appGet(`${APP_PATH}/map`, {
      south: -2,
      north: 0,
      west: 170,
      east: -170,
    })
      .expect(200)
      .expect(({ body }: { body: StationResponseDto[] }) =>
        expect(body.map((station) => station.id).sort()).toEqual(
          [a.id, b.id].sort(),
        ),
      );
  });

  it.each([
    { south: undefined },
    { south: '' },
    { west: ' ' },
    { north: 'NaN' },
    { east: 'Infinity' },
    { south: ['37', '38'] },
    { south: -91 },
    { east: 181 },
    { south: 39 },
    { zoom: 12 },
  ])('rejects invalid or unapproved map query: %j', async (change) => {
    await appGet(`${APP_PATH}/map`, { ...bounds, ...change }).expect(400);
  });

  it('protects every admin and driver route, including after company deactivation', async () => {
    const station = await saved();
    for (const auth of ['', driverAuthorization]) {
      await create(input, auth).expect(401);
      await update(station.id, editBody(station), auth).expect(401);
      for (const path of [ADMIN_PATH, `${ADMIN_PATH}/${station.id}`])
        await request(app.getHttpServer())
          .get(path)
          .set('Authorization', auth)
          .expect(401);
    }
    for (const auth of ['', authorization])
      for (const path of [
        APP_PATH,
        `${APP_PATH}/${station.id}`,
        `${APP_PATH}/map`,
      ])
        await appGet(path, path.endsWith('/map') ? bounds : {}, auth).expect(
          401,
        );
    await database.db
      .update(logisticsCompanies)
      .set({ active: false })
      .where(eq(logisticsCompanies.id, companyId));
    await appGet().expect(401);
  });

  it('returns missing-resource errors and exposes no standalone device mutation', async () => {
    const missing = randomUUID();
    await update(missing, input).expect(404);
    await request(app.getHttpServer())
      .get(`${ADMIN_PATH}/${missing}`)
      .set('Authorization', authorization)
      .expect(404);
    await appGet(`${APP_PATH}/${missing}`).expect(404);
    await appGet(`${APP_PATH}/invalid-id`).expect(400);
    await request(app.getHttpServer())
      .get(`${ADMIN_PATH}/invalid-id`)
      .set('Authorization', authorization)
      .expect(400)
      .expect(({ body }: { body: { code: string } }) =>
        expect(body.code).toBe('BAD_REQUEST'),
      );
    await update('invalid-id', input)
      .expect(400)
      .expect(({ body }: { body: { code: string } }) =>
        expect(body.code).toBe('BAD_REQUEST'),
      );
    const station = await saved();
    const before = await snapshot();
    for (const path of [
      `${ADMIN_PATH}/${station.id}/devices/${station.devices[0].id}`,
    ])
      await request(app.getHttpServer())
        .delete(path)
        .set('Authorization', authorization)
        .expect(404);
    expect(await snapshot()).toEqual(before);
  });

  it('propagates read failures instead of returning an empty admin or app result', async () => {
    const station = await saved();
    await verifyCoordinates(station.id);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await database.connection.unsafe(
      'ALTER TABLE app.installation_site_devices RENAME TO unavailable_devices',
    );
    try {
      await list().expect(500);
      await request(app.getHttpServer())
        .get(`${ADMIN_PATH}/${station.id}`)
        .set('Authorization', authorization)
        .expect(500);
      for (const path of [
        APP_PATH,
        `${APP_PATH}/${station.id}`,
        `${APP_PATH}/map`,
      ])
        await appGet(path, path.endsWith('/map') ? bounds : {}).expect(500);
    } finally {
      await database.connection.unsafe(
        'ALTER TABLE app.unavailable_devices RENAME TO installation_site_devices',
      );
    }
  });

  it('documents access, nested inputs, real required fields, and deferred policies', async () => {
    const result = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = result.body as OpenAPIObject;
    expect(document.paths[ADMIN_PATH]?.post?.security).toEqual([
      { admin: [] },
      { 'admin-session': [] },
    ]);
    expect(document.paths[APP_PATH]?.get?.security).toEqual([
      { bearer: [] },
      { 'driver-session': [] },
    ]);
    expect(document.paths[`${APP_PATH}/map`]?.get?.description).toContain(
      '미제공',
    );
    expect(document.paths[`${ADMIN_PATH}/{id}`]?.delete?.security).toEqual([
      { admin: [] },
      { 'admin-session': [] },
    ]);
    expect(
      Object.keys(
        document.paths[`${ADMIN_PATH}/{id}`].delete!.responses,
      ).sort(),
    ).toEqual(['204', '400', '401', '403', '404', '409', '500']);
    const invalidIdResponse =
      document.paths[`${ADMIN_PATH}/{id}`]?.put?.responses?.['400'];
    expect(
      invalidIdResponse &&
        'description' in invalidIdResponse &&
        invalidIdResponse.description,
    ).toContain('BAD_REQUEST');
    for (const name of [
      'CreateStationDto',
      'UpdateStationDto',
      'StationResponseDto',
    ]) {
      const model = document.components?.schemas?.[name];
      expect(
        model && 'properties' in model && model.properties,
      ).not.toHaveProperty('area');
      expect(
        model && 'properties' in model && model.properties,
      ).not.toHaveProperty('siteType');
    }
    const schema = document.components?.schemas?.CreateStationDto;
    expect(schema && 'required' in schema && schema.required).toEqual(
      expect.arrayContaining(['latitude', 'longitude', 'devices']),
    );
    for (const name of [
      'CreateStationDto',
      'UpdateStationDto',
      'CreateStationDeviceDto',
      'UpdateStationDeviceDto',
      'StationResponseDto',
      'StationDeviceResponseDto',
    ]) {
      const model = document.components?.schemas?.[name];
      if (!model || !('properties' in model))
        throw new Error(`Missing Swagger model ${name}`);
      for (const field of Object.values(model.properties ?? {}))
        expect('description' in field && field.description).toEqual(
          expect.stringMatching(/[가-힣]/),
        );
    }
  });

  it('hard-deletes only the selected station and all its devices', async () => {
    const station = await saved({
      ...input,
      devices: [input.devices[0], { model: 'extra', capacityLiters: 100 }],
    });
    const other = await saved();
    const originalUsers = await database.db.select().from(users);
    await remove(station.id).expect(204).expect('Cache-Control', 'no-store');
    expect((await snapshot()).stations.map((row) => row.id)).toEqual([
      other.id,
    ]);
    expect((await snapshot()).devices.map((row) => row.id)).toEqual(
      other.devices.map((device) => device.id),
    );
    expect(await database.db.select().from(users)).toEqual(originalUsers);
    await remove(station.id).expect(404);
    await request(app.getHttpServer())
      .get(`${ADMIN_PATH}/${station.id}`)
      .set('Authorization', authorization)
      .expect(404);
    await appGet(`${APP_PATH}/${station.id}`).expect(404);
    await appGet(`${APP_PATH}/map`, bounds)
      .expect(200)
      .expect(({ body }: { body: StationResponseDto[] }) =>
        expect(body.map((row) => row.id)).toEqual([other.id]),
      );
  });

  it('only permits admin deletion and validates IDs without modifying data', async () => {
    const station = await saved();
    const before = await snapshot();
    for (const auth of ['', driverAuthorization, 'Bearer expired'])
      await remove(station.id, auth).expect(401);
    await remove('invalid').expect(400);
    await remove(randomUUID()).expect(404);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a stale station delete and preserves concurrently added devices', async () => {
    const station = await saved();
    const concurrent = await update(station.id, {
      ...editBody(station),
      expectedVersion: station.version,
      devices: [
        editBody(station).devices[0],
        { model: '동시 추가 모델', capacityLiters: 500 },
      ],
    }).expect(200);
    const current = concurrent.body as StationResponseDto;

    await remove(station.id, authorization, {
      expectedVersion: station.version,
    })
      .expect(409)
      .expect(({ body }: { body: { code: string } }) =>
        expect(body.code).toBe('STATION_VERSION_CONFLICT'),
      );

    const state = await snapshot();
    expect(state.stations).toHaveLength(1);
    expect(state.stations[0].id).toBe(station.id);
    expect(state.devices).toHaveLength(2);
    expect(state.devices.map(({ model }) => model).sort()).toEqual([
      '동시 추가 모델',
      input.devices[0].model,
    ]);
    await request(app.getHttpServer())
      .get(`${ADMIN_PATH}/${station.id}`)
      .set('Authorization', authorization)
      .expect(200)
      .expect(({ body }: { body: StationResponseDto }) =>
        expect(body.version).toBe(current.version),
      );
  });

  it('deletes a station when its expected version matches', async () => {
    const station = await saved({
      ...input,
      devices: [input.devices[0], { model: '같이 삭제', capacityLiters: 500 }],
    });

    await remove(station.id, authorization, {
      expectedVersion: station.version,
    }).expect(204);
    expect(await snapshot()).toEqual({ stations: [], devices: [] });
  });

  it.each(['installation_sites', 'installation_site_devices'])(
    'rolls back station cascade deletion when %s storage fails',
    async (table) => {
      const station = await saved({
        ...input,
        devices: [input.devices[0], { model: 'extra', capacityLiters: 100 }],
      });
      const before = await snapshot();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await createFailureTrigger('fail_delete', 'BEFORE DELETE', table);
      try {
        await remove(station.id).expect(500);
        expect(await snapshot()).toEqual(before);
      } finally {
        await dropFailureTrigger('fail_delete', table);
      }
    },
  );

  it('allows only one simultaneous delete and no update can resurrect the station', async () => {
    const station = await saved();
    const results = await Promise.all([remove(station.id), remove(station.id)]);
    expect(results.map((result) => result.status).sort()).toEqual([204, 404]);
    await update(station.id, editBody(station)).expect(404);
    expect(await snapshot()).toEqual({ stations: [], devices: [] });
  });

  it('removes omitted devices within the full station update, preserving retained IDs and unrelated stations', async () => {
    const station = await saved({
      ...input,
      devices: [input.devices[0], { model: 'remove', capacityLiters: 100 }],
    });
    const other = await saved();
    const retained = station.devices[0];
    const response = await update(station.id, {
      ...editBody(station),
      businessName: '변경',
      devices: [
        { id: retained.id, model: '유지', capacityLiters: 500 },
        { model: '신규', capacityLiters: 800 },
      ],
    }).expect(200);
    const result = response.body as StationResponseDto;
    expect(result.devices).toHaveLength(2);
    expect(result.devices[0].id).toBe(retained.id);
    expect(
      (await snapshot()).devices.some(
        (row) => row.id === station.devices[1].id,
      ),
    ).toBe(false);
    expect(
      (await snapshot()).devices.some((row) => row.id === other.devices[0].id),
    ).toBe(true);
    const before = await snapshot();
    await update(station.id, { ...editBody(result), devices: [] }).expect(400);
    expect(await snapshot()).toEqual(before);
  });

  it.each(['delete', 'insert'])(
    'rolls back removed devices and parent changes when device %s fails',
    async (operation) => {
      const station = await saved();
      const before = await snapshot();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await createFailureTrigger(
        'fail_replace',
        `BEFORE ${operation.toUpperCase()}`,
        'installation_site_devices',
      );
      try {
        await update(station.id, {
          ...input,
          businessName: '실패',
          devices: [{ model: 'replacement', capacityLiters: 100 }],
        }).expect(500);
        expect(await snapshot()).toEqual(before);
      } finally {
        await dropFailureTrigger('fail_replace', 'installation_site_devices');
      }
    },
  );
});
