import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProviderAccount } from '@openathlete/database';
import { ApiEnvSchemaType } from '@openathlete/shared';

import { AuthUser } from 'src/modules/auth/decorators/user.decorator';

import { PrismaService } from '../../prisma/services/prisma.service';
import { QueueService } from '../../queue/queue.service';
import {
  IntervalsIcuAuthError,
  IntervalsIcuHttpError,
} from './intervals-icu.client';
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
  athleteProfile: unknown = { id: 'i123456', name: 'Test Athlete' },
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
      INTERVALS_ICU_ATHLETE_ID: 'i123456',
    });

    await service.connect(USER);

    expect(keysUsed).toEqual(['env-key']);
    expect(created[0].accessToken).toBe('env-key');
    expect(created[0].externalUserId).toBe('i123456');
  });

  it('uses INTERVALS_ICU_ATHLETE_ID when the env key is used', async () => {
    const { service, pathsRequested } = setup({
      INTERVALS_ICU_API_KEY: 'env-key',
      INTERVALS_ICU_ATHLETE_ID: 'i123456',
    });

    await service.connect(USER);

    expect(pathsRequested).toEqual(['/athlete/i123456']);
  });

  it('resolves the athlete ID via the "me" alias when only the env key is set', async () => {
    const { service, pathsRequested, created } = setup({
      INTERVALS_ICU_API_KEY: 'env-key',
    });

    await service.connect(USER);

    // `GET /athlete/0` is the documented "me" alias.
    expect(pathsRequested).toEqual(['/athlete/0']);
    expect(created[0].externalUserId).toBe('i123456');
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
    expect(output).toContain('i123456');
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

/**
 * `importActivity()` tests.
 *
 * These use a small in-memory stand-in for the two tables an import writes,
 * because the defects they cover are about *when* rows appear relative to a
 * network call that can fail — something a mock that only records calls cannot
 * express. `$transaction` runs its callback against the same store, so a test
 * can assert that a failed import left nothing behind.
 */
interface FakeEvent {
  eventId: number;
  athleteId: number;
  name: string;
  startDate: Date;
  endDate: Date;
}

interface FakeEventActivity {
  eventActivityId: number;
  eventId: number;
  externalId: string;
  maxWatts: number | null;
}

const ACCOUNT = {
  providerAccountId: 1,
  athleteId: ATHLETE_ID,
  accessToken: 'api-key',
  status: 'active',
} as unknown as ProviderAccount;

/** Shaped like the summary Intervals.icu really returns: no `max_watts`. */
const RIDE = {
  id: 'i167939639',
  name: 'Marin County Road Cycling',
  type: 'Ride',
  start_date: '2026-06-28T19:18:28Z',
  moving_time: 5781,
  elapsed_time: 6978,
  distance: 34988.06,
  icu_average_watts: 202,
  stream_types: ['time', 'watts'],
};

const IMPORTED = {
  externalId: RIDE.id,
  name: RIDE.name,
  startDate: new Date(RIDE.start_date),
  endDate: new Date('2026-06-28T21:14:46Z'),
  sport: 'CYCLING',
  duration: RIDE.elapsed_time,
  raw: RIDE,
} as unknown as Parameters<IntervalsIcuProviderService['importActivity']>[1];

function importSetup(options: {
  /** Replies for `GET /activity/{id}/streams`, one per call. */
  streamReplies: (unknown | Error)[];
  /** Events already in the database, e.g. one orphaned by an earlier attempt. */
  seedEvents?: FakeEvent[];
}) {
  const events: FakeEvent[] = [...(options.seedEvents ?? [])];
  const activities: FakeEventActivity[] = [];
  let nextEventId = 100 + events.length;
  let nextActivityId = 500;

  const eventTable = {
    findFirst: jest.fn(
      async ({ where }: { where: { startDate: Date; athleteId: number } }) =>
        events.find(
          (event) =>
            event.athleteId === where.athleteId &&
            event.startDate.getTime() === where.startDate.getTime() &&
            !activities.some((a) => a.eventId === event.eventId),
        ) ?? null,
    ),
    create: jest.fn(async ({ data }: { data: Omit<FakeEvent, 'eventId'> }) => {
      const event = { eventId: ++nextEventId, ...data };
      events.push(event);
      return event;
    }),
    update: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { eventId: number };
        data: Partial<FakeEvent>;
      }) => {
        const event = events.find((e) => e.eventId === where.eventId);
        if (!event) {
          throw new Error(`No event ${where.eventId}`);
        }
        Object.assign(event, data);
        return event;
      },
    ),
  };

  const eventActivityTable = {
    findFirst: jest.fn(
      async ({ where }: { where: { externalId: string } }) =>
        activities.find((a) => a.externalId === where.externalId) ?? null,
    ),
    create: jest.fn(
      async ({
        data,
      }: {
        data: {
          externalId: string;
          maxWatts: number | null;
          event: { connect: { eventId: number } };
        };
      }) => {
        const activity = {
          eventActivityId: ++nextActivityId,
          eventId: data.event.connect.eventId,
          externalId: data.externalId,
          maxWatts: data.maxWatts,
        };
        activities.push(activity);
        return activity;
      },
    ),
  };

  const prisma = {
    athlete: {
      findUnique: jest.fn().mockResolvedValue({ athleteId: ATHLETE_ID }),
    },
    event: eventTable,
    eventActivity: eventActivityTable,
    $transaction: jest.fn(
      async (run: (tx: unknown) => Promise<unknown>) =>
        await run({ event: eventTable, eventActivity: eventActivityTable }),
    ),
  } as unknown as PrismaService;

  const service = new IntervalsIcuProviderService(
    prisma,
    { get: () => undefined } as unknown as ConfigService<
      ApiEnvSchemaType,
      true
    >,
    {} as QueueService,
  );

  let streamCall = 0;
  const clientsBuilt: { get: (path: string) => Promise<unknown> }[] = [];

  jest
    .spyOn(service as unknown as ServiceInternals, 'createClient')
    .mockImplementation(() => {
      const client = {
        get: async () => {
          const reply =
            options.streamReplies[
              Math.min(streamCall, options.streamReplies.length - 1)
            ];
          streamCall++;
          if (reply instanceof Error) {
            throw reply;
          }
          return reply;
        },
      };
      clientsBuilt.push(client);
      return client;
    });

  return { service, prisma, events, activities, clientsBuilt };
}

