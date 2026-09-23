import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import {
  mileageApplications as applications,
  mileagePhotos as photos,
  mileageOcrJobs as ocrJobs,
  mileageUploadAttempts as attempts,
  mileageResubmissions as resubmissions,
  settlements,
} from '../database/schema';
import type { MileageListQueryDto } from './mileage.dto';
import {
  amountValue,
  litersValue,
  OCR_VERSION,
  type MeterReading,
  type ReceiptReading,
} from './mileage-ocr.service';

export type MileageRecord = typeof applications.$inferSelect;
export type PhotoRecord = typeof photos.$inferSelect;
export type OcrJob = typeof ocrJobs.$inferSelect;
export type OcrResult = {
  receipt: ReceiptReading | null;
  meter: MeterReading | null;
  clovaError: string | null;
  lunaError: string | null;
  clovaDurationMs: number | null;
  lunaDurationMs: number | null;
  lunaInputTokens: number | null;
  lunaOutputTokens: number | null;
};
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
    queueOcr: boolean;
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
        const { photos: inputPhotos, queueOcr, ...values } = input;
        const application = tx
          .insert(applications)
          .values({ ...values, submittedAt: new Date().toISOString() })
          .returning()
          .get();
        const savedPhotos: PhotoRecord[] = [];
        for (const photo of inputPhotos) {
          const saved = {
            ...photo,
            id: randomUUID(),
            mileageApplicationId: application.id,
          };
          tx.insert(photos).values(saved).run();
          savedPhotos.push(saved);
        }
        if (queueOcr)
          tx.insert(ocrJobs)
            .values({
              id: randomUUID(),
              applicationId: application.id,
              sourceVersion: photoVersion(application.requestHash, savedPhotos),
              extractorVersion: OCR_VERSION,
            })
            .run();
        tx.delete(attempts).where(eq(attempts.id, input.id)).run();
        return application;
      },
      { behavior: 'immediate' },
    );
  }

  submissionVersion(
    record: Pick<MileageRecord, 'requestHash'> & { photos: PhotoRecord[] },
  ): string {
    return photoVersion(record.requestHash, record.photos);
  }

  findResubmission(applicationId: string, key: string) {
    return this.database.db
      .select()
      .from(resubmissions)
      .where(
        and(
          eq(resubmissions.applicationId, applicationId),
          eq(resubmissions.idempotencyKey, key),
        ),
      )
      .get();
  }

  assertResubmittable(
    record: MileageRecord & { photos: PhotoRecord[] },
    version: string,
  ): void {
    if (
      record.approvalStatus !== 'rejected' ||
      record.settlementId !== null ||
      this.submissionVersion(record) !== version ||
      !['receipt', 'meter'].every((kind) =>
        record.photos.some((photo) => photo.kind === kind),
      )
    ) {
      throw new ConflictException({
        code: 'MILEAGE_RESUBMISSION_CONFLICT',
        message:
          '신청 상태나 사진이 변경되었습니다. 신청 내역을 다시 확인해 주세요.',
      });
    }
  }

  commitResubmission(input: {
    id: string;
    userId: string;
    attemptId: string;
    idempotencyKey: string;
    requestHash: string;
    submissionVersion: string;
    queueOcr: boolean;
    photos: Omit<PhotoRecord, 'id' | 'mileageApplicationId'>[];
  }): { committed: boolean; requestHash: string } {
    return this.database.db.transaction(
      (tx) => {
        const application = tx
          .select()
          .from(applications)
          .where(
            and(
              eq(applications.id, input.id),
              eq(applications.userId, input.userId),
            ),
          )
          .get();
        if (!application)
          throw new NotFoundException({
            code: 'MILEAGE_APPLICATION_NOT_FOUND',
            message: '신청 내역을 찾을 수 없습니다.',
          });
        const replay = tx
          .select()
          .from(resubmissions)
          .where(
            and(
              eq(resubmissions.applicationId, input.id),
              eq(resubmissions.idempotencyKey, input.idempotencyKey),
            ),
          )
          .get();
        if (replay)
          return { committed: false, requestHash: replay.requestHash };
        const savedPhotos = tx
          .select()
          .from(photos)
          .where(eq(photos.mileageApplicationId, input.id))
          .all();
        this.assertResubmittable(
          { ...application, photos: savedPhotos },
          input.submissionVersion,
        );
        for (const photo of input.photos) {
          tx.delete(photos)
            .where(
              and(
                eq(photos.mileageApplicationId, input.id),
                eq(photos.kind, photo.kind),
              ),
            )
            .run();
          const replacement = {
            ...photo,
            id: randomUUID(),
            mileageApplicationId: input.id,
          };
          tx.insert(photos).values(replacement).run();
          savedPhotos[
            savedPhotos.findIndex((previous) => previous.kind === photo.kind)
          ] = replacement;
        }
        const version = photoVersion(application.requestHash, savedPhotos);
        tx.insert(resubmissions)
          .values({
            applicationId: input.id,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            previousVersion: input.submissionVersion,
            submissionVersion: version,
            previousRejectionReason: application.rejectionReason,
            previousDecidedAt: application.decidedAt,
          })
          .run();
        tx.update(applications)
          .set({
            approvalStatus: 'pending',
            matchStatus: 'pending',
            receiptAmount: null,
            meterAmount: null,
            receiptAt: null,
            finalAmount: null,
            mileageAmount: null,
            rejectionReason: null,
            decidedAt: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(applications.id, input.id))
          .run();
        if (input.queueOcr)
          tx.insert(ocrJobs)
            .values({
              id: randomUUID(),
              applicationId: input.id,
              sourceVersion: version,
              extractorVersion: OCR_VERSION,
            })
            .run();
        tx.delete(attempts).where(eq(attempts.id, input.attemptId)).run();
        return { committed: true, requestHash: input.requestHash };
      },
      { behavior: 'immediate' },
    );
  }

  interruptRunningOcrJobs(): void {
    this.database.db
      .update(ocrJobs)
      .set({
        status: 'unknown',
        errorCode: 'INTERRUPTED',
        finishedAt: new Date().toISOString(),
      })
      .where(eq(ocrJobs.status, 'running'))
      .run();
  }

  claimOcrJob(): OcrJob | undefined {
    return this.database.db.transaction(
      (tx) => {
        const job = tx
          .select()
          .from(ocrJobs)
          .where(eq(ocrJobs.status, 'queued'))
          .orderBy(asc(ocrJobs.createdAt), asc(ocrJobs.id))
          .limit(1)
          .get();
        if (!job) return undefined;
        return tx
          .update(ocrJobs)
          .set({
            status: 'running',
            startedAt: new Date().toISOString(),
          })
          .where(and(eq(ocrJobs.id, job.id), eq(ocrJobs.status, 'queued')))
          .returning()
          .get();
      },
      { behavior: 'immediate' },
    );
  }

  ocrSource(job: OcrJob): { receiptKey: string; meterKey: string } | null {
    return this.database.db.transaction((tx) => {
      const application = tx
        .select()
        .from(applications)
        .where(eq(applications.id, job.applicationId))
        .get();
      if (
        !application ||
        application.approvalStatus !== 'pending' ||
        application.settlementId !== null
      )
        return null;
      const savedPhotos = tx
        .select()
        .from(photos)
        .where(eq(photos.mileageApplicationId, job.applicationId))
        .all();
      if (
        photoVersion(application.requestHash, savedPhotos) !== job.sourceVersion
      )
        return null;
      const receipt = savedPhotos.find((photo) => photo.kind === 'receipt');
      const meter = savedPhotos.find((photo) => photo.kind === 'meter');
      return receipt && meter
        ? { receiptKey: receipt.storageKey, meterKey: meter.storageKey }
        : null;
    });
  }

  reserveOcrCalls(
    jobId: string,
    clovaLimit: number,
    lunaLimit: number,
  ): boolean {
    return this.database.db.transaction(
      (tx) => {
        const job = tx
          .select()
          .from(ocrJobs)
          .where(eq(ocrJobs.id, jobId))
          .get();
        if (
          !job ||
          job.status !== 'running' ||
          job.clovaReservedAt ||
          job.lunaReservedAt
        )
          return false;
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        const from = today + 'T00:00:00.000Z';
        const until = new Date(Date.parse(from) + 86400000).toISOString();
        const used = (column: typeof ocrJobs.clovaReservedAt) =>
          tx
            .select({ count: sql<number>`count(*)` })
            .from(ocrJobs)
            .where(and(gte(column, from), lt(column, until)))
            .get()!.count;
        if (
          used(ocrJobs.clovaReservedAt) >= clovaLimit ||
          used(ocrJobs.lunaReservedAt) >= lunaLimit
        )
          return false;
        tx.update(ocrJobs)
          .set({
            clovaReservedAt: now.toISOString(),
            lunaReservedAt: now.toISOString(),
          })
          .where(eq(ocrJobs.id, jobId))
          .run();
        return true;
      },
      { behavior: 'immediate' },
    );
  }

  finishOcrJob(job: OcrJob, result: OcrResult, errorCode?: string): void {
    this.database.db.transaction(
      (tx) => {
        const current = tx
          .select()
          .from(ocrJobs)
          .where(eq(ocrJobs.id, job.id))
          .get();
        if (!current || current.status !== 'running') return;
        const application = tx
          .select()
          .from(applications)
          .where(eq(applications.id, job.applicationId))
          .get();
        const savedPhotos = tx
          .select()
          .from(photos)
          .where(eq(photos.mileageApplicationId, job.applicationId))
          .all();
        const stillCurrent =
          application?.approvalStatus === 'pending' &&
          application.settlementId === null &&
          photoVersion(application.requestHash, savedPhotos) ===
            job.sourceVersion;
        const receiptAmount = amountValue(result.receipt?.amountText ?? null);
        const meterAmount = amountValue(result.meter?.amountText ?? null);
        const receiptAt = transactionAt(result.receipt);
        const duplicate =
          stillCurrent &&
          application &&
          tx
            .select({ id: applications.id })
            .from(applications)
            .where(
              and(
                sql`${applications.id} <> ${application.id}`,
                or(
                  sql`0`,
                  // The retained creation hash no longer identifies resubmitted photos.
                  application.requestHash
                    ? and(
                        eq(applications.requestHash, application.requestHash),
                        sql`NOT EXISTS (SELECT 1 FROM ${resubmissions}
                          WHERE ${resubmissions.applicationId} IN (${application.id}, ${applications.id}))`,
                      )
                    : undefined,
                  receiptAt !== null &&
                    receiptAmount !== null &&
                    meterAmount !== null
                    ? and(
                        eq(applications.receiptAt, receiptAt),
                        eq(applications.receiptAmount, receiptAmount),
                        eq(applications.meterAmount, meterAmount),
                      )
                    : undefined,
                  result.receipt?.transactionDateText &&
                    result.receipt.transactionTimeText &&
                    receiptAmount !== null &&
                    meterAmount !== null
                    ? and(
                        eq(applications.receiptAmount, receiptAmount),
                        eq(applications.meterAmount, meterAmount),
                        sql`EXISTS (
                          SELECT 1 FROM ${ocrJobs}
                          WHERE ${ocrJobs.applicationId} = ${applications.id}
                            AND ${ocrJobs.sourceVersion} = COALESCE((
                              SELECT submission_version FROM mileage_resubmissions
                              WHERE application_id = ${applications.id} ORDER BY id DESC LIMIT 1
                            ), ${ocrJobs.sourceVersion})
                            AND json_extract(${ocrJobs.result}, '$.receipt.transactionDateText') = ${result.receipt.transactionDateText}
                            AND json_extract(${ocrJobs.result}, '$.receipt.transactionTimeText') = ${result.receipt.transactionTimeText}
                        )`,
                      )
                    : undefined,
                ),
              ),
            )
            .get();
        if (stillCurrent && application) {
          const status = duplicate
            ? 'duplicate_suspected'
            : receiptAmount !== null &&
                meterAmount !== null &&
                receiptAmount !== meterAmount
              ? 'mismatched'
              : receiptAmount !== null &&
                  meterAmount !== null &&
                  result.receipt?.documentKind === 'sale' &&
                  result.receipt.issues.length === 0 &&
                  result.meter?.issues.length === 0 &&
                  litersValue(result.meter.litersText) !== null
                ? 'matched'
                : 'ocr_failed';
          tx.update(applications)
            .set({
              receiptAmount,
              meterAmount,
              receiptAt,
              matchStatus: status,
              updatedAt: new Date().toISOString(),
            })
            .where(
              and(
                eq(applications.id, application.id),
                eq(applications.approvalStatus, 'pending'),
                isNull(applications.settlementId),
              ),
            )
            .run();
        }
        tx.update(ocrJobs)
          .set({
            status:
              errorCode || result.clovaError || result.lunaError
                ? 'failed'
                : 'completed',
            result,
            errorCode: errorCode ?? result.clovaError ?? result.lunaError,
            clovaDurationMs: result.clovaDurationMs,
            lunaDurationMs: result.lunaDurationMs,
            lunaInputTokens: result.lunaInputTokens,
            lunaOutputTokens: result.lunaOutputTokens,
            finishedAt: new Date().toISOString(),
          })
          .where(eq(ocrJobs.id, job.id))
          .run();
      },
      { behavior: 'immediate' },
    );
  }
}

function photoVersion(
  requestHash: string | null,
  savedPhotos: PhotoRecord[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        requestHash,
        ...(['receipt', 'meter'] as const).map((kind) => {
          const photo = savedPhotos.find((row) => row.kind === kind);
          return photo
            ? [photo.id, photo.storageKey, photo.originalStorageKey]
            : null;
        }),
      ]),
    )
    .digest('hex');
}

function transactionAt(receipt: ReceiptReading | null): string | null {
  if (!receipt?.transactionDateText || !receipt.transactionTimeText)
    return null;
  const date = receipt.transactionDateText
    .replaceAll('.', '-')
    .replaceAll('/', '-');
  const time = receipt.transactionTimeText;
  if (
    !/^20\d{2}-\d{2}-\d{2}$/.test(date) ||
    !/^\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(time)
  )
    return null;
  const iso = date + 'T' + time;
  const parsed = new Date(iso);
  const [year, month, day] = date.split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(parsed.getTime()) ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() + 1 !== month ||
    calendar.getUTCDate() !== day
    ? null
    : parsed.toISOString();
}

function visibleSettlement() {
  return or(isNull(settlements.id), eq(settlements.transferStatus, 'pending'));
}
