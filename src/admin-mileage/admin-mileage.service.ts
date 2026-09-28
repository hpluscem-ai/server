import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  AdminAuthRepository,
  type AdminAuthenticatedRequest,
} from '../admin-auth';
import { DatabaseService } from '../database/database.service';
import {
  logisticsCompanies,
  mileageApplications as applications,
  mileagePhotos as photos,
  mileageOcrJobs as ocrJobs,
  mileageResubmissions as resubmissions,
  users,
} from '../database/schema';
import {
  PhotoStorageService,
  OCR_VERSION,
  mileageFromLiters,
} from '../mileage';
import {
  AdminMileageQueryDto,
  AdminMileageResponseDto,
  ApproveAdminMileageDto,
  PendingAdminMileageDto,
  RejectAdminMileageDto,
} from './admin-mileage.dto';

@Injectable()
export class AdminMileageService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: PhotoStorageService,
    private readonly auth: AdminAuthRepository,
  ) {}

  async list(query: AdminMileageQueryDto): Promise<AdminMileageResponseDto[]> {
    const rows = await this.records(query);
    const name = query.nameQuery?.toLocaleLowerCase('ko-KR');
    // ponytail: existing admin tables load all matching rows; add pagination when measured volume requires it.
    return name
      ? rows.filter((row) => row.name.toLocaleLowerCase('ko-KR').includes(name))
      : rows;
  }

  async detail(
    id: string,
    database: Pick<DatabaseService['db'], 'select'> = this.database.db,
  ): Promise<AdminMileageResponseDto> {
    const row = (await this.records({}, id, database))[0];
    if (!row) throw this.notFound();
    return row;
  }

  async reject(
    id: string,
    input: RejectAdminMileageDto,
  ): Promise<AdminMileageResponseDto> {
    return this.review(id, input, {
      approvalStatus: 'rejected',
      rejectionReason: input.rejectionReason,
      finalAmount: null,
      mileageAmount: null,
    });
  }

  async approve(
    id: string,
    input: ApproveAdminMileageDto,
  ): Promise<AdminMileageResponseDto> {
    const mileageAmount = mileageFromLiters(`${input.liters} L`);
    if (mileageAmount === null) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: '주유량을 확인해 주세요.',
      });
    }
    return this.review(id, input, {
      approvalStatus: 'approved',
      rejectionReason: null,
      finalAmount: input.finalAmount,
      mileageAmount,
    });
  }

  async pending(
    id: string,
    input: PendingAdminMileageDto,
  ): Promise<AdminMileageResponseDto> {
    return this.review(id, input, {
      approvalStatus: 'pending',
      rejectionReason: null,
      finalAmount: null,
      mileageAmount: null,
    });
  }

  private async review(
    id: string,
    input: Pick<RejectAdminMileageDto, 'reviewVersion'>,
    decision: {
      approvalStatus: 'pending' | 'approved' | 'rejected';
      rejectionReason: string | null;
      finalAmount: number | null;
      mileageAmount: number | null;
    },
  ): Promise<AdminMileageResponseDto> {
    return this.database.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ replay: applications.reviewReplay })
        .from(applications)
        .where(eq(applications.id, id))
        .for('update');
      const current = await this.detail(id, tx);
      if (current.settlementId !== null) throw this.conflict();
      const sameDecision =
        current.status === decision.approvalStatus &&
        current.rejectionReason === decision.rejectionReason &&
        current.finalAmount === decision.finalAmount &&
        current.mileageAmount === decision.mileageAmount;
      if (current.reviewVersion !== input.reviewVersion) {
        // Only the latest unchanged result can replay a lost response.
        if (
          sameDecision &&
          locked.replay?.requestVersion === input.reviewVersion &&
          locked.replay.resultVersion === current.reviewVersion
        )
          return current;
        throw this.conflict();
      }
      if (sameDecision) return current;
      // Re-review changes the status; editing an existing decision is separate.
      if (current.status === decision.approvalStatus) throw this.conflict();
      if (
        decision.approvalStatus === 'approved' &&
        (!current.photos.receipt || !current.photos.meter)
      )
        throw this.conflict();
      const now = new Date().toISOString();
      const changed = await tx
        .update(applications)
        .set({
          ...decision,
          reviewReplay: {
            requestVersion: input.reviewVersion,
            resultVersion: '',
          },
          decidedAt: decision.approvalStatus === 'pending' ? null : now,
          updatedAt: now,
        })
        .where(
          and(
            eq(applications.id, id),
            eq(applications.approvalStatus, current.status),
            isNull(applications.settlementId),
          ),
        )
        .returning({ id: applications.id });
      if (!changed.length) throw this.conflict();
      const result = await this.detail(id, tx);
      await tx
        .update(applications)
        .set({
          reviewReplay: {
            requestVersion: input.reviewVersion,
            resultVersion: result.reviewVersion,
          },
        })
        .where(eq(applications.id, id));
      return result;
    });
  }

  private conflict() {
    return new ConflictException({
      code: 'MILEAGE_REVIEW_CONFLICT',
      message: '신청 또는 심사 상태가 변경되었습니다. 다시 조회해 주세요.',
    });
  }

  async photo(
    session: AdminAuthenticatedRequest['adminSession'],
    id: string,
    kind: string,
  ): Promise<Buffer> {
    if (kind !== 'receipt' && kind !== 'meter') throw this.notFound();
    const find = async () =>
      (
        await this.database.db
          .select({ id: photos.id, key: photos.storageKey })
          .from(photos)
          .innerJoin(
            applications,
            eq(photos.mileageApplicationId, applications.id),
          )
          .where(
            and(
              eq(applications.id, id),
              sql`${photos.kind} = CASE WHEN ${applications.photoMode} = 'single' THEN 'receipt' ELSE ${kind} END`,
            ),
          )
          .limit(1)
      )[0];
    const photo = await find();
    if (!photo) throw this.notFound();
    const content = await this.storage.get(photo.key);
    const currentAdmin = await this.auth.findSession(session.tokenHash);
    if (!currentAdmin || currentAdmin.id !== session.user.id) {
      throw new UnauthorizedException({
        code: 'INVALID_ADMIN_SESSION',
        message: '관리자 로그인이 필요합니다.',
      });
    }
    const current = await find();
    if (!current || current.id !== photo.id || current.key !== photo.key)
      throw this.notFound();
    return content;
  }

  private async records(
    query: AdminMileageQueryDto,
    id?: string,
    database: Pick<DatabaseService['db'], 'select'> = this.database.db,
  ): Promise<AdminMileageResponseDto[]> {
    return (
      await database
        .select({
          id: applications.id,
          requestHash: applications.requestHash,
          idempotencyKey: applications.idempotencyKey,
          userId: applications.userId,
          logisticsCompanyId: applications.logisticsCompanyId,
          logisticsCompanyName: logisticsCompanies.businessName,
          name: users.name,
          phone: users.phone,
          receiptAmount: applications.receiptAmount,
          meterAmount: applications.meterAmount,
          finalAmount: applications.finalAmount,
          mileageAmount: applications.mileageAmount,
          receiptAt: applications.receiptAt,
          matchStatus: applications.matchStatus,
          status: applications.approvalStatus,
          rejectionReason: applications.rejectionReason,
          reviewReplay: applications.reviewReplay,
          submittedAt: applications.submittedAt,
          decidedAt: applications.decidedAt,
          settlementId: applications.settlementId,
          // Late OCR after a rejection of unread photos is not applied to the application.
          ocrEvidence: sql<unknown>`(SELECT jsonb_build_array(${ocrJobs.sourceVersion}, ${ocrJobs.extractorVersion}, ${ocrJobs.result}, ${ocrJobs.errorCode})
          FROM ${ocrJobs} WHERE ${ocrJobs.applicationId} = ${applications.id}
          AND ${ocrJobs.extractorVersion} = ${OCR_VERSION} AND ${ocrJobs.status} = 'completed'
          AND ${applications.matchStatus} <> 'pending'
          AND ${ocrJobs.sourceVersion} = COALESCE((SELECT ${resubmissions.submissionVersion} FROM ${resubmissions}
            WHERE ${resubmissions.applicationId} = ${applications.id} ORDER BY ${resubmissions.id} DESC LIMIT 1), ${ocrJobs.sourceVersion}) LIMIT 1)`,
          receiptPhotoIdentity: sql<unknown>`(SELECT jsonb_build_array(${photos.id}, ${photos.storageKey}, ${photos.originalStorageKey}, ${photos.byteSize}) FROM ${photos} WHERE ${photos.mileageApplicationId} = ${applications.id} AND ${photos.kind} = 'receipt')`,
          meterPhotoIdentity: sql<unknown>`(SELECT jsonb_build_array(${photos.id}, ${photos.storageKey}, ${photos.originalStorageKey}, ${photos.byteSize}) FROM ${photos} WHERE ${photos.mileageApplicationId} = ${applications.id} AND ${photos.kind} = CASE WHEN ${applications.photoMode} = 'single' THEN 'receipt' ELSE 'meter' END)`,
        })
        .from(applications)
        .innerJoin(users, eq(applications.userId, users.id))
        .innerJoin(
          logisticsCompanies,
          eq(applications.logisticsCompanyId, logisticsCompanies.id),
        )
        .where(
          and(
            id ? eq(applications.id, id) : undefined,
            query.logisticsCompanyId
              ? eq(applications.logisticsCompanyId, query.logisticsCompanyId)
              : undefined,
          ),
        )
        .orderBy(
          desc(sql`(${applications.submittedAt})::timestamptz`),
          desc(applications.id),
        )
    ).map(
      ({
        receiptPhotoIdentity,
        meterPhotoIdentity,
        requestHash,
        idempotencyKey,
        ocrEvidence,
        reviewReplay,
        ...row
      }) => {
        for (const amount of [
          row.receiptAmount,
          row.meterAmount,
          row.finalAmount,
          row.mileageAmount,
        ]) {
          if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0))
            throw new InternalServerErrorException();
        }
        // Uploads use immutable, unique storage keys. Re-registration must replace the
        // changed photo and submission identity atomically before returning to pending.
        const reviewVersion = createHash('sha256')
          .update(
            JSON.stringify([
              row.id,
              row.userId,
              row.logisticsCompanyId,
              idempotencyKey,
              requestHash,
              row.submittedAt,
              row.receiptAmount,
              row.meterAmount,
              row.receiptAt,
              row.matchStatus,
              receiptPhotoIdentity,
              meterPhotoIdentity,
              ocrEvidence,
              row.status,
              row.finalAmount,
              row.mileageAmount,
              row.rejectionReason,
              row.decidedAt,
              reviewReplay?.requestVersion ?? null,
            ]),
          )
          .digest('hex');
        const base = `/api/v1/admin/mileage/applications/${row.id}/photos`;
        return {
          ...row,
          reviewVersion,
          submittedAt: iso(row.submittedAt),
          decidedAt: row.decidedAt ? iso(row.decidedAt) : null,
          receiptAt: row.receiptAt ? iso(row.receiptAt) : null,
          finalAmount: row.status === 'approved' ? row.finalAmount : null,
          mileageAmount: row.status === 'approved' ? row.mileageAmount : null,
          rejectionReason:
            row.status === 'rejected' ? row.rejectionReason : null,
          photos: {
            receipt: receiptPhotoIdentity ? `${base}/receipt` : null,
            meter: meterPhotoIdentity ? `${base}/meter` : null,
          },
        };
      },
    );
  }

  private notFound() {
    return new NotFoundException({
      code: 'MILEAGE_APPLICATION_NOT_FOUND',
      message: '마일리지 신청을 찾을 수 없습니다.',
    });
  }
}

function iso(value: string): string {
  return new Date(
    value.includes('T') ? value : value.replace(' ', 'T') + 'Z',
  ).toISOString();
}
