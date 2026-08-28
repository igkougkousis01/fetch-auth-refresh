import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuthFetch } from '../src/index.js';
import type { AuthFetchOptions, FetchLike } from '../src/index.js';

const URL_ = 'https://api.test/resource';

/**
 * A stand-in transport that records the `Request` the library actually sends.
 *
 * Deliberately not a mock of `Request`/`Response`/`Headers`: those are real
 * platform objects, and asserting against them is the whole point.
 */
function createFakeFetch(response: Response = new Response('ok')): {
  fetch: FetchLike;
  calls: Request[];
  sent: () => Request;
} {
  const calls: Request[] = [];
  const fetch: FetchLike = async (input) => {
    calls.push(input as Request);
    return response;
  };
  return {
    fetch,
    calls,
    sent: () => {
      expect(calls).toHaveLength(1);
      return calls[0] as Request;
    },
  };
}

/** `refreshToken` must be supplied by the type, but must never be called yet. */
const neverRefresh = vi.fn(async (): Promise<string> => {
  throw new Error('refreshToken must not be called on this branch');
});

afterEach(() => {
  vi.unstubAllGlobals();
  neverRefresh.mockClear();
});

function options(overrides: Partial<AuthFetchOptions> = {}): AuthFetchOptions {
  return {
    getToken: () => 'token-123',
    refreshToken: neverRefresh,
    ...overrides,
  };
}

