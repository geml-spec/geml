---
gep: 0007
title: Emphasis may span an inline atom
state: draft
author: GEML (maintainer)
created: 2026-08-07
issue: (pending)
---

## Summary

Change §5.3 phase 2 so emphasis delimiters pair across inline atoms instead of
only within the literal-text runs between them. Today `*see the [spec](s.geml)*`
and ``*the `code` block*`` are not emphasis at all: the asterisks are literal, no
diagnostic is raised, and every renderer prints them. Under this proposal phase 2
runs over the whole inline sequence with atoms treated as opaque units — which is
what CommonMark does, and what §5.3's own closing sentence already claims GEML
does.

## Motivation

### The current rule

> **Phase 2 — emphasis** runs over each maximal run of literal text *between*
> phase-1 atoms; emphasis never spans an atom or a block boundary.

Phase 1 atoms are code spans, inline math, images, links, auto-refs, inline
projections and footnote refs. So emphasis fails whenever it contains any of
them:

| Written | Today |
|---|---|
| `*plain emphasis*` | ✅ `<em>` |
| ``*emphasis with `code`*`` | ❌ literal asterisks |
| `*emphasis with [a link](x.geml)*` | ❌ literal asterisks |
| `**strong with `code`**` | ❌ literal asterisks |
| `*emphasis with $x^2$*` | ❌ literal asterisks |
| `[a link with *emphasis*](x)` | ✅ (the link's children parse on their own) |

"A phrase in italics that mentions a `flag` or links to a spec" is not an exotic
construct — for technical prose it is close to the median sentence. GEML is aimed
squarely at technical documents, so the rule is most restrictive exactly where the
format expects to be used.

### It fails silently, which is the worst available behaviour

There is no diagnostic. `geml check` reports nothing, the document is conforming,
and the damage appears only in rendered output as stray `*` characters. A format
whose entire argument is "a broken reference fails the build instead of rotting
quietly" is, here, rotting quietly.

### It is already biting this repository

22 sites carry the shape `*[English](…) | 中文*` — including the language switcher
at the top of **every specification document**, the comparison documents, and the
manifesto. All of them render as:

```html
<p>*English | <a href="COMPARISON_CN.md">中文</a>*</p>
```

Literal asterisks, in the HTML path the Chrome extension and the published site
both use. This was found while auditing the Markdown projection, not by any check.

### Two published statements are false because of it

Both were written believing emphasis behaved as it does in CommonMark:

1. **§5.3's own closing sentence** — "*This is the CommonMark emphasis algorithm
   restricted to GEML's delimiters: `*` and `~~`, with no `_` emphasis.*" The
   restriction is not only the delimiter set; the phase structure differs, and
   that difference changes results on ordinary input.
2. **`docs/comparisons/GEML-vs-CommonMark.md`** — "Delimiter algorithm | Flanking
   runs + rule of three | **Identical algorithm**, restricted to `*` and `~~`".

Those two need correcting whatever happens to this GEP. If it is accepted they
become true; if it is rejected they must be rewritten to describe a deliberate
divergence. They cannot stay as they are.

## Design

Phase 1 is unchanged: atoms are recognized first, left to right, and nothing
inside an atom is parsed further.

Phase 2 changes from *"over each maximal run of literal text between atoms"* to
*"over the whole inline sequence, with each phase-1 atom treated as a single
opaque unit"*.

Concretely, for delimiter-run flanking (§5.3):

- A delimiter run is still a maximal run of `*`, or of two or more `~`, **in
  literal text**. Characters inside an atom are never delimiters — a `*` in a code
  span or in a link's destination stays what it is.
- For the flanking test, the character "immediately before" a run is the last
  character of the preceding literal text if there is one; if the run is preceded
  by an atom, the atom counts as **punctuation**. Mirrored for "immediately
  after". Start and end of the inline sequence still count as whitespace.
- Pairing, the rule of three, and the emphasis/strong assignment are unchanged.
  A matched pair's content is the sequence of atoms and literal text between the
  two runs.

Treating an atom as punctuation is the choice that makes `*a [b](c)*` work while
keeping `a*[b](c)*a` from becoming emphasis inside a word, which is the same
result CommonMark reaches by treating the link's `[`/`]` as punctuation.

```
before                              after
────────────────────────────        ────────────────────────────
*see the [spec](s.geml)*            *see the [spec](s.geml)*
  -> text "*see the "                 -> emph[ text "see the ", link ]
     link
     text "*"
```

Emphasis still MUST NOT span a block boundary. Nesting a link inside a link
remains forbidden (§5.2), and this GEP does not change it.

## Conformance impact

New cases in `geml-parser/test/conformance/`, each asserting the inline model,
not the rendering:

1. `*a [b](x.geml) c*` → one `emph` containing text, link, text.
2. ``*a `b` c*`` → one `emph` containing text, code, text.
3. `**a `b` c**` → one `strong`, same shape.
4. `*a $x$ c*` → one `emph` containing inline math.
5. `*a ![alt](i.png) c*` → one `emph` containing an image.
6. `~~a [b](x.geml) c~~` → one `strike`, same shape.
7. `` `*not emphasis*` `` → unchanged: a code span, whose asterisks are content.
8. `*a* [b](x.geml) *c*` → two separate `emph`, not one spanning the link — the
   nearest-preceding-opener rule still decides, so this must not regress.
9. `a*[b](x.geml)*a` → literal, per the flanking rule with the atom as
   punctuation.
10. An unpaired run still ends up literal, with no diagnostic (unchanged).

The existing emphasis cases must all still pass unchanged; this only adds pairings
that were previously impossible, so no currently-`<em>` input can stop being one.

## Alternatives considered

**Do nothing.** Keeps a rule with no stated rationale, keeps 22 broken sites in
this repository, and forces the two published claims above to be rewritten as
"a deliberate divergence" — which nobody has yet given a reason for.

**Keep the rule, add a diagnostic** (`emphasis-not-spanning-atom`, warning) when
an unpaired delimiter run *would* have paired across an atom. Strictly better than
doing nothing: the failure stops being silent. It is a good fallback if this GEP
is rejected, and a reasonable transitional step if it is accepted late. It does
not make the common construct work.

**Keep the rule, fix the documents.** Rewrite the 22 sites to avoid the shape, and
correct the two false statements. Cheapest, but it fixes the symptom in one
repository while every future author walks into the same trap.

**Go further and adopt CommonMark's inline pass wholesale.** Rejected: GEML
deliberately drops `_` emphasis and reference links, and adopting the whole
algorithm would drag those back in. This GEP changes the phase *structure* only.

## Compatibility & migration

This makes strictly more input into emphasis. Any document that renders correctly
today renders identically afterwards — the only inputs whose meaning changes are
ones that are, today, producing literal asterisks nobody wanted.

The one honest risk: a document that *relies* on literal asterisks around a span
containing a link or code — for example prose showing GEML syntax inline without
escaping it. Such a document is already fragile, and `\*` has always been the
supported way to write a literal asterisk. `geml fmt` cannot detect intent here,
so this is a manual, and expected to be empty in practice.

Requires a parser change (`inline.ts`), a spec change (§5.3, EN and CN), the
conformance cases above, and — because it is a behaviour change in the inline
grammar — a minor version bump for the parser.

## Drawbacks & open questions

**1. It is a change to a `1.0` inline grammar.** "Stable" was promised as "the
rules already there won't shift under you". This shifts one. The defence is that
it shifts it toward what the spec's own closing sentence already promised, and
that no conforming document loses a rendering it had — but it is still a change
to shipped normative text, and should be argued as such rather than filed as a
bug fix.

**2. "Atom counts as punctuation" needs pinning against CommonMark case by case.**
The rule above is the intent; the conformance cases are what actually fix it. If
any case disagrees with CommonMark's output for the same input (modulo `_` and
reference links), that is a bug in this proposal, not a deliberate divergence.

**3. The second implementation gets harder.** Phase-2-per-text-run is markedly
simpler to implement than a delimiter stack spanning a node sequence. Since a
second independent implementation is what the project says it needs most, raising
the cost of writing one is a real price. It is probably still worth paying —
matching CommonMark means an implementer can port a well-understood algorithm
rather than invent a variant — but it belongs on the ledger.

**4. Should the fallback diagnostic ship regardless?** Even with this accepted,
`*unclosed` and friends stay silently literal. Whether GEML should ever warn about
an unpaired delimiter run is a separate question this GEP does not answer.
