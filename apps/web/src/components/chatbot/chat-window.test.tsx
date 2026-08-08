import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatWindow } from './chat-window';

/**
 * Regression cover for #37 — "Chatbot bubble POSTs /messages/threads with an
 * empty participantUserIds and gets a 400".
 *
 * Opening the bubble on an account with no threads used to fire
 * `createThread({ participantUserIds: [] })`, which the API rejects with a
 * validation error. Nothing was visibly broken, so it went unnoticed while
 * logging a 400 in error monitoring on every open.
 */

const mutate = vi.fn();
const threads = vi.fn();

vi.mock('@/api/messages', () => ({
  useCreateThreadMutation: () => ({ mutate, isPending: false }),
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

vi.mock('@/contexts/chatbot', () => ({
  useChatbot: () => ({
    isOpen: true,
    closeChat: vi.fn(),
    chatWidth: 400,
    setChatWidth: vi.fn(),
    chatSide: 'right',
    setChatSide: vi.fn(),
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/components/messages/message-messages', () => ({
  MessageMessages: () => <div />,
}));

vi.mock('./chat-input', () => ({
  ChatInput: () => <div />,
}));

describe('ChatWindow', () => {
  beforeEach(() => {
    mutate.mockReset();
    threads.mockReturnValue([]);
  });

  it('does not create a thread when opened with none', async () => {
    render(<ChatWindow />);

    await waitFor(() =>
      expect(
        screen.getByText('Select or create a conversation'),
      ).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows the empty state and leaves creation to the + button', async () => {
    render(<ChatWindow />);

    expect(
      await screen.findByText('Select or create a conversation'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'New conversation' }),
    ).toBeEnabled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
