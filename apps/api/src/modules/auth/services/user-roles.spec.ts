import { BadRequestException } from '@nestjs/common';

import { updateAccountDtoSchema } from '@openathlete/shared';

import { AuthUser } from '../decorators/user.decorator';
import { UserService } from './user.service';

/**
 * Regression cover for #35 — "Settings: no way to change roles after
 * onboarding".
 *
 * `completeOnboarding` used to be the only writer of `roles`, so an account that
 * picked "I'm an athlete" was athlete-only forever. `updateAccount` now accepts
 * a `roles` array, and these tests pin the three rules that make that safe:
 *
 *  1. the submitted array is authoritative — roles are removed as well as added;
 *  2. an empty array is rejected (the web shell assumes at least one role);
 *  3. COACH cannot be dropped while `CoachAthlete` rows still point at the user.
 *
 * `UserService` is constructed directly rather than through a Nest testing
 * module: the constructor only reads HASH_PEPPER off the config service, and
 * this code path touches nothing but Prisma, so stubbing the two collaborators
 * it uses keeps the test on the rule under test.
 */

const USER = { userId: 1 } as AuthUser;

type UpdateArgs = {
  where: { userId: number };
  data: { roles?: string[] };
  select: Record<string, boolean>;
};

function buildService({ coachedAthleteCount = 0 } = {}) {
  const update = jest.fn(async (_: UpdateArgs) => ({
    firstName: 'Jane',
    lastName: 'Smith',
    gender: 'FEMALE',
    roles: ['ATHLETE'],
  }));
  const count = jest.fn(async (_: { where: { userId: number } }) =>
    Promise.resolve(coachedAthleteCount),
  );

  const prisma = {
    user: { update },
    coachAthlete: { count },
  };

  // `updateAccount` is an arrow-function instance property, so it only exists
  // once the constructor has run — `Object.create(prototype)` is not enough.
  // The constructor itself only reads HASH_PEPPER off the config service; the
  // remaining collaborators are unused on this path.
  const configService = { get: () => undefined };
  const unused = {} as never;

  const service = new UserService(
    prisma as never,
    configService as never,
    unused,
    unused,
    unused,
    unused,
  );

  return { service, update, count };
}

describe('updateAccountDtoSchema roles field', () => {
  it('accepts a payload with no roles at all (roles left untouched)', () => {
    const parsed = updateAccountDtoSchema.parse({ firstName: 'Jane' });

    expect(parsed.roles).toBeUndefined();
  });

  it('accepts both roles', () => {
    const parsed = updateAccountDtoSchema.parse({
      roles: ['ATHLETE', 'COACH'],
    });

    expect(parsed.roles).toEqual(['ATHLETE', 'COACH']);
  });

  it('rejects an empty roles array', () => {
    // SpaceProvider and the sidebar space switcher assume every account has at
    // least one role, so an account must never be able to clear them.
    expect(updateAccountDtoSchema.safeParse({ roles: [] }).success).toBe(false);
  });

  it('rejects a role outside the enum', () => {
    expect(updateAccountDtoSchema.safeParse({ roles: ['ADMIN'] }).success).toBe(
      false,
    );
  });
});

describe('UserService.updateAccount roles handling', () => {
  it('leaves roles alone when the field is absent', async () => {
    const { service, update, count } = buildService();

    await service.updateAccount(USER, { firstName: 'Jane' });

    expect(update.mock.calls[0][0].data.roles).toBeUndefined();
    // No point querying coached athletes when roles are not changing.
    expect(count).not.toHaveBeenCalled();
  });

  it('writes the submitted array verbatim, so roles are removed as well as added', async () => {
    const { service, update } = buildService();

    await service.updateAccount(USER, { roles: ['COACH'] });

    // Not a merge with the existing roles: ATHLETE is gone.
    expect(update.mock.calls[0][0].data.roles).toEqual(['COACH']);
  });

  it('returns roles so the caller can refresh its cached user', async () => {
    const { service, update } = buildService();

    await service.updateAccount(USER, { roles: ['ATHLETE', 'COACH'] });

    expect(update.mock.calls[0][0].select.roles).toBe(true);
  });

  it('allows dropping COACH when the user coaches nobody', async () => {
    const { service, update, count } = buildService({ coachedAthleteCount: 0 });

    await service.updateAccount(USER, { roles: ['ATHLETE'] });

    expect(count).toHaveBeenCalledWith({ where: { userId: USER.userId } });
    expect(update.mock.calls[0][0].data.roles).toEqual(['ATHLETE']);
  });

  it('refuses to drop COACH while the user still coaches athletes', async () => {
    const { service, update } = buildService({ coachedAthleteCount: 3 });

    await expect(
      service.updateAccount(USER, { roles: ['ATHLETE'] }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The write must not happen: leaving CoachAthlete rows pointing at a
    // non-coach would hide the coaching UI while CASL still grants access.
    expect(update).not.toHaveBeenCalled();
  });

  it('does not check coached athletes when COACH is being kept', async () => {
    const { service, count } = buildService({ coachedAthleteCount: 3 });

    await service.updateAccount(USER, { roles: ['ATHLETE', 'COACH'] });

    expect(count).not.toHaveBeenCalled();
  });
});
