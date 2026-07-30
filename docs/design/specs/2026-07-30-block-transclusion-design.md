# Block transclusion — `![](doc.geml#id)` renders the referenced block in place

- **Status**: proposed (design input for a GEP — this touches embed semantics in the
  core spec §5.1, so per `GOVERNANCE.md` it needs a discussion issue, a GEP, and
  conformance cases before it is real)
- **Date**: 2026-07-30
- **Driver**: reference-only index documents. The concrete case: a task file that
  *describes* a piece of work entirely through references to the single source of
  truth — no copied content — but that a reader can still read top-to-bottom as if
  the content were present. GEML can express the references today; nothing expands
  them.

## Current behaviour (measured, 1.4.6)

Both halves of the gap are verified against the current build:

1. **Rendering.** `![](../other.geml#id)` goes down the media-embed path. The kind
   is inferred from the extension, `.geml` is not a known media kind, and the
   fallback is *image*:

   ```html
   <img class="media" src="../other.geml#id" alt="">
   ```

   The browser loads a `.geml` file as an image, fails, and shows a broken-image
   placeholder. Local vs hosted makes no difference — the renderer never expands.

2. **Checking.** An embed whose target is a `.geml` with a **nonexistent** id
   produces **zero diagnostics** — while the same target in link form
   (`[t](other.geml#missing)` or `[[other.geml#missing]]`) is an error. So today an
   embed is the one reference shape whose rot is silent. Index documents built from
   embeds currently need a parallel manifest of `[[…]]` auto-refs purely to get
   validation; that workaround should die with this feature.

## Semantics

**S1 — Target selection.** In a media embed `![alt](target)`, if `target` (after
stripping any `#fragment`) resolves to a GEML document, the embed is a
**transclusion**, not a media embed. All other targets keep today's behaviour.

**S2 — Fragment.** `#id` selects one block. A **heading id selects its whole
section** — identical to `geml get`'s section semantics (through the next
same-or-higher heading). No fragment = the whole document body (permitted, but the
fragment form is the intended use).

**S3 — Rendering.** The selected content renders in place, wrapped in a container
that carries provenance (e.g. `<section class="transclusion"
data-src="other.geml#id">…</section>`) so a stylesheet can mark it and a reader can
trace it. The `alt` text, if present, is the caption/label of the container.

**S4 — Context rules.** Transcluded content is rendered **in its source document's
context**:
- `{{key}}` interpolation resolves against the **source** document's `=== meta` —
  never the host's. (Single source of truth: the block must mean the same thing
  everywhere it appears.)
- Relative link / media / embed targets inside the transcluded content are
  **rebased** to remain correct relative to the output location.
- A `geml-chart` whose `data=#id` table lives inside the transcluded slice works;
  one whose table is outside the slice renders the existing degraded note.

**S5 — Recursion.** Transclusions inside transcluded content expand recursively,
subject to:
- **cycle detection** on the set of (absolute path, fragment) already being
  expanded — a cycle is an **error diagnostic** and renders an error placeholder,
  never a loop;
- a **depth cap** (suggest 8) — exceeding it degrades to the link form with a note.

**S6 — Validation.** `geml check` treats a transclusion target exactly like a
cross-document reference: unresolvable document or missing id is an **error**
(new or reused Appendix A code — suggest reusing `unresolved-reference`, plus a new
`transclusion-cycle`). Resolution scope and `--root` behave identically to link
references (fail-closed; `..` escapes need `--root`).

**S7 — Degradation.** A renderer that understands GEML targets but cannot fetch the
content (viewer over `file://`, same-origin gate, offline) must degrade to the
**auto-ref link form** `[[doc.geml#id]]` plus a visible note — never a broken
`<img>`, never silent blank. The current broken-image output is the bug this spec
exists to remove.

**S8 — Read-only.** Transclusion is a *view*. `get`/`set`/`revert` semantics are
untouched; editing through a transclusion is out of scope.

## Surfaces

| Surface | Work |
|---|---|
| `--to html` (CLI) | Expand at build time; content is inlined, output stays self-contained. The doc-resolver hooks used by the GEP-0003 code-graph embed are the precedent for loading a sibling document. |
| Viewer extension / playground | Fetch through the existing same-origin gate; `file://` needs the extension's file-access mode; on refusal apply S7. |
| `--to md` | Lossy by design: emit the link form + loss note on stderr, consistent with how other GEML-only constructs project. |
| `geml check` | S6. This is the half that unblocks reference-only documents even before any renderer ships. |

## Conformance cases (required before this is real)

1. Embed of an existing block id → output contains the block's rendered content.
2. Embed of a heading id → the whole section, matching `get`'s section boundary.
3. Embed of a missing id → `check` exits non-zero with the diagnostic (today:
   silent — this case pins the fix).
4. Two documents transcluding each other → `transclusion-cycle` error, terminating.
5. Depth cap → degrades per S5, terminating.
6. `{{key}}` inside transcluded content resolves against the source doc's meta.
7. A relative link inside transcluded content still resolves from the output.
8. `--to md` projection emits the link form and reports the loss.

## Non-goals

Partial-block selection (line ranges), styling of transcluded content beyond the
provenance wrapper, editing through a transclusion, and any change to link-form
reference semantics.

## Beneficiary cleanup once shipped

The reference-only task files in `geml-outreach/geml_tasks/` each carry a `#refs`
manifest of `[[…]]` auto-refs whose only purpose is to give `check` something to
validate while embeds are silent. Once S6 lands, those manifests are redundant and
should be deleted — the embeds themselves become the validated references.
