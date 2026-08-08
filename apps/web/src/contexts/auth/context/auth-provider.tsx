import { UserAPI } from '@/api/user';
import { getPath } from '@/routes/paths';
import { isValidToken } from '@/utils/auth';
import { signOutFirebase } from '@/utils/firebase-auth';
import { ACCESS_TOKEN, clear, getItem, setItem } from '@/utils/local-storage';
import { initializePushNotifications } from '@/utils/push-notifications';
import { resetQueryCache } from '@/utils/query-client';
import posthog from 'posthog-js';
import { useCallback, useEffect, useMemo, useReducer } from 'react';

import { User } from '@openathlete/shared';

import { ActionMapType, AuthContextType, AuthStateType } from '../types';
import { AuthContext } from './auth-context';

const Types = {
  INITIAL: 'INITIAL',
  LOGOUT: 'LOGOUT',
} as const;

type Types = (typeof Types)[keyof typeof Types];

const reducer = (state: AuthStateType, action: ActionsType) => {
  if (action.type === Types.INITIAL) {
    return {
      loading: false,
      user: action.payload.user,
    };
  }
  if (action.type === Types.LOGOUT) {
    return {
      ...state,
      user: null,
    };
  }
  return state;
};

type Props = {
  children: React.ReactNode;
};

type Payload = {
  [Types.INITIAL]: {
    user: User | null;
  };
  [Types.LOGOUT]: undefined;
};

type ActionsType = ActionMapType<Payload>[keyof ActionMapType<Payload>];

const initialState: AuthStateType = {
  user: null,
  loading: true,
};

export function AuthProvider({ children }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const initialize = useCallback(async () => {
    // `initialize` runs on mount and again after every login, signup and
    // onboarding completion, i.e. on every account boundary. The React Query
    // cache is keyed without any user identity, so anything the previous
    // account fetched in this tab would otherwise be served to the next one —
    // most visibly `UserAPI.getMe`, which decides whether AuthGuard sends a
    // brand-new signup to onboarding or straight to the dashboard.
    resetQueryCache();

    try {
      const accessToken = getItem(ACCESS_TOKEN);

      if (accessToken && isValidToken(accessToken)) {
        setItem(ACCESS_TOKEN, accessToken);

        const user = await UserAPI.getMe();

        const urlParams = new URLSearchParams(window.location.search);
        const urlLang = urlParams.get('lang');
        if (urlLang && (urlLang === 'fr' || urlLang === 'en')) {
          const language = urlLang.toUpperCase() as 'FR' | 'EN';
          if (user.language !== language) {
            try {
              await UserAPI.updateLanguage(language);
            } catch (error) {
              console.error('Failed to update language:', error);
            }
          }
        }

        posthog.identify(user.userId.toString(), {
          roles: user.roles,
        });

        dispatch({
          type: Types.INITIAL,
          payload: {
            user,
          },
        });

        // Initialize push notifications and send any pending token
        initializePushNotifications()
          .then(() => {
            // Import dynamically to avoid circular dependency
            import('@/utils/push-notifications').then(
              ({ sendPendingTokenIfAny }) => {
                sendPendingTokenIfAny();
              },
            );
          })
          .catch((error) => {
            console.error('Failed to initialize push notifications:', error);
          });
      } else {
        try {
          const user = await UserAPI.getMe();

          const urlParams = new URLSearchParams(window.location.search);
          const urlLang = urlParams.get('lang');
          if (urlLang && (urlLang === 'fr' || urlLang === 'en')) {
            const language = urlLang.toUpperCase() as 'FR' | 'EN';
            if (user.language !== language) {
              try {
                await UserAPI.updateLanguage(language);
              } catch (error) {
                console.error('Failed to update language:', error);
              }
            }
          }

          posthog.identify(user.userId.toString(), {
            roles: user.roles,
          });

          dispatch({
            type: Types.INITIAL,
            payload: {
              user,
            },
          });

          // Initialize push notifications and send any pending token
          initializePushNotifications()
            .then(() => {
              // Import dynamically to avoid circular dependency
              import('@/utils/push-notifications').then(
                ({ sendPendingTokenIfAny }) => {
                  sendPendingTokenIfAny();
                },
              );
            })
            .catch((error) => {
              console.error('Failed to initialize push notifications:', error);
            });
        } catch {
          dispatch({
            type: Types.INITIAL,
            payload: {
              user: null,
            },
          });
        }
      }
    } catch {
      dispatch({
        type: Types.INITIAL,
        payload: {
          user: null,
        },
      });
    }
  }, []);

  const logout = useCallback((navigate?: (path: string) => void) => {
    posthog.capture('user_logged_out');
    posthog.reset();
    clear();
    // Logging out from the sidebar navigates client-side, so the module-scope
    // query cache survives. Empty it here as well as in `initialize` so the
    // next account in this tab cannot read this one's responses even if it
    // never reaches `initialize` (e.g. it just browses the login screen).
    resetQueryCache();
    signOutFirebase().catch((error) => {
      console.error('Failed to sign out Firebase:', error);
    });
    dispatch({
      type: Types.LOGOUT,
    });
    const loginPath = getPath(['auth', 'login']);
    if (navigate) {
      navigate(loginPath);
    } else {
      window.location.href = loginPath;
    }
  }, []);

  useEffect(() => {
    initialize();
  }, [initialize]);

  const checkAuthenticated = state.user ? 'authenticated' : 'unauthenticated';

  const status = state.loading ? 'loading' : checkAuthenticated;

  const memoizedValue = useMemo<AuthContextType>(
    () => ({
      user: state.user,
      loading: status === 'loading',
      authenticated: status === 'authenticated',
      unauthenticated: status === 'unauthenticated',
      initialize,
      logout,
    }),
    [state.user, status, initialize, logout],
  );

  return (
    <AuthContext.Provider value={memoizedValue}>
      {children}
    </AuthContext.Provider>
  );
}
