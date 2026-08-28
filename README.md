# fetch-auth-refresh

A small, zero-runtime-dependency TypeScript wrapper around the native Fetch API that adds
concurrency-safe access token refresh.

```
request → attach token → fetch → not an auth failure? return it
                              → auth failure? join the one shared refresh
                                             → retry exactly once with the fresh token
```

## The problem

Almost every app that talks to an authenticated HTTP API ends up rewriting the same logic:

1. Attach the current access token to each request.
2. Notice that the server rejected the token (usually `401`).
3. Refresh the token.
4. Retry the original request.

Written by hand, this logic tends to leak into every call site, or to grow into a bespoke HTTP
client that has to be maintained forever. `fetch-auth-refresh` does exactly those four steps and
nothing else.

## The single-flight refresh problem

The hard part is not refreshing. The hard part is refreshing *once*.

A typical page loads several resources at the same time:

```
GET /profile      ─┐
GET /settings     ─┼─ all in flight with the same expired token
GET /notifications─┘
```

When the token expires, all three come back `401` at roughly the same moment. A naive
implementation refreshes per failed request, so one expired token produces three refresh calls.

That is not just wasteful:

- **Refresh tokens are often single-use.** Many providers rotate the refresh token on every use
  and invalidate the previous one. Three parallel refreshes mean two of them present a token that
  a sibling call has already consumed — and the user gets logged out.
- **Rate limits and lockouts.** Auth endpoints are commonly the most aggressively rate-limited
  ones in a system.
- **Last-writer-wins races.** Three refreshes produce three tokens; whichever finishes last is the
  one stored, and requests retried with the others fail.

**Single-flight** means: the first authentication failure starts the refresh, and every other
request that fails during that window *joins the same in-flight operation* instead of starting a
new one. One refresh call, one new token, every waiting request retried with it.

100 simultaneous requests that all receive a `401` produce exactly **one** `refreshToken()` call.

## API

```ts
import { createAuthFetch } from 'fetch-auth-refresh';

const authFetch = createAuthFetch({
  // Return the token to attach, or null to send the request unauthenticated.
  getToken: () => localStorage.getItem('access_token'),

  // Obtain a fresh token and return it. At most one call is in flight at a time.
  // Throw if the session cannot be recovered.
  refreshToken: async () => {
    const response = await fetch('/auth/refresh', { method: 'POST' });
    if (!response.ok) throw new Error('Session expired');

    const { accessToken } = await response.json();
    localStorage.setItem('access_token', accessToken);
    return accessToken;
  },

  // Optional. Defaults to `response.status === 401`. May be async.
  isAuthFailure: (response) => response.status === 401,

  // Optional. Called once per unrecoverable authentication outcome.
  onAuthFailure: () => {
    localStorage.removeItem('access_token');
    redirectToLogin();
  },

  // Optional. Defaults to `Authorization: Bearer <token>`.
  attachToken: (request, token) => {
    request.headers.set('X-Api-Key', token);
    return request;
  },

  // Optional. Defaults to the global `fetch`, captured when the client is created.
  fetch: undiciFetch,
});

// Same signature as fetch.
const response = await authFetch('/api/profile');
```

`refreshToken()` returns the new token rather than writing it somewhere the library reads back.
That keeps the retry from racing against the consumer's storage, and keeps persistence optional.
**Refresh failure is a rejection, not a return value** — there is no `null` sentinel, so a resolved
value is always a usable token.

## Behaviour

### Single-flight refresh

One shared promise per client. The first request to classify a response as an authentication
failure starts the refresh; every other request that fails while it is pending joins that same
operation. All of them are retried with the same resolved token. When the operation settles the
slot is cleared, so a later, independent expiry starts a new refresh.

Failures do not all arrive at the same instant, so "while it is pending" is not enough on its own.
Refresh operations are numbered, and a request records the current number alongside the token it is
sent with. That single piece of request-local state decides what its failure gets:

> **An authentication failure may consume the result of a refresh that completed *after* its
> credential was obtained, and never the result of one that completed *before*.**

A refresh from before was replacing some earlier credential, not this one, so reusing it would
answer the failure with a token no newer than the one just rejected. The rule separates the two
cases that are indistinguishable by timing alone:

