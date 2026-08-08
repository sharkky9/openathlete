import { Job } from 'bullmq';

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, forwardRef } from '@nestjs/common';

import { ConnectorProvider, EventActivity } from '@openathlete/database';
import { CompressedActivityStream } from '@openathlete/shared';

import { uncompressActivityStream } from '../../core/helpers/activity-stream';
import { computeRecords } from '../../core/helpers/record';
import { PrismaService } from '../../prisma/services/prisma.service';
import {
  GarminProviderService,
  IntervalsIcuProviderService,
  PolarProviderService,
  StravaProviderService,
  SuuntoProviderService,
} from '../../providers-sync/providers';
import { ActivityImportJobData, QueueService } from '../queue.service';

@Processor('activity-import', {
  concurrency: 3,
})
export class ActivityImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ActivityImportProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => StravaProviderService))
    private readonly stravaProviderService: StravaProviderService,
    @Inject(forwardRef(() => GarminProviderService))
    private readonly garminProviderService: GarminProviderService,
    @Inject(forwardRef(() => PolarProviderService))
    private readonly polarProviderService: PolarProviderService,
    @Inject(forwardRef(() => SuuntoProviderService))
    private readonly suuntoProviderService: SuuntoProviderService,
    @Inject(forwardRef(() => IntervalsIcuProviderService))
    private readonly intervalsIcuProviderService: IntervalsIcuProviderService,
    private readonly queueService: QueueService,
  ) {
    super();
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ActivityImportJobData>, error: Error) {
    this.logger.error(
      `Job ${job.id} (${job.data?.activity?.externalId || 'unknown'}) failed: ${error.message}`,
      error.stack,
    );

    // Only once BullMQ has given up: an intermediate attempt is not a settled
    // job, and counting it would end the run while retries were still pending.
    const attemptsAllowed = job.opts?.attempts ?? 1;
    if (job.attemptsMade >= attemptsAllowed) {
      await this.settleBulkImport(job);
    }
  }

  /**
   * Account for one job of a historical import run reaching a final state.
   *
   * `fullImportCompletedAt` used to be stamped by the controller the moment the
   * jobs were queued, which on a real 1,224-activity import read as "complete"
   * 29 minutes before the last activity actually landed — and read as complete
   * even for the activities that never landed at all. It is now written here,
   * when the last job of the run has genuinely settled.
   */
  private async settleBulkImport(job: Job<ActivityImportJobData>) {
    if (!job.data?.bulkImport) {
      return;
    }

    const { providerAccountId } = job.data;

    try {
      const runFinished =
        await this.queueService.settleFullImportJob(providerAccountId);

      if (!runFinished) {
        return;
      }

      // Scoped to an import that was actually asked for and has not been marked
      // finished already, so a stray bulk job cannot invent a completed
      // historical import on an account that never requested one.
      await this.prisma.providerAccount.updateMany({
        where: {
          providerAccountId,
          fullImportRequestedAt: { not: null },
          fullImportCompletedAt: null,
        },
        data: {
          fullImportCompletedAt: new Date(),
        },
      });

      this.logger.log(
        `Historical import finished for provider account ${providerAccountId}`,
      );
    } catch (error) {
      // Never let bookkeeping change the outcome of an import.
      this.logger.error(
        `Failed to record full import completion for provider account ${providerAccountId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async process(job: Job<ActivityImportJobData>) {
    const result = await this.runImport(job);

    // Reached only when the import did not throw. A failure settles from
    // `onFailed` instead, and only once BullMQ has stopped retrying.
    await this.settleBulkImport(job);

    return result;
  }

  private async runImport(job: Job<ActivityImportJobData>) {
    const { providerAccountId, activity, bulkImport } = job.data;

    try {
      await job.updateProgress(10);

      const account = await this.prisma.providerAccount.findUnique({
        where: {
          providerAccountId: providerAccountId,
        },
      });

      if (!account) {
        throw new Error(`Provider account ${providerAccountId} not found`);
      }

      if (account.status !== 'active') {
        throw new Error(
          `Provider account ${providerAccountId} is not active (status: ${account.status})`,
        );
      }

      if (!account.importActivitiesEnabled) {
        this.logger.debug(
          `Skipping import for provider account ${providerAccountId}: import disabled`,
        );
        return;
      }

      await job.updateProgress(30);

      let savedActivity: EventActivity;
      if (account.provider === ConnectorProvider.STRAVA) {
        savedActivity = await this.stravaProviderService.importActivity(
          account,
          activity,
        );
      } else if (account.provider === ConnectorProvider.GARMIN) {
        savedActivity = await this.garminProviderService.importActivity(
          account,
          activity,
        );
      } else if (account.provider === ConnectorProvider.POLAR) {
        savedActivity = await this.polarProviderService.importActivity(
          account,
          activity,
        );
      } else if (account.provider === ConnectorProvider.SUUNTO) {
        savedActivity = await this.suuntoProviderService.importActivity(
          account,
          activity,
        );
      } else if (account.provider === ConnectorProvider.INTERVALS_ICU) {
        savedActivity = await this.intervalsIcuProviderService.importActivity(
          account,
          activity,
        );
      } else {
        throw new Error(
          `Provider ${account.provider} does not support activity import yet`,
        );
      }

      await job.updateProgress(60);

      const activityWithStream = await this.prisma.eventActivity.findUnique({
        where: { eventActivityId: savedActivity.eventActivityId },
        select: {
          stream: true,
          event: { select: { athleteId: true } },
          provider: true,
        },
      });

      if (activityWithStream?.stream && activityWithStream.event) {
        const compressedStream =
          activityWithStream.stream as CompressedActivityStream;
        const stream = uncompressActivityStream(compressedStream);

        if (stream) {
          const records = computeRecords(stream);

          if (records.length > 0 && activityWithStream.event.athleteId) {
            await this.prisma.record.createMany({
              data: records.map((record) => ({
                ...record,
                eventActivityId: savedActivity.eventActivityId,
                athleteId: activityWithStream.event.athleteId!,
                date: new Date(),
              })),
              skipDuplicates: true,
            });
          }
        }
      }

      await job.updateProgress(90);

      if (
        account.provider === ConnectorProvider.GARMIN &&
        !activityWithStream?.stream
      ) {
        return {
          success: true,
          eventActivityId: savedActivity.eventActivityId,
          eventId: savedActivity.eventId,
          waitingForStream: true,
        };
      }

      await this.queueService.addActivityProcessingJob(
        savedActivity.eventActivityId,
        savedActivity.eventId,
        bulkImport,
      );

      return {
        success: true,
        eventActivityId: savedActivity.eventActivityId,
        eventId: savedActivity.eventId,
      };
    } catch (error) {
      this.logger.error(
        `Job ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }
}
