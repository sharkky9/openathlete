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
  seedEntries: Array<{
    trainingLoadEntryId: number;
    date: Date;
    activity: { event: { startDate: Date } };
  }> = [],
) {
  const created: { accessToken: string; externalUserId?: string }[] = [];
  const entries = seedEntries.map((entry) => ({ ...entry }));

  const prisma = {
    athlete: {
      findUnique: jest.fn().mockResolvedValue({ athleteId: ATHLETE_ID }),
      update: jest.fn().mockResolvedValue({ athleteId: ATHLETE_ID }),
    },
    trainingLoadEntry: {
      findMany: jest.fn().mockImplementation(async () => entries),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { trainingLoadEntryId: number };
          data: { date: Date };
        }) => {
          const entry = entries.find(
            (candidate) =>
              candidate.trainingLoadEntryId === where.trainingLoadEntryId,
          );
          if (entry) entry.date = data.date;
          return entry;
        },
      ),
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
          if (path.includes('/activities')) return [];
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

  it('stores the profile timezone and idempotently re-anchors existing loads', async () => {
    const { service, prisma } = setup(
      {},
      {
        id: 'i123456',
        name: 'Test Athlete',
        timezone: 'America/Los_Angeles',
      },
      [
        {
          trainingLoadEntryId: 9,
          date: new Date('2026-06-29T00:00:00Z'),
          activity: {
            event: { startDate: new Date('2026-06-29T02:00:00Z') },
          },
        },
      ],
    );

    await service.connect(USER, 'request-key');
    await service.connect(USER, 'request-key');

    expect(prisma.athlete.update).toHaveBeenCalledWith({
      where: { athleteId: ATHLETE_ID },
      data: { timezone: 'America/Los_Angeles' },
    });
    expect(prisma.trainingLoadEntry.update).toHaveBeenCalledTimes(1);
    expect(prisma.trainingLoadEntry.update).toHaveBeenCalledWith({
      where: { trainingLoadEntryId: 9 },
      data: { date: new Date('2026-06-28T00:00:00Z') },
    });
  });

  it('refreshes the profile timezone whenever activities are imported', async () => {
    const { service, prisma, pathsRequested } = setup(
      {},
      {
        id: 'i123456',
        timezone: 'America/Los_Angeles',
      },
    );

    await service.importActivities(
      {
        providerAccountId: 1,
        athleteId: ATHLETE_ID,
        externalUserId: 'i123456',
        accessToken: 'request-key',
        status: 'active',
      } as ProviderAccount,
      {
        startDate: new Date('2026-06-01T00:00:00Z'),
        endDate: new Date('2026-06-02T00:00:00Z'),
      },
    );

    expect(pathsRequested[0]).toBe('/athlete/i123456');
    expect(pathsRequested).toContain('/athlete/i123456/activities');
    expect(prisma.athlete.update).toHaveBeenCalledWith({
      where: { athleteId: ATHLETE_ID },
      data: { timezone: 'America/Los_Angeles' },
    });
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
  type: string;
  startDate: Date;
  endDate: Date;
  createdAt: Date;
}

/**
 * The `where` the orphan lookup builds. Every clause is optional here and an
 * absent one filters nothing, exactly as Prisma treats it — so dropping a
 * clause from the query widens what the fake matches, and the tests below fail
 * for the reason they are written to catch rather than on a stray undefined.
 */
interface FakeEventWhere {
  athleteId?: number;
  type?: string;
  name?: string;
  startDate?: Date;
  endDate?: Date;
  createdAt?: { gte: Date; lte: Date };
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
  id: 'i100000001',
  name: 'Sample Road Ride',
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An event this importer would have written for `IMPORTED` and then failed to
 * finish: same athlete, same start, same end, same name, and old enough that
 * nothing can still be working on it. Override a field to move it out of reach
 * of adoption and assert that it stays there.
 */
function orphan(
  overrides: Partial<FakeEvent> & { eventId: number },
): FakeEvent {
  return {
    athleteId: ATHLETE_ID,
    name: RIDE.name,
    type: 'ACTIVITY',
    startDate: new Date(RIDE.start_date),
    endDate: new Date('2026-06-28T21:14:46Z'),
    createdAt: new Date(Date.now() - 2 * DAY_MS),
    ...overrides,
  };
}

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
      async ({ where }: { where: FakeEventWhere }) =>
        events.find(
          (event) =>
            (where.athleteId === undefined ||
              event.athleteId === where.athleteId) &&
            (where.type === undefined || event.type === where.type) &&
            (where.name === undefined || event.name === where.name) &&
            (where.startDate === undefined ||
              event.startDate.getTime() === where.startDate.getTime()) &&
            (where.endDate === undefined ||
              event.endDate.getTime() === where.endDate.getTime()) &&
            (where.createdAt === undefined ||
              (event.createdAt >= where.createdAt.gte &&
                event.createdAt <= where.createdAt.lte)) &&
            // `activity: { is: null }`
            !activities.some((a) => a.eventId === event.eventId),
        ) ?? null,
    ),
    create: jest.fn(
      async ({ data }: { data: Omit<FakeEvent, 'eventId' | 'createdAt'> }) => {
        const event = {
          eventId: ++nextEventId,
          createdAt: new Date(),
          ...data,
        };
        events.push(event);
        return event;
      },
    ),
    // Adoption no longer rewrites the row it takes: matching on name and end
    // date is exactly what made the row safe to take in the first place. A call
    // here means that reasoning has been broken.
    update: jest.fn(() => {
      throw new Error('resolveEvent must not update the event it adopts');
    }),
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
      seedEvents: [orphan({ eventId: 77 })],
    });

    await service.importActivity(ACCOUNT, IMPORTED);

    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe(77);
    expect(activities[0].eventId).toBe(77);
  });

  /**
   * The reason adoption is not simply "an activity-less ACTIVITY event at this
   * start time".
   *
   * Strava, Garmin, Polar and Suunto all still create their `Event` and their
   * `EventActivity` in two statements with a network call in between — Strava
   * allows 45 seconds for a stream fetch alone. Throughout that call their
   * event is activity-less and looks exactly like wreckage. And because
   * Intervals.icu is an aggregator that pulls from those same platforms, the
   * two rows for one ride can agree on every field there is.
   *
   * Taking it would hang this activity off Strava's event and then collide with
   * Strava's own insert: one activity attached to the wrong event, another lost
   * outright, across two providers. The age floor is what stops it, since a row
   * that young cannot be the leftovers of anything.
   */
  it('does not adopt an event another provider is still writing', async () => {
    const inFlight = orphan({
      eventId: 77,
      // Not a stale copy — the row another provider created seconds ago and is
      // about to attach its own activity to.
      createdAt: new Date(),
    });

    const { service, events, activities } = importSetup({
      streamReplies: [WATTS_STREAM],
      seedEvents: [inFlight],
    });

    await service.importActivity(ACCOUNT, IMPORTED);

    // A second event, not a stolen one, and the other provider's row is still
    // free for the activity it is waiting on.
    expect(events).toHaveLength(2);
    expect(activities[0].eventId).not.toBe(77);
    expect(activities.some((a) => a.eventId === 77)).toBe(false);
  });

  it('does not adopt an event that merely starts at the same time', async () => {
    const { service, events, activities } = importSetup({
      streamReplies: [WATTS_STREAM],
      seedEvents: [
        orphan({
          eventId: 77,
          // Another provider's naming and its own idea of when the ride ended.
          name: 'Morning Ride',
          endDate: new Date('2026-06-28T20:00:00Z'),
        }),
      ],
    });

    await service.importActivity(ACCOUNT, IMPORTED);

    expect(events).toHaveLength(2);
    expect(activities[0].eventId).not.toBe(77);
  });

  it('does not adopt an event older than the wreckage window', async () => {
    const { service, events, activities } = importSetup({
      streamReplies: [WATTS_STREAM],
      seedEvents: [
        orphan({
          eventId: 77,
          createdAt: new Date(Date.now() - 90 * DAY_MS),
        }),
      ],
    });

    await service.importActivity(ACCOUNT, IMPORTED);

    expect(events).toHaveLength(2);
    expect(activities[0].eventId).not.toBe(77);
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
