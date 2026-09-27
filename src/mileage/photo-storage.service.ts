import {
  Injectable,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

export const MAX_PHOTO_BYTES = 50 * 1024 * 1024;

@Injectable()
export class PhotoStorageService implements OnApplicationShutdown {
  private client?: S3Client;
  private bucket?: string;

  ensureConfigured(): void {
    if (this.client) return;
    const endpoint = process.env.SUPABASE_S3_ENDPOINT?.trim();
    const region = process.env.SUPABASE_S3_REGION?.trim();
    const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim();
    const accessKeyId = process.env.SUPABASE_S3_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.SUPABASE_S3_SECRET_ACCESS_KEY?.trim();
    if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
      throw this.unavailable();
    }
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw this.unavailable();
    }
    const localHttp =
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      process.env.NODE_ENV !== 'production' &&
      process.env.VERCEL_ENV !== 'production';
    if (
      (url.protocol !== 'https:' && !localHttp) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw this.unavailable();
    }
    this.bucket = bucket;
    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(
    key: string,
    path: string,
    contentType: string,
    size: number,
  ): Promise<void> {
    this.ensureConfigured();
    const stream = createReadStream(path);
    try {
      await this.client!.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: stream,
          ContentType: contentType,
          ContentLength: size,
          CacheControl: 'private, no-store',
        }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
    } catch {
      throw this.unavailable();
    } finally {
      stream.destroy();
    }
  }

  async remove(key: string): Promise<void> {
    this.ensureConfigured();
    try {
      await this.client!.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
    } catch {
      throw this.unavailable();
    }
  }

  async get(key: string): Promise<Buffer> {
    this.ensureConfigured();
    let body: Readable | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      body?.destroy(new Error('Photo read timed out'));
    }, 30000);
    try {
      const result = await this.client!.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: controller.signal },
      );
      if (!(result.Body instanceof Readable)) throw this.unavailable();
      body = result.Body;
      if ((result.ContentLength ?? 0) > MAX_PHOTO_BYTES)
        throw this.unavailable();
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_PHOTO_BYTES) throw this.unavailable();
        chunks.push(chunk);
      }
      if (
        !size ||
        (result.ContentLength !== undefined && size !== result.ContentLength)
      )
        throw this.unavailable();
      return Buffer.concat(chunks);
    } catch {
      throw this.unavailable();
    } finally {
      clearTimeout(timer);
      body?.destroy();
    }
  }

  onApplicationShutdown(): void {
    this.client?.destroy();
  }

  private unavailable() {
    return new ServiceUnavailableException({
      code: 'PHOTO_STORAGE_UNAVAILABLE',
      message: '사진 저장소를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
}
