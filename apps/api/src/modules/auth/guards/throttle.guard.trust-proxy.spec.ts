import request from 'supertest';

import {
  Controller,
  Get,
  INestApplication,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  ClientAddressedRequest,
  configureTrustProxy,
  resolveClientIp,
} from 'src/common/utils/client-ip.util';
import { Throttle, ThrottleGuard } from 'src/modules/auth/guards';

// The blind spot this file exists to close.
//
// `throttle.guard.spec.ts` hands the guard hand-built `{ ip }` objects, so it
// can only prove the guard separates the addresses it is given. It cannot see
// *which* address Express puts there, and that is the half that was broken:
// under `set('trust proxy', 1)` Express resolved the rightmost trusted entry of
// `X-Forwarded-For` — Railway's internal hop — instead of the client, so every
// caller behind one edge node shared a single bucket. Every unit test passed.
//
// So this spec drives a real Nest-over-Express app through real HTTP, with the
// trust-proxy configuration installed by the same `configureTrustProxy` call
// `main.ts` makes (importing the helper rather than restating the value, so the
// two cannot drift apart), and asserts on what comes out the other end.
//
// Railway's edge overwrites any client-supplied `X-Forwarded-For` with the real
// client address, then one or more internal hops may append their own. The
// header this app sees is therefore `<client>` or `<client>, <hop>[, <hop>…]`,
// and the address billed must be the leftmost — the real client — in every
// shape. `configureTrustProxy` gets there by trusting *every* hop, which makes
// the leftmost entry the answer no matter how many hops Railway adds; the
// address-list attempt that preceded it failed live because Railway's hop turns
// out not to sit in any range that list named. See `client-ip.util.ts` for the
// full history and, importantly, for what this setting costs.

const CLIENT = '203.0.113.7';
const OTHER_CLIENT = '203.0.113.8';
// Two different Railway internal hops. The bug was that these two values
// produced two different buckets for the same caller — and one shared bucket
// for every caller behind either. Their actual ranges are deliberately
// unrelated: with every hop trusted, what a hop's address happens to be no
// longer changes the answer, and these values being un-guessable is exactly
// why the previous address-list configuration could not work.
const RAILWAY_HOP = '100.64.12.34';
const OTHER_RAILWAY_HOP = '66.33.22.11';

const LIMIT = 3;
const WINDOW_MS = 60_000;

@Controller('probe')
@UseGuards(ThrottleGuard)
class ProbeController {
  /** Unthrottled, so the resolved address can be read directly. */
  @Get('whoami')
  whoami(@Req() req: ClientAddressedRequest) {
    return { clientIp: resolveClientIp(req) };
  }

  @Get('limited')
  @Throttle({ limit: LIMIT, windowMs: WINDOW_MS })
  limited() {
    return { ok: true };
  }
}

