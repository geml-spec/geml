---
gep: 0010
title: Projections along the language axis — a translated document is a view, not a copy
state: draft
author: GEML (maintainer)
created: 2026-08-31
issue: (pending)
---

## Summary

Let a document be a **translation** of another the way it can already be a
rendering of one: `_CN.geml` holds `=== embed` blocks and nothing else, each
asking for a target language with `lang=`, and a processor that knows the
vocabulary projects the source's prose into it while leaving everything that is
not prose exactly as it is. The document names a **target**, never a provider —
whatever translator the host has is the host's business, exactly as
`format=mermaid` names a language and not an implementation of it. The
structure is not duplicated — block ids, order and non-prose content have one
home — so drift is not detected, it is impossible.

[GEP 0006](0006-declared-projections.md) makes a derived **file** checkable along
the format axis (`A.geml` projects to `A.md`). This is the same relationship
along the **language** axis, and it reuses 0006's shape rather than inventing a
parallel one.

It also carries the addressing revision it needs. A translated document can only
be assembled tile by tile if every tile has an address, and prose runs have
none today — so this proposal includes making them addressable, by **position**
rather than by content, together with the one sentence of §0.6 that has to widen
for such an address to be legal in a document. That is a revision of machinery
that already exists (`geml add` anchors on `--before #id`; a block with no `#id`
already gets a content address) rather than a new language feature, and it is
carried here rather than deferred because without it this profile fits one tidy
document and nothing else.

## Motivation

### The drift is measured, in this repository, this week

`docs/PUBLISHING` is four files for one document: `.geml` and `.md`, each in EN
and CN. The `.md` pair is generated, so that axis is mechanical. The CN prose is
not: every edit to the English has to be re-made by hand in the Chinese, and in
the session that produced those files it was got wrong once — a claim that the
two versions shared their diagram and tables verbatim, which measurement then
contradicted, because they had in fact been translated and diverged.

The specification has already conceded this fight once. `GEML-spec_CN.md`
refuses to translate Appendix A at all:

> 完整的代码、严重级别与条件对照表见英文版附录 A —— **它是规范性的，不作翻译以免漂移**

Faced with "translate it and let it drift" or "point at the English", the answer
was to point. That is the right answer for a *copy*. It is not the only shape
available.

### Why this belongs in GEML rather than in a browser

A generic translator wrecks this content. GEML knows which blocks are prose
because §3's registry already says so — measured across the built-in types:

| block | `mode` | model beyond `raw` | may be translated |
|---|---|---|---|
| `code`, `math`, `diagram`, `embed` | `raw` | — | never |
| `data` | `raw` | `value` | never — it is data |
| `table` | `raw` | `table` | **the cells, yes** |
| `note`, `text` | `flow` | `children` | yes |

"Translate this page" in a browser mangles the `code` bodies, the mermaid source
and the JSON. A GEML-aware projection does not, because the type says what the
body is. That is a capability the format has and a generic tool cannot have, and
it is the whole of the case for doing this here.

## Design

### The translated document

```
=== meta
title    = "发布"
profile  = "geml-translator/v1"
lang     = "zh-cn"
source   = "PUBLISHING.geml"
===

=== embed {src=PUBLISHING.geml#topology lang=zh-cn}
===

=== embed {src=PUBLISHING.geml#prereq lang=zh-cn}
===
```

Nothing but embeds. Ids, order and every non-prose byte have exactly one home.

### The prerequisite: the embeds must tile the source

Everything above assumes a document of embeds can reproduce its source without
losing anything. That is a claim, not a given, and it was verified before the
rest of this proposal was worth writing.

**It holds, and it was checked against the hardest document here rather than a
convenient one.** `spec/in_geml_format/GEML-spec.geml` is 1388 lines carrying 16
tables, 9 code blocks, 2 diagrams and an `embed` of its own. Its 16 `##`
sections tile L5–L1389 with **zero gaps**. A 52-line document embedding those 16
ids projects to 1349 lines of Markdown; so does the source; and from the first
section onward the two are **byte-identical** across 1345 lines — nested
transclusion included. An `embed` naming a heading pulls the **whole section**,
bare paragraphs and nested blocks and all, not merely the heading line.
(`docs/PUBLISHING.geml`, 199 lines and six sections, behaves the same way at
smaller scale.)

The only lines the 16 embeds do not cover are L1–4 of the source, which are its
H1 title and its `*English | [中文](…)*` switcher — precisely the two things a
translated document writes for itself. The uncovered region turns out to be
exactly the translation's own authoring surface, which is a pleasant accident
rather than a designed one, and worth not relying on.

**But embedding every addressable id is not the same as embedding everything,
and the difference is silent.** A source with a paragraph before its first
heading has content that belongs to no addressable unit at all: `geml list`
reports `meta` at L1–3 and the headings from L7, and the lines between are
nobody's. A translated document that embeds both headings still checks clean —
`ok: no diagnostics` — and its projection simply does not contain that
paragraph. Nothing warns, because nothing was asked to.

So the real prerequisite is not "embed works" but **the embedded ids must tile
the source**, from the end of its meta to the end of the file. That is
mechanically checkable: `geml list` already reports every unit's line range, so
a tool can prove coverage rather than trust it, and a gap is a diagnostic
waiting to be defined rather than a design flaw.

It also puts a mild pressure on the source, which is arguably where the pressure
belongs: prose that nothing can address is prose that nothing can transclude,
translate, or block-edit either. §3 already gives it a home — `text` is "an
addressable prose container" — and this proposal simply makes the cost of not
using one visible.

### Granularity is bounded by addressability, and that bound bites

