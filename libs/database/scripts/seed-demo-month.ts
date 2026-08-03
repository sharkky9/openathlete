import "dotenv/config";
import * as argon2 from "argon2";
import { prisma } from "../client";

type Sport =
  | "RUNNING"
  | "CYCLING"
  | "SWIMMING"
  | "TRAIL_RUNNING"
  | "HIKING"
  | "STRENGTH"
  | "YOGA"
  | "CROSSFIT"
  | "ROCK_CLIMBING"
  | "OTHER";

const DEMO_EMAIL = process.env.DEMO_EMAIL ?? "demo@openathlete.local";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "demo-openathlete-2025";
const DEMO_FIRST_NAME = "Demo";
const DEMO_LAST_NAME = "Athlete";

// Month to seed, parameterised via env (fork change; upstream hard-codes 2025-09).
// Defaults to the current UTC month so the demo calendar always has "this month".
const NOW = new Date();
const YEAR = Number(process.env.SEED_YEAR ?? NOW.getUTCFullYear());
const MONTH = Number(process.env.SEED_MONTH ?? NOW.getUTCMonth() + 1); // 1..12

// Mirror the password hashing used by the API auth module
// (apps/api/src/modules/auth/services/user.service.ts#hashPassword): argon2 with
// HASH_PEPPER passed as `secret`. Kept identical so the seeded demo user
// authenticates through the exact same verification path as a real signup.
const HASH_PEPPER = process.env.HASH_PEPPER
  ? Buffer.from(process.env.HASH_PEPPER)
  : undefined;

async function hashPassword(plainPassword: string) {
  return argon2.hash(plainPassword, { secret: HASH_PEPPER });
}

function toDate(y: number, m1to12: number, d: number, hours = 7, minutes = 0) {
  // m1to12 is 1..12; JS Date expects 0..11
  return new Date(Date.UTC(y, m1to12 - 1, d, hours, minutes, 0));
}

function randomFloat(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function randomInt(min: number, max: number) {
  return Math.floor(randomFloat(min, max + 1));
}

function pickOne<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function kmToMeters(km: number) {
  return km * 1000;
}

function paceToSpeedMps(minutesPerKm: number) {
  const totalSeconds = minutesPerKm * 60;
  return 1000 / totalSeconds;
}

async function upsertDemoUserAndAthlete() {
  const hashedPassword = await hashPassword(DEMO_PASSWORD);
  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {
      firstName: DEMO_FIRST_NAME,
      lastName: DEMO_LAST_NAME,
      // reset the password on every seed so the demo user stays loginable
      password: hashedPassword,
      // ensure the demo user is also a coach
      roles: { set: ["ATHLETE", "COACH"] },
      // skip onboarding so login lands on the seeded calendar, not the wizard
      onboardingCompleted: true,
    },
    create: {
      email: DEMO_EMAIL,
      password: hashedPassword,
      roles: ["ATHLETE", "COACH"],
      firstName: DEMO_FIRST_NAME,
      lastName: DEMO_LAST_NAME,
      onboardingCompleted: true,
    },
  });

  const athlete = await prisma.athlete.upsert({
    where: { userId: user.userId },
    update: {},
    create: { userId: user.userId },
  });

  return { user, athlete };
}

async function clearExistingMonth(
  athleteId: number,
  year: number,
  month1to12: number
) {
  const monthStart = toDate(year, month1to12, 1, 0, 0);
  const monthEnd = toDate(
    year,
    month1to12,
    new Date(Date.UTC(year, month1to12, 0)).getUTCDate(),
    23,
    59
  );

  const events = await prisma.event.findMany({
    where: {
      athleteId: athleteId,
      startDate: { gte: monthStart, lte: monthEnd },
    },
    select: { eventId: true },
  });

  if (events.length === 0) return;

  const eventIds = events.map((e) => e.eventId);

  await prisma.eventActivity.deleteMany({
    where: { eventId: { in: eventIds } },
  });
  await prisma.eventTraining.deleteMany({
    where: { eventId: { in: eventIds } },
  });
  await prisma.eventCompetition.deleteMany({
    where: { eventId: { in: eventIds } },
  });
  await prisma.eventNote.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.event.deleteMany({ where: { eventId: { in: eventIds } } });
}

