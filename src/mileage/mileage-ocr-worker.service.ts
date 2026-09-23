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
  private busy = false;

  constructor(
    private readonly repository: MileageRepository,
    private readonly ocr: MileageOcrService,
    private readonly storage: PhotoStorageService,
  ) {}

  onModuleInit(): void {
    // A previous process may have sent a paid request before its response was lost.
    this.repository.interruptRunningOcrJobs();
    if (!this.ocr.isConfigured()) return;
    this.timer = setInterval(() => void this.drain(), 5000);
    this.timer.unref();
    void this.drain();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (await this.processOne()) continue;
    } catch {
      this.logger.error('Mileage OCR worker stopped after an internal error');
    } finally {
      this.busy = false;
    }
  }

  async processOne(): Promise<boolean> {
    if (!this.ocr.isConfigured()) return false;
    const job = this.repository.claimOcrJob();
    if (!job) return false;
    const result = emptyResult();
    const source = this.repository.ocrSource(job);
    if (!source) {
      this.repository.finishOcrJob(job, result, 'STALE_SOURCE');
      return true;
    }
    let receipt: Buffer;
    let meter: Buffer;
    try {
      [receipt, meter] = await Promise.all([
        this.storage.get(source.receiptKey),
        this.storage.get(source.meterKey),
      ]);
    } catch {
      this.repository.finishOcrJob(job, result, 'PHOTO_READ_FAILED');
      return true;
    }
    if (!this.repository.ocrSource(job)) {
      this.repository.finishOcrJob(job, result, 'STALE_SOURCE');
      return true;
    }
    const clovaLimit = positiveLimit(
      process.env.MILEAGE_OCR_CLOVA_DAILY_LIMIT,
    )!;
    const lunaLimit = positiveLimit(process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT)!;
    if (!this.repository.reserveOcrCalls(job.id, clovaLimit, lunaLimit)) {
      this.repository.finishOcrJob(job, result, 'DAILY_LIMIT_REACHED');
      return true;
    }
    if (!this.repository.ocrSource(job)) {
      this.repository.finishOcrJob(job, result, 'STALE_SOURCE');
      return true;
    }
    const [clova, luna] = await Promise.allSettled([
      this.ocr.readReceipt(receipt),
      this.ocr.readMeter(meter),
    ]);
    if (clova.status === 'fulfilled') {
      result.receipt = clova.value.reading;
      result.clovaDurationMs = clova.value.durationMs;
    } else {
      result.clovaError = errorCode(clova.reason, 'CLOVA_FAILED');
    }
    if (luna.status === 'fulfilled') {
      result.meter = luna.value.reading;
      result.lunaDurationMs = luna.value.durationMs;
      result.lunaInputTokens = luna.value.usage?.inputTokens ?? null;
      result.lunaOutputTokens = luna.value.usage?.outputTokens ?? null;
    } else {
      result.lunaError = errorCode(luna.reason, 'LUNA_FAILED');
    }
    this.repository.finishOcrJob(job, result);
    return true;
  }
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof OcrFailure ? error.code : fallback;
}