describe('ThrottleGuard behind a trusted proxy (real Express resolution)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [ThrottleGuard],
    }).compile();

    app = moduleRef.createNestApplication();
    // Exactly what main.ts does, via the same helper.
    configureTrustProxy(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const whoami = (forwardedFor: string) =>
    request(app.getHttpServer())
      .get('/probe/whoami')
      .set('X-Forwarded-For', forwardedFor);

  const limited = (forwardedFor: string) =>
    request(app.getHttpServer())
      .get('/probe/limited')
      .set('X-Forwarded-For', forwardedFor);

  describe('client address resolution', () => {
    it('bills the client when the edge appends no internal hop', async () => {
      const response = await whoami(CLIENT);

      expect(response.body.clientIp).toBe(CLIENT);
    });

    it('bills the client, not the hop, when the edge appends one', async () => {
      const response = await whoami(`${CLIENT}, ${RAILWAY_HOP}`);

      expect(response.body.clientIp).toBe(CLIENT);
      // Spelled out because this exact value is what the old hop-counting
      // configuration returned, and it is what made the limiter global.
      expect(response.body.clientIp).not.toBe(RAILWAY_HOP);
    });

    it('bills the client when the edge appends two hops', async () => {
      const response = await whoami(
        `${CLIENT}, ${RAILWAY_HOP}, ${OTHER_RAILWAY_HOP}`,
      );

      expect(response.body.clientIp).toBe(CLIENT);
    });

    it('bills the client when the edge appends three hops', async () => {
      // The point of trusting every hop rather than naming the trusted ones:
      // the answer does not move when Railway grows another layer. Both the
      // hop count and the address list broke on exactly this — the count
      // because it was tuned to one shape, the list because a hop it did not
      // name stopped resolution dead.
      const response = await whoami(
        `${CLIENT}, ${RAILWAY_HOP}, ${OTHER_RAILWAY_HOP}, 10.1.2.3`,
      );

      expect(response.body.clientIp).toBe(CLIENT);
    });

    it('trusts a leftmost entry the caller supplied — safe ONLY behind a stripping edge', async () => {
      // The price of `trust proxy: true`, pinned rather than wished away.
      //
      // Express takes the leftmost `X-Forwarded-For` entry as the client, and
      // it has no way to tell an entry the edge wrote from one the caller
      // sent. Here nothing strips the header, so the caller's own value wins
      // and it gets to name its own throttle bucket — send a fresh one per
      // request and the limiter is not slowed down, it is bypassed entirely.
      //
      // In production this is unreachable because Railway's edge discards the
      // inbound header and writes the real connecting address itself ("We do
      // strip X-Forwarded-For at our edge and ensure clients cannot overwrite
      // it"). That strip is the only thing standing between this setting and
      // an unlimited limiter. If this API is ever reachable without such a
      // proxy in front, this test is the description of the resulting hole —
      // change `configureTrustProxy` before that happens, not after.
      const callerSupplied = '198.51.100.66';

      const response = await whoami(
        `${callerSupplied}, ${CLIENT}, ${RAILWAY_HOP}`,
      );

      expect(response.body.clientIp).toBe(callerSupplied);
      expect(response.body.clientIp).not.toBe(CLIENT);
    });
  });

  describe('throttle bucket identity', () => {
    const statusesFor = async (forwardedFor: string, count: number) => {
      const statuses: number[] = [];
      for (let i = 0; i < count; i++) {
        statuses.push((await limited(forwardedFor)).status);
      }
      return statuses;
    };

    it('puts one client in one bucket however many hops the edge appends', async () => {
      // Same caller, three header shapes that differ only in the appended
      // internal hop. Under hop counting these were three separate budgets.
      expect((await limited(CLIENT)).status).not.toBe(429);
      expect((await limited(`${CLIENT}, ${RAILWAY_HOP}`)).status).not.toBe(429);
      expect(
        (await limited(`${CLIENT}, ${OTHER_RAILWAY_HOP}`)).status,
      ).not.toBe(429);

      // LIMIT is spent, so the next request is rejected no matter which shape
      // it arrives in — one bucket, not three.
      expect((await limited(`${CLIENT}, ${RAILWAY_HOP}`)).status).toBe(429);
      expect((await limited(CLIENT)).status).toBe(429);
    });

    it('keeps separate buckets for separate clients behind the same hop', async () => {
      // The inverse, and the property the bug destroyed: sharing an edge node
      // must not share a budget.
      const spent = await statusesFor(`${CLIENT}, ${RAILWAY_HOP}`, LIMIT + 1);

      expect(spent.slice(0, LIMIT)).toEqual(Array(LIMIT).fill(200));
      expect(spent[LIMIT]).toBe(429);

      expect((await limited(`${OTHER_CLIENT}, ${RAILWAY_HOP}`)).status).toBe(
        200,
      );
    });

    it('gives a client exactly LIMIT requests across mixed hops, then 429s', async () => {
      // Exact boundary rather than "some 429 shows up": a regression that
      // multiplied the budget by the number of distinct edge nodes — which is
      // precisely what the old configuration did — would still produce 429s
      // eventually and pass a laxer assertion.
      const hops = [RAILWAY_HOP, OTHER_RAILWAY_HOP, '100.64.7.7', ''];
      const statuses: number[] = [];

      for (let i = 0; i < (LIMIT + 1) * hops.length; i++) {
        const hop = hops[i % hops.length];
        const header = hop ? `${CLIENT}, ${hop}` : CLIENT;
        statuses.push((await limited(header)).status);
      }

      expect(statuses.slice(0, LIMIT)).toEqual(Array(LIMIT).fill(200));
      expect(statuses.slice(LIMIT)).toEqual(
        Array(statuses.length - LIMIT).fill(429),
      );
    });
  });
});
