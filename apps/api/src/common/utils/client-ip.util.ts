import { INestApplication } from '@nestjs/common';

/** The sliver of the Express application object this module writes to. */
interface ProxyConfigurableApp {
  set(setting: string, value: unknown): unknown;
}

/**
 * Tells Express to trust every hop in `X-Forwarded-For`, so `request.ip`
 * becomes the *leftmost* entry of that header.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE CHANGING WHERE THIS API IS DEPLOYED.
 *
 * `trust proxy: true` is only sound because a proxy that *strips* the inbound
 * `X-Forwarded-For` sits in front of this app. Railway's edge does exactly
 * that — it discards whatever header the caller sent and writes the real
 * connecting address itself. Railway staff, verbatim: "We do strip
 * X-Forwarded-For at our edge and ensure clients cannot overwrite it." That
 * strip is the entire security argument for this setting.
 *
 * Expose this API directly — no proxy, a proxy that forwards the caller's
 * header instead of replacing it, or a second ingress path that bypasses the
 * edge — and the throttle is finished. Express trusts the leftmost entry, so
 * any caller could send `X-Forwarded-For: <random>` on every request, land in
 * a fresh bucket each time and make unlimited requests. Not degraded: gone.
 * The limiter's correctness is a property of the deployment, not of this file.
 * ---------------------------------------------------------------------------
 *
 * Two narrower settings were tried in production first, and both failed:
 *
 * 1. `set('trust proxy', 1)` — a hop *count*. Express walks `X-Forwarded-For`
 *    from the right and skips exactly that many entries, so on a
 *    `<client>, <internal hop>` header it returned Railway's internal hop as
 *    the client. That address differs per edge node, which split one caller
 *    across several buckets and, far worse, put every caller behind a given
 *    edge node into one shared bucket: the throttle stopped being a per-client
 *    limit and became a lockout switch. A count is also brittle — it needs
 *    re-tuning the moment Railway adds or drops a hop, and it is wrong in both
 *    directions when the hop count varies per request.
 *
 * 2. `['loopback', 'linklocal', 'uniquelocal', '100.64.0.0/10']` — an address
 *    *list*, on the community-sourced belief that Railway's internal hop sits
 *    in the CGNAT range. It was tested live against a deployed preview: 100
 *    sequential logins against a 10/60s limit produced 50 accepted and 50
 *    `429`, with the remaining-count resetting for each of five distinct
 *    trace IDs and each trace independently allowing exactly 10 — bucketing
 *    identical to the pre-fix behaviour. Railway's hop is therefore not in
 *    `100.64.0.0/10` (nor any private range), so `proxy-addr` stopped at that
 *    hop and returned it as the client. The CGNAT guess was simply wrong, and
 *    an address list cannot be written correctly against a hop address the
 *    platform does not document and that cannot be observed from outside it.
 *
 * Trusting every hop sidesteps the question entirely: the leftmost entry is
 * the client the edge wrote, however many internal hops Railway appends today
 * or starts appending tomorrow.
 *
 * `main.ts` and the trust-proxy spec both call this rather than each setting
 * their own value, so the test exercises the configuration the app actually
 * ships instead of a copy that can drift away from it.
 */
export const configureTrustProxy = (app: INestApplication): void => {
  const expressApp = app.getHttpAdapter().getInstance() as ProxyConfigurableApp;
  expressApp.set('trust proxy', true);
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
 * `request.ip` is already the resolved answer — with every hop trusted (see
 * {@link configureTrustProxy}) Express set it to the leftmost `X-Forwarded-For`
 * entry before any guard ran. Nothing here re-parses that header: doing so by
 * hand is how a limiter ends up keyed on a value the caller controls.
 * (`request.ips` is not consulted either; it is the same resolution expressed
 * as a list, so it can only agree with `request.ip`, never correct it.)
 *
 * This function stays the seam for the resolution strategy. If the stripping
 * edge the trust-all setting depends on ever goes away, the replacement lives
 * here — read Railway's `X-Real-IP` instead, which needs `headers` added to
 * {@link ClientAddressedRequest} and nothing else — rather than being spread
 * across every guard that wants a client address.
 */
export const resolveClientIp = (request: ClientAddressedRequest): string =>
  request.ip ?? 'unknown';