| Situation | Generation | What happens |
| --------- | ---------- | ------------ |
| Failed alongside the wave that already refreshed, but classified late | a refresh completed after its credential | takes that refresh's result — no new refresh |
| Used the refreshed token and was rejected anyway | no refresh has completed since its credential | starts a new refresh |

Without it, 100 failures classified one at a time — an async `isAuthFailure` that reads a response
body is enough — would produce one refresh each, in sequence. The library therefore keeps the most
recent refresh result (its token, or its error) for exactly this purpose. It is never used to
authenticate a *new* request; `getToken()` remains the only source for those.

The completed-refresh check is made **before** joining an operation that is currently running, and
that order matters. A refresh in flight may have been started by a newer credential than a given
request ever held — one it never used — so joining it would make that request wait for, and fail
with, an outcome belonging to a generation ahead of its own, while the refresh that actually
replaced its credential has already finished.

### Requests that start during a refresh

A request that begins while a refresh is already in flight is **not** sent with a credential the
client already knows was rejected. It waits for the in-flight refresh, then is sent **once**, with
the refreshed token:

```
request A → 401 → starts refresh ─────────┐
                                          │
request B starts during refresh ──────────┤
request C starts during refresh ──────────┤
                                          ↓
                                   refreshed token
                                     ↙    ↓    ↘
                                 retry A  send B  send C
```

B and C never produce an avoidable extra `401`. `getToken()` is not called for them — the token
that the refresh returned is by definition newer than anything storage can offer.

### One retry maximum

A logical request is retried at most once because of authentication:

```
request → 401 → refresh succeeds → retry → 401 → that 401 is returned to you
```

The retry is a straight-line fall-through in the implementation, not a loop and not a recursive
call into `authFetch`, so `401 → refresh → 401 → refresh → …` is structurally impossible.

The retry's response is returned **unclassified**: `isAuthFailure` sees each request's response once,
on the first attempt only.

### Refresh failure

If `refreshToken()` rejects, **every request awaiting that operation rejects with that same
error** — including requests that were waiting to be sent and never reached the network, and those
whose failure was classified just after the refresh gave up. None of them starts a replacement
refresh. The shared slot is then cleared, so the next authentication
failure begins a fresh operation.

```ts
try {
  await authFetch('/api/profile');
} catch (error) {
  // The error your refreshToken() threw, unchanged.
}
```

### `onAuthFailure`

Fires **once per failed shared refresh**, and at no other time. 100 requests joining one refresh
that rejects produce exactly one call, so a logout or a redirect implemented there runs once.

It means one specific thing: *the session could not be recovered*. That is deliberately narrower
than "a request was unauthorized", because the two are different events:

| Event | Signal |
| ----- | ------ |
| The refresh operation failed | `onAuthFailure`, once, and every attached request rejects |
| A request is still unauthorized after a *successful* refresh | the `401` is returned to that caller; no callback |

A retry that comes back `401` does not mean the refresh failed — it succeeded, and the server
simply refused that particular request with a valid credential. That can be a scope or permission
problem on one endpoint, and turning it into a global logout would be wrong. It is left to the
caller, who has the response.

If your `onAuthFailure` throws, the error is **swallowed** and the original refresh error is what
every waiting request receives. Notification is a side channel: it must never replace, reshape, or
delay the failure it was called to report. The behaviour is the same in every runtime — nothing is
routed to `reportError` or any other host-specific hook — so if you need to observe an error from
your own callback, catch it inside the callback.

### Responses are never consumed by the library

Every `Response` handed to a consumer callback — `isAuthFailure`, and the `response` field of
`RefreshContext` and `AuthFailureContext` — is a `response.clone()`. You can read the full body in
a callback and the caller still receives an unconsumed response:

```ts
isAuthFailure: async (response) => {
  if (response.status !== 400) return false;
  const { code } = await response.json(); // safe: this is a clone
  return code === 'token_expired';
};
```

### Body replay

A retry needs the request body a second time, so a replay copy is taken with `Request.clone()`
**before** the first attempt reaches the transport and **before** a token is attached — a retry
therefore never carries the credential that was just rejected, even with an `attachToken` that
appends rather than replaces.

Tested replay cases: `GET`, `POST` with a text body, `POST` with a JSON body, a `Request` object as
input, and a `ReadableStream` body.

Two limitations worth knowing:

