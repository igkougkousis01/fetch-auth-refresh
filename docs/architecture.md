# Architecture

## The implemented lifecycle

```
caller
  → normalise input to a library-owned Request
  → caller-supplied Authorization header?
      yes → fetch as-is, no authentication lifecycle at all
  → signal already aborted? → reject
  → a refresh already in flight?
      yes → wait for it (abort-aware) → use its token
      no  → getToken()
  → take a replay copy of the request
  → attach the token (default Bearer, or attachToken)
  → fetch
  → isAuthFailure(clone of response, request)?
      no  → return the response unchanged
      yes → start or join the one shared refresh operation
              rejects → onAuthFailure once for the operation, then every waiter
                        rejects with that error
              token   → retry exactly once with it
                        → return the retry response unclassified, whatever it is
```

Every request performs a bounded amount of work: at most two `fetch` calls and at most a share in
one refresh.

## The concurrency model

The synchronisation primitive is one closure variable:

```ts
let refreshPromise: Promise<AccessToken> | null = null;
```

plus one record that extends single-flight past the moment it settles:

```ts
interface CompletedRefresh {
  generation: number;                                    // 1-based ordinal
  result: { token: AccessToken } | { error: unknown };
}

let lastRefresh: CompletedRefresh | null = null;
```

The ordinal and the result it produced are written in a single assignment, so they cannot drift
apart. Refreshes never overlap, so the ordinal totally orders them.

No queue, no lock, no event emitter, no state machine.

### Why one shared promise is enough

A promise is already the thing being coordinated on: a single future value that any number of
consumers can await, that settles once, and that delivers the same result to all of them. A queue
of waiting requests would have to re-implement exactly that, plus its own fan-out on failure and
its own cleanup on abort.

### Acquire and release

Reduced to the promise slot alone — the generation check that precedes it in the real function is
introduced two sections down, and the full version appears there:

```ts
function acquireRefresh(/* … */ request, response, rejectedToken) {
  if (refreshPromise !== null) return refreshPromise;   // join

  const started = runRefresh(request, response, rejectedToken);
  refreshPromise = started;                             // claim

  const clear = () => { if (refreshPromise === started) refreshPromise = null; };
  void started.then(clear, clear);                      // release on settle

  return started;
}
```

Two properties make this safe:

- **The read and the write are synchronous and adjacent.** There is no `await` between
  `if (refreshPromise !== null)` and `refreshPromise = started`, and JavaScript is single-threaded,
  so no interleaving is possible. Two concurrent requests can never both observe `null`.
- **Release is identity-checked.** `clear` nulls the slot only if it still holds *this* operation,
  so a late callback from a previous refresh can never wipe out a newer one.

The release handler is registered before any waiter awaits the promise, so by the time waiters
resume the slot is already empty. A request whose failure arrives after that legitimately starts a
new operation — which is the desired behaviour, not a race.

### Why the in-flight promise alone is not enough

A shared promise coordinates requests that are failing *at the same time*. Failures are not
delivered at the same time.

