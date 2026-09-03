# Block embed — `=== embed {src=doc.geml#id}` renders the referenced block in place

- **Status**: proposed (design input for a GEP — this adds a block type and touches
  embed semantics in the core spec §3/§5.1, so per `GOVERNANCE.md` it needs a
  discussion issue, a GEP, and conformance cases before it is real)
- **Date**: 2026-07-30; **revised 2026-07-31** — the syntax pivoted from extending
  the media embed `![](doc.geml#id)` to a typed block. See *Why a typed block*.
- **Driver**: reference-only index documents. The concrete case: a task file that
  *describes* a piece of work entirely through references to the single source of
  truth — no copied content — but that a reader can still read top-to-bottom as if
  the content were present. GEML can express the references today; nothing expands
  them.

## Why a typed block

Three spellings were evaluated:

1. `![](doc.geml#id)` — extend the media embed (this document's original draft).
2. `![[doc.geml#id]]` — Obsidian-style; standalone line embeds, mid-text links.
3. `=== embed {src=doc.geml#id}` — a typed block. **Chosen.**

Decisive points, measured against 1.4.6:

- **Position-dependent semantics (option 2) is disqualified.** The same token
  meaning "embed" alone on a line and "link" mid-text breaks under `geml set` /
  `--to geml` reflow: joining two paragraphs silently turns an embed into a link,
  with no diagnostic. Worse, `![[#id]]` already parses today as literal `!` + a
  fully validated auto-ref (zero diagnostics), so assigning it a new meaning is a
  breaking change to existing documents.
- **A typed block is block-level by construction.** The type-coherence rule —
  block content cannot be spliced into an inline run — is enforced by the grammar
  instead of a position rule. No new inline atom in §5.3, no new serializer invariant.
- **Degradation on old toolchains is visible by construction.** Measured:
  `geml check` emits `unknown-block-type` (warning, exit 0) and the renderer
  emits a visible figure — `<figcaption>unknown block type <code>embed</code>;
  shown as raw</figcaption>` — never option 1's broken `<img>`, never silent
  blank.
- **`src=` is already the external-resource attribute.** `table src=` (§6) and
  `geml-code-graph src=` (§7) exist; embed's `src=` joins `data=` / `of=` /
  `src=` in the attribute-position reference family (spec Appendix B.3), and the
  bare value `src=other.geml#sec1` already parses as a string.
- **Attribute slots come free**: `.class`, the embed's own `#id` (an
  agent retargets with `geml set #e1 --head`), and future knobs
  (`shift-headings=`, `as=`) — no grammar work.
- **Naming.** `embed` completes an existing duality pattern of the language —
  `` `code` `` vs `=== code`, `$…$` vs `=== math`, and now inline media embed vs
  block embed (spec Appendix B.4 documents the matrix; the block cell was the one
  gap). `include` would give the block half of the family a different name from
  the inline half; `inline` collides head-on with the spec's own term of art.

## Current behaviour (measured, 1.4.6)

1. **Block form.** `=== embed {src=other.geml#sec1}` → `unknown-block-type`
   warning; `src`/`#id` are preserved in the model; the renderer shows
   the visible unknown-type figure. The `src` target is **not** validated.
2. **Inline form.** `![](../other.geml#id)` goes down the media-embed path,
   `.geml` is not a known media kind, and the fallback is a broken
   `<img src="../other.geml#id">`. Under this design that spelling becomes an
   **error** (S1), not a transclusion.
3. **Checking.** An embed-shaped reference is today the one reference shape whose
   rot is silent — index documents need a parallel manifest of `[[…]]` auto-refs
   purely for validation. That workaround dies with S6.

## Semantics

**S1 — Syntax and target.** A typed block `=== embed {src=<target>}`.

- `src` is **required**; its target grammar is identical to link references:
  `#id` (same document) or `doc.geml#id` (cross-document, `--root` scoped). No
  name-based fuzzy resolution.
