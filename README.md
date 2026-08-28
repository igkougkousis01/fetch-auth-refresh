# fetch-auth-refresh

> **Status: early development.** Token attachment works. **Token refresh does not exist yet** —
> a `401` is returned to you unchanged. Do not use this in production.

A small, zero-runtime-dependency TypeScript wrapper around the native Fetch API that adds
concurrency-safe access token refresh.

## The problem

Almost every app that talks to an authenticated HTTP API ends up rewriting the same logic:

1. Attach the current access token to each request.
2. Notice that the server rejected the token (usually `401`).
3. Refresh the token.
4. Retry the original request.

Written by hand, this logic tends to leak into every call site, or to grow into a bespoke HTTP
client that has to be maintained forever. `fetch-auth-refresh` will do exactly those four steps
and nothing else. **Step 1 is implemented; steps 2–4 are not.**

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

**This is the library's reason to exist, and it is not built yet.**

## Implementation status

### Works today

- Accepts every native `fetch` input form: `authFetch(url, init)`, `authFetch(request)`,
  strings, `URL`s, and `Request`s.
- Calls `getToken()` (sync or async) for each outgoing request it authenticates.
- Attaches `Authorization: Bearer <token>` by default, or whatever `attachToken()` decides.
- Sends a normal unauthenticated request when `getToken()` returns `null`.
- Never overwrites an `Authorization` header the caller set — caller intent wins.
- Uses an injected `fetch`, or the global one.
- Returns the underlying `Response` unchanged, body untouched.

### Not implemented yet

- Detecting authentication failures. `isAuthFailure()` is **never called**; a `401` comes straight
  back to you.
- Refreshing. `refreshToken()` is **never called**.
- Retrying, request queuing, and response recovery.
- **Single-flight coordination.** There is no shared refresh promise yet.
- `onAuthFailure()` is **never called**.

`refreshToken`, `isAuthFailure`, `onAuthFailure` exist in the type surface so that consumers can
write against the final shape, but supplying them changes nothing today.

## What this library is not

- **Not a JWT library.** Tokens are opaque strings. Nothing is decoded, parsed, or checked for
  expiry.
- **Not an Axios replacement.** It wraps native `fetch` and returns a function with the same
  signature. Standard `Request`, `Response`, `Headers`, `RequestInit`, and `AbortSignal` are used
  throughout — no custom request or response objects.
- **Not a token store.** Where tokens live and how they are persisted is entirely the consumer's
  concern; the library holds no token state.
- **Not tied to an auth provider.** No provider SDKs, no assumptions about grant types.

**Zero runtime dependencies.** Dev dependencies (TypeScript, Vitest) exist, but nothing is shipped
alongside the package.

## API

```ts
import { createAuthFetch } from 'fetch-auth-refresh';

const authFetch = createAuthFetch({
  // Return the token to attach, or null to send the request unauthenticated.
  getToken: () => localStorage.getItem('access_token'),

  // Obtain a fresh token and return it. Will be called at most once at a time.
  // Throw if the session cannot be recovered.
  // NOT CALLED YET.
  refreshToken: async () => {
    const response = await fetch('/auth/refresh', { method: 'POST' });
    if (!response.ok) throw new Error('Session expired');

    const { accessToken } = await response.json();
    localStorage.setItem('access_token', accessToken);
    return accessToken;
  },

  // Optional. Defaults to `response.status === 401`. NOT CALLED YET.
  isAuthFailure: (response) => response.status === 401,

  // Optional. Called when a request could not be recovered. NOT CALLED YET.
  onAuthFailure: () => {
    localStorage.removeItem('access_token');
    redirectToLogin();
  },
});

// Same signature as fetch.
const response = await authFetch('/api/profile');
```

`refreshToken()` returns the new token rather than writing it somewhere the library reads back.
That keeps the retry from racing against the consumer's storage, and keeps persistence optional.
**Refresh failure is a rejection, not a return value** — there is no `null` sentinel, so a resolved
value is always a usable token.

### Caller intent wins

If the request already carries an `Authorization` header, the library sends it untouched and does
not even call `getToken()`. That request is the caller's to authenticate:

```ts
// Sends `Basic …`. The token provider is never consulted.
await authFetch('/api/thing', { headers: { Authorization: 'Basic ' + basic } });
```

### Custom attachment

`attachToken()` receives a `Request` **owned by the library** — never the object you passed in — so
mutating its headers in place is safe:

```ts
const authFetch = createAuthFetch({
  getToken,
  refreshToken,
  attachToken: (request, token) => {
    request.headers.set('X-Api-Key', token);
    return request;
  },
});
```

### Fetch semantics

Input is normalised with the native `Request` constructor, so the platform — not this library —
decides how method, headers, body, credentials, mode, cache, redirect, and signal are carried
over. Two consequences are worth knowing, and both match plain `fetch`:

- **Passing a `Request` hands over its body.** As with `fetch(request)`, the `Request` you pass is
  left consumed (`bodyUsed === true`) and must not be reused. Pass `request.clone()` if you need
  to keep it.
- **`authFetch(request, { headers })` replaces the header list**, it does not merge it. That is
  `new Request(request, init)` behaviour; the library adds no merging of its own.

Your `Request` and `Headers` objects are never mutated: the token is attached to a `Request` the
library constructed.

Note that a relative URL such as `/api/profile` needs a document base, so it works in a browser but
throws in Node — that is the native `Request` constructor, not this library.

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
