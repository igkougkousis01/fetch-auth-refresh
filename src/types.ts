/**
 * Public type surface for `createAuthFetch()`.
 *
 * Only part of this is implemented today. The token-attachment path
 * (`getToken`, `attachToken`, `fetch`) is live; the refresh path
 * (`refreshToken`, `isAuthFailure`, `onAuthFailure`) is declared but never
 * invoked yet. Each member documents its own status.
 *
 * Design rule: this library owns *transport coordination* (when to refresh, how
 * many refreshes run at once, how many retries a request gets). The consumer
 * owns *authentication policy* (what a token is, where it lives, how it is
 * renewed, what counts as an authentication failure).
 */

/**
 * An access token, treated as an opaque string.
 *
 * The library never parses, decodes, or inspects it. JWT, PASETO, or a random
 * opaque string are all equally fine.
 */
export type AccessToken = string;

/** A `fetch`-compatible function. Defaults to the global `fetch`. */
export type FetchLike = typeof globalThis.fetch;

/** The function returned by {@link createAuthFetch}. Drop-in for `fetch`. */
export type AuthFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Information about a response the consumer classified as an auth failure. */
export interface AuthFailureContext {
  /**
   * The request as it was sent, including the token that was attached.
   *
   * This is the library's own `Request`, never the caller's object. It has
   * already been sent, so its body is consumed; treat it as read-only metadata
   * (URL, method, headers).
   */
  readonly request: Request;
  /**
   * A **clone** of the response that was classified as an authentication
   * failure.
   *
   * A clone is passed so that reading the body here cannot consume the response
   * that is returned to the caller.
   */
  readonly response: Response;
}

/** Information handed to {@link AuthFetchOptions.refreshToken}. */
export interface RefreshContext {
  /**
   * The request whose failure triggered this refresh.
   *
   * This is the library's own `Request`, never the caller's object. It has
   * already been sent, so its body is consumed; treat it as read-only metadata
   * (URL, method, headers).
   */
  readonly request: Request;
  /**
   * A **clone** of the response that was classified as an authentication
   * failure.
   *
   * A clone is passed so that reading the body here cannot consume the response
   * that is returned to the caller.
   */
  readonly response: Response;
  /**
   * The token that was rejected, or `null` if the request was sent unauthenticated.
   *
   * Useful for consumers that want to no-op when another part of the app has
   * already rotated the token.
   */
  readonly rejectedToken: AccessToken | null;
}

/**
 * Consumer-supplied authentication policy.
 *
 * Every callback may be sync or async. The library holds no token state of its
 * own; persistence is entirely the consumer's responsibility.
 */
export interface AuthFetchOptions {
  /**
   * Returns the token to attach to an outgoing request, or `null` to send the
   * request without credentials.
   *
   * Called once per outgoing request that the library authenticates. It is
   * *not* called when the caller supplied their own `Authorization` header —
   * that request is already authenticated by the caller.
   *
   * Implemented today.
   */
  getToken(): AccessToken | null | Promise<AccessToken | null>;

  /**
   * Obtains a fresh token and resolves with it.
   *
   * **Failure is signalled by rejecting**, not by a sentinel value. If the
   * session cannot be recovered, throw (or return a rejected promise); the
   * library treats any rejection as "refresh failed" and returns the original
   * authentication-failure response to the caller. A resolved value is always a
   * usable token.
   *
   * The returned token is used directly for the retry, so the library never has
   * to re-read consumer storage between refresh and retry. Persisting the token
   * (localStorage, cookie, memory, …) is the consumer's job.
   *
   * At most one call to this function will be in flight at a time; concurrent
   * requests that hit an authentication failure will join the same operation.
   *
   * **Not implemented yet** — this callback is never invoked in the current
   * release. It is part of the fixed API surface so that consumers can write
   * against the final shape.
   */
  refreshToken(context: RefreshContext): Promise<AccessToken>;

  /**
   * Classifies a response as an authentication failure.
   *
   * Only classification belongs here — whether to actually refresh, and how
   * many times, is the library's decision.
   *
   * The `response` passed in is a **clone**, so reading its body here can never
   * consume the response the caller receives. The `request` is the library's
   * own `Request`, already sent and therefore body-consumed.
   *
   * **Not implemented yet** — this callback is never invoked in the current
   * release.
   *
   * @default (response) => response.status === 401
   */
  isAuthFailure?(response: Response, request: Request): boolean | Promise<boolean>;

  /**
   * Called when a request could not be recovered: `refreshToken` rejected, or
   * the retried request failed authentication again.
   *
   * Intended for consumer-side reactions such as clearing storage or
   * redirecting to a login screen. It cannot change the outcome of the request.
   *
   * **Not implemented yet** — this callback is never invoked in the current
   * release.
   */
  onAuthFailure?(context: AuthFailureContext): void | Promise<void>;

  /**
   * Attaches a token to an outgoing request, returning the request to send.
   *
   * The header scheme is authentication policy, so it is overridable; the
   * default sends `Authorization: Bearer <token>`.
   *
   * The `request` passed in is always a `Request` constructed by the library,
   * never the caller's object, so mutating its headers in place is safe.
   * Returning a brand-new `Request` built from it works too.
   *
   * Implemented today.
   */
  attachToken?(request: Request, token: AccessToken): Request | Promise<Request>;

  /**
   * The underlying transport. Defaults to the global `fetch`, bound to
   * `globalThis`, resolved at call time.
   *
   * Implemented today.
   */
  fetch?: FetchLike;
}
