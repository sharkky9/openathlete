import { TrainingLoadCalculationType } from '@openathlete/database';

import {
  EWMA_ALPHA_ATL,
  EWMA_ALPHA_CTL,
} from 'src/common/constants/training-formulas.constants';
import { AuthUser } from 'src/modules/auth/decorators/user.decorator';
import { CaslAbilityFactory } from 'src/modules/auth/services/casl-ability.factory';
import { PrismaService } from 'src/modules/prisma/services/prisma.service';

import { TrainingLoadService } from './training-load.service';

/**
 * Covers the ATL / CTL / TSB maths — the numbers the whole product is built on
 * and which had no test at all.
 *
 * The expectations are derived from the closed form of an exponentially
 * weighted moving average rather than copied out of the implementation:
 *
 *   x_n = alpha * load_n + (1 - alpha) * x_(n-1),  x_0 = 0
 *
 * which for a constant load L over n days is  x_n = L * (1 - (1 - alpha)^n),
 * and for a single load L followed by k rest days is
 * `alpha * L * (1 - alpha)^k`. Both forms are written out below rather than
 * re-deriving them with the same recurrence the service uses, so a change to
 * the recurrence shows up as a failure instead of being mirrored by the test.
 *
 * ATL is the 7-day EWMA (alpha = 2/8), CTL the 42-day one (alpha = 2/43), and
 * TSB is CTL - ATL: fatigue falls away quickly, fitness slowly, so rest pushes
 * TSB positive and a hard block pushes it negative.
 *
 * `TrainingLoadEntry.date` is a UTC-midnight encoding of the athlete's local
 * calendar date. Read paths operate on those day anchors and must never let the
 * API server's process timezone move them.
 */

const ATHLETE_ID = 42;
const CALCULATION_ID = 7;
const CALCULATION_TYPE: TrainingLoadCalculationType = 'TRIMP';

const USER = { userId: 1 } as AuthUser;

const ALPHA_ATL = EWMA_ALPHA_ATL;
const ALPHA_CTL = EWMA_ALPHA_CTL;

/** A UTC-midnight Date, matching how training load entries are stored. */
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** EWMA of a constant daily load `load` sustained for `days` days from zero. */
const steadyState = (load: number, days: number, alpha: number) =>
  load * (1 - Math.pow(1 - alpha, days));

/** EWMA `restDays` after a single load spike, starting from zero. */
const spikeThenRest = (load: number, restDays: number, alpha: number) =>
  alpha * load * Math.pow(1 - alpha, restDays);

type Entry = { date: string; value: number };

/**
 * A `TrainingLoadService` backed by an in-memory set of entries.
 *
 * Only the reads the ATL/CTL/TSB paths make are stubbed: the athlete lookup,
 * the calculation row, and the date-ranged entry query. `findMany` applies the
 * `gte`/`lte` filter for real so that the 42-day warm-up window the service
 * asks for is exercised rather than assumed.
 */
function buildService(entries: Entry[], timezone = 'UTC') {
  const rows = entries.map((entry) => ({
    date: day(entry.date),
    value: entry.value,
  }));

  const findMany = jest.fn(
    async ({
      where,
    }: {
      where: { calculationId: number; date: { gte: Date; lte: Date } };
    }) =>
      rows.filter(
        (row) =>
          row.date.getTime() >= where.date.gte.getTime() &&
          row.date.getTime() <= where.date.lte.getTime(),
      ),
  );

  const prisma = {
    athlete: {
      findFirst: jest.fn(async () => ({ athleteId: ATHLETE_ID, timezone })),
      findUnique: jest.fn(async () => ({ athleteId: ATHLETE_ID, timezone })),
    },
    trainingLoadCalculation: {
      findUnique: jest.fn(async () => ({
        trainingLoadCalculationId: CALCULATION_ID,
      })),
    },
    trainingLoadEntry: { findMany },
  };

  const abilities = {
    getFor: jest.fn(async () => ({ can: () => true })),
  };

  const service = new TrainingLoadService(
    prisma as unknown as PrismaService,
    abilities as unknown as CaslAbilityFactory,
  );

  return { service, prisma, findMany };
}