Take the README's thundering-herd example and scale it to 100 requests: they are sent with one
expired token and all come back `401`, but each one is then classified independently — and classification can be
asynchronous, because `isAuthFailure` is allowed to read the response body. The first failure
starts the refresh; the refresh finishes; the slot is cleared. Then the second failure is
classified, finds nothing in flight, and starts its own refresh. Then the third. One expired token
produces 100 sequential refreshes, which is precisely the failure mode this library exists to
prevent — and it is invisible to a test that responds to all 100 requests before letting the
refresh settle. It was caught during development, by a throwaway harness that drove the built
package against a real HTTP server (see [Testing approach](#testing-approach)).

The fix is to give "the same cohort" a definition that outlives the promise. A request records the
current generation next to the token it is sent with:

```ts
const credentialGeneration = currentGeneration();   // lastRefresh?.generation ?? 0
```

and when its failure is finally classified, that number decides everything:

```ts
// 1. A refresh completed after this credential was obtained: take its result.
if (lastRefresh !== null && lastRefresh.generation > credentialGeneration) {
  const { result } = lastRefresh;
  return 'token' in result ? Promise.resolve(result.token) : Promise.reject(result.error);
}

// 2. Nothing has replaced this credential yet, but an operation is running: join it.
if (refreshPromise !== null) return refreshPromise;

// 3. Start one.
```

### The generation invariant

> **An authentication failure may consume the result of a refresh that completed *after* its
> credential was obtained, and may never consume the result of one that completed *before*.**

A refresh that completed beforehand was replacing some earlier credential — not the one that just
failed — so reusing it would answer the failure with a token already known to be no newer than the
rejected one. That single rule separates the two cases that look identical from outside:

- **a straggler**: it failed with a credential a refresh has since replaced
  (`lastRefresh.generation > credentialGeneration`), so it takes that refresh's result;
- **a genuinely later failure**: the request *used* the refreshed token and was rejected anyway
  (`lastRefresh.generation === credentialGeneration`), so nothing has replaced its credential and it
  must start a new refresh.

Successes and failures both advance the generation, so a straggler shares the token on success and
the error on failure — and `onAuthFailure` still fires exactly once for the operation.

### Why the completed check comes before the in-flight check

Step 1 is deliberately ahead of step 2. A refresh may be running that was started by a *newer*
credential than some request ever held:

```
A(token-1) → 401 → refresh #1 ──→ token-2
B(token-1) → 401, classification still running
                    C(token-2) → 401 → refresh #2 (in flight)
B's classification finishes here
```

B belongs to generation 0. Refresh #2 was triggered by token-2 — a credential B never used, whose
rejection says nothing about B. Joining it would make B wait for an operation it has no stake in,
and if refresh #2 rejected, B would fail without ever having been given token-2, the token that
actually replaced its own. B takes refresh #1's result and retries with token-2; if that is refused
too, B's `401` is returned, because one retry is the limit. It does not start a refresh #3.

Checking the in-flight slot first is exactly the bug this ordering fixes — it was found by
reproducing the sequence above against the built package, and `scenario 3` and `scenario 3b` in
`test/refresh.test.ts` now pin it deterministically.

### Where the snapshot is taken

`credentialGeneration` is read *after* `getToken()` returns, not before. If a refresh completes
while that read is in flight, the token coming back may well be the one that refresh produced;
counting it as "before" would let a later failure of that very token consume the refresh that
created it, retrying with the credential that had just been rejected. Reading afterwards can only
overstate a credential's vintage, which costs at most one redundant refresh in a narrow window —
never a wrong reuse. The invariant is one-directional on purpose.

This is the one piece of token state the library holds. It is never a source of credentials for new
requests; `getToken()` remains that. It exists only to answer a failure that predates it.

### The other half: requests that start mid-refresh

The same variable is read at the *top* of a request, before any `await`:

```ts
const pendingRefresh = refreshPromise;
const token = pendingRefresh === null
  ? await options.getToken()
  : await waitFor(pendingRefresh, signal);
```

This is what stops a request from being deliberately sent with a credential the client already
knows was rejected, and it is why B and C in the README's diagram never produce their own `401`.
`getToken()` is skipped on that path on purpose: the refresh's return value is newer than anything
consumer storage can offer, and reading storage there would reintroduce the read-after-write race
that returning the token was designed to avoid.

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

### 2. One retry maximum, structurally

The retry is a fall-through at the end of the request function: the response it produces is
classified only to decide whether to call `onAuthFailure`, and there is no syntactic path from
there back to the refresh branch. It is deliberately *not* a recursive call to the public
`authFetch`, and not a loop with a counter, because both of those make the bound a runtime property
that has to be argued about rather than a shape you can see.

The consumer's own `refreshToken()` is expected to use plain `fetch`. If it were to use the wrapped
fetch, that would be a consumer-side cycle the library cannot detect.

### 3. Consumer-controlled token persistence

The library stores no tokens. It calls `getToken()` before a request and receives the new token as
the return value of `refreshToken()`. Between those two points it holds a token only for the
duration of a single request.

Taking the refreshed token as a return value — rather than re-reading `getToken()` after a
refresh — avoids a read-after-write race against asynchronous consumer storage. Every request
joining one refresh therefore uses the identical token, not whatever each of them happens to read.

**Refresh failure is a rejection, not a sentinel.** `refreshToken()` resolves only with a usable
token; an unrecoverable session is signalled by throwing. A `null` return would have been a second,
weaker channel for the same condition — consumers would have had to handle both, and a
`Promise<AccessToken | null>` makes every call site test for a value the type says is valid.

A rejection propagates: `authFetch()` rejects with the consumer's own error, for every request
attached to that operation. The alternative — resolving with the original `401` — would have hidden
the reason the session could not be recovered behind a response body the server wrote.

### 4. `onAuthFailure` reports a lost session, not an unauthorized request

Consumers put logout, navigation, state clearing, and telemetry in this callback, so it fires once
per **failed shared refresh** — from inside the shared operation, never from each waiter. One
expired session produces one logout, whether one request or a hundred were attached to it.

It deliberately does *not* fire when a retry comes back `401`. Those are different events:

| Event | Meaning |
| ----- | ------- |
| The refresh operation rejected | the session could not be recovered — a client-wide fact |
| A retry is still unauthorized | the server refused one request that carried a valid, freshly issued credential |

The second is not evidence that authentication is broken; it can be a scope or permission problem
on a single endpoint. Escalating it to a global logout would log users out on the strength of one
endpoint's answer, and with a hundred concurrent retries it would do so a hundred times. The
response goes back to the caller, who has the context to interpret it. This is also why the retry's
response is not classified at all: there is no decision left for the library to make.

A throwing callback is swallowed. Letting it propagate would replace the refresh error — the thing
the callback was called to report — with an error from the reporting itself. Forwarding it to a
host hook such as `reportError` was considered and rejected: it exists in browsers and Deno but not
in Node, so identical code would behave differently per runtime, and a library this small should
not carry host-specific error plumbing. Consumers who need to observe an error from their own
callback catch it inside the callback.

### 5. Standards-first Fetch compatibility

`createAuthFetch()` returns a function with the same signature as `fetch`. Inputs are normalised to
a standard `Request`; `Response`, `Headers`, `RequestInit`, and `AbortSignal` are used unchanged.
No custom request/response wrapper types, no interceptor framework, no serialisation opinions.

The whole of the input handling is one line — `new Request(input, init)` — and that is deliberate.
The Fetch spec already defines how a `Request` merges with a `RequestInit`, how a body is
transferred, and how a signal is followed. Re-deriving any of it by hand would be both longer and
wrong at the edges. The same reasoning drives body replay: `Request.clone()` rather than sniffing
body types and re-serialising them.

Consequences that fall out of using the platform:

- **Headers are replaced, not merged**, when `init.headers` is present alongside a `Request` input.
- **A `Request` input's body is transferred**, leaving the caller's object with
  `bodyUsed === true`. Native `fetch(request)` does the same.
- **The outgoing `signal` is a new `AbortSignal` that follows the caller's**, so it is not
  reference-equal to the one passed in, but aborting the caller's controller still aborts the
  request, the wait for a refresh, and the retry.
- **Relative URLs need a document base**, so they work in browsers and throw in Node.

### 6. Nothing the caller set is mutated

The library authenticates a `Request` it constructed itself, never the caller's object. The token
is attached by mutating that owned request's `Headers`, which is why `attachToken()` can safely
mutate in place: the object it receives has no other owner.

An explicit `Authorization` header from the caller is treated as authentication the caller has
already performed. That bypass is total — not just "do not overwrite the header", but also no
`getToken`, no classification, no refresh, and no retry. Consulting a token provider to discard its
result would be surprising; refreshing a credential the library did not issue would be worse.

### 7. Responses are never consumed by the library

A `Response` body is a single-use stream. Every response handed to a consumer callback
(`isAuthFailure`, and the `response` field of `RefreshContext` and `AuthFailureContext`) is a
`response.clone()`, taken from the untouched original each time, so several callbacks can each read
the full body. The response the caller receives always has `bodyUsed === false`.

### 8. Cancellation is per request; refresh is per client

A request's `AbortSignal` must be able to abandon that request at any stage, including while it is
waiting on a shared refresh — but abandoning the wait must not cancel the refresh, because other
requests are still depending on it. The shared refresh is therefore never given a request's signal.

The wait is a small helper that races the shared promise against the signal and detaches its
listener on settlement. Nothing else is needed: an abort while waiting rejects only that request,
and it never reaches its retry.

### 9. A stable transport

`globalThis.fetch` is resolved once, at client creation. Resolving it per request would make one
logical operation — an initial request, a shared refresh, and a retry — able to straddle two
different transports if the global were swapped in between. Late-installed polyfills are not
supported on purpose: the library does not promise that feature, and promising it would cost the
stability of the client's own configuration.

### 10. Minimal dependency surface

Zero runtime dependencies, permanently. TypeScript and Vitest are dev-only.

## Resolved design questions

These were open while the refresh path was being designed. All are now decided and tested.

- **Non-replayable bodies.** Resolved by measurement: `Request.clone()` handles every body type a
  freshly constructed `Request` can hold, including a `ReadableStream`, which it tees. The replay
  copy is taken before the first send and before token attachment. The "cannot clone" branch
  remains as an explicit guard — such a request is sent once and its response returned unchanged,
  never retried with a corrupted body — but it is not a path real bodies take. The honest cost of
  stream replay is memory: the tee'd branch buffers for the duration of the first attempt.
- **Requests started mid-refresh.** They wait. Sending them immediately with a credential the client
  already knows was rejected would manufacture extra `401`s and extra load on the API for no gain.
- **Refresh failure fan-out.** Every waiter rejects with the same error; `onAuthFailure` fires once
  for the operation. Requests whose failure is classified just after the refresh gave up share that
  error too, rather than each retrying the refresh.

## Testing approach

The concurrency tests use no timers and no sleeps. A stand-in transport records every call and hands
the test explicit control over when each one completes, and `refreshToken` is gated on a deferred
promise the test resolves or rejects. Transport call counts are asserted at each state transition —
before the failures land, after the refresh starts, and after it settles — so "exactly one refresh"
and "waited before being sent" are observed rather than inferred.

`test/refresh.test.ts` covers, among others: 20 and 100 simultaneous `401`s producing one refresh;
100 failures classified *after* the refresh has already settled still producing one refresh;
requests that start mid-refresh not reaching the transport; failure fan-out; state reset after both
success and failure; every body-replay case; and all five abort positions.

A `refresh generations` suite drives the invariant directly, gating `isAuthFailure`, `getToken`, and
`refreshToken` completion by hand so that a straggler and a genuinely later failure can be made
indistinguishable by timing and separated only by generation. It covers a late classifier consuming
a completed refresh; a request that used the refreshed token starting a new one; a straggler
declining to join — or be failed by — a refresh from a newer generation; a failed generation not
leaking into the next; a genuine failure after a success receiving the new error; and the snapshot
boundary where a credential is read across a completing refresh.

The invariants are checked by mutation: reordering the two checks, weakening `>` to `>=`, removing
the generation shortcut, moving the snapshot before `getToken()`, and dropping the generation stamp
from a failed refresh each break at least one test.

Both bugs described above were found with a throwaway harness that ran the built ESM output
against a real `node:http` server with the real global `fetch` — a stand-in transport that completes
only when the test says so can hide timing that a real network exposes. That harness was development
scaffolding and is **not** part of the repository; it was not a regression test, and the behaviour it
uncovered is pinned by the deterministic tests above instead. CI covers the built artefact from the
other direction: it packs the tarball, installs it into a scratch consumer project, and runs the
package's own `.d.ts` through `tsc` and its ESM output through Node.
