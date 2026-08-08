import { ZodValidationPipe } from 'nestjs-zod';

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ConnectorProvider } from '@openathlete/database';
import {
  ProviderCredentialsDto,
  ProviderPreferencesDto,
  getProviderSyncCapabilities,
  providerCredentialsSchema,
  providerPreferencesSchema,
} from '@openathlete/shared';

import { JwtUser, UserTypeGuard } from 'src/modules/auth';
import { AuthUser } from 'src/modules/auth/decorators/user.decorator';
import { PrismaService } from 'src/modules/prisma/services/prisma.service';
import { FullImportCompletionService } from 'src/modules/queue/services/full-import-completion.service';

import { IntervalsIcuAuthError } from '../providers/intervals-icu.client';
import { IntervalsIcuProviderService } from '../providers/intervals-icu.provider.service';

@ApiTags('Provider')
@Controller('provider')
export class ProviderOAuthController {
  constructor(
    private readonly intervalsIcuProviderService: IntervalsIcuProviderService,
    private readonly prisma: PrismaService,
    private readonly fullImportCompletionService: FullImportCompletionService,
  ) {}

  private assertSupportedProvider(provider: string): ConnectorProvider {
    const providerEnum = provider.toUpperCase() as ConnectorProvider;
    if (providerEnum !== ConnectorProvider.INTERVALS_ICU) {
      throw new BadRequestException(
        `Provider ${provider} is not supported by this deployment`,
      );
    }
    return providerEnum;
  }

  private async getAthleteForUser(user: AuthUser) {
    const athlete = await this.prisma.athlete.findUnique({
      where: { userId: user.userId },
    });

    if (!athlete) {
      throw new Error('Athlete not found');
    }

    return athlete;
  }

  private async getProviderAccountForUser(user: AuthUser) {
    const athlete = await this.getAthleteForUser(user);
    const account = await this.prisma.providerAccount.findFirst({
      where: {
        athleteId: athlete.athleteId,
        provider: ConnectorProvider.INTERVALS_ICU,
        status: 'active',
      },
    });

    if (!account) {
      throw new Error('Provider account not found');
    }

    return { athlete, account };
  }

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Post(':provider/credentials')
  async connectProviderWithCredentials(
    @JwtUser() user: AuthUser,
    @Param('provider') provider: string,
    @Body(new ZodValidationPipe(providerCredentialsSchema))
    body: ProviderCredentialsDto,
  ) {
    this.assertSupportedProvider(provider);

    let account;
    try {
      account = await this.intervalsIcuProviderService.connect(
        user,
        body.apiKey,
        body.athleteId,
      );
    } catch (error) {
      if (error instanceof IntervalsIcuAuthError) {
        throw new BadRequestException(
          'Intervals.icu rejected these credentials. Check the API key (and athlete ID, if you supplied one) and try again.',
        );
      }
      throw error;
    }

    return {
      providerAccountId: account.providerAccountId,
      provider: account.provider,
      status: account.status,
      athleteId: account.athleteId,
    };
  }

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Post(':provider/disconnect')
  async disconnectProvider(
    @JwtUser() user: AuthUser,
    @Param('provider') provider: string,
  ) {
    this.assertSupportedProvider(provider);
    const { account } = await this.getProviderAccountForUser(user);

    await this.prisma.providerAccount.update({
      where: { providerAccountId: account.providerAccountId },
      data: {
        status: 'revoked',
        fullImportRequestedAt: null,
        fullImportCompletedAt: null,
      },
    });

    return { success: true, message: 'Disconnected from Intervals.icu' };
  }

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Get('connected')
  async getConnectedProviders(@JwtUser() user: AuthUser) {
    const athlete = await this.prisma.athlete.findUnique({
      where: { userId: user.userId },
      include: {
        providerAccounts: {
          where: {
            provider: ConnectorProvider.INTERVALS_ICU,
            status: 'active',
          },
        },
      },
    });

    if (!athlete) return [];

    return athlete.providerAccounts.map((account) => ({
      provider: account.provider,
      status: account.status,
      connectedAt: account.createdAt,
      importActivitiesEnabled: account.importActivitiesEnabled,
      exportWorkoutsEnabled: account.exportWorkoutsEnabled,
      importMetricsEnabled: account.importMetricsEnabled,
      fullImportRequestedAt: account.fullImportRequestedAt,
      fullImportCompletedAt: account.fullImportCompletedAt,
    }));
  }

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Patch(':provider/preferences')
  async updateProviderPreferences(
    @JwtUser() user: AuthUser,
    @Param('provider') provider: string,
    @Body(new ZodValidationPipe(providerPreferencesSchema))
    body: ProviderPreferencesDto,
  ) {
    const providerEnum = this.assertSupportedProvider(provider);
    const { account } = await this.getProviderAccountForUser(user);
    const capabilities = getProviderSyncCapabilities(providerEnum);
    const data: Record<string, unknown> = {};

    if (body.importActivitiesEnabled !== undefined) {
      data.importActivitiesEnabled = body.importActivitiesEnabled;
    }
    if (body.exportWorkoutsEnabled !== undefined) {
      if (!capabilities.exportWorkouts) {
        throw new BadRequestException(
          'Exporting workouts is not available for Intervals.icu',
        );
      }
      data.exportWorkoutsEnabled = body.exportWorkoutsEnabled;
    }
    if (body.importMetricsEnabled !== undefined) {
      if (!capabilities.importMetrics) {
        throw new BadRequestException(
          'Importing metrics is not available for Intervals.icu',
        );
      }
      data.importMetricsEnabled = body.importMetricsEnabled;
    }

    await this.prisma.providerAccount.update({
      where: { providerAccountId: account.providerAccountId },
      data,
    });

    return { success: true };
  }