const metricsOn = (entries: Entry[], targetDate: string) =>
  buildService(entries).service.getTrainingLoadMetrics(
    USER,
    CALCULATION_TYPE,
    day(targetDate),
  );

/** As `metricsOn`, but for an arbitrary instant rather than a UTC midnight. */
const metricsAt = (entries: Entry[], targetDate: Date, timezone = 'UTC') =>
  buildService(entries, timezone).service.getTrainingLoadMetrics(
    USER,
    CALCULATION_TYPE,
    targetDate,
  );

/**
 * The zone this process is running in, for failure messages.
 *
 * Assigning `process.env.TZ` at runtime cannot move it: Jest replaces
 * `process.env` with a plain sandbox object, so the libuv hook that would
 * re-read the zone never fires. The timezone therefore has to be set on the
 * process before Jest starts — see `pnpm api test:timezones`.
 */
const PROCESS_TIMEZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'unknown';

const historyFor = (entries: Entry[], startDate: string, endDate: string) =>
  buildService(entries).service.getTrainingLoadHistory(
    USER,
    CALCULATION_TYPE,
    day(startDate),
    day(endDate),
  );

describe('TrainingLoadService — ATL / CTL / TSB', () => {
  describe('a single day of load', () => {
    it('moves ATL by alpha_atl and CTL by alpha_ctl on the day it happens', async () => {
      const metrics = await metricsOn(
        [{ date: '2026-03-01', value: 100 }],
        '2026-03-01',
      );

      // First non-zero sample from a zero baseline: x = alpha * load.
      expect(metrics.atl).toBeCloseTo(0.25 * 100, 10);
      expect(metrics.ctl).toBeCloseTo((2 / 43) * 100, 10);
    });

    it('leaves TSB deeply negative — one hard day is fatigue, not fitness', async () => {
      const metrics = await metricsOn(
        [{ date: '2026-03-01', value: 100 }],
        '2026-03-01',
      );

      expect(metrics.tsb).toBeCloseTo(metrics.ctl - metrics.atl, 10);
      expect(metrics.tsb).toBeLessThan(0);
      expect(metrics.status).toBe('overreaching');
    });
  });

  describe('an empty history', () => {
    it('reports zero fitness, zero fatigue and a neutral balance', async () => {
      const metrics = await metricsOn([], '2026-03-01');

      expect(metrics.atl).toBe(0);
      expect(metrics.ctl).toBe(0);
      expect(metrics.tsb).toBe(0);
      expect(metrics.totalLoad).toBe(0);
      expect(metrics.trainingDays).toBe(0);
      // TSB of 0 sits between the overreaching (-10) and detraining (25) marks.
      expect(metrics.status).toBe('optimal');
    });
  });

  describe('a constant daily load', () => {
    // 43 days is the full window the service looks at: targetDate - 42 through
    // targetDate inclusive.
    const WINDOW_DAYS = 43;
    const DAILY_LOAD = 100;

    const everyDay = () =>
      Array.from({ length: WINDOW_DAYS }, (_, index) => {
        const date = new Date(day('2026-03-01'));
        date.setUTCDate(date.getUTCDate() - (WINDOW_DAYS - 1 - index));
        return { date: date.toISOString().split('T')[0], value: DAILY_LOAD };
      });

    it('drives ATL to the daily load and CTL only part-way there', async () => {
      const metrics = await metricsOn(everyDay(), '2026-03-01');

      expect(metrics.atl).toBeCloseTo(
        steadyState(DAILY_LOAD, WINDOW_DAYS, ALPHA_ATL),
        8,
      );
      expect(metrics.ctl).toBeCloseTo(
        steadyState(DAILY_LOAD, WINDOW_DAYS, ALPHA_CTL),
        8,
      );

      // The 7-day average is essentially saturated after 43 days; the 42-day
      // one is still climbing, so fitness lags fatigue during a ramp.
      expect(metrics.atl).toBeCloseTo(DAILY_LOAD, 2);
      expect(metrics.ctl).toBeLessThan(metrics.atl);
      expect(metrics.tsb).toBeLessThan(0);
    });

    it('counts every day of the block in totalLoad and trainingDays', async () => {
      const metrics = await metricsOn(everyDay(), '2026-03-01');

      expect(metrics.trainingDays).toBe(WINDOW_DAYS);
      expect(metrics.totalLoad).toBe(WINDOW_DAYS * DAILY_LOAD);
    });
  });

  describe('rest after a hard effort', () => {
    it('decays fatigue much faster than fitness, turning TSB positive', async () => {
      // One 2000-point effort, then three weeks of nothing.
      const metrics = await metricsOn(
        [{ date: '2026-02-08', value: 2000 }],
        '2026-03-01',
      );

      const restDays = 21;
      expect(metrics.atl).toBeCloseTo(
        spikeThenRest(2000, restDays, ALPHA_ATL),
        8,
      );
      expect(metrics.ctl).toBeCloseTo(
        spikeThenRest(2000, restDays, ALPHA_CTL),
        8,
      );

      expect(metrics.atl).toBeLessThan(metrics.ctl);
      expect(metrics.tsb).toBeGreaterThan(0);
      expect(metrics.status).toBe('detraining');
    });

    it('keeps TSB negative through the first week of rest', async () => {
      // Four days off. ATL has shed 68% of the spike but is still far above
      // CTL, so the athlete reads as fatigued rather than fresh. The crossover
      // is at eight rest days: 0.25 * 0.75^k < (2/43) * (41/43)^k holds from
      // k = 8 onwards.
      const metrics = await metricsOn(
        [{ date: '2026-02-25', value: 300 }],
        '2026-03-01',
      );

      expect(metrics.atl).toBeGreaterThan(metrics.ctl);
      expect(metrics.tsb).toBeLessThan(0);
    });

    it('rates a moderate effort ten days back as optimal, not detrained', async () => {
      // Past the crossover, so TSB is positive, but the load was small enough
      // that it stays under the detraining mark of 25.
      const metrics = await metricsOn(
        [{ date: '2026-02-19', value: 500 }],
        '2026-03-01',
      );

      expect(metrics.tsb).toBeGreaterThan(0);
      expect(metrics.tsb).toBeLessThan(25);
      expect(metrics.status).toBe('optimal');
    });
  });

  describe('day bucketing', () => {
    it('sums several activities recorded on the same day', async () => {
      const split = await metricsOn(
        [
          { date: '2026-03-01', value: 60 },
          { date: '2026-03-01', value: 40 },
        ],
        '2026-03-01',
      );
      const single = await metricsOn(
        [{ date: '2026-03-01', value: 100 }],
        '2026-03-01',
      );

      expect(split.atl).toBeCloseTo(single.atl, 10);
      expect(split.ctl).toBeCloseTo(single.ctl, 10);
      // Two activities, but one training day.
      expect(split.trainingDays).toBe(1);
      expect(split.totalLoad).toBe(100);
    });

    it('ignores load outside the 42-day window', async () => {
      const metrics = await metricsOn(
        [{ date: '2025-12-01', value: 5000 }],
        '2026-03-01',
      );

      expect(metrics.atl).toBe(0);
      expect(metrics.ctl).toBe(0);
      expect(metrics.totalLoad).toBe(0);
    });

    it('asks the database for exactly the 42-day warm-up window', async () => {
      const { service, findMany } = buildService([]);

      await service.getTrainingLoadMetrics(
        USER,
        CALCULATION_TYPE,
        day('2026-03-01'),
      );

      const where = findMany.mock.calls[0][0].where;
      expect(where.calculationId).toBe(CALCULATION_ID);
      expect(where.date.lte).toEqual(day('2026-03-01'));
      expect(where.date.gte).toEqual(day('2026-01-18')); // 42 days earlier
    });
  });

  describe('status thresholds', () => {
    it('calls a heavy recent block overreaching', async () => {
      const metrics = await metricsOn(
        [
          { date: '2026-02-27', value: 400 },
          { date: '2026-02-28', value: 400 },
          { date: '2026-03-01', value: 400 },
        ],
        '2026-03-01',
      );

      expect(metrics.tsb).toBeLessThan(-10);
      expect(metrics.status).toBe('overreaching');
    });
  });

  describe('recommended load range', () => {
    it('returns a non-negative range with a real width', async () => {
      const metrics = await metricsOn(
        [
          { date: '2026-02-22', value: 300 },
          { date: '2026-02-25', value: 250 },
          { date: '2026-03-01', value: 350 },
        ],
        '2026-03-01',
      );

      expect(metrics.recommendedLoadRange.min).toBeGreaterThanOrEqual(0);
      expect(metrics.recommendedLoadRange.max).toBeGreaterThan(
        metrics.recommendedLoadRange.min,
      );
    });
  });
});