Tiling a document with section embeds is complete, but it is **all-or-nothing**:
the translated document says "project this section" and has no way to add "…but
leave the `code` block in it alone". The per-type rule still protects that code
block — a translator applies it while walking the embedded content — so the
*default* is right without the document saying anything. What cannot be
expressed is the **exception**, and that is a real loss: a note that is a term
of art, an error message quoted verbatim, a passage whose wording is the point.

The obvious repair is to embed at the finest granularity `geml list` reports,
one embed per unit, so each carries its own `lang=` or `translator=none`. That
does not work today, and the reason is worth stating precisely because it names
the missing primitive.

Measured on a section holding three prose runs and two blocks, `geml list`
reports exactly three units: the section, the `code` block and the `table`. **The
prose runs between the blocks have no ids at all.** So:

| what is embedded | complete? | per-unit selectivity? |
|---|---|---|
| the section | **yes** — byte-identical | no — one `lang=` for everything inside |
| its blocks, individually | **no** — all three prose runs vanish | yes, per block |
| a line selector (`#L7`) | — | not an address `embed` accepts: `unresolved reference` |

`geml get` does take `L27-58`, but it resolves to the smallest *block* holding
those lines, which for prose inside a section is the section itself — and
`embed` rejects the form outright. `--intro` does not help either: it is "up to
the first subheading", so on a section without subheadings it returns the whole
body, blocks included.

So the proposal as written operates at section granularity with **automatic**
per-type selectivity, which is correct but silent. **Declared** per-unit
selectivity needs the source to be tiled by addressable units all the way down,
which today means wrapping every prose run in `=== text {#id}`. That is a real
cost on the source and it should be named rather than assumed away: it is
mechanical, a tool could do it, and §3 blesses it — but it turns a readable
document into a scaffolded one, and whether that trade is worth making for
translation alone is not obvious.

There is a third way out, and the measurement points straight at it: **the
exceptions worth declaring are almost always blocks, and blocks already have
ids.** A `code` body, a `data` value, a `note` quoting an error message verbatim
— that is what `translator=none` is for. Prose one would want to exempt is rare,
and where it exists, wrapping that one run in `text {#id}` is a cost paid once,
where it is needed, instead of everywhere.

So keep the section embed, which is complete, and name the exceptions inside it:

```geml
=== embed {src=PUBLISHING.geml#a-parser lang=zh-cn except="#cmd #t"}
===
```

A space-separated list in a quoted value is not a new shape: `profile = "a b"`
is already one. Selectivity becomes something the document **declares** rather
than something the translator infers, and it costs no new address form, no model
change and no identity that an edit can break.

**What `except=` is, and what it is not.** It suppresses translation *in place*:
the translator walks the embedded content and leaves the named ids alone, so a
`code` body or a term of art stays exactly as the source wrote it, where the
source wrote it. It is an instruction to the translator, not a hole in the
embed.

That distinction is load-bearing, because **an embed composes by concatenation
and never by substitution**, and the difference was measured. Embedding a
section and, separately, a block inside that section produces no conflict —
`ok: no diagnostics`, because embedded ids do not propagate into the host at all
(`geml list` on such a document reports only anonymous `embed@<hash>` units).
But the block's content then appears **twice**: once in place inside the
section, once again at the end where the second embed sits. Silent duplication,
and out of order.

So a translated document cannot be assembled as a mosaic of the source. "Render
this section in zh-cn, but that one block in ja" has no expression: leaving the
block in place means it takes the section's language, and pulling it out
separately duplicates it and moves it. The only arrangement that would place
differently-treated pieces in their original order is one embed per unit in
order — which loses every prose run between them, because prose has no address.
The same missing primitive, seen from a third side.

**And that is disqualifying, not merely limiting.** A translated document that
can only ever take whole sections works for a tidy source and fails for any
other; it cannot reorder, cannot split, cannot place a translator's note, cannot
treat one block differently from its neighbours. If the mosaic cannot be
assembled, this profile is a trick that happens to fit `PUBLISHING.geml`, not a
mechanism. So the primitive is a **dependency of this proposal**, not an
improvement to it. So this proposal carries it, rather than waiting on one that
might.

### The addressing revision this proposal includes

Two measurements put it within reach, and neither was in the first draft.

**The addressing scheme already exists.** A block with no `#id` gets a content
address — `geml list` prints `text@65334d3e`, `geml get '@11d4abb2'` resolves
it, and the CLI documents `@<hex>[~n]` as the address form "for blocks with no
#id", the `~n` disambiguating identical content. Nothing has to be invented to
name an anonymous unit. What is missing is only that **prose is not a unit**:
`list` on a document of two paragraphs and two blocks reports the blocks and
says nothing about the paragraphs.

**And it does not require prose to become a block.** Wrapping each run in an
anonymous `=== text` does work — `list` then reports `text@65334d3e` and
`text@bc3d851f`, and the `--to md` projection is **byte-identical** to the bare
original — but it moves the document model, and §8.4's projection with it: the
suite renders blocks opaquely, so the same sentence reads as
`"Plain " strong("prose") " with a " code("span") "."` bare and as `block:text`
wrapped. That is a price this proposal does not have to pay.

What it needs is not a node but an **address**. A processor can report a prose
run as an addressable region and resolve a reference to it without adding
anything to the model: paragraphs stay paragraphs, the projection is untouched,
and every existing conformance case holds. The host document gains an `embed`
node exactly as it does today; only what that embed *resolves to* is new.

(The wrapping experiment did surface something worth reporting elsewhere: as it
stands the conformance suite can only see inline structure in **bare**
paragraphs. Put the identical sentence in the `text` block §3 invites and the
suite goes blind to its emphasis, code spans and links. That hole is independent
of translation and wants its own fix.)

#### What identity that primitive should carry

Content addressing is the scheme that exists, and for this it is the wrong one.
`@<hex>` is derived from the run's own bytes, so **every rewording changes the
address** — and rewording is what happens to prose. A hand-maintained
translated document would break on the most ordinary edit there is.

