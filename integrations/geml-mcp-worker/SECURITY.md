# Security Policy

This Worker is part of the [GEML](https://github.com/geml-spec/geml) repository
and is covered by the project's single security policy. Supported versions,
scope notes, and response expectations all live there:

**[../../SECURITY.md](../../SECURITY.md)**

## What this deployment holds

Nothing. The Worker keeps no documents, no sessions and no history: every call
carries its document in and gets the result back in the same response. Logs
record the JSON-RPC method and the response status, never a document's text.

Browser callers are gated by an Origin allowlist (`ALLOWED_ORIGINS`), which
defaults to localhost only; non-browser clients send no Origin and are not
gated. The request body is capped (`MAX_BODY_BYTES`, default 2 MiB).

## Reporting a vulnerability

Report privately via **GitHub Security Advisories**: on the
[repository page](https://github.com/geml-spec/geml), *Security → Report a
vulnerability*. This reaches the maintainer directly and keeps the report
confidential until a fix is released.

Please do not open a public issue for a security report.
