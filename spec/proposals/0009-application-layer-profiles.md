---
gep: 0009
title: The profile mechanism is how GEML is extended
state: draft
author: GEML (maintainer)
created: 2026-08-31
issue: (pending)
---

## Summary

Establish, normatively, that GEML is extended in exactly one way: a document
**declares** an application-layer vocabulary with the reserved `=== meta` key
`profile`, and that declaration — nothing else — admits block types and
attribute keys the specification does not define. §8.5 has always said the type
registry is open; §8.6 says how it opens, and closes every other route.

`GEML-history-spec` is then the first thing put through it. A companion
specification for a layer that needs nothing from §3's registry is a
mis-classification the new rule can name, so it becomes `geml-history/v1`
alongside `geml-codemap/v1` and `geml-style/v1`. That GEML is left with one
specification is the consequence, not the goal.

## Motivation

The mechanism already existed and was already load-bearing; what was missing was
any statement of it.

§8.5 has always said the type registry is open, and recommends a hyphen so an
extension stays out of the standard's way. Neither says how a processor is
supposed to **know** an extension. That gap was not academic. §8.2(7) makes
diagnostics part of conformance — *report every diagnostic with the code and
severity Appendix A assigns it* — while the reference implementation had a
registry that suppresses `unknown-block-type` for names it recognizes, and no
document said so. A second implementation could not have agreed with it about a
single codemap or history document, and would have been right to call the
divergence a bug in the first.

The demotion follows from the same reasoning rather than from taste. Measured on
this repository, the history layer needs nothing the core registry can give:

| | `revision` | `keyframe` | `blob` |
|---|---|---|---|
| body mode | `raw` | `raw` | `raw` |
| ids GEML must resolve inside the body | none | none | none |

A layer whose block bodies are opaque to GEML is, by the test this project now
writes down in [`README.md`](README.md), an application layer. And the
implementation had said so all along without anyone noticing: `geml history`,
`geml codemap` and `geml style` are three subcommand families of equal standing,
while no core verb — `check`, `list`, `get`, `set`, `add`, `delete`, `rename`,
`find`, `--to` — carries a profile name.

Meanwhile the history vocabulary was declared nowhere, so every `.gemlhistory`
this project wrote reported its own three block types as unknown: 333
occurrences across seven sidecars, three warnings per file that fixing anything
could not remove.

## Design

### The extension mechanism (§8.6)

`profile` is a reserved meta key holding a space-separated list of vocabulary
names:

```
=== meta
profile = "acme-invoice/v1 acme-style/v1"
===
```

A vocabulary admits **three things and no others**: block `type` names,
attribute keys, and `diagram` `format` names. The body mode of a type, the
grammar of §§2–5, Appendix A's diagnostic catalogue and the meaning of any name
this specification defines are all outside it, and change only through this
specification.

The third admits a distinction §8.5 had blurred by saying only that "diagram
`format` names follow the same convention". They follow it for **naming**, but
not for admission, and the split is visible in the document model:

| block | `mode` | what `format` produces in the model |
|---|---|---|
| `diagram {format=…}` | `raw` | nothing — it selects a renderer |
| `table {format=…}` | `raw` | `node.table`, the parsed grid |
| `data {format=…}` | `raw` | `node.value`, the parsed value tree |

All three bodies are `raw`, so body mode is not the discriminator; rule 4's
actual wording is. A diagram's format cannot move the model and is therefore
admissible. A table's or a data block's format *is* how the model is built, so
admitting one would be a declaration changing the model, and rule 4 forbids it
outright. `format` is one key over two unlike things, and the mechanism is what
made the difference matter.

A conforming processor:

1. MUST NOT report an admitted `type` as `unknown-block-type`, nor an admitted
   attribute key as `unknown-attribute`, when the document declares a vocabulary
   it recognizes.
2. MUST admit names ONLY through that declaration — never by inferring a
   vocabulary from content, file name or extension.
3. MUST treat a declared name it does not recognize as absent: not an error, not
   a warning, admitting nothing. **Which vocabularies a processor recognizes is
   implementation-defined**, and one that recognizes none is conformant.
4. MUST NOT let admission change the document model. Admission licenses NAMES:
   an admitted type keeps the `raw` body §8.2(6) gives an unknown one.

Rule 4 is what makes rule 3 safe to state, and it is the load-bearing clause of
this proposal. §8.4 states the conformance suite over the document model, so no
case's expected projection can depend on which vocabularies an implementation
happens to know; two conformant processors that recognize different sets still
agree on every case. It is also what makes a document safe to edit across a
boundary — block extraction, block replacement and `=== embed` behave
identically either side of a declaration, so content moved between documents
cannot change meaning in transit.

Rule 2 is the one a first-party format most wants to break. `.gemlhistory` has
its own file extension and could trivially be special-cased; it declares
`profile = "geml-history/v1"` instead, because a special case is
implementation-specific knowledge a second implementation would have to
reproduce byte for byte to agree about diagnostics.

### First application: GEML-history

A rule earns its keep by classifying something that already exists, so the
proposal applies it to the one case GEML had already got wrong.

`GEML-history-spec` was a *companion specification*. Put through the test the
mechanism implies — does GEML have to read inside these blocks? — it is not one:
`revision`, `keyframe` and `blob` all carry `raw` bodies, and nothing in them is
an id GEML must resolve. It becomes
`spec/profiles/geml-history/geml-history-profile{,_CN}.md`, its status table
restated from *Companion Specification* to *Application-layer profile*, and the
vocabulary it admits stated in a new §1.1 of that document.