Position is the alternative: name a run by the stable things around it rather
than by what it says — the prose between `#intro` and `#chapter1`. The
toolchain already thinks this way, though only for writing: `geml add` takes
`--before #id` and `--after #id`. What is missing is the same idea as an
*address* rather than an insertion point.

The two schemes fail in opposite places, and the difference decides it:

| | rewording the run | inserting a block beside it | renaming the anchor |
|---|---|---|---|
| `@<hex>` | **breaks** | survives | — |
| between two anchors | **survives** | becomes ambiguous | breaks, as any id reference does |

Rewording is constant; inserting a block exactly between two named ones is rare.
But frequency is the smaller half of the argument. The larger half is that
**each scheme names a different thing, and each is right to change when that
thing changes**:

| address | names | changes when |
|---|---|---|
| `#id` | an author's declaration | the author changes it |
| `@<hex>` | some bytes | the bytes change |
| between two anchors | a **position** | the position changes |

A content address breaking on a rewording is not a defect; it is the address
being honest about what it names. A positional address breaking when a block is
inserted between its anchors is honest in exactly the same way — **the position
did change**, so an address that named it should stop resolving. Neither is a
flaw to be engineered around. The only mistake available is choosing the kind
that names something other than what you meant.

Which settles what a translated document means when it says "the run between
`#cmd` and `#next`": *whatever prose sits in that slot*, not *this particular
text*. That is exactly what a view wants to say, and it is why the position
changing should invalidate it.

It also means the primitive needs no new diagnostic. A positional address whose
slot no longer exists is an unresolved reference, and §8.2(5) already makes that
an error — loud, rare, and pointing at the edit that caused it.

Two anchors rather than one, for the same reason turned around. "The run after
`#cmd`" keeps resolving after a block is inserted there, and quietly names
something else; "the run between `#cmd` and `#next`" stops resolving, which is
the truthful answer.

There is a pleasing consistency in this, and it is worth stating because it
suggests the choice is not arbitrary. The two identity schemes match the two
variants of this proposal exactly. **Live** wants positional: the address
survives edits, always resolves, and the projection simply re-translates
whatever is there now — zero drift, which is the point. **Pinned** would want
content hashing: the address breaking on an edit *is* the staleness detection.
Having chosen live, positional is the primitive that fits, and pairing them the
other way round would be the mistake — a positional address would let a stored
translation go quietly stale.

#### An anchor may be a boundary, not only a block

Two block anchors do not cover every run, and the gap is at the ends. In a
section holding four prose runs among three blocks, the first run has no block
to its left and the last has none to its right — there is nothing after it but
the section's end.

So an anchor is either a block id **or a boundary of the enclosing addressable
unit**: the start of a section's body, or its end. Then the first run is
*between the start of `#pub` and `#cmd`*, the last is *between `#warn` and the
end of `#pub`*, every run has exactly two anchors, and all of them are derived
from ids that already exist.

This is not new thinking for this format, only a new use of it. `geml get
--intro` already names a boundary-delimited region — "everything under a heading
up to its FIRST SUBHEADING" — so regions bounded by structure rather than by
content are an established idea here; they are simply not yet addresses.

The identity rule survives intact: insert a block after `#warn` and "between
`#warn` and the end of `#pub`" is two runs rather than one, so the address stops
resolving. Which is right, because the position changed.

A heading anchor must say **which edge**, and this is not a detail. A block
occupies a bounded span with prose on either side of it; a heading does not — its
region starts at its own line and swallows everything after it. Measured on a
document whose outer section holds a block, then a subheading, then more blocks:

```
#outer   heading  L5-24     ← contains #inner
#c1      code     L9-11
#inner   heading  L15-24    ← runs to the end of #outer
#c2      code     L19-21
```

So the run before `#c1` is bounded on its left by `#outer`'s **heading line**,
not by `#outer`'s region, which begins above it and covers the whole document.
The run before `#inner` is bounded on its right by `#inner`'s **start**. Both are
edges of the same heading, and an address that says only "`#outer`" has not said
which.

Mixed anchor kinds are therefore the common case, not the exception: heading-edge
on one side and block on the other.

**Always the innermost enclosing container.** In that measurement `#inner` and
`#outer` both end at L24, so the tail run can be described as "between `#c2` and
the end of `#inner`" or "…the end of `#outer`" — the same run, two spellings.
They stop agreeing the moment `#outer` gains a sibling section after `#inner`:
the first address still names the tail of `#inner`, the second silently widens to
span across `#inner`'s boundary. An address generator must take the innermost
container, and a specification should say so rather than leave it to taste.

**An anchor is only as stable as its own id**, and that is a real hole rather
than a caveat. A heading without an explicit `{#id}` derives one from its text,
so rewording the heading changes the id and breaks every positional address
anchored to it — the content-derived volatility this scheme was chosen to avoid,
re-entering through the anchor.

Measured, and the non-ASCII case is the ordinary one rather than an edge:
`# 发布流程` derives `#发布流程` and `## 核对` derives `#核对`, verbatim, because
a NAME admits any Unicode letter. So `#核对..#cmd` is a legal and readable
address — and it stops resolving the moment someone rewrites that heading.

The mitigation is advice the format already gives for its own reasons: give every
section a stable `{#id}`. This proposal makes the cost of not doing so concrete,
and a processor generating addresses should prefer an explicit anchor over a
derived one — or refuse to generate an address whose anchors are all derived,
rather than emit one that will break quietly.

One spelling trap, recorded here and answered under §Addresses below. A flat
NAME form is tempting because it is already legal — `src=doc.geml#pub-after-cmd`
parses today — but ids may contain hyphens, so any infix separator can also occur
*inside* an anchor and make the address unreadable back. That is the residual
cost of staying inside NAME, and the reason a delimited form keeps being
attractive despite §0.6 not admitting one.

