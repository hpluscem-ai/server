import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { installationSites, installationSiteDevices } from '../database/schema';
import {
  AdminStationListQueryDto,
  CreateStationDto,
  StationBoundsQueryDto,
  UpdateStationDto,
} from './station.dto';

export type StationRecord = typeof installationSites.$inferSelect & {
  devices: (typeof installationSiteDevices.$inferSelect)[];
};
export class StationNotFoundError extends Error {}
export class StationDevicesConflictError extends Error {
  constructor(readonly reason: 'UNKNOWN_DEVICE' | 'DUPLICATE_DEVICE_ID') {
    super(reason);
  }
}

@Injectable()
export class StationsRepository {
  constructor(private readonly database: DatabaseService) {}

  findAll(
    query: AdminStationListQueryDto = {},
    appOnly = false,
    bounds?: StationBoundsQueryDto,
  ): StationRecord[] {
    const rows = this.database.db
      .select({ station: installationSites, device: installationSiteDevices })
      .from(installationSites)
      .leftJoin(
        installationSiteDevices,
        eq(installationSiteDevices.installationSiteId, installationSites.id),
      )
      .where(
        and(
          appOnly ? eq(installationSites.active, true) : undefined,
          query.createdFrom
            ? gte(
                sql`julianday(${installationSites.createdAt})`,
                sql`julianday(${query.createdFrom})`,
              )
            : undefined,
          query.createdBefore
            ? lt(
                sql`julianday(${installationSites.createdAt})`,
                sql`julianday(${query.createdBefore})`,
              )
            : undefined,
          bounds
            ? and(
                gte(installationSites.latitude, bounds.south),
                lte(installationSites.latitude, bounds.north),
                bounds.west <= bounds.east
                  ? and(
                      gte(installationSites.longitude, bounds.west),
                      lte(installationSites.longitude, bounds.east),
                    )
                  : or(
                      gte(installationSites.longitude, bounds.west),
                      lte(installationSites.longitude, bounds.east),
                    ),
              )
            : undefined,
        ),
      )
      .orderBy(
        desc(installationSites.createdAt),
        asc(installationSites.id),
        asc(installationSiteDevices.id),
      )
      .all();
    const stations = new Map<string, StationRecord>();
    for (const { station, device } of rows) {
      let record = stations.get(station.id);
      if (!record) {
        record = { ...station, devices: [] };
        stations.set(station.id, record);
      }
      if (device) record.devices.push(device);
    }
    // ponytail: Unicode contains search scans selected stations; index search when volume warrants it.
    const name = query.stationQuery?.toLocaleLowerCase('ko-KR');
    return [...stations.values()].filter(
      (row) =>
        !name || row.businessName.toLocaleLowerCase('ko-KR').includes(name),
    );
  }

  findOne(id: string, appOnly = false): StationRecord | undefined {
    // 부모와 기기를 같은 읽기 스냅샷에서 조회한다.
    return this.database.db.transaction((tx) => {
      const station = tx
        .select()
        .from(installationSites)
        .where(
          and(
            eq(installationSites.id, id),
            appOnly ? eq(installationSites.active, true) : undefined,
          ),
        )
        .get();
      if (!station) return undefined;
      const devices = tx
        .select()
        .from(installationSiteDevices)
        .where(eq(installationSiteDevices.installationSiteId, id))
        .orderBy(asc(installationSiteDevices.id))
        .all();
      return { ...station, devices };
    });
  }

  create(input: CreateStationDto): StationRecord {
    return this.database.db.transaction(
      (tx) => {
        const { devices: inputs, note, ...fields } = input;
        const station = tx
          .insert(installationSites)
          .values({ id: randomUUID(), ...fields, note: note ?? null })
          .returning()
          .get();
        const devices = inputs.map((device) =>
          tx
            .insert(installationSiteDevices)
            .values({
              ...device,
              id: randomUUID(),
              installationSiteId: station.id,
            })
            .returning()
            .get(),
        );
        return { ...station, devices };
      },
      { behavior: 'immediate' },
    );
  }

  remove(id: string): boolean {
    // FK ON DELETE CASCADE removes only this station's devices in the same statement.
    return (
      this.database.db
        .delete(installationSites)
        .where(eq(installationSites.id, id))
        .run().changes > 0
    );
  }

  update(id: string, input: UpdateStationDto): StationRecord {
    return this.database.db.transaction(
      (tx) => {
        const previous = tx
          .select()
          .from(installationSites)
          .where(eq(installationSites.id, id))
          .get();
        if (!previous) throw new StationNotFoundError();
        const existing = tx
          .select()
          .from(installationSiteDevices)
          .where(eq(installationSiteDevices.installationSiteId, id))
          .all();
        const submittedIds = input.devices.flatMap((device) =>
          device.id === undefined ? [] : [device.id],
        );
        const uniqueIds = new Set(submittedIds);
        if (uniqueIds.size !== submittedIds.length)
          throw new StationDevicesConflictError('DUPLICATE_DEVICE_ID');
        const existingIds = new Set(existing.map((device) => device.id));
        if (submittedIds.some((deviceId) => !existingIds.has(deviceId)))
          throw new StationDevicesConflictError('UNKNOWN_DEVICE');
        const removedIds = existing
          .filter((device) => !uniqueIds.has(device.id))
          .map((device) => device.id);

        const { devices: inputs, note, ...fields } = input;
        const locationChanged =
          previous.roadAddress !== fields.roadAddress ||
          previous.latitude !== fields.latitude ||
          previous.longitude !== fields.longitude;
        const station = tx
          .update(installationSites)
          .set({
            ...fields,
            note: note ?? null,
            updatedAt: sql`CURRENT_TIMESTAMP`,
            ...(locationChanged
              ? { coordinateSource: null, coordinateVerifiedAt: null }
              : {}),
          })
          .where(eq(installationSites.id, id))
          .returning()
          .get();
        if (removedIds.length) {
          tx.delete(installationSiteDevices)
            .where(
              and(
                eq(installationSiteDevices.installationSiteId, id),
                inArray(installationSiteDevices.id, removedIds),
              ),
            )
            .run();
        }
        const devices = inputs.map((device) =>
          device.id === undefined
            ? tx
                .insert(installationSiteDevices)
                .values({
                  id: randomUUID(),
                  installationSiteId: id,
                  model: device.model,
                  capacityLiters: device.capacityLiters,
                })
                .returning()
                .get()
            : tx
                .update(installationSiteDevices)
                .set({
                  model: device.model,
                  capacityLiters: device.capacityLiters,
                  updatedAt: sql`CURRENT_TIMESTAMP`,
                })
                .where(
                  and(
                    eq(installationSiteDevices.id, device.id),
                    eq(installationSiteDevices.installationSiteId, id),
                  ),
                )
                .returning()
                .get(),
        );
        return { ...station, devices };
      },
      { behavior: 'immediate' },
    );
  }
}
