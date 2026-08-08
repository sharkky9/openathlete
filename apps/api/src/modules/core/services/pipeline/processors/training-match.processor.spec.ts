import { PrismaService } from 'src/modules/prisma/services/prisma.service';

import { TrainingMatchProcessor } from './training-match.processor';

describe(`TrainingMatchProcessor local day window (process TZ=${process.env.TZ ?? 'system'})`, () => {
  it('queries the complete 23-hour Pacific spring-forward day', async () => {
    const findMany = jest.fn(async () => []);
    const prisma = {
      eventActivity: {
        findUnique: jest.fn(async () => ({
          eventActivityId: 1,
          sport: 'CYCLING',
          distance: 20_000,
          movingTime: 3600,
          relatedTraining: null,
          event: {
            eventId: 2,
            athleteId: 42,
            startDate: new Date('2026-03-09T06:30:00Z'), // 23:30 PDT Mar 8
            endDate: new Date('2026-03-09T07:30:00Z'),
            athlete: { timezone: 'America/Los_Angeles' },
          },
        })),
      },
      eventTraining: { findMany },
    };
    const processor = new TrainingMatchProcessor(
      prisma as unknown as PrismaService,
    );

    await processor.run({ eventActivityId: 1, eventId: 2 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          event: {
            athleteId: 42,
            startDate: {
              gte: new Date('2026-03-08T08:00:00Z'),
              lt: new Date('2026-03-09T07:00:00Z'),
            },
          },
        }),
      }),
    );
  });
});