  @UseGuards(AuthGuard('jwt'), UserTypeGuard)
  @ApiBearerAuth()
  @Post(':provider/import-all')
  async importAllActivities(
    @JwtUser() user: AuthUser,
    @Param('provider') provider: string,
  ) {
    this.assertSupportedProvider(provider);
    const { account: fetchedAccount } =
      await this.getProviderAccountForUser(user);
    let account = fetchedAccount;

    if (!account.importActivitiesEnabled) {
      throw new BadRequestException(
        'Importing activities is disabled for Intervals.icu',
      );
    }

    if (account.fullImportCompletedAt) {
      return {
        status: 'completed',
        completed: true,
        message: 'Full import already completed',
      };
    }

    if (account.fullImportRequestedAt && !account.fullImportCompletedAt) {
      const released = await this.fullImportCompletionService.releaseIfStale(
        account.providerAccountId,
        account.fullImportRequestedAt,
      );
      if (!released) {
        throw new BadRequestException(
          'A historical import is already in progress',
        );
      }
      account = {
        ...account,
        fullImportRequestedAt: null,
        fullImportCompletedAt: null,
      };
    }

    this.fullImportCompletionService.assertPipelineAvailable();

    const now = new Date();
    await this.prisma.providerAccount.update({
      where: { providerAccountId: account.providerAccountId },
      data: {
        fullImportRequestedAt: now,
        fullImportCompletedAt: null,
      },
    });

    const runAccount = {
      ...account,
      fullImportRequestedAt: now,
      fullImportCompletedAt: null,
    };
    const runId = this.fullImportCompletionService.runId(now);

    try {
      const importResult =
        await this.intervalsIcuProviderService.queueFullImport(runAccount);
      const queuedActivities = importResult.queuedActivities ?? 0;
      const recoveredProcessingJobs =
        await this.fullImportCompletionService.recoverProcessingJobs(
          account.providerAccountId,
          runId,
        );
      const completionStatus = importResult.backfillRequested
        ? 'pending'
        : await this.fullImportCompletionService.reconcile(
            account.providerAccountId,
            runId,
          );

      if (completionStatus === 'failed') {
        throw new BadRequestException(
          'Historical import failed before activity processing completed',
        );
      }

      const completed = completionStatus === 'completed';
      return {
        status: completed ? 'completed' : 'accepted',
        completed,
        queuedActivities,
        recoveredProcessingJobs,
        backfillRequested: importResult.backfillRequested ?? false,
      };
    } catch (error) {
      await this.prisma.providerAccount.updateMany({
        where: {
          providerAccountId: account.providerAccountId,
          fullImportRequestedAt: now,
        },
        data: {
          fullImportRequestedAt: null,
          fullImportCompletedAt: null,
        },
      });
      throw error;
    }
  }
}
