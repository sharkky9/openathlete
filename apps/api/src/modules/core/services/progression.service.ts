import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  Athlete,
  Event,
  EventActivity,
  EventType,
  Prisma,
  SportType,
} from '@openathlete/database';
import { GetProgressionDataResponseDto } from '@openathlete/shared';

import {
  dayRangeInstants,
  normalizeTimeZone,
  startOfMonthAnchor,
  startOfWeekAnchor,
  toDayAnchor,
} from 'src/common/utils/day-anchor';
import { AuthUser } from 'src/modules/auth/decorators/user.decorator';
import { CaslAbilityFactory } from 'src/modules/auth/services/casl-ability.factory';
import { PrismaService } from 'src/modules/prisma/services/prisma.service';

@Injectable()
export class ProgressionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly abilities: CaslAbilityFactory,
  ) {}

  async getFirstActivityDate(
    user: AuthUser,
    athleteId: Athlete['athleteId'],
    sport?: SportType,
  ): Promise<Date | null> {
    const ability = await this.abilities.getFor({ user });
    if (!ability.can('read', 'Athlete')) {
      throw new ForbiddenException('Not allowed to access this athlete');
    }

    const whereClause: Prisma.EventWhereInput = {
      athleteId: athleteId,
      type: EventType.ACTIVITY,
      activity: {
        isNot: null,
      },
    };

    if (sport) {
      whereClause.activity = {
        isNot: null,
        is: {
          sport,
        },
      };
    }

    const firstEvent = await this.prisma.event.findFirst({
      where: whereClause,
      orderBy: {
        startDate: 'asc',
      },
      select: {
        startDate: true,
      },
    });

    return firstEvent?.startDate ? new Date(firstEvent.startDate) : null;
  }

  async getProgressionData(
    user: AuthUser,
    athleteId: Athlete['athleteId'],
    startDate: Date,
    endDate: Date,
    sport?: SportType,
  ): Promise<GetProgressionDataResponseDto> {
    const ability = await this.abilities.getFor({ user });
    if (!ability.can('read', 'Athlete')) {
      throw new ForbiddenException('Not allowed to access this athlete');
    }

    const athlete = await this.prisma.athlete.findUnique({
      where: { athleteId },
      select: { timezone: true },
    });
    if (!athlete) {
      throw new NotFoundException('Athlete not found');
    }

    const timeZone = normalizeTimeZone(athlete.timezone);
    const startAnchor = toDayAnchor(startDate, timeZone);
    const endAnchor = toDayAnchor(endDate, timeZone);
    const rangeStart = dayRangeInstants(startAnchor, timeZone).start;
    const rangeEnd = dayRangeInstants(endAnchor, timeZone).endExclusive;
    const daysDiff = Math.ceil(
      (endAnchor.getTime() - startAnchor.getTime()) / (1000 * 60 * 60 * 24),
    );
    const aggregationType: 'week' | 'month' =
      daysDiff <= 120 ? 'week' : 'month';

    // Build where clause
    const whereClause: Prisma.EventWhereInput = {
      athleteId: athleteId,
      type: EventType.ACTIVITY,
      startDate: {
        gte: rangeStart,
        lt: rangeEnd,
      },
      activity: {
        isNot: null,
      },
    };

    // Filter by sport if provided
    if (sport) {
      whereClause.activity = {
        isNot: null,
        is: {
          sport,
        },
      };
    }

    // Fetch all activities in the period
    const events = await this.prisma.event.findMany({
      where: whereClause,
      include: {
        activity: true,
      },
      orderBy: {
        startDate: 'asc',
      },
    });

    // Filter to only events with activities
    const activities = events.filter(
      (e): e is Event & { activity: EventActivity } => e.activity !== null,
    );

    if (activities.length === 0) {
      return {
        data: [],
        aggregationType,
      };
    }

    // Group activities by period
    const grouped = new Map<string, typeof activities>();

    activities.forEach((event) => {
      const eventDay = toDayAnchor(event.startDate, timeZone);
      let periodKey: string;

      if (aggregationType === 'week') {
        periodKey = startOfWeekAnchor(eventDay).toISOString();
      } else {
        periodKey = startOfMonthAnchor(eventDay).toISOString();
      }

      if (!grouped.has(periodKey)) {
        grouped.set(periodKey, []);
      }
      grouped.get(periodKey)!.push(event);
    });

    // Calculate metrics for each period
    const data = Array.from(grouped.entries())
      .map(([period, periodActivities]) => {
        const totalDistance = periodActivities.reduce(
          (sum, e) => sum + (e.activity.distance || 0),
          0,
        );
        const totalElevationGain = periodActivities.reduce(
          (sum, e) => sum + (e.activity.elevationGain || 0),
          0,
        );
        const activityCount = periodActivities.length;

        // Calculate averages
        const speeds = periodActivities
          .map((e) => e.activity.averageSpeed)
          .filter((s): s is number => s !== null && s !== undefined);
        const averageSpeed =
          speeds.length > 0
            ? speeds.reduce((sum, s) => sum + s, 0) / speeds.length
            : 0;

        const gapSpeeds = periodActivities
          .map((e) => e.activity.averageGapSpeed)
          .filter((g): g is number => g !== null && g !== undefined);
        const averageGapSpeed =
          gapSpeeds.length > 0
            ? gapSpeeds.reduce((sum, g) => sum + g, 0) / gapSpeeds.length
            : null;

        const heartrates = periodActivities
          .map((e) => e.activity.averageHeartrate)
          .filter((h): h is number => h !== null && h !== undefined);
        const averageHeartrate =
          heartrates.length > 0
            ? heartrates.reduce((sum, h) => sum + h, 0) / heartrates.length
            : null;

        const cadences = periodActivities
          .map((e) => e.activity.averageCadence)
          .filter((c): c is number => c !== null && c !== undefined);
        const averageCadence =
          cadences.length > 0
            ? cadences.reduce((sum, c) => sum + c, 0) / cadences.length
            : null;

        // Calculate efficiency: gap / hr average (if both available)
        const efficiency =
          averageHeartrate !== null &&
          averageGapSpeed !== null &&
          averageHeartrate > 0
            ? averageGapSpeed / averageHeartrate
            : null;

        return {
          period,
          totalDistance,
          averageDistancePerActivity:
            activityCount > 0 ? totalDistance / activityCount : 0,
          averageSpeed,
          averageGapSpeed,
          efficiency,
          totalElevationGain,
          averageElevationGainPerActivity:
            activityCount > 0 ? totalElevationGain / activityCount : 0,
          averageHeartrate,
          averageCadence,
          activityCount,
        };
      })
      .sort(
        (a, b) => new Date(a.period).getTime() - new Date(b.period).getTime(),
      );

    return {
      data,
      aggregationType,
    };
  }
}
