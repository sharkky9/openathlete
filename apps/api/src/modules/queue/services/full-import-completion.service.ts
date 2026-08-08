import { Job, JobType, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/services/prisma.service';
import {
  ActivityImportJobData,
  ActivityProcessingJobData,
  QueueService,
} from '../queue.service';

export interface FullImportCompletionJobData {
  providerAccountId: number;
  runId: string;
}

export type FullImportCompletionStatus =
  | 'completed'
  | 'failed'
  | 'obsolete'
  | 'pending';

const ACTIVE_JOB_TYPES: JobType[] = [
  'wait',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
  'paused',
];
const COMPLETION_POLL_DELAY_MS = 5_000;
export const FULL_IMPORT_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

@Injectable()
export class FullImportCompletionService {
  private readonly logger = new Logger(FullImportCompletionService.name);

  constructor(
    @InjectQueue('activity-import')
    private readonly activityImportQueue: Queue<ActivityImportJobData>,
    @InjectQueue('activity-processing')
    private readonly activityProcessingQueue: Queue<ActivityProcessingJobData>,
    @InjectQueue('full-import-completion')
    private readonly completionQueue: Queue<FullImportCompletionJobData>,
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {}

  assertPipelineAvailable(): void {
    this.queueService.assertActivityPipelineAvailable();
  }

  runId(requestedAt: Date): string {
    return requestedAt.getTime().toString();
  }

  async releaseIfStale(
    providerAccountId: number,
    requestedAt: Date,
    now = new Date(),
  ): Promise<boolean> {
    if (now.getTime() - requestedAt.getTime() < FULL_IMPORT_STALE_AFTER_MS) {
      return false;
    }

    const released = await this.prisma.providerAccount.updateMany({
      where: {
        providerAccountId,
        fullImportRequestedAt: requestedAt,
        fullImportCompletedAt: null,
      },
      data: {
        fullImportRequestedAt: null,
      },
    });

    if (released.count > 0) {
      this.logger.warn(
        `Released stale full import ${this.runId(requestedAt)} for provider account ${providerAccountId}`,
      );
    }

    return released.count > 0;
  }

  async recoverProcessingJobs(
    providerAccountId: number,
    runId: string,
  ): Promise<number> {
    const [unfinishedJobs, failedJobs] = await Promise.all([
      this.activityProcessingQueue.getJobs(ACTIVE_JOB_TYPES, 0, -1, false),
      this.activityProcessingQueue.getJobs(['failed'], 0, -1, false),
    ]);
    const jobsToAdopt = unfinishedJobs.filter(
      (job) =>
        job.data.providerAccountId === providerAccountId &&
        job.data.fullImportRunId !== undefined &&
        job.data.fullImportRunId !== runId,
    );
    const jobsToResume = failedJobs.filter(
      (job) =>
        job.data.providerAccountId === providerAccountId &&
        job.data.fullImportRunId !== undefined,
    );

    for (const job of jobsToAdopt) {
      await job.updateData({ ...job.data, fullImportRunId: runId });
    }
    for (const job of jobsToResume) {
      await job.updateData({ ...job.data, fullImportRunId: runId });
      await job.retry('failed');
    }

    return jobsToAdopt.length + jobsToResume.length;
  }

  async reconcile(
    providerAccountId: number,
    runId: string,
  ): Promise<FullImportCompletionStatus> {
    const requestedAt = new Date(Number(runId));
    const account = await this.prisma.providerAccount.findUnique({
      where: { providerAccountId },
      select: {
        fullImportRequestedAt: true,
        fullImportCompletedAt: true,
      },
    });

    if (
      !account ||
      account.fullImportCompletedAt ||
      account.fullImportRequestedAt?.getTime() !== requestedAt.getTime()
    ) {
      return 'obsolete';
    }

    const [
      activeImports,
      failedImports,
      completedImports,
      activeProcessing,
      failedProcessing,
    ] = await Promise.all([
      this.activityImportQueue.getJobs(ACTIVE_JOB_TYPES, 0, -1, false),
      this.activityImportQueue.getJobs(['failed'], 0, -1, false),
      this.activityImportQueue.getJobs(['completed'], 0, -1, false),
      this.activityProcessingQueue.getJobs(ACTIVE_JOB_TYPES, 0, -1, false),
      this.activityProcessingQueue.getJobs(['failed'], 0, -1, false),
    ]);

    const belongsToRun = <Data extends { fullImportRunId?: string }>(
      job: Job<Data>,
    ) => job.data.fullImportRunId === runId;

    const terminalFailures = [
      ...failedImports.filter(belongsToRun),
      ...failedProcessing.filter(belongsToRun),
    ];

    if (terminalFailures.length > 0) {
      await this.prisma.providerAccount.updateMany({
        where: {
          providerAccountId,
          fullImportRequestedAt: requestedAt,
          fullImportCompletedAt: null,
        },
        data: {
          fullImportRequestedAt: null,
        },
      });
      this.logger.error(
        `Full import ${runId} failed for provider account ${providerAccountId}; ${terminalFailures.length} terminal queue job(s) remain retryable`,
      );
      return 'failed';
    }

    const waitingForStream = completedImports.filter(
      (job) =>
        belongsToRun(job) &&
        (job.returnvalue as { waitingForStream?: boolean } | undefined)
          ?.waitingForStream === true,
    );
    const pendingJobs = [
      ...activeImports.filter(belongsToRun),
      ...activeProcessing.filter(belongsToRun),
      ...waitingForStream,
    ];

    if (pendingJobs.length > 0) {
      await this.scheduleCompletionCheck(
        providerAccountId,
        runId,
        COMPLETION_POLL_DELAY_MS,
      );
      return 'pending';
    }

    await this.prisma.providerAccount.updateMany({
      where: {
        providerAccountId,
        fullImportRequestedAt: requestedAt,
        fullImportCompletedAt: null,
      },
      data: {
        fullImportCompletedAt: new Date(),
      },
    });
    return 'completed';
  }

  private async scheduleCompletionCheck(
    providerAccountId: number,
    runId: string,
    delay: number,
  ): Promise<void> {
    await this.completionQueue.add(
      'check',
      { providerAccountId, runId },
      {
        delay,
        jobId: `full-import-completion-${providerAccountId}-${runId}-${randomUUID()}`,
      },
    );
  }
}
