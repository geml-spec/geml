---
gep: 0006
title: Declared projections — a document names the files derived from it
state: draft
author: GEML (maintainer)
created: 2026-08-07
issue: (pending)
---

## Summary

Let a document declare, in its `=== meta` block, the files that are *projections*
of it (`projects-to = "COMPARISON.md"`). `geml check` then re-projects in memory
and compares against what is on disk: a target that has drifted, or is missing,
is a **warning**. A new verb, `geml project <file>`, regenerates the declared
targets. This makes "`.md` and `.html` are views projected from it" — already the
claim in the manifesto and the README — a checkable property instead of an
honour system.

## Motivation

GEML already refuses to let a *reference* rot: `src=` line ranges fail the build
when they drift (`bad-source-range`), a snapshot body alongside `src=` warns when
it no longer matches (`stale-code-snapshot`), and an unresolved `#id` is an error.
There is one relationship it does not check at all — **the derived file** — and
that is the one this repository actually got bitten by.

### The evidence is this repository

`docs/comparisons/` carries four hand-maintained pairs: `COMPARISON.geml` /
`COMPARISON.md`, and the same in Chinese. The `.geml` is the dogfooded source;
the `.md` exists because GitHub does not render `.geml`. Nothing connects them.

Measured on 2026-08-07, projecting the source and diffing against the checked-in
copy:

| Pair | Lines differing | Total |
|---|---:|---:|
| `COMPARISON.geml` → `COMPARISON.md` | 80 | 307 |
| `COMPARISON_CN.geml` → `COMPARISON_CN.md` | 66 | 282 |

Roughly a quarter of each file. About nine tenths of that is mechanical (see
*Drawbacks*), but the remainder is genuine divergence — and it runs in the
direction nobody would predict: **`COMPARISON.md` contains a paragraph pointing
readers at the CommonMark walk-through that `COMPARISON.geml` does not have.**
The copy we call the source is the less complete of the two.

Separately, all eight comparison documents sat about three months behind the
specification — they described a GEML with no `embed`, no `data` block, and no
`src=` source routes — while `geml check` reported them clean the entire time.
Structural checking cannot see that, and this GEP does not claim to fix it (see
*Non-goals*). But the projection half of the problem is mechanical, and mechanical
problems should not be left to eyesight.

### Who feels it

Anyone keeping a GEML source next to a Markdown or HTML rendering of it — which,
until `.geml` renders natively on the major forges, is everyone publishing GEML.
An agent asked to update such a document feels it twice: it must discover that a
second copy exists (nothing says so), and then make every edit twice. In this
repository that is four edits per change, once the Chinese pair is counted.

## Design

### Declaration

A new `meta` key, valid once per document:

```
=== meta
title = "GEML vs. other markup formats"
projects-to = "COMPARISON.md"
===
```

- The value is a path **relative to the document**, or a comma-separated list of
  them (`"COMPARISON.md, COMPARISON.html"`).
- Each path resolves under the confinement boundary of §9.4, exactly like `src=`.
  A path escaping it is an error (`unsafe-projection-target`).
- The output format is inferred from the extension and MUST be a supported `--to`
  target: `.md`, `.html`, `.json`, `.geml`. Any other extension is an error
  (`bad-projection-target`).
- A document MAY declare a projection to a file that does not exist yet; that is
  the `missing-projection` warning below, not an error.

`projects-to` is a *declaration*, not an instruction: reading, rendering and
checking a document all work whether or not the target is present or current. A
processor that does not implement this GEP treats it as an unknown meta key, which
is already a no-op — the same degradation rule the history sidecar relies on.

### What `check` does

When `projects-to` is present, a conforming processor SHOULD:

1. Project the document to the declared format, in memory.
2. Compare the result byte-for-byte with the file on disk.

| Condition | Diagnostic | Severity |
|---|---|---|
| Target exists, bytes differ | `stale-projection` | warning |
| Target does not exist | `missing-projection` | warning |
| Extension is not a `--to` target | `bad-projection-target` | error |
| Path escapes the confinement boundary | `unsafe-projection-target` | error |

Warnings, not errors, and deliberately so. A stale projection does not make the
*document* wrong — the `.geml` is still valid, still renders, still checks. This
matches `stale-code-snapshot`, which warns for the same reason, and it preserves
the property GEML defends in its own post-mortem: a file reads and renders without
being validated. A repository that wants the stronger contract escalates warnings
to failures in CI, which is a policy choice, not a spec one.

An `http(s)` target is not permitted: projection writes, and the parser never
writes to the network.

### What `project` does

```console
$ geml project <file.geml> [--check] [-o dir]
```

Regenerates every declared target. `--check` performs the comparison and exits
non-zero on drift without writing — the CI form. With no `projects-to`, it is a
no-op that exits 0.

The verb is the write path; `check` only ever reads. Keeping them separate is why
`check` can stay safe to run anywhere.

## Conformance impact

