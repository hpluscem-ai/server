import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';

export type ProcessedPhoto = {
  contentType: string;
  originalSize: number;
  size: number;
  hash: string;
  path: string;
  outputPath: string;
};
type WorkerResult =
  | {
      ok: true;
      contentType: string;
      originalSize: number;
      size: number;
      hash: string;
    }
  | { ok: false; code: string };

@Injectable()
export class PhotoProcessorService {
  private active = false;

  async processPair(
    receipt: Express.Multer.File,
    meter: Express.Multer.File,
  ): Promise<[ProcessedPhoto, ProcessedPhoto]> {
    const photos = await this.processPhotos([receipt, meter]);
    return [photos[0], photos[1]];
  }

  async processPhotos(files: Express.Multer.File[]): Promise<ProcessedPhoto[]> {
    // ponytail: one bounded decoder per process; add a bounded worker pool when upload throughput requires it.
    if (this.active)
      throw new ServiceUnavailableException({
        code: 'PHOTO_PROCESSING_BUSY',
        message: '사진 처리 중입니다. 잠시 후 다시 시도해 주세요.',
      });
    this.active = true;
    try {
      const photos: ProcessedPhoto[] = [];
      for (const file of files) photos.push(await this.process(file.path));
      return photos;
    } finally {
      this.active = false;
    }
  }

  private async process(path: string): Promise<ProcessedPhoto> {
    const outputPath = `${path}.jpg`;
    const worker = new Worker(join(__dirname, 'photo-worker.cjs'), {
      workerData: { path, outputPath },
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    // Third-party decoder messages can contain image metadata; discard them.
    worker.stdout.resume();
    worker.stderr.resume();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await new Promise<WorkerResult>((resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ServiceUnavailableException({
                code: 'PHOTO_PROCESSING_TIMEOUT',
                message: '사진 처리가 지연되었습니다. 다시 시도해 주세요.',
              }),
            ),
          30000,
        );
        worker.once('message', (message: WorkerResult) => resolve(message));
        worker.once('error', () =>
          reject(
            new BadRequestException({
              code: 'INVALID_PHOTO',
              message: '사진을 읽을 수 없습니다.',
            }),
          ),
        );
        worker.once('exit', () =>
          reject(
            new BadRequestException({
              code: 'INVALID_PHOTO',
              message: '사진을 읽을 수 없습니다.',
            }),
          ),
        );
      });
      if (!result.ok) {
        const body = {
          code: result.code,
          message: '사진 형식과 크기를 확인해 주세요.',
        };
        if (result.code === 'UNSUPPORTED_PHOTO_TYPE')
          throw new UnsupportedMediaTypeException(body);
        if (result.code === 'PHOTO_TOO_LARGE')
          throw new PayloadTooLargeException(body);
        throw new BadRequestException(body);
      }
      return { ...result, path, outputPath };
    } finally {
      clearTimeout(timer);
      await worker.terminate();
    }
  }
}
