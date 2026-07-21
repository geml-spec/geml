# Security Policy

## Supported versions

Security fixes land on the latest minor release of `@geml/geml`.

| Version | Supported |
|---------|-----------|
| 1.2.x   | ✓ |
| < 1.2   | ✗ — please upgrade |

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
never executed, `output` blocks are stored results only, and diagram bodies are
passed to external renderers verbatim. Reports about untrusted-document
handling (path traversal via cross-document references, resource loading in
rendered HTML, ReDoS in the parser, recipe/CLI injection) are very much in
scope — this project has shipped dedicated hardening releases (1.2.1, 1.2.2)
for exactly that class of issue.
