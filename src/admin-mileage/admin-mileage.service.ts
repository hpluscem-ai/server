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
  RejectAdminMileageDto,
} from './admin-mileage.dto';

@Injectable()
export class AdminMileageService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: PhotoStorageService,
    private readonly auth: AdminAuthRepository,
  ) {}

  list(query: AdminMileageQueryDto): AdminMileageResponseDto[] {
    const rows = this.records(query);
    const name = query.nameQuery?.toLocaleLowerCase('ko-KR');
    // ponytail: existing admin tables load all matching rows; add pagination when measured volume requires it.
    return name
      ? rows.filter((row) => row.name.toLocaleLowerCase('ko-KR').includes(name))
      : rows;
  }

  detail(id: string): AdminMileageResponseDto {
    const row = this.records({}, id)[0];
    if (!row) throw this.notFound();
    return row;
  }

  reject(id: string, input: RejectAdminMileageDto): AdminMileageResponseDto {
    return this.review(id, input, {
      approvalStatus: 'rejected',
      finalAmount: null,
      mileageAmount: null,
    });
  }

  approve(id: string, input: ApproveAdminMileageDto): AdminMileageResponseDto {
    const mileageAmount = mileageFromLiters(`${input.liters} L`);
    if (mileageAmount === null) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: '주유량을 확인해 주세요.',
      });
    }
    return this.review(id, input, {
      approvalStatus: 'approved',
      finalAmount: input.finalAmount,
      mileageAmount,
    });
  }

  private review(
    id: string,
    input: Pick<RejectAdminMileageDto, 'reviewVersion'>,
    decision: {
      approvalStatus: 'approved' | 'rejected';
      finalAmount: number | null;
      mileageAmount: number | null;
    },
  ): AdminMileageResponseDto {
    return this.database.db.transaction(
      (tx) => {
        const current = this.detail(id);
        if (
          current.settlementId !== null ||
          current.reviewVersion !== input.reviewVersion
        ) {
          throw this.conflict();
        }
        // A lost response can be retried without rewriting the decision or its timestamp.
        if (
          current.status === decision.approvalStatus &&
          current.finalAmount === decision.finalAmount &&
          current.mileageAmount === decision.mileageAmount
        )
          return current;
        if (current.status !== 'pending') throw this.conflict();
        if (
          decision.approvalStatus === 'approved' &&
          (!current.photos.receipt || !current.photos.meter)
        )
          throw this.conflict();
        const now = new Date().toISOString();
        const changed = tx
          .update(applications)
          .set({
            ...decision,
            rejectionReason: null,
            decidedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(applications.id, id),
              eq(applications.approvalStatus, 'pending'),
              isNull(applications.settlementId),
            ),
          )
          .returning({ id: applications.id })
          .get();
        if (!changed) throw this.conflict();
        return this.detail(id);
      },
      { behavior: 'immediate' },
    );
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
    const find = () =>
      this.database.db
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
        .get();
    const photo = find();
    if (!photo) throw this.notFound();
    const content = await this.storage.get(photo.key);
    const currentAdmin = this.auth.findSession(session.tokenHash);
    if (!currentAdmin || currentAdmin.id !== session.user.id) {
      throw new UnauthorizedException({
        code: 'INVALID_ADMIN_SESSION',
        message: '관리자 로그인이 필요합니다.',
      });
    }
    const current = find();
    if (!current || current.id !== photo.id || current.key !== photo.key)
      throw this.notFound();
    return content;
  }

  private records(
    query: AdminMileageQueryDto,
    id?: string,
  ): AdminMileageResponseDto[] {
    return this.database.db
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
        submittedAt: applications.submittedAt,
        decidedAt: applications.decidedAt,
        settlementId: applications.settlementId,
        // Late OCR after a rejection of unread photos is not applied to the application.
        ocrEvidence: sql<
          string | null
        >`(SELECT json_array(${ocrJobs.sourceVersion}, ${ocrJobs.extractorVersion}, ${ocrJobs.result}, ${ocrJobs.errorCode})
          FROM ${ocrJobs} WHERE ${ocrJobs.applicationId} = ${applications.id}
          AND ${ocrJobs.extractorVersion} = ${OCR_VERSION} AND ${ocrJobs.status} = 'completed'
          AND ${applications.matchStatus} <> 'pending'
          AND ${ocrJobs.sourceVersion} = COALESCE((SELECT ${resubmissions.submissionVersion} FROM ${resubmissions}
            WHERE ${resubmissions.applicationId} = ${applications.id} ORDER BY ${resubmissions.id} DESC LIMIT 1), ${ocrJobs.sourceVersion}) LIMIT 1)`,
        receiptPhotoIdentity: sql<
          string | null
        >`(SELECT json_array(${photos.id}, ${photos.storageKey}, ${photos.originalStorageKey}, ${photos.byteSize}) FROM ${photos} WHERE ${photos.mileageApplicationId} = ${applications.id} AND ${photos.kind} = 'receipt')`,
        meterPhotoIdentity: sql<
          string | null
        >`(SELECT json_array(${photos.id}, ${photos.storageKey}, ${photos.originalStorageKey}, ${photos.byteSize}) FROM ${photos} WHERE ${photos.mileageApplicationId} = ${applications.id} AND ${photos.kind} = CASE WHEN ${applications.photoMode} = 'single' THEN 'receipt' ELSE 'meter' END)`,
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
        desc(sql`julianday(${applications.submittedAt})`),
        desc(applications.id),
      )
      .all()
      .map(
        ({
          receiptPhotoIdentity,
          meterPhotoIdentity,
          requestHash,
          idempotencyKey,
          ocrEvidence,
          ...row
        }) => {
          for (const amount of [
            row.receiptAmount,
            row.meterAmount,
            row.finalAmount,
            row.mileageAmount,
          ]) {
            if (
              amount !== null &&
              (!Number.isSafeInteger(amount) || amount < 0)
            )
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
