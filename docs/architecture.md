# Architecture

> Status: this document describes the design the library is being built towards. The
> token-attachment path is implemented; the refresh path is not. Each section says which.

## Implementation status

| Stage                                   | Status                            |
| --------------------------------------- | --------------------------------- |
| Normalise input to a library-owned `Request` | Implemented                   |
| `getToken()` per outgoing request       | Implemented                       |
| Attach token (default or `attachToken`) | Implemented                       |
| Call the underlying `fetch`             | Implemented                       |
| Return the `Response` unchanged         | Implemented                       |
| Classify auth failures (`isAuthFailure`) | Not implemented — never called   |
| Single-flight refresh (`refreshToken`)  | Not implemented — never called    |
| Retry once with the fresh token         | Not implemented                   |
| `onAuthFailure` notification            | Not implemented — never called    |

The implemented lifecycle is exactly:

```
caller
  → build a library-owned Request
  → getToken()
  → attach the token if there is one
  → underlying fetch
  → return the Response unchanged   (401 included)
```

## Principles

### 1. Transport vs. authentication policy

The library owns **transport coordination**. The consumer owns **authentication policy**.

| Library (transport)                      | Consumer (policy)                         |
| ---------------------------------------- | ----------------------------------------- |
| When a refresh is started                | How a token is obtained and renewed       |
| That only one refresh runs at a time     | Where tokens are stored                   |
| That a request is retried at most once   | What a token *is* (JWT, opaque, anything) |
| How a token is attached (default scheme) | Which responses mean "not authenticated"  |
| Abort and body-replay safety             | What to do when the session is lost       |

Anything that would require the library to understand a specific auth provider, token format, or
storage medium belongs on the consumer's side of that line.

### 2. Single-flight refresh — *not implemented*

At most one refresh operation exists at any moment. The first request to observe an authentication
failure creates it; every other request that fails while it is pending awaits the *same* promise
rather than starting its own. This is the library's core reason to exist — see the README for why
parallel refreshes break single-use refresh tokens.

When the operation settles, the in-flight reference is cleared so that a later expiry starts a
fresh one.

Today there is no shared promise and no refresh: an authentication failure is returned to the
caller untouched.

### 3. One retry maximum — *not implemented*

A request is retried at most once, and only after a refresh that produced a token. If the retry
also fails authentication, that response is returned to the caller as-is. There is no backoff loop
and no second refresh triggered by the same request.

### 4. No recursive refresh loops — *not implemented*

A retried request is marked as already-retried, so it can never re-enter the refresh path. The
consumer's own `refreshToken()` implementation is expected to use plain `fetch` — if it were to
use the wrapped fetch, that would be a consumer-side cycle the library cannot detect.

Every request therefore performs a bounded amount of work: at most two `fetch` calls and at most a
share in one refresh. Today the bound is one `fetch` call.

### 5. Consumer-controlled token persistence — *implemented*

The library stores no tokens. It calls `getToken()` before a request and will receive the new token
as the return value of `refreshToken()`. Between those two points it holds a token only for the
duration of a single request. Consumers are free to use memory, `localStorage`, cookies, a
platform keychain, or a server-side session store.

Taking the refreshed token as a return value (rather than re-reading `getToken()` after a refresh)
avoids a read-after-write race with asynchronous storage.

**Refresh failure is a rejection, not a sentinel.** `refreshToken()` resolves only with a usable
token; an unrecoverable session is signalled by throwing. A `null` return would have been a second,
weaker channel for the same condition — consumers would have had to handle both, and a
`Promise<AccessToken | null>` makes every call site test for a value the type says is valid. The
type is `Promise<AccessToken>`, and the library treats any rejection as "refresh failed".

### 6. Standards-first Fetch compatibility — *implemented*

`createAuthFetch()` returns a function with the same signature as `fetch`. Inputs are normalised to
a standard `Request`; `Response`, `Headers`, `RequestInit`, and `AbortSignal` are used unchanged.
No custom request/response wrapper types, no interceptor framework, no serialisation opinions. If
`fetch` can do it, the wrapper can do it — including streaming responses and `AbortController`.