- The body MUST be empty — a non-empty body is an **error** (a body would invite
  cached copies of the target, breaking single-source-of-truth).
- An inline media embed `![alt](target)` whose target resolves to a GEML document
  is an **error** directing the author to the block form. This replaces today's
  broken-image fallback: GEML block content is never inline-coherent.

**S2 — Fragment.** `#id` selects one block. A **heading id selects its whole
section** — identical to `geml get`'s section semantics (through the next
same-or-higher heading). No fragment = the whole document body (permitted, but the
fragment form is the intended use).

**S3 — Rendering.** The selected content renders in place, wrapped in a container
that carries provenance (e.g. `<section class="embed"
data-src="other.geml#id">…</section>`). An embed carries no caption of its own — it
is a reference shell, and a title belongs to the content it stands for, so a
`caption=` written here is an ordinary unused attribute. The embedded content's own
ids do not become host anchors (S9).

**S4 — Context rules.** Embedded content is rendered **in its source document's
context**:

- `{{key}}` interpolation resolves against the **source** document's `=== meta` —
  never the host's. (The block must mean the same thing everywhere it appears.)
- Relative link / media / embed targets inside the embedded content are
  **rebased** to remain correct relative to the output location.
- **Fragment-only references** (`[t](#x)`, `[[#x]]`) inside the embedded content
  whose target lies **outside the embedded slice** rebase to the source document
  (`other.geml#x`) — never to the host's `#x`, which may name a different block.
- A `geml-chart` whose `data=#id` table lives inside the embedded slice works; one
  whose table is outside the slice renders the existing degraded note.

**S5 — Recursion.** Embeds inside embedded content expand recursively, subject to:

- **cycle detection** on the set of (absolute path, fragment) already being
  expanded — a cycle is an **error diagnostic** and renders an error placeholder,
  never a loop;
- a **depth cap** (suggest 8) — exceeding it degrades to the link form with a note.

**S6 — Validation.** `geml check` treats `src=` exactly like a cross-document
reference: unresolvable document or missing id is an **error** (reuse
`unresolved-reference` / `unresolved-cross-document-reference` /
`unresolvable-document`; new codes: `embed-missing-src`, `embed-body-not-empty`,
`embed-cycle`). Resolution scope and `--root` behave identically to link
references (fail-closed; `..` escapes need `--root`).

**S7 — Degradation.** A renderer that understands `embed` but cannot fetch the
content (viewer over `file://`, same-origin gate, offline) must degrade to the
**auto-ref link form** `[[doc.geml#id]]` plus a visible note — never silent blank.
(Pre-embed toolchains degrade to the visible unknown-type figure, measured above.)

**S8 — Read-only.** An embed is a *view*. `get`/`set`/`revert` semantics are
untouched. Corollary worth a conformance case: `geml set host.geml #id-in-source`
fails because the id is not declared in the host — correct, fail-closed.

**S9 — Id collision.** Embedded content may declare ids that collide with host
ids, or with a second embed of the same slice. The host document's id namespace is
authoritative: embedded ids register no anchors in the host render (or only
derived, non-conflicting ones); references to them resolve per S4 to the source
document. `duplicate-id` is NOT emitted for host-vs-embedded collisions.

**S10 — Heading levels (open).** An embedded section keeps its source heading
levels, which can invert the host's hierarchy. Proposal: render as-is by default,
plus an opt-in `shift-headings=<n>` attribute (AsciiDoc `leveloffset` precedent).
Auto-shifting to the host depth is rejected as magic.

**S11 — History and revert.** Bytes and history belong to the source file: a
transclusion stores a pointer, so nothing about the borrowed content enters the
host's `.gemlhistory`. The host's content hash covers the **reference text** only,
following the precedent §6 already sets for a table's `src=`. `revert` therefore
restores the *reference*, never the view — reverting the host's embed block puts
back the target it used to name, and reverting an id that only exists in the source
is refused, because that id was never in the host's addressable space (S8). After
reverting a source document, run `check --root` over the tree: a host that pointed
at a block the older revision does not contain is now dangling, and only a
whole-tree check sees it.