function buildTrainingName(sport: Sport) {
  const templates: Record<Sport, string[]> = {
    RUNNING: ["Easy Run", "Intervals", "Tempo Run", "Long Run", "Recovery Run"],
    TRAIL_RUNNING: [
      "Trail Endurance",
      "Hill Repeats",
      "Technical Trail",
      "Vertical Session",
    ],
    CYCLING: [
      "Endurance Ride",
      "Sweet Spot",
      "VO2 Max",
      "Recovery Spin",
      "Long Ride",
    ],
    SWIMMING: [
      "Endurance Swim",
      "Intervals Swim",
      "Technique Drills",
      "Open Water Style",
    ],
    HIKING: ["Hiking Session", "Steep Hiking", "Endurance Hike"],
    STRENGTH: ["Full Body Strength", "Lower Body Strength", "Core & Mobility"],
    YOGA: ["Yoga Flow", "Mobility & Stretch"],
    CROSSFIT: ["Cross-Training WOD"],
    ROCK_CLIMBING: ["Climbing Session"],
    OTHER: ["General Conditioning"],
  };
  return pickOne(templates[sport]);
}

function pickTrainingSport(dayOfWeek: number): Sport {
  // Emphasize running and cycling, sprinkle cross-training
  const weekday = dayOfWeek; // 0..6 Sun..Sat
  if (weekday === 1 || weekday === 3) return "RUNNING"; // Mon/Wed quality
  if (weekday === 2) return "CYCLING"; // Tue
  if (weekday === 5) return pickOne(["RUNNING", "TRAIL_RUNNING"]); // Fri
  if (weekday === 6) return "LONG"; // placeholder; handled below
  if (weekday === 0) return pickOne(["YOGA", "STRENGTH"]); // Sun light
  return pickOne(["RUNNING", "CYCLING", "STRENGTH"]);
}

function buildPlannedTrainingForDay(date: Date) {
  const dow = date.getUTCDay();
  let sport: Sport = pickTrainingSport(dow);
  if (sport === "LONG") sport = pickOne(["RUNNING", "CYCLING"]);
  const name = buildTrainingName(sport);

  // Goal targets by sport
  let goalDistanceMeters: number | null = null;
  let goalDurationSec: number | null = null;
  let goalElevationGain: number | null = null;

  switch (sport) {
    case "RUNNING": {
      const isLong = dow === 6; // Saturday
      const km = isLong ? randomInt(18, 28) : randomInt(6, 14);
      goalDistanceMeters = kmToMeters(km);
      goalDurationSec = Math.round(km * 5.2 * 60); // ~5:12/km average plan
      goalElevationGain = randomInt(50, isLong ? 400 : 150);
      break;
    }
    case "TRAIL_RUNNING": {
      const km = randomInt(10, 20);
      goalDistanceMeters = kmToMeters(km);
      goalDurationSec = Math.round(km * 6.5 * 60);
      goalElevationGain = randomInt(300, 900);
      break;
    }
    case "CYCLING": {
      const km = randomInt(30, 90);
      goalDistanceMeters = kmToMeters(km);
      goalDurationSec = Math.round((km / 28) * 3600); // ~28 km/h
      goalElevationGain = randomInt(200, 1200);
      break;
    }
    case "SWIMMING": {
      const m = randomInt(1200, 3000);
      goalDistanceMeters = m;
      goalDurationSec = Math.round(m / 2.1); // ~2.1 m/s ~ 1:35/100
      goalElevationGain = null;
      break;
    }
    case "STRENGTH": {
      goalDistanceMeters = null;
      goalDurationSec = 45 * 60;
      goalElevationGain = null;
      break;
    }
    case "YOGA": {
      goalDistanceMeters = null;
      goalDurationSec = 35 * 60;
      goalElevationGain = null;
      break;
    }
    default: {
      goalDistanceMeters = null;
      goalDurationSec = 60 * 60;
      goalElevationGain = null;
    }
  }

  return {
    sport,
    name,
    goalDistanceMeters,
    goalDurationSec,
    goalElevationGain,
  };
}

