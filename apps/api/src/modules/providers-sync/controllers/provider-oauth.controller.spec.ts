import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { ConnectorProvider, ProviderAccount } from '@openathlete/database';

import { AuthUser } from 'src/modules/auth/decorators/user.decorator';
import { PrismaService } from 'src/modules/prisma/services/prisma.service';
import { FullImportCompletionService } from 'src/modules/queue/services/full-import-completion.service';

import { IntervalsIcuProviderService } from '../providers/intervals-icu.provider.service';
import { ProviderOAuthController } from './provider-oauth.controller';

jest.mock('src/modules/auth', () => ({
  JwtUser: () => () => undefined,
  UserTypeGuard: class UserTypeGuard {},
}));
const USER = { userId: 9 } as AuthUser;
const ACCOUNT = {
  providerAccountId: 23,
  athleteId: 4,
  provider: ConnectorProvider.INTERVALS_ICU,
  status: 'active',
  importActivitiesEnabled: true,
  fullImportRequestedAt: null,
  fullImportCompletedAt: null,
} as ProviderAccount;

interface ControllerInternals {
  getProviderAccountForUser: () => Promise<{
    athlete: { athleteId: number };
    account: ProviderAccount;
  }>;
}

function setup() {
  const intervalsIcuProviderService = {
    queueFullImport: jest.fn().mockResolvedValue({ queuedActivities: 3 }),
  } as unknown as IntervalsIcuProviderService;
  const prisma = {
    providerAccount: {
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  } as unknown as PrismaService;
  const fullImportCompletionService = {
    assertPipelineAvailable: jest.fn(),
    releaseIfStale: jest.fn().mockResolvedValue(false),
    runId: jest.fn((date: Date) => date.getTime().toString()),
    recoverProcessingJobs: jest.fn().mockResolvedValue(0),
    reconcile: jest.fn().mockResolvedValue('pending'),
  } as unknown as FullImportCompletionService;
  const controller = new ProviderOAuthController(
    intervalsIcuProviderService,
    prisma,
    fullImportCompletionService,
  );
  jest
    .spyOn(
      controller as unknown as ControllerInternals,
      'getProviderAccountForUser',
    )
    .mockResolvedValue({ athlete: { athleteId: 4 }, account: ACCOUNT });

  return {
    controller,
    intervalsIcuProviderService,
    prisma,
    fullImportCompletionService,
  };
}

describe('ProviderOAuthController full import', () => {
  it('registers no retired provider webhook routes', () => {
    const routes = Object.getOwnPropertyNames(
      ProviderOAuthController.prototype,
    ).flatMap((methodName) => {
      const handler =
        ProviderOAuthController.prototype[
          methodName as keyof ProviderOAuthController
        ];
      const path = Reflect.getMetadata(PATH_METADATA, handler);
      return typeof path === 'string' ? [path] : [];
    });

    expect(routes).not.toEqual(
      expect.arrayContaining([
        'strava/webhook',
        'garmin/webhook/activity-ping',
        'garmin/webhook/health-ping',
        'garmin/webhook/activity-files',
        'garmin/webhook/deregistration',
        'garmin/webhook/user-permissions-change',
        'polar/webhook',
        'suunto/webhook',
      ]),
    );
  });

  it.each(['strava', 'garmin', 'suunto', 'polar', 'coros'])(
    'rejects the retired %s provider before reading an account',
    async (provider) => {
      const { controller, intervalsIcuProviderService, prisma } = setup();

      await expect(
        controller.importAllActivities(USER, provider),
      ).rejects.toThrow(`Provider ${provider} is not supported`);
      expect(prisma.providerAccount.update).not.toHaveBeenCalled();
      expect(
        intervalsIcuProviderService.queueFullImport,
      ).not.toHaveBeenCalled();
    },
  );

  it('fails before latching or calling the provider when consumers are disabled', async () => {
    const {
      controller,
      fullImportCompletionService,
      intervalsIcuProviderService,
      prisma,
    } = setup();
    jest
      .mocked(fullImportCompletionService.assertPipelineAvailable)
      .mockImplementation(() => {
        throw new ServiceUnavailableException('activity import disabled');
      });

    await expect(
      controller.importAllActivities(USER, 'intervals_icu'),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(intervalsIcuProviderService.queueFullImport).not.toHaveBeenCalled();
    expect(prisma.providerAccount.update).not.toHaveBeenCalled();
  });

  it('reports accepted, not successful or completed, after enqueue only', async () => {
    const {
      controller,
      fullImportCompletionService,
      intervalsIcuProviderService,
      prisma,
    } = setup();

    const response = await controller.importAllActivities(
      USER,
      'intervals_icu',
    );

    expect(response).toEqual({
      status: 'accepted',
      completed: false,
      queuedActivities: 3,
      recoveredProcessingJobs: 0,
      backfillRequested: false,
    });
    expect(response).not.toHaveProperty('success');
    expect(prisma.providerAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          fullImportRequestedAt: expect.any(Date),
          fullImportCompletedAt: null,
        },
      }),
    );
    expect(intervalsIcuProviderService.queueFullImport).toHaveBeenCalledWith(
      expect.objectContaining({ fullImportRequestedAt: expect.any(Date) }),
    );
    expect(fullImportCompletionService.reconcile).toHaveBeenCalled();
  });

  it('clears the run latch and propagates a provider enqueue failure', async () => {
    const { controller, intervalsIcuProviderService, prisma } = setup();
    jest
      .mocked(intervalsIcuProviderService.queueFullImport)
      .mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(
      controller.importAllActivities(USER, 'intervals_icu'),
    ).rejects.toThrow('provider unavailable');
    expect(prisma.providerAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          fullImportRequestedAt: null,
          fullImportCompletedAt: null,
        },
      }),
    );
  });

  it('reports completion only when reconciliation proves the run settled', async () => {
    const { controller, fullImportCompletionService } = setup();
    jest
      .mocked(fullImportCompletionService.reconcile)
      .mockResolvedValueOnce('completed');

    await expect(
      controller.importAllActivities(USER, 'intervals_icu'),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'completed',
        completed: true,
      }),
    );
  });

  it('does not mask an immediately observed terminal failure', async () => {
    const { controller, fullImportCompletionService } = setup();
    jest
      .mocked(fullImportCompletionService.reconcile)
      .mockResolvedValueOnce('failed');

    await expect(
      controller.importAllActivities(USER, 'intervals_icu'),
    ).rejects.toThrow(BadRequestException);
  });
});