describe('TrainingLoadService — history', () => {
  it('returns one row per day in the requested range', async () => {
    const history = await historyFor(
      [{ date: '2026-03-02', value: 100 }],
      '2026-03-01',
      '2026-03-05',
    );

    expect(history.map((row) => row.date.toISOString().split('T')[0])).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
    ]);
  });

  it('keeps TSB = CTL - ATL on every row', async () => {
    const history = await historyFor(
      [
        { date: '2026-03-01', value: 120 },
        { date: '2026-03-03', value: 80 },
        { date: '2026-03-04', value: 200 },
      ],
      '2026-03-01',
      '2026-03-05',
    );

    for (const row of history) {
      expect(row.tsb).toBeCloseTo(row.ctl - row.atl, 10);
    }
  });

  it('carries fitness in from before the range instead of starting at zero', async () => {
    // The only load is 10 days before the range starts. Without the 42-day
    // warm-up the range would open at zero CTL, which would show every athlete
    // as freshly untrained whenever they scrolled the chart.
    const history = await historyFor(
      [{ date: '2026-02-19', value: 500 }],
      '2026-03-01',
      '2026-03-03',
    );

    expect(history[0].load).toBe(0);
    expect(history[0].ctl).toBeCloseTo(spikeThenRest(500, 10, ALPHA_CTL), 8);
    expect(history[0].atl).toBeCloseTo(spikeThenRest(500, 10, ALPHA_ATL), 8);
    expect(history[0].ctl).toBeGreaterThan(0);
  });

  it('decays both averages across rest days inside the range', async () => {
    const history = await historyFor(
      [{ date: '2026-03-01', value: 400 }],
      '2026-03-01',
      '2026-03-04',
    );

    for (let index = 1; index < history.length; index++) {
      expect(history[index].atl).toBeLessThan(history[index - 1].atl);
      expect(history[index].ctl).toBeLessThan(history[index - 1].ctl);
      // Fatigue sheds a quarter of itself a day, fitness ~4.7%, so the balance
      // improves every rest day.
      expect(history[index].tsb).toBeGreaterThan(history[index - 1].tsb);
    }
  });

  it('agrees with getTrainingLoadMetrics on the final day', async () => {
    const entries = [
      { date: '2026-02-20', value: 250 },
      { date: '2026-02-24', value: 180 },
      { date: '2026-03-01', value: 320 },
    ];

    const history = await historyFor(entries, '2026-02-25', '2026-03-01');
    const metrics = await metricsOn(entries, '2026-03-01');
    const lastDay = history[history.length - 1];

    expect(lastDay.atl).toBeCloseTo(metrics.atl, 8);
    expect(lastDay.ctl).toBeCloseTo(metrics.ctl, 8);
    expect(lastDay.tsb).toBeCloseTo(metrics.tsb, 8);
  });
});