What remains open: a run whose neighbours are themselves anonymous has no stable
anchors and falls back to content addressing with all of its volatility. Whether
that is rare enough to accept, or wants a rule of its own, is unresolved.

#### Worked example

A source, its actual `geml list` output, the addresses the four prose runs would
need, and the view assembled from them. Everything below except the address
column is real output, not illustration.

```geml
 1  === meta
 2  title = "Publishing"
 3  ===
 4
 5  # Publishing {#pub}
 6
 7  Run this from the parser directory.
 8
 9  === code {#cmd lang=sh}
10  npm publish --provenance
11  ===
12
13  Then confirm it landed.
14
15  ## Verify {#verify}
16
17  Two checks, in order.
18
19  === table {#checks format=csv header=1}
20  Step, Check
21  "npm", "npm view version"
22  ===
23
24  That is the whole of it.
```

```
$ geml list publishing.geml
=== meta  meta     anon  L1-3
#pub      heading  h1    L5-25   Publishing
#cmd      code           L9-11
#verify   heading  h2    L15-25  Verify
#checks   table          L19-22
```

Five units, and **not one of the four prose runs is among them** — L7, L13, L17
and L24 are addressable by nothing. That is the gap, in the tool's own words.

After this proposal the same command has to report them, and that is a
requirement rather than a nicety: `list`'s addresses are the ones that "paste
straight into" the other verbs, so a run nobody lists is a run whose address
nobody can discover and no generator can enumerate. The listing becomes:

```
$ geml list publishing.geml          # as proposed
=== meta               meta          L1-3
#pub                   heading    h1 L5-25   Publishing
#pub-before-cmd        paragraph     L7-7
#cmd                   code          L9-11
#cmd-between-verify    paragraph     L13-13
#verify                heading    h2 L15-25  Verify
#verify-before-checks  paragraph     L17-17
#checks                table         L19-22
#verify-after-checks   paragraph     L24-24
```

Nine units that now tile the document, and the coverage check the prerequisite
section asks for becomes trivial: the ranges are contiguous from the end of the
meta to the last line.

The kind is **`paragraph`**, not a new word. That column reports the model's own
node kinds — measured, the children of this document are
`block, heading, paragraph, block, heading, paragraph` — which is also why
`heading` appears there while `=== heading` is not a block type at all. A run
already has a name in the model, and `text` would be the wrong one: it would
imply a `text` block that this proposal deliberately does not create.

The addresses above are written flat, and that is chosen for one reason that
outweighs its looks: **the form is already a valid NAME**, so §0.6's line needs
its *scope* widened and its *syntax* not touched at all. A delimited form like
`#pub..#cmd` reads better and cannot collide, but `.` is not a NAME character, so
it would be a fragment §0.6 does not admit. This parser happens to be lenient —
`#pub-after-cmd`, `#pub..cmd` and `#pub~cmd` all come back as `unresolved
reference` rather than a syntax error — but leniency is not conformance, and a
stricter implementation would be within its rights to reject the delimited ones.

**Collision, and why it is not a parsing problem.** `before`, `after` and
`between` are ordinary words, and ids may contain hyphens — `#before-you-begin`
and `#after-install` are natural anchors, and a base rate settles nothing.
Measured on this repository as one data point: 683 distinct explicit ids across
175 files, 108 of them hyphenated, up to four hyphens deep, one non-ASCII — and
zero containing any of the three words, as an infix or at an edge. That is one
corpus, and no evidence at all about anyone else's.

What makes the collision bounded is that resolution is **a lookup, not a string
split**. The set of ids in the document is known when the address is resolved, so
a processor enumerates the candidate splits at each relation-word token and keeps
only those where both anchors are real ids standing in the named relation. Three
cases, and only one needs a decision:

1. **A hyphenated id, or a relation word at an id's edge** — harmless.
   `#intro-before-before-you-begin` has two `before` tokens and so two candidate
   splits, but the second requires both `#intro-before` and `#you-begin` to exist
   and be adjacent. Normally one split survives.
2. **A real block id equal to a synthesised address** — someone's document really
   does have `{#intro-before-setup}` on a block. This is the likelier collision,
   and the rule is one line: **an explicit `id` always wins.** A synthesised
   address is consulted only when no block carries it. So adding an id never
   breaks a document, it shadows; the shadowed run becomes unaddressable, and the
   author's recourse is to embed its container whole — coarser, but nothing
   silently dropped.
3. **Two splits surviving the filter** — constructible, requiring `#intro`,
   `#intro-before`, `#you-begin` and `#before-you-begin` all present with both
   relations holding. This wants a diagnostic of its own, an **error** for the
   same reason §8.2(5) makes an unresolved reference one: two implementations must
   not disagree about what a document means. The fix is to rename an anchor, which
   `geml rename` already does.

**Derived container ids are the real fragility — and it is not expressibility.**
Measured, a heading with no `{#id}` still yields a usable one: `## Verify (v2) —
final!` derives `#verify-v2-final`, so punctuation collapses and a derived id is
always a legal NAME; `# 发布流程` derives `#发布流程`, and `src=doc.geml#发布流程`
resolves today. `NAME-CHAR = LETTER | DIGIT | "-" | "_"` admits any Unicode
letter, so `#发布流程-before-c1` is well-formed. Every section is addressable.

The cost is that a derived id is a function of the heading's **words**: fix a
typo in a heading and the container id changes, so every run address inside that
section breaks at once. Script-mixing is unlovely too — `#发布流程-before-c1` is
legal, but half of it is an English keyword a reader of a Chinese document has no
reason to expect.