Its substance does not change, which is the argument rather than a convenience:
the document already said *this extension adds no new grammar to GEML*, already
scoped its conformance section to "a conforming **history** processor", and
already called the layer optional. Only its claimed rank was wrong, and the
mechanism is what makes "wrong" a thing one can say.

The tier follows from the classification rather than being designed: `spec/`
holds one specification (`GEML-spec*`, with `in_geml_format/` holding its GEML
rendering), `spec/profiles/` the vocabularies, `spec/proposals/` the process.

## Conformance impact

Four cases in `geml-parser/test/conformance/vocabulary.json`, all using a
vocabulary name **nothing recognizes**, so the file is implementation-neutral:

| Case | Projection |
|---|---|
| a `profile` declaration does not change the document model | `block:acme-invoice` |
| the same document without the declaration | `block:acme-invoice` |
| a vocabulary a processor does not recognize admits nothing and breaks nothing | `block:acme-invoice` |
| several declared vocabularies are a space-separated list | `block:acme-invoice` |

Identical projections **are** the assertion: rule 4 says a declaration cannot
move the model, so the suite proves it by making the declaration invisible to
the projection.

The second implementation (`conformance/impl2.mjs`) implements no profile
mechanism at all and reproduces every case. That is the strongest available
evidence that rule 3 is honest — a processor recognizing zero vocabularies is
conformant, and here is one.

The projection grammar does not change.

## Alternatives considered

**Do nothing.** Leaves §8.2(7) unsatisfiable for any second implementation, and
leaves this project's own history files permanently warning about themselves.

**Infer the vocabulary** — treat a `.gemlhistory` extension, or the presence of
`history-of`, as a declaration. Rejected as rule 2: every such rule is a private
habit the conformance surface would then depend on. It is also the cheaper
option only until the second implementation exists.

**Reserve hyphenated names for extensions** and let a checker tell a deliberate
`acme-chart` from a mistyped `ntoe`, which today produce the identical
`unknown-block-type`. Rejected because it is rule 2 wearing a different hat:
reading a namespace out of a name's shape is still inference. §8.5's hyphen
SHOULD stays what it is — namespace reservation for future versions of this
specification, not a signal a processor may act on.

**Let a profile choose body mode**, so an admitted type could take a `flow`
body. Rejected for v1 and worth restating as the boundary of this proposal: it
would break rule 4, and with it the guarantee that the same bytes parse to the
same model on both sides of a document boundary. Anything needing GEML to read
inside its body belongs in §3's registry, through a GEP — which is exactly what
GEP 0008 does for `form`.

**Keep `GEML-history-spec` a companion specification** and give it a separate
profile document. Rejected: two documents maintaining one set of facts is how
they drift, and the second document existed only to say what the first already
implied.

## Compatibility & migration

No document that parsed before parses differently. The mechanism only removes
warnings, and only for documents that opt in by declaring.

- **Existing `.gemlhistory` files** keep working unchanged; they simply keep
  warning until the declaration is added. `geml history save` writes it, so a
  sidecar heals on its next save, and adding the one meta line by hand is
  equally valid — `geml history verify` reconstructs and re-hashes every
  revision either way (verified on all seven sidecars in this repository).
- **`codemap/v1` is renamed `geml-codemap/v1`**, so every published vocabulary
  name now begins `geml-`. Free at this moment and not later: the profile
  mechanism landed after 1.8.8 shipped and 1.9.0 is unpublished, so no released
  artifact declares the old name. A document declaring it gets no vocabulary
  and warns; the fix is the new name, or a rebuild for generated documents.
- **The specification license list shrinks.** `GEML-history-spec*` and its GEML
  renderings leave the CC-BY-4.0 enumeration in `spec/LICENSE-spec.md`, because
  an application layer is not the specification — the same reason
  `spec/proposals/` and the other two profiles were always MIT.
- **The history document's GEML renderings are removed** rather than moved. A
  profile document carries none: neither `geml-style` nor `geml-codemap` has
  one, and `spec/in_geml_format/` means *the specification, written in GEML*.

## Drawbacks & open questions

**A tier is a place to hide.** "Make it a profile" is now an available answer to
any awkward type, and the §8.6-rule-4 test is the only thing standing between
that and a core registry that never grows again. The test is mechanical, which
helps, but it is only as good as the honesty of the person applying it.

**~~`revision`, `keyframe` and `blob` violate §8.5's hyphen SHOULD.~~ Fixed.**
They were unhyphenated names this specification does not define, sitting in space
reserved for future versions of it. They are `history-revision`,
`history-keyframe` and `history-blob` now, and the old spelling is not read —
keeping a second spelling alive would have been the squatting.

This paragraph used to say the rename needed a compatibility period because it
was a migration over user data. It does not, and the reason is worth recording:
a revision's `hash` covers the SNAPSHOTTED DOCUMENT, not the sidecar's own fence
lines. Renaming the block types is therefore a pure text substitution that leaves
every hash in the chain valid — measured across this repository's five sidecars
and the 74 revisions in them, which verify identically before and after and
reconstruct byte-for-byte the same content. A cost assumed rather than measured
was the only thing holding this open.

**Two other spec edits landed in this same range without a GEP**: §3.1's fence
production (the whitespace after a `=` run became optional) and §3.1's
`TYPE-NAME` production (the block type stopped sharing the wider `NAME`). Both
carry conformance cases, and neither is in a proposal. Whether they should be
recorded retroactively, and how, is open.
