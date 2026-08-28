import { describe, expect, it } from 'vitest';

import { createAuthFetch } from '../src/index.js';
import type { AuthFetchOptions } from '../src/index.js';

const options: AuthFetchOptions = {
  getToken: () => 'token',
  refreshToken: async () => 'fresh-token',
};

describe('package setup', () => {
  it('exports createAuthFetch as a function', () => {
    expect(typeof createAuthFetch).toBe('function');
  });

  it('returns a fetch-compatible function', () => {
    expect(typeof createAuthFetch(options)).toBe('function');
  });
});
