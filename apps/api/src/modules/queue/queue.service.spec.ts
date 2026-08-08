import { Queue } from 'bullmq';

import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ConnectorProvider, ProviderAccount } from '@openathlete/database';
import { ApiEnvSchemaType } from '@openathlete/shared';

import { ImportedActivity } from '../providers-sync/base/provider-import.interface';
import { ActivityImportJobData, QueueService } from './queue.service';

const ACTIVITY: ImportedActivity = {
  externalId: 'activity-1',
  name: 'Morning ride',
  startDate: new Date('2026-08-01T08:00:00.000Z'),
  endDate: new Date('2026-08-01T09:00:00.000Z'),
  sport: 'CYCLING',
};

const ACCOUNT = {
  providerAccountId: 41,
  provider: ConnectorProvider.INTERVALS_ICU,
  fullImportRequestedAt: new Date('2026-08-07T20:00:00.000Z'),
} as ProviderAccount;

function setup(flags = { import: true, processing: true }) {
  const activityImportQueue = {
    getJob: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
    addBulk: jest.fn().mockResolvedValue([]),
  } as unknown as Queue<ActivityImportJobData>;
  const activityProcessingQueue = {
    add: jest.fn().mockResolvedValue(undefined),
  } as unknown as Queue;
  const configService = {
    get: jest.fn((key: keyof ApiEnvSchemaType) => {
      if (key === 'ENABLE_ACTIVITY_IMPORT') return flags.import;
      if (key === 'ENABLE_ACTIVITY_PROCESSING') return flags.processing;
      return undefined;
    }),
  } as unknown as ConfigService<ApiEnvSchemaType, true>;

  return {
    service: new QueueService(
      activityImportQueue,
      activityProcessingQueue,
      configService,
    ),
    activityImportQueue,
    activityProcessingQueue,
  };
}

describe('QueueService activity pipeline contract', () => {
  it.each([
    [{ import: false, processing: true }, 'activity import'],
    [{ import: true, processing: false }, 'activity processing'],
  ])(
    'rejects before enqueueing when a required consumer is disabled',
    async (flags, disabledConsumer) => {
      const { service, activityImportQueue } = setup(flags);

      await expect(
        service.addActivityImportJobs(ACCOUNT, [ACTIVITY], true),
      ).rejects.toThrow(ServiceUnavailableException);
      await expect(
        service.addActivityImportJobs(ACCOUNT, [ACTIVITY], true),
      ).rejects.toThrow(disabledConsumer);
      expect(activityImportQueue.getJob).not.toHaveBeenCalled();
      expect(activityImportQueue.addBulk).not.toHaveBeenCalled();
    },
  );

  it('fails the enqueue contract when BullMQ rejects the bulk write', async () => {
    const { service, activityImportQueue } = setup();
    jest
      .mocked(activityImportQueue.addBulk)
      .mockRejectedValueOnce(new Error('redis write failed'));

    await expect(
      service.addActivityImportJobs(ACCOUNT, [ACTIVITY], true),
    ).rejects.toThrow('redis write failed');
  });

  it('returns the actual accepted count and tags jobs with the full-import run', async () => {
    const { service, activityImportQueue } = setup();

    const accepted = await service.addActivityImportJobs(
      ACCOUNT,
      [ACTIVITY],
      true,
    );

    expect(accepted).toBe(1);
    expect(activityImportQueue.addBulk).toHaveBeenCalledWith([
      expect.objectContaining({
        data: expect.objectContaining({
          providerAccountId: ACCOUNT.providerAccountId,
          fullImportRunId: ACCOUNT.fullImportRequestedAt?.getTime().toString(),
        }),
      }),
    ]);
  });

  it('does not accept processing work when its consumer is disabled', async () => {
    const { service, activityProcessingQueue } = setup({
      import: true,
      processing: false,
    });

    await expect(service.addActivityProcessingJob(7, 8, true)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(activityProcessingQueue.add).not.toHaveBeenCalled();
  });
});
