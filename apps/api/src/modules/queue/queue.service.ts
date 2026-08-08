import { Queue } from 'bullmq';

import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProviderAccount } from '@openathlete/database';
import { ApiEnvSchemaType } from '@openathlete/shared';

import { ImportedActivity } from '../providers-sync/base/provider-import.interface';

export interface ActivityImportJobData {
  providerAccountId: number;
  activity: ImportedActivity;
  bulkImport?: boolean;
  fullImportRunId?: string;
}

export interface ActivityProcessingJobData {
  eventActivityId: number;
  eventId: number;
  bulkImport?: boolean;
  providerAccountId?: number;
  fullImportRunId?: string;
}

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue('activity-import')
    private readonly activityImportQueue: Queue<ActivityImportJobData>,
    @InjectQueue('activity-processing')
    private readonly activityProcessingQueue: Queue<ActivityProcessingJobData>,
    private readonly configService: ConfigService<ApiEnvSchemaType, true>,
  ) {}

  assertActivityPipelineAvailable(): void {
    const disabledConsumers: string[] = [];
    if (this.configService.get('ENABLE_ACTIVITY_IMPORT') !== true) {
      disabledConsumers.push('activity import');
    }
    if (this.configService.get('ENABLE_ACTIVITY_PROCESSING') !== true) {
      disabledConsumers.push('activity processing');
    }

    if (disabledConsumers.length > 0) {
      throw new ServiceUnavailableException(
        `Activity import is unavailable because ${disabledConsumers.join(
          ' and ',
        )} ${disabledConsumers.length === 1 ? 'is' : 'are'} disabled`,
      );
    }
  }

  private fullImportRunId(account: ProviderAccount): string | undefined {
    return account.fullImportRequestedAt?.getTime().toString();
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
  ): Promise<boolean> {
    try {
      this.assertActivityPipelineAvailable();

      const priority = this.calculatePriority(activity.startDate);
      const jobId = `import-${account.provider}-${activity.externalId}`;
      const fullImportRunId = this.fullImportRunId(account);

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
            if (fullImportRunId) {
              await existingJob.updateData({
                ...existingJob.data,
                fullImportRunId,
              });
            }
            return false;
          }
        } catch (error) {
          this.logger.error(
            `Failed to check/remove existing job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
      }

      await this.activityImportQueue.add(
        'import',
        {
          providerAccountId: account.providerAccountId,
          activity,
          bulkImport,
          fullImportRunId,
        },
        {
          priority,
          jobId,
        },
      );
      return true;
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
  ): Promise<number> {
    try {
      this.assertActivityPipelineAvailable();

      const fullImportRunId = this.fullImportRunId(account);
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
          throw error;
        }

        if (existingJob) {
          try {
            const state = await existingJob.getState();
            if (state === 'completed' || state === 'failed') {
              await existingJob.remove();
            } else {
              if (fullImportRunId) {
                await existingJob.updateData({
                  ...existingJob.data,
                  fullImportRunId,
                });
              }
              continue;
            }
          } catch (error) {
            this.logger.error(
              `Failed to check/remove existing job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
        }

        const priority = this.calculatePriority(activity.startDate);
        jobsToAdd.push({
          name: 'import',
          data: {
            providerAccountId: account.providerAccountId,
            activity,
            bulkImport,
            fullImportRunId,
          },
          opts: {
            priority,
            jobId,
          },
        });
      }

      if (jobsToAdd.length === 0) {
        return 0;
      }

      await this.activityImportQueue.addBulk(jobsToAdd);

      this.logger.log(
        `Added ${jobsToAdd.length} activity import jobs for provider ${account.provider}`,
      );
      return jobsToAdd.length;
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
    fullImport?: { providerAccountId: number; runId: string },
  ): Promise<void> {
    try {
      if (this.configService.get('ENABLE_ACTIVITY_PROCESSING') !== true) {
        throw new ServiceUnavailableException(
          'Activity processing is unavailable because activity processing is disabled',
        );
      }

      await this.activityProcessingQueue.add('process', {
        eventActivityId,
        eventId,
        bulkImport,
        providerAccountId: fullImport?.providerAccountId,
        fullImportRunId: fullImport?.runId,
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