describe('TrainingLoadService — athlete-local writes', () => {
  it('stores an evening Pacific activity under the athlete local date', async () => {
    const create = jest.fn(
      async ({ data }: { data: Record<string, unknown> }) => data,
    );
    const prisma = {
      athlete: {
        findFirst: jest.fn(async () => ({
          athleteId: ATHLETE_ID,
          timezone: 'America/Los_Angeles',
          user: { gender: 'MALE' },
        })),
      },
      event: {
        findFirst: jest.fn(async () => ({
          eventId: 100,
          startDate: new Date('2026-08-08T02:00:00Z'), // Friday 19:00 PDT
          activity: {
            eventActivityId: 200,
            rpe: 0.5,
            movingTime: 3600,
          },
        })),
      },
      trainingLoadCalculation: {
        findUnique: jest.fn(async () => ({
          trainingLoadCalculationId: CALCULATION_ID,
        })),
      },
      trainingLoadEntry: {
        findUnique: jest.fn(async () => null),
        create,
      },
    };
    const service = new TrainingLoadService(
      prisma as unknown as PrismaService,
      {} as CaslAbilityFactory,
    );

    await service.calculateActivityLoad(USER, 100, 'FOSTER_RPE');

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        date: new Date('2026-08-07T00:00:00Z'),
      }),
    });
  });
});

