import { Queue } from 'bullmq';

import { Logger } from '@nestjs/common';

import { ProviderAccount } from '@openathlete/database';

import { ImportedActivity } from '../providers-sync/base/provider-import.interface';
import { QueueService } from './queue.service';

/**
 * The counter behind `fullImportCompletedAt`. It only has to survive being
 * wrong, so the cases worth pinning down are the unhappy ones: what a missing
 * key does, and what an unreachable Redis does.
 */
class FakeRedis {
  readonly store = new Map<string, number>();
  readonly expires = new Map<string, number>();

  async incrby(key: string, amount: number): Promise<number> {
    const next = (this.store.get(key) ?? 0) + amount;
    this.store.set(key, next);
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.expires.set(key, seconds);
    return 1;
  }

  async decr(key: string): Promise<number> {
    const next = (this.store.get(key) ?? 0) - 1;
    this.store.set(key, next);
    return next;
  }

  async get(key: string): Promise<string | null> {
    const value = this.store.get(key);
    return value === undefined ? null : String(value);
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

const ACCOUNT = {
  providerAccountId: 7,
  provider: 'INTERVALS_ICU',
} as unknown as ProviderAccount;

function makeService(client: unknown) {
  const added: { data: unknown }[][] = [];

  const importQueue = {
    client: Promise.resolve(client),
    getJob: jest.fn().mockResolvedValue(undefined),
    addBulk: jest.fn(async (jobs: { data: unknown }[]) => {
      added.push(jobs);
    }),
  } as unknown as Queue;

  const service = new QueueService(importQueue, {} as unknown as Queue);

  return { service, added };
}

const activity = (externalId: string): ImportedActivity =>
  ({
    externalId,
    startDate: new Date('2026-06-28T19:18:28Z'),
  }) as unknown as ImportedActivity;

describe('QueueService full import tracking', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('counts the jobs a bulk import queued', async () => {
    const redis = new FakeRedis();
    const { service } = makeService(redis);

    await service.addActivityImportJobs(
      ACCOUNT,
      [activity('i1'), activity('i2'), activity('i3')],
      true,
    );

    expect(await service.pendingFullImportJobs(7)).toBe(3);
  });

  it('does not count jobs queued outside a bulk import', async () => {
    const redis = new FakeRedis();
    const { service } = makeService(redis);

    await service.addActivityImportJobs(ACCOUNT, [activity('i1')], false);

    expect(await service.pendingFullImportJobs(7)).toBe(0);
  });

  it('reports the run finished only on the last job', async () => {
    const redis = new FakeRedis();
    const { service } = makeService(redis);

    await service.addActivityImportJobs(
      ACCOUNT,
      [activity('i1'), activity('i2')],
      true,
    );

    expect(await service.settleFullImportJob(7)).toBe(false);
    expect(await service.settleFullImportJob(7)).toBe(true);
  });

  /**
   * Both of these mean "we no longer know how much is left". Answering true
   * marks the import complete slightly early — which is all the old code ever
   * did — whereas answering false would strand the account on "import in
   * progress" and refuse to start another one.
   */
  it('treats a missing counter as a finished run', async () => {
    const { service } = makeService(new FakeRedis());

    expect(await service.settleFullImportJob(7)).toBe(true);
  });

  it('treats an unreachable Redis as a finished run', async () => {
    const { service } = makeService({
      decr: async () => {
        throw new Error('connection refused');
      },
    });

    expect(await service.settleFullImportJob(7)).toBe(true);
  });

  it('reports nothing pending when Redis is unreachable', async () => {
    const { service } = makeService({
      get: async () => {
        throw new Error('connection refused');
      },
    });

    expect(await service.pendingFullImportJobs(7)).toBe(0);
  });
});
