---
gep: 0013
title: A vocabulary may declare a prose body
state: draft
author: GEML (maintainer)
created: 2026-09-15
issue: (pending)
---

## Summary

§8.6 lets a vocabulary admit names and nothing else: an admitted type keeps the
`raw` body §8.2(6) gives an unknown one, so the document model does not depend on
which vocabularies a processor happens to know. That rule costs more than it was
meant to. A vocabulary cannot have a type that holds **prose** — a run of
paragraphs with emphasis, links and projections — even though prose creates no
addresses and therefore threatens nothing rule 4 protects.

This proposal adds one narrowly defined body mode a vocabulary may declare,
**`prose`**, and restates the invariant rule 4 was really after: admission MUST
NOT change **the set of addressable units**. `geml-media/v1` is the first
vocabulary that needs it, and the reason it is proposed now.

## Motivation

What rule 4 buys is worth keeping, and it is one specific thing. Measured, on
`geml-form/v1`, whose `form` type holds `form-field` blocks:

```
a processor that knows the vocabulary sees addresses: #outer #inner
one that does not sees:                               #outer
```

`geml get doc.geml '#inner'` therefore succeeds for one tool and fails for
another, on the same bytes. For a format whose pitch is *address a document by
its blocks*, an address set that depends on your tool's vocabulary list is not a
detail — it is the pitch failing.

The specification gives rule 4 a second justification, that content cannot change
meaning as it moves between documents. Measured, that one is already covered by
something else: every document is parsed under **its own** `=== meta profile`
declaration, so a host that declares nothing still projects a target that
declares `geml-media/v1` correctly:

