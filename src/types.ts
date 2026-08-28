/**
 * Public type surface for `createAuthFetch()`.
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

/**
 * The function returned by {@link createAuthFetch}. Drop-in for `fetch`.
 *
 * The parameters are derived from the platform's own `fetch` rather than
 * written out, because the spelling of its first parameter is not portable:
 * `RequestInfo` exists in the DOM lib but not in `@types/node`, so naming it
 * here would make the published declarations fail to compile for a Node
 * consumer who has not enabled `"lib": ["DOM"]`.
 */
export type AuthFetch = (...args: Parameters<FetchLike>) => Promise<Response>;

/**
 * Information about the authentication failure that triggered a refresh which
 * then failed.
 */
export interface AuthFailureContext {
  /**
   * The request whose failure started the refresh that could not be completed.
   *
   * Several requests may have been attached to that one operation; this is the
   * one that began it, not each of them.
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
   *
   * When several requests fail at once they share **one** refresh operation, so
   * this is the request that happened to start it — not every request that is
   * waiting on the result.
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
   * Called once per outgoing request that the library authenticates, with two
   * deliberate exceptions:
   *
   * - the caller supplied their own `Authorization` header — that request is
   *   already authenticated by the caller;
   * - a refresh was already in flight when the request started, or had just
   *   produced a token for this request's retry. Those requests use the token
   *   `refreshToken()` returned, so consumer storage is never read back in a
   *   window where it may not have been written yet.
   */
  getToken(): AccessToken | null | Promise<AccessToken | null>;

  /**
   * Obtains a fresh token and resolves with it.
   *
   * **Failure is signalled by rejecting**, not by a sentinel value. If the
   * session cannot be recovered, throw (or return a rejected promise). A
   * resolved value is always a usable token.
   *
   * The returned token is used directly for the retry, so the library never has
   * to re-read consumer storage between refresh and retry. Persisting the token
   * (localStorage, cookie, memory, …) is the consumer's job.
   *
   * **At most one call is in flight at a time.** Every request that hits an
   * authentication failure while one is running joins that same operation, and
   * they are all retried with the same resolved token. If it rejects, every
   * request awaiting it rejects with that same error — none of them starts a
   * replacement refresh, and `onAuthFailure` fires once for the operation.
   */
  refreshToken(context: RefreshContext): Promise<AccessToken>;

  /**
   * Classifies a response as an authentication failure.
   *
   * Only classification belongs here — whether to actually refresh, and how
   * many times, is the library's decision.
   *
   * Called **once per request**, on its first attempt. The response of a retry
   * is returned to the caller unclassified: a retry that is still unauthorized
   * has no decision left to drive, since a request is retried at most once.
   *
   * The `response` passed in is a **clone**, so reading its body here can never
   * consume the response the caller receives. The `request` is the library's
   * own `Request` as it was sent, already body-consumed.
   *
   * @default (response) => response.status === 401
   */
  isAuthFailure?(response: Response, request: Request): boolean | Promise<boolean>;

  /**
   * Called when the session could not be recovered: `refreshToken()` rejected.
   * Intended for consumer-side reactions such as clearing storage or
   * redirecting to a login screen; it cannot change the outcome of a request.
   *
   * **Once per failed shared refresh operation**, never once per waiting
   * request: 100 requests joining one refresh that rejects produce exactly one
   * call, so a logout implemented here runs once.
   *
   * It is *not* called when a retried request comes back unauthorized. There
   * the refresh succeeded and the server simply refused that one request with a
   * freshly issued credential — a per-request outcome, possibly a scope or
   * permission problem on a single endpoint, which is returned to the caller as
   * a normal response rather than escalated to a session-wide event.
   *
   * A `response` clone is passed, so reading its body is safe. If this callback
   * throws, the error is swallowed and the original refresh error is what
   * waiting requests receive — identically in every runtime. Catch inside the
   * callback if you need to observe its failures.
   */
  onAuthFailure?(context: AuthFailureContext): void | Promise<void>;

  /**
   * Attaches a token to an outgoing request, returning the request to send.
   *
   * The header scheme is authentication policy, so it is overridable; the
   * default sends `Authorization: Bearer <token>`.
   *
   * This is the single credential-attachment path: it is used for the initial
   * request, for a request that waited on an in-flight refresh, and for a retry
   * with a refreshed token. A retry receives a copy of the request taken
   * *before* the rejected credential was attached, so it never has to strip
   * anything.
   *
   * The `request` passed in is always a `Request` constructed by the library,
   * never the caller's object, so mutating its headers in place is safe.
   * Returning a brand-new `Request` built from it works too.
   *
   * Not called when the caller supplied their own `Authorization` header, or
   * when there is no token to attach.
   */
  attachToken?(request: Request, token: AccessToken): Request | Promise<Request>;

  /**
   * The underlying transport. Defaults to the global `fetch`, bound to
   * `globalThis`.
   *
   * Resolved **once, when the client is created**, not per request: the
   * transport is client configuration, and a refresh spans several requests. A
   * missing transport throws from `createAuthFetch()` rather than from the
   * first request.
   */
  fetch?: FetchLike;
}