An earlier revision of this proposal answered that by forbidding it: a processor
MUST NOT synthesise a run address on a derived anchor, and a document to be
projected must give every section an explicit `{#id}`. **That is withdrawn**, and
measuring the failure modes is what withdrew it. Every one of them is already
loud:

| what happens to a derived anchor | result | status |
|---|---|---|
| the heading is reworded, so the id no longer exists | `unresolved reference` | **error**, §8.2(5) |
| the reword makes two sections share a derived id | `duplicate id ‹#x› (first defined at line …)` | **error** — measured, and it fires on derived ids exactly as on explicit ones |
| an address silently retargets to a different section | cannot occur — the row above catches the collision first | — |

So there is no silent inaccuracy here to trade against. The rule would have
prevented only failures that already announce themselves, and it would have cost
a great deal: most real documents do not give every section an id, so gatekeeping
makes the whole mechanism unavailable to them, or forces whole-section embeds —
which discard exactly the per-block `translator=none` hold-back that is the point
of the design. Loud breakage on a reword is the cheaper failure, and it is
repairable by the person who caused it.

What remains is advisory, and stays advisory. A processor **SHOULD** report that
an address rests on a derived anchor, so an author who is about to rename a
heading knows what depends on it — and so that when it does break, the reason is
already on the record. Giving sections explicit ids is good practice for
stability, as it was before this proposal; it is not a precondition for using it.

**The address is two names with a relation word between them.** Earlier
revisions spelled a run as a span with the relation on the outside —
`#between-cmd-and-verify` — and then needed `start-of-`/`end-of-` to say which
edge of an *enclosing* anchor was meant, because `#between-checks-and-verify`
would otherwise read `#verify` as its end in one address and its start in
another. Moving the relation to the middle fixes that, and admits three words
instead of one:

```
#<a>-before-<b>     prose in a, before b, nothing between
#<a>-after-<b>      prose in a, after b, nothing between
#<a>-between-<b>    prose between siblings a and b, nothing between
```

`#pub-before-cmd`, `#cmd-between-verify`, `#verify-after-checks`. Four properties
earn the form its slot:

- **The word is determined, not chosen.** For a run with nearest preceding block
  sibling *P* and nearest following sibling *N* inside container *C*: both present
  → `#P-between-N`; *P* absent → `#C-before-N`; *N* absent → `#C-after-P`; both
  absent → the run *is* `#C`. Total, disjoint, exactly one spelling per run. No
  convention has to be agreed on top, and two people tiling the same document
  cannot produce diffs that are not changes.
- **Every address names both boundaries of its run**, which is what makes the
  three words worth having rather than one. `#C-before-N` is bounded by *C*'s
  opening and by *N*; `#P-between-N` by two siblings. So an insertion cannot
  quietly shrink a tile: put a block between `#cmd` and `#verify` and
  `#cmd-between-verify` names a region that is no longer contiguous prose, so it
  fails to resolve — §8.2(5), an **error**. Loud, not quieter. That matters more
  here than anywhere, because silent omission is the failure mode §Prerequisite
  identifies as this design's hazard.
- **It is local.** The relation word says which slot is a container and which is
  a sibling, so the address can be read before it is resolved. This is the whole
  reason `before`/`after` put the container **first**: reverse them and
  `#checks-after-verify` reads as a span running up the page — `#verify` is at L15
  and `#checks` at L19 — and it once again takes knowledge of the surrounding
  structure to see that `#verify`'s *end* is meant. `between` needs no container
  slot at all, because two siblings already imply theirs.
- **It reads forward** in all three shapes: a container is not a position, and
  `between`'s two anchors are in document order.

The four runs cover every case the form has to handle:

| run | line | address | why this case matters |
|---|---|---|---|
| 1 | 7 | `#pub-before-cmd` | head of a container: the span form needed `start-of-`, this needs nothing |
| 2 | 13 | `#cmd-between-verify` | the only shape with no container slot — and the one where a heading is an anchor by its *start* |
| 3 | 17 | `#verify-before-checks` | head again, one level down: the container is the innermost one, not `#pub` |
| 4 | 24 | `#verify-after-checks` | tail of a container. `#pub` also ends at L25, so the innermost rule decides — anchored to `#verify`, this survives `#pub` gaining a sibling section |

And the view assembled from those tiles, with one block held back from
translation:

```geml
=== meta
title = "发布"
profile = "geml-translator/v1"
lang = "zh-cn"
===

# 发布 {#pub}

=== embed {src=publishing.geml#pub-before-cmd}
===

=== embed {src=publishing.geml#cmd translator=none}
===

=== embed {src=publishing.geml#cmd-between-verify}
===

## 核对 {#verify}

=== embed {src=publishing.geml#verify-before-checks}
===

=== embed {src=publishing.geml#checks}
===

=== embed {src=publishing.geml#verify-after-checks}
===
```

Simulating the four runs with explicit ids, so the only thing left unbuilt is the
address syntax: the source, the tiled source and this view all check clean, the
one diagnostic being `unknown attribute translator` — which the profile clears —
and the view's non-heading content is **byte-identical** to the source's under
`--to md`. Headings are written in the target language by the view itself, which
is the same authoring surface the whole-document case left uncovered.

#### What is a parser revision and what is not

Most of this is a revision of machinery that already exists rather than a new
language feature, and the boundary is exactly **whether the address appears
inside a document**.

The specification defines none of the selector forms the CLI accepts — `@<hex>`,
`L27-58`, `--head`/`--intro`/`--body` appear nowhere in it. So extending `geml
list` to report prose runs, and `get`/`set` to address them, is implementation
surface and changes nothing normative.

A reference written in a document is another matter. §0.6 says a fragment
identifier on a `.geml` resource is "a block `id` (§4)", and §8.2(5) makes an
unresolved reference an **error** — so if one processor synthesises an address
for a prose run and another does not, the same document builds in the first and
fails in the second. That is the conformance split §8.6 exists to prevent,
arriving through references instead of vocabularies, and it cannot be left
implementation-defined.

