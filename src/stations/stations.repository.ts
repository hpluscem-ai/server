import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  ilike,
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

  async findAll(
    query: AdminStationListQueryDto = {},
    appOnly = false,
    bounds?: StationBoundsQueryDto,
  ): Promise<StationRecord[]> {
    const rows = await this.database.db
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
                sql`${installationSites.createdAt}::timestamptz`,
                sql`${query.createdFrom}::timestamptz`,
              )
            : undefined,
          query.createdBefore
            ? lt(
                sql`${installationSites.createdAt}::timestamptz`,
                sql`${query.createdBefore}::timestamptz`,
              )
            : undefined,
          query.stationQuery
            ? ilike(
                installationSites.businessName,
                `%${escapeLike(query.stationQuery)}%`,
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
      );
    const stations = new Map<string, StationRecord>();
    for (const { station, device } of rows) {
      let record = stations.get(station.id);
      if (!record) {
        record = { ...station, devices: [] };
        stations.set(station.id, record);
      }
      if (device) record.devices.push(device);
    }
    return [...stations.values()];
  }

  async findOne(
    id: string,
    appOnly = false,
  ): Promise<StationRecord | undefined> {
    // 부모와 기기를 같은 읽기 스냅샷에서 조회한다.
    return this.database.db.transaction(async (tx) => {
      const [station] = await tx
        .select()
        .from(installationSites)
        .where(
          and(
            eq(installationSites.id, id),
            appOnly ? eq(installationSites.active, true) : undefined,
          ),
        )
        .limit(1);
      if (!station) return undefined;
      const devices = await tx
        .select()
        .from(installationSiteDevices)
        .where(eq(installationSiteDevices.installationSiteId, id))
        .orderBy(asc(installationSiteDevices.id));
      return { ...station, devices };
    });
  }

  async create(input: CreateStationDto): Promise<StationRecord> {
    return this.database.db.transaction(async (tx) => {
      const { devices: inputs, note, ...fields } = input;
      const [station] = await tx
        .insert(installationSites)
        .values({ id: randomUUID(), ...fields, note: note ?? null })
        .returning();
      const devices = [] as (typeof installationSiteDevices.$inferSelect)[];
      for (const device of inputs) {
        const [created] = await tx
          .insert(installationSiteDevices)
          .values({
            ...device,
            id: randomUUID(),
            installationSiteId: station.id,
          })
          .returning();
        devices.push(created);
      }
      return { ...station, devices };
    });
  }

  async remove(id: string): Promise<boolean> {
    // FK ON DELETE CASCADE removes only this station's devices in the same statement.
    const [station] = await this.database.db
      .delete(installationSites)
      .where(eq(installationSites.id, id))
      .returning({ id: installationSites.id });
    return station !== undefined;
  }

  async update(id: string, input: UpdateStationDto): Promise<StationRecord> {
    return this.database.db.transaction(async (tx) => {
      const [previous] = await tx
        .select()
        .from(installationSites)
        .where(eq(installationSites.id, id))
        .for('update')
        .limit(1);
      if (!previous) throw new StationNotFoundError();
      const existing = await tx
        .select()
        .from(installationSiteDevices)
        .where(eq(installationSiteDevices.installationSiteId, id))
        .for('update');
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
      const [station] = await tx
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
        .returning();
      if (removedIds.length) {
        await tx
          .delete(installationSiteDevices)
          .where(
            and(
              eq(installationSiteDevices.installationSiteId, id),
              inArray(installationSiteDevices.id, removedIds),
            ),
          );
      }
      const devices = [] as (typeof installationSiteDevices.$inferSelect)[];
      for (const device of inputs) {
        const [saved] =
          device.id === undefined
            ? await tx
                .insert(installationSiteDevices)
                .values({
                  id: randomUUID(),
                  installationSiteId: id,
                  model: device.model,
                  capacityLiters: device.capacityLiters,
                })
                .returning()
            : await tx
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
                .returning();
        devices.push(saved);
      }
      return { ...station, devices };
    });
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
