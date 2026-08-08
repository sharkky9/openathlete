import axios, { AxiosRequestConfig, AxiosResponse, isAxiosError } from 'axios';

/**
 * HTTP client for the Intervals.icu API.
 *
 * Three behaviours here are not optional and are the reason this lives in its
 * own class rather than inline in the provider service:
 *
 * 1. **Auth is HTTP Basic with the literal username `API_KEY`** and the
 *    athlete's personal API key as the password. Bearer tokens are for OAuth
 *    apps only and are rejected for personal keys.
 *
 * 2. **A 401 is ambiguous.** Intervals.icu returns `401 {"status":401,
 *    "error":"Auth failed"}` both for a genuinely bad key *and* for a
 *    short-lived (~30-60s) block applied after repeated failed auth attempts
 *    from the same IP. A client that treats the first 401 as "credentials are
 *    dead" will revoke a perfectly good connection. So we back off and retry on
 *    401, and only surface an auth failure once every retry is exhausted.
 *
 * 3. **There are no rate-limit headers.** Nothing in the response tells you how
 *    much budget is left (verified across ~25 live responses), so the only
 *    option is to self-throttle. Documented limits are 5000/day, 2500/15min and
 *    10 req/s per IP; we pace well under the per-second one.
 */

const DEFAULT_BASE_URL = 'https://intervals.icu/api/v1';

/** ~5 req/s, half of the documented 10/s per-IP ceiling. */
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 200;

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** An 11-hour run returned 3.6 MB of stream JSON; leave generous headroom. */
const DEFAULT_MAX_CONTENT_LENGTH = 64 * 1024 * 1024;

export type IntervalsIcuRequestFn = (
  config: AxiosRequestConfig,
) => Promise<AxiosResponse>;

export interface IntervalsIcuClientOptions {
  baseUrl?: string;
  minRequestIntervalMs?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  maxContentLength?: number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to `axios.request`. */
  request?: IntervalsIcuRequestFn;
  onRetry?: (info: {
    attempt: number;
    status?: number;
    delayMs: number;
    path: string;
  }) => void;
}

/**
 * Raised when Intervals.icu kept answering 401 after every retry. Callers may
 * treat this as "the key is probably revoked" — but only this error, never a
 * single raw 401.
 */
export class IntervalsIcuAuthError extends Error {
  constructor(path: string, attempts: number) {
    super(
      `Intervals.icu authentication failed for ${path} after ${attempts} attempt(s)`,
    );
    this.name = 'IntervalsIcuAuthError';
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class IntervalsIcuApiClient {
  private readonly baseUrl: string;
  private readonly minRequestIntervalMs: number;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxContentLength: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly request: IntervalsIcuRequestFn;
  private readonly onRetry?: IntervalsIcuClientOptions['onRetry'];

  /** Serialises the throttle so concurrent callers still respect the spacing. */
  private throttleChain: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(
    private readonly apiKey: string,
    options: IntervalsIcuClientOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.minRequestIntervalMs =
      options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.initialBackoffMs =
      options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.maxContentLength =
      options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
    this.sleep = options.sleep ?? defaultSleep;
    this.request = options.request ?? ((config) => axios.request(config));
    this.onRetry = options.onRetry;
  }

  /**
   * GET a path relative to the API base (e.g. `/athlete/i225849/activities`).
   */
  async get<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
    timeoutMs = 45_000,
  ): Promise<T> {
    let attempt = 0;

    for (;;) {
      attempt++;
      await this.throttle();

      try {
        const response = await this.request({
          method: 'GET',
          url: `${this.baseUrl}${path}`,
          params,
          // HTTP Basic with the literal username `API_KEY`.
          auth: { username: 'API_KEY', password: this.apiKey },
          timeout: timeoutMs,
          maxContentLength: this.maxContentLength,
          maxBodyLength: this.maxContentLength,
          // Handle non-2xx ourselves so the retry policy lives in one place.
          validateStatus: () => true,
        });

        if (response.status >= 200 && response.status < 300) {
          return response.data as T;
        }

        const canRetry =
          this.isRetryableStatus(response.status) && attempt <= this.maxRetries;

        if (!canRetry) {
          if (response.status === 401) {
            // Only after exhausting retries do we call it an auth failure.
            throw new IntervalsIcuAuthError(path, attempt);
          }
          throw new Error(
            `Intervals.icu GET ${path} failed with status ${response.status}: ${this.describeBody(response.data)}`,
          );
        }

        await this.backOff(attempt, path, response);
      } catch (error) {
        if (error instanceof IntervalsIcuAuthError) {
          throw error;
        }

        // Network-level failures (timeouts, resets) are worth one more go.
        const retryableNetworkError =
          isAxiosError(error) && !error.response && attempt <= this.maxRetries;

        if (!retryableNetworkError) {
          throw error;
        }

        await this.backOff(attempt, path);
      }
    }
  }

  private isRetryableStatus(status: number): boolean {
    // 401 is retryable on purpose — see the class doc.
    return status === 401 || status === 429 || status >= 500;
  }

  private describeBody(data: unknown): string {
    if (typeof data === 'string') {
      return data.slice(0, 200);
    }
    try {
      return JSON.stringify(data).slice(0, 200);
    } catch {
      return '<unserialisable body>';
    }
  }

  private async backOff(
    attempt: number,
    path: string,
    response?: AxiosResponse,
  ): Promise<void> {
    const retryAfterSeconds = Number(
      (response?.headers as Record<string, string> | undefined)?.[
        'retry-after'
      ] ?? NaN,
    );

    const delayMs = Number.isFinite(retryAfterSeconds)
      ? Math.min(retryAfterSeconds * 1000, this.maxBackoffMs)
      : Math.min(
          this.initialBackoffMs * Math.pow(2, attempt - 1),
          this.maxBackoffMs,
        );

    this.onRetry?.({
      attempt,
      status: response?.status,
      delayMs,
      path,
    });

    await this.sleep(delayMs);
  }

  /**
   * Space requests out by at least `minRequestIntervalMs`, serialised so that
   * parallel callers queue behind each other instead of all firing at once.
   */
  private throttle(): Promise<void> {
    const next = this.throttleChain.then(async () => {
      const waitMs =
        this.lastRequestAt + this.minRequestIntervalMs - Date.now();
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }
      this.lastRequestAt = Date.now();
    });

    // Keep the chain alive even if a link rejects.
    this.throttleChain = next.catch(() => undefined);
    return next;
  }
}