New cases in `geml-parser/test/conformance/`:

1. `projects-to` with a current target → no diagnostics.
2. `projects-to` with a drifted target → exactly one `stale-projection` warning,
   naming the target path; exit 0.
3. `projects-to` naming an absent file → one `missing-projection` warning; exit 0.
4. `projects-to = "out.pdf"` → `bad-projection-target` error; exit 1.
5. `projects-to = "../../etc/x.md"` outside the root → `unsafe-projection-target`
   error; exit 1.
6. A comma list where one target is current and one has drifted → one warning.
7. A processor without the feature: `projects-to` is preserved in the document
   model as an ordinary meta value and emits no diagnostic.

Case 7 is the important one — it encodes the degradation rule, and it is what
keeps a second implementation free to skip this GEP entirely.

The projection grammar itself does not change.

## Alternatives considered

**Do nothing.** The status quo, and the reason this GEP exists: four pairs in this
repository drifted, in one case losing a whole paragraph from the source. The cost
of doing nothing is paid by whoever notices, by eye, eventually.

**A CI script instead of a spec change.** Regenerate and `git diff --exit-code` in
a workflow. This works *today*, needs no GEP, and is genuinely the cheapest path —
it deserves to be taken seriously rather than dismissed. The argument against: the
relationship between a source and its rendering is a property of the document, not
of one repository's automation. Someone who clones the file, or vendors it into
another project, takes the declaration with them and takes nothing from our
`.github/`. That is the same argument that put `.gemlhistory` beside the file
instead of in a service — if it does not hold here, it is worth asking whether it
held there.

**Hash-pinning instead of re-projection.** Record the source's hash in the target
(an HTML comment in the `.md`) and warn when the source has moved on. Cheaper, and
tolerant of the projector changing between versions — but it detects only "the
source changed", never "somebody hand-edited the target", which is precisely how
`COMPARISON.md` acquired a paragraph the source lacks.

**Delete the `.md` copies.** Honest, and the smallest possible design. It fails on
the ecosystem fact the manifesto already concedes: GitHub does not render `.geml`,
and the copies exist for readers who arrive through a forge.

**Bidirectional sync.** Rejected without much deliberation. `--to md` is lossy by
construction (block ids and chart bindings do not survive), so a round trip cannot
be an identity, and pretending otherwise would invent a second source of truth —
the exact thing this proposal is against.

## Compatibility & migration

No existing valid document changes meaning: `projects-to` is a new key, and an
unknown meta key is already preserved without complaint. Nothing that passed
`check` before fails now. The feature is opt-in per document.

Migration inside this repository is *not* free, and the cost is concentrated in
one place — see below.

## Drawbacks & open questions

**1. This is blocked on projector fidelity, and the projector currently has a
bug.** `--to md` mis-escapes emphasis that contains a link:

```
input     *emphasis with [a link](x.md)*
--to md   \*emphasis with [a link](x.md)\*     ← renders as literal asterisks
```

Plain emphasis and emphasis containing a pipe both round-trip correctly. Line 3 of
every comparison document — the language switcher — is exactly this shape, so
regenerating today would visibly degrade the published files. **This GEP should not
be accepted before that is fixed.**

**2. Line wrapping becomes non-negotiable.** The projector emits one line per
paragraph; the hand-written copies are wrapped at about 80 columns. Under strict
comparison the hand wrapping is gone, permanently, and every future diff of a
prose change becomes a whole-paragraph diff. That is a real loss for anyone who
reviews raw Markdown. A `--wrap N` option on the projector would recover it, but
then the wrap width becomes part of the comparison contract and has to be declared
somewhere. Unresolved.

**3. Byte-for-byte may be too strict a criterion.** Two conforming processors
could produce trivially different Markdown (table delimiter padding, for instance
— `|---|` versus `| --- |`, which is already a difference between our own output
and our own checked-in files). If the comparison is byte-exact, the projection
contract silently becomes "whatever the reference implementation emits", which is
a poor thing to write into a spec that wants a second implementation. Options: a
normalized comparison, or scoping the criterion to "the projection the *declaring*
processor produces" and accepting that this diagnostic is advisory. Unresolved,
and the most likely reason to reject this GEP as written.

**4. It does nothing for translation drift.** `COMPARISON.md` and
`COMPARISON_CN.md` are separate source documents; there is no mechanical relation
between them, so nothing here prevents the English and Chinese versions from
diverging — which they also have. Naming this as a non-goal, not an oversight.

**5. It does nothing for semantic staleness.** The three-month gap between the
specification and its comparison documents is a *content* dependency, not a
projection. A separate proposal (a `tracks=` attribute pinning a target block's
hash) would be the mechanism, and it should be argued on its own merits rather
than smuggled in here.

## Non-goals

- A build system. No dependency graph, no incremental builds, no ordering.
- Translation parity between language editions.
- Detecting that prose has fallen behind what it describes.
- Any obligation on a processor that does not implement this GEP.
