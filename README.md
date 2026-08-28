# fetch-auth-refresh

A zero-runtime-dependency authentication wrapper for native `fetch` with concurrency-safe
single-flight token refresh.

```
request → attach token → fetch → not an auth failure? return it
                              → auth failure? join the one shared refresh
                                             → retry exactly once with the fresh token
```

## Status

**v0.1.0 — first release, not yet published to npm.** The library is feature-complete for what it
claims to do and covered by 78 tests, but the public API has not been used in anger by anyone but
its author.

While the version is `0.x`, a **minor bump may contain breaking changes**. Pin an exact version if
that matters to you. The surface is deliberately tiny — one function and six types — so the blast
radius of a change is small.

## Why this exists

The hard part of token refresh is not refreshing. It is refreshing *once*.

A page loads several resources at the same time, all carrying the same access token. The token
expires, and every one of them comes back `401` at roughly the same moment. A naive wrapper
refreshes per failed request:

```
20 requests
  → 20 × 401
  → 20 refresh calls        ← the thundering herd
```

This library gives you:

```
20 requests
  → 20 × 401
  → 1 refresh
  → 20 retries
```

That difference is not just about wasted calls:

- **Refresh tokens are often single-use.** Many providers rotate the refresh token on every use and
  invalidate the previous one. Twenty parallel refreshes mean nineteen of them present a token a
  sibling call has already consumed — and the user gets logged out.
- **Auth endpoints are the most aggressively rate-limited ones** in most systems.
- **Last-writer-wins races.** Twenty refreshes produce twenty tokens; whichever finishes last is the
  one stored, and requests retried with the others fail.

## Features

- **Single-flight refresh** — at most one `refreshToken()` call in flight per client, however many
  requests fail at once.
- **Late failures still share it** — a failure classified *after* the refresh already settled joins
  that refresh's result instead of starting its own, so an asynchronous `isAuthFailure` cannot
  degrade single-flight into a sequential stampede.
- **Requests that start mid-refresh wait**, then are sent once with the fresh token, instead of
  being sent with a credential the client already knows was rejected.
- **One retry maximum**, guaranteed by the shape of the code rather than by a counter.
- **Abort isolation** — aborting one request never cancels the refresh other requests depend on.
- **Response clone safety** — callbacks receive clones, so the response you get back is never
  consumed.
- **Nothing of yours is mutated** — your `Request` and `Headers` objects are left untouched.
- **Zero runtime dependencies**, ESM-only, fully typed.

## Installation

> **Not yet published.** This command is what installation *will* look like; it does not work today.
> Until the first publish, install from the repository.

```bash
npm install fetch-auth-refresh
```

Requires Node.js >= 22, or any browser with the Fetch API.

## Quick start

```ts
import { createAuthFetch } from 'fetch-auth-refresh';

let accessToken: string | null = null;

const authFetch = createAuthFetch({
  getToken: () => accessToken,

  refreshToken: async () => {
    const response = await fetch('/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Refresh failed');
    }

    const data = await response.json();
    accessToken = data.accessToken;

    return accessToken;
  },
});

const response = await authFetch('/api/me');
```

`authFetch` has the same signature as `fetch`. `refreshToken()` **returns** the new token rather
than writing it somewhere the library reads back, which keeps the retry from racing against your
storage. **Failure is a rejection, not a sentinel** — throw, and a resolved value is always a usable
token.

More in [`examples/`](./examples): [`basic.ts`](./examples/basic.ts) and
[`custom-auth-failure.ts`](./examples/custom-auth-failure.ts).

## Concurrency behaviour

The first failure starts the refresh; everything else joins it.

```
A ──401─┐
B ──401─┼──→ [ one refreshToken() ] ──→ token
C ──401─┘            │
                     ├──→ retry A
                     ├──→ retry B
                     └──→ retry C
```

A request that *starts* while a refresh is running does not fire off a doomed request first — it
waits, then is sent once, already authenticated:

