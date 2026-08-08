import { Queue } from 'bullmq';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';

import { ProviderAccount } from '@openathlete/database';

import { ImportedActivity } from '../providers-sync/base/provider-import.interface';

export interface ActivityImportJobData {
  providerAccountId: number;
  activity: ImportedActivity;
  bulkImport?: boolean;
}

export interface ActivityProcessingJobData {
  eventActivityId: number;
  eventId: number;
  bulkImport?: boolean;
}

/**
 * A full import run is queued in one go but lands over the following minutes,
 * one job at a time, so the number of jobs still in flight has to be tracked
 * somewhere both the API process (which queues) and the worker process (which
 * drains) can see. Redis already backs the queue, so the count lives there.
 *
 * Long enough that a genuinely slow run cannot outlive it; short enough that an
 * abandoned run does not linger. See `settleFullImportJob` for what happens if
 * the key does disappear early.
 */
const FULL_IMPORT_PENDING_TTL_SECONDS = 7 * 24 * 60 * 60;

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue('activity-import')
    private readonly activityImportQueue: Queue<ActivityImportJobData>,
    @InjectQueue('activity-processing')
    private readonly activityProcessingQueue: Queue<ActivityProcessingJobData>,
  ) {}

  private fullImportPendingKey(providerAccountId: number): string {
    return `openathlete:full-import-pending:${providerAccountId}`;
  }

  /**
   * Record that `jobCount` more bulk-import jobs are in flight for an account.
   */
  private async trackFullImportJobs(
    providerAccountId: number,
    jobCount: number,
  ): Promise<void> {
    if (jobCount <= 0) {
      return;
    }

    try {
      const client = await this.activityImportQueue.client;
      const key = this.fullImportPendingKey(providerAccountId);

      await client.incrby(key, jobCount);
      await client.expire(key, FULL_IMPORT_PENDING_TTL_SECONDS);
    } catch (error) {
      // Bookkeeping must never sink an import. Losing the count only costs the
      // accuracy of `fullImportCompletedAt`, which is what `settleFullImportJob`
      // degrades to anyway.
      this.logger.error(
        `Failed to track full import jobs for provider account ${providerAccountId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * How many bulk-import jobs are still in flight for an account.
   */
  async pendingFullImportJobs(providerAccountId: number): Promise<number> {
    try {
      const client = await this.activityImportQueue.client;
      const pending = await client.get(
        this.fullImportPendingKey(providerAccountId),
      );

      return Math.max(0, Number(pending ?? 0) || 0);
    } catch (error) {
      this.logger.error(
        `Failed to read pending full import jobs for provider account ${providerAccountId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  /**
   * Mark one bulk-import job as settled — imported, or failed for the last time.
   *
   * Returns true when that was the last one, i.e. the run is genuinely over.
   *
   * Every uncertain case answers true. If the counter is missing, or Redis is
   * unreachable, we do not know how much is left, and the harm of the two
   * answers is not symmetric: a premature true marks the import complete a
   * little early (exactly what the old code did unconditionally), while a stuck
   * false would leave the account reading "import in progress" forever and
   * refusing to start another one.
   */
  async settleFullImportJob(providerAccountId: number): Promise<boolean> {
    try {
      const client = await this.activityImportQueue.client;
      const key = this.fullImportPendingKey(providerAccountId);
      const remaining = await client.decr(key);

      if (remaining <= 0) {
        await client.del(key);
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error(
        `Failed to settle full import job for provider account ${providerAccountId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }
  }

  private calculatePriority(startDate: string | Date): number {
    const activityDate = new Date(startDate);
    const now = new Date();
    const daysDiff = Math.max(
      0,
      Math.floor(
        (now.getTime() - activityDate.getTime()) / (1000 * 60 * 60 * 24),
      ),
    );
    return Math.min(2097152, Math.min(daysDiff, 200) * 10000);
  }

  async addActivityImportJob(
    account: ProviderAccount,
    activity: ImportedActivity,
    bulkImport = false,
  ): Promise<void> {
    try {
      const priority = this.calculatePriority(activity.startDate);
      const jobId = `import-${account.provider}-${activity.externalId}`;

      let existingJob;
      try {
        existingJob = await this.activityImportQueue.getJob(jobId);
      } catch (error) {
        this.logger.error(
          `Failed to check for existing job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }

      if (existingJob) {
        try {
          const state = await existingJob.getState();
          if (state === 'completed' || state === 'failed') {
            await existingJob.remove();
          } else {
            return;
          }
        } catch (error) {
          this.logger.error(
            `Failed to check/remove existing job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
      }

      if (bulkImport) {
        await this.trackFullImportJobs(account.providerAccountId, 1);
      }

      await this.activityImportQueue.add(
        'import',
        {
          providerAccountId: account.providerAccountId,
          activity,
          bulkImport,
        },
        {
          priority,
          jobId,
        },
      );
    } catch (error) {
      this.logger.error(
        `Failed to add activity import job for ${activity.externalId}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async addActivityImportJobs(
    account: ProviderAccount,
    activities: ImportedActivity[],
    bulkImport = false,
  ): Promise<void> {
    try {
      const sortedActivities = [...activities].sort(
        (a, b) =>
          new Date(b.startDate).getTime() - new Date(a.startDate).getTime(),
      );

      const jobsToAdd: Array<{
        name: string;
        data: ActivityImportJobData;
        opts: { priority: number; jobId: string };
      }> = [];

      for (const activity of sortedActivities) {
        const jobId = `import-${account.provider}-${activity.externalId}`;
        let existingJob;
        try {
          existingJob = await this.activityImportQueue.getJob(jobId);
        } catch (error) {
          this.logger.error(
            `Failed to check for existing job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (existingJob) {
          try {
            const state = await existingJob.getState();
            if (state === 'completed' || state === 'failed') {
              await existingJob.remove();
            } else {
              continue;
            }
          } catch (error) {
            this.logger.error(
              `Failed to check/remove existing job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        const priority = this.calculatePriority(activity.startDate);
        jobsToAdd.push({
          name: 'import',
          data: {
            providerAccountId: account.providerAccountId,
            activity,
            bulkImport,
          },
          opts: {
            priority,
            jobId,
          },
        });
      }

      if (jobsToAdd.length === 0) {
        return;
      }

      // Counted before the jobs exist: a worker settling one before the count
      // lands would decrement past zero and end the run early.
      if (bulkImport) {
        await this.trackFullImportJobs(
          account.providerAccountId,
          jobsToAdd.length,
        );
      }

      await this.activityImportQueue.addBulk(jobsToAdd);

      this.logger.log(
        `Added ${jobsToAdd.length} activity import jobs for provider ${account.provider}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to add activity import jobs for provider ${account.provider}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async addActivityProcessingJob(
    eventActivityId: number,
    eventId: number,
    bulkImport = false,
  ): Promise<void> {
    try {
      await this.activityProcessingQueue.add('process', {
        eventActivityId,
        eventId,
        bulkImport,
      });
    } catch (error) {
      this.logger.error(
        `Failed to add activity processing job for eventActivityId ${eventActivityId}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async getQueueStats() {
    const [importStats, processingStats] = await Promise.all([
      this.activityImportQueue.getJobCounts(),
      this.activityProcessingQueue.getJobCounts(),
    ]);

    return {
      'activity-import': importStats,
      'activity-processing': processingStats,
    };
  }
}