function buildActivityFromPlan(
  plan: ReturnType<typeof buildPlannedTrainingForDay>
) {
  const { sport } = plan;
  // Slight variations between plan and activity
  if (sport === "RUNNING" || sport === "TRAIL_RUNNING") {
    const distKm = plan.goalDistanceMeters
      ? plan.goalDistanceMeters / 1000
      : randomInt(6, 12);
    const avgPace = randomFloat(4.3, sport === "TRAIL_RUNNING" ? 7.5 : 5.8);
    const movingSec = Math.round(distKm * avgPace * 60);
    const avgSpeed = 1000 / (avgPace * 60);
    const maxSpeed = avgSpeed * randomFloat(1.2, 1.4);
    return {
      distance: kmToMeters(distKm),
      elevationGain:
        sport === "TRAIL_RUNNING" ? randomInt(300, 1100) : randomInt(50, 250),
      movingTime: movingSec,
      averageSpeed: avgSpeed,
      maxSpeed: maxSpeed,
      averageCadence: randomInt(160, 182),
      averageHeartrate: randomInt(130, 164),
      maxHeartrate: randomInt(170, 190),
      sport,
    };
  }
  if (sport === "CYCLING") {
    const distKm = plan.goalDistanceMeters
      ? plan.goalDistanceMeters / 1000
      : randomInt(35, 85);
    const avgSpeed = randomFloat(7.5, 9.2); // m/s ~ 27-33 km/h
    const movingSec = Math.round((distKm * 1000) / avgSpeed);
    const maxSpeed = avgSpeed * randomFloat(1.3, 1.6);
    return {
      distance: kmToMeters(distKm),
      elevationGain: randomInt(200, 1300),
      movingTime: movingSec,
      averageSpeed: avgSpeed,
      maxSpeed: maxSpeed,
      averageCadence: randomInt(70, 92),
      averageWatts: randomInt(140, 280),
      maxWatts: randomInt(550, 900),
      weightedAverageWatts: randomInt(160, 260),
      sport,
    };
  }
  if (sport === "SWIMMING") {
    const meters = plan.goalDistanceMeters || randomInt(1500, 2800);
    const avgMps = randomFloat(1.2, 1.7);
    const movingSec = Math.round(meters / avgMps);
    return {
      distance: meters,
      elevationGain: 0,
      movingTime: movingSec,
      averageSpeed: avgMps,
      maxSpeed: avgMps * randomFloat(1.1, 1.25),
      sport,
    };
  }
  // Strength/Yoga/etc. as activities: represent short generic metrics
  const meters = randomInt(0, 1000);
  const avgMps = randomFloat(0.5, 1.5);
  const movingSec = randomInt(1800, 4200);
  return {
    distance: meters,
    elevationGain: randomInt(0, 50),
    movingTime: movingSec,
    averageSpeed: avgMps,
    maxSpeed: avgMps * randomFloat(1.1, 1.3),
    sport,
  };
}

async function createTrainingEvent(
  athleteId: number,
  date: Date,
  plan: ReturnType<typeof buildPlannedTrainingForDay>
) {
  const start = new Date(date);
  const end = new Date(date);
  end.setUTCHours(start.getUTCHours() + 2);

  const event = await prisma.event.create({
    data: {
      name: plan.name,
      type: "TRAINING",
      startDate: start,
      endDate: end,
      athleteId: athleteId,
      training: {
        create: {
          sport: plan.sport,
          description: "",
          goalDistance: plan.goalDistanceMeters ?? undefined,
          goalDuration: plan.goalDurationSec ?? undefined,
          goalElevationGain: plan.goalElevationGain ?? undefined,
          goalRpe: randomFloat(0.2, 0.8),
        },
      },
    },
    include: { training: true },
  });
  return event;
}

