import { Redis } from 'ioredis';

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiEnvSchemaType } from '@openathlete/shared';

import { PrismaService } from '../prisma/services/prisma.service';

/**
 * How long a readiness result is reused before the dependencies are probed
 * again. Readiness is polled by the platform health check (and potentially by
 * uptime monitors), so a short cache keeps a hot loop from opening a Postgres
 * round-trip and a Redis PING on every request.
 */
export const READINESS_CACHE_TTL_MS = 5000;

/** Upper bound on a single dependency probe, so a hung socket cannot hang the probe. */
const PROBE_TIMEOUT_MS = 2000;

export type ReadinessResult = { ready: boolean };

/**
 * Squashes an error message onto a single line. Prisma's connection errors
 * start with a newline ("\nInvalid `prisma.$queryRaw()` invocation:\n\n\nCan't
 * reach database server..."), which makes the log record *look* empty even
 * though the detail is on the following lines.
 */
function toSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Produces a non-empty, single-line description of a probe failure. The
 * readiness response body carries no detail at all, so this is the only place
 * an operator can learn *which* dependency broke — it must never be blank.
 * ioredis in particular surfaces a refused connection as an `AggregateError`
 * whose `.message` is the empty string, so fall through until we have
 * something to say.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const message = toSingleLine(error.message ?? '');
    if (message.length > 0) {
      return message;
    }

    const aggregated = (error as { errors?: unknown }).errors;
    if (Array.isArray(aggregated) && aggregated.length > 0) {
      const detail = aggregated
        .map((inner) => describeError(inner))
        .filter((inner) => inner.length > 0)
        .join('; ');
      if (detail.length > 0) {
        return `${error.name}: ${detail}`;
      }
    }

    const stringified = toSingleLine(String(error));
    if (stringified.length > 0 && stringified !== 'Error') {
      return stringified;
    }

    return error.name || 'unknown error';
  }

  const stringified = toSingleLine(String(error));
  return stringified.length > 0 ? stringified : 'unknown error';
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  return Promise.race([operation, timeout]).finally(() => {
    clearTimeout(timer);
  }) as Promise<T>;
}

@Injectable()
export class HealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private redis: Redis | null = null;
  private cached: { result: ReadinessResult; expiresAt: number } | null = null;
  private inFlight: Promise<ReadinessResult> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<ApiEnvSchemaType, true>,
  ) {}

  onModuleInit() {
    // `REDIS_URL` is validated (and defaulted) by `ApiEnvSchema`; ioredis
    // parses `redis://` / `rediss://` URLs natively, so no hand-rolled parsing.
    const redisUrl = this.configService.get('REDIS_URL');

    // A dedicated client: the BullMQ connection is shared with the queue
    // workers and its options (unbounded command timeouts, give-up retry
    // strategy) are tuned for job processing, not for a fast liveness probe.
    this.redis = new Redis(redisUrl, {
      // Connect eagerly and keep the offline queue: with `lazyConnect` +
      // `enableOfflineQueue: false`, the first requests after boot fail with
      // "Stream isn't writeable" while the socket is still connecting.
      lazyConnect: false,
      connectTimeout: PROBE_TIMEOUT_MS,
      // Bounds a PING against a dead Redis, so it rejects instead of sitting
      // in the offline queue forever.
      commandTimeout: PROBE_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      // Always return a delay: returning null makes ioredis give up
      // permanently, and readiness would then never recover from a Redis
      // restart ("Connection is closed." forever).
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    });

    // ioredis emits `error` on every failed reconnect attempt; without a
    // listener those become unhandled events and take the process down.
    this.redis.on('error', (error: unknown) => {
      this.logger.debug(`Redis health client error: ${describeError(error)}`);
    });
  }

  async onModuleDestroy() {
    if (!this.redis) {
      return;
    }

    const client = this.redis;
    this.redis = null;

    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }

  /**
   * Returns the readiness of the API's hard dependencies. Results are cached
   * for {@link READINESS_CACHE_TTL_MS} and concurrent callers share a single
   * in-flight check, so a burst of probes cannot amplify into a burst of
   * database round-trips.
   */
  async isReady(): Promise<ReadinessResult> {
    const now = Date.now();

    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.result;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.runChecks()
      .then((result) => {
        this.cached = {
          result,
          expiresAt: Date.now() + READINESS_CACHE_TTL_MS,
        };
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async runChecks(): Promise<ReadinessResult> {
    // Run both probes concurrently so a slow Redis does not serialise behind
    // Postgres (and vice versa).
    const [postgres, redis] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
    ]);

    return { ready: postgres && redis };
  }

  private async checkPostgres(): Promise<boolean> {
    try {
      await withTimeout(
        this.prisma.$queryRaw`SELECT 1`,
        PROBE_TIMEOUT_MS,
        'Postgres readiness probe',
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Postgres readiness check failed: ${describeError(error)}`,
      );
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      const client = this.redis;
      if (!client) {
        throw new Error('Redis health client is not initialised');
      }

      await withTimeout(
        client.ping(),
        PROBE_TIMEOUT_MS,
        'Redis readiness probe',
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Redis readiness check failed: ${describeError(error)}`,
      );
      return false;
    }
  }
}
