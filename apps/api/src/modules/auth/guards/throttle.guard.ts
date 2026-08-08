import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  ClientAddressedRequest,
  resolveClientIp,
} from 'src/common/utils/client-ip.util';

export interface ThrottleOptions {
  /** Requests allowed per client, per window. */
  limit: number;
  /** Window length, in milliseconds. */
  windowMs: number;
}

/**
 * Marks a route (or a whole controller) as rate limited.
 *
 * Built on `Reflector.createDecorator` to match `UserTypes` next door, which
 * gives the guard a typed metadata read instead of a stringly-keyed one.
 */
export const Throttle = Reflector.createDecorator<ThrottleOptions>();

/**
 * Upper bound on distinct clients tracked at once, so a flood from spoofed or
 * rotating source addresses cannot grow the map until the process runs out of
 * memory — which is the obvious way to attack a naive in-memory counter sitting
 * on unauthenticated routes.
 */
export const MAX_TRACKED_CLIENTS = 10_000;

/** How often the expired-entry sweep is allowed to run, in milliseconds. */
const SWEEP_INTERVAL_MS = 30_000;

interface ThrottleWindow {
  hits: number;
  resetAt: number;
}

/**
 * Shape of the pieces of the Express request/response this guard touches. Typed
 * structurally so the guard stays independent of the HTTP adapter. The request
 * half is owned by the client-IP util, so changing how the client address is
 * resolved does not reach into this file.
 */
type ThrottledRequest = ClientAddressedRequest;

interface ThrottledResponse {
  setHeader(name: string, value: string | number): void;
}

/**
 * Fixed-window, per-client, per-route rate limiter.
 *
 * State lives in this process. That is correct today because the API runs a
 * single replica (`numReplicas: 1` in infra/railway/api.railway.json); scaling
 * horizontally would hand each replica its own counter and effectively multiply
 * every limit by the replica count, so that change needs shared storage first.
 */
@Injectable()
export class ThrottleGuard implements CanActivate {
  private readonly windows = new Map<string, ThrottleWindow>();
  private nextSweepAt = 0;

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride(Throttle, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Untagged handlers are deliberately left alone: this guard is opt-in per
    // route so that adding it to a controller cannot silently start rejecting
    // traffic on routes nobody reviewed.
    if (!options) {
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<ThrottledRequest>();
    const response = http.getResponse<ThrottledResponse>();

    const now = Date.now();
    this.sweep(now);

    const key = this.buildKey(request, context);
    const window = this.hit(key, now, options.windowMs);

    const resetInSeconds = Math.ceil((window.resetAt - now) / 1000);
    response.setHeader('X-RateLimit-Limit', options.limit);
    response.setHeader(
      'X-RateLimit-Remaining',
      Math.max(0, options.limit - window.hits),
    );
    response.setHeader('X-RateLimit-Reset', resetInSeconds);

    if (window.hits > options.limit) {
      response.setHeader('Retry-After', resetInSeconds);
      throw new HttpException(
        'Too many requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /**
   * One bucket per client *and* handler, so a burst of logins cannot exhaust
   * the budget for password resets (and vice versa).
   *
   * The client half comes from `resolveClientIp`, which returns the address
   * Express already worked out from `X-Forwarded-For` against the trusted-proxy
   * list `main.ts` installs. The guard deliberately does no header parsing of
   * its own: behind a proxy the only difference between the caller's address
   * and an address the caller made up is that trust configuration.
   */
  private buildKey(request: ThrottledRequest, context: ExecutionContext) {
    const clientIp = resolveClientIp(request);
    return `${clientIp}|${context.getClass().name}.${context.getHandler().name}`;
  }

  private hit(key: string, now: number, windowMs: number): ThrottleWindow {
    const current = this.windows.get(key);

    if (!current || current.resetAt <= now) {
      const fresh = { hits: 1, resetAt: now + windowMs };
      this.windows.set(key, fresh);
      this.enforceCap();
      return fresh;
    }

    current.hits += 1;
    return current;
  }

  /**
   * Drops windows that have already expired. Rate limited to once per interval
   * because it is O(tracked clients) and would otherwise run on every request.
   */
  private sweep(now: number): void {
    if (now < this.nextSweepAt) {
      return;
    }
    this.nextSweepAt = now + SWEEP_INTERVAL_MS;

    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) {
        this.windows.delete(key);
      }
    }
  }

  /**
   * Backstop for the case the sweep cannot handle: more distinct clients alive
   * inside a single window than we are willing to track. Eviction is
   * insertion-ordered (Map iteration order), so the oldest windows go first —
   * they are the closest to expiring anyway. An evicted client gets a fresh
   * budget, so under this much pressure the limit degrades rather than holds;
   * bounded memory is the property worth keeping here.
   */
  private enforceCap(): void {
    if (this.windows.size <= MAX_TRACKED_CLIENTS) {
      return;
    }

    for (const key of this.windows.keys()) {
      this.windows.delete(key);
      if (this.windows.size <= MAX_TRACKED_CLIENTS) {
        return;
      }
    }
  }
}
