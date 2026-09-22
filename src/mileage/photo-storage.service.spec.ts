import { Readable } from 'node:stream';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { MAX_PHOTO_BYTES, PhotoStorageService } from './photo-storage.service';

const mockSend = jest.fn<Promise<unknown>, [unknown]>();
const mockDestroy = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  ...jest.requireActual<typeof import('@aws-sdk/client-s3')>(
    '@aws-sdk/client-s3',
  ),
  S3Client: jest
    .fn()
    .mockImplementation(() => ({ send: mockSend, destroy: mockDestroy })),
}));

describe('PhotoStorageService', () => {
  let storage: PhotoStorageService;
  const names = [
    'R2_ACCOUNT_ID',
    'R2_BUCKET_NAME',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ];
  let previous: (string | undefined)[];
  beforeEach(() => {
    previous = names.map((name) => process.env[name]);
    process.env.R2_ACCOUNT_ID = 'a'.repeat(32);
    process.env.R2_BUCKET_NAME = 'isolated-test-bucket';
    process.env.R2_ACCESS_KEY_ID = 'isolated-test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'isolated-test-secret';
    mockSend.mockReset();
    mockDestroy.mockReset();
    jest.mocked(S3Client).mockClear();
    storage = new PhotoStorageService();
  });
  afterEach(() => {
    storage.onModuleDestroy();
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    });
  });
  it('fails closed when storage configuration is absent', async () => {
    delete process.env.R2_ACCOUNT_ID;
    await expect(storage.get('private-photo')).rejects.toMatchObject({
      response: { code: 'PHOTO_STORAGE_UNAVAILABLE' },
    });
    expect(S3Client).not.toHaveBeenCalled();
  });
  it('returns the actual bytes and destroys the response stream', async () => {
    const body = Readable.from([Buffer.from('one'), Buffer.from('two')]);
    mockSend.mockResolvedValue({ Body: body, ContentLength: 6 });
    expect(await storage.get('private-photo')).toEqual(Buffer.from('onetwo'));
    expect(body.destroyed).toBe(true);
  });
  it('destroys an oversized response without buffering it', async () => {
    const body = Readable.from([Buffer.from('small')]);
    mockSend.mockResolvedValue({
      Body: body,
      ContentLength: MAX_PHOTO_BYTES + 1,
    });
    await expect(storage.get('private-photo')).rejects.toMatchObject({
      response: { code: 'PHOTO_STORAGE_UNAVAILABLE' },
    });
    expect(body.destroyed).toBe(true);
  });
  it('does not accept a truncated storage response', async () => {
    mockSend.mockResolvedValue({
      Body: Readable.from([Buffer.from('short')]),
      ContentLength: 100,
    });
    await expect(storage.get('private-photo')).rejects.toMatchObject({
      response: { code: 'PHOTO_STORAGE_UNAVAILABLE' },
    });
  });
  it('does not leak storage errors or treat a missing object as an empty photo', async () => {
    mockSend.mockRejectedValue(
      new Error('private storage key and sensitive SDK context'),
    );
    await expect(storage.get('private-photo')).rejects.toMatchObject({
      response: {
        code: 'PHOTO_STORAGE_UNAVAILABLE',
        message:
          '사진 저장소를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
      },
    });
  });
  it('closes upload streams after an SDK failure', async () => {
    mockSend.mockRejectedValue(new Error('isolated failure'));
    await expect(
      storage.put(
        'private-key',
        join(__dirname, '../../test/fixtures/mileage-receipt.heic'),
        'image/heif',
        100,
      ),
    ).rejects.toMatchObject({
      response: { code: 'PHOTO_STORAGE_UNAVAILABLE' },
    });
    const command = mockSend.mock.calls[0][0] as {
      input: { Body: Readable; CacheControl: string };
    };
    expect(command.input.Body.destroyed).toBe(true);
    expect(command.input.CacheControl).toBe('private, no-store');
  });
});