/**
 * Day anchors are timezone-free after the athlete-local conversion, so none of
 * these numbers may depend on the timezone the server happens to run in.
 *
 * The service used to bucket its day grid with local-time `setHours(0, 0, 0, 0)`
 * while keying it with UTC `toISOString().split('T')[0]`. Those agree only at
 * non-positive UTC offsets, and only for target instants late enough in the UTC
 * day — so the defect was invisible both to CI and to the suite, which pinned
 * `TZ=UTC`. It is a silent wrong answer rather than a crash, and because CTL and
 * ATL are cumulative, one misplaced day propagates through every later day.
 */
describe(`TrainingLoadService — timezone independence (TZ=${PROCESS_TIMEZONE})`, () => {
  it('counts a load on the day it was recorded', async () => {
    const metrics = await metricsOn(
      [{ date: '2026-03-01', value: 100 }],
      '2026-03-01',
    );

    expect(metrics.atl).toBeCloseTo(ALPHA_ATL * 100, 10);
    expect(metrics.ctl).toBeCloseTo(ALPHA_CTL * 100, 10);
    expect(metrics.totalLoad).toBe(100);
    expect(metrics.trainingDays).toBe(1);
  });

  it('returns the requested days from the history, and only those', async () => {
    const history = await historyFor(
      [{ date: '2026-03-02', value: 100 }],
      '2026-03-01',
      '2026-03-05',
    );

    expect(history.map((row) => row.date.toISOString().split('T')[0])).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
    ]);
    // The load must sit on 2026-03-02, not drift to a neighbouring day.
    expect(history.map((row) => row.load)).toEqual([0, 100, 0, 0, 0]);
  });

  /**
   * The case that motivated all of this.
   *
   * The owner is in America/Los_Angeles. He rides at 19:00 on Friday 7 August;
   * that instant is 2026-08-08T02:00Z. Both the entry write and the metrics
   * request must resolve it to the athlete's Friday anchor, 2026-08-07.
   */
  it('counts an evening activity logged late in the UTC day', async () => {
    const rideInstant = new Date('2026-08-08T02:00:00.000Z'); // 19:00 PDT, 7 Aug

    const metrics = await metricsAt(
      [{ date: '2026-08-07', value: 100 }],
      rideInstant,
      'America/Los_Angeles',
    );

    expect(metrics.atl).toBeCloseTo(ALPHA_ATL * 100, 10);
    expect(metrics.ctl).toBeCloseTo(ALPHA_CTL * 100, 10);
    expect(metrics.totalLoad).toBe(100);
  });

  /**
   * The mirror case, for zones ahead of UTC: there, local midnight falls on the
   * *previous* UTC day, so the whole grid shifted back one day and the most
   * recent day of training was dropped from the averages.
   */
  it('counts a load on the target day when asked early in the UTC day', async () => {
    const metrics = await metricsAt(
      [{ date: '2026-03-01', value: 100 }],
      new Date('2026-03-01T01:00:00.000Z'),
    );

    expect(metrics.atl).toBeCloseTo(ALPHA_ATL * 100, 10);
    expect(metrics.totalLoad).toBe(100);
  });
});
