import { Injectable } from '@nestjs/common';

import { EventType } from '@openathlete/database';
import {
  CoachDashboardAthleteRowDto,
  CoachDashboardResponseDto,
  coachDashboardResponseSchema,
} from '@openathlete/shared';

import {
  addDaysAnchor,
  dayRangeInstants,
  normalizeTimeZone,
  toDayAnchor,
} from 'src/common/utils/day-anchor';
import { AuthUser } from 'src/modules/auth/decorators/user.decorator';
import { PrismaService } from 'src/modules/prisma/services/prisma.service';

@Injectable()
export class CoachService {
  constructor(private readonly prisma: PrismaService) {}

  private defaultPeriod(timeZone: string): { start: Date; end: Date } {
    const today = toDayAnchor(new Date(), timeZone);
    const start = dayRangeInstants(addDaysAnchor(today, -28), timeZone).start;
    const endExclusive = dayRangeInstants(today, timeZone).endExclusive;
    return { start, end: new Date(endExclusive.getTime() - 1) };
  }

  async getCoachDashboard(
    user: AuthUser,
    period?: { start?: Date; end?: Date },
  ): Promise<CoachDashboardResponseDto> {
    // Get coached athletes first: their timezone defines calendar-day defaults.
    // This deployment has one athlete; UTC remains the safe empty-list fallback.
    const coachedAthletes = await this.prisma.athlete.findMany({
      where: { coachAthletes: { some: { userId: user.userId } } },
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    const timeZone = normalizeTimeZone(coachedAthletes[0]?.timezone);
    const { start, end } = (() => {
      if (period?.start && period?.end)
        return { start: period.start, end: period.end };
      return this.defaultPeriod(timeZone);
    })();

    const athleteIds = coachedAthletes.map((a) => a.athleteId);
    if (athleteIds.length === 0) {
      return coachDashboardResponseSchema.parse({
        period: { start: start.toISOString(), end: end.toISOString() },
        athletes: [],
      });
    }

    // Planned training sessions within period
    const plannedByAthlete = await this.prisma.event.groupBy({
      by: ['athleteId'],
      where: {
        athleteId: { in: athleteIds },
        type: EventType.TRAINING,
        startDate: { gte: start, lte: end },
      },
      _count: { _all: true },
    });

    // Planned time: sum of workout estimated_duration when available
    const plannedTimeByAthleteRaw = await this.prisma.event.findMany({
      where: {
        athleteId: { in: athleteIds },
        type: EventType.TRAINING,
        startDate: { gte: start, lte: end },
      },
      select: {
        athleteId: true,
        training: {
          select: {
            goalDuration: true,
          },
        },
      },
    });

    const plannedTimeByAthlete = plannedTimeByAthleteRaw.reduce(
      (acc, e) => {
        const aid = e.athleteId as number;
        const duration = e.training?.goalDuration ?? 0;
        acc[aid] = (acc[aid] || 0) + duration;
        return acc;
      },
      {} as Record<number, number>,
    );

    // Completed activity events within period with activity details
    const activities = await this.prisma.event.findMany({
      where: {
        athleteId: { in: athleteIds },
        type: EventType.ACTIVITY,
        startDate: { gte: start, lte: end },
      },
      select: {
        athleteId: true,
        startDate: true,
        endDate: true,
        activity: { select: { distance: true } },
      },
    });

    const completedByAthlete: Record<
      number,
      { count: number; time: number; distance: number; lastAt: string | null }
    > = {};
    for (const ev of activities) {
      const aid = ev.athleteId as number;
      const startTs = new Date(ev.startDate).getTime();
      const endTs = new Date(ev.endDate).getTime();
      const time = Math.max(0, Math.floor((endTs - startTs) / 1000));
      const distance = ev.activity?.distance ?? 0;
      const iso = new Date(ev.endDate).toISOString();
      if (!completedByAthlete[aid]) {
        completedByAthlete[aid] = {
          count: 0,
          time: 0,
          distance: 0,
          lastAt: null,
        };
      }
      completedByAthlete[aid].count += 1;
      completedByAthlete[aid].time += time;
      completedByAthlete[aid].distance += distance;
      const prev = completedByAthlete[aid].lastAt;
      completedByAthlete[aid].lastAt = !prev || iso > prev ? iso : prev;
    }

    // Build rows
    const rows: CoachDashboardAthleteRowDto[] = coachedAthletes.map((a) => {
      const plannedCount =
        plannedByAthlete.find((p) => p.athleteId === a.athleteId)?._count
          ._all || 0;
      const plannedTime = plannedTimeByAthlete[a.athleteId] || 0;
      const completed = completedByAthlete[a.athleteId] || {
        count: 0,
        time: 0,
        distance: 0,
        lastAt: null,
      };
      const compliance =
        plannedCount > 0
          ? Math.round((completed.count / plannedCount) * 100)
          : 0;
      return {
        athleteId: a.athleteId,
        firstName: a.user?.firstName ?? null,
        lastName: a.user?.lastName ?? null,
        email: a.user?.email ?? null,
        start: start.toISOString(),
        end: end.toISOString(),
        plannedSessions: plannedCount,
        completedSessions: completed.count,
        plannedTime: plannedTime,
        completedTime: completed.time,
        completedDistance: completed.distance,
        lastActivityAt: completed.lastAt,
        compliancePercent: compliance,
      };
    });

    return coachDashboardResponseSchema.parse({
      period: { start: start.toISOString(), end: end.toISOString() },
      athletes: rows,
    });
  }
}
