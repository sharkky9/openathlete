import { AxiosRequestConfig, AxiosResponse } from 'axios';

import { authFailedBody } from '../../core/helpers/__fixtures__/intervals-icu.fixtures';
import {
  IntervalsIcuApiClient,
  IntervalsIcuAuthError,
} from './intervals-icu.client';

type Reply = Partial<AxiosResponse> & { status: number };

/**
 * Builds a fake request function that replays a canned sequence of responses and
 * records the configs it was called with.
 */
function stubRequests(replies: Reply[]) {
  const calls: AxiosRequestConfig[] = [];
  let index = 0;

  const request = jest.fn(async (config: AxiosRequestConfig) => {
    calls.push(config);
    const reply = replies[Math.min(index, replies.length - 1)];
    index++;
    return {
      status: reply.status,
      statusText: '',
      headers: reply.headers ?? {},
      config: config as AxiosResponse['config'],
      data: reply.data,
    } as AxiosResponse;
  });

  return { request, calls };
}

/**
 * A client on the real defaults, with only the injectable seams replaced.
 *
 * The defaults are the point of most of these tests — the retry budget is what
 * decides whether a temporary auth block costs an activity — so they are
 * deliberately not overridden here. `random: () => 0.5` is the midpoint, which
 * makes the jitter factor exactly 1 and the delays reproducible; jitter itself
 * is exercised separately.
 */
function makeClient(replies: Reply[], overrides = {}) {
  const { request, calls } = stubRequests(replies);
  const sleeps: number[] = [];

  const client = new IntervalsIcuApiClient('test-key', {
    request,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    // Throttling is exercised separately; keep it out of the recorded sleeps.
    minRequestIntervalMs: 0,
    ...overrides,
  });

  return { client, request, calls, sleeps };
}

/** Sleeps caused by the request spacing rather than by a retry. */
const retryDelays = (sleeps: number[]) => sleeps.filter((ms) => ms > 0);

