import { ExecutionContext, HttpStatus, Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { MAX_TRACKED_CLIENTS, Throttle, ThrottleGuard } from './throttle.guard';

// This limiter is hand-rolled and sits on unauthenticated routes, so the two
// properties worth pinning are the ones a naive counter gets wrong.
//
// Bucket identity: the budget is per client *and* per handler. Sharing a bucket
// across routes would let a login burst lock a user out of password reset;
// sharing it across clients would turn the limiter into a global outage switch
// the moment one caller misbehaves.
//
// Bounded memory: an attacker rotating source addresses is exactly how you turn
// an in-memory counter into an OOM. The map must stay capped no matter how many
// distinct clients appear inside a single window.
//
// What this file deliberately does NOT cover: which address `request.ip` holds
// behind Railway's proxy. The requests here are hand-built objects, so they can
// only assert that the guard separates whatever addresses it is handed — they
// cannot catch a `trust proxy` setting that makes Express hand it the proxy's
// address instead of the client's. An earlier version of this file asserted a
// forwarded-client rule against a hand-set `ips` array and passed happily while
// production was billing every caller to a shared bucket. That resolution is
// Express's job and is pinned end-to-end in `throttle.guard.trust-proxy.spec.ts`.

const WINDOW_MS = 60_000;
const LIMIT = 3;

class FakeController {
  @Throttle({ limit: LIMIT, windowMs: WINDOW_MS })
  login() {}

  @Throttle({ limit: LIMIT, windowMs: WINDOW_MS })
  passwordReset() {}

  untagged() {}
}

interface CallOptions {
  handler?: keyof FakeController;
  ip?: string;
}

const makeContext = ({ handler = 'login', ip = '10.0.0.1' }: CallOptions) => {
  const headers: Record<string, string | number> = {};
  const request = { ip };
  const response = {
    setHeader: (name: string, value: string | number) => {
      headers[name] = value;
    },
  };

  const context = {
    getHandler: () => FakeController.prototype[handler],
    getClass: () => FakeController as Type<FakeController>,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { context, headers };
};

describe('ThrottleGuard', () => {
  let guard: ThrottleGuard;

  beforeEach(() => {
    guard = new ThrottleGuard(new Reflector());
  });

  const call = (options: CallOptions = {}) => {
    const { context, headers } = makeContext(options);
    try {
      return { allowed: guard.canActivate(context), status: 0, headers };
    } catch (error) {
      return {
        allowed: false,
        status: (error as { getStatus(): number }).getStatus(),
        headers,
      };
    }
  };

  const exhaust = (options: CallOptions = {}) => {
    for (let i = 0; i < LIMIT; i++) {
      expect(call(options).allowed).toBe(true);
    }
  };

  it('lets untagged handlers through, however many times they are called', () => {
    for (let i = 0; i < LIMIT * 10; i++) {
      expect(call({ handler: 'untagged' }).allowed).toBe(true);
    }
  });

  it('rejects with 429 once the limit is exceeded', () => {
    exhaust();

    const blocked = call();

    expect(blocked.allowed).toBe(false);
    expect(blocked.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(Number(blocked.headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('reports the limit and the remaining budget on allowed requests', () => {
    const first = call();

    expect(first.headers['X-RateLimit-Limit']).toBe(LIMIT);
    expect(first.headers['X-RateLimit-Remaining']).toBe(LIMIT - 1);
    expect(Number(first.headers['X-RateLimit-Reset'])).toBeGreaterThan(0);
  });

  it('keeps a separate budget per handler', () => {
    exhaust({ handler: 'login' });
    expect(call({ handler: 'login' }).allowed).toBe(false);

    expect(call({ handler: 'passwordReset' }).allowed).toBe(true);
  });

  it('keeps a separate budget per client address', () => {
    exhaust({ ip: '10.0.0.1' });
    expect(call({ ip: '10.0.0.1' }).allowed).toBe(false);

    expect(call({ ip: '10.0.0.2' }).allowed).toBe(true);
  });

  it('restores the budget after the window expires', () => {
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);

    exhaust();
    expect(call().allowed).toBe(false);

    clock.mockReturnValue(start + WINDOW_MS + 1);
    expect(call().allowed).toBe(true);

    clock.mockRestore();
  });

  it('caps the number of tracked clients under an address-rotating flood', () => {
    const overflow = 500;

    for (let i = 0; i < MAX_TRACKED_CLIENTS + overflow; i++) {
      call({ ip: `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}` });
    }

    expect(guard['windows'].size).toBeLessThanOrEqual(MAX_TRACKED_CLIENTS);
  });
});
