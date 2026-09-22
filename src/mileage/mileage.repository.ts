import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import {
  mileageApplications as applications,
  mileagePhotos as photos,
  mileageUploadAttempts as attempts,
  settlements,
} from '../database/schema';
import type { MileageListQueryDto } from './mileage.dto';

export type MileageRecord = typeof applications.$inferSelect;
export type PhotoRecord = typeof photos.$inferSelect;
export type MileageCursor = {
  at: string;
  id: string;
  order: 'asc' | 'desc';
  from: string | null;
  before: string | null;
};

@Injectable()
export class MileageRepository {
  constructor(private readonly database: DatabaseService) {}

  findByKey(userId: string, key: string): MileageRecord | undefined {
    return this.database.db
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.userId, userId),
          eq(applications.idempotencyKey, key),
        ),
      )
      .get();
  }

  findOne(userId: string, id: string) {
    return this.database.db.transaction((tx) => {
      const row = tx
        .select({ application: applications })
        .from(applications)
        .leftJoin(settlements, eq(applications.settlementId, settlements.id))
        .where(
          and(
            eq(applications.userId, userId),
            eq(applications.id, id),
            visibleSettlement(),
          ),
        )
        .get();
      if (!row) return undefined;
      return {
        ...row.application,
        photos: tx
          .select()
          .from(photos)
          .where(eq(photos.mileageApplicationId, id))
          .all(),
      };
    });
  }

  findList(
    userId: string,
    query: MileageListQueryDto,
    cursor?: MileageCursor,
  ): MileageRecord[] {
    const order = query.order ?? 'desc';
    const direction = order === 'asc' ? asc : desc;
    const compare = order === 'asc' ? gt : lt;
    const time = sql`julianday(${applications.submittedAt})`;
    return this.database.db
      .select({ application: applications })
      .from(applications)
      .leftJoin(settlements, eq(applications.settlementId, settlements.id))
      .where(
        and(
          eq(applications.userId, userId),
          visibleSettlement(),
          query.createdFrom
            ? gte(time, sql`julianday(${query.createdFrom})`)
            : undefined,
          query.createdBefore
            ? lt(time, sql`julianday(${query.createdBefore})`)
            : undefined,
          cursor
            ? or(
                compare(time, sql`julianday(${cursor.at})`),
                and(
                  eq(time, sql`julianday(${cursor.at})`),
                  compare(applications.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(direction(time), direction(applications.id))
      .limit((query.limit ?? 20) + 1)
      .all()
      .map((row) => row.application);
  }

  trackAttempt(id: string, userId: string, storageKeys: string[]) {
    this.database.db.insert(attempts).values({ id, userId, storageKeys }).run();
  }

  forgetAttempt(id: string) {
    this.database.db.delete(attempts).where(eq(attempts.id, id)).run();
  }

  hasAttempt(id: string): boolean {
    return Boolean(
      this.database.db
        .select({ id: attempts.id })
        .from(attempts)
        .where(eq(attempts.id, id))
        .get(),
    );
  }

  commit(input: {
    id: string;
    userId: string;
    logisticsCompanyId: string;
    idempotencyKey: string;
    requestHash: string;
    photos: Omit<PhotoRecord, 'id' | 'mileageApplicationId'>[];
  }): MileageRecord {
    return this.database.db.transaction(
      (tx) => {
        // Concurrent retries keep their own storage keys; only one key can commit.
        const existing = tx
          .select()
          .from(applications)
          .where(
            and(
              eq(applications.userId, input.userId),
              eq(applications.idempotencyKey, input.idempotencyKey),
            ),
          )
          .get();
        if (existing) return existing;
        const { photos: inputPhotos, ...values } = input;
        const application = tx
          .insert(applications)
          .values({ ...values, submittedAt: new Date().toISOString() })
          .returning()
          .get();
        for (const photo of inputPhotos) {
          tx.insert(photos)
            .values({
              ...photo,
              id: randomUUID(),
              mileageApplicationId: application.id,
            })
            .run();
        }
        tx.delete(attempts).where(eq(attempts.id, input.id)).run();
        return application;
      },
      { behavior: 'immediate' },
    );
  }
}

function visibleSettlement() {
  return or(isNull(settlements.id), eq(settlements.transferStatus, 'pending'));
}