The wording change it needs is small, because the syntax is already legal:
`pub-after-cmd` is an ordinary NAME (`LETTER | DIGIT | "-" | "_"`), so
`src=doc.geml#pub-after-cmd` parses today and merely fails to resolve. What must
change is the **scope** of §0.6's line — from "a block id" to a block id or a
synthesised address for a prose run inside one — plus the rule that forms it. No
grammar, no new diagnostic, no model change.

So: the CLI half is a parser revision, the one sentence in §0.6 (and its echo in
§3) is normative, and this proposal carries both rather than deferring them.

**One honest gap in `except=` itself.** Exactly seven attribute keys carry
references and are checked — every one a `src=`, `data=` or `schema=` bound to a block type — and a
custom attribute's `#id` values are invisible to the checker: measured,
`except="#nope"` draws only `unknown attribute`, never an unresolved-reference
error. So a typo in an exception list fails silently, which is the failure mode
this whole proposal is trying to remove. Closing it means an eighth
reference-bearing key, and that is **core**: §8.6.1 forbids a vocabulary from
touching diagnostics, so a profile can admit `except` but cannot make it
checked. Small, but a specification change, and it should land with the rest.

### `lang=` asks; `translator=` is only a hint

`lang=` is the whole of the request: *project this into zh-cn*. The document does
not know, and must not need to know, what the reader's processor can reach — a
browser's built-in translation, an OS service, an MCP tool, a CLI the processor
shells out to. **How a processor obtains a translator is implementation-defined**,
the same words §8.6.2 already uses for which vocabularies a processor
recognizes, and a processor that can reach none is still conforming.

`translator=` is therefore OPTIONAL and defaults to `auto`. Two other values
earn their place:

- `translator=none` — do not translate this block even though the document asks
  for a language. The escape hatch for a term of art, a quoted error message, or
  a passage whose wording is the point.
- `translator="<hint>"` — a provider a processor MAY honour and MUST ignore when
  it cannot, degrading to `auto`. This is `format=`'s existing shape: an
  unrecognized value is a warning and the content is preserved, never an error.

A processor MAY report which provider it used, the way it reports anything else
about a render. It is not recorded in the document: the document asked for a
language, and which machine answered is not a property of the document.

### Where a translator comes from (non-normative)

The specification says only that this is implementation-defined. That is
correct and it is not an answer, so here is what the two environments actually
look like — neither of which the document participates in.

**In a browser, "which platform" has four answers and only two are usable.** The
renderer *is* the processor: it asks at render time whether it can go from the
source language to `lang=`, and renders the source language when the answer is
no — the same shape as asking whether a maths engine is present. What it can ask
is bounded by the extension manifest, and the viewer's is deliberately narrow
today: `scripting` and `offscreen`, host access to `.geml` URLs and nothing
else.

- **The browser's own programmatic translation API** — an availability check and
  an on-device model, costing **no new permission**. This is the right first
  answer, and it is right precisely because it is *not* the page-level
  "translate this page": that one is uncallable from script and is the one that
  mangles code bodies, which is the failure this proposal exists to avoid.

  Probed rather than assumed, in Chrome 148: `Translator` and `LanguageDetector`
  are present as classes whose static methods are exactly `availability` and
  `create`, and the older `self.ai` namespace is gone. But **`availability()`
  never resolved** in that browser — four targets including a deliberately
  invalid language code all sat pending past eight seconds, rather than
  rejecting. That was an automated browser and a user's may answer at once, but
  it settles a piece of implementation guidance that guessing would have missed:
  the availability check must be raced against a timeout, and **no answer is
  treated as unavailable**, which means the source language. A renderer that
  awaits it unconditionally hangs on the first block.
- **Another installed extension** — not usable. Cross-extension messaging is
  controlled by the *receiver*: the translator extension would have to declare
  `externally_connectable` naming this one. No translator does, and a convention
  that they should is not something this proposal can create.
- **A local HTTP endpoint** — `geml` itself could serve one, and the project
  already binds `127.0.0.1` this way for `geml codemap serve`, so it is
  in-family and avoids the heaviest setup. It costs a localhost host permission.
- **Native messaging to a local CLI** — the real channel for an arbitrary local
  tool, and the most expensive: a `nativeMessaging` permission *and* a native
  host manifest installed on the machine naming this extension's id.

The last two are opt-in and off by default, because each one widens what a user
is asked to trust in an extension that currently asks for remarkably little.
The selection is a preference order verified by use — built-in, then a
configured endpoint, then nothing — which is the shape the Logseq integration
already settled on for finding a CLI. Target language and on/off belong in the
extension's options; neither belongs in the document, and neither belongs here.

Measured: `integrations/geml-viewer/src/` performs no platform-capability
detection today, so all of this is new code.

**Locally it is discovery and then trust**, and the repository already knows how
to do both. Discovery by *verifying through use* is the pattern the Logseq
integration settled on — "a candidate that answers `graph list` is, by that
fact, the working one" — rather than trusting a path. Execution belongs under
the posture `recipe-trust.mjs` already enforces for build recipes: structured
argv and never a shell string, a fingerprint, explicit trust before anything
runs. A configured provider lives in the same `.geml/` config a third-party
vocabulary would be registered in.

Of the two local channels, MCP is the cleaner one — the processor asks a tool
instead of spawning a process — but it is also the one that is real work rather
than wiring. Measured: `geml mcp` is a **server**; the parser has no MCP client
in it. A configured CLI is the cheap path and reuses two mechanisms that exist.

Only the local case needs configuration at all. A browser detects what it has;
there is nothing for a user to point it at, and no config file belongs there.

