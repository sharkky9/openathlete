import { INestApplication } from '@nestjs/common';

/**
 * Addresses Express may treat as our own infrastructure when it resolves the
 * client IP from `X-Forwarded-For`.
 *
 * Railway's edge discards whatever `X-Forwarded-For` the caller sent and writes
 * the real client address itself; one internal hop may then append its own
 * address, so the app sees `<client>` or `<client>, <internal hop>`. Express
 * walks that list from the right and returns the first entry it does *not*
 * trust, so which entry it picks is decided entirely by this setting.
 *
 * Trusting by address rather than by hop count is the whole point. The previous
 * `set('trust proxy', 1)` told Express "the last entry is ours" — so on a
 * two-entry header it skipped exactly one entry and returned Railway's internal
 * hop as the client. That hop address differs per edge node, which split one
 * caller across several buckets and, far worse, put every caller behind a given
 * edge node into one shared bucket: the throttle stopped being a per-client
 * limit and became a lockout switch. A hop count is also brittle in a way a
 * list is not — it has to be re-tuned the moment Railway adds or drops a hop,
 * and it is wrong in both directions when the count varies per request.
 *
 * `loopback` / `linklocal` / `uniquelocal` are Express's built-in aliases for
 * the private ranges (they also cover local development and the in-process test
 * server). `100.64.0.0/10` is the CGNAT range Railway is reported to use for
 * the internal hop, and it is the one entry here that is not a general-purpose
 * private range — see the caveat on {@link resolveClientIp}.
 */
export const TRUSTED_PROXY_ADDRESSES = [
  'loopback',
  'linklocal',
  'uniquelocal',
  '100.64.0.0/10',
];

/** The sliver of the Express application object this module writes to. */
interface ProxyConfigurableApp {
  set(setting: string, value: unknown): unknown;
}

/**
 * Points the app's Express instance at {@link TRUSTED_PROXY_ADDRESSES}.
 *
 * `main.ts` and the trust-proxy spec both call this rather than each setting
 * their own value, so the test exercises the configuration the app actually
 * ships instead of a copy that can drift away from it.
 */
export const configureTrustProxy = (app: INestApplication): void => {
  const expressApp = app.getHttpAdapter().getInstance() as ProxyConfigurableApp;
  expressApp.set('trust proxy', TRUSTED_PROXY_ADDRESSES);
};

/**
 * The pieces of the Express request that client-IP resolution reads. Consumers
 * type their request against this so that changing the resolution strategy
 * stays contained to this file.
 */
export interface ClientAddressedRequest {
  ip?: string;
}

/**
 * The address a request is billed to.
 *
 * `request.ip` is already the resolved answer — Express derived it from
 * `X-Forwarded-For` against {@link TRUSTED_PROXY_ADDRESSES} before any guard
 * ran. Nothing here re-parses that header: doing so by hand is how a limiter
 * ends up keyed on a value the caller controls. (`request.ips` is not consulted
 * either; it is the same resolution expressed as a list, so it can only agree
 * with `request.ip`, never correct it.)
 *
 * This function is the seam for the caveat above. If Railway's internal hop
 * turns out not to fall inside the trusted set, Express silently falls back to
 * the socket address and every caller shares a bucket again. The two fallbacks
 * are both changes to this file alone: widen or replace the trusted list, or
 * read Railway's `X-Real-IP` here instead (which needs `headers` added to
 * {@link ClientAddressedRequest} and nothing else).
 */
export const resolveClientIp = (request: ClientAddressedRequest): string =>
  request.ip ?? 'unknown';
