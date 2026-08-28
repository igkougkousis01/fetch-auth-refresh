# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, a minor bump may contain breaking changes.

## [Unreleased]

## [0.1.0] - 2026-08-28

First release. Everything below is the initial feature set, not a change from a
previous version.

### Added

- `createAuthFetch(options)` — returns a function with the same signature as
  `fetch` that attaches an access token to outgoing requests and refreshes it,
  once, when the server rejects it.
- **Single-flight refresh.** At most one `refreshToken()` call is in flight per
  client. Concurrent authentication failures join the same operation and are all
  retried with the same resolved token.
- **Generation-aware late failures.** Refresh operations are numbered, and a
  request records the current number alongside the token it was sent with, so a
  failure classified *after* the refresh already settled still shares that
  refresh's result instead of starting its own. This keeps single-flight intact
  when `isAuthFailure` is asynchronous.
- **Requests that start mid-refresh wait**, then are sent once with the
  refreshed token, rather than being sent with a credential the client already
  knows was rejected.
- **One retry maximum**, guaranteed structurally: the retry is a fall-through,
  not a loop or a recursive call, and its response is returned unclassified.
- **Refresh failure fans out.** If `refreshToken()` rejects, every request
  attached to that operation rejects with the same error, and none starts a
  replacement refresh.
- `onAuthFailure` — called once per failed shared refresh, never once per
  waiting request. A throwing callback is swallowed so it cannot reshape the
  refresh error.
- `isAuthFailure` — response classification, defaulting to `status === 401`. May
  be asynchronous.
- `attachToken` — credential attachment, defaulting to
  `Authorization: Bearer <token>`. Used by the initial request and the retry
  alike.
- `fetch` — transport injection, resolved once at client creation.
- **Abort isolation.** A request's `AbortSignal` abandons that request at any
  stage, including while it waits on the shared refresh, without cancelling the
  refresh other requests depend on.
- **Response clone safety.** Every `Response` handed to a consumer callback is a
  `response.clone()`, so the response returned to the caller is never consumed.
- **Body replay.** A replay copy is taken with `Request.clone()` before the first
  send and before token attachment, so a retry never carries the rejected
  credential.
- Exported types: `AccessToken`, `AuthFetch`, `AuthFetchOptions`,
  `AuthFailureContext`, `FetchLike`, `RefreshContext`.
- ESM-only distribution with TypeScript declarations, zero runtime dependencies.

[unreleased]: https://github.com/igkougkousis01/fetch-auth-refresh/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/igkougkousis01/fetch-auth-refresh/releases/tag/v0.1.0