async function createCompetitionEvent(
  athleteId: number,
  date: Date,
  sport: Sport,
  name: string
) {
  const start = new Date(date);
  const end = new Date(date);
  end.setUTCHours(start.getUTCHours() + 6);

  const event = await prisma.event.create({
    data: {
      name,
      type: "COMPETITION",
      startDate: start,
      endDate: end,
      athleteId: athleteId,
      competition: {
        create: {
          sport,
          description: "A-race objective",
          goalDistance:
            sport === "RUNNING"
              ? kmToMeters(21.1)
              : sport === "CYCLING"
                ? kmToMeters(120)
                : null,
          goalDuration: null,
          goalElevationGain:
            sport === "TRAIL_RUNNING"
              ? randomInt(1200, 2500)
              : randomInt(100, 600),
          goalRpe: 0.9,
        },
      },
    },
    include: { competition: true },
  });
  return event;
}

async function createActivityEvent(
  athleteId: number,
  date: Date,
  plan: ReturnType<typeof buildPlannedTrainingForDay>,
  maybeLinkToTrainingEventId?: number
) {
  const start = new Date(date);
  const end = new Date(date);
  const metrics = buildActivityFromPlan(plan);

  const name = `${plan.name} • ${plan.sport}`;
  const activity = await prisma.event.create({
    data: {
      name,
      type: "ACTIVITY",
      startDate: start,
      endDate: end,
      athleteId: athleteId,
      activity: {
        create: {
          provider: "STRAVA",
          // externalId is globally unique, so scope it per athlete to avoid
          // collisions when several seeded athletes share the same calendar dates.
          externalId: `demo-${athleteId}-${start.toISOString()}`,
          description: "",
          distance: metrics.distance,
          elevationGain: metrics.elevationGain,
          movingTime: metrics.movingTime,
          averageSpeed: metrics.averageSpeed,
          maxSpeed: metrics.maxSpeed,
          averageCadence: metrics.averageCadence ?? null,
          averageHeartrate: metrics.averageHeartrate ?? null,
          maxHeartrate: metrics.maxHeartrate ?? null,
          averageWatts: metrics.averageWatts ?? null,
          maxWatts: metrics.maxWatts ?? null,
          weightedAverageWatts: metrics.weightedAverageWatts ?? null,
          sport: metrics.sport,
        },
      },
    },
    include: { activity: true },
  });

  if (maybeLinkToTrainingEventId) {
    await prisma.eventTraining.update({
      where: { eventId: maybeLinkToTrainingEventId },
      data: { relatedActivityId: activity.activity!.eventActivityId },
    });
  }

  return activity;
}

async function seedMonthForAthlete(
  athleteId: number,
  year: number,
  month1to12: number
) {
  await clearExistingMonth(athleteId, year, month1to12);

  const daysInMonth = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();

  const raceDay = 15;
  const raceSport: Sport = pickOne(["RUNNING", "TRAIL_RUNNING", "CYCLING"]);
  const race = await createCompetitionEvent(
    athleteId,
    toDate(year, month1to12, raceDay, 8, 30),
    raceSport,
    raceSport === "RUNNING"
      ? "Half Marathon"
      : raceSport === "TRAIL_RUNNING"
        ? "Trail 30K"
        : "Gran Fondo"
  );

  for (let day = 1; day <= daysInMonth; day++) {
    const date = toDate(year, month1to12, day, 7, 0);
    const dow = date.getUTCDay();

    const isRest = dow === 4 && Math.random() < 0.6;
    if (isRest) {
      await prisma.event.create({
        data: {
          name: "Rest / Recovery",
          type: "NOTE",
          startDate: date,
          endDate: new Date(date.getTime() + 60 * 60 * 1000),
          athleteId: athleteId,
          note: {
            create: {
              description: "Recovery focus: hydration, mobility, sleep",
            },
          },
        },
      });
      continue;
    }

    if (day === raceDay) {
      const plan = {
        sport: race.competition!.sport as Sport,
        name: race.name,
        goalDistanceMeters: null,
        goalDurationSec: null,
        goalElevationGain: null,
      } as const;
      await createActivityEvent(
        athleteId,
        toDate(year, month1to12, day, 8, 45),
        plan,
        undefined
      );
      continue;
    }

    const planned = buildPlannedTrainingForDay(date);
    const training = await createTrainingEvent(athleteId, date, planned);

    if (Math.random() < 0.7) {
      const linkIt = Math.random() < 0.6;
      await createActivityEvent(
        athleteId,
        toDate(year, month1to12, day, 18, 0),
        planned,
        linkIt ? training.eventId : undefined
      );
    }
  }
}