describe('IntervalsIcuApiClient', () => {
  it('authenticates with HTTP Basic using the literal username API_KEY', async () => {
    const { client, calls } = makeClient([{ status: 200, data: { id: 'i1' } }]);

    await client.get('/athlete/0');

    expect(calls[0].auth).toEqual({
      username: 'API_KEY',
      password: 'test-key',
    });
    expect(calls[0].headers?.Authorization).toBeUndefined();
    expect(calls[0].url).toBe('https://intervals.icu/api/v1/athlete/0');
  });

  it('passes query parameters through', async () => {
    const { client, calls } = makeClient([{ status: 200, data: [] }]);

    await client.get('/athlete/i123456/activities', {
      oldest: '2026-06-08',
      newest: '2026-08-07',
    });

    expect(calls[0].params).toEqual({
      oldest: '2026-06-08',
      newest: '2026-08-07',
    });
  });

  // Intervals.icu answers 401 both for a bad key and for a short-lived block
  // applied after repeated failed auth attempts. Treating the first 401 as
  // "credentials are dead" would revoke a working connection.
  describe('401 handling', () => {
    it('backs off and retries a 401 instead of giving up', async () => {
      const { client, request, sleeps } = makeClient([
        { status: 401, data: authFailedBody },
        { status: 401, data: authFailedBody },
        { status: 200, data: { id: 'i123456' } },
      ]);

      await expect(client.get('/athlete/0')).resolves.toEqual({
        id: 'i123456',
      });

      expect(request).toHaveBeenCalledTimes(3);
      expect(retryDelays(sleeps)).toEqual([5000, 10_000]);
    });

    it('only reports an auth failure once every retry is exhausted', async () => {
      const { client, request, sleeps } = makeClient([
        { status: 401, data: authFailedBody },
      ]);

      await expect(client.get('/athlete/0')).rejects.toBeInstanceOf(
        IntervalsIcuAuthError,
      );

      // 1 initial attempt + 6 retries.
      expect(request).toHaveBeenCalledTimes(7);
      expect(retryDelays(sleeps)).toEqual([
        5000, 10_000, 20_000, 30_000, 30_000, 30_000,
      ]);
    });

    /**
     * The defect this pins down. Intervals.icu blocks an IP for ~30-60s after
     * repeated auth failures, and the old budget of 1+2+4+8 = 15s ran out well
     * inside that window: the client gave up while still blocked, the job burnt
     * all three BullMQ attempts the same way, and the activity was lost for
     * good. 2 of 1,224 activities went that way on a real account.
     */
    it('can outlast the long end of a 30-60s auth block', async () => {
      const { client, sleeps } = makeClient([
        { status: 401, data: authFailedBody },
      ]);

      await expect(client.get('/athlete/0')).rejects.toBeInstanceOf(
        IntervalsIcuAuthError,
      );

      const total = retryDelays(sleeps).reduce((sum, ms) => sum + ms, 0);
      expect(total).toBeGreaterThan(60_000);
    });

    it('outlasts a 60s block even on the unluckiest jitter draw', async () => {
      // random() === 0 is the largest downward jitter the client can produce.
      const { client, sleeps } = makeClient(
        [{ status: 401, data: authFailedBody }],
        { random: () => 0 },
      );

      await expect(client.get('/athlete/0')).rejects.toBeInstanceOf(
        IntervalsIcuAuthError,
      );

      const total = retryDelays(sleeps).reduce((sum, ms) => sum + ms, 0);
      expect(total).toBeGreaterThan(60_000);
    });

    it('waits longer before the first 401 retry than before other retries', async () => {
      // A block lasts ~30-60s, so an immediate retry cannot succeed and each
      // failed auth is itself what feeds the block.
      const auth = makeClient([{ status: 401, data: authFailedBody }]);
      await expect(auth.client.get('/athlete/0')).rejects.toBeInstanceOf(
        IntervalsIcuAuthError,
      );

      const server = makeClient([{ status: 503 }]);
      await expect(server.client.get('/athlete/0')).rejects.toThrow(/503/);

      expect(retryDelays(auth.sleeps)[0]).toBeGreaterThan(
        retryDelays(server.sleeps)[0],
      );
    });

    it('caps the exponential backoff', async () => {
      const { client, sleeps } = makeClient(
        [{ status: 401, data: authFailedBody }],
        { maxRetries: 8, maxBackoffMs: 5000, authInitialBackoffMs: 1000 },
      );

      await expect(client.get('/athlete/0')).rejects.toBeInstanceOf(
        IntervalsIcuAuthError,
      );

      expect(retryDelays(sleeps)).toEqual([
        1000, 2000, 4000, 5000, 5000, 5000, 5000, 5000,
      ]);
    });

    it('does not retry when retries are disabled', async () => {
      const { client, request } = makeClient(
        [{ status: 401, data: authFailedBody }],
        { maxRetries: 0 },
      );

      await expect(client.get('/athlete/0')).rejects.toBeInstanceOf(
        IntervalsIcuAuthError,
      );
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  describe('jitter', () => {
    it('spreads the delay either side of the nominal backoff', async () => {
      const draws = [0, 1];
      let index = 0;

      const { client, sleeps } = makeClient(
        [{ status: 401, data: authFailedBody }],
        { maxRetries: 2, random: () => draws[index++] ?? 0.5 },
      );

      await expect(client.get('/athlete/0')).rejects.toBeInstanceOf(
        IntervalsIcuAuthError,
      );

      // Nominal 5000 and 10000, jittered by -20% then +20%.
      expect(retryDelays(sleeps)).toEqual([4000, 12_000]);
    });

    it('never jitters an explicit Retry-After', async () => {
      const { client, sleeps } = makeClient(
        [{ status: 429, headers: { 'retry-after': '3' } }, { status: 200 }],
        { random: () => 0 },
      );

      await client.get('/athlete/0');

      expect(retryDelays(sleeps)).toEqual([3000]);
    });
  });

  describe('other statuses', () => {
    it('honours Retry-After on 429', async () => {
      const { client, sleeps, request } = makeClient([
        { status: 429, headers: { 'retry-after': '3' } },
        { status: 200, data: [] },
      ]);

      await client.get('/athlete/i123456/activities');

      expect(request).toHaveBeenCalledTimes(2);
      expect(retryDelays(sleeps)).toEqual([3000]);
    });

    it('retries 5xx', async () => {
      const { client, request } = makeClient([
        { status: 503 },
        { status: 200, data: [] },
      ]);

      await client.get('/athlete/i123456/activities');
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 422 and surfaces the message body', async () => {
      const { client, request } = makeClient([
        {
          status: 422,
          data: {
            status: 422,
            error:
              "Required request parameter 'oldest' for method parameter type String is not present",
          },
        },
      ]);

      await expect(client.get('/athlete/i123456/activities')).rejects.toThrow(
        /status 422.*oldest/s,
      );
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('does not retry a 404', async () => {
      const { client, request } = makeClient([{ status: 404 }]);

      await expect(client.get('/activity/nope/streams')).rejects.toThrow(
        /status 404/,
      );
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  describe('throttling', () => {
    it('spaces successive requests out', async () => {
      const sleeps: number[] = [];
      const { request } = stubRequests([{ status: 200, data: [] }]);

      const client = new IntervalsIcuApiClient('test-key', {
        request,
        minRequestIntervalMs: 200,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      });

      await client.get('/athlete/0');
      await client.get('/athlete/0');

      // The second call waits out the remainder of the 200ms window.
      expect(sleeps.some((ms) => ms > 0 && ms <= 200)).toBe(true);
    });
  });
});
