import { SEOPlanData } from '@openathlete/shared';

import { AuthUser } from 'src/modules/auth/decorators/user.decorator';
import { PrismaService } from 'src/modules/prisma/services/prisma.service';

import { TrainingPlanService } from './training-plan.service';

describe(`TrainingPlanService local scheduling (process TZ=${process.env.TZ ?? 'system'})`, () => {
  it('keeps 09:00 sessions at 09:00 athlete-local time across DST', async () => {
    const eventStarts: Date[] = [];
    const prisma = {
      athlete: {
        findUnique: jest.fn(async () => ({
          timezone: 'America/Los_Angeles',
        })),
      },
      trainingPlan: {
        create: jest.fn(async () => ({ trainingPlanId: 10 })),
        findUnique: jest.fn(async () => ({ trainingPlanId: 10 })),
      },
      cycle: { create: jest.fn(async () => ({ cycleId: 20 })) },
      trainingWeek: {
        create: jest.fn(async ({ data }: { data: { weekNumber: number } }) => ({
          trainingWeekId: data.weekNumber,
        })),
      },
      event: {
        create: jest.fn(async ({ data }: { data: { startDate: Date } }) => {
          eventStarts.push(data.startDate);
          return { eventId: eventStarts.length, training: null };
        }),
      },
      workout: { create: jest.fn() },
    };
    const service = new TrainingPlanService(prisma as unknown as PrismaService);
    const plan = {
      plan: {
        name: 'DST plan',
        description: '',
        goal: 'Consistency',
        duration: 2,
      },
      cycles: [
        {
          name: 'Base',
          description: '',
          phase: 'BASE',
          weeks: [
            {
              weekNumber: 1,
              theme: '',
              sessions: [
                {
                  dayOfWeek: 1,
                  name: 'Monday one',
                  sport: 'RUNNING',
                  description: '',
                },
              ],
            },
            {
              weekNumber: 2,
              theme: '',
              sessions: [
                {
                  dayOfWeek: 1,
                  name: 'Monday two',
                  sport: 'RUNNING',
                  description: '',
                },
              ],
            },
          ],
        },
      ],
    } as unknown as SEOPlanData;

    await service.importSeoPlan(
      { athlete: { athleteId: 42 } } as AuthUser,
      plan,
      new Date('2026-03-02T08:00:00Z'),
    );

    expect(eventStarts.map((date) => date.toISOString())).toEqual([
      '2026-03-02T17:00:00.000Z', // 09:00 PST
      '2026-03-09T16:00:00.000Z', // 09:00 PDT
    ]);
  });
});
