---
gep: 0013
title: A vocabulary may declare a body mode; an unrecognized one is announced
state: accepted
author: GEML (maintainer)
created: 2026-09-17
issue: (pending)
---

## Summary

§8.6.2 rule 3 requires a processor to meet a vocabulary it does not know in
**silence** — "not an error, not a warning". Rule 4 then has to make that silence
safe, by forbidding admission to change anything a reader could observe. The two
rules are one decision, and this proposal takes the other side of it: a processor
**MUST say** it did not recognize a declared vocabulary, and admission **MAY**
then declare a body mode for the types it admits.

Nothing about the degradation changes — a processor that does not know a
vocabulary still admits nothing and still reads those bodies as `raw`. What
changes is that the reader is told, and that the processor which *does* know the
vocabulary is allowed to read the body the vocabulary says it holds.

## Motivation

### Rule 4 exists to protect rule 3

Rule 3 is a generous claim, and the reason GEML is cheap to implement twice:

> Which vocabularies a processor recognizes is implementation-defined, and a
> processor that recognizes none is conformant.

It holds only while recognizing a vocabulary cannot change the answer to anything
§8.4's suite asks. The suite is stated over the document model, so if admission
could set a body mode, one input would have two expected projections and the
suite would have to be indexed by vocabulary set. Rule 4 buys rule 3 by making
admission unobservable.

### One of rule 4's two justifications is already spent

§8.6.2 gives two. The second — that content cannot change meaning as it moves
between documents — was measured in
[GEP-0013](0013-prose-body-for-vocabularies.md) and found to be carried by
something else entirely: every document is parsed under **its own** `=== meta`
declaration, so a host that declares nothing still projects a target that
declares `geml-media/v1` correctly. The rule is standing guard over a door
another mechanism already holds.

What remains is one thing, and GEP-0013 named it: **the set of addressable
units**. For a format whose claim is *address a document by its blocks*,
`geml get doc.geml '#x'` must not have one answer for a tool that ships a
vocabulary and another for a tool that does not.

### The specification already ships exactly that

Measured, on the reference implementation, with no profile involved:

```
=== data {#d format=json}     geml get '#d["k"]'  ->  v
=== data {#d format=toml}     geml get '#d["k"]'  ->  error: this `data` block
                                declares `format=toml`, which this processor
                                keeps raw — there is no value tree to address
```

§3.2 makes `yaml`, `toml` and `edn` RESERVED format names and requires a
processor with no engine for one to keep the body raw and emit a warning
(`data-format-no-engine`, Appendix A). Such a processor is **conformant**. So a
processor that ships a TOML engine has the address `#d["k"]` and one that does
not, does not — same bytes, both conformant, addressable set differing by
implementation capability.

This is the property rule 4 forbids a vocabulary from having. §3 has it, in the
core, today.

### The difference is announcement, not substance

The `format=toml` degradation is harmless because it is **declared by the
document and announced by the processor**: the document says `format=toml`, the
processor warns that it has no engine, and an address into that block fails with
a message naming the reason. A reader is never under the impression that it is
looking at a complete view.

A profile's degradation is equally declared by the document — `profile =` is a
reserved key, written by the author — and rule 3 forbids the processor from
announcing it. That is the whole asymmetry. Rule 4's severity is the price of a
silence nothing else in the specification asks for.

GEP-0009 considered and rejected a nearby idea: letting a checker read a
hyphenated name as a deliberate extension. That rejection was right and is
untouched here — reading a namespace out of a **name's shape** is inference, and
rule 2 forbids it. Reporting that a name the **document explicitly declared** is
one this processor does not ship is not inference of any kind. The two were
rejected together; only one of them deserved it.

## Design

### §8.6.2 rule 3

> 3. MUST treat a declared name it does not recognize as admitting nothing, and
>    **MUST report `unrecognized-vocabulary`** naming it. The declaration is not
>    an error: the document is valid, and the processor's view of it is
>    incomplete in a way the reader is now told about. **Which vocabularies a
>    processor recognizes is implementation-defined**, and a processor that
>    recognizes none is conformant.

### §8.6.2 rule 4

> 4. MUST NOT let admission change the **set of addressable units** except as a
>    vocabulary's declared body modes require, and then only in a processor that
>    recognizes the vocabulary. A processor that does not recognize it reads
>    every admitted type's body as `raw` — the body §8.2(6) gives an unknown type
>    — and has reported rule 3's diagnostic, so the difference is observable
>    rather than silent. Admission never changes the addresses a document's
>    **recognized** blocks carry, nor any address outside the admitted types'
>    bodies.

