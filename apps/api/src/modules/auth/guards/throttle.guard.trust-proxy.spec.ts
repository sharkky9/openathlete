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
// client address, then an internal hop may append its own. The header this app
// sees is therefore `<client>` or `<client>, <internal hop>`, and the address
// billed must be the leftmost — the real client — in both shapes.

const CLIENT = '203.0.113.7';
const OTHER_CLIENT = '203.0.113.8';
// Two different Railway edge nodes, in the CGNAT range the trusted-proxy list
// covers. The bug was that these two values produced two different buckets for
// the same caller — and one shared bucket for every caller behind either.
const RAILWAY_HOP = '100.64.12.34';
const OTHER_RAILWAY_HOP = '100.64.200.9';

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

    it('ignores an address the caller prepended to the header', async () => {
      // A caller that sends its own `X-Forwarded-For` gets it overwritten at
      // the edge, so its value can only ever appear to the *left* of the real
      // client. Resolution stops at the first untrusted entry from the right,
      // which is the edge-written one, so the spoof is never reached.
      const response = await whoami(`198.51.100.66, ${CLIENT}, ${RAILWAY_HOP}`);

      expect(response.body.clientIp).toBe(CLIENT);
      expect(response.body.clientIp).not.toBe('198.51.100.66');
    });

    it('falls back to the hop when it is outside the trusted set', async () => {
      // The known failure mode, pinned so it is visible rather than surprising:
      // trust is by address, so a hop from a range the list does not cover is
      // treated as the client and the shared-bucket bug returns. If Railway's
      // internal hop is ever observed outside 100.64.0.0/10, this is the test
      // that explains why production regressed.
      const untrustedHop = '66.33.22.11';

      const response = await whoami(`${CLIENT}, ${untrustedHop}`);

      expect(response.body.clientIp).toBe(untrustedHop);
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
