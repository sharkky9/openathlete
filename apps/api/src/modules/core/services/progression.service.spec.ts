import { AuthUser } from 'src/modules/auth/decorators/user.decorator';
import { CaslAbilityFactory } from 'src/modules/auth/services/casl-ability.factory';
import { PrismaService } from 'src/modules/prisma/services/prisma.service';

import { ProgressionService } from './progression.service';

describe(`ProgressionService local periods (process TZ=${process.env.TZ ?? 'system'})`, () => {
  it('keeps a Sunday-evening Pacific activity in the preceding ISO week', async () => {
    const findMany = jest.fn(async () => [
      {
        eventId: 1,
        startDate: new Date('2026-08-10T02:00:00Z'), // Sunday 19:00 PDT
        activity: {
          distance: 10_000,
          elevationGain: 100,
          averageSpeed: 3,
          averageGapSpeed: 3,
          averageHeartrate: 150,
          averageCadence: 170,
        },
      },
    ]);
    const prisma = {
      athlete: {
        findUnique: jest.fn(async () => ({
          timezone: 'America/Los_Angeles',
        })),
      },
      event: { findMany },
    };
    const abilities = {
      getFor: jest.fn(async () => ({ can: () => true })),
    };
    const service = new ProgressionService(
      prisma as unknown as PrismaService,
      abilities as unknown as CaslAbilityFactory,
    );

    const result = await service.getProgressionData(
      { userId: 1 } as AuthUser,
      42,
      new Date('2026-08-01T07:00:00Z'),
      new Date('2026-08-15T06:59:59.999Z'),
    );

    expect(result.data).toHaveLength(1);
    expect(result.data[0].period).toBe('2026-08-03T00:00:00.000Z');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          startDate: {
            gte: new Date('2026-08-01T07:00:00Z'),
            lt: new Date('2026-08-15T07:00:00Z'),
          },
        }),
      }),
    );
  });
});