### §8.6.1

The first entry of the MUST-NOT list — "the **body mode** of any type" — is
removed, and the paragraph that follows it loses its force and is replaced by:

> A vocabulary that declares a body mode is declaring what its own types hold.
> It may not restate the body mode of a type **this specification** registers:
> `text` is `flow`, `data` is its format engine's, and a vocabulary that
> disagreed would be redefining a name it does not own (the last entry of this
> list).

The rest of the list — grammar, diagnostic catalogue, the meaning of names this
specification defines — is unchanged.

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

### The report follows the content across an `embed`

§3 parses an `embed`'s target as a document in its own right, under its own
`=== meta`. Measured, that already gives the good case for free: a host that
declares nothing, read by a processor that ships `geml-media/v1`, projects the
target's `media-text` as a paragraph — the embedded block arrives read the way
its home reads it, which is the whole point of embedding one.

The bad case is the one that needs the rule. A processor that does NOT ship the
vocabulary renders those blocks raw, and the reader is looking at the **host** —
a document that declares nothing, has no fault of its own, and appeared perfectly
clean before this proposal:

```
host embeds a target declaring an unrecognized vocabulary
before:  geml check host.geml  ->  ok: no diagnostics
         geml host.geml --to md ->  a fenced code block where prose should be
```

So rule 3's report is required at the embedding block as well — **and only for
a target the host itself names.** Reporting it from the transitive walk that
already exists for cycle detection was measured to disclose a third document:

```
A embeds one PUBLIC block of B; B, in a block A never took, embeds secret.geml
leaked:  geml check A.geml -> `secret.geml` declares `acme-payroll/v1` …
         and the same string in A's published --to html
```

`A` never named `secret.geml` and received no content from it. So the rule has a
second half: a diagnostic may name only documents this document names. The host
still learns the vocabulary of a document it embeds from even when the slice it
took does not use it — that document is one the host names and reads, so it is a
dependency the host already has, and the rendered page suppresses the notice
anyway unless the page actually shows a block it could not read.

 That draws a line
this specification did not have to state before: a diagnostic about **what this
processor cannot do** follows the content, because its effect follows the
content; a diagnostic about **a document's own fault** stays with that document.
`unknown-block-type` inside the target is the target's fact and does not travel.

### Appendix A

| Code | Severity | Condition |
|------|----------|-----------|
| `unrecognized-vocabulary` | warning | A `profile` name this processor does not recognize (§8.6.2 rule 3). The vocabulary admits nothing and every type it would have admitted keeps the `raw` body of an unknown type; the reader's view of the document is incomplete. |

Severity follows `data-format-no-engine`, which reports the same class of fact:
the document is well-formed and this processor cannot read part of it.

### What each processor sees

```geml
=== meta
profile = "geml-media/v1"
===

=== media-text {#hero-look .look}
二十六岁女性，**银灰短发齐耳**，左眉一道旧疤。
===
```

| | recognizes `geml-media/v1` | does not |
|---|---|---|
| `#hero-look` | a block with a prose body | a block with a `raw` body |
| addresses | `#hero-look` | `#hero-look` |
| diagnostics | none | `unrecognized-vocabulary` |
| `![[#hero-look]]` | expands | `inline-transclusion-not-inline`, alongside the warning that says why |

The second column is a processor that has told the reader it is reading with one
eye shut. That is the whole change.

## Conformance impact

**The suite does not change.** §8.4's suite is stated over the document model,
and diagnostics were never part of it — rule 1 is already entirely about
diagnostics differing with what a processor recognizes. The six cases in
`conformance/vocabulary.json` use a vocabulary name nothing recognizes and assert
identical projections; they assert the same projections after this proposal,
because a vocabulary nothing recognizes still admits nothing.

**The second implementation needs no change.** `conformance/impl2.mjs` already
has `collectMeta` and states in three places that diagnostics are out of its
scope. The new MUST is a requirement on a production processor that the suite
does not reach — which is worth saying plainly rather than claiming a rigour the
mechanism does not have. If the announcement should be verifiable, the place for
it is a per-profile conformance suite, which does not exist yet and is out of
scope here.

## Alternatives considered