**S12 — Inline projection (settled).** `![[doc.geml#id]]` projects the target
block's body into a sentence; `!` is the projection prefix throughout. The physical
constraint that block content cannot sit mid-sentence is enforced as a check on the
TARGET's type, not on where the reference was written: v1 accepts a `text` block
whose body is a single paragraph, and anything else reports
`inline-transclusion-not-inline` naming `=== embed` instead. It shares this
document's machinery rather than running its own — cycle stack, depth cap, S4
context rules, S9 non-addressability, and a `<span class="transclusion-inline"
data-src=…>` for provenance. §5.3 tries `![[` before the image atom, so
`![[#x]](y)` is a projection followed by a literal `(y)`; the conformance suite
pins that ordering. `![alt](doc.geml#id)` is an error naming both forms.

**Diagnostic names, as implemented.** This note was drafted with names the
implementation did not keep: `embed-body-not-empty` is `ignored-embed-body`, and it
is a **warning** rather than an error (consistent with `ignored-diagram-body` — the
body is ignored, not fatal); `embed-cycle` is `transclusion-cycle`. The full set is
`embed-missing-src`, `ignored-embed-body`, `embed-target-not-geml`,
`unsafe-embed-scheme`, `media-target-is-document`,
`inline-transclusion-not-inline`, `transclusion-cycle`, plus the one-source rule's
`source-attr-conflict`, `unresolvable-table-source` and `table-source-not-a-table`.

## Surfaces

| Surface | Work |
|---|---|
| `geml check` | S6. The half that unblocks reference-only documents even before any renderer ships — ship first. |
| `--to html` (CLI) | Expand at build time; content is inlined, output stays self-contained. The doc-resolver hooks used by the GEP-0003 code-graph embed are the precedent for loading a sibling document. |
| Viewer extension / playground | Fetch through the existing same-origin gate; `file://` needs the extension's file-access mode; on refusal apply S7. |
| `--to md` | Lossy by design: emit the link form + loss note on stderr, consistent with how other GEML-only constructs project. |
| Spec | Register `embed` in §3's type registry; add the inline-`.geml`-target error to §5.1; fill the Appendix B.4 embedding cell. |

## Conformance cases (required before this is real)

1. Embed of an existing block id → output contains the block's rendered content.
2. Embed of a heading id → the whole section, matching `get`'s section boundary.
3. Embed of a missing id → `check` exits non-zero (today: silent — pins the fix).
4. Two documents embedding each other → `embed-cycle` error, terminating.
5. Depth cap → degrades per S5, terminating.
6. `{{key}}` inside embedded content resolves against the source doc's meta.
7. A relative link inside embedded content still resolves from the output.
8. A fragment-only ref pointing outside the slice → rebased to the source doc (S4).
9. Host/embedded id collision → no `duplicate-id`; anchors per S9.
10. Non-empty `embed` body → `embed-body-not-empty` error.
11. Missing `src` → `embed-missing-src` error.
12. Inline `![](x.geml#id)` → error, not a broken image.
13. `--to md` projection emits the link form and reports the loss.
14. `geml set host.geml #id-declared-only-in-source` → refused (S8).

## Non-goals

Partial-block selection (line ranges), styling of embedded content beyond the
provenance wrapper, editing through an embed, any change to link-form reference
semantics, and the `![[…]]` spelling (rejected above — position-dependent
semantics, breaking, and redundant with `[[…]]`).

## Beneficiary cleanup once shipped

The reference-only task files in `geml-outreach/geml_tasks/` each carry a `#refs`
manifest of `[[…]]` auto-refs whose only purpose is to give `check` something to
validate while embeds are silent. Once S6 lands, those manifests are redundant and
should be deleted — the embeds themselves become the validated references.
