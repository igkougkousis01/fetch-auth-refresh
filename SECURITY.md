# Security policy

## Supported versions

This project is pre-1.0. Only the latest `0.x` release receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's private vulnerability reporting:

<https://github.com/igkougkousis01/fetch-auth-refresh/security/advisories/new>

That channel is private to the maintainer until an advisory is published. This
is a small, personally maintained project, so please allow a reasonable window
for a first response before disclosing publicly.

A useful report includes the affected version, a description of the impact, and
the smallest reproduction you can manage.

## Scope

This package coordinates *when* credentials are attached and refreshed. It never
stores, parses, decodes, validates, or transmits credentials on its own: token
storage, the refresh request, and the definition of an authentication failure are
all supplied by the consumer.

Findings that are in scope include, for example:

- a token leaking onto a request that should not carry it — in particular, a
  retry carrying a credential that was already rejected;
- a caller-supplied `Authorization` header being replaced or a token being
  attached to a request the library was told not to authenticate;
- a refresh result being handed to a request whose credential it does not
  replace, or single-flight breaking such that one expired token triggers many
  refresh calls;
- a `Response` or `Request` belonging to one caller being observable by another.

Out of scope: how your application stores tokens, what your `refreshToken()`
endpoint does, transport security (TLS), and vulnerabilities in Node.js or in a
browser's own `fetch` implementation.
