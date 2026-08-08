import { QueryClient } from '@tanstack/react-query';

/**
 * The single React Query cache for the app.
 *
 * It lives in its own module rather than in `App.tsx` so that non-React code —
 * in practice `AuthProvider`, which is mounted *outside* `QueryClientProvider` —
 * can reach it. Every query key under `src/api` is a static string with
 * no user identity in it (`UserAPI.getMe`, `AthleteAPI.getCoachedAthletes`, …),
 * so one account's cached responses are readable by the next account signed in
 * to the same tab unless the cache is emptied at the account boundary. See
 * `resetQueryCache`.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes - data is considered fresh for 5 minutes
      gcTime: 10 * 60 * 1000, // 10 minutes - cache is kept for 10 minutes (formerly cacheTime)
      refetchOnWindowFocus: false, // Don't refetch when window regains focus
      refetchOnMount: false, // Don't refetch on mount if data is fresh
      refetchOnReconnect: true, // Refetch when network reconnects
    },
  },
});

/**
 * Drop every cached query.
 *
 * Must be called on any account boundary — logout, login, signup — because
 * logging out through the sidebar is a client-side navigation with no page
 * reload, so this module (and the cache it holds) survives it.
 */
export const resetQueryCache = () => {
  queryClient.clear();
};
