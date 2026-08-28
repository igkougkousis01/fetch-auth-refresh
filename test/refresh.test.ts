import { describe, expect, it, vi } from 'vitest';

import { createAuthFetch } from '../src/index.js';
import type { AuthFetchOptions, FetchLike } from '../src/index.js';

const URL_ = 'https://api.test/resource';

const unauthorized = (body = 'unauthorized'): Response => new Response(body, { status: 401 });
const ok = (body = 'ok'): Response => new Response(body, { status: 200 });

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Drains the microtask queue.
 *
 * Nothing in the library uses timers, so "everything that could happen has
 * happened" is reached by turning the microtask queue over a bounded number of
 * times — deterministic, unlike a `setTimeout` sleep. Used only to assert that
 * something did *not* happen; positive progress is awaited through
 * `transport.untilAttempts()`.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

interface Attempt {
  readonly request: Request;
  /** Completes this transport call with a response. */
  readonly respond: (response: Response) => void;
  /** Fails this transport call, as a network error would. */
  readonly fail: (reason: unknown) => void;
  readonly token: string | null;
}

/**
 * A transport that records every call and, by default, hands the test explicit
 * control over when each one completes.
 *
 * Like a real `fetch`, a pending call rejects when the request's signal aborts.
 * Passing a `handler` switches to auto-responding for tests that do not need to
 * control timing.
 */
function createTransport(handler?: (request: Request, index: number) => Response): {
  fetch: FetchLike;
  attempts: Attempt[];
  untilAttempts: (count: number) => Promise<void>;
} {
  const attempts: Attempt[] = [];
  const watchers: Array<{ count: number; resolve: () => void }> = [];

  const announce = (): void => {
    for (let index = watchers.length - 1; index >= 0; index -= 1) {
      const watcher = watchers[index]!;
      if (attempts.length >= watcher.count) {
        watchers.splice(index, 1);
        watcher.resolve();
      }
    }
  };

  const fetch: FetchLike = (input) => {
    const request = input as Request;
    const settled = deferred<Response>();
    const index = attempts.length;

    attempts.push({
      request,
      respond: settled.resolve,
      fail: settled.reject,
      token: request.headers.get('authorization'),
    });
    announce();

    if (handler) return Promise.resolve(handler(request, index));

    request.signal.addEventListener('abort', () => settled.reject(request.signal.reason), {
      once: true,
    });
    return settled.promise;
  };

  return {
    fetch,
    attempts,
    untilAttempts: (count) => {
      if (attempts.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => watchers.push({ count, resolve }));
    },
  };
}

/** Responds 401 to every unretried request, 200 once a fresh token is presented. */
function refreshAwareHandler(freshToken: string) {
  return (request: Request): Response =>
    request.headers.get('authorization') === `Bearer ${freshToken}` ? ok() : unauthorized();
}

function options(overrides: Partial<AuthFetchOptions> = {}): AuthFetchOptions {
  return {
    getToken: () => 'stale',
    refreshToken: async () => 'fresh',
    ...overrides,
  };
}

