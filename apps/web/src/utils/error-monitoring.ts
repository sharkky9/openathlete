import * as Sentry from '@sentry/react';

let isInitialized = false;

export function initErrorMonitoring() {
  if (isInitialized || import.meta.env.DEV) {
    return;
  }

  // Read lazily, and treat an empty string as absent: container runtimes inject
  // `VAR=` for variables that were never set. With no DSN configured, browser
  // error reporting stays dark rather than shipping this deployment's errors to
  // somebody else's account.
  const dsn = import.meta.env.VITE_BETTER_STACK_DSN as string | undefined;
  if (!dsn) {
    return;
  }

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: false,
      }),
    ],
    tracesSampleRate: 0.25,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1,
  });

  isInitialized = true;
}
