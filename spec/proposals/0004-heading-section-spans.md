---
gep: 0004
title: A heading's `#id` addresses its whole section
state: draft
author: GEML (maintainer)
created: 2026-07-22
issue: (maintainer decision)
---

## Summary

Extend a heading's **source span** — the byte range `geml get` prints and
`geml set` / `geml revert` splice — from the single heading line to the whole
**section**: the heading line through the line just before the next heading of
the same-or-higher level (fewer-or-equal `#`), or end of scope. Nested blocks
inside the section keep their own spans, so spans now intentionally **overlap**:
`#sec` contains `#code`, and each remains addressable on its own. The document
model is unchanged; this is purely an addressing (CLI/span) rule.

## Motivation

The addressable-block loop (`get` → edit → `set`, guarded) is GEML's core
AI-editing workflow. Today it reaches typed blocks and footnote definitions, but
a heading's span is just its one line — so the prose under a heading, the thing
a writer or agent most often wants to revise, is unreachable: plain paragraphs
carry no id, and `set #sec` could only retitle the section, not rewrite it.
Making the heading span cover its section gives prose block-level editing with
**zero new syntax** — every existing document's headings become section handles
retroactively.

## Design

For a heading of level `L` (its `#`-run length), the span end is found by
scanning forward **within the current scope** (the document top level, or the
flow-block body the heading sits in):

- A line opening a typed-block fence skips the **entire block** to its matching
  close — the equal-length `=` run, or the labeled `=== #id` close. Lines inside
  a fenced body are never boundaries: a `# comment` in a `=== code` body is
  content.
- The first line matching a heading with level `<= L` ends the section (that
  line is excluded).
- If no boundary is found, the section runs to the end of the scope.

A deeper heading (`## B` under `# A`) is **part of** `#a`'s section; a
same-or-higher one ends it. The walk that records spans still advances line by
line through the section body, so every nested id registers its own span.

```
# A {#a}          ─┐
                   │  get '#a' prints this whole range
para               │
                   │
=== code {#c}     ─┼─┐ get '#c' still prints just this block
x                  │ │
===               ─┼─┘
                  ─┘
# B {#b}             ← boundary: level 1 <= 1 (excluded from #a)
```

Consequences inherited by the existing `set`/`revert` guard (`spliceBlock`):

- Replacing a section replaces heading + prose + nested blocks in one splice.
- The guard already refuses a replacement that drops any pre-existing id, so a
  `set '#sec'` whose new content omits a nested `#code` is **rejected** — the
  caller must re-supply (or consciously edit) the section's blocks. This is the
  intended safety behavior for overlapping spans.
- `revert '#sec'` rewinds the whole section to a past revision (the historical
  section is extracted from the old revision by the same span rule).

### `--json` asymmetry (explicit decision)

`geml get --json '#sec'` keeps returning the **heading's model node** only. The
document model has no "section" node — sections are an *addressing* concept, not
a *model* concept — and synthesizing one would invent structure the parser does
not produce. So: raw `get` = section bytes, `--json` = heading node. The
asymmetry is documented in the CLI docs; a future GEP may add a section node if
a real consumer needs it.

## Conformance impact

None to the conformance corpus: `inline/precedence/lists/interp.json` encode the
document model via the projection, and the model is unchanged. Source spans are
a CLI-level contract, pinned by the CLI suites instead —
`geml-parser/test/get-set.test.mjs` (section extraction, boundaries at
same/deeper levels, fenced-body `#` lines, end-of-file, whole-section `set`,
the dropped-nested-id guard, nested-block addressing) and
`geml-parser/test/revert.test.mjs` (whole-section revert).

## Alternatives considered

- **Do nothing.** Prose stays unaddressable; agents re-emit whole files to edit
  a paragraph — the exact cost `get`/`set` exists to avoid.
- **Auto-ids on paragraphs** (e.g. `#p-3`). Positional ids are unstable under
  edits (every insertion renumbers), and they bloat the id namespace. Sections
  track how humans and agents actually chunk prose.
- **A new explicit section construct** (e.g. wrapping prose in `=== section`).
  Works today with no code change, but costs syntax and nesting noise in every
  document; the heading is already the section marker humans write.
- **Advance the span walk past the section** (`i = sectionEnd`). Rejected —
  nested blocks would lose their own spans; overlap is the point.

## Compatibility & migration

**This changes existing observable output.** `geml get '#heading'` printed one
line; it now prints the whole section. `set`/`revert` on a heading id likewise
grow their splice range. No document syntax changes, no parse output changes,
and ids/diagnostics are identical — only span-based tooling behavior shifts.
Callers that truly want the single heading line can `get --json` the heading
node, or address a narrower nested block. The pre-1.0 tool surface is the
low-cost moment for this flip; PARSER_VERSION should bump minor on the next
release.

## Drawbacks & open questions

- Overlapping spans make `set` on a mixed section heavier: the replacement must
  carry the section's nested blocks (the guard enforces it). That friction is
  deliberate, but a future `--allow-drop` escape hatch could be considered.
- A `.gemlhistory` written before this change recorded heading revisions as
  single lines; `revert '#sec'` against such history restores what was
  recorded (history stores whole-file revisions, so extraction uses the new
  rule on old content — consistent, but worth knowing).
- `--json` returning the heading node only (see above) — revisit if a consumer
  needs a structural section.
