import { Logger } from '@nestjs/common';

import { HealthService, READINESS_CACHE_TTL_MS } from './health.service';

// Guards the readiness contract that gates deployments: a 200 must mean both
// Postgres and Redis actually answered, failure detail must reach the logs
// (never the response body), and a burst of probes must not amplify into a
// burst of dependency round-trips.

type MockPrisma = { $queryRaw: jest.Mock };
type MockRedis = { ping: jest.Mock; on: jest.Mock; quit: jest.Mock };

/**
 * The real client is created in `onModuleInit`; unit tests must not need a live
 * Redis, so the double is injected over the private field.
 */
function setRedisClient(service: HealthService, client: unknown) {
  (service as unknown as { redis: unknown }).redis = client;
}

function buildService(overrides?: {
  prisma?: Partial<MockPrisma>;
  redis?: Partial<MockRedis>;
}) {
  const prisma: MockPrisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    ...overrides?.prisma,
  };
  const redis: MockRedis = {
    ping: jest.fn().mockResolvedValue('PONG'),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    ...overrides?.redis,
  };
  const configService = {
    get: jest.fn().mockReturnValue('redis://localhost:6379/0'),
  };

  const service = new HealthService(prisma as never, configService as never);
  setRedisClient(service, redis);

  return { service, prisma, redis };
}

describe('HealthService', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('isReady', () => {
    it('reports ready when both dependencies answer', async () => {
      const { service, prisma, redis } = buildService();

      await expect(service.isReady()).resolves.toEqual({ ready: true });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(redis.ping).toHaveBeenCalledTimes(1);
    });

    it('reports not ready when Postgres fails', async () => {
      const { service, redis } = buildService({
        prisma: {
          $queryRaw: jest
            .fn()
            .mockRejectedValue(new Error('connection refused')),
        },
      });

      await expect(service.isReady()).resolves.toEqual({ ready: false });
      // Redis is still probed: the checks run concurrently, not short-circuited.
      expect(redis.ping).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        'Postgres readiness check failed: connection refused',
      );
    });

    it('reports not ready when Redis fails', async () => {
      const { service } = buildService({
        redis: {
          ping: jest.fn().mockRejectedValue(new Error('Connection is closed.')),
        },
      });

      await expect(service.isReady()).resolves.toEqual({ ready: false });
      expect(errorSpy).toHaveBeenCalledWith(
        'Redis readiness check failed: Connection is closed.',
      );
    });

    it('reports not ready when the Redis client was never initialised', async () => {
      const { service } = buildService();
      setRedisClient(service, null);

      await expect(service.isReady()).resolves.toEqual({ ready: false });
      expect(errorSpy).toHaveBeenCalledWith(
        'Redis readiness check failed: Redis health client is not initialised',
      );
    });
  });

  describe('caching', () => {
    it('serves a cached result without re-probing inside the TTL', async () => {
      const { service, prisma, redis } = buildService();

      await service.isReady();
      await service.isReady();
      await service.isReady();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(redis.ping).toHaveBeenCalledTimes(1);
    });

    it('re-probes once the TTL has elapsed', async () => {
      const { service, prisma, redis } = buildService();
      const start = Date.now();
      const nowSpy = jest.spyOn(Date, 'now');

      nowSpy.mockReturnValue(start);
      await service.isReady();

      nowSpy.mockReturnValue(start + READINESS_CACHE_TTL_MS + 1);
      await service.isReady();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(redis.ping).toHaveBeenCalledTimes(2);
    });

    it('shares one in-flight check between concurrent callers', async () => {
      let releasePing: (value: string) => void = () => {};
      const pending = new Promise<string>((resolve) => {
        releasePing = resolve;
      });
      const { service, prisma, redis } = buildService({
        redis: { ping: jest.fn().mockReturnValue(pending) },
      });

      const calls = Promise.all(
        Array.from({ length: 10 }, () => service.isReady()),
      );
      releasePing('PONG');
      const results = await calls;

      expect(results).toEqual(
        Array.from({ length: 10 }, () => ({ ready: true })),
      );
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(redis.ping).toHaveBeenCalledTimes(1);
    });
  });

  describe('failure logging', () => {
    it('logs non-empty detail for an error with a blank message', async () => {
      // ioredis reports a refused connection as an AggregateError whose
      // `.message` is the empty string; a naive `error.message` logger would
      // emit "Redis readiness check failed: " with nothing after it.
      const aggregate = new Error('');
      aggregate.name = 'AggregateError';
      (aggregate as Error & { errors: Error[] }).errors = [
        new Error('connect ECONNREFUSED 127.0.0.1:6379'),
      ];

      const { service } = buildService({
        redis: { ping: jest.fn().mockRejectedValue(aggregate) },
      });

      await expect(service.isReady()).resolves.toEqual({ ready: false });

      const logged = errorSpy.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('readiness check failed'));

      expect(logged).toBeDefined();
      const detail = (logged as string).split('readiness check failed: ')[1];
      expect(detail?.trim()).not.toBe('');
      expect(detail).toContain('ECONNREFUSED');
    });

    it('collapses a multi-line Prisma error onto the log line', async () => {
      // Prisma's connection errors begin with a newline, so a raw
      // `${error.message}` renders as "…check failed: " with the detail
      // stranded on the following lines.
      const { service } = buildService({
        prisma: {
          $queryRaw: jest
            .fn()
            .mockRejectedValue(
              new Error(
                "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nCan't reach database server at `localhost:5433`\n",
              ),
            ),
        },
      });

      await expect(service.isReady()).resolves.toEqual({ ready: false });

      const logged = errorSpy.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('Postgres readiness check failed'));

      expect(logged).toBe(
        "Postgres readiness check failed: Invalid `prisma.$queryRaw()` invocation: Can't reach database server at `localhost:5433`",
      );
      expect(logged).not.toContain('\n');
    });

    it('falls back to a description when the error is not an Error', async () => {
      const { service } = buildService({
        redis: { ping: jest.fn().mockRejectedValue('redis exploded') },
      });

      await expect(service.isReady()).resolves.toEqual({ ready: false });
      expect(errorSpy).toHaveBeenCalledWith(
        'Redis readiness check failed: redis exploded',
      );
    });

    it('times out a hung dependency instead of hanging the probe', async () => {
      const { service } = buildService({
        prisma: { $queryRaw: jest.fn().mockReturnValue(new Promise(() => {})) },
      });

      await expect(service.isReady()).resolves.toEqual({ ready: false });

      const logged = errorSpy.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('Postgres readiness check failed'));

      expect(logged).toContain('timed out');
    }, 10000);
  });

  describe('onModuleDestroy', () => {
    it('closes the Redis client', async () => {
      const { service, redis } = buildService();

      await service.onModuleDestroy();

      expect(redis.quit).toHaveBeenCalledTimes(1);
    });
  });
});
