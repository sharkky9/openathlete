import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderAPI } from './provider.api';

const { post, setCredentialsRoute } = vi.hoisted(() => ({
  post: vi.fn(),
  setCredentialsRoute: vi.fn(() => '/provider/intervals_icu/credentials'),
}));

vi.mock('@/utils/axios', () => ({
  default: { post },
  routes: {
    provider: {
      setCredentials: setCredentialsRoute,
    },
  },
}));

describe('ProviderAPI.setCredentials', () => {
  beforeEach(() => {
    post.mockReset();
    setCredentialsRoute.mockClear();
  });

  it('omits apiKey so the server can use its configured Intervals.icu key', async () => {
    await ProviderAPI.setCredentials({ provider: 'INTERVALS_ICU' });

    expect(setCredentialsRoute).toHaveBeenCalledWith('INTERVALS_ICU');
    expect(post).toHaveBeenCalledWith(
      '/provider/intervals_icu/credentials',
      {},
    );
  });

  it('sends a supplied personal API key', async () => {
    await ProviderAPI.setCredentials({
      provider: 'INTERVALS_ICU',
      apiKey: 'personal-key',
    });

    expect(post).toHaveBeenCalledWith('/provider/intervals_icu/credentials', {
      apiKey: 'personal-key',
    });
  });
});
