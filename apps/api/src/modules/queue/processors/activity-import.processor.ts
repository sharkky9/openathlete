import { Job } from 'bullmq';

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, forwardRef } from '@nestjs/common';

import { ConnectorProvider, EventActivity } from '@openathlete/database';
import { CompressedActivityStream } from '@openathlete/shared';

import { uncompressActivityStream } from '../../core/helpers/activity-stream';
import { computeRecords } from '../../core/helpers/record';
import { PrismaService } from '../../prisma/services/prisma.service';
import { IntervalsIcuProviderService } from '../../providers-sync/providers/intervals-icu.provider.service';
import { ActivityImportJobData, QueueService } from '../queue.service';

@Processor('activity-import', {
  concurrency: 3,
})
export class ActivityImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ActivityImportProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => IntervalsIcuProviderService))
    private readonly intervalsIcuProviderService: IntervalsIcuProviderService,
    private readonly queueService: QueueService,
  ) {
    super();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ActivityImportJobData>, error: Error) {
    this.logger.error(
      `Job ${job.id} (${job.data?.activity?.externalId || 'unknown'}) failed: ${error.message}`,
      error.stack,
    );
  }

  async process(job: Job<ActivityImportJobData>) {
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

      if (account.provider !== ConnectorProvider.INTERVALS_ICU) {
        throw new Error(
          `Provider ${account.provider} is not supported by this deployment`,
        );
      }

      if (account.status !== 'active') {
        throw new Error(
          `Provider account ${providerAccountId} is not active (status: ${account.status})`,
        );
      }

      if (!account.importActivitiesEnabled) {
        throw new Error(
          `Importing activities is disabled for provider account ${providerAccountId}`,
        );
      }

      const accountRunId =
        bulkImport && !account.fullImportCompletedAt
          ? account.fullImportRequestedAt?.getTime().toString()
          : undefined;
      const fullImportRunId = bulkImport
        ? (accountRunId ?? job.data.fullImportRunId)
        : undefined;
      if (fullImportRunId !== job.data.fullImportRunId) {
        await job.updateData({ ...job.data, fullImportRunId });
      }

      await job.updateProgress(30);

      const savedActivity: EventActivity =
        await this.intervalsIcuProviderService.importActivity(
          account,
          activity,
        );

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

      await this.queueService.addActivityProcessingJob(
        savedActivity.eventActivityId,
        savedActivity.eventId,
        bulkImport,
        fullImportRunId
          ? { providerAccountId, runId: fullImportRunId }
          : undefined,
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
