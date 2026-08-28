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
 * A refresh operation that has run to completion, and how it ended.
 *
 * `generation` is the operation's 1-based ordinal. Refreshes never overlap, so
 * the ordinal totally orders them, and comparing it against the generation a
 * request recorded when it took its credential answers the only question that
 * matters: did this refresh happen before or after that credential was chosen?
 */
interface CompletedRefresh {
  readonly generation: number;
  readonly result: { readonly token: AccessToken } | { readonly error: unknown };
}

/**
 * Resolves the transport **once**, at client creation.
 *
 * The transport is client configuration, not per-request state: a refresh can
 * span several requests, and resolving the global per call would let a mid-flight
 * swap of `globalThis.fetch` split one logical operation across two transports.
 * A missing transport is therefore a construction-time error, not a surprise on
 * the first request.
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
 * A copy of `request` kept aside for a possible retry, or `null` when the
 * platform cannot produce one.
 *
 * Must be called before the body can be consumed — the transport disturbs it —
 * and before a token is attached, so that a retry never carries the credential
 * that was just rejected. `clone()` handles every body type the platform
 * supports, including a `ReadableStream` (which it tees); it throws only for a
 * request that is already disturbed, and such a request is never retried.
 */
function cloneForReplay(request: Request): Request | null {
  try {
    return request.clone();
  } catch {
    return null;
  }
}

/**
 * Awaits `promise`, but rejects as soon as `signal` aborts.
 *
 * Cancellation belongs to one logical request; the promise being awaited (a
 * shared refresh) belongs to the client. Abandoning the wait therefore never
 * touches the underlying operation, so other requests keep waiting on it.
 */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });

    // Attached even when the signal has already aborted: the promise being
    // abandoned may be a rejected one, and leaving it unobserved would surface
    // as an unhandled rejection.
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });

    // `addEventListener` never fires for a signal that aborted earlier.
    if (signal.aborted) reject(signal.reason);
  });
}

/**
 * Creates a `fetch`-compatible function that attaches the current access token
 * to outgoing requests and refreshes it, once, when the server rejects it.
 *
 * The lifecycle is:
 *
 * ```
 * caller → build a library-owned Request
 *        → caller-supplied Authorization? → send as-is, no auth lifecycle
 *        → a refresh already in flight?   → wait for it, use its token
 *          otherwise                      → getToken()
 *        → attach token → fetch
 *        → not an auth failure → return the Response unchanged
 *        → auth failure        → start or join the one shared refresh
 *                              → retry exactly once with the refreshed token
 * ```
 *
 * At most one `refreshToken()` call is in flight per client: concurrent
 * authentication failures join the same operation and are all retried with the
 * same token. See `docs/architecture.md`.
 *
 * Notes on Fetch semantics:
 *
 * - Input is normalised with the native `Request` constructor, so method,
 *   headers, body, credentials, mode, cache, redirect, and signal are handled
 *   by the platform rather than reconstructed by hand.
 * - The caller's `Request` and `Headers` objects are never mutated. As with
 *   native `fetch(request)`, passing a `Request` with a body hands that body
 *   over: the caller's `Request` is left consumed and must not be reused.
 * - Responses handed to consumer callbacks are always `response.clone()`s, so
 *   the response returned to the caller is never consumed by the library.
 */
