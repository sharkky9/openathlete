import { Job, Queue } from 'bullmq';

import { PrismaService } from '../../prisma/services/prisma.service';
import {
  ActivityImportJobData,
  ActivityProcessingJobData,
  QueueService,
} from '../queue.service';
import {
  FULL_IMPORT_STALE_AFTER_MS,
  FullImportCompletionJobData,
  FullImportCompletionService,
} from './full-import-completion.service';

const PROVIDER_ACCOUNT_ID = 17;
const REQUESTED_AT = new Date('2026-08-07T20:00:00.000Z');
const RUN_ID = REQUESTED_AT.getTime().toString();

function job<Data>(
  data: Data,
  returnvalue?: unknown,
): Job<Data, unknown, string> {
  return { data, returnvalue } as Job<Data, unknown, string>;
}

function setup(options?: {
  activeImports?: Job<ActivityImportJobData>[];
  failedImports?: Job<ActivityImportJobData>[];
  completedImports?: Job<ActivityImportJobData>[];
  activeProcessing?: Job<ActivityProcessingJobData>[];
  failedProcessing?: Job<ActivityProcessingJobData>[];
}) {
  const importJobs = {
    active: options?.activeImports ?? [],
    failed: options?.failedImports ?? [],
    completed: options?.completedImports ?? [],
  };
  const processingJobs = {
    active: options?.activeProcessing ?? [],
    failed: options?.failedProcessing ?? [],
  };
  const activityImportQueue = {
    getJobs: jest.fn(async (types: string[]) => {
      if (types.includes('failed')) return importJobs.failed;
      if (types.includes('completed')) return importJobs.completed;
      return importJobs.active;
    }),
  } as unknown as Queue<ActivityImportJobData>;
  const activityProcessingQueue = {
    getJobs: jest.fn(async (types: string[]) =>
      types.includes('failed') ? processingJobs.failed : processingJobs.active,
    ),
  } as unknown as Queue<ActivityProcessingJobData>;
  const completionQueue = {
    add: jest.fn().mockResolvedValue(undefined),
  } as unknown as Queue<FullImportCompletionJobData>;
  const prisma = {
    providerAccount: {
      findUnique: jest.fn().mockResolvedValue({
        fullImportRequestedAt: REQUESTED_AT,
        fullImportCompletedAt: null,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  } as unknown as PrismaService;
  const queueService = {
    assertActivityPipelineAvailable: jest.fn(),
  } as unknown as QueueService;

  return {
    service: new FullImportCompletionService(
      activityImportQueue,
      activityProcessingQueue,
      completionQueue,
      prisma,
      queueService,
    ),
    activityImportQueue,
    activityProcessingQueue,
    completionQueue,
    prisma,
  };
}

const importData = (overrides?: Partial<ActivityImportJobData>) =>
  ({
    providerAccountId: PROVIDER_ACCOUNT_ID,
    activity: {
      externalId: 'a1',
      name: 'Ride',
      startDate: REQUESTED_AT,
      endDate: REQUESTED_AT,
      sport: 'CYCLING',
    },
    fullImportRunId: RUN_ID,
    ...overrides,
  }) satisfies ActivityImportJobData;

const processingData = (overrides?: Partial<ActivityProcessingJobData>) =>
  ({
    providerAccountId: PROVIDER_ACCOUNT_ID,
    eventActivityId: 1,
    eventId: 2,
    fullImportRunId: RUN_ID,
    ...overrides,
  }) satisfies ActivityProcessingJobData;

describe('FullImportCompletionService', () => {
  it('keeps an enqueue-only run pending while import jobs have not settled', async () => {
    const { service, completionQueue, prisma } = setup({
      activeImports: [job(importData())],
    });

    await expect(service.reconcile(PROVIDER_ACCOUNT_ID, RUN_ID)).resolves.toBe(
      'pending',
    );
    expect(completionQueue.add).toHaveBeenCalled();
    expect(prisma.providerAccount.updateMany).not.toHaveBeenCalled();
  });

  it('waits for downstream activity processing after imports settle', async () => {
    const { service, completionQueue, prisma } = setup({
      completedImports: [job(importData())],
      activeProcessing: [job(processingData())],
    });

    await expect(service.reconcile(PROVIDER_ACCOUNT_ID, RUN_ID)).resolves.toBe(
      'pending',
    );
    expect(completionQueue.add).toHaveBeenCalled();
    expect(prisma.providerAccount.updateMany).not.toHaveBeenCalled();
  });

  it('does not complete a Garmin import that is still waiting for its stream', async () => {
    const { service, completionQueue, prisma } = setup({
      completedImports: [job(importData(), { waitingForStream: true })],
    });

    await expect(service.reconcile(PROVIDER_ACCOUNT_ID, RUN_ID)).resolves.toBe(
      'pending',
    );
    expect(completionQueue.add).toHaveBeenCalled();
    expect(prisma.providerAccount.updateMany).not.toHaveBeenCalled();
  });

  it('releases the latch without reporting completion after terminal failure', async () => {
    const { service, prisma, completionQueue } = setup({
      failedProcessing: [job(processingData())],
    });

    await expect(service.reconcile(PROVIDER_ACCOUNT_ID, RUN_ID)).resolves.toBe(
      'failed',
    );
    expect(prisma.providerAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { fullImportRequestedAt: null },
      }),
    );
    expect(completionQueue.add).not.toHaveBeenCalled();
  });

  it('stamps completion only after both queues have no unfinished run jobs', async () => {
    const { service, prisma } = setup({
      completedImports: [job(importData())],
    });

    await expect(service.reconcile(PROVIDER_ACCOUNT_ID, RUN_ID)).resolves.toBe(
      'completed',
    );
    expect(prisma.providerAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { fullImportCompletedAt: expect.any(Date) },
      }),
    );
  });

  it('fails closed when BullMQ state cannot be read', async () => {
    const { service, activityImportQueue, prisma } = setup();
    jest
      .mocked(activityImportQueue.getJobs)
      .mockRejectedValue(new Error('redis unavailable'));

    await expect(
      service.reconcile(PROVIDER_ACCOUNT_ID, RUN_ID),
    ).rejects.toThrow('redis unavailable');
    expect(prisma.providerAccount.updateMany).not.toHaveBeenCalled();
  });

  it('releases a stale run so it can be requested again', async () => {
    const { service, prisma } = setup();
    const now = new Date(REQUESTED_AT.getTime() + FULL_IMPORT_STALE_AFTER_MS);

    await expect(
      service.releaseIfStale(PROVIDER_ACCOUNT_ID, REQUESTED_AT, now),
    ).resolves.toBe(true);
    expect(prisma.providerAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { fullImportRequestedAt: null } }),
    );
  });

  it('retags and retries failed processing jobs during a later run', async () => {
    const failedJob = job(processingData()) as Job<ActivityProcessingJobData>;
    failedJob.updateData = jest.fn().mockResolvedValue(undefined);
    failedJob.retry = jest.fn().mockResolvedValue(undefined);
    const { service } = setup({ failedProcessing: [failedJob] });
    const nextRunId = (REQUESTED_AT.getTime() + 1_000).toString();

    await expect(
      service.recoverProcessingJobs(PROVIDER_ACCOUNT_ID, nextRunId),
    ).resolves.toBe(1);
    expect(failedJob.updateData).toHaveBeenCalledWith(
      expect.objectContaining({ fullImportRunId: nextRunId }),
    );
    expect(failedJob.retry).toHaveBeenCalledWith('failed');
  });

  it('adopts still-running processing jobs when a stale run is restarted', async () => {
    const unfinishedJob = job(
      processingData(),
    ) as Job<ActivityProcessingJobData>;
    unfinishedJob.updateData = jest.fn().mockResolvedValue(undefined);
    const { service } = setup({ activeProcessing: [unfinishedJob] });
    const nextRunId = (REQUESTED_AT.getTime() + 1_000).toString();

    await expect(
      service.recoverProcessingJobs(PROVIDER_ACCOUNT_ID, nextRunId),
    ).resolves.toBe(1);
    expect(unfinishedJob.updateData).toHaveBeenCalledWith(
      expect.objectContaining({ fullImportRunId: nextRunId }),
    );
  });
});
