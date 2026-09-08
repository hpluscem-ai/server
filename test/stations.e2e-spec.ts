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
  area: '서울',
  roadAddress: '서울시 강남구 테스트로 1',
  siteType: 'station',
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
  beforeEach(() => {
    database.db.delete(installationSites).run();
    database.db.delete(users).run();
    database.db.delete(logisticsCompanies).run();
    authorization = seedAdminSession(database);
    companyId = randomUUID();
    const userId = randomUUID();
    database.db
      .insert(logisticsCompanies)
      .values({
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
      })
      .run();
    database.db
      .insert(users)
      .values({
        id: userId,
        role: 'driver',
        email: 'driver@example.com',
        name: '기사',
        passwordHash: 'test-only-unused-hash',
        phone: '010-2222-3333',
        logisticsCompanyId: companyId,
        serviceTermsConsent: true,
        privacyTermsConsent: true,
      })
      .run();
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    database.db
      .insert(authSessions)
      .values({
        tokenHash: createHash('sha256').update(token).digest('hex'),
        userId,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + 600000),
      })
      .run();
    driverAuthorization = `Bearer ${token}`;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => app.close());

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
  function remove(id: string, auth = authorization) {
    return request(app.getHttpServer())
      .delete(`${ADMIN_PATH}/${id}`)
      .set('Authorization', auth);
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
  function snapshot() {
    return {
      stations: database.connection
        .prepare('SELECT * FROM installation_sites ORDER BY id')
        .all(),
      devices: database.connection
        .prepare('SELECT * FROM installation_site_devices ORDER BY id')
        .all(),
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
  function verifyCoordinates(id: string) {
    // 실제 검수 워크플로를 흉내내는 런타임 API가 아니라, 격리 테스트의 기존 검증 데이터다.
    database.db
      .update(installationSites)
      .set({
        coordinateSource: 'isolated-test-survey',
        coordinateVerifiedAt: '2026-09-01 01:00:00',
      })
      .where(eq(installationSites.id, id))
      .run();
  }

  it('saves a station and its devices together without fabricating coordinate verification', async () => {
    await request(app.getHttpServer())
      .post(ADMIN_PATH)
      .set('Authorization', authorization)
      .send(input)
      .expect(201)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body.businessName).toBe(input.businessName);
        expect(body.coordinateVerified).toBe(false);
        expect(body.coordinateSource).toBeNull();
        expect(body.coordinateVerifiedAt).toBeNull();
        expect(body.devices).toHaveLength(1);
      });
    const state = snapshot();
    expect(state.stations).toHaveLength(1);
    expect(state.devices).toHaveLength(1);
    expect(state.devices[0].installation_site_id).toBe(state.stations[0].id);
    expect(state.devices[0].capacity_liters).toBe(2000);
    expect(state.stations[0].area).toBe(input.area);
    expect(state.stations[0].site_type).toBe(input.siteType);
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
      snapshot().devices.every(
        (device) => device.installation_site_id === station.id,
      ),
    ).toBe(true);
  });

  it.each([
    { area: undefined },
    { area: null },
    { area: ' ' },
    { siteType: undefined },
    { siteType: 'unknown' },
    { businessName: '' },
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
      expect(snapshot()).toEqual({ stations: [], devices: [] });
    },
  );

  it.each([{ devices: [[]] }, { devices: [[input.devices[0]]] }])(
    'rejects nested device arrays before persistence: %j',
    async ({ devices }) => {
      const station = await saved();
      const before = snapshot();
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
      expect(snapshot()).toEqual(before);
    },
  );

  it('rejects foreign and duplicate existing device ids without any mutation', async () => {
    const station = await saved();
    const other = await saved({ ...input, businessName: '다른 주유소' });
    const before = snapshot();
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
      expect(snapshot()).toEqual(before);
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
    expect(snapshot()).toEqual(before);
  });

  it('rolls back the new parent and every device when a later insert fails', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    database.connection.exec(
      "CREATE TRIGGER fail_device BEFORE INSERT ON installation_site_devices WHEN NEW.model = 'fail' BEGIN SELECT RAISE(ABORT, 'test-only failure'); END",
    );
    try {
      await create({
        ...input,
        devices: [input.devices[0], { model: 'fail', capacityLiters: 1 }],
      }).expect(500);
      expect(snapshot()).toEqual({ stations: [], devices: [] });
    } finally {
      database.connection.exec('DROP TRIGGER fail_device');
    }
  });

  it.each(['parent', 'device_update', 'device_insert'])(
    'rolls back a %s failure including coordinate verification and sibling devices',
    async (failure) => {
      const station = await saved();
      verifyCoordinates(station.id);
      const before = snapshot();
      const trigger =
        failure === 'parent'
          ? 'BEFORE UPDATE ON installation_sites'
          : failure === 'device_update'
            ? 'BEFORE UPDATE ON installation_site_devices'
            : 'BEFORE INSERT ON installation_site_devices';
      database.connection.exec(
        `CREATE TRIGGER fail_write ${trigger} BEGIN SELECT RAISE(ABORT, 'test-only failure'); END`,
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
        expect(snapshot()).toEqual(before);
        expect(JSON.stringify(logs.mock.calls)).not.toContain(
          input.roadAddress,
        );
      } finally {
        database.connection.exec('DROP TRIGGER fail_write');
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
    const state = snapshot();
    expect(state.stations[0].business_name).toBe(state.devices[0].model);
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
    expect(snapshot().devices).toHaveLength(2);
    const final = snapshot();
    const addition = final.devices.find(
      (device) => device.id !== station.devices[0].id,
    )!;
    expect(final.stations[0].business_name).toBe(addition.model);
  });

  it.each(['roadAddress', 'latitude', 'longitude'])(
    'clears coordinate verification on %s changes',
    async (field) => {
      const station = await saved();
      verifyCoordinates(station.id);
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
      expect(snapshot().stations[0].coordinate_source).toBeNull();
      expect(snapshot().stations[0].coordinate_verified_at).toBeNull();
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
    verifyCoordinates(station.id);
    database.db
      .update(installationSites)
      .set({ active: false })
      .where(eq(installationSites.id, station.id))
      .run();
    database.db
      .update(installationSiteDevices)
      .set({ active: false })
      .where(eq(installationSiteDevices.id, station.devices[0].id))
      .run();
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
    database.db
      .update(installationSites)
      .set({ createdAt: '2026-09-07 15:00:00' })
      .where(eq(installationSites.id, station.id))
      .run();
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
    database.db
      .update(installationSites)
      .set({ latitude: null, longitude: null })
      .where(eq(installationSites.id, station.id))
      .run();
    await appGet(`${APP_PATH}/${station.id}`)
      .expect(200)
      .expect(({ body }: { body: StationResponseDto }) =>
        expect(body.coordinateVerified).toBe(false),
      );
    await appGet(`${APP_PATH}/map`, bounds).expect(200).expect([]);
  });

  it('maps only active stations with trusted coordinates inside inclusive bounds', async () => {
    const station = await saved();
    verifyCoordinates(station.id);
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
    database.db
      .update(installationSites)
      .set({ active: false })
      .where(eq(installationSites.id, station.id))
      .run();
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
      verifyCoordinates(station.id);
      database.db
        .update(installationSites)
        .set(changes)
        .where(eq(installationSites.id, station.id))
        .run();
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
    verifyCoordinates(a.id);
    verifyCoordinates(b.id);
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
    database.db
      .update(logisticsCompanies)
      .set({ active: false })
      .where(eq(logisticsCompanies.id, companyId))
      .run();
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
    const before = snapshot();
    for (const path of [
      `${ADMIN_PATH}/${station.id}/devices/${station.devices[0].id}`,
    ])
      await request(app.getHttpServer())
        .delete(path)
        .set('Authorization', authorization)
        .expect(404);
    expect(snapshot()).toEqual(before);
  });

  it('propagates read failures instead of returning an empty admin or app result', async () => {
    const station = await saved();
    verifyCoordinates(station.id);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    database.connection.exec(
      'ALTER TABLE installation_site_devices RENAME TO unavailable_devices',
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
      database.connection.exec(
        'ALTER TABLE unavailable_devices RENAME TO installation_site_devices',
      );
    }
  });

  it('documents access, nested inputs, real required fields, and deferred policies', async () => {
    const result = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = result.body as OpenAPIObject;
    expect(document.paths[ADMIN_PATH]?.post?.security).toEqual([{ admin: [] }]);
    expect(document.paths[APP_PATH]?.get?.security).toEqual([{ bearer: [] }]);
    expect(document.paths[`${APP_PATH}/map`]?.get?.description).toContain(
      '미제공',
    );
    expect(document.paths[`${ADMIN_PATH}/{id}`]?.delete?.security).toEqual([
      { admin: [] },
    ]);
    expect(
      Object.keys(
        document.paths[`${ADMIN_PATH}/{id}`].delete!.responses,
      ).sort(),
    ).toEqual(['204', '400', '401', '404', '500']);
    const invalidIdResponse =
      document.paths[`${ADMIN_PATH}/{id}`]?.put?.responses?.['400'];
    expect(
      invalidIdResponse &&
        'description' in invalidIdResponse &&
        invalidIdResponse.description,
    ).toContain('BAD_REQUEST');
    const schema = document.components?.schemas?.CreateStationDto;
    expect(schema && 'required' in schema && schema.required).toEqual(
      expect.arrayContaining([
        'area',
        'siteType',
        'latitude',
        'longitude',
        'devices',
      ]),
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
    const originalUsers = database.db.select().from(users).all();
    await remove(station.id).expect(204).expect('Cache-Control', 'no-store');
    expect(snapshot().stations.map((row) => row.id)).toEqual([other.id]);
    expect(snapshot().devices.map((row) => row.id)).toEqual(
      other.devices.map((device) => device.id),
    );
    expect(database.db.select().from(users).all()).toEqual(originalUsers);
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
    expect(
      database.connection.prepare('PRAGMA foreign_key_check').all(),
    ).toEqual([]);
  });

  it('only permits admin deletion and validates IDs without modifying data', async () => {
    const station = await saved();
    const before = snapshot();
    for (const auth of ['', driverAuthorization, 'Bearer expired'])
      await remove(station.id, auth).expect(401);
    await remove('invalid').expect(400);
    await remove(randomUUID()).expect(404);
    expect(snapshot()).toEqual(before);
  });

  it.each(['installation_sites', 'installation_site_devices'])(
    'rolls back station cascade deletion when %s storage fails',
    async (table) => {
      const station = await saved({
        ...input,
        devices: [input.devices[0], { model: 'extra', capacityLiters: 100 }],
      });
      const before = snapshot();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      database.connection.exec(
        `CREATE TRIGGER fail_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'test-only failure'); END;`,
      );
      try {
        await remove(station.id).expect(500);
        expect(snapshot()).toEqual(before);
      } finally {
        database.connection.exec('DROP TRIGGER fail_delete');
      }
    },
  );

  it('allows only one simultaneous delete and no update can resurrect the station', async () => {
    const station = await saved();
    const results = await Promise.all([remove(station.id), remove(station.id)]);
    expect(results.map((result) => result.status).sort()).toEqual([204, 404]);
    await update(station.id, editBody(station)).expect(404);
    expect(snapshot()).toEqual({ stations: [], devices: [] });
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
      snapshot().devices.some((row) => row.id === station.devices[1].id),
    ).toBe(false);
    expect(
      snapshot().devices.some((row) => row.id === other.devices[0].id),
    ).toBe(true);
    const before = snapshot();
    await update(station.id, { ...editBody(result), devices: [] }).expect(400);
    expect(snapshot()).toEqual(before);
  });

  it.each(['delete', 'insert'])(
    'rolls back removed devices and parent changes when device %s fails',
    async (operation) => {
      const station = await saved();
      const before = snapshot();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      database.connection.exec(
        `CREATE TRIGGER fail_replace BEFORE ${operation.toUpperCase()} ON installation_site_devices BEGIN SELECT RAISE(ABORT, 'test-only failure'); END;`,
      );
      try {
        await update(station.id, {
          ...input,
          businessName: '실패',
          devices: [{ model: 'replacement', capacityLiters: 100 }],
        }).expect(500);
        expect(snapshot()).toEqual(before);
      } finally {
        database.connection.exec('DROP TRIGGER fail_replace');
      }
    },
  );
});
