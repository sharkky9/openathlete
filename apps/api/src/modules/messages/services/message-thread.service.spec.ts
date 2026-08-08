import { BadRequestException } from '@nestjs/common';

import { createMessageThreadDtoSchema } from '@openathlete/shared';

import { AuthUser } from 'src/modules/auth/decorators/user.decorator';

import { MessageThreadService } from './message-thread.service';

/**
 * Pins the server side of #37 / #39 — the web app used to auto-fire
 * `POST /messages/threads` with `participantUserIds: []` on every empty
 * Messages page and every open of the chatbot bubble, and the request could
 * never succeed. The client no longer does that; these tests record why an
 * empty list is not something the server should start accepting instead, and
 * that a user alone in a thread is the smallest payload that does work — which
 * is what the New conversation dialog now sends for an account with no coach
 * or athlete links.
 */

const USER = { userId: 7 } as AuthUser;

type CreateArgs = {
  data: {
    title?: string;
    participants: { create: { userId: number }[] };
  };
};

function buildService() {
  const create = jest.fn(async (_: CreateArgs) => ({
    messageThreadId: 1,
  }));
  const findMany = jest.fn(async () => [
    { userId: 7, firstName: 'Sam', lastName: 'Rider' },
  ]);

  const prisma = {
    messageThread: { create },
    user: { findMany },
  };

  const service = new MessageThreadService(prisma as never);

  return { service, create };
}

describe('createMessageThreadDtoSchema', () => {
  it('rejects an empty participant list', () => {
    // The exact payload the old auto-create effect sent. Validation rejects it
    // before the service is even reached, which is why the loop showed up as a
    // stream of 400s rather than a server error.
    const result = createMessageThreadDtoSchema.safeParse({
      participantUserIds: [],
    });

    expect(result.success).toBe(false);
  });

  it('accepts a single participant', () => {
    const result = createMessageThreadDtoSchema.safeParse({
      participantUserIds: [7],
    });

    expect(result.success).toBe(true);
  });
});

describe('MessageThreadService.createThread', () => {
  it('rejects a thread the caller is not part of', async () => {
    const { service, create } = buildService();

    await expect(
      service.createThread(USER, { participantUserIds: [99] }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(create).not.toHaveBeenCalled();
  });

  it('accepts a thread containing only the caller', async () => {
    // A user with no coach and no coached athletes has nobody to add. Creating
    // a thread they are alone in is what the New conversation dialog falls back
    // to, so this has to keep working.
    const { service, create } = buildService();

    await service.createThread(USER, { participantUserIds: [USER.userId] });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.participants.create).toEqual([
      { userId: USER.userId },
    ]);
  });

  it('derives a title from the participants when none is given', async () => {
    // The old auto-create sent a hardcoded English `title: 'New Thread'`, which
    // reached the database untranslated. With no title the server names the
    // thread after its participants instead.
    const { service, create } = buildService();

    await service.createThread(USER, { participantUserIds: [USER.userId] });

    expect(create.mock.calls[0][0].data.title).toBe('Sam Rider');
  });
});
