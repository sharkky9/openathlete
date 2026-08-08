import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MessagesPage } from './index';

/**
 * Regression cover for #39 — "Messages: user with no coach/athlete link can
 * never create a conversation".
 *
 * The page used to auto-fire `createThread` with `participantUserIds: []` from
 * a `useEffect` guarded only by `threads.length === 0 && !isLoading &&
 * !isPending`. The API rejects that payload outright, so the guard re-armed as
 * soon as the failed request settled and the page sat in a 400 loop. Nothing
 * may create a thread without the user asking for one.
 */

const mutate = vi.fn();
const threads = vi.fn();

vi.mock('@/api/messages', () => ({
  useCreateThreadMutation: () => ({ mutate, isPending: false }),
  useDeleteThreadMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useGetUserThreadsQuery: () => ({ data: threads(), isLoading: false }),
  useMessagesWebSocket: () => ({ sendMessage: vi.fn() }),
}));

vi.mock('@/api/user', () => ({
  useGetMeQuery: () => ({ data: { userId: 1 } }),
}));

vi.mock('@/api/athlete', () => ({
  useGetMyCoachesQuery: () => ({ data: [] }),
  useGetMyCoachedAthletesQuery: () => ({ data: [] }),
}));

vi.mock('posthog-js/react', () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

vi.mock('@/components/messages/message-messages', () => ({
  MessageMessages: () => <div />,
}));

vi.mock('@/components/chatbot/chat-input', () => ({
  ChatInput: () => <div />,
}));

vi.mock('@/hooks/use-page-actions', () => ({
  useSetPageActions: () => {},
}));

describe('MessagesPage empty state', () => {
  beforeEach(() => {
    mutate.mockReset();
  });

  it('does not create a thread when the user has none', async () => {
    threads.mockReturnValue([]);

    render(<MessagesPage />);

    // Give any effect a chance to fire before asserting it did not.
    await waitFor(() =>
      expect(screen.getByText(/0 conversations/i)).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it('offers the empty state instead of a silently failing request', async () => {
    threads.mockReturnValue([]);

    render(<MessagesPage />);

    expect(
      await screen.findByText('Select or create a conversation'),
    ).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('still does not create a thread once threads exist', async () => {
    threads.mockReturnValue([
      { messageThreadId: 5, title: 'Sam Rider', createdAt: '2026-03-01' },
    ]);

    render(<MessagesPage />);

    await waitFor(() =>
      expect(screen.getByText(/1 conversation/i)).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
  });
});