```
host declares no profile; `![[t.geml#look]]` into t.geml's media-text: resolves
```

So the rule is carrying one real load, not two.

**Prose does not put anything on that load.** A body of paragraphs and inline
content creates no ids, and no addressable unit of any other kind: GEP-0011's
coordinates reach a table's rows and cells, a `data` block's value tree and
`meta`'s keys — never a paragraph. A vocabulary type whose body is prose is
therefore invisible to the one thing rule 4 protects, and the rule refuses it
anyway.

The concrete case is `geml-media/v1` (design record
`docs/design/specs/2026-09-15-geml-media-design.md`). Its script layer is
character cards, prompts and lines; a prompt is written

```geml
=== media-text {#s01-prompt .prompt shot=s01}
![[../characters.geml#look]] ![[../characters.geml#hero-look]] 特写，缓推。
===
```

and the projection is the whole mechanism: the character card is the single
source, expanded into every prompt that references it, so that changing one word
of it makes every shot that used it stale. With a `raw` body the projection is
not parsed at all, and the profile has no reason to exist.

Today that leaves two routes, both bad. Put a near-duplicate of `text` into §3's
registry — a specification change to win a namespace. Or put the five script keys
on core `text`, which is legal and costs nothing structurally, but makes those
keys valid on every `text` block in the document. Neither is about prose; both
are about a rule that reaches further than its purpose.

**This proposal also names a current violation.** `geml-form/v1` declares `form`
and `form-group` as flow bodies in the reference implementation. Those are
containers of id-bearing blocks — exactly the case rule 4 exists for — and this
proposal does **not** legalize them. They belong in §3's registry, which is what
GEP-0008 already proposes; until it lands, that declaration is a divergence and
should be recorded as one.

## Design

### The `prose` body mode

A body read as `prose` holds **paragraphs and inline content, and nothing else**:

- emphasis, code spans, links, images, footnote and block references, and
  inline projections (`![[…]]`) are parsed exactly as they are in a `text` body;
- a **fence-open line inside a prose body is not a construct**. It stays text.
  So is a heading line, a list marker and a `%%` line;
- therefore a prose body contains **no nested block, no id, and no addressable
  unit of any kind**. The only address it contributes is the block's own.

Lists are excluded deliberately, and not because they would be hard to parse:
GEP-0011 may yet make a list item an addressable inner unit, and a body mode
whose invariant depends on that not happening is a trap laid for a later GEP.
Paragraphs cannot become addressable without a coordinate syntax for them, which
nothing proposes.

### How a vocabulary declares it

A vocabulary names the types whose body is prose. In the reference
implementation that is one field:

```
"geml-media/v1": {
  types: ["media-asset", "media-clip", "media-text"],
  prose: ["media-text"],
  attrs: { … },
}
```

`prose` implies the body is read; there is no separate body-mode declaration and
no way to say "prose but raw".

### The specification changes

**§8.6.1**, the bullet list of what a vocabulary MUST NOT introduce or alter,
changes its first entry from

> - the **body mode** of any type — rule 4 below, and the reason the rest of this
>   list holds;

to

> - the **body mode** of any type, except that a vocabulary MAY declare a type's
>   body to be `prose` (§8.6.3) — rule 4 below, and the reason the rest of this
>   list holds;

and the paragraph that follows it keeps its force with one word narrowed: a
construct whose body GEML must read **as blocks** — ids it must resolve,
references §8.2(5) makes errors — cannot be admitted by a vocabulary.

**§8.6.2 rule 4** changes from "MUST NOT let admission change the document
model" to:

> 4. MUST NOT let admission change **the set of addressable units**. Admission
>    licenses names, and — for a type the vocabulary declares `prose` (§8.6.3) —
>    how that type's body is read. A processor that does not recognize the
>    vocabulary reads the body as `raw`, one that does reads it as prose, and
>    both yield the same block, with the same id, and no addressable unit inside
>    it. Every other admitted type keeps the `raw` body §8.2(6) gives an unknown
>    one.

**§8.6.3** is new and defines the prose body as above.

### What a non-recognizing processor sees

Unchanged: `raw`, as §8.2(6) requires for an unknown type. The two processors
therefore differ in the block's body *representation* and agree on every address.
They may also differ in **diagnostics** — a dangling `[[#x]]` inside a prose body
is an `unresolved-reference` for the processor that reads it and silence for the
one that does not. That difference is not new: rule 1 is entirely about
diagnostics differing with what a processor recognizes, and §8.4's suite is
stated over the model, not over diagnostics.

### Before / after

```geml
=== meta
profile = "geml-media/v1"
===

=== media-text {#hero-look .look}
二十六岁女性，**银灰短发齐耳**，左眉一道旧疤。
===
```

*Before:* `#hero-look` is a block with a `raw` body. `![[#hero-look]]` elsewhere
is `inline-transclusion-not-inline`, because the target is not a single-paragraph
prose block. The projection cannot be written.

*After:* `#hero-look` is a block with a prose body of one paragraph; the
projection resolves and expands. The document's addresses are `#hero-look` in
both readings.

## Conformance impact

The existing case **"a profile declaration does not change the document model"**
stands unchanged. Its vocabulary (`acme-invoice/v1`) is one no implementation
recognizes, so what it pins is rule 3 and the `raw` default — neither moves.

Two cases are added to `geml-parser/test/conformance/vocabulary.json`, stated
over **the addressable set**, which both kinds of processor produce identically
and which is what the amended rule 4 promises:

1. *a prose-declared type contributes exactly one address* — a document whose
   vocabulary type holds a fence-open line and a heading line in its body has the
   same addressable set as the same document with a paragraph there.
2. *a fence line inside a prose body is not a construct* — the same document,
   projected, shows no second block.

Whether a body was read as prose is **deliberately not observable** in the
suite's projection. That is the point of the amended rule: two conformant
processors that recognize different vocabularies still agree on every case, and
the suite is what makes that testable rather than asserted.

## Alternatives considered

**Do nothing, and put the five script keys on core `text`.** Fully legal today:
attribute keys are one of the three things §8.6.1 admits, and admitting them
changes diagnostics and nothing else. The cost is scope — the keys become valid
on *every* `text` block in a document that declares the vocabulary, and a
`since=` on a paragraph of ordinary prose is caught only by the profile's own
`media-attr-misplaced`. This is the option to fall back to if this GEP is
rejected; it loses nothing structural.

**Do nothing, and put `media-text` into §3's registry.** GEP-0008's shape: a
construct that needs a body mode goes to the specification. It works, and it is
what the current §8.6.1 tells you to do. But what lands in the registry is
`text` plus five attribute keys — a near-duplicate of a type that already exists,
carried into the specification to win a namespace. The registry is the place for
constructs the specification must read; this one is prose it already reads.

**Relax rule 4 completely**: admission may set any body mode, and the model need
only agree among processors that recognize the vocabulary. This is the natural
reading of "extensible", and it is how rendering formats work — unknown elements
degrade, known ones get behaviour. It would legalize `form` and `form-group` too,
and remove this class of friction for good. It was rejected for the measurement
in *Motivation*: `#inner` exists or does not depending on the reader's vocabulary
list, so `geml get doc#inner` stops being a question with one answer. A format
whose claim is per-block addressing cannot make its addresses
implementation-dependent and keep the claim. The narrow rule keeps the invariant
and buys the case that needed it.

**Give the vocabulary type a `raw` body and parse it in the application layer.**
The projection is then not GEML's projection: references inside would not be
recorded, `--to md` would not expand them, and every consumer would need the
vocabulary's own parser to read a block GEML had already declined to read. It
reintroduces, one layer down, exactly the split §8.6 exists to prevent.

## Compatibility & migration

No existing valid document changes meaning, and none can: no vocabulary declares
a prose body today, and the default for an admitted type is unchanged. A document
that a processor could read before it reads identically after.

`geml <file> --to geml` is unaffected — a prose body serializes to the same bytes
it was written as, whether it was read as prose or as raw.

**`geml-form/v1` is not legalized by this.** Its `form` and `form-group` hold
`form-field` blocks with ids; they are containers, not prose, and the measurement
in *Motivation* is theirs. They belong in §3, which GEP-0008 proposes; until that
lands, the reference implementation's `bodies` declaration for them is a
divergence from §8.6.2 rule 4 and should be recorded as one rather than read as
precedent.

## Drawbacks & open questions

**The whole shape of this is provisional, and deliberately recorded as such.**
The maintainer accepted the narrow rule as the current version without being
convinced by the reasoning end to end; it is not a settled position, and a later
version may take it back. What is actually unsettled is the choice against full
relaxation: whether an address set that depends on the reader’s vocabulary list
is intolerable, or merely untidy. The narrow rule is the conservative answer to
that question, chosen because it is the one that can be widened later without
invalidating a document — not because the argument closed.

Three things would move it:

- **More container cases.** If vocabularies keep needing types that hold
  id-bearing blocks, the narrow rule becomes a toll booth on the same road and
  full relaxation gets stronger by repetition. `geml-form/v1` is already
  one.
- **GEP-0011 growing downward.** The invariant here rests on paragraphs not
  being addressable. If inner-unit coordinates ever reach into prose, the
  justification has to be rewritten, not patched.
- **How real the second implementation is.** Rule 4 protects agreement between
  independent processors. This repository has a clean-room second implementation
  in its suite, so the concern is not hypothetical — but if that stays the only
  one, the rule is being paid for by a reader who does not exist yet.

- **A third body mode.** `raw`, `flow`, `prose` — and prose is *almost* flow.
  The difference is exactly "may not contain blocks", and it exists to keep an
  invariant rather than to express a new shape. That is a real cost in the
  specification's surface, paid for one property.
- **The model shape still differs** between a recognizing and a non-recognizing
  processor (`children` of paragraphs versus `raw` lines), even though the
  addressable set does not. The suite is stated so as not to depend on it; a
  reader of the model, however, can still tell. Whether that is "the model
  changed" is a judgment the amended rule 4 settles by naming addresses instead
  of the model — but it is a narrowing, and it should be read as one.
- **Should §3's own types be able to declare prose?** `text` and `note` are
  `flow` and may nest blocks. Nothing here changes them, and nothing needs to;
  raised only because the obvious next question is whether `text` should have
  been prose all along.
- **Lists.** Excluded from prose bodies for the reason in *Design*. If GEP-0011
  never makes a list item addressable, that exclusion is pure cost and can be
  revisited.
