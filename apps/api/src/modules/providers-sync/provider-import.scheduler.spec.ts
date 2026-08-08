import { ConnectorProvider, ProviderAccount } from '@openathlete/database';

import { PrismaService } from '../prisma/services/prisma.service';
import { ProviderImportScheduler } from './provider-import.scheduler';
import { IntervalsIcuProviderService } from './providers/intervals-icu.provider.service';

const account = (overrides: Partial<ProviderAccount> = {}): ProviderAccount =>
  ({
    providerAccountId: 1,
    athleteId: 42,
    provider: ConnectorProvider.INTERVALS_ICU,
    status: 'active',
    importActivitiesEnabled: true,
    fullImportRequestedAt: null,
    fullImportCompletedAt: null,
    ...overrides,
  }) as ProviderAccount;

describe('ProviderImportScheduler', () => {
  function setup(accounts: ProviderAccount[]) {
    const prisma = {
      providerAccount: {
        findMany: jest.fn().mockResolvedValue(accounts),
      },
    } as unknown as PrismaService;
    const intervalsIcuProviderService = {
      queueIncrementalImport: jest
        .fn()
        .mockResolvedValue({ queuedActivities: 1 }),
    } as unknown as IntervalsIcuProviderService;

    return {
      scheduler: new ProviderImportScheduler(
        prisma,
        intervalsIcuProviderService,
      ),
      prisma,
      intervalsIcuProviderService,
    };
  }

  it('polls every eligible Intervals.icu account', async () => {
    const first = account();
    const second = account({ providerAccountId: 2 });
    const { scheduler, prisma, intervalsIcuProviderService } = setup([
      first,
      second,
    ]);

    await scheduler.syncIntervalsIcuActivities();

    expect(prisma.providerAccount.findMany).toHaveBeenCalledWith({
      where: {
        provider: ConnectorProvider.INTERVALS_ICU,
        status: 'active',
        importActivitiesEnabled: true,
      },
    });
    expect(
      intervalsIcuProviderService.queueIncrementalImport,
    ).toHaveBeenNthCalledWith(1, first);
    expect(
      intervalsIcuProviderService.queueIncrementalImport,
    ).toHaveBeenNthCalledWith(2, second);
  });

  it('does not compete with a full import still in progress', async () => {
    const inProgress = account({
      fullImportRequestedAt: new Date('2026-08-08T00:00:00Z'),
      fullImportCompletedAt: null,
    });
    const { scheduler, intervalsIcuProviderService } = setup([inProgress]);

    await scheduler.syncIntervalsIcuActivities();

    expect(
      intervalsIcuProviderService.queueIncrementalImport,
    ).not.toHaveBeenCalled();
  });

  it('continues syncing other accounts after one account fails', async () => {
    const first = account();
    const second = account({ providerAccountId: 2 });
    const { scheduler, intervalsIcuProviderService } = setup([first, second]);
    jest
      .mocked(intervalsIcuProviderService.queueIncrementalImport)
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ queuedActivities: 1 });

    await scheduler.syncIntervalsIcuActivities();

    expect(
      intervalsIcuProviderService.queueIncrementalImport,
    ).toHaveBeenCalledTimes(2);
  });
});