async function upsertCoachedAthlete(
  coachUserId: number,
  email: string,
  firstName: string,
  lastName: string
) {
  const hashedPassword = await hashPassword(DEMO_PASSWORD);
  const user = await prisma.user.upsert({
    where: { email },
    update: {
      firstName: firstName,
      lastName: lastName,
      password: hashedPassword,
      roles: { set: ["ATHLETE"] },
      onboardingCompleted: true,
    },
    create: {
      email,
      password: hashedPassword,
      roles: ["ATHLETE"],
      firstName: firstName,
      lastName: lastName,
      onboardingCompleted: true,
    },
  });

  const athlete = await prisma.athlete.upsert({
    where: { userId: user.userId },
    update: {},
    create: { userId: user.userId },
  });

  const existingLink = await prisma.coachAthlete.findFirst({
    where: { userId: coachUserId, athleteId: athlete.athleteId },
  });
  if (!existingLink) {
    await prisma.coachAthlete.create({
      data: { userId: coachUserId, athleteId: athlete.athleteId },
    });
  }

  return athlete;
}

async function seedAll(): Promise<boolean> {
  // This seed creates login-able accounts with a known default password, so it
  // must never run against a hosted environment. It is registered as the Prisma
  // seed hook (prisma.config.ts -> migrations.seed), so it also runs on
  // `prisma migrate dev`/`reset` (`db:migrate`/`db:reset`) — `migrate deploy`
  // (the Railway image path) never invokes it.
  //
  // Only seed when explicitly in local dev / CI: ENV is "development" or "test".
  // For any other ENV (unset, production, staging, preview, ...) skip cleanly
  // and exit 0 — throwing here would make the standard `db:migrate`/`db:reset`
  // setup command fail, since ENV is not part of libs/database's own env.
  const env = process.env.ENV;
  const allowed = new Set(["development", "test"]);
  if (env === undefined || !allowed.has(env)) {
    console.log(
      `Skipping demo seed: ENV=${env ?? "(unset)"}. ` +
        `Set ENV=development (or ENV=test) to seed the demo month.`,
    );
    return false;
  }

  const { user, athlete } = await upsertDemoUserAndAthlete();

  // Seed the demo user's month (September 2025)
  await seedMonthForAthlete(athlete.athleteId, YEAR, MONTH);

  // Create a couple of coached athletes and seed September & October 2025 for them
  const coachedSpecs = [
    { email: `coached1+${DEMO_EMAIL}`, first: "Alice", last: "Dupont" },
    { email: `coached2+${DEMO_EMAIL}`, first: "Marc", last: "Leroy" },
  ];

  for (const spec of coachedSpecs) {
    const a = await upsertCoachedAthlete(
      user.userId,
      spec.email,
      spec.first,
      spec.last
    );
    await seedMonthForAthlete(a.athleteId, YEAR, MONTH);
    await seedMonthForAthlete(a.athleteId, YEAR, MONTH + 1);
  }

  return true;
}

seedAll()
  .then((seeded) => {
    if (seeded) {
      // eslint-disable-next-line no-console
      console.log("Demo month seeded successfully");
    }
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