const WATTS_STREAM = [
  { type: 'time', data: [0, 1, 2, 3] },
  { type: 'watts', data: [0, 145, 210, 198] },
];

describe('IntervalsIcuProviderService.importActivity', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes the event and the activity together', async () => {
    const { service, events, activities, prisma } = importSetup({
      streamReplies: [WATTS_STREAM],
    });

    const saved = await service.importActivity(ACCOUNT, IMPORTED);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(activities).toHaveLength(1);
    expect(activities[0].eventId).toBe(events[0].eventId);
    expect(saved.externalId).toBe(RIDE.id);
  });

  /**
   * The data-loss defect. The old code created the `Event` before fetching
   * streams, so a stream fetch that threw left an event with no activity behind
   * it — invisible to the dedup guard, which looks for an `EventActivity`.
   */
  it('leaves no event behind when the stream fetch fails', async () => {
    const { service, events, activities } = importSetup({
      streamReplies: [new IntervalsIcuAuthError('/activity/x/streams', 7)],
    });

    await expect(
      service.importActivity(ACCOUNT, IMPORTED),
    ).rejects.toBeInstanceOf(IntervalsIcuAuthError);

    expect(events).toEqual([]);
    expect(activities).toEqual([]);
  });

  /**
   * Retries have to converge on one row per activity. Under the old code each
   * of the three BullMQ attempts leaked another event; six orphans accumulated
   * on a real account for two activities that were never imported at all.
   */
  it('adopts an event orphaned by an earlier attempt instead of duplicating it', async () => {
    const { service, events, activities } = importSetup({
      streamReplies: [WATTS_STREAM],
      seedEvents: [
        {
          eventId: 77,
          athleteId: ATHLETE_ID,
          // Stale leftovers from whatever the abandoned attempt wrote.
          name: 'Some other ride',
          startDate: new Date(RIDE.start_date),
          endDate: new Date('2026-06-28T20:00:00Z'),
        },
      ],
    });

    await service.importActivity(ACCOUNT, IMPORTED);

    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe(77);
    expect(activities[0].eventId).toBe(77);
    // The adopted row describes the activity now attached to it, not the one
    // the abandoned attempt was working on.
    expect(events[0].name).toBe(RIDE.name);
    expect(events[0].endDate).toEqual(IMPORTED.endDate);
  });

  it('repeated failed attempts never accumulate events', async () => {
    const error = new IntervalsIcuAuthError('/activity/x/streams', 7);
    const { service, events } = importSetup({
      streamReplies: [error, error, error],
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(service.importActivity(ACCOUNT, IMPORTED)).rejects.toThrow();
    }

    expect(events).toEqual([]);
  });

  it('returns the existing activity rather than importing twice', async () => {
    const { service, events, activities } = importSetup({
      streamReplies: [WATTS_STREAM],
    });

    const first = await service.importActivity(ACCOUNT, IMPORTED);
    const second = await service.importActivity(ACCOUNT, IMPORTED);

    expect(second.eventActivityId).toBe(first.eventActivityId);
    expect(events).toHaveLength(1);
    expect(activities).toHaveLength(1);
  });

  // Intervals.icu has no `max_watts` on an activity summary, so the peak has to
  // come from the stream. Reading the summary field gave null on all 1,222
  // activities of a real account.
  it('stores a max power derived from the watts stream', async () => {
    const { service, activities } = importSetup({
      streamReplies: [WATTS_STREAM],
    });

    await service.importActivity(ACCOUNT, IMPORTED);

    expect(RIDE).not.toHaveProperty('max_watts');
    expect(activities[0].maxWatts).toBe(210);
  });

  // A stream that could not be fetched is a failed import, not an import with
  // no stream: swallowing the error stored a blank activity and reported it as
  // a success.
  it('fails the import when the streams cannot be fetched', async () => {
    const { service, activities } = importSetup({
      streamReplies: [new IntervalsIcuHttpError(500, '/streams', '{}')],
    });

    await expect(service.importActivity(ACCOUNT, IMPORTED)).rejects.toThrow(
      /status 500/,
    );
    expect(activities).toEqual([]);
  });

  it('imports without streams when Intervals.icu reports none', async () => {
    const { service, activities } = importSetup({
      streamReplies: [new IntervalsIcuHttpError(404, '/streams', '{}')],
    });

    await service.importActivity(ACCOUNT, IMPORTED);

    expect(activities).toHaveLength(1);
    expect(activities[0].maxWatts).toBeNull();
  });

  /**
   * The client spaces its own requests 200ms apart by remembering when it last
   * called out. Building a new one per activity reset that clock every time, so
   * the spacing never applied *between* activities — which is how a 1,224
   * activity import outran the API's tolerance and drew an auth block.
   */
  it('reuses one client across activities so the throttle spans them', async () => {
    const { service, clientsBuilt } = importSetup({
      streamReplies: [WATTS_STREAM, WATTS_STREAM, WATTS_STREAM],
    });

    for (const externalId of ['i1', 'i2', 'i3']) {
      await service.importActivity(ACCOUNT, {
        ...IMPORTED,
        externalId,
        raw: { ...RIDE, id: externalId },
      });
    }

    expect(clientsBuilt).toHaveLength(1);
  });

  it('builds a new client when the account key changes', async () => {
    const { service, clientsBuilt } = importSetup({
      streamReplies: [WATTS_STREAM, WATTS_STREAM],
    });

    await service.importActivity(ACCOUNT, IMPORTED);
    await service.importActivity(
      { ...ACCOUNT, accessToken: 'rotated-key' } as ProviderAccount,
      { ...IMPORTED, externalId: 'i2', raw: { ...RIDE, id: 'i2' } },
    );

    expect(clientsBuilt).toHaveLength(2);
  });
});