The whole of the input handling is one line — `new Request(input, init)` — and that is deliberate.
The Fetch spec already defines how a `Request` merges with a `RequestInit`, how a body is
transferred, and how a signal is followed. Re-deriving any of it by hand would be both longer and
wrong at the edges.

Consequences that fall out of using the platform:

- **Headers are replaced, not merged**, when `init.headers` is present alongside a `Request` input.
  That is `new Request()` behaviour and the library does not paper over it.
- **A `Request` input's body is transferred**, leaving the caller's object with
  `bodyUsed === true`. Native `fetch(request)` does the same; callers who need to keep the request
  pass a `clone()`.
- **The outgoing `signal` is a new `AbortSignal` that follows the caller's**, so it is not
  reference-equal to the one passed in, but aborting the caller's controller still aborts the
  request.
- **Relative URLs need a document base**, so they work in browsers and throw in Node. That is the
  `Request` constructor, not this library.

Once retries exist: a caller's `AbortSignal` must abort the original request, the wait for the
refresh, and the retry — while aborting one request must not abort a shared refresh that other
requests are waiting on.

### 7. Nothing the caller set is mutated — *implemented*

The library authenticates a `Request` it constructed itself, never the caller's object. The token
is attached by mutating that owned request's `Headers`, which is why `attachToken()` can safely
mutate in place: the object it receives has no other owner. The caller's `Request` and `Headers`
objects come out of a call unchanged.

An explicit `Authorization` header from the caller is treated as authentication the caller has
already performed: it is neither overwritten nor supplemented, and `getToken()` is not called for
that request at all. Consulting a token provider — which may hit storage or the network — to then
discard its result would be surprising.

### 8. Responses are never consumed by the library — *rule fixed, enforcement pending*

A `Response` body is a single-use stream. Any response handed to a consumer callback
(`isAuthFailure`, and the `response` field of `RefreshContext` and `AuthFailureContext`) will be a
**`response.clone()`**, so that a consumer inspecting the body — reading a JSON error code, say —
can never consume the response that is returned to the caller.

The response the caller receives is the one the underlying `fetch` produced, with `bodyUsed` still
`false`. Today that is trivially true because no callback sees a response at all; the rule is
recorded now because the refresh path is where it can be broken silently.

### 9. Minimal dependency surface — *implemented*

Zero runtime dependencies, permanently. TypeScript and Vitest are dev-only. The entire runtime is
intended to stay in the low hundreds of lines.

## Conceptual flow

Implemented today:

```
request
  → normalise to a library-owned Request
  → caller-supplied Authorization header?
      yes → fetch as-is
      no  → getToken()
              null  → fetch unauthenticated
              token → attach (Bearer by default, or attachToken)
                    → fetch
  → return the response unchanged
```

Target, once the refresh path lands:

```
request
  → attach current token
  → fetch
  → authentication failure?   (isAuthFailure, given a cloned response)
      no  → return response
      yes → already retried?
              yes → return response (invoke onAuthFailure)
              no  → acquire or join the one shared refresh operation
                  → obtain fresh token
                      rejects → return original response (invoke onAuthFailure)
                      token   → retry request once with the fresh token
                              → return response
```

## Known design questions (open)

These remain unresolved, and all belong to the refresh path:

- **Non-replayable bodies.** A request whose body is a `ReadableStream` is consumed by the first
  attempt and cannot be retried. The likely rule: clone the `Request` before sending when the body
  is replayable, and return the original failure without retrying when it is not.
- **Requests started mid-refresh.** Should a request that begins while a refresh is pending wait
  for it, or be sent with the current (probably stale) token and rely on the normal failure path?
  Waiting is friendlier; sending immediately is simpler and avoids stalling unauthenticated calls.
- **Refresh failure fan-out.** When a refresh fails, every waiting request needs the failure, but
  `onAuthFailure` should plausibly fire once rather than once per waiting request.