describe('createAuthFetch', () => {
  it('is a drop-in for fetch at the type level', () => {
    const authFetch: FetchLike = createAuthFetch(options());
    expect(typeof authFetch).toBe('function');
  });

  it('returns the underlying Response unchanged', async () => {
    const response = new Response('body', { status: 203 });
    const fake = createFakeFetch(response);
    const authFetch = createAuthFetch(options({ fetch: fake.fetch }));

    const result = await authFetch(URL_);

    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    await expect(result.text()).resolves.toBe('body');
  });

  it('calls getToken once for an outgoing request', async () => {
    const fake = createFakeFetch();
    const getToken = vi.fn(() => 'token-123');
    const authFetch = createAuthFetch(options({ getToken, fetch: fake.fetch }));

    await authFetch(URL_);

    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('adds Authorization: Bearer <token>', async () => {
    const fake = createFakeFetch();
    const authFetch = createAuthFetch(options({ fetch: fake.fetch }));

    await authFetch(URL_);

    expect(fake.sent().headers.get('authorization')).toBe('Bearer token-123');
  });

  it('sends no Authorization header when getToken returns null', async () => {
    const fake = createFakeFetch();
    const authFetch = createAuthFetch(options({ getToken: () => null, fetch: fake.fetch }));

    await authFetch(URL_);

    expect(fake.sent().headers.has('authorization')).toBe(false);
  });

  it('preserves a caller-provided Authorization header and skips the token provider', async () => {
    const fake = createFakeFetch();
    const getToken = vi.fn(() => 'token-123');
    const authFetch = createAuthFetch(options({ getToken, fetch: fake.fetch }));

    await authFetch(URL_, { headers: { Authorization: 'Basic Zm9vOmJhcg==' } });

    expect(fake.sent().headers.get('authorization')).toBe('Basic Zm9vOmJhcg==');
    expect(getToken).not.toHaveBeenCalled();
  });

  it('preserves a caller-provided Authorization header set on a Request', async () => {
    const fake = createFakeFetch();
    const authFetch = createAuthFetch(options({ fetch: fake.fetch }));

    await authFetch(new Request(URL_, { headers: { authorization: 'Token abc' } }));

    expect(fake.sent().headers.get('authorization')).toBe('Token abc');
  });

  it('supports an asynchronous token provider', async () => {
    const fake = createFakeFetch();
    const getToken = async (): Promise<string> => {
      await Promise.resolve();
      return 'async-token';
    };
    const authFetch = createAuthFetch(options({ getToken, fetch: fake.fetch }));

    await authFetch(URL_);

    expect(fake.sent().headers.get('authorization')).toBe('Bearer async-token');
  });

  it('uses the injected fetch instead of the global one', async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    const fake = createFakeFetch();
    const authFetch = createAuthFetch(options({ fetch: fake.fetch }));

    await authFetch(URL_);

    expect(fake.calls).toHaveLength(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('falls back to globalThis.fetch when none is injected', async () => {
    const response = new Response('global');
    const globalFetch = vi.fn(async () => response);
    vi.stubGlobal('fetch', globalFetch);
    const authFetch = createAuthFetch(options());

    await expect(authFetch(URL_)).resolves.toBe(response);
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });

  it('accepts string, URL, and Request input', async () => {
    const fake = createFakeFetch();
    const authFetch = createAuthFetch(options({ fetch: fake.fetch }));

    await authFetch(URL_);
    await authFetch(new URL(URL_));
    await authFetch(new Request(URL_));

    expect(fake.calls.map((request) => request.url)).toEqual([URL_, URL_, URL_]);
    for (const request of fake.calls) {
      expect(request.headers.get('authorization')).toBe('Bearer token-123');
    }
  });

  it('preserves the request method', async () => {
    const fake = createFakeFetch();
    const authFetch = createAuthFetch(options({ fetch: fake.fetch }));

    await authFetch(URL_, { method: 'DELETE' });
    await authFetch(new Request(URL_, { method: 'PUT' }));

    expect(fake.calls.map((request) => request.method)).toEqual(['DELETE', 'PUT']);
  });

  it('preserves the request body', async () => {
    const fake = createFakeFetch();
    const authFetch = createAuthFetch(options({ fetch: fake.fetch }));

    await authFetch(URL_, { method: 'POST', body: '{"hello":"world"}' });

    const sent = fake.sent();
    expect(sent.method).toBe('POST');
    await expect(sent.text()).resolves.toBe('{"hello":"world"}');
  });

  it('preserves the body of a Request input', async () => {
    const fake = createFakeFetch();
    const authFetch = createAuthFetch(options({ fetch: fake.fetch }));

    await authFetch(new Request(URL_, { method: 'POST', body: 'payload' }));

    await expect(fake.sent().text()).resolves.toBe('payload');
  });

  it('preserves existing headers alongside the token', async () => {
    const fake = createFakeFetch();
    const authFetch = createAuthFetch(options({ fetch: fake.fetch }));

    await authFetch(
      new Request(URL_, { headers: { 'X-Request-Id': 'abc', Accept: 'application/json' } }),
    );

    const sent = fake.sent();
    expect(sent.headers.get('x-request-id')).toBe('abc');
    expect(sent.headers.get('accept')).toBe('application/json');
    expect(sent.headers.get('authorization')).toBe('Bearer token-123');
  });

  it('preserves credentials', async () => {
    const fake = createFakeFetch();
    const authFetch = createAuthFetch(options({ fetch: fake.fetch }));

    await authFetch(URL_, { credentials: 'include' });

    expect(fake.sent().credentials).toBe('include');
  });

  it('preserves the AbortSignal', async () => {
    const fake = createFakeFetch();
    const authFetch = createAuthFetch(options({ fetch: fake.fetch }));
    const controller = new AbortController();

    await authFetch(URL_, { signal: controller.signal });

    const sent = fake.sent();
    expect(sent.signal.aborted).toBe(false);
    controller.abort();
    expect(sent.signal.aborted).toBe(true);
  });

  it('preserves an AbortSignal carried by a Request input', async () => {
    const fake = createFakeFetch();
    const authFetch = createAuthFetch(options({ fetch: fake.fetch }));
    const controller = new AbortController();

    await authFetch(new Request(URL_, { signal: controller.signal }));

    const sent = fake.sent();
    expect(sent.signal.aborted).toBe(false);
    controller.abort();
    expect(sent.signal.aborted).toBe(true);
  });

  it('uses a custom attachToken when supplied', async () => {
    const fake = createFakeFetch();
    const attachToken = vi.fn((request: Request, token: string) => {
      const authenticated = new Request(request, {
        headers: new Headers(request.headers),
      });
      authenticated.headers.set('X-Api-Key', token);
      return authenticated;
    });
    const authFetch = createAuthFetch(options({ attachToken, fetch: fake.fetch }));

    await authFetch(URL_, { headers: { 'X-Trace': 'on' } });

    const sent = fake.sent();
    expect(attachToken).toHaveBeenCalledTimes(1);
    expect(sent.headers.get('x-api-key')).toBe('token-123');
    expect(sent.headers.get('x-trace')).toBe('on');
    expect(sent.headers.has('authorization')).toBe(false);
  });

  it('does not call attachToken when there is no token', async () => {
    const fake = createFakeFetch();
    const attachToken = vi.fn((request: Request) => request);
    const authFetch = createAuthFetch(
      options({ getToken: () => null, attachToken, fetch: fake.fetch }),
    );

    await authFetch(URL_);

    expect(attachToken).not.toHaveBeenCalled();
  });

  it('supports an asynchronous attachToken', async () => {
    const fake = createFakeFetch();
    const attachToken = async (request: Request, token: string): Promise<Request> => {
      await Promise.resolve();
      request.headers.set('X-Api-Key', token);
      return request;
    };
    const authFetch = createAuthFetch(options({ attachToken, fetch: fake.fetch }));

    await authFetch(URL_);

    expect(fake.sent().headers.get('x-api-key')).toBe('token-123');
  });

  it('never hands a caller-owned Request to attachToken', async () => {
    const fake = createFakeFetch();
    const callerRequest = new Request(URL_);
    let received: Request | undefined;
    const attachToken = (request: Request): Request => {
      received = request;
      return request;
    };
    const authFetch = createAuthFetch(options({ attachToken, fetch: fake.fetch }));

    await authFetch(callerRequest);

    expect(received).toBeInstanceOf(Request);
    expect(received).not.toBe(callerRequest);
  });

  it('returns a 401 unchanged and triggers no refresh behaviour', async () => {
    const unauthorized = new Response('nope', { status: 401 });
    const fake = createFakeFetch(unauthorized);
    const isAuthFailure = vi.fn(() => true);
    const onAuthFailure = vi.fn();
    const authFetch = createAuthFetch(
      options({ isAuthFailure, onAuthFailure, fetch: fake.fetch }),
    );

    const response = await authFetch('https://api.test/private');

    expect(response).toBe(unauthorized);
    expect(response.status).toBe(401);
    expect(response.bodyUsed).toBe(false);
    await expect(response.text()).resolves.toBe('nope');
    expect(neverRefresh).not.toHaveBeenCalled();
    expect(isAuthFailure).not.toHaveBeenCalled();
    expect(onAuthFailure).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(1);
  });

  it('does not mutate caller-owned Headers or Request objects', async () => {
    const fake = createFakeFetch();
    const headers = new Headers({ 'X-Custom': '1' });
    const callerRequest = new Request(URL_, { headers });
    const authFetch = createAuthFetch(options({ fetch: fake.fetch }));

    await authFetch(callerRequest);

    expect(headers.has('authorization')).toBe(false);
    expect(callerRequest.headers.has('authorization')).toBe(false);
    expect(fake.sent()).not.toBe(callerRequest);
    expect(fake.sent().headers.get('authorization')).toBe('Bearer token-123');
  });

  it('merges a Request input with a RequestInit using native semantics', async () => {
    const fake = createFakeFetch();
    const authFetch = createAuthFetch(options({ fetch: fake.fetch }));

    // Native `new Request(request, init)` *replaces* the header list when
    // `init.headers` is present; it does not merge. The library relies on the
    // platform here rather than hand-rolling a merge.
    await authFetch(new Request(URL_, { method: 'POST', headers: { 'X-A': '1' } }), {
      headers: { 'X-B': '2' },
    });

    const sent = fake.sent();
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('x-b')).toBe('2');
    expect(sent.headers.has('x-a')).toBe(false);
  });

  it('preserves `this` for a policy object implementing the options interface', async () => {
    const fake = createFakeFetch();

    class Policy implements AuthFetchOptions {
      readonly token = 'from-this';
      constructor(readonly fetch: FetchLike) {}
      getToken(): string {
        return this.token;
      }
      async refreshToken(): Promise<string> {
        throw new Error('refreshToken must not be called on this branch');
      }
    }

    const authFetch = createAuthFetch(new Policy(fake.fetch));

    await authFetch(URL_);

    expect(fake.sent().headers.get('authorization')).toBe('Bearer from-this');
  });

  it('reports a missing transport clearly', async () => {
    vi.stubGlobal('fetch', undefined);
    const authFetch = createAuthFetch(options());

    await expect(authFetch(URL_)).rejects.toThrow(/No fetch implementation available/);
  });
});