describe('authentication failure classification', () => {
  it('treats a 401 as an auth failure by default and refreshes (1)', async () => {
    const transport = createTransport(refreshAwareHandler('fresh'));
    const refreshToken = vi.fn(async () => 'fresh');
    const authFetch = createAuthFetch(options({ refreshToken, fetch: transport.fetch }));

    const response = await authFetch(URL_);

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(transport.attempts).toHaveLength(2);
  });

  it('does not refresh for a non-401 response (2)', async () => {
    const transport = createTransport(() => new Response('teapot', { status: 418 }));
    const refreshToken = vi.fn(async () => 'fresh');
    const authFetch = createAuthFetch(options({ refreshToken, fetch: transport.fetch }));

    const response = await authFetch(URL_);

    expect(response.status).toBe(418);
    expect(refreshToken).not.toHaveBeenCalled();
    expect(transport.attempts).toHaveLength(1);
  });

  it('uses a custom synchronous isAuthFailure (3)', async () => {
    const transport = createTransport((request) =>
      request.headers.get('authorization') === 'Bearer fresh'
        ? ok()
        : new Response('nope', { status: 419 }),
    );
    const refreshToken = vi.fn(async () => 'fresh');
    const isAuthFailure = vi.fn((response: Response) => response.status === 419);
    const authFetch = createAuthFetch(
      options({ isAuthFailure, refreshToken, fetch: transport.fetch }),
    );

    const response = await authFetch(URL_);

    expect(isAuthFailure).toHaveBeenCalled();
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it('uses a custom asynchronous isAuthFailure (4)', async () => {
    const transport = createTransport((request) =>
      request.headers.get('authorization') === 'Bearer fresh'
        ? ok()
        : new Response(JSON.stringify({ code: 'token_expired' }), { status: 400 }),
    );
    const refreshToken = vi.fn(async () => 'fresh');
    const isAuthFailure = async (response: Response): Promise<boolean> => {
      if (response.status !== 400) return false;
      const body = (await response.json()) as { code?: string };
      return body.code === 'token_expired';
    };
    const authFetch = createAuthFetch(
      options({ isAuthFailure, refreshToken, fetch: transport.fetch }),
    );

    const response = await authFetch(URL_);

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it('gives the classifier a clone, leaving the returned response readable (5, 29)', async () => {
    const original = new Response('body-the-classifier-reads', { status: 200 });
    const transport = createTransport(() => original);
    const seen: string[] = [];
    const isAuthFailure = async (response: Response): Promise<boolean> => {
      seen.push(await response.text());
      expect(response.bodyUsed).toBe(true);
      return false;
    };
    const authFetch = createAuthFetch(options({ isAuthFailure, fetch: transport.fetch }));

    const response = await authFetch(URL_);

    expect(seen).toEqual(['body-the-classifier-reads']);
    expect(response).toBe(original);
    expect(response.bodyUsed).toBe(false);
    await expect(response.text()).resolves.toBe('body-the-classifier-reads');
  });

  it('gives refreshToken a clone, leaving the retried response readable (29)', async () => {
    const transport = createTransport((request) =>
      request.headers.get('authorization') === 'Bearer fresh'
        ? ok('retry-body')
        : unauthorized('failure-detail'),
    );
    const bodies: string[] = [];
    const refreshToken = async (context: {
      response: Response;
      rejectedToken: string | null;
    }): Promise<string> => {
      bodies.push(await context.response.text());
      expect(context.rejectedToken).toBe('stale');
      return 'fresh';
    };
    const authFetch = createAuthFetch(options({ refreshToken, fetch: transport.fetch }));

    const response = await authFetch(URL_);

    expect(bodies).toEqual(['failure-detail']);
    expect(response.bodyUsed).toBe(false);
    await expect(response.text()).resolves.toBe('retry-body');
  });

  it('gives onAuthFailure a clone it can read in full (29)', async () => {
    const transport = createTransport(() => unauthorized('failure-detail'));
    const bodies: string[] = [];
    const onAuthFailure = async (context: { response: Response }): Promise<void> => {
      bodies.push(await context.response.text());
    };
    const authFetch = createAuthFetch(
      options({
        refreshToken: async () => {
          throw new Error('session expired');
        },
        onAuthFailure,
        fetch: transport.fetch,
      }),
    );

    await expect(authFetch(URL_)).rejects.toThrow('session expired');

    expect(bodies).toEqual(['failure-detail']);
  });
});

describe('refresh and retry', () => {
  it('retries the request after a successful refresh (6)', async () => {
    const transport = createTransport(refreshAwareHandler('fresh'));
    const authFetch = createAuthFetch(options({ fetch: transport.fetch }));

    const response = await authFetch(URL_);

    expect(response.status).toBe(200);
    expect(transport.attempts[0]?.token).toBe('Bearer stale');
    expect(transport.attempts[1]?.token).toBe('Bearer fresh');
  });

  it('retries with the token refreshToken returned (7)', async () => {
    const transport = createTransport(refreshAwareHandler('returned-token'));
    const authFetch = createAuthFetch(
      options({ refreshToken: async () => 'returned-token', fetch: transport.fetch }),
    );

    await authFetch(URL_);

    expect(transport.attempts[1]?.token).toBe('Bearer returned-token');
  });

  it('does not re-read getToken to obtain the retry token (8)', async () => {
    const transport = createTransport(refreshAwareHandler('fresh'));
    // A store that has not been written back yet: re-reading it would retry
    // with the token that was just rejected.
    const getToken = vi.fn(() => 'stale');
    const authFetch = createAuthFetch(options({ getToken, fetch: transport.fetch }));

    await authFetch(URL_);

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(transport.attempts[1]?.token).toBe('Bearer fresh');
  });

  it('retries exactly once (9)', async () => {
    const transport = createTransport(refreshAwareHandler('fresh'));
    const authFetch = createAuthFetch(options({ fetch: transport.fetch }));

    await authFetch(URL_);

    expect(transport.attempts).toHaveLength(2);
  });

  it('returns a retry that fails again without refreshing twice (10)', async () => {
    const transport = createTransport(() => unauthorized('still-401'));
    const refreshToken = vi.fn(async () => 'fresh');
    const authFetch = createAuthFetch(options({ refreshToken, fetch: transport.fetch }));

    const response = await authFetch(URL_);

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('still-401');
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(transport.attempts).toHaveLength(2);
  });

  it('does not call onAuthFailure when the retry itself comes back 401 (10)', async () => {
    // The refresh succeeded, so the session was recovered. A retry the server
    // still refuses is that request's business — it must not fire a
    // session-wide logout or navigation.
    const transport = createTransport(() => unauthorized('still-401'));
    const onAuthFailure = vi.fn();
    const isAuthFailure = vi.fn((response: Response) => response.status === 401);
    const authFetch = createAuthFetch(
      options({ onAuthFailure, isAuthFailure, fetch: transport.fetch }),
    );

    const response = await authFetch(URL_);

    expect(onAuthFailure).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('still-401');
    // The retry's response is returned unclassified: no second look.
    expect(isAuthFailure).toHaveBeenCalledTimes(1);
  });

  it('uses the custom attachToken on the retry (11)', async () => {
    const transport = createTransport((request) =>
      request.headers.get('x-api-key') === 'fresh' ? ok() : unauthorized(),
    );
    const attachToken = vi.fn((request: Request, token: string) => {
      request.headers.set('X-Api-Key', token);
      return request;
    });
    const authFetch = createAuthFetch(options({ attachToken, fetch: transport.fetch }));

    const response = await authFetch(URL_, { headers: { 'X-Trace': 'on' } });

    expect(response.status).toBe(200);
    expect(attachToken).toHaveBeenCalledTimes(2);
    const retry = transport.attempts[1]!.request;
    expect(retry.headers.get('x-api-key')).toBe('fresh');
    expect(retry.headers.get('x-trace')).toBe('on');
    // The replay copy is taken before the rejected credential is attached, so
    // nothing has to be stripped from it.
    expect(retry.headers.has('authorization')).toBe(false);
  });
});

describe('single-flight refresh', () => {
  it.each([20, 100])(
    '%i simultaneous 401s trigger exactly one refresh, all retried with the same token (12, 13, 14)',
    async (count) => {
      const transport = createTransport();
      const release = deferred<string>();
      const refreshToken = vi.fn(() => release.promise);
      const authFetch = createAuthFetch(options({ refreshToken, fetch: transport.fetch }));

      const requests = Array.from({ length: count }, (_, index) =>
        authFetch(`${URL_}/${index}`),
      );

      await transport.untilAttempts(count);
      expect(transport.attempts).toHaveLength(count);
      expect(refreshToken).not.toHaveBeenCalled();

      for (const attempt of transport.attempts) attempt.respond(unauthorized());
      await settle();

      // Every one of them failed authentication, and together they produced a
      // single refresh operation.
      expect(refreshToken).toHaveBeenCalledTimes(1);
      expect(transport.attempts).toHaveLength(count);

      release.resolve('one-fresh-token');
      await transport.untilAttempts(count * 2);
      await settle();

      const retries = transport.attempts.slice(count);
      expect(retries).toHaveLength(count);
      expect(retries.every((attempt) => attempt.token === 'Bearer one-fresh-token')).toBe(true);

      for (const attempt of retries) attempt.respond(ok());
      const responses = await Promise.all(requests);

      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(refreshToken).toHaveBeenCalledTimes(1);
    },
  );

  it('still refreshes once when the failures are classified after it settled (12, 13, 14)', async () => {
    // The failures all arrive with the same token, but are classified one at a
    // time — an async `isAuthFailure` that reads a body is enough to cause
    // this. By the time the second one is classified the first refresh has
    // already finished and cleared the shared slot, so nothing is in flight to
    // join. They must still not each start their own refresh.
    const transport = createTransport();
    const refreshToken = vi.fn(async () => 'fresh');
    const authFetch = createAuthFetch(options({ refreshToken, fetch: transport.fetch }));

    const requests = Array.from({ length: 100 }, (_, index) => authFetch(`${URL_}/${index}`));
    await transport.untilAttempts(100);

    // Only the first failure lands; its refresh runs to completion.
    transport.attempts[0]!.respond(unauthorized());
    await transport.untilAttempts(101);
    await settle();
    expect(refreshToken).toHaveBeenCalledTimes(1);

    // Now the other 99 failures are classified, with no refresh in flight.
    for (const attempt of transport.attempts.slice(1, 100)) attempt.respond(unauthorized());
    await transport.untilAttempts(200);
    await settle();

    expect(refreshToken).toHaveBeenCalledTimes(1);
    const retries = transport.attempts.slice(100);
    expect(retries).toHaveLength(100);
    expect(retries.every((attempt) => attempt.token === 'Bearer fresh')).toBe(true);

    for (const attempt of retries) attempt.respond(ok());
    const responses = await Promise.all(requests);
    expect(responses.every((response) => response.status === 200)).toBe(true);
  });

  it('still fails once when the failures are classified after the refresh rejected (17, 18)', async () => {
    const transport = createTransport();
    const failure = new Error('session expired');
    const refreshToken = vi.fn(async () => {
      throw failure;
    });
    const onAuthFailure = vi.fn();
    const authFetch = createAuthFetch(
      options({ refreshToken, onAuthFailure, fetch: transport.fetch }),
    );

    const requests = Array.from({ length: 50 }, (_, index) => authFetch(`${URL_}/${index}`));
    await transport.untilAttempts(50);

    transport.attempts[0]!.respond(unauthorized());
    await expect(requests[0]).rejects.toBe(failure);
    expect(refreshToken).toHaveBeenCalledTimes(1);

    for (const attempt of transport.attempts.slice(1)) attempt.respond(unauthorized());
    const settled = await Promise.allSettled(requests.slice(1));

    // Stragglers share the outcome of the operation they belong to rather than
    // each retrying the refresh.
    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
    expect(settled.every((result) => (result as PromiseRejectedResult).reason === failure)).toBe(
      true,
    );
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(transport.attempts).toHaveLength(50);
  });

  it('makes requests that start during a refresh wait before hitting the transport (15, 16)', async () => {
    const transport = createTransport();
    const release = deferred<string>();
    const getToken = vi.fn(() => 'stale');
    const authFetch = createAuthFetch(
      options({ getToken, refreshToken: () => release.promise, fetch: transport.fetch }),
    );

    const first = authFetch(`${URL_}/a`);
    await transport.untilAttempts(1);
    transport.attempts[0]!.respond(unauthorized());
    await settle();

    // The refresh is now in flight. Two fresh requests start.
    const second = authFetch(`${URL_}/b`);
    const third = authFetch(`${URL_}/c`);
    await settle();

    expect(transport.attempts).toHaveLength(1);
    // They must not even ask for the token they would have been sent with.
    expect(getToken).toHaveBeenCalledTimes(1);

    release.resolve('fresh');
    await transport.untilAttempts(4);
    await settle();

    const later = transport.attempts.slice(1);
    expect(later).toHaveLength(3);
    expect(later.every((attempt) => attempt.token === 'Bearer fresh')).toBe(true);
    // No avoidable extra 401s: b and c were each sent exactly once.
    expect(later.map((attempt) => attempt.request.url).sort()).toEqual([
      `${URL_}/a`,
      `${URL_}/b`,
      `${URL_}/c`,
    ]);

    for (const attempt of later) attempt.respond(ok());
    for (const response of await Promise.all([first, second, third])) {
      expect(response.status).toBe(200);
    }
    expect(getToken).toHaveBeenCalledTimes(1);
  });
});

describe('refresh failure', () => {
  it('fans a rejection out to every waiter without starting replacements (17)', async () => {
    const transport = createTransport();
    const release = deferred<string>();
    const refreshToken = vi.fn(() => release.promise);
    const authFetch = createAuthFetch(options({ refreshToken, fetch: transport.fetch }));

    const requests = [0, 1, 2].map((index) => authFetch(`${URL_}/${index}`));
    await transport.untilAttempts(3);
    for (const attempt of transport.attempts) attempt.respond(unauthorized());
    await settle();

    const failure = new Error('session expired');
    release.reject(failure);

    for (const request of requests) await expect(request).rejects.toBe(failure);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(transport.attempts).toHaveLength(3);
  });

  it('rejects requests that were waiting to be sent, without sending them (17)', async () => {
    const transport = createTransport();
    const release = deferred<string>();
    const authFetch = createAuthFetch(
      options({ refreshToken: () => release.promise, fetch: transport.fetch }),
    );

    const first = authFetch(`${URL_}/a`);
    await transport.untilAttempts(1);
    transport.attempts[0]!.respond(unauthorized());
    await settle();

    const waiting = authFetch(`${URL_}/b`);
    await settle();
    expect(transport.attempts).toHaveLength(1);

    const failure = new Error('session expired');
    release.reject(failure);

    await expect(first).rejects.toBe(failure);
    await expect(waiting).rejects.toBe(failure);
    expect(transport.attempts).toHaveLength(1);
  });

  it('calls onAuthFailure once per failed shared refresh, not once per waiter (18)', async () => {
    const transport = createTransport();
    const release = deferred<string>();
    const onAuthFailure = vi.fn();
    const authFetch = createAuthFetch(
      options({ refreshToken: () => release.promise, onAuthFailure, fetch: transport.fetch }),
    );

    const requests = Array.from({ length: 100 }, (_, index) => authFetch(`${URL_}/${index}`));
    await transport.untilAttempts(100);
    for (const attempt of transport.attempts) attempt.respond(unauthorized());
    await settle();

    release.reject(new Error('session expired'));
    await Promise.allSettled(requests);

    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });

  it('does not let a throwing onAuthFailure replace the refresh error (30)', async () => {
    const transport = createTransport(() => unauthorized());
    const failure = new Error('session expired');
    const authFetch = createAuthFetch(
      options({
        refreshToken: async () => {
          throw failure;
        },
        onAuthFailure: () => {
          throw new Error('logout blew up');
        },
        fetch: transport.fetch,
      }),
    );

    await expect(authFetch(URL_)).rejects.toBe(failure);
  });

  it('contains a throwing onAuthFailure identically whether or not the runtime has reportError (30)', async () => {
    // Behaviour must not depend on a global that some runtimes have and others
    // do not, so the callback's error is swallowed in both cases.
    const failure = new Error('session expired');
    const run = async (): Promise<unknown> => {
      const transport = createTransport(() => unauthorized());
      const authFetch = createAuthFetch(
        options({
          refreshToken: async () => {
            throw failure;
          },
          onAuthFailure: () => {
            throw new Error('logout blew up');
          },
          fetch: transport.fetch,
        }),
      );
      return authFetch(URL_).then(
        () => 'resolved',
        (error: unknown) => error,
      );
    };

    const reportError = vi.fn();
    vi.stubGlobal('reportError', reportError);
    expect(await run()).toBe(failure);
    expect(reportError).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    expect(await run()).toBe(failure);
  });

  it('waits for a slow onAuthFailure without letting it reshape the error (30)', async () => {
    const transport = createTransport(() => unauthorized());
    const failure = new Error('session expired');
    const gate = deferred<void>();
    const calls: string[] = [];
    const authFetch = createAuthFetch(
      options({
        refreshToken: async () => {
          throw failure;
        },
        onAuthFailure: async () => {
          calls.push('start');
          await gate.promise;
          calls.push('end');
          throw new Error('logout blew up late');
        },
        fetch: transport.fetch,
      }),
    );

    const request = authFetch(URL_).catch((error: unknown) => error);
    await settle();
    expect(calls).toEqual(['start']);

    gate.resolve();

    expect(await request).toBe(failure);
    expect(calls).toEqual(['start', 'end']);
  });
});

describe('shared refresh state', () => {
  it('clears after a successful refresh (19, 21)', async () => {
    const transport = createTransport();
    const refreshToken = vi.fn(async () => `fresh-${refreshToken.mock.calls.length}`);
    const authFetch = createAuthFetch(options({ refreshToken, fetch: transport.fetch }));

    const first = authFetch(`${URL_}/a`);
    await transport.untilAttempts(1);
    transport.attempts[0]!.respond(unauthorized());
    await transport.untilAttempts(2);
    transport.attempts[1]!.respond(ok());
    await expect(first).resolves.toMatchObject({ status: 200 });
    expect(refreshToken).toHaveBeenCalledTimes(1);

    // A later, independent authentication failure starts a brand new operation.
    const second = authFetch(`${URL_}/b`);
    await transport.untilAttempts(3);
    transport.attempts[2]!.respond(unauthorized());
    await transport.untilAttempts(4);

    expect(refreshToken).toHaveBeenCalledTimes(2);
    expect(transport.attempts[3]?.token).toBe('Bearer fresh-2');
    transport.attempts[3]!.respond(ok());
    await expect(second).resolves.toMatchObject({ status: 200 });
  });

  it('clears after a failed refresh (20, 21)', async () => {
    const transport = createTransport();
    let attempt = 0;
    const refreshToken = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('first refresh failed');
      return 'fresh';
    });
    const authFetch = createAuthFetch(options({ refreshToken, fetch: transport.fetch }));

    const first = authFetch(`${URL_}/a`);
    await transport.untilAttempts(1);
    transport.attempts[0]!.respond(unauthorized());
    await expect(first).rejects.toThrow('first refresh failed');
    expect(refreshToken).toHaveBeenCalledTimes(1);

    const second = authFetch(`${URL_}/b`);
    await transport.untilAttempts(2);
    transport.attempts[1]!.respond(unauthorized());
    await transport.untilAttempts(3);

    expect(refreshToken).toHaveBeenCalledTimes(2);
    expect(transport.attempts[2]?.token).toBe('Bearer fresh');
    transport.attempts[2]!.respond(ok());
    await expect(second).resolves.toMatchObject({ status: 200 });
  });
});

describe('caller-provided Authorization', () => {
  it('bypasses the entire authentication lifecycle (22)', async () => {
    const transport = createTransport(() => unauthorized('caller-owned 401'));
    const getToken = vi.fn(() => 'stale');
    const attachToken = vi.fn((request: Request) => request);
    const refreshToken = vi.fn(async () => 'fresh');
    const isAuthFailure = vi.fn(() => true);
    const onAuthFailure = vi.fn();
    const authFetch = createAuthFetch({
      getToken,
      attachToken,
      refreshToken,
      isAuthFailure,
      onAuthFailure,
      fetch: transport.fetch,
    });

    const response = await authFetch(URL_, { headers: { Authorization: 'Basic Zm9vOmJhcg==' } });

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('caller-owned 401');
    expect(transport.attempts).toHaveLength(1);
    expect(transport.attempts[0]?.token).toBe('Basic Zm9vOmJhcg==');
    expect(getToken).not.toHaveBeenCalled();
    expect(attachToken).not.toHaveBeenCalled();
    expect(isAuthFailure).not.toHaveBeenCalled();
    expect(refreshToken).not.toHaveBeenCalled();
    expect(onAuthFailure).not.toHaveBeenCalled();
  });
});

describe('request replay', () => {
  it('replays a GET, preserving method, url, and headers (23)', async () => {
    const transport = createTransport(refreshAwareHandler('fresh'));
    const authFetch = createAuthFetch(options({ fetch: transport.fetch }));

    await authFetch(URL_, { headers: { 'X-Request-Id': 'abc' } });

    const retry = transport.attempts[1]!.request;
    expect(retry.method).toBe('GET');
    expect(retry.url).toBe(URL_);
    expect(retry.headers.get('x-request-id')).toBe('abc');
    expect(retry.headers.get('authorization')).toBe('Bearer fresh');
  });

  it('replays a POST text body exactly (24)', async () => {
    const transport = createTransport(refreshAwareHandler('fresh'));
    const authFetch = createAuthFetch(options({ fetch: transport.fetch }));

    await authFetch(URL_, { method: 'POST', body: 'plain text payload' });

    const [first, second] = transport.attempts;
    expect(second!.request.method).toBe('POST');
    await expect(first!.request.text()).resolves.toBe('plain text payload');
    await expect(second!.request.text()).resolves.toBe('plain text payload');
  });

  it('replays a POST JSON body exactly (25)', async () => {
    const transport = createTransport(refreshAwareHandler('fresh'));
    const authFetch = createAuthFetch(options({ fetch: transport.fetch }));
    const payload = { hello: 'world', nested: [1, 2, 3] };

    await authFetch(URL_, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
    });

    const retry = transport.attempts[1]!.request;
    expect(retry.headers.get('content-type')).toBe('application/json');
    await expect(retry.json()).resolves.toEqual(payload);
  });

  it('replays a Request input (26)', async () => {
    const transport = createTransport(refreshAwareHandler('fresh'));
    const authFetch = createAuthFetch(options({ fetch: transport.fetch }));

    await authFetch(
      new Request(URL_, {
        method: 'PATCH',
        body: 'from a Request',
        headers: { 'X-Trace': 'on' },
      }),
    );

    const retry = transport.attempts[1]!.request;
    expect(retry.method).toBe('PATCH');
    expect(retry.headers.get('x-trace')).toBe('on');
    await expect(retry.text()).resolves.toBe('from a Request');
  });

  it('takes the replay copy before the rejected credential is attached (11, 26)', async () => {
    const transport = createTransport((request) =>
      request.headers.get('x-token') === 'fresh' ? ok() : unauthorized(),
    );
    // An *appending* attachToken: if the replay copy were taken after the first
    // attachment, the retry would carry the rejected token alongside the fresh
    // one.
    const attachToken = (request: Request, token: string): Request => {
      request.headers.append('X-Token', token);
      return request;
    };
    const authFetch = createAuthFetch(options({ attachToken, fetch: transport.fetch }));

    const response = await authFetch(URL_);

    expect(response.status).toBe(200);
    expect(transport.attempts[0]?.request.headers.get('x-token')).toBe('stale');
    expect(transport.attempts[1]?.request.headers.get('x-token')).toBe('fresh');
  });

  it('replays a stream body, which the platform tees (26)', async () => {
    const transport = createTransport(refreshAwareHandler('fresh'));
    const authFetch = createAuthFetch(options({ fetch: transport.fetch }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed body'));
        controller.close();
      },
    });

    // `duplex` is required by the Fetch standard for a stream body; TypeScript's
    // DOM lib does not declare it yet, hence the cast.
    await authFetch(URL_, {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);

    const retry = transport.attempts[1]!.request;
    await expect(retry.text()).resolves.toBe('streamed body');
  });
});

describe('AbortSignal', () => {
  it('rejects a request that is already aborted, without sending it (1)', async () => {
    const transport = createTransport();
    const getToken = vi.fn(() => 'stale');
    const authFetch = createAuthFetch(options({ getToken, fetch: transport.fetch }));
    const controller = new AbortController();
    const reason = new Error('too late');
    controller.abort(reason);

    await expect(authFetch(URL_, { signal: controller.signal })).rejects.toBe(reason);
    expect(transport.attempts).toHaveLength(0);
    expect(getToken).not.toHaveBeenCalled();
  });

  it('propagates an abort during the initial fetch (2)', async () => {
    const transport = createTransport();
    const refreshToken = vi.fn(async () => 'fresh');
    const authFetch = createAuthFetch(options({ refreshToken, fetch: transport.fetch }));
    const controller = new AbortController();

    const request = authFetch(URL_, { signal: controller.signal });
    await transport.untilAttempts(1);
    const reason = new Error('user navigated away');
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(refreshToken).not.toHaveBeenCalled();
    expect(transport.attempts).toHaveLength(1);
  });

  it('aborts a request waiting for a refresh, and never retries it (3, 27)', async () => {
    const transport = createTransport();
    const release = deferred<string>();
    const authFetch = createAuthFetch(
      options({ refreshToken: () => release.promise, fetch: transport.fetch }),
    );
    const controller = new AbortController();

    const request = authFetch(URL_, { signal: controller.signal });
    await transport.untilAttempts(1);
    transport.attempts[0]!.respond(unauthorized());
    await settle();

    const reason = new Error('abandoned while waiting');
    controller.abort(reason);
    await expect(request).rejects.toBe(reason);

    release.resolve('fresh');
    await settle();

    // No retry was ever sent for the aborted request.
    expect(transport.attempts).toHaveLength(1);
  });

  it('aborts a request waiting to be sent during a refresh, and never sends it (3, 27)', async () => {
    const transport = createTransport();
    const release = deferred<string>();
    const authFetch = createAuthFetch(
      options({ refreshToken: () => release.promise, fetch: transport.fetch }),
    );
    const controller = new AbortController();

    const first = authFetch(`${URL_}/a`);
    await transport.untilAttempts(1);
    transport.attempts[0]!.respond(unauthorized());
    await settle();

    const waiting = authFetch(`${URL_}/b`, { signal: controller.signal });
    await settle();
    expect(transport.attempts).toHaveLength(1);

    const reason = new Error('abandoned before sending');
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);

    release.resolve('fresh');
    await transport.untilAttempts(2);
    await settle();

    // Only the first request's retry was sent.
    expect(transport.attempts).toHaveLength(2);
    expect(transport.attempts[1]?.request.url).toBe(`${URL_}/a`);
    transport.attempts[1]!.respond(ok());
    await expect(first).resolves.toMatchObject({ status: 200 });
  });

  it('does not let one aborted waiter cancel the shared refresh (28)', async () => {
    const transport = createTransport();
    const release = deferred<string>();
    const refreshToken = vi.fn(() => release.promise);
    const authFetch = createAuthFetch(options({ refreshToken, fetch: transport.fetch }));
    const controller = new AbortController();

    const abandoned = authFetch(`${URL_}/abandoned`, { signal: controller.signal });
    const survivors = [authFetch(`${URL_}/b`), authFetch(`${URL_}/c`)];
    await transport.untilAttempts(3);
    for (const attempt of transport.attempts) attempt.respond(unauthorized());
    await settle();

    const reason = new Error('abandoned');
    controller.abort(reason);
    await expect(abandoned).rejects.toBe(reason);

    // The shared refresh is the client's, not the aborted request's.
    release.resolve('fresh');
    await transport.untilAttempts(5);
    await settle();

    const retries = transport.attempts.slice(3);
    expect(retries).toHaveLength(2);
    expect(retries.every((attempt) => attempt.token === 'Bearer fresh')).toBe(true);
    expect(retries.map((attempt) => attempt.request.url).sort()).toEqual([
      `${URL_}/b`,
      `${URL_}/c`,
    ]);

    for (const attempt of retries) attempt.respond(ok());
    for (const response of await Promise.all(survivors)) expect(response.status).toBe(200);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('does not send the retry when the abort lands after the refresh resolves (4)', async () => {
    const transport = createTransport();
    const controller = new AbortController();
    const reason = new Error('aborted between refresh and retry');
    // `attachToken` for the retry runs after the shared refresh has already
    // resolved and before the retry reaches the transport — exactly the window
    // this case is about, and reachable without a timer.
    const attachToken = vi.fn((request: Request, token: string) => {
      request.headers.set('Authorization', `Bearer ${token}`);
      if (attachToken.mock.calls.length === 2) controller.abort(reason);
      return request;
    });
    const authFetch = createAuthFetch(options({ attachToken, fetch: transport.fetch }));

    const request = authFetch(URL_, { signal: controller.signal });
    await transport.untilAttempts(1);
    transport.attempts[0]!.respond(unauthorized());

    await expect(request).rejects.toBe(reason);
    expect(attachToken).toHaveBeenCalledTimes(2);
    expect(transport.attempts).toHaveLength(1);
  });

  it('propagates an abort during the retry (5)', async () => {
    const transport = createTransport();
    const authFetch = createAuthFetch(options({ fetch: transport.fetch }));
    const controller = new AbortController();

    const request = authFetch(URL_, { signal: controller.signal });
    await transport.untilAttempts(1);
    transport.attempts[0]!.respond(unauthorized());
    await transport.untilAttempts(2);

    const reason = new Error('aborted mid-retry');
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(transport.attempts).toHaveLength(2);
  });
});

/**
 * Adversarial cases for the generation bookkeeping.
 *
 * The invariant under test: **an authentication failure may consume the result
 * of a refresh that completed after its credential was obtained, and may never
 * consume the result of one that completed before.**
 *
 * These all turn on *when a failure is classified*, not on when it arrived, so
 * each one drives `isAuthFailure` through a gate the test opens by hand. No
 * timers, no sleeps.
 */
describe('refresh generations', () => {
  /** A client whose classification and refresh completion the test controls. */
  function createScenario() {
    const transport = createTransport();
    const classificationGates = new Map<string, Deferred<void>>();
    const refreshGates: Array<Deferred<string>> = [];
    const refreshToken = vi.fn(async (): Promise<string> => {
      const gate = deferred<string>();
      refreshGates.push(gate);
      const token = await gate.promise;
      stored = token; // a realistic consumer persists what it was handed
      return token;
    });
    let stored = 'token-1';
    let tokenGate: Deferred<void> | null = null;

    const authFetch = createAuthFetch({
      getToken: async () => {
        if (tokenGate !== null) await tokenGate.promise;
        return stored;
      },
      refreshToken,
      isAuthFailure: async (response, request) => {
        const gate = classificationGates.get(new URL(request.url).pathname);
        if (gate) await gate.promise;
        return response.status === 401;
      },
      fetch: transport.fetch,
    });

    return {
      authFetch,
      transport,
      refreshToken,
      refreshGates,
      /** Blocks classification of `path` until `release(path)` is called. */
      hold: (path: string): void => {
        classificationGates.set(path, deferred<void>());
      },
      release: (path: string): void => {
        classificationGates.get(path)?.resolve();
        classificationGates.delete(path);
      },
      /** Blocks every `getToken()` call until `releaseToken()` is called. */
      holdToken: (): void => {
        tokenGate = deferred<void>();
      },
      releaseToken: (): void => {
        tokenGate?.resolve();
        tokenGate = null;
      },
      stored: () => stored,
    };
  }

  /** Finds the attempts made against one path, in order. */
  const attemptsFor = (transport: { attempts: Attempt[] }, path: string): Attempt[] =>
    transport.attempts.filter((attempt) => new URL(attempt.request.url).pathname === path);

  it('scenario 1: a late classifier consumes the refresh that already completed', async () => {
    const scenario = createScenario();
    scenario.hold('/b');

    const a = scenario.authFetch('https://api.test/a');
    const b = scenario.authFetch('https://api.test/b');
    await scenario.transport.untilAttempts(2);
    expect(scenario.transport.attempts.map((attempt) => attempt.token)).toEqual([
      'Bearer token-1',
      'Bearer token-1',
    ]);

    // Both fail, but only A's failure is classified.
    for (const attempt of scenario.transport.attempts) attempt.respond(unauthorized());
    await settle();
    expect(scenario.refreshToken).toHaveBeenCalledTimes(1);

    // Refresh #1 completes and the shared slot is cleared, all while B is still
    // inside its classifier.
    scenario.refreshGates[0]!.resolve('token-2');
    await scenario.transport.untilAttempts(3);
    await settle();
    expect(attemptsFor(scenario.transport, '/a')[1]?.token).toBe('Bearer token-2');
    attemptsFor(scenario.transport, '/a')[1]!.respond(ok());
    await expect(a).resolves.toMatchObject({ status: 200 });

    // Only now is B classified. Nothing is in flight to join.
    scenario.release('/b');
    await scenario.transport.untilAttempts(4);
    await settle();

    expect(scenario.refreshToken).toHaveBeenCalledTimes(1);
    const bRetry = attemptsFor(scenario.transport, '/b')[1];
    expect(bRetry?.token).toBe('Bearer token-2');
    bRetry!.respond(ok());
    await expect(b).resolves.toMatchObject({ status: 200 });
    expect(scenario.transport.attempts).toHaveLength(4);
  });

  it('scenario 2: a request that used the refreshed token starts a new refresh', async () => {
    // The most important regression here. C is indistinguishable from B by
    // timing alone — both are classified after refresh #1 settled — and is
    // separated from it only by the generation its credential belongs to.
    const scenario = createScenario();
    scenario.hold('/b');

    const a = scenario.authFetch('https://api.test/a');
    const b = scenario.authFetch('https://api.test/b');
    await scenario.transport.untilAttempts(2);
    for (const attempt of scenario.transport.attempts) attempt.respond(unauthorized());
    await settle();

    scenario.refreshGates[0]!.resolve('token-2');
    await scenario.transport.untilAttempts(3);
    await settle();
    attemptsFor(scenario.transport, '/a')[1]!.respond(ok());
    await a;

    scenario.release('/b');
    await scenario.transport.untilAttempts(4);
    await settle();
    attemptsFor(scenario.transport, '/b')[1]!.respond(ok());
    await b;
    expect(scenario.refreshToken).toHaveBeenCalledTimes(1);

    // Scenario 1 is complete. C is genuinely later: it takes token-2, the token
    // refresh #1 produced, so refresh #1 cannot answer its failure.
    const c = scenario.authFetch('https://api.test/c');
    await scenario.transport.untilAttempts(5);
    expect(attemptsFor(scenario.transport, '/c')[0]?.token).toBe('Bearer token-2');

    attemptsFor(scenario.transport, '/c')[0]!.respond(unauthorized());
    await settle();

    expect(scenario.refreshToken).toHaveBeenCalledTimes(2);
    scenario.refreshGates[1]!.resolve('token-3');
    await scenario.transport.untilAttempts(6);
    await settle();

    const cRetry = attemptsFor(scenario.transport, '/c')[1];
    expect(cRetry?.token).toBe('Bearer token-3');
    cRetry!.respond(ok());
    await expect(c).resolves.toMatchObject({ status: 200 });
    expect(scenario.refreshToken).toHaveBeenCalledTimes(2);
  });

  it('scenario 3: a straggler does not join a refresh from a newer generation', async () => {
    const scenario = createScenario();
    scenario.hold('/b');

    const a = scenario.authFetch('https://api.test/a');
    const b = scenario.authFetch('https://api.test/b');
    await scenario.transport.untilAttempts(2);
    for (const attempt of scenario.transport.attempts) attempt.respond(unauthorized());
    await settle();

    scenario.refreshGates[0]!.resolve('token-2');
    await scenario.transport.untilAttempts(3);
    await settle();
    attemptsFor(scenario.transport, '/a')[1]!.respond(ok());
    await a;

    // C uses token-2 and fails, so refresh #2 starts and stays in flight.
    const c = scenario.authFetch('https://api.test/c');
    await scenario.transport.untilAttempts(4);
    expect(attemptsFor(scenario.transport, '/c')[0]?.token).toBe('Bearer token-2');
    attemptsFor(scenario.transport, '/c')[0]!.respond(unauthorized());
    await settle();
    expect(scenario.refreshToken).toHaveBeenCalledTimes(2);

    // Only now is B — a token-1 failure, generation 0 — classified. Refresh #2
    // is running, but it belongs to a credential B never held.
    scenario.release('/b');
    await scenario.transport.untilAttempts(5);
    await settle();

    // B takes refresh #1's token: the operation that actually replaced its
    // credential. It neither waits for refresh #2 nor starts a refresh #3.
    const bRetry = attemptsFor(scenario.transport, '/b')[1];
    expect(bRetry?.token).toBe('Bearer token-2');
    expect(scenario.refreshToken).toHaveBeenCalledTimes(2);

    bRetry!.respond(ok());
    await expect(b).resolves.toMatchObject({ status: 200 });

    // And refresh #2 still serves C, untouched by any of it.
    scenario.refreshGates[1]!.resolve('token-3');
    await scenario.transport.untilAttempts(6);
    await settle();
    const cRetry = attemptsFor(scenario.transport, '/c')[1];
    expect(cRetry?.token).toBe('Bearer token-3');
    cRetry!.respond(ok());
    await expect(c).resolves.toMatchObject({ status: 200 });
    expect(scenario.refreshToken).toHaveBeenCalledTimes(2);
  });

  it('scenario 3b: a straggler is not failed by a newer generation that rejects', async () => {
    // The sharper edge of scenario 3: if B joined refresh #2, B would reject
    // without ever having been given the token that replaced its own.
    const scenario = createScenario();
    scenario.hold('/b');

    const a = scenario.authFetch('https://api.test/a');
    const b = scenario.authFetch('https://api.test/b');
    await scenario.transport.untilAttempts(2);
    for (const attempt of scenario.transport.attempts) attempt.respond(unauthorized());
    await settle();
    scenario.refreshGates[0]!.resolve('token-2');
    await scenario.transport.untilAttempts(3);
    await settle();
    attemptsFor(scenario.transport, '/a')[1]!.respond(ok());
    await a;

    const c = scenario.authFetch('https://api.test/c');
    await scenario.transport.untilAttempts(4);
    attemptsFor(scenario.transport, '/c')[0]!.respond(unauthorized());
    await settle();

    scenario.release('/b');
    await scenario.transport.untilAttempts(5);
    await settle();
    const bRetry = attemptsFor(scenario.transport, '/b')[1];
    expect(bRetry?.token).toBe('Bearer token-2');
    bRetry!.respond(ok());
    await expect(b).resolves.toMatchObject({ status: 200 });

    // Refresh #2 fails: that is C's outcome alone.
    const failure = new Error('session expired');
    scenario.refreshGates[1]!.reject(failure);
    await expect(c).rejects.toBe(failure);
  });

  it('scenario 4: a failed generation does not leak into the next one', async () => {
    const scenario = createScenario();
    const transport = scenario.transport;
    scenario.hold('/b');

    const a = scenario.authFetch('https://api.test/a');
    const b = scenario.authFetch('https://api.test/b');
    await transport.untilAttempts(2);
    for (const attempt of transport.attempts) attempt.respond(unauthorized());
    await settle();

    const failure = new Error('session expired');
    scenario.refreshGates[0]!.reject(failure);
    await expect(a).rejects.toBe(failure);

    // B's late classification joins the same failed generation.
    scenario.release('/b');
    await expect(b).rejects.toBe(failure);
    expect(scenario.refreshToken).toHaveBeenCalledTimes(1);
    expect(transport.attempts).toHaveLength(2);

    // A completely new request must still be able to start refresh #2, and must
    // not inherit generation 1's error.
    const d = scenario.authFetch('https://api.test/d');
    await transport.untilAttempts(3);
    attemptsFor(transport, '/d')[0]!.respond(unauthorized());
    await settle();

    expect(scenario.refreshToken).toHaveBeenCalledTimes(2);
    scenario.refreshGates[1]!.resolve('token-2');
    await transport.untilAttempts(4);
    await settle();

    const dRetry = attemptsFor(transport, '/d')[1];
    expect(dRetry?.token).toBe('Bearer token-2');
    dRetry!.respond(ok());
    await expect(d).resolves.toMatchObject({ status: 200 });
  });

  it('scenario 4: onAuthFailure fires once for the failed operation', async () => {
    const transport = createTransport();
    const onAuthFailure = vi.fn();
    const gate = deferred<string>();
    const authFetch = createAuthFetch(
      options({ refreshToken: () => gate.promise, onAuthFailure, fetch: transport.fetch }),
    );

    const requests = [0, 1, 2].map((index) => authFetch(`${URL_}/${index}`));
    await transport.untilAttempts(3);
    for (const attempt of transport.attempts) attempt.respond(unauthorized());
    await settle();

    const failure = new Error('session expired');
    gate.reject(failure);
    for (const request of requests) await expect(request).rejects.toBe(failure);

    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });

  it('a credential read while a refresh completed belongs to the newer generation', async () => {
    // The boundary of the invariant. X reads its token across a refresh: the
    // slot is empty when X starts, so it calls getToken(), and refresh #1
    // completes and persists token-2 before that read returns. X is therefore
    // sent with token-2 — the refreshed token — and its 401 is a genuine
    // failure of generation 1, not a straggler from generation 0.
    //
    // Snapshotting the generation before the read would put X in generation 0
    // and let it consume refresh #1's result: a retry with the exact token that
    // had just been rejected. The snapshot is taken with the credential, after
    // the read, so X starts a new refresh instead.
    const scenario = createScenario();
    scenario.hold('/a');

    const a = scenario.authFetch('https://api.test/a');
    await scenario.transport.untilAttempts(1);
    scenario.transport.attempts[0]!.respond(unauthorized());
    await settle();

    // X begins while nothing is in flight, and blocks inside getToken().
    scenario.holdToken();
    const x = scenario.authFetch('https://api.test/x');
    await settle();
    expect(scenario.transport.attempts).toHaveLength(1);

    // Refresh #1 runs to completion during that read.
    scenario.release('/a');
    await settle();
    scenario.refreshGates[0]!.resolve('token-2');
    await scenario.transport.untilAttempts(2);
    await settle();
    attemptsFor(scenario.transport, '/a')[1]!.respond(ok());
    await a;
    expect(scenario.refreshToken).toHaveBeenCalledTimes(1);

    // X's read now returns the refreshed token.
    scenario.releaseToken();
    await scenario.transport.untilAttempts(3);
    expect(attemptsFor(scenario.transport, '/x')[0]?.token).toBe('Bearer token-2');

    attemptsFor(scenario.transport, '/x')[0]!.respond(unauthorized());
    await settle();

    // token-2 is X's own credential, so refresh #1 cannot answer for it.
    expect(scenario.refreshToken).toHaveBeenCalledTimes(2);
    scenario.refreshGates[1]!.resolve('token-3');
    await scenario.transport.untilAttempts(4);
    await settle();

    const retry = attemptsFor(scenario.transport, '/x')[1];
    expect(retry?.token).toBe('Bearer token-3');
    retry!.respond(ok());
    await expect(x).resolves.toMatchObject({ status: 200 });
  });

  it('scenario 5: a genuine failure of the refreshed token gets the new error', async () => {
    const scenario = createScenario();

    const a = scenario.authFetch('https://api.test/a');
    await scenario.transport.untilAttempts(1);
    scenario.transport.attempts[0]!.respond(unauthorized());
    await settle();

    scenario.refreshGates[0]!.resolve('token-2');
    await scenario.transport.untilAttempts(2);
    await settle();
    scenario.transport.attempts[1]!.respond(ok());
    await expect(a).resolves.toMatchObject({ status: 200 });

    // A later request uses token-2 and is genuinely rejected.
    const e = scenario.authFetch('https://api.test/e');
    await scenario.transport.untilAttempts(3);
    expect(scenario.transport.attempts[2]?.token).toBe('Bearer token-2');
    scenario.transport.attempts[2]!.respond(unauthorized());
    await settle();

    expect(scenario.refreshToken).toHaveBeenCalledTimes(2);

    // Refresh #2 rejects: the request must get *that* error, not generation 1's
    // stale success, and must not be retried with token-2 again.
    const failure = new Error('refresh token revoked');
    scenario.refreshGates[1]!.reject(failure);

    await expect(e).rejects.toBe(failure);
    expect(scenario.transport.attempts).toHaveLength(3);
  });
});