export function createAuthFetch(options: AuthFetchOptions): AuthFetch {
  // Callbacks are invoked as `options.x()` rather than destructured, so that a
  // policy object implementing this interface with real methods keeps its
  // `this`.
  const fetchImpl = resolveFetch(options.fetch);

  /**
   * The single shared refresh operation, or `null` when none is running.
   *
   * This one variable is the entire synchronisation primitive: no queue, no
   * lock, no state machine. Everything that reads or writes it does so
   * synchronously, with no `await` in between, so two concurrent requests can
   * never both observe `null` and start rival refreshes.
   */
  let refreshPromise: Promise<AccessToken> | null = null;

  /**
   * The most recently completed refresh operation, or `null` before the first
   * one finishes.
   *
   * Held as one record rather than a count plus a separate outcome so the two
   * cannot drift apart: the generation and the result it produced are written
   * together, in a single assignment.
   *
   * This exists because a shared promise only coordinates failures that are
   * classified while it is still pending. Classification can be asynchronous —
   * `isAuthFailure` may read a response body — so a hundred requests failing
   * with one token can be classified one at a time, long after the first
   * refresh settled and cleared the slot. Without this record each of them
   * would start its own refresh, in sequence.
   */
  let lastRefresh: CompletedRefresh | null = null;

  /**
   * The generation a credential obtained *right now* belongs to.
   *
   * A request records this next to its token, and it is the whole basis of the
   * decision in {@link acquireRefresh} — request-local state, never elapsed
   * time or ordering heuristics.
   */
  function currentGeneration(): number {
    return lastRefresh === null ? 0 : lastRefresh.generation;
  }

  /** Classification is consumer policy; the default is the conventional 401. */
  function isAuthFailure(response: Response, request: Request): boolean | Promise<boolean> {
    if (options.isAuthFailure === undefined) return response.status === 401;
    // A clone, so that a classifier reading the body cannot consume the
    // response the caller receives.
    return options.isAuthFailure(response.clone(), request);
  }

  /** The one place a credential is put on a request, used by every path. */
  function attach(
    request: Request,
    token: AccessToken | null | undefined,
  ): Request | Promise<Request> {
    if (token === null || token === undefined) return request;
    return options.attachToken
      ? options.attachToken(request, token)
      : attachBearerToken(request, token);
  }

  /**
   * Tells the consumer that the session could not be recovered.
   *
   * A throwing callback is swallowed. Notification is a side channel: it must
   * never replace, reshape, or delay the refresh error it was called to report,
   * and behaving one way in a runtime with a global error reporter and another
   * way without one would make that guarantee runtime-dependent. Consumers who
   * need to observe an error from their own callback must catch it inside the
   * callback.
   */
  async function notifyAuthFailure(request: Request, response: Response): Promise<void> {
    if (options.onAuthFailure === undefined) return;
    try {
      await options.onAuthFailure({ request, response: response.clone() });
    } catch {
      // Contained on purpose. See above.
    }
  }

  /**
   * The body of one shared refresh operation.
   *
   * `onAuthFailure` fires here — once per failed operation, never once per
   * waiting request — because consumers use it to log out, navigate, or clear
   * state, and "the session is gone" is a fact about the session, not about any
   * one request.
   *
   * The result is recorded before the promise settles, so every waiter that
   * resumes afterwards, and every straggler that arrives later, sees the same
   * completed generation.
   */
  async function runRefresh(
    request: Request,
    response: Response,
    rejectedToken: AccessToken | null,
  ): Promise<AccessToken> {
    // Refreshes never overlap, so this is simply "the next one".
    const generation = currentGeneration() + 1;

    try {
      const token = await options.refreshToken({
        request,
        response: response.clone(),
        rejectedToken,
      });
      lastRefresh = { generation, result: { token } };
      return token;
    } catch (error) {
      lastRefresh = { generation, result: { error } };
      await notifyAuthFailure(request, response);
      throw error;
    }
  }

  /**
   * Decides what an authentication failure gets: an already-completed refresh,
   * the one currently running, or a new one.
   *
   * **The generation invariant.** A failure may consume the result of a refresh
   * that completed *after* its credential was obtained, and may never consume
   * the result of one that completed *before*. A refresh that completed
   * beforehand was replacing some earlier credential — not the one that just
   * failed — so reusing it would answer this failure with a token already known
   * to be no newer than the rejected one.
   *
   * That single rule separates the two cases that look alike from the outside:
   *
   * - a failure from the same wave that already caused a refresh, classified
   *   late (`lastRefresh.generation > credentialGeneration`) — it takes that
   *   refresh's result;
   * - a genuinely later failure, by a request that *used* the refreshed token
   *   (`lastRefresh.generation === credentialGeneration`) — it must start a new
   *   refresh, because nothing has replaced its credential yet.
   *
   * It is decided entirely from state each request carries, never from timing.
   */
  function acquireRefresh(
    credentialGeneration: number,
    request: Request,
    response: Response,
    rejectedToken: AccessToken | null,
  ): Promise<AccessToken> {
    // Checked before the in-flight slot, and that order matters. A refresh may
    // be running that was started by a *newer* credential than this request
    // ever held — one it never used and whose failure says nothing about it.
    // Joining that operation would make this request wait for, and fail with,
    // an outcome belonging to a generation ahead of its own; the refresh that
    // actually replaced its credential has already completed.
    if (lastRefresh !== null && lastRefresh.generation > credentialGeneration) {
      const { result } = lastRefresh;
      return 'token' in result ? Promise.resolve(result.token) : Promise.reject(result.error);
    }

    // Nothing has replaced this credential yet. If an operation is already
    // running it is the one doing so: join it.
    if (refreshPromise !== null) return refreshPromise;

    const started = runRefresh(request, response, rejectedToken);
    refreshPromise = started;

    const clear = (): void => {
      if (refreshPromise === started) refreshPromise = null;
    };
    void started.then(clear, clear);

    return started;
  }

  return async function authFetch(input, init) {
    // One native normalisation step handles Request-vs-URL/string input and the
    // Request + RequestInit merge. Everything after this point works on a
    // Request the library owns, so nothing the caller passed in is mutated.
    const request = new Request(input, init);

    // Caller intent wins: an Authorization header the caller set explicitly is
    // never replaced, and the whole authentication lifecycle is skipped — no
    // getToken, no attachToken, no classification, no refresh, no retry. That
    // request is the caller's to authenticate.
    if (request.headers.has(AUTHORIZATION)) {
      return fetchImpl(request);
    }

    const { signal } = request;
    signal.throwIfAborted();

    // Read synchronously, before any `await`: a request that starts while a
    // refresh is running must not be sent with a credential this client already
    // knows was rejected. It waits instead, and is sent once, with the fresh
    // token. `getToken()` is deliberately not consulted on this path — the
    // refresh's return value is the newest token, without a read-after-write
    // race against consumer storage.
    const pendingRefresh = refreshPromise;
    const token =
      pendingRefresh === null ? await options.getToken() : await waitFor(pendingRefresh, signal);

    // Recorded with the credential, never before it: a refresh that completed
    // while `getToken()` was still running may well be the source of this very
    // token, so counting it as "after" could answer a later failure with the
    // token that just failed. Recording it here can only overstate the
    // credential's vintage, which costs at worst one extra refresh in a narrow
    // window and never a wrong reuse.
    const credentialGeneration = currentGeneration();

    const replay = cloneForReplay(request);
    const sent = await attach(request, token);

    signal.throwIfAborted();
    const response = await fetchImpl(sent);

    // Nothing to retry with: send-once semantics, response returned untouched.
    if (replay === null) return response;
    if (!(await isAuthFailure(response, sent))) return response;

    // Rejecting here fans the refresh failure out to every request awaiting the
    // same operation, consistently, without any of them starting a rival one.
    const freshToken = await waitFor(
      acquireRefresh(credentialGeneration, sent, response, token ?? null),
      signal,
    );

    // The retry is a fall-through, not a loop and not a recursive call into
    // `authFetch`: there is no path from its response back to the refresh above,
    // so one logical request can never trigger a second refresh.
    //
    // Its response is returned as-is, unclassified. A retry that comes back 401
    // is not a failed refresh — the refresh succeeded — it is one request the
    // server still refuses with a valid credential, which is that caller's
    // business and not grounds for a session-wide notification.
    const retrySent = await attach(replay, freshToken);

    signal.throwIfAborted();
    return fetchImpl(retrySent);
  };
}
