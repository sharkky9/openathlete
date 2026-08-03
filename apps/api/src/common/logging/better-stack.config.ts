export interface BetterStackLogConfig {
  sourceToken: string;
  ingestingHost: string;
  environment: string;
  service: string;
}

/**
 * Resolves the Better Stack log ingestion credentials.
 *
 * Better Stack log sources are addressed by a source token plus an ingesting
 * host. When a dedicated log source exists, `BETTER_STACK_SOURCE_TOKEN` and
 * `BETTER_STACK_INGESTING_HOST` are used. Otherwise the values are derived from
 * the Sentry-compatible `BETTER_STACK_DSN` already used for error tracking
 * (`https://<token>@<host>/<source-id>`), so a single variable is enough to get
 * logs and errors into the same Better Stack team.
 */
export function resolveBetterStackLogConfig(
  env: NodeJS.ProcessEnv,
): BetterStackLogConfig | null {
  const environment = env.NODE_ENV ?? 'production';
  const service = env.BETTER_STACK_SERVICE_NAME ?? 'openathlete-api';

  const explicitToken = env.BETTER_STACK_SOURCE_TOKEN?.trim();
  const explicitHost = normalizeHost(env.BETTER_STACK_INGESTING_HOST);

  if (explicitToken && explicitHost) {
    return {
      sourceToken: explicitToken,
      ingestingHost: explicitHost,
      environment,
      service,
    };
  }

  const fromDsn = parseDsn(env.BETTER_STACK_DSN);
  if (!fromDsn) {
    return null;
  }

  return {
    sourceToken: explicitToken || fromDsn.sourceToken,
    ingestingHost: explicitHost ?? fromDsn.ingestingHost,
    environment,
    service,
  };
}

function parseDsn(
  dsn: string | undefined,
): { sourceToken: string; ingestingHost: string } | null {
  if (!dsn) {
    return null;
  }

  try {
    const url = new URL(dsn);
    if (!url.username) {
      return null;
    }
    return { sourceToken: url.username, ingestingHost: url.host };
  } catch {
    return null;
  }
}

function normalizeHost(host: string | undefined): string | undefined {
  const trimmed = host?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}