- **A stream body is replayed by teeing it.** `clone()` on a `ReadableStream` body buffers the
  unread branch in memory for the duration of the first attempt. Replay is correct, but for a large
  streamed upload it is not free.
- **If the platform cannot produce a replay copy, the request is sent once and its response is
  returned unchanged** — no classification, no refresh, no retry. The library never retries with an
  empty or partially-consumed body. In practice `clone()` succeeds for every body type a freshly
  constructed `Request` can hold, so this is a guard rather than a common path.

A `Request` you pass in that is already consumed (`bodyUsed === true`) makes the native `Request`
constructor throw `TypeError: unusable`, before this library sees it.

### AbortSignal

Cancellation belongs to the individual request; the shared refresh belongs to the client. They stay
independent:

| When you abort                       | What happens                                            |
| ------------------------------------ | ------------------------------------------------------- |
| Before the request is sent           | Rejects with your reason; nothing is sent, `getToken()` is not called |
| During the initial fetch             | Rejects with your reason; no refresh is started         |
| While waiting for the shared refresh | That request rejects and is **never** retried           |
| After the refresh, before the retry  | Rejects with your reason; the retry is never sent       |
| During the retry                     | Rejects with your reason                                |

**Aborting one waiter never cancels the shared refresh** — other requests are still depending on
it, and they are retried normally.

### Caller-provided `Authorization`

If the request already carries an `Authorization` header, the library sends it untouched and stays
out of the **entire** authentication lifecycle: no `getToken()`, no `attachToken()`, no
classification of its `401`, no `refreshToken()`, no retry. That request is the caller's to
authenticate.

```ts
// Sends `Basic …`. A 401 comes straight back to you.
await authFetch('/api/thing', { headers: { Authorization: 'Basic ' + basic } });
```

### Transport resolution

The transport is resolved **once, when the client is created**, and it is client configuration
rather than per-request state — a refresh spans several requests, and resolving `globalThis.fetch`
per call would let a mid-flight swap split one logical operation across two transports. A missing
transport therefore throws from `createAuthFetch()` rather than from the first request. If you
install a `fetch` polyfill, install it before creating the client, or pass it as `fetch`.

### Fetch semantics

Input is normalised with the native `Request` constructor, so the platform — not this library —
decides how method, headers, body, credentials, mode, cache, redirect, and signal are carried over.
Two consequences are worth knowing, and both match plain `fetch`:

- **Passing a `Request` hands over its body.** As with `fetch(request)`, the `Request` you pass is
  left consumed (`bodyUsed === true`) and must not be reused. Pass `request.clone()` if you need
  to keep it.
- **`authFetch(request, { headers })` replaces the header list**, it does not merge it. That is
  `new Request(request, init)` behaviour; the library adds no merging of its own.

Your `Request` and `Headers` objects are never mutated: the token is attached to a `Request` the
library constructed.

Note that a relative URL such as `/api/profile` needs a document base, so it works in a browser but
throws in Node — that is the native `Request` constructor, not this library.

## What this library is not

- **Not a JWT library.** Tokens are opaque strings. Nothing is decoded, parsed, or checked for
  expiry — there is no proactive refresh before a token expires, only reactive refresh after the
  server rejects it.
- **Not an Axios replacement.** It wraps native `fetch` and returns a function with the same
  signature. Standard `Request`, `Response`, `Headers`, `RequestInit`, and `AbortSignal` are used
  throughout — no custom request or response objects, no interceptor pipeline.
- **Not a token store.** Where tokens live and how they are persisted is entirely the consumer's
  concern. The only token the library retains is the one the most recent refresh returned, and only
  so that straggling failures from the same cohort can share it rather than trigger another
  refresh; new requests always come from `getToken()`.
- **Not a retry engine.** No backoff, no timers, no retries for network errors or `5xx`. Exactly
  one retry, and only for authentication.
- **Not tied to an auth provider.** No provider SDKs, no assumptions about grant types.
- **Not cross-tab.** Coordination is per client instance, within one JavaScript realm.

**Zero runtime dependencies.** Dev dependencies (TypeScript, Vitest) exist, but nothing is shipped
alongside the package.

## Requirements

- Node.js >= 22 (native `fetch`), or any browser with the Fetch API.
- ESM only.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Documentation

- [Architecture](./docs/architecture.md) — design principles and the request flow.

## License

[MIT](./LICENSE)
