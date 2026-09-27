import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DatabaseService } from '../database/database.service';
import { MileageOcrService } from './mileage-ocr.service';
import { PhotoStorageService } from './photo-storage.service';
import { MileageRepository, type OcrJob } from './mileage.repository';
import { MileageOcrWorkerService } from './mileage-ocr-worker.service';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const job = (id: string) => ({ id }) as OcrJob;

const reading = {
  reading: {
    receipt: null,
    meter: null,
    mirroredImages: [false, false],
  },
  durationMs: 1,
};

const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};

describe('MileageOcrWorkerService lifecycle', () => {
  let previousLimit: string | undefined;

  beforeEach(() => {
    previousLimit = process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT;
    process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT = '10';
    jest.useFakeTimers();
  });

  afterEach(() => {
    if (previousLimit === undefined)
      delete process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT;
    else process.env.MILEAGE_OCR_LUNA_DAILY_LIMIT = previousLimit;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function createWorker(
    options: {
      jobs?: OcrJob[];
      configured?: boolean;
      read?: jest.Mock;
      renew?: jest.Mock;
    } = {},
  ) {
    const jobs = options.jobs ?? [];
    const repository = {
      interruptExpiredOcrJobs: jest.fn().mockResolvedValue(undefined),
      claimOcrJob: jest
        .fn()
        .mockImplementation(() => Promise.resolve(jobs.shift())),
      renewOcrLease: options.renew ?? jest.fn().mockResolvedValue(true),
      ocrSource: jest.fn().mockResolvedValue({
        receiptKey: 'receipt.jpg',
        meterKey: 'meter.jpg',
      }),
      reserveOcrCall: jest.fn().mockResolvedValue(true),
      finishOcrJob: jest.fn().mockResolvedValue(undefined),
    } as unknown as MileageRepository;
    const ocr = {
      isConfigured: jest.fn().mockReturnValue(options.configured ?? true),
      readApplication: options.read ?? jest.fn().mockResolvedValue(reading),
    } as unknown as MileageOcrService;
    const storage = {
      get: jest.fn().mockResolvedValue(Buffer.from('photo')),
    } as unknown as PhotoStorageService;
    return {
      worker: new MileageOcrWorkerService(repository, ocr, storage),
      repository: repository as unknown as {
        interruptExpiredOcrJobs: jest.Mock;
        claimOcrJob: jest.Mock;
        renewOcrLease: jest.Mock;
        finishOcrJob: jest.Mock;
      },
      ocr: ocr as unknown as { readApplication: jest.Mock },
      jobs,
    };
  }

  it('keeps two OCR calls in flight and fills an idle lane on the next poll', async () => {
    const first = deferred<typeof reading>();
    const second = deferred<typeof reading>();
    let inFlight = 0;
    let maximumInFlight = 0;
    const read = jest
      .fn()
      .mockImplementationOnce(() => {
        inFlight++;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        return first.promise.finally(() => inFlight--);
      })
      .mockImplementationOnce(() => {
        inFlight++;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        return second.promise.finally(() => inFlight--);
      });
    const { worker, jobs, ocr } = createWorker({ jobs: [job('first')], read });

    await worker.onModuleInit();
    await flush();
    expect(ocr.readApplication).toHaveBeenCalledTimes(1);

    jobs.push(job('second'));
    await jest.advanceTimersByTimeAsync(15_000);
    expect(ocr.readApplication).toHaveBeenCalledTimes(2);
    expect(maximumInFlight).toBe(2);

    first.resolve(reading);
    second.resolve(reading);
    await flush();
    await worker.onModuleDestroy();
  });

  it('caps five queued jobs at two calls while polls continue, then refills a freed lane', async () => {
    const calls = Array.from({ length: 5 }, () => deferred<typeof reading>());
    let inFlight = 0;
    let maximumInFlight = 0;
    const read = jest.fn().mockImplementation(() => {
      const current = calls[read.mock.calls.length - 1];
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      return current.promise.finally(() => inFlight--);
    });
    const { worker, repository, ocr } = createWorker({
      jobs: ['one', 'two', 'three', 'four', 'five'].map(job),
      read,
    });

    await worker.onModuleInit();
    await flush();
    await jest.advanceTimersByTimeAsync(15_000);
    expect(ocr.readApplication).toHaveBeenCalledTimes(2);
    expect(repository.interruptExpiredOcrJobs).toHaveBeenCalledTimes(4);

    calls[0].resolve(reading);
    await flush();
    await jest.advanceTimersByTimeAsync(0);
    expect(ocr.readApplication).toHaveBeenCalledTimes(3);
    expect(inFlight).toBe(2);
    expect(maximumInFlight).toBe(2);

    for (const call of calls.slice(1)) {
      call.resolve(reading);
      await flush();
    }
    expect(ocr.readApplication).toHaveBeenCalledTimes(5);
    await worker.onModuleDestroy();
  });

  it('does nothing when OCR is disabled', async () => {
    const { worker, repository, ocr } = createWorker({ configured: false });

    await worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(15_000);
    await worker.onModuleDestroy();

    expect(repository.interruptExpiredOcrJobs).not.toHaveBeenCalled();
    expect(repository.claimOcrJob).not.toHaveBeenCalled();
    expect(ocr.readApplication).not.toHaveBeenCalled();
  });

  it('waits for claimed jobs but does not claim backlog during shutdown', async () => {
    const first = deferred<typeof reading>();
    const second = deferred<typeof reading>();
    const read = jest
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { worker, repository, ocr } = createWorker({
      jobs: [job('first'), job('second'), job('backlog')],
      read,
    });

    await worker.onModuleInit();
    await flush();
    expect(ocr.readApplication).toHaveBeenCalledTimes(2);

    const stopping = worker.onModuleDestroy();
    first.resolve(reading);
    second.resolve(reading);
    await stopping;
    await flush();

    expect(repository.claimOcrJob).toHaveBeenCalledTimes(2);
    expect(ocr.readApplication).toHaveBeenCalledTimes(2);
  });

  it('keeps database and storage open until Nest drains OCR work', async () => {
    const provider = deferred<typeof reading>();
    const { repository, ocr } = createWorker({
      jobs: [job('one')],
      read: jest.fn().mockReturnValue(provider.promise),
    });
    const order: string[] = [];
    const database = Object.create(
      DatabaseService.prototype,
    ) as DatabaseService;
    Object.defineProperties(database, {
      onModuleInit: { value: undefined },
      connection: {
        value: {
          end: jest.fn().mockImplementation(() => {
            order.push('database');
            return Promise.resolve();
          }),
        },
      },
    });
    const storage = Object.create(
      PhotoStorageService.prototype,
    ) as PhotoStorageService;
    Object.defineProperties(storage, {
      client: {
        value: {
          destroy: jest.fn(() => {
            order.push('storage');
          }),
        },
      },
      get: { value: jest.fn().mockResolvedValue(Buffer.from('photo')) },
    });
    repository.finishOcrJob.mockImplementation(() => {
      order.push('finish');
      return Promise.resolve();
    });
    const module = await Test.createTestingModule({
      providers: [
        { provide: MileageRepository, useValue: repository },
        { provide: MileageOcrService, useValue: ocr },
        { provide: PhotoStorageService, useValue: storage },
        { provide: DatabaseService, useValue: database },
        MileageOcrWorkerService,
      ],
    }).compile();

    await module.init();
    await flush();
    let closed = false;
    const closing = module.close().then(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);
    expect(order).toEqual([]);

    provider.resolve(reading);
    await closing;
    expect(order.indexOf('finish')).toBeLessThan(order.indexOf('database'));
    expect(order.indexOf('finish')).toBeLessThan(order.indexOf('storage'));
  });

  it('renews a pending job, absorbs renewal errors, and clears the heartbeat on completion', async () => {
    const provider = deferred<typeof reading>();
    const renew = jest
      .fn()
      .mockRejectedValue(new Error('database unavailable'));
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { worker, repository } = createWorker({
      jobs: [job('one')],
      read: jest.fn().mockReturnValue(provider.promise),
      renew,
    });

    const processing = worker.processOne();
    await flush();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(repository.renewOcrLease).toHaveBeenCalledWith('one');
    expect(error).toHaveBeenCalledWith('Mileage OCR lease renewal failed');

    provider.resolve(reading);
    await processing;
    await jest.advanceTimersByTimeAsync(20_000);
    expect(repository.renewOcrLease).toHaveBeenCalledTimes(1);
  });

  it('does not overlap lease renewals and waits for a pending renewal on shutdown', async () => {
    const provider = deferred<typeof reading>();
    const renewal = deferred<boolean>();
    const { worker, repository } = createWorker({
      jobs: [job('one')],
      read: jest.fn().mockReturnValue(provider.promise),
      renew: jest.fn().mockReturnValue(renewal.promise),
    });

    await worker.onModuleInit();
    await flush();
    await jest.advanceTimersByTimeAsync(40_000);
    expect(repository.renewOcrLease).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = worker.onModuleDestroy().then(() => {
      stopped = true;
    });
    provider.resolve(reading);
    await flush();
    expect(stopped).toBe(false);

    renewal.resolve(true);
    await stopping;
    expect(stopped).toBe(true);
  });

  it('clears the heartbeat after a provider failure', async () => {
    const provider = deferred<typeof reading>();
    const { worker, repository } = createWorker({
      jobs: [job('one')],
      read: jest.fn().mockReturnValue(provider.promise),
    });

    const processing = worker.processOne();
    await flush();
    await jest.advanceTimersByTimeAsync(10_000);
    provider.reject(new Error('provider unavailable'));
    await processing;
    await jest.advanceTimersByTimeAsync(20_000);

    expect(repository.renewOcrLease).toHaveBeenCalledTimes(1);
    expect(repository.finishOcrJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'one' }),
      expect.objectContaining({ lunaError: 'LUNA_FAILED' }),
    );
  });
});
