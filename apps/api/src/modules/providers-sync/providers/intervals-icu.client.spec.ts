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

function makeClient(replies: Reply[], overrides = {}) {
  const { request, calls } = stubRequests(replies);
  const sleeps: number[] = [];

  const client = new IntervalsIcuApiClient('test-key', {
    request,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    initialBackoffMs: 1000,
    maxBackoffMs: 30_000,
    maxRetries: 4,
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

    await client.get('/athlete/i225849/activities', {
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
        { status: 200, data: { id: 'i225849' } },
      ]);

      await expect(client.get('/athlete/0')).resolves.toEqual({
        id: 'i225849',
      });

      expect(request).toHaveBeenCalledTimes(3);
      expect(retryDelays(sleeps)).toEqual([1000, 2000]);
    });

    it('only reports an auth failure once every retry is exhausted', async () => {
      const { client, request, sleeps } = makeClient([
        { status: 401, data: authFailedBody },
      ]);

      await expect(client.get('/athlete/0')).rejects.toBeInstanceOf(
        IntervalsIcuAuthError,
      );

      // 1 initial attempt + 4 retries.
      expect(request).toHaveBeenCalledTimes(5);
      expect(retryDelays(sleeps)).toEqual([1000, 2000, 4000, 8000]);
    });

    it('caps the exponential backoff', async () => {
      const { client, sleeps } = makeClient(
        [{ status: 401, data: authFailedBody }],
        { maxRetries: 8, maxBackoffMs: 5000 },
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

  describe('other statuses', () => {
    it('honours Retry-After on 429', async () => {
      const { client, sleeps, request } = makeClient([
        { status: 429, headers: { 'retry-after': '3' } },
        { status: 200, data: [] },
      ]);

      await client.get('/athlete/i225849/activities');

      expect(request).toHaveBeenCalledTimes(2);
      expect(retryDelays(sleeps)).toEqual([3000]);
    });

    it('retries 5xx', async () => {
      const { client, request } = makeClient([
        { status: 503 },
        { status: 200, data: [] },
      ]);

      await client.get('/athlete/i225849/activities');
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

      await expect(client.get('/athlete/i225849/activities')).rejects.toThrow(
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
