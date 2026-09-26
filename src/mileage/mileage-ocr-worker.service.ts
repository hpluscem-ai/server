import sharp from 'sharp';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { MileageRepository, type OcrResult } from './mileage.repository';
import {
  MileageOcrService,
  OcrFailure,
  positiveLimit,
} from './mileage-ocr.service';
import { PhotoStorageService } from './photo-storage.service';

const emptyResult = (): OcrResult => ({
  receipt: null,
  meter: null,
  clovaError: null,
  lunaError: null,
  clovaDurationMs: null,
  lunaDurationMs: null,
  lunaInputTokens: null,
  lunaOutputTokens: null,
});

@Injectable()
export class MileageOcrWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MileageOcrWorkerService.name);
  private timer?: NodeJS.Timeout;
  private draining?: Promise<void>;

  constructor(
    private readonly repository: MileageRepository,
    private readonly ocr: MileageOcrService,
    private readonly storage: PhotoStorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    // A previous process may have sent a paid request before its response was lost.
    await this.repository.interruptRunningOcrJobs();
    if (!this.ocr.isConfigured()) return;
    this.timer = setInterval(() => void this.drain(), 5000);
    this.timer.unref();
    void this.drain();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.draining;
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.runDrain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async runDrain(): Promise<void> {
    try {
      while (await this.processOne()) continue;
    } catch {
      this.logger.error('Mileage OCR worker stopped after an internal error');
    }
  }

  async processOne(): Promise<boolean> {
    if (!this.ocr.isConfigured()) return false;
    const job = await this.repository.claimOcrJob();
    if (!job) return false;
    const result = emptyResult();
    const source = await this.repository.ocrSource(job);
    if (!source) {
      await this.repository.finishOcrJob(job, result, 'STALE_SOURCE');
      return true;
    }
    let images: Buffer[];
    try {
      images = await Promise.all(
        [...new Set([source.receiptKey, source.meterKey])].map((key) =>
          this.storage.get(key),
        ),
      );
    } catch {
      await this.repository.finishOcrJob(job, result, 'PHOTO_READ_FAILED');
      return true;
    }
    if (!(await this.repository.ocrSource(job))) {
      await this.repository.finishOcrJob(job, result, 'STALE_SOURCE');
      return true;
    }
    const lunaLimit = positiveLimit(process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT);
    if (
      lunaLimit === null ||
      !(await this.repository.reserveOcrCall(job.id, lunaLimit))
    ) {
      await this.repository.finishOcrJob(job, result, 'DAILY_LIMIT_REACHED');
      return true;
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!(await this.repository.ocrSource(job)))
          throw new OcrFailure('STALE_SOURCE');
        const response = await this.ocr.readApplication(images);
        result.receipt = response.reading.receipt;
        result.meter = response.reading.meter;
        result.lunaDurationMs =
          (result.lunaDurationMs ?? 0) + response.durationMs;
        result.lunaInputTokens =
          (result.lunaInputTokens ?? 0) + (response.usage?.inputTokens ?? 0);
        result.lunaOutputTokens =
          (result.lunaOutputTokens ?? 0) + (response.usage?.outputTokens ?? 0);
        result.lunaCachedTokens =
          (result.lunaCachedTokens ?? 0) + (response.usage?.cachedTokens ?? 0);
        result.lunaCacheWriteTokens =
          (result.lunaCacheWriteTokens ?? 0) +
          (response.usage?.cacheWriteTokens ?? 0);
        result.attempts = attempt + 1;
        if (!response.reading.mirroredImages.some((value) => value === true))
          break;
        if (attempt === 1) throw new OcrFailure('MIRROR_CORRECTION_FAILED');
        // Work on an in-memory copy; originals and stored normalized photos stay intact.
        images = await Promise.all(
          images.map(async (image, index) =>
            response.reading.mirroredImages[index] === true
              ? sharp(image).flop().jpeg({ quality: 90 }).toBuffer()
              : image,
          ),
        );
        if (!(await this.repository.ocrSource(job)))
          throw new OcrFailure('STALE_SOURCE');
        if (!(await this.repository.reserveOcrCall(job.id, lunaLimit, true)))
          throw new OcrFailure('DAILY_LIMIT_REACHED');
      }
    } catch (error) {
      result.lunaError = errorCode(error, 'LUNA_FAILED');
    }
    await this.repository.finishOcrJob(job, result);
    return true;
  }
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof OcrFailure ? error.code : fallback;
}
