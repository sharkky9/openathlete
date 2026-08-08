import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProviderAccount } from '@openathlete/database';
import { ApiEnvSchemaType } from '@openathlete/shared';

import { AuthUser } from 'src/modules/auth/decorators/user.decorator';

import { PrismaService } from '../../prisma/services/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { IntervalsIcuAuthError } from './intervals-icu.client';
import { IntervalsIcuProviderService } from './intervals-icu.provider.service';

/**
 * `connect()` reaches the network through the protected `createClient` factory,
 * so the tests replace that factory and record the key it was handed. The key
 * itself is what these tests are about: which one is used, and where it came
 * from.
 */
interface ServiceInternals {
  createClient: (apiKey: string) => { get: (path: string) => Promise<unknown> };
}

const ATHLETE_ID = 42;
const USER: AuthUser = { userId: 7 } as AuthUser;

function setup(
  env: Partial<Record<keyof ApiEnvSchemaType, string>> = {},
  athleteProfile: unknown = { id: 'i225849', name: 'Test Athlete' },
) {
  const created: { accessToken: string; externalUserId?: string }[] = [];

  const prisma = {
    athlete: {
      findUnique: jest.fn().mockResolvedValue({ athleteId: ATHLETE_ID }),
    },
    providerAccount: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(
        async ({
          data,
        }: {
          data: { accessToken: string; externalUserId?: string };
        }) => {
          created.push(data);
          return {
            providerAccountId: 1,
            ...data,
          } as unknown as ProviderAccount;
        },
      ),
      update: jest.fn(),
    },
  } as unknown as PrismaService;

  const configService = {
    get: (key: keyof ApiEnvSchemaType) => env[key],
  } as unknown as ConfigService<ApiEnvSchemaType, true>;

  const service = new IntervalsIcuProviderService(
    prisma,
    configService,
    {} as QueueService,
  );

  // Keys the client factory was constructed with, and paths requested.
  const keysUsed: string[] = [];
  const pathsRequested: string[] = [];

  jest
    .spyOn(service as unknown as ServiceInternals, 'createClient')
    .mockImplementation((apiKey: string) => {
      keysUsed.push(apiKey);
      return {
        get: async (path: string) => {
          pathsRequested.push(path);
          if (athleteProfile instanceof Error) {
            throw athleteProfile;
          }
          return athleteProfile;
        },
      };
    });

  return { service, prisma, created, keysUsed, pathsRequested };
}

describe('IntervalsIcuProviderService.connect', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the key from the request even when an env key is configured', async () => {
    const { service, keysUsed, created } = setup({
      INTERVALS_ICU_API_KEY: 'env-key',
      INTERVALS_ICU_ATHLETE_ID: 'i999999',
    });

    await service.connect(USER, 'request-key');

    expect(keysUsed).toEqual(['request-key']);
    expect(created[0].accessToken).toBe('request-key');
  });

  it('ignores the env athlete ID when the key came from the request', async () => {
    // The env athlete ID belongs to the env key's account; pairing it with a
    // different key would point the connection at the wrong athlete.
    const { service, pathsRequested } = setup({
      INTERVALS_ICU_API_KEY: 'env-key',
      INTERVALS_ICU_ATHLETE_ID: 'i999999',
    });

    await service.connect(USER, 'request-key');

    expect(pathsRequested).toEqual(['/athlete/0']);
  });

  it('falls back to INTERVALS_ICU_API_KEY when the request supplies none', async () => {
    const { service, keysUsed, created } = setup({
      INTERVALS_ICU_API_KEY: 'env-key',
      INTERVALS_ICU_ATHLETE_ID: 'i225849',
    });

    await service.connect(USER);

    expect(keysUsed).toEqual(['env-key']);
    expect(created[0].accessToken).toBe('env-key');
    expect(created[0].externalUserId).toBe('i225849');
  });

  it('uses INTERVALS_ICU_ATHLETE_ID when the env key is used', async () => {
    const { service, pathsRequested } = setup({
      INTERVALS_ICU_API_KEY: 'env-key',
      INTERVALS_ICU_ATHLETE_ID: 'i225849',
    });

    await service.connect(USER);

    expect(pathsRequested).toEqual(['/athlete/i225849']);
  });

  it('resolves the athlete ID via the "me" alias when only the env key is set', async () => {
    const { service, pathsRequested, created } = setup({
      INTERVALS_ICU_API_KEY: 'env-key',
    });

    await service.connect(USER);

    // `GET /athlete/0` is the documented "me" alias.
    expect(pathsRequested).toEqual(['/athlete/0']);
    expect(created[0].externalUserId).toBe('i225849');
  });

  it('treats a blank env key as unset', async () => {
    const { service } = setup({ INTERVALS_ICU_API_KEY: '   ' });

    await expect(service.connect(USER)).rejects.toThrow(
      /INTERVALS_ICU_API_KEY/,
    );
  });

  it('fails with a clear error when neither a request key nor an env key exists', async () => {
    const { service, keysUsed } = setup();

    await expect(service.connect(USER)).rejects.toThrow(
      'An Intervals.icu API key is required: supply one when connecting, or set INTERVALS_ICU_API_KEY on the server',
    );
    // Nothing was attempted against the API.
    expect(keysUsed).toEqual([]);
  });

  it('validates the env key against the athlete endpoint like a request key', async () => {
    const { service, pathsRequested, created } = setup(
      { INTERVALS_ICU_API_KEY: 'bad-env-key' },
      new IntervalsIcuAuthError('/athlete/0', 5),
    );

    await expect(service.connect(USER)).rejects.toBeInstanceOf(
      IntervalsIcuAuthError,
    );

    // The probe happened, and a misconfigured env var never reached the database.
    expect(pathsRequested).toEqual(['/athlete/0']);
    expect(created).toEqual([]);
  });

  it('logs the credential source and athlete ID but never the key', async () => {
    const logged: string[] = [];
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });

    const { service } = setup({ INTERVALS_ICU_API_KEY: 'super-secret-key' });

    await service.connect(USER);

    const output = logged.join('\n');
    expect(output).not.toContain('super-secret-key');
    expect(output).toContain('INTERVALS_ICU_API_KEY');
    expect(output).toContain('i225849');
  });

  it('does not log the request key either', async () => {
    const logged: string[] = [];
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });

    const { service } = setup();

    await service.connect(USER, 'another-secret-key');

    const output = logged.join('\n');
    expect(output).not.toContain('another-secret-key');
    expect(output).toContain('request');
  });
});
