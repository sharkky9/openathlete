import { describe, expect, it } from 'vitest';

import { paths } from './paths';

describe('auth routes', () => {
  it('does not expose retired provider OAuth callbacks', () => {
    expect(JSON.stringify(paths.auth)).not.toContain('/callback');
  });
});
