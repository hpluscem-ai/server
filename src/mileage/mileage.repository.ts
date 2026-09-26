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
  automaticApprovalAmounts,
  transactionAt,
  OCR_VERSION,
  type MeterReading,
  type ReceiptReading,
} from './mileage-ocr.service';

export type MileageRecord = typeof applications.$inferSelect;
export type PhotoRecord = typeof photos.$inferSelect;
type PhotoInput = Pick<
  PhotoRecord,
  | 'kind'
  | 'storageKey'
  | 'contentType'
  | 'byteSize'
  | 'originalStorageKey'
  | 'originalContentType'
  | 'originalByteSize'
>;
type SavedPhoto = PhotoInput & {
  id: string;
  mileageApplicationId: string;
};
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
  lunaCachedTokens?: number;
  lunaCacheWriteTokens?: number;
  attempts?: number;
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

  async findByKey(
    userId: string,
    key: string,
  ): Promise<MileageRecord | undefined> {
    return (
      await this.database.db
        .select()
        .from(applications)
        .where(
          and(
            eq(applications.userId, userId),
            eq(applications.idempotencyKey, key),
          ),
        )
        .limit(1)
    )[0];
  }

  async findOne(userId: string, id: string) {
    return this.database.db.transaction(async (tx) => {
      const row = (
        await tx
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
          .limit(1)
      )[0];
      if (!row) return undefined;
      return {
        ...row.application,
        photos: await tx
          .select()
          .from(photos)
          .where(eq(photos.mileageApplicationId, id)),
      };
    });
  }

  async findList(
    userId: string,
    query: MileageListQueryDto,
    cursor?: MileageCursor,
  ): Promise<MileageRecord[]> {
    const order = query.order ?? 'desc';
    const direction = order === 'asc' ? asc : desc;
    const compare = order === 'asc' ? gt : lt;
    const time = sql`(${applications.submittedAt})::timestamptz`;
    return (
      await this.database.db
        .select({ application: applications })
        .from(applications)
        .leftJoin(settlements, eq(applications.settlementId, settlements.id))
        .where(
          and(
            eq(applications.userId, userId),
            visibleSettlement(),
            query.createdFrom
              ? gte(time, sql`${query.createdFrom}::timestamptz`)
              : undefined,
            query.createdBefore
              ? lt(time, sql`${query.createdBefore}::timestamptz`)
              : undefined,
            cursor
              ? or(
                  compare(time, sql`${cursor.at}::timestamptz`),
                  and(
                    eq(time, sql`${cursor.at}::timestamptz`),
                    compare(applications.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(direction(time), direction(applications.id))
        .limit((query.limit ?? 20) + 1)
    ).map((row) => row.application);
  }

  async trackAttempt(id: string, userId: string, storageKeys: string[]) {
    await this.database.db.insert(attempts).values({ id, userId, storageKeys });
  }

  async forgetAttempt(id: string) {
    await this.database.db.delete(attempts).where(eq(attempts.id, id));
  }

  async hasAttempt(id: string): Promise<boolean> {
    return Boolean(
      (
        await this.database.db
          .select({ id: attempts.id })
          .from(attempts)
          .where(eq(attempts.id, id))
          .limit(1)
      )[0],
    );
  }

  commit(input: {
    id: string;
    userId: string;
    logisticsCompanyId: string;
    idempotencyKey: string;
    requestHash: string;
    queueOcr: boolean;
    photoMode?: 'single' | 'separate';
    photos: PhotoInput[];
  }): Promise<MileageRecord> {
    return this.database.db.transaction(async (tx) => {
      // Concurrent retries keep their own storage keys; only one key can commit.
      const existing = (
        await tx
          .select()
          .from(applications)
          .where(
            and(
              eq(applications.userId, input.userId),
              eq(applications.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1)
      )[0];
      if (existing) return existing;
      const { photos: inputPhotos, queueOcr, ...values } = input;
      const inserted = await tx
        .insert(applications)
        .values({ ...values, submittedAt: new Date().toISOString() })
        .onConflictDoNothing({
          target: [applications.userId, applications.idempotencyKey],
        })
        .returning();
      const application = inserted[0];
      if (!application) {
        const replay = (
          await tx
            .select()
            .from(applications)
            .where(
              and(
                eq(applications.userId, input.userId),
                eq(applications.idempotencyKey, input.idempotencyKey),
              ),
            )
            .limit(1)
        )[0];
        if (replay) return replay;
        throw new Error(
          'Mileage application idempotency conflict was not readable',
        );
      }
      const savedPhotos: SavedPhoto[] = [];
      for (const photo of inputPhotos) {
        const saved = {
          ...photo,
          id: randomUUID(),
          mileageApplicationId: application.id,
        };
        await tx.insert(photos).values(saved);
        savedPhotos.push(saved);
      }
      if (queueOcr)
        await tx.insert(ocrJobs).values({
          id: randomUUID(),
          applicationId: application.id,
          sourceVersion: photoVersion(application.requestHash, savedPhotos),
          extractorVersion: OCR_VERSION,
        });
      await tx.delete(attempts).where(eq(attempts.id, input.id));
      return application;
    });
  }

  submissionVersion(
    record: Pick<MileageRecord, 'requestHash'> & {
      photos: Pick<
        PhotoRecord,
        'id' | 'kind' | 'storageKey' | 'originalStorageKey'
      >[];
    },
  ): string {
    return photoVersion(record.requestHash, record.photos);
  }

  async findResubmission(applicationId: string, key: string) {
    return (
      await this.database.db
        .select()
        .from(resubmissions)
        .where(
          and(
            eq(resubmissions.applicationId, applicationId),
            eq(resubmissions.idempotencyKey, key),
          ),
        )
        .limit(1)
    )[0];
  }

  assertResubmittable(
    record: Pick<
      MileageRecord,
      'approvalStatus' | 'settlementId' | 'requestHash' | 'photoMode'
    > & {
      photos: Pick<
        PhotoRecord,
        'id' | 'kind' | 'storageKey' | 'originalStorageKey'
      >[];
    },
    version: string,
  ): void {
    if (
      record.approvalStatus !== 'rejected' ||
      record.settlementId !== null ||
      this.submissionVersion(record) !== version ||
      !(
        record.photoMode === 'single' ? ['receipt'] : ['receipt', 'meter']
      ).every((kind) => record.photos.some((photo) => photo.kind === kind))
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
    photoMode?: 'single' | 'separate';
    photos: PhotoInput[];
  }): Promise<{ committed: boolean; requestHash: string }> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT ${applications.id} FROM ${applications}
              WHERE ${applications.id} = ${input.id} AND ${applications.userId} = ${input.userId}
              FOR UPDATE`,
      );
      const application = (
        await tx
          .select()
          .from(applications)
          .where(
            and(
              eq(applications.id, input.id),
              eq(applications.userId, input.userId),
            ),
          )
          .limit(1)
      )[0];
      if (!application)
        throw new NotFoundException({
          code: 'MILEAGE_APPLICATION_NOT_FOUND',
          message: '신청 내역을 찾을 수 없습니다.',
        });
      const replay = (
        await tx
          .select()
          .from(resubmissions)
          .where(
            and(
              eq(resubmissions.applicationId, input.id),
              eq(resubmissions.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1)
      )[0];
      if (replay) return { committed: false, requestHash: replay.requestHash };
      const savedPhotos: SavedPhoto[] = await tx
        .select()
        .from(photos)
        .where(eq(photos.mileageApplicationId, input.id));
      this.assertResubmittable(
        { ...application, photos: savedPhotos },
        input.submissionVersion,
      );
      if (input.photoMode === 'single') {
        await tx
          .delete(photos)
          .where(
            and(
              eq(photos.mileageApplicationId, input.id),
              eq(photos.kind, 'meter'),
            ),
          );
        const index = savedPhotos.findIndex((photo) => photo.kind === 'meter');
        if (index >= 0) savedPhotos.splice(index, 1);
      }
      for (const photo of input.photos) {
        await tx
          .delete(photos)
          .where(
            and(
              eq(photos.mileageApplicationId, input.id),
              eq(photos.kind, photo.kind),
            ),
          );
        const replacement = {
          ...photo,
          id: randomUUID(),
          mileageApplicationId: input.id,
        };
        await tx.insert(photos).values(replacement);
        const index = savedPhotos.findIndex(
          (previous) => previous.kind === photo.kind,
        );
        if (index >= 0) savedPhotos[index] = replacement;
        else savedPhotos.push(replacement);
      }
      const version = photoVersion(application.requestHash, savedPhotos);
      await tx.insert(resubmissions).values({
        applicationId: input.id,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        previousVersion: input.submissionVersion,
        submissionVersion: version,
        previousRejectionReason: application.rejectionReason,
        previousDecidedAt: application.decidedAt,
      });
      await tx
        .update(applications)
        .set({
          approvalStatus: 'pending',
          photoMode: input.photoMode ?? 'separate',
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
        .where(eq(applications.id, input.id));
      if (input.queueOcr)
        await tx.insert(ocrJobs).values({
          id: randomUUID(),
          applicationId: input.id,
          sourceVersion: version,
          extractorVersion: OCR_VERSION,
        });
      await tx.delete(attempts).where(eq(attempts.id, input.attemptId));
      return { committed: true, requestHash: input.requestHash };
    });
  }

  async interruptRunningOcrJobs(): Promise<void> {
    await this.database.db
      .update(ocrJobs)
      .set({
        status: 'unknown',
        errorCode: 'INTERRUPTED',
        finishedAt: new Date().toISOString(),
      })
      .where(eq(ocrJobs.status, 'running'));
  }

  async claimOcrJob(): Promise<OcrJob | undefined> {
    return this.database.db.transaction(async (tx) => {
      const locked = await tx.execute(
        sql`SELECT ${ocrJobs.id} FROM ${ocrJobs}
              WHERE ${ocrJobs.status} = 'queued'
              ORDER BY ${ocrJobs.createdAt}, ${ocrJobs.id}
              FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const jobId = locked[0]?.id as string | undefined;
      if (!jobId) return undefined;
      const job = (
        await tx
          .select()
          .from(ocrJobs)
          .where(and(eq(ocrJobs.id, jobId), eq(ocrJobs.status, 'queued')))
          .limit(1)
      )[0];
      if (!job) return undefined;
      return (
        await tx
          .update(ocrJobs)
          .set({
            status: 'running',
            startedAt: new Date().toISOString(),
          })
          .where(and(eq(ocrJobs.id, job.id), eq(ocrJobs.status, 'queued')))
          .returning()
      )[0];
    });
  }

  async ocrSource(
    job: OcrJob,
  ): Promise<{ receiptKey: string; meterKey: string } | null> {
    return this.database.db.transaction(async (tx) => {
      const current = (
        await tx.select().from(ocrJobs).where(eq(ocrJobs.id, job.id)).limit(1)
      )[0];
      if (
        !current ||
        current.status !== 'running' ||
        current.applicationId !== job.applicationId ||
        current.sourceVersion !== job.sourceVersion ||
        current.extractorVersion !== job.extractorVersion ||
        current.extractorVersion !== OCR_VERSION
      )
        return null;
      const application = (
        await tx
          .select()
          .from(applications)
          .where(eq(applications.id, job.applicationId))
          .limit(1)
      )[0];
      if (
        !application ||
        application.approvalStatus !== 'pending' ||
        application.settlementId !== null
      )
        return null;
      const savedPhotos = await tx
        .select()
        .from(photos)
        .where(eq(photos.mileageApplicationId, job.applicationId));
      if (
        photoVersion(application.requestHash, savedPhotos) !== job.sourceVersion
      )
        return null;
      const receipt = savedPhotos.find((photo) => photo.kind === 'receipt');
      const meter =
        application.photoMode === 'single'
          ? receipt
          : savedPhotos.find((photo) => photo.kind === 'meter');
      return receipt && meter
        ? { receiptKey: receipt.storageKey, meterKey: meter.storageKey }
        : null;
    });
  }

  async reserveOcrCall(
    jobId: string,
    lunaLimit: number,
    retry = false,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(lunaLimit) || lunaLimit <= 0) return false;
    return this.database.db.transaction(async (tx) => {
      const job = (
        await tx.select().from(ocrJobs).where(eq(ocrJobs.id, jobId)).limit(1)
      )[0];
      if (
        !job ||
        job.status !== 'running' ||
        job.extractorVersion !== OCR_VERSION ||
        (retry
          ? !job.lunaReservedAt || Boolean(job.lunaRetryReservedAt)
          : Boolean(job.lunaReservedAt))
      )
        return false;
      const now = new Date().toISOString();
      const from = now.slice(0, 10) + 'T00:00:00.000Z';
      const until = new Date(Date.parse(from) + 86400000).toISOString();
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${from}))`);
      const used = async (column: typeof ocrJobs.lunaReservedAt) =>
        (
          await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(ocrJobs)
            .where(and(gte(column, from), lt(column, until)))
        )[0].count;
      if (
        (await used(ocrJobs.lunaReservedAt)) +
          (await used(ocrJobs.lunaRetryReservedAt)) >=
        lunaLimit
      )
        return false;
      const changed = await tx
        .update(ocrJobs)
        .set(retry ? { lunaRetryReservedAt: now } : { lunaReservedAt: now })
        .where(
          and(
            eq(ocrJobs.id, jobId),
            eq(ocrJobs.status, 'running'),
            retry
              ? isNull(ocrJobs.lunaRetryReservedAt)
              : isNull(ocrJobs.lunaReservedAt),
          ),
        )
        .returning({ id: ocrJobs.id });
      return changed.length === 1;
    });
  }

  async finishOcrJob(
    job: OcrJob,
    result: OcrResult,
    errorCode?: string,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      // Duplicate detection is global across drivers, so completion decisions share one
      // short critical section. OCR/provider I/O has already completed before this point.
      // ponytail: this is intentionally serialized until duplicate matching has an indexable design.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('mileage-ocr-completion'))`,
      );
      await tx.execute(
        sql`SELECT ${ocrJobs.id} FROM ${ocrJobs} WHERE ${ocrJobs.id} = ${job.id} FOR UPDATE`,
      );
      const current = (
        await tx.select().from(ocrJobs).where(eq(ocrJobs.id, job.id)).limit(1)
      )[0];
      if (
        !current ||
        current.status !== 'running' ||
        current.applicationId !== job.applicationId ||
        current.sourceVersion !== job.sourceVersion ||
        current.extractorVersion !== job.extractorVersion
      )
        return;
      await tx.execute(
        sql`SELECT ${applications.id} FROM ${applications}
            WHERE ${applications.id} = ${job.applicationId} FOR UPDATE`,
      );
      const application = (
        await tx
          .select()
          .from(applications)
          .where(eq(applications.id, job.applicationId))
          .limit(1)
      )[0];
      const savedPhotos = await tx
        .select()
        .from(photos)
        .where(eq(photos.mileageApplicationId, job.applicationId));
      const stillCurrent =
        current.extractorVersion === OCR_VERSION &&
        savedPhotos.some((photo) => photo.kind === 'receipt') &&
        (application?.photoMode === 'single' ||
          savedPhotos.some((photo) => photo.kind === 'meter')) &&
        application?.approvalStatus === 'pending' &&
        application.settlementId === null &&
        photoVersion(application.requestHash, savedPhotos) ===
          job.sourceVersion;
      const receiptAmount = amountValue(result.receipt?.amountText ?? null);
      const meterAmount = amountValue(result.meter?.amountText ?? null);
      const receiptAt = transactionAt(result.receipt);
      // Keep the original pair-hash suspicion rule; creation hashes do not identify replacements.
      let duplicate = Boolean(
        stillCurrent &&
        application?.requestHash &&
        (
          await tx
            .select({ id: applications.id })
            .from(applications)
            .where(
              and(
                sql`${applications.id} <> ${application.id}`,
                eq(applications.requestHash, application.requestHash),
                sql`NOT EXISTS (SELECT 1 FROM ${resubmissions}
              WHERE ${resubmissions.applicationId} IN (${application.id}, ${applications.id}))`,
              ),
            )
            .limit(1)
        )[0],
      );
      if (
        !duplicate &&
        stillCurrent &&
        application &&
        receiptAmount !== null &&
        meterAmount !== null
      ) {
        const candidates = await tx
          .select({ application: applications, job: ocrJobs })
          .from(applications)
          .leftJoin(ocrJobs, eq(ocrJobs.applicationId, applications.id))
          .where(
            and(
              sql`${applications.id} <> ${application.id}`,
              eq(applications.receiptAmount, receiptAmount),
              eq(applications.meterAmount, meterAmount),
            ),
          );
        // ponytail: scan only matching totals; index normalized current evidence if this set becomes large.
        for (const candidate of candidates) {
          if (!candidate.job)
            duplicate =
              receiptAt !== null &&
              candidate.application.receiptAt === receiptAt;
          else {
            const candidatePhotos = await tx
              .select()
              .from(photos)
              .where(eq(photos.mileageApplicationId, candidate.application.id));
            if (
              candidate.job.sourceVersion !==
              photoVersion(candidate.application.requestHash, candidatePhotos)
            )
              continue;
            const previous = candidate.job.result as OcrResult | null;
            const receipt = previous?.receipt;
            if (
              !receipt ||
              amountValue(receipt.amountText) !== receiptAmount ||
              amountValue(previous?.meter?.amountText ?? null) !== meterAmount
            )
              continue;
            duplicate =
              (receiptAt !== null && transactionAt(receipt) === receiptAt) ||
              Boolean(
                result.receipt?.transactionDateText &&
                result.receipt.transactionTimeText &&
                receipt.transactionDateText ===
                  result.receipt.transactionDateText &&
                receipt.transactionTimeText ===
                  result.receipt.transactionTimeText,
              );
          }
          if (duplicate) break;
        }
      }
      const failed =
        errorCode !== undefined ||
        result.clovaError !== null ||
        result.lunaError !== null;
      const amounts = automaticApprovalAmounts(result.receipt, result.meter);
      if (!duplicate && stillCurrent && application && !failed && amounts) {
        // Compare the immediately preceding result, not every earlier equal total.
        // ponytail: scan this driver's history; index current source versions if it grows large.
        const candidates = await tx
          .select({ application: applications, job: ocrJobs })
          .from(applications)
          .innerJoin(ocrJobs, eq(ocrJobs.applicationId, applications.id))
          .where(
            and(
              eq(applications.userId, application.userId),
              sql`${applications.id} <> ${application.id}`,
              or(eq(ocrJobs.status, 'completed'), eq(ocrJobs.status, 'failed')),
            ),
          )
          .orderBy(
            desc(ocrJobs.finishedAt),
            desc(ocrJobs.createdAt),
            desc(ocrJobs.id),
          );
        let previous: (typeof candidates)[number] | undefined;
        for (const candidate of candidates) {
          const previousPhotos = await tx
            .select()
            .from(photos)
            .where(eq(photos.mileageApplicationId, candidate.application.id));
          if (
            candidate.job.sourceVersion ===
            photoVersion(candidate.application.requestHash, previousPhotos)
          ) {
            previous = candidate;
            break;
          }
        }
        duplicate = Boolean(
          previous?.job.status === 'completed' &&
          previous.application.receiptAmount === receiptAmount &&
          previous.application.meterAmount === meterAmount,
        );
      }
      const approval =
        stillCurrent &&
        !duplicate &&
        !failed &&
        process.env.MILEAGE_OCR_AUTO_APPROVE_ENABLED === 'true'
          ? amounts
          : null;
      const now = new Date().toISOString();
      if (stillCurrent && application) {
        const status = duplicate
          ? 'duplicate_suspected'
          : receiptAmount !== null &&
              meterAmount !== null &&
              receiptAmount !== meterAmount
            ? 'mismatched'
            : !failed && amounts !== null
              ? 'matched'
              : 'ocr_failed';
        await tx
          .update(applications)
          .set({
            receiptAmount,
            meterAmount,
            receiptAt,
            matchStatus: status,
            ...(approval
              ? {
                  ...approval,
                  approvalStatus: 'approved' as const,
                  decidedAt: now,
                }
              : {}),
            updatedAt: now,
          })
          .where(
            and(
              eq(applications.id, application.id),
              eq(applications.approvalStatus, 'pending'),
              isNull(applications.settlementId),
            ),
          );
      }
      await tx
        .update(ocrJobs)
        .set({
          status: failed ? 'failed' : 'completed',
          result,
          errorCode: errorCode ?? result.clovaError ?? result.lunaError,
          clovaDurationMs: result.clovaDurationMs,
          lunaDurationMs: result.lunaDurationMs,
          lunaInputTokens: result.lunaInputTokens,
          lunaOutputTokens: result.lunaOutputTokens,
          finishedAt: now,
        })
        .where(and(eq(ocrJobs.id, job.id), eq(ocrJobs.status, 'running')));
    });
  }
}

function photoVersion(
  requestHash: string | null,
  savedPhotos: Pick<
    PhotoRecord,
    'id' | 'kind' | 'storageKey' | 'originalStorageKey'
  >[],
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

function visibleSettlement() {
  return or(isNull(settlements.id), eq(settlements.transferStatus, 'pending'));
}
