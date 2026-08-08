import { describe, expect, it } from 'vitest';

import {
  API_KEY_PROVIDERS,
  SUPPORTED_CONNECTOR_PROVIDERS,
  isApiKeyProvider,
} from './api-key-providers';

describe('supported connector providers', () => {
  it('exposes only Intervals.icu in the single-user deployment', () => {
    expect(SUPPORTED_CONNECTOR_PROVIDERS).toEqual(['INTERVALS_ICU']);
    expect(API_KEY_PROVIDERS).toEqual(['INTERVALS_ICU']);
    expect(isApiKeyProvider('INTERVALS_ICU')).toBe(true);
  });
});
