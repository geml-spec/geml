# Security Policy

## Supported versions

Reports are accepted for **`1.3.2` and above**; the fix itself ships on the
latest release of `@geml/geml`, so an upgrade is how you receive it. `1.3.2` is
the floor because it is the oldest release **on npm** that carries the hardening
work described under *Scope notes*: the `1.2.x` builds where that work first
landed were never published, so those fixes first reached users in `1.3.2`.
Anything below it predates the hardening and is not supported — please upgrade
rather than report against it.

| Version | Supported |
|---------|-----------|
| ≥ 1.3.2 | ✓ — report it; the fix ships on latest |
| < 1.3.2 | ✗ — please upgrade |

(Stated as a range on purpose: an enumeration of minors goes stale on every
release, and a version missing from it reads as unsupported when it is not.)

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately via **GitHub Security Advisories**: on the repository page,
*Security → Report a vulnerability*. This reaches the maintainer directly and
keeps the report confidential until a fix is released.

What to include: the affected component (parser, CLI, viewer extension, GitHub
Action, editor integrations), a minimal reproducing input (a `.geml` /
`.gemlhistory` snippet or CLI invocation), and the impact you believe it has.

## What to expect

- **Acknowledgement** within 72 hours.
- **Assessment and fix plan** within 7 days for confirmed issues.
- Fixes ship as a patch release with the advisory credited to the reporter
  (unless you prefer otherwise). Coordinated disclosure: we ask that you hold
  publication until the release is out, and we will not sit on a fix.

## Scope notes

GEML processors treat documents as **data, never code**: `code` blocks are
never executed, an `embed` block's target is loaded but never executed, and
diagram bodies are
passed to external renderers verbatim. Reports about untrusted-document
handling (path traversal via cross-document references, resource loading in
rendered HTML, ReDoS in the parser, recipe/CLI injection) are very much in
scope — this project has shipped dedicated hardening releases for exactly that
class of issue, starting with the two audit rounds that reached npm as
1.3.2, and continuing through further rounds since. [`CHANGELOG.md`](CHANGELOG.md) records each one under
*Security*; a round sitting under `[Unreleased]` there has landed on `main` but
is not on npm yet, so check both before concluding a fix has reached you.