**The narrow rule — one exception, for prose only.** This was this proposal's
own first draft, and the version the maintainer accepted "without being
convinced by the reasoning end to end". It amends rule 4 to admit a `prose` body
and nothing else, on the ground that prose provably creates no addresses. It
works for `geml-media/v1` and for nothing else: `geml-form/v1`'s containers stay
illegal, and the draft's own drawbacks named the repetition to come — *if
vocabularies keep needing types that hold id-bearing blocks, the narrow rule
becomes a toll booth on the same road*. What reopened it was noticing that the
ban it was tiptoeing around had a cause, rule 3's mandated silence, and that the
cause was the thing to fix. The `prose` body mode survives from that draft on
its own merits; the exception it was built to justify does not.

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

**Relax rule 4 and leave rule 3 silent.** The address set would then vary between
processors with nothing to tell a reader which one it has. This is the version of
the idea GEP-0013 rejected, and rejecting it was right: an unobservable
difference in an address set is exactly the failure a per-block addressing format
cannot afford. Announcement is what makes the same relaxation safe.

**Make the announcement a SHOULD.** Then rule 4's relaxation would be
conditioned on something a conformant processor may skip, and the guarantee would
be worth nothing in the one case it exists for. A processor that does not want to
report it can recognize the vocabulary instead.

**Infer the vocabulary from a name's shape** (`acme-…` is deliberate, `ntoe` is a
typo). Rejected by GEP-0009 as rule 2, and still rejected. Nothing here reads a
namespace out of a name; it reports a name the document wrote.

## Compatibility & migration

**No document changes meaning.** A document that parsed before parses identically
after; the only new output is a warning on documents that declare a vocabulary
the reader does not ship. A processor that recognizes every declared vocabulary
emits nothing new.

**Two recorded divergences become licensed extensions.**
`geml-form/v1`'s `bodies: { form: "flow", "form-group": "flow" }` and
`geml-media/v1`'s prose body are both described in their own documents as
divergences from rule 4. They stop being divergences. GEP-0008 is unaffected in
substance — whether `form` belongs in §3 is now a question about *ownership*,
not about what a profile is permitted to do.

**GEP-0013 narrows rather than dies.** Its rule-4 amendment is superseded by this
one. Its `prose` body mode is not: a body in which a fence-open line, a heading
and a list marker are **text rather than constructs** is a real and useful shape,
distinct from `flow`, and `ProfileDef.prose`'s other job — granting a type the
privileges core gives `text` (inline-projection target, Markdown paragraph
projection, the same rendered container) — is untouched by this proposal and
still needs saying. 0013 should be rewritten as "a `prose` body mode and a
prose-type declaration", with its rule-4 argument removed.

**The reference implementation** already carries the machinery: `ProfileDef.bodies`
exists and is honoured, and `vocabularyFor` merges it. What it does not yet do is
report the new code, and it silently lets the last-registered profile win when two
declare different body modes for one type — a static conflict a registry test
should refuse.

## Drawbacks & open questions

**The mechanical GEP-versus-profile test is lost, and it was load-bearing.**
`spec/proposals/README.md` asks one question — *does GEML have to read inside the
block's body?* — and answers it from rule 4. After this proposal a vocabulary may
have GEML read inside its bodies, so the question stops deciding anything. This
is the sharpest form of GEP-0009's own warning: "a tier is a place to hide… the
§8.6-rule-4 test is the only thing standing between that and a core registry that
never grows again." **A replacement boundary has to land with this proposal, not
after it.** The candidate is a question about ownership rather than mechanism —
*is this construct the format's, or an application's?* — which is a judgment, and
therefore needs the governance the mechanical test made unnecessary: a `state` on
every profile, and a conformance suite per profile. Both are proposed separately;
neither exists today. **This is the open question on which this proposal should be
accepted or rejected.**

**Warning noise on generic tooling.** A tool reading a repository of codemap
output, history sidecars and media documents now warns once per document. That is
the intended signal, and it is also the first thing a user will want to silence.
`--severity unrecognized-vocabulary=off` is the obvious escape hatch and does not
exist; a general per-code severity control is proposed in the `geml-media` design
record (§7.1) and would serve this too.

**The address set genuinely varies now**, and no amount of announcement makes
`geml get doc.geml '#inner'` return the same thing to two tools. What the warning
buys is that the tool which cannot see `#inner` knows it cannot, and can say so
instead of reporting that the address does not exist. Whether that is enough is
the judgment this proposal asks for; the `format=toml` precedent is the evidence
that the specification has already judged it enough once.

**The model shape differs too**, not only the address set — `children` of
paragraphs versus `raw` lines. GEP-0013 raised this and settled it by naming
addresses instead of the model. The same settlement is assumed here, and it is
the same narrowing.
