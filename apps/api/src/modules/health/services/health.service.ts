import { Redis } from 'ioredis';

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiEnvSchemaType } from '@openathlete/shared';

import { PrismaService } from '../../prisma/services/prisma.service';

export type DependencyStatus = 'up' | 'down';

export interface DependencyCheck {
  status: DependencyStatus;
  error?: string;
}

/**
 * Internal view of readiness. Only `status` is exposed: the per-dependency
 * detail stays in the logs, which are shipped to Better Stack.
 */
export interface ReadinessReport {
  status: 'ok' | 'error';
  checks: {
    database: DependencyCheck;
    redis: DependencyCheck;
  };
}

export interface PublicReadiness {
  status: ReadinessReport['status'];
}

const CHECK_TIMEOUT_MS = 3000;

// The probe is unauthenticated, so results are reused for a short window: an
// anonymous caller cannot turn request volume into Postgres/Redis load, while
// monitors (60s+ intervals) still observe fresh state.
const CACHE_TTL_MS = 5000;

// The endpoint is unauthenticated and driver errors name the connection target
// (host, port, database), so the detail is logged instead of returned.
const PUBLIC_ERROR = 'unreachable';

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private redisClient: Redis | null = null;
  private redisConnecting: Promise<void> | null = null;
  private cachedReadiness: { report: ReadinessReport; at: number } | null =
    null;
  private pendingReadiness: Promise<ReadinessReport> | null = null;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService<ApiEnvSchemaType, true>,
  ) {}

  async getReadiness(): Promise<ReadinessReport> {
    const cached = this.cachedReadiness;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.report;
    }

    if (!this.pendingReadiness) {
      this.pendingReadiness = this.runChecks()
        .then((report) => {
          this.cachedReadiness = { report, at: Date.now() };
          return report;
        })
        .finally(() => {
          this.pendingReadiness = null;
        });
    }

    return this.pendingReadiness;
  }

  private async runChecks(): Promise<ReadinessReport> {
    const [database, redis] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
    ]);

    const status =
      database.status === 'up' && redis.status === 'up' ? 'ok' : 'error';

    return { status, checks: { database, redis } };
  }

  async onModuleDestroy() {
    if (this.redisClient) {
      this.redisClient.disconnect();
      this.redisClient = null;
    }
  }

  private async checkDatabase(): Promise<DependencyCheck> {
    try {
      await this.withTimeout(
        this.prismaService.$queryRaw`SELECT 1`,
        'database',
      );
      return { status: 'up' };
    } catch (error) {
      this.logger.warn(`Database readiness check failed: ${toMessage(error)}`);
      return { status: 'down', error: PUBLIC_ERROR };
    }
  }

  private async checkRedis(): Promise<DependencyCheck> {
    try {
      const client = this.getRedisClient();
      await this.ensureConnected(client);
      await this.withTimeout(client.ping(), 'redis');
      return { status: 'up' };
    } catch (error) {
      this.logger.warn(`Redis readiness check failed: ${toMessage(error)}`);
      return { status: 'down', error: PUBLIC_ERROR };
    }
  }

  /**
   * Waits until the lazily created client is usable. Every caller shares a
   * single attempt: concurrent readiness requests must neither race on
   * `connect()` (ioredis rejects a second call) nor issue a command while the
   * socket is still opening (offline queueing is disabled, so that fails).
   */
  private async ensureConnected(client: Redis): Promise<void> {
    if (client.status === 'ready') {
      return;
    }

    if (!this.redisConnecting) {
      this.redisConnecting = this.withTimeout(
        openConnection(client),
        'redis',
      ).finally(() => {
        this.redisConnecting = null;
      });
    }

    await this.redisConnecting;
  }

  private getRedisClient(): Redis {
    if (!this.redisClient) {
      this.redisClient = new Redis(this.configService.get('REDIS_URL'), {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: CHECK_TIMEOUT_MS,
        commandTimeout: CHECK_TIMEOUT_MS,
        // Keep reconnecting for the lifetime of the process: a check that gives
        // up on the first outage would report Redis down forever afterwards.
        retryStrategy: (times: number) => Math.min(times * 200, 5000),
      });
      this.redisClient.on('error', (error: Error) => {
        this.logger.debug(`Redis health client error: ${error.message}`);
      });
    }
    return this.redisClient;
  }

  private async withTimeout<T>(
    promise: PromiseLike<T>,
    label: string,
  ): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`${label} check timed out`)),
        CHECK_TIMEOUT_MS,
      );
    });

    try {
      return await Promise.race([Promise.resolve(promise), timeout]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

/**
 * Resolves once the client is ready, whether it still has to be opened or is
 * already opening (initial connect or an automatic reconnect).
 */
async function openConnection(client: Redis): Promise<void> {
  if (client.status === 'wait' || client.status === 'end') {
    await client.connect();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      client.off('ready', onReady);
      client.off('error', onError);
    };

    client.once('ready', onReady);
    client.once('error', onError);
  });
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
