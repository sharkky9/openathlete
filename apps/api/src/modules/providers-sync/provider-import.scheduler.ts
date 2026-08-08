import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ConnectorProvider, ProviderAccount } from '@openathlete/database';

import { PrismaService } from '../prisma/services/prisma.service';
import { IntervalsIcuProviderService } from './providers/intervals-icu.provider.service';

@Injectable()
export class ProviderImportScheduler {
  private readonly logger = new Logger(ProviderImportScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly intervalsIcuProviderService: IntervalsIcuProviderService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, {
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  async syncIntervalsIcuActivities(): Promise<void> {
    const accounts = await this.prisma.providerAccount.findMany({
      where: {
        provider: ConnectorProvider.INTERVALS_ICU,
        status: 'active',
        importActivitiesEnabled: true,
      },
    });

    for (const account of accounts) {
      if (this.fullImportInProgress(account)) {
        this.logger.debug(
          `Skipping incremental sync while full import is in progress for account ${account.providerAccountId}`,
        );
        continue;
      }

      try {
        const { queuedActivities } =
          await this.intervalsIcuProviderService.queueIncrementalImport(
            account,
          );
        this.logger.log(
          `Intervals.icu incremental sync queued ${queuedActivities} activities for account ${account.providerAccountId}`,
        );
      } catch (error) {
        this.logger.error(
          `Intervals.icu incremental sync failed for account ${account.providerAccountId}: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  private fullImportInProgress(account: ProviderAccount): boolean {
    return Boolean(
      account.fullImportRequestedAt && !account.fullImportCompletedAt,
    );
  }
}
