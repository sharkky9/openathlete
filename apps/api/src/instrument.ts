import * as Sentry from '@sentry/nestjs';

// Ensure to call this before requiring any other modules!
Sentry.init({
  dsn: process.env.BETTER_STACK_DSN,
  // Sample 10% of transactions/profiles rather than 100%: tracing every single
  // production request costs ingest quota and CPU without telling us anything
  // a 10% sample does not already show.
  tracesSampleRate: 0.1,
  profilesSampleRate: 0.1,
  environment: process.env.NODE_ENV || 'production',
});
