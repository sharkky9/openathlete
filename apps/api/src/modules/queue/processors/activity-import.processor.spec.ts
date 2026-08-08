import { Job } from 'bullmq';

import { ConnectorProvider, ProviderAccount } from '@openathlete/database';

import { PrismaService } from '../../prisma/services/prisma.service';
import {
  GarminProviderService,
  IntervalsIcuProviderService,
  PolarProviderService,
  StravaProviderService,
  SuuntoProviderService,
} from '../../providers-sync/providers';
import { ActivityImportJobData, QueueService } from '../queue.service';
import { ActivityImportProcessor } from './activity-import.processor';

jest.mock('@garmin/fitsdk', () => ({
  Decoder: class Decoder {},
  Stream: class Stream {},
}));

const REQUESTED_AT = new Date('2026-08-07T20:00:00.000Z');
const ACCOUNT = {
  providerAccountId: 19,
  provider: ConnectorProvider.INTERVALS_ICU,
  status: 'active',
  importActivitiesEnabled: true,
  fullImportRequestedAt: REQUESTED_AT,
} as ProviderAccount;

function setup(account: ProviderAccount = ACCOUNT) {
  const prisma = {
    providerAccount: {
      findUnique: jest.fn().mockResolvedValue(account),
    },
    eventActivity: {
      findUnique: jest.fn().mockResolvedValue({
        stream: null,
        event: { athleteId: 3 },
        provider: ConnectorProvider.INTERVALS_ICU,
      }),
    },
    record: { createMany: jest.fn() },
  } as unknown as PrismaService;
  const intervalsIcuProviderService = {
    importActivity: jest.fn().mockResolvedValue({
      eventActivityId: 7,
      eventId: 8,
    }),
  } as unknown as IntervalsIcuProviderService;
  const queueService = {
    addActivityProcessingJob: jest.fn().mockResolvedValue(undefined),
  } as unknown as QueueService;
  const processor = new ActivityImportProcessor(
    prisma,
    {} as StravaProviderService,
    {} as GarminProviderService,
    {} as PolarProviderService,
    {} as SuuntoProviderService,
    intervalsIcuProviderService,
    queueService,
  );
  const data: ActivityImportJobData = {
    providerAccountId: account.providerAccountId,
    activity: {
      externalId: 'a1',
      name: 'Ride',
      startDate: REQUESTED_AT,
      endDate: REQUESTED_AT,
      sport: 'CYCLING',
    },
    bulkImport: true,
  };
  const job = {
    id: 'import-a1',
    data,
    updateProgress: jest.fn().mockResolvedValue(undefined),
    updateData: jest.fn(async (next: ActivityImportJobData) => {
      job.data = next;
    }),
  } as unknown as Job<ActivityImportJobData>;

  return { processor, queueService, intervalsIcuProviderService, job };
}

describe('ActivityImportProcessor full import contract', () => {
  it('propagates the current run into downstream activity processing', async () => {
    const { processor, queueService, job } = setup();

    await processor.process(job);

    const runId = REQUESTED_AT.getTime().toString();
    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({ fullImportRunId: runId }),
    );
    expect(queueService.addActivityProcessingJob).toHaveBeenCalledWith(
      7,
      8,
      true,
      { providerAccountId: ACCOUNT.providerAccountId, runId },
    );
  });

  it('fails rather than silently settling when account-level import is disabled', async () => {
    const { processor, queueService, intervalsIcuProviderService, job } = setup(
      {
        ...ACCOUNT,
        importActivitiesEnabled: false,
      } as ProviderAccount,
    );

    await expect(processor.process(job)).rejects.toThrow(
      'Importing activities is disabled',
    );
    expect(intervalsIcuProviderService.importActivity).not.toHaveBeenCalled();
    expect(queueService.addActivityProcessingJob).not.toHaveBeenCalled();
  });
});
