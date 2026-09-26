import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isISO8601 } from 'class-validator';
import { AuthService, type AuthenticatedSession } from '../auth';
import { normalizeDateRange } from '../common/date-range-query';
import {
  CreateMileageDto,
  ResubmitMileageDto,
  MileageDetailDto,
  MileageListDto,
  MileageListQueryDto,
  MileageResponseDto,
} from './mileage.dto';
import {
  MileageRepository,
  type MileageCursor,
  type MileageRecord,
} from './mileage.repository';
import { PhotoProcessorService } from './photo-processor.service';
import { PhotoStorageService } from './photo-storage.service';
import { MileageOcrService } from './mileage-ocr.service';

@Injectable()
export class MileageService {
  private readonly logger = new Logger(MileageService.name);
  constructor(
    private readonly repository: MileageRepository,
    private readonly processor: PhotoProcessorService,
    private readonly storage: PhotoStorageService,
    private readonly auth: AuthService,
    private readonly ocr: MileageOcrService,
  ) {}

  async create(
    session: AuthenticatedSession,
    input: CreateMileageDto,
    files: { receipt?: Express.Multer.File[]; meter?: Express.Multer.File[] },
  ): Promise<MileageDetailDto> {
    const photoMode = input.photoMode ?? 'separate';
    if (
      files?.receipt?.length !== 1 ||
      (photoMode === 'single'
        ? Boolean(files?.meter?.length)
        : files?.meter?.length !== 1)
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message:
          photoMode === 'single'
            ? '영수증과 계기판이 함께 찍힌 사진 한 장을 등록해 주세요.'
            : '영수증과 계기판 사진을 한 장씩 등록해 주세요.',
      });
    }
    const pair = await this.processor.processPhotos(
      photoMode === 'single'
        ? [files.receipt[0]]
        : [files.receipt[0], files.meter![0]],
    );
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify(
          photoMode === 'single'
            ? ['single', pair[0].hash]
            : pair.map((photo) => photo.hash),
        ),
      )
      .digest('hex');
    const key = input.idempotencyKey.toLowerCase();
    this.revalidate(session);
    const existing = this.repository.findByKey(session.user.id, key);
    if (existing) {
      this.assertSameRequest(existing, requestHash);
      return this.findOne(session.user.id, existing.id);
    }
    this.storage.ensureConfigured();
    const id = randomUUID();
    const kinds = ['receipt', 'meter'] as const;
    const photos = pair.map((photo, index) => ({
      kind: kinds[index],
      storageKey: `mileage/${id}/${kinds[index]}.jpg`,
      contentType: 'image/jpeg',
      byteSize: photo.size,
      originalStorageKey: `mileage/${id}/${kinds[index]}-original`,
      originalContentType: photo.contentType,
      originalByteSize: photo.originalSize,
    }));
    const keys = photos.flatMap((photo) => [
      photo.originalStorageKey,
      photo.storageKey,
    ]);
    this.repository.trackAttempt(id, session.user.id, keys);
    try {
      for (let i = 0; i < photos.length; i++) {
        await this.storage.put(
          photos[i].originalStorageKey,
          pair[i].path,
          pair[i].contentType,
          pair[i].originalSize,
        );
        await this.storage.put(
          photos[i].storageKey,
          pair[i].outputPath,
          'image/jpeg',
          pair[i].size,
        );
      }
      // No await between final session validation and the synchronous DB transaction.
      const current = this.revalidate(session);
      const saved = this.repository.commit({
        id,
        userId: current.user.id,
        logisticsCompanyId: current.user.logisticsCompanyId,
        idempotencyKey: key,
        requestHash,
        queueOcr: this.ocr.isConfigured(),
        photoMode,
        photos,
      });
      if (saved.id !== id) await this.cleanup(id, keys, false);
      this.assertSameRequest(saved, requestHash);
      this.revalidate(session);
      return this.findOne(session.user.id, saved.id);
    } catch (error) {
      // Keep failed attempt records: a timed-out remote PUT may have completed ambiguously.
      await this.cleanup(id, keys, true);
      throw error;
    }
  }

  async resubmit(
    session: AuthenticatedSession,
    id: string,
    input: ResubmitMileageDto,
    files: { receipt?: Express.Multer.File[]; meter?: Express.Multer.File[] },
  ): Promise<MileageDetailDto> {
    const kinds = (['receipt', 'meter'] as const).filter(
      (kind) => files?.[kind]?.length,
    );
    if (!kinds.length || kinds.some((kind) => files[kind]!.length !== 1))
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: '교체할 사진을 한 장 이상 선택해 주세요.',
      });
    const row = this.repository.findOne(session.user.id, id);
    if (!row) throw this.notFound();
    const photoMode = input.photoMode ?? 'separate';
    const key = input.idempotencyKey.toLowerCase();
    if (
      (photoMode === 'single' &&
        (kinds.length !== 1 || kinds[0] !== 'receipt')) ||
      (!this.repository.findResubmission(id, key) &&
        photoMode === 'separate' &&
        row.photoMode === 'single' &&
        kinds.length !== 2)
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: '선택한 장수에 맞는 사진을 새로 등록해 주세요.',
      });
    }
    if (!this.repository.findResubmission(id, key))
      this.repository.assertResubmittable(row, input.submissionVersion);
    const processed = await this.processor.processPhotos(
      kinds.map((kind) => files[kind]![0]),
    );
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          input.submissionVersion,
          ...(photoMode === 'single' ? ['single'] : []),
          ...processed.map((photo, index) => [kinds[index], photo.hash]),
        ]),
      )
      .digest('hex');
    this.revalidate(session);
    const replay = this.repository.findResubmission(id, key);
    if (replay) {
      this.assertSameRequest(replay, requestHash);
      return this.findOne(session.user.id, id);
    }
    this.storage.ensureConfigured();
    const attemptId = randomUUID();
    const photos = processed.map((photo, index) => ({
      kind: kinds[index],
      storageKey: `mileage/${id}/resubmissions/${attemptId}/${kinds[index]}.jpg`,
      contentType: 'image/jpeg',
      byteSize: photo.size,
      originalStorageKey: `mileage/${id}/resubmissions/${attemptId}/${kinds[index]}-original`,
      originalContentType: photo.contentType,
      originalByteSize: photo.originalSize,
    }));
    const keys = photos.flatMap((photo) => [
      photo.originalStorageKey,
      photo.storageKey,
    ]);
    this.repository.trackAttempt(attemptId, session.user.id, keys);
    try {
      for (let i = 0; i < photos.length; i++) {
        await this.storage.put(
          photos[i].originalStorageKey,
          processed[i].path,
          processed[i].contentType,
          processed[i].originalSize,
        );
        await this.storage.put(
          photos[i].storageKey,
          processed[i].outputPath,
          'image/jpeg',
          processed[i].size,
        );
      }
      const current = this.revalidate(session);
      const saved = this.repository.commitResubmission({
        id,
        userId: current.user.id,
        attemptId,
        idempotencyKey: key,
        requestHash,
        submissionVersion: input.submissionVersion,
        queueOcr: this.ocr.isConfigured(),
        photoMode,
        photos,
      });
      if (!saved.committed) await this.cleanup(attemptId, keys, false);
      this.assertSameRequest(saved, requestHash);
      this.revalidate(session);
      return this.findOne(session.user.id, id);
    } catch (error) {
      await this.cleanup(attemptId, keys, true);
      throw error;
    }
  }

  findList(userId: string, input: MileageListQueryDto): MileageListDto {
    const query = { ...input, ...normalizeDateRange(input) };
    const cursor = query.cursor ? this.decodeCursor(query) : undefined;
    const rows = this.repository.findList(userId, query, cursor);
    const limit = query.limit ?? 20;
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => this.present(row));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        more && last
          ? Buffer.from(
              JSON.stringify({
                at: last.submittedAt,
                id: last.id,
                order: query.order ?? 'desc',
                from: query.createdFrom ?? null,
                before: query.createdBefore ?? null,
              } satisfies MileageCursor),
            ).toString('base64url')
          : null,
    };
  }

  findOne(userId: string, id: string): MileageDetailDto {
    const row = this.repository.findOne(userId, id);
    if (!row) throw this.notFound();
    const path = (kind: 'receipt' | 'meter') =>
      row.photos.some(
        (photo) =>
          photo.kind === (row.photoMode === 'single' ? 'receipt' : kind),
      )
        ? `/api/v1/mileage/applications/${id}/photos/${kind}`
        : null;
    return {
      ...this.present(row),
      photoMode: row.photoMode,
      submissionVersion: this.repository.submissionVersion(row),
      photos: { receipt: path('receipt'), meter: path('meter') },
    };
  }

  async photo(
    session: AuthenticatedSession,
    id: string,
    kind: string,
  ): Promise<Buffer> {
    if (kind !== 'receipt' && kind !== 'meter')
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: '사진 종류를 확인해 주세요.',
      });
    const row = this.repository.findOne(session.user.id, id);
    const photo = row?.photos.find(
      (item) => item.kind === (row.photoMode === 'single' ? 'receipt' : kind),
    );
    if (!photo) throw this.notFound();
    const content = await this.storage.get(photo.storageKey);
    this.revalidate(session);
    const latest = this.repository.findOne(session.user.id, id);
    const current = latest?.photos.find(
      (item) =>
        item.kind === (latest.photoMode === 'single' ? 'receipt' : kind),
    );
    if (!current || current.storageKey !== photo.storageKey)
      throw this.notFound();
    return content;
  }

  private revalidate(session: AuthenticatedSession): AuthenticatedSession {
    const current = this.auth.authenticateSessionHash(session.tokenHash);
    if (!current || current.user.id !== session.user.id)
      throw new UnauthorizedException({
        code: 'INVALID_SESSION',
        message:
          '로그인이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.',
      });
    return current;
  }

  private async cleanup(
    id: string,
    keys: string[],
    keepRecord: boolean,
  ): Promise<void> {
    try {
      // The successful DB transaction removes this row. Never delete committed files.
      if (!this.repository.hasAttempt(id)) return;
      const results = await Promise.allSettled(
        keys.map((key) => this.storage.remove(key)),
      );
      if (
        !keepRecord &&
        results.every((result) => result.status === 'fulfilled')
      )
        this.repository.forgetAttempt(id);
      else
        this.logger.warn(
          `Mileage upload attempt requires reconciliation: ${id}`,
        );
    } catch {
      this.logger.warn(`Mileage upload attempt requires reconciliation: ${id}`);
    }
  }

  private assertSameRequest(
    record: Pick<MileageRecord, 'requestHash'>,
    hash: string,
  ): void {
    if (record.requestHash !== hash)
      throw new ConflictException({
        code: 'IDEMPOTENCY_CONFLICT',
        message: '같은 요청 식별자로 다른 사진을 등록할 수 없습니다.',
      });
  }

  private decodeCursor(query: MileageListQueryDto): MileageCursor {
    try {
      const value: unknown = JSON.parse(
        Buffer.from(query.cursor!, 'base64url').toString('utf8'),
      );
      if (!value || typeof value !== 'object') throw new Error();
      const cursor = value as Partial<MileageCursor>;
      if (
        typeof cursor.at !== 'string' ||
        !isISO8601(cursor.at, { strict: true, strictSeparator: true }) ||
        new Date(cursor.at).toISOString() !== cursor.at ||
        typeof cursor.id !== 'string' ||
        !cursor.id.length ||
        cursor.id.length > 128 ||
        cursor.order !== (query.order ?? 'desc') ||
        cursor.from !== (query.createdFrom ?? null) ||
        cursor.before !== (query.createdBefore ?? null)
      )
        throw new Error();
      return cursor as MileageCursor;
    } catch {
      throw new BadRequestException({
        code: 'INVALID_CURSOR',
        message: '조회 조건과 다음 페이지 식별자를 확인해 주세요.',
      });
    }
  }

  private present(row: MileageRecord): MileageResponseDto {
    return {
      id: row.id,
      status: row.approvalStatus,
      submittedAt: iso(row.submittedAt),
      decidedAt: row.decidedAt ? iso(row.decidedAt) : null,
      mileageAmount:
        row.approvalStatus === 'approved' ? row.mileageAmount : null,
      finalAmount: row.approvalStatus === 'approved' ? row.finalAmount : null,
      rejectionReason:
        row.approvalStatus === 'rejected' ? row.rejectionReason : null,
    };
  }

  private notFound() {
    return new NotFoundException({
      code: 'MILEAGE_APPLICATION_NOT_FOUND',
      message: '신청 내역을 찾을 수 없습니다.',
    });
  }
}

function iso(value: string): string {
  const normalized = value.replace(' ', 'T');
  return new Date(
    /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}Z`,
  ).toISOString();
}
