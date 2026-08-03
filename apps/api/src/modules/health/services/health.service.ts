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

export interface ReadinessReport {
  status: 'ok' | 'error';
  uptime: number;
  checks: {
    database: DependencyCheck;
    redis: DependencyCheck;
  };
}

const CHECK_TIMEOUT_MS = 3000;

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private redisClient: Redis | null = null;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService<ApiEnvSchemaType, true>,
  ) {}

  async getReadiness(): Promise<ReadinessReport> {
    const [database, redis] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
    ]);

    const status =
      database.status === 'up' && redis.status === 'up' ? 'ok' : 'error';

    return {
      status,
      uptime: Math.round(process.uptime()),
      checks: { database, redis },
    };
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
      return { status: 'down', error: toMessage(error) };
    }
  }

  private async checkRedis(): Promise<DependencyCheck> {
    try {
      const client = this.getRedisClient();
      if (client.status === 'wait' || client.status === 'end') {
        await this.withTimeout(client.connect(), 'redis');
      }
      await this.withTimeout(client.ping(), 'redis');
      return { status: 'up' };
    } catch (error) {
      this.logger.warn(`Redis readiness check failed: ${toMessage(error)}`);
      return { status: 'down', error: toMessage(error) };
    }
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

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