```
A ──401──→ starts refresh ─────────┐
                                   │
B starts during refresh ───────────┤
C starts during refresh ───────────┤
                                   ↓
                            refreshed token
                             ↙     ↓      ↘
                        retry A  send B  send C
```

`getToken()` is not consulted for B and C: the token the refresh returned is by definition newer
than anything your storage can offer, and reading storage there would reintroduce the
read-after-write race that returning the token was designed to avoid.

## API

### `createAuthFetch(options): AuthFetch`

Returns a `fetch`-compatible function. Throws a `TypeError` at construction time if no transport is
available.

```ts
type AuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
```

### Options

| Option | Signature | Required |
| ------ | --------- | -------- |
| [`getToken`](#gettoken) | `() => string \| null \| Promise<string \| null>` | yes |
| [`refreshToken`](#refreshtoken) | `(context: RefreshContext) => Promise<string>` | yes |
| [`isAuthFailure`](#isauthfailure) | `(response: Response, request: Request) => boolean \| Promise<boolean>` | no |
| [`attachToken`](#attachtoken) | `(request: Request, token: string) => Request \| Promise<Request>` | no |
| [`onAuthFailure`](#onauthfailure) | `(context: AuthFailureContext) => void \| Promise<void>` | no |
| [`fetch`](#fetch) | `typeof globalThis.fetch` | no |

#### `getToken`

Returns the token to attach, or `null` to send the request without credentials. Called once per
outgoing request the library authenticates — but **not** when the caller supplied their own
`Authorization` header, and **not** for a request that waited on a refresh or is being retried after
one. Those use the token `refreshToken()` returned.

#### `refreshToken`

Obtains a fresh token and resolves with it. **At most one call is in flight at a time.**

Receives a `RefreshContext`:

```ts
interface RefreshContext {
  readonly request: Request;                  // the request that started this refresh, as sent
  readonly response: Response;                // a clone of the response classified as a failure
  readonly rejectedToken: string | null;      // the credential the server refused
}
```

When several requests fail at once they share one refresh, so `request` is the one that *started*
it, not each of them. It has already been sent, so treat it as read-only metadata (URL, method,
headers). `rejectedToken` is useful for no-opping when another part of your app has already rotated
the token.

Reject to signal that the session cannot be recovered. Every request attached to the operation then
rejects with that same error, and none of them starts a replacement refresh.

#### `isAuthFailure`

Classifies a response as an authentication failure. Defaults to `response.status === 401`.

Called **once per request, on its first attempt only**. The `response` is a clone, so reading its
body here can never consume the response the caller receives:

```ts
isAuthFailure: async (response) => {
  if (response.status !== 400) return false;
  const { code } = await response.json();  // safe: this is a clone
  return code === 'token_expired';
},
```

Only classification belongs here. Whether to refresh, and how many times, is the library's decision.

#### `attachToken`

Attaches a token to an outgoing request and returns the request to send. Defaults to
`Authorization: Bearer <token>`.

This is the single credential-attachment path — used for the initial request, for a request that
waited on a refresh, and for a retry. The `request` is always one the library constructed, never
yours, so mutating its headers in place is safe:

```ts
attachToken: (request, token) => {
  request.headers.set('X-Api-Key', token);
  return request;
},
```

Not called when there is no token, or when the caller set their own `Authorization` header.

#### `onAuthFailure`

Called when `refreshToken()` rejected — **once per failed shared refresh**, never once per waiting
request. A hundred requests joining one failed refresh produce exactly one call, so a logout
implemented here runs once.

```ts
interface AuthFailureContext {
  readonly request: Request;    // the request that started the failed refresh
  readonly response: Response;  // a clone, safe to read
}
```

It cannot change the outcome of a request. If it throws, the error is swallowed and the original
refresh error is what waiting requests receive.

#### `fetch`

The underlying transport. Defaults to the global `fetch`, bound to `globalThis`, and resolved
**once when the client is created** — not per request. A refresh spans several requests, and
resolving the global per call would let a mid-flight swap split one logical operation across two
transports. If you install a `fetch` polyfill, install it before creating the client, or pass it
here.

## Important semantics

**A caller-supplied `Authorization` header bypasses everything.** Not just "the header is not
overwritten": no `getToken`, no `attachToken`, no classification, no refresh, no retry. That request
is yours to authenticate.

**One retry maximum.** `401 → refresh → retry → 401` returns that second `401` to you. The retry is
a fall-through in the implementation, not a loop and not a recursive call, so
`401 → refresh → 401 → refresh → …` is structurally impossible. The retry's response is returned
**unclassified**.

**Single-flight, and it survives late classification.** Refresh operations are numbered, and each
request records the current number alongside the token it was sent with. A failure may consume the
result of a refresh that completed *after* its credential was obtained, and never one that completed
*before*. That rule separates a straggler from the same wave (takes the completed refresh's result)
from a request that genuinely used the refreshed token and was rejected anyway (starts a new
refresh) — decided from request-local state, never from timing.

**Requests arriving mid-refresh wait** and are then sent once with the fresh token.

**Aborting is per request.** A request's signal abandons it at any stage — before it is sent, during
the fetch, while waiting on the refresh, between the refresh and the retry, and during the retry —
and rejects with your reason. A request aborted while waiting on a refresh is **never** retried.
**Aborting one waiter never cancels the shared refresh**; other requests still get their retry.

**Refresh rejection propagates unchanged.** `authFetch()` rejects with your own error, for every
request attached to that operation, including ones that were waiting to be sent and never reached
the network. The shared slot is then cleared, so the next authentication failure begins a fresh
operation.

**Responses handed to callbacks are always clones.** The response you receive always has
`bodyUsed === false`.

**Request bodies are replayed by cloning.** The replay copy is taken before the first send and
before a token is attached, so a retry never carries the credential that was just rejected — even
with an `attachToken` that appends rather than replaces. Two things follow: a `ReadableStream` body
is replayed by teeing it, which **buffers the unread branch in memory** for the duration of the
first attempt, so a large streamed upload is not free; and if the platform cannot produce a replay
copy, the request is sent once and its response returned unchanged rather than retried with a
consumed body.

## Compatibility

- **Node.js >= 22.** The library itself needs only the Web Platform Fetch APIs (`fetch`, `Request`,
  `Response`, `Headers`, `AbortSignal`), which Node has had since 18. The floor is set by support
  policy rather than by an API: Node 18 and 20 are both past end-of-life, so 22 is the oldest line
  still receiving security fixes. Nothing in the emitted code prevents it from running on 18 or 20;
  those versions are simply not tested or supported.
- **Browsers:** any with the Fetch API. No DOM APIs beyond `fetch` are used — no `localStorage`, no
  `window`, no timers.
- **ESM only.** There is no CommonJS build.
- **Relative URLs need a document base**, so `/api/me` works in a browser and throws in Node. That is
  the native `Request` constructor, not this library.
- **`authFetch(request, { headers })` replaces the header list**, it does not merge — that is
  `new Request(request, init)` behaviour. Likewise, passing a `Request` hands over its body, leaving
  your object with `bodyUsed === true`, exactly as `fetch(request)` does.

## What this is not

Not a JWT library (tokens are opaque strings; no decoding, no proactive expiry). Not an Axios
replacement (no interceptors, no custom request/response types). Not a token store (persistence is
yours). Not a retry engine (no backoff, no `5xx` retries). Not tied to an auth provider. Not
cross-tab — coordination is per client instance, within one JavaScript realm.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

`npm run verify` runs all three.

## Documentation

- [Architecture](./docs/architecture.md) — the concurrency model, the generation invariant, and the
  reasoning behind each design decision.
- [Changelog](./CHANGELOG.md)
- [Security policy](./SECURITY.md)

## License

[MIT](./LICENSE)
