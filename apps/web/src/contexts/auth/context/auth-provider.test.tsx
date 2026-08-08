import { queryClient } from '@/utils/query-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthContext } from '../hooks';
import { AuthProvider } from './auth-provider';

/**
 * Regression cover for #36 — "New signup skips onboarding: stale cached
 * GET /user/me survives logout".
 *
 * The `QueryClient` lives at module scope and logging out from the sidebar is a
 * client-side navigation, so nothing tears it down. Every query key in
 * `src/api` is a static string with no user identity in it, so
 * the next account signed in to the same tab was served the previous account's
 * `UserAPI.getMe` for the 5-minute staleTime — and `AuthGuard` decides from that
 * value whether to route a brand-new signup to onboarding.
 */

const getMe = vi.fn();

vi.mock('@/api/user', () => ({
  UserAPI: {
    getMe: () => getMe(),
    updateLanguage: vi.fn(),
  },
}));

vi.mock('posthog-js', () => ({
  default: {
    capture: vi.fn(),
    reset: vi.fn(),
    identify: vi.fn(),
  },
}));

vi.mock('@/utils/firebase-auth', () => ({
  signOutFirebase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/utils/push-notifications', () => ({
  initializePushNotifications: vi.fn().mockResolvedValue(undefined),
  sendPendingTokenIfAny: vi.fn(),
}));

vi.mock('@/utils/local-storage', () => ({
  ACCESS_TOKEN: 'accessToken',
  clear: vi.fn(),
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
}));

const PREVIOUS_USER = {
  userId: 1,
  email: 'first@example.com',
  onboardingCompleted: true,
  roles: ['ATHLETE'],
  language: 'EN',
};

const NEW_USER = {
  userId: 2,
  email: 'second@example.com',
  onboardingCompleted: false,
  roles: ['ATHLETE'],
  language: 'EN',
};

function Consumer() {
  const { logout, initialize, user } = useAuthContext();

  return (
    <div>
      <span data-testid="user-id">{user?.userId ?? 'none'}</span>
      <button onClick={() => logout(() => {})}>logout</button>
      <button onClick={() => void initialize()}>initialize</button>
    </div>
  );
}

/** Stands in for any cached response belonging to the signed-in account. */
const seedCache = (user: typeof PREVIOUS_USER) => {
  queryClient.setQueryData(['UserAPI.getMe'], user);
  queryClient.setQueryData(['AthleteAPI.getCoachedAthletes'], [{ id: 99 }]);
};

describe('AuthProvider cache isolation between accounts', () => {
  beforeEach(() => {
    queryClient.clear();
    getMe.mockReset();
    getMe.mockResolvedValue(PREVIOUS_USER);
  });

  it('empties the query cache on logout', async () => {
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(getMe).toHaveBeenCalled());
    seedCache(PREVIOUS_USER);
    expect(queryClient.getQueryData(['UserAPI.getMe'])).toEqual(PREVIOUS_USER);

    await userEvent.click(screen.getByText('logout'));

    expect(queryClient.getQueryData(['UserAPI.getMe'])).toBeUndefined();
  });

  it('does not leave any other account-scoped query behind either', async () => {
    // getMe is the visible symptom, but every domain's key is equally
    // user-agnostic, so the whole cache has to go — not just the user entry.
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(getMe).toHaveBeenCalled());
    seedCache(PREVIOUS_USER);

    await userEvent.click(screen.getByText('logout'));

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('does not serve the previous user to a fresh signup', async () => {
    // The reported repro: log out through the sidebar (no page reload), then
    // register a new account, which calls `initialize()` again.
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(getMe).toHaveBeenCalled());
    seedCache(PREVIOUS_USER);

    await userEvent.click(screen.getByText('logout'));

    getMe.mockResolvedValue(NEW_USER);
    await userEvent.click(screen.getByText('initialize'));

    await waitFor(() =>
      expect(screen.getByTestId('user-id')).toHaveTextContent('2'),
    );

    // Nothing left over that would report onboardingCompleted: true for a user
    // whose API record says false.
    const cachedUser = queryClient.getQueryData<typeof PREVIOUS_USER>([
      'UserAPI.getMe',
    ]);
    expect(cachedUser?.userId).not.toBe(PREVIOUS_USER.userId);
  });

  it('clears the cache on initialize even without a preceding logout', async () => {
    // Covers the account switch that never goes through `logout` — e.g. a
    // session that expires and is replaced by a different login in the same tab.
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(getMe).toHaveBeenCalled());
    seedCache(PREVIOUS_USER);

    await userEvent.click(screen.getByText('initialize'));

    await waitFor(() =>
      expect(
        queryClient.getQueryData(['AthleteAPI.getCoachedAthletes']),
      ).toBeUndefined(),
    );
  });
});