**What a user would install** (surveyed 2026-08-31; this is the kind of list
that rots, so it names properties rather than winners):

| Tool | Shape | Key | Network |
|---|---|---|---|
| [`translate-shell`](https://github.com/soimort/translate-shell) | `trans -b -s en -t zh-CN "…"`, also reads stdin; gawk 4+ and curl | none | yes — fronts Google/Bing/Yandex/Apertium |
| [`argos-translate`](https://github.com/argosopentech/argos-translate) | Python CLI plus `argospm` for models; OpenNMT on-device | none | **no**, once a model is installed |
| [`skywind3000/translator`](https://github.com/skywind3000/translator) | `--engine= --from= --to=`; Google, Bing, Baidu, Youdao, Ciba, Sogou | Youdao needs none; Baidu and Azure need your own | yes |
| [DeepL MCP](https://github.com/DeepL/deepl-mcp-server) · [Lara MCP](https://github.com/translated/lara-mcp) | MCP servers, not CLIs — the channel the parser does not speak yet | account | yes |

**Or GEML ships the tool itself**, which is worth separating from wrapping. The
appeal is not hiding a CLI's flags; it is that a *GEML-aware* translator knows
what not to touch. Hand a `.geml` file to a general-purpose translation MCP and
it translates the `code` bodies — the exact failure the per-type rule above
exists to prevent, arriving through a different door.

Who that serves is not who the rest of this section serves. `geml mcp` already
exposes twelve tools and the Claude plugin registers it automatically, so a
`geml_translate` alongside `geml_get` and `geml_set` is nearly free, and an
**agent** is already an MCP client. A **renderer** is not: the parser has no MCP
client in it, so for `--to html` and the viewer this changes nothing, and a
direct CLI call stays simpler than speaking a protocol to reach a binary on the
same machine. The browser is untouched either way.

The cost is owning the seam: third-party flags drift, `argos-translate` manages
models on its own schedule, and a tool that spawns user-installed binaries takes
on the trust surface `recipe-trust.mjs` exists for. Worth it for the agent case,
where the alternative is every agent re-deriving which blocks may be translated.

The property that decides is the last two columns, not popularity.
`argos-translate` is the only one that keeps a document's prose on the machine,
which for anything unpublished is the difference between a tool and a leak;
`translate-shell` is the one that works with nothing to sign up for.
Non-interactive argv and stdin are what make any of them usable here — a
translator that only runs as an interactive shell cannot be driven under the
structured-argv rule `recipe-trust.mjs` enforces.

### What a translator must honour

The specification cannot say how to translate. It can say what must survive, and
it already has the precedent: §4's interpolation refuses to substitute inside
the verbatim atoms of §5.3 phase 1(1), so `{{key}}` inside a code span or inline
math is left alone. A translator inherits that rule and extends it.

A conforming projection MUST leave untouched:

1. **Verbatim inline atoms** — code spans, inline math. Translate *around* them,
   never *through* them.
2. **Every reference and its target** — `[[#id]]`, `[t](#id)`, `[^fn]`, and a
   link's href. The label may be translated; the target never is, or §8.2(5)
   turns a translation into a build error.
3. **Every id, class and attribute key**, and every attribute value that names a
   thing rather than saying something (`format=`, `src=`, `lang=`).
4. **Block structure**: the same blocks, in the same order, with the same ids.

And it MUST NOT emit partial output: a translator that fails, times out, or is
unavailable yields the source language for that block. Half a translated
sentence is worse than an untranslated one.

### The vocabulary is an ordinary profile

`geml-translator/v1` admits `lang` and `translator` as attribute keys on
`embed`. Measured: both are `unknown-attribute` warnings today, and §8.6.1 lists
attribute keys among the three things a vocabulary may admit — so the vocabulary
half needs **no specification change at all**.

### Translatability is declared per type, not derived from body mode

Body mode almost draws the line and then fails on one pair. `table` and `data`
are both `raw`, and they want opposite treatment: a table of this document's own
traps is nearly all sentences, while a `data` block's body is the value the
model carries and translating it is data corruption. So the profile declares
translatability per type rather than inferring it:

- **translated**: `flow` bodies (`note`, `text`), heading text, paragraph text,
  list items, `table` cells, and `caption=`.
- **never**: `code`, `math`, `diagram`, `data` and `embed` bodies; every id;
  every attribute key; `format=`, `lang=`, `src=` and every other value that
  names a thing rather than saying something.

### It is a projection, which is what keeps it legal

Translation happens where `--to md` happens: in the **renderer** (§8.3). `parse()`
is untouched, so the document model of a translated document is identical to the
model it would have with no translator at all — which is exactly what §8.6.2
rule 4 requires of anything a vocabulary admits, and why this can be a profile
instead of a change to §3.

It is also the honest classification. GEML holds that style must not change what
a document says, so translation is not style; it produces no content of its own,
so it is not content. It is a third thing the format already has a word for: a
**projection**, lossy and directional, like `--to md`. This one runs along the
language axis instead of the format axis.

A renderer that does not know `geml-translator/v1` shows the source language.
That is §8.2(6)'s degradation, not a failure.

## Conformance impact

The document model does not change, so every existing case still holds. Two new
cases in `vocabulary.json`-style form, both stated over the model:

| Case | Projection |
|---|---|
| an `embed` carrying `lang=` and `translator=` | identical to the same embed without them |
| a document of embeds declaring `geml-translator/v1` | identical to the same document with no `profile` |

**The assembly itself is verified**, which is the half that does not depend on
the addressing revision. Simulating the tiles with explicit ids — a section of
four prose runs among a `code` block, a `table` and a `note`, with a list, inline
emphasis and a link among them — a view of seven embeds in order reproduces the
bare source **byte-for-byte** in `--to md`. Adding a different `lang=` or
`translator=none` to individual tiles leaves it byte-for-byte identical still,
with `unknown-attribute` as the only diagnostic raised — so the attributes are
model-inert at tile granularity too, not merely at section granularity.

Two further cases belong to the addressing revision above, and unlike every
other measurement in this proposal these are **cases to be written, not runs
already made** — the feature does not exist yet:

| Case | Expectation |
|---|---|
| an `embed` resolving to a prose region between two ids | projects that prose, inline structure and all |
| the same reference after a block is inserted between those ids | **unresolved reference**, an error by §8.2(5) — the position changed, so the address stops naming it |

The second is the more important of the two, because it pins the identity
semantics rather than the plumbing: a positional address is allowed to stop
resolving, and must, when the position it named is gone.

The suite pins that the attributes are **model-inert**. It deliberately does not
pin translated text: a conformance case whose expectation is a sentence in
another language would be asserting a translator's output, not the format's, and
two conformant implementations must be free to name different translators. That
is a real limit on what this proposal can prove, and it is why the rules above
are written as *what must not be touched* rather than *what must come out*.

## Alternatives considered

**Do nothing.** Four hand-maintained files per document, and the drift measured
above. It is also what the specification chose for Appendix A, and for normative
text that remains the right answer regardless of this proposal.

**Copy, plus a staleness hash.** `translation-of` and `translation-of-hash` in
the translated document's meta; `geml check` compares against the source's
current hash and warns. Detects drift instead of preventing it, and keeps a
review surface — but there are still two copies of the structure, and the
non-prose blocks are duplicated for nothing. Strictly worse than embeds where
embeds apply.

**Leave it to the browser.** Measured to destroy `raw` bodies. It is also
undeclarable: the document cannot say which of its parts are translatable.

**Translate at parse time.** The model would differ between a processor that
knows the vocabulary and one that does not, violating §8.6.2 rule 4 and taking
the conformance suite with it. This is the variant that cannot be a profile.

**Address prose runs by content or by line number** — the two schemes considered
before the positional one, and the reason both were dropped is in the Design
above: an address should change when the thing it names changes, and neither
names what a translation means.

Content addressing (`@<hex>`, or an id derived from the prose) breaks on every
rewording, which is the most ordinary edit a document gets, so a hand-maintained
translated document would fail constantly. Line ranges (`#L10-L100`) are worse
for the opposite reason: they always resolve, so inserting a line silently
repoints every later reference at the wrong text — a misalignment where the
status quo at least gives a clean omission. It is also the one thing this format
says it is not: an address, not a line number.

**Turn prose runs into real blocks** rather than addressable regions. It works —
wrapping each run in an anonymous `=== text` leaves `--to md` byte-identical —
but it moves §2's document model and therefore §8.4's projection for every case
containing prose. An address needs no node, so the node is not worth its price.

**Make the translated file a generated projection** in GEP 0006's sense —
`projects-to = "PUBLISHING_CN.geml"`, regenerated by `geml project`. Checkable
and reviewable, but a generated file cannot hold a human's correction: the next
projection clobbers it.

**Pin the translation in a hash-keyed sidecar.** Produce it once with a verb,
store it keyed by the source block's hash — `.gemlhistory`'s shape — show the
stored text, let a human correct it, and mark it stale when the source block's
hash stops matching. This buys determinism, a review surface and drift
detection, and it was the author's first recommendation.

It is dropped for cost. It adds a second file format, a second thing to keep in
sync, a staleness state with a fallback path, and a verb to produce and refresh
it — a versioning system, in effect, for something that is meant to be a
**view**. The whole appeal of this proposal is that the translated document is
thin enough to be obviously correct: embeds and nothing else. A sidecar puts the
weight back, in a different place. If translations later need to be corrected
and kept, that is a proposal of its own, and it can build on this one rather
than being carried by it.

## Compatibility & migration

Purely additive. No document that parses today parses differently; the two
attributes are inert to the model, and a processor that has never heard of the
profile renders the source language.

Nothing needs migrating. A translated document can be written for one source and
not another, and a partially translated document is just one with fewer embeds.

## Drawbacks & open questions

**1. It is live, and therefore not reviewable.** The renderer translates at view
time and stores nothing. Two viewings may differ — a translator is not the
deterministic renderer a mermaid engine is — and a sentence that comes out
subtly wrong has nowhere to be fixed, because the translated document contains
no sentences.

This is accepted rather than solved, and the reason is scope. A view is allowed
to be a view. The pinned alternative buys the review surface and pays a
versioning system for it (see *Alternatives*), which is too much weight for
something whose appeal is being thin enough to be obviously correct. What keeps
the cost bounded is the rule below: this is not how normative text is
published.

**2. A translated document must not be mistaken for an authored one.** Appendix
A's refusal stands: normative text is not projected, it is pointed at.

**3. Prose in attributes.** `caption=` is a sentence; `format=` is a name. The
line above is drawn by hand, per attribute, and hand-drawn lines are where the
next surprise lives.

**4. There is nowhere to register a translator or a vocabulary, and that is not
this proposal's to fix.** §8.6.2 already makes it implementation-defined which vocabularies a
processor recognizes, and a capability provider is the same kind of thing. But
the reference implementation currently hardcodes its three vocabularies and
offers no way to add a fourth, so a third party declaring `acme-invoice/v1`
today gets a warning and no recourse — the format is open and the implementation
is not. Closing that is a reference-implementation feature, not a specification
change, and by the test in this directory's README it is not a GEP: a
vocabulary is data, and a capability provider is behaviour that belongs under
the same trust posture as `refresh.json` recipes.

**5. Table cells are prose inside a raw body.** The per-type rule handles it, but
it means a translator must understand the table model rather than the block body
— the first place this stops being a body-level operation.
