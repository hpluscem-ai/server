import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { catchError, concatMap, finalize } from 'rxjs';
import { MAX_PHOTO_BYTES } from './photo-storage.service';

@Injectable()
export class MileageUploadInterceptor implements NestInterceptor {
  private activeUploads = 0;
  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    if (!request.is('multipart/form-data'))
      throw new UnsupportedMediaTypeException({
        code: 'MULTIPART_REQUIRED',
        message: '사진을 multipart/form-data로 전송해 주세요.',
      });
    // Bound temporary disk use as well as the separate image decoder's memory use.
    if (this.activeUploads >= 2)
      throw new ServiceUnavailableException({
        code: 'PHOTO_PROCESSING_BUSY',
        message: '사진 처리 중입니다. 잠시 후 다시 시도해 주세요.',
      });
    this.activeUploads++;
    let directory: string;
    try {
      directory = await mkdtemp(join(tmpdir(), 'hpluseco-mileage-'));
    } catch (error) {
      this.activeUploads--;
      throw error;
    }
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= rm(directory, { recursive: true, force: true })
        .catch(() =>
          Logger.warn(
            'Mileage temporary files require cleanup',
            'MileageUploadInterceptor',
          ),
        )
        .finally(() => {
          this.activeUploads--;
        }));
    const limits = {
      fileSize: MAX_PHOTO_BYTES,
      files: 2,
      fields: 3,
      parts: 5,
      fieldNameSize: 64,
      fieldSize: 128,
      fieldArrayIndexLimit: 0,
    };
    const upload = multer({
      storage: multer.diskStorage({
        destination: directory,
        filename: (_request, _file, callback) => callback(null, randomUUID()),
      }),
      limits,
    }).fields([
      { name: 'receipt', maxCount: 1 },
      { name: 'meter', maxCount: 1 },
    ]);
    try {
      await new Promise<void>((resolve, reject) => {
        upload(request, response, (error) =>
          error
            ? reject(
                error instanceof Error ? error : new Error('Invalid upload'),
              )
            : resolve(),
        );
      });
      return next.handle().pipe(
        // Release the upload slot before acknowledging success or failure to a retrying client.
        concatMap(async (value: unknown) => {
          await cleanup();
          return value;
        }),
        catchError(async (error: unknown) => {
          await cleanup();
          throw error;
        }),
        finalize(() => {
          void cleanup();
        }),
      );
    } catch (error) {
      await cleanup();
      if (
        error instanceof multer.MulterError &&
        error.code === 'LIMIT_FILE_SIZE'
      ) {
        throw new PayloadTooLargeException({
          code: 'PHOTO_TOO_LARGE',
          message: '사진은 한 장당 50MB 이하로 등록해 주세요.',
        });
      }
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: '사진과 요청 식별자의 형식과 개수를 확인해 주세요.',
      });
    }
  }
}
