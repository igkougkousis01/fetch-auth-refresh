export type {
  AccessToken,
  AuthFailureContext,
  AuthFetch,
  AuthFetchOptions,
  FetchLike,
  RefreshContext,
} from './types.js';

import type { AccessToken, AuthFetch, AuthFetchOptions, FetchLike } from './types.js';

/** Header name, lower-cased. `Headers` lookups are case-insensitive anyway. */
const AUTHORIZATION = 'authorization';

/**
 * Resolves the transport for a single request.
 *
 * The global is read (and bound) per call rather than captured at creation time
 * so that swapping `globalThis.fetch` — in tests, or by a polyfill loaded after
 * setup — is picked up, and so that constructing an `authFetch` on a platform
 * without a global `fetch` does not fail until it is actually used.
 */
function resolveFetch(injected: FetchLike | undefined): FetchLike {
  if (injected !== undefined) return injected;

  const globalFetch = globalThis.fetch;
  if (typeof globalFetch !== 'function') {
    throw new TypeError(
      'No fetch implementation available: pass `fetch` in the options, or run on a platform that provides a global fetch.',
    );
  }

  // Native `fetch` is not callable with an arbitrary `this` in browsers.
  return globalFetch.bind(globalThis);
}

/** Default token attachment: `Authorization: Bearer <token>`. */
function attachBearerToken(request: Request, token: AccessToken): Request {
  // `request` is library-owned, so mutating its headers is safe. Rebuilding it
  // as `new Request(request, { headers })` would *replace* the whole header
  // list rather than merge, and would needlessly transfer the body again.
  request.headers.set('Authorization', `Bearer ${token}`);
  return request;
}

/**
 * Creates a `fetch`-compatible function that attaches the current access token
 * to outgoing requests.
 *
 * The lifecycle implemented today is:
 *
 * ```
 * caller → build a library-owned Request → getToken() → attach token if present
 *        → underlying fetch → return the Response unchanged
 * ```
 *
 * Responses are passed through untouched, including authentication failures: a
 * `401` is returned exactly as received. Token refresh, retry, and single-flight
 * coordination are declared in {@link AuthFetchOptions} but are **not
 * implemented yet** — `refreshToken`, `isAuthFailure`, and `onAuthFailure` are
 * never invoked. See `docs/architecture.md`.
 *
 * Notes on Fetch semantics:
 *
 * - Input is normalised with the native `Request` constructor, so method,
 *   headers, body, credentials, mode, cache, redirect, and signal are handled
 *   by the platform rather than reconstructed by hand.
 * - The caller's `Request` and `Headers` objects are never mutated. As with
 *   native `fetch(request)`, passing a `Request` with a body hands that body
 *   over: the caller's `Request` is left consumed and must not be reused.
 */
export function createAuthFetch(options: AuthFetchOptions): AuthFetch {
  // Callbacks are invoked as `options.x()` rather than destructured, so that a
  // policy object implementing this interface with real methods keeps its
  // `this`.
  return async function authFetch(input, init) {
    const fetchImpl = resolveFetch(options.fetch);

    // One native normalisation step handles Request-vs-URL/string input and the
    // Request + RequestInit merge. Everything after this point works on a
    // Request the library owns, so nothing the caller passed in is mutated.
    const request = new Request(input, init);

    // Caller intent wins: an Authorization header the caller set explicitly is
    // never replaced, and the token provider is not consulted at all — that
    // request is already authenticated by the caller.
    if (request.headers.has(AUTHORIZATION)) {
      return fetchImpl(request);
    }

    const token = await options.getToken();

    // No token: send a normal unauthenticated request.
    if (token === null || token === undefined) {
      return fetchImpl(request);
    }

    const authenticatedRequest = options.attachToken
      ? await options.attachToken(request, token)
      : attachBearerToken(request, token);

    return fetchImpl(authenticatedRequest);
  };
}
