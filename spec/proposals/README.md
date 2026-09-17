# GEML Enhancement Proposals (GEPs)

A GEP is how a change to the **GEML specification** is proposed, discussed, and
recorded. Bug fixes and tooling changes do not need a GEP — just open a PR. A GEP
is for changes to the *format itself*: new block types, attribute semantics,
inline syntax, conformance rules. Not every new block type is one of those,
though — see the next section before writing one.

## Before you write one: is this a GEP, or a profile?

Not every new block type belongs in the specification. §8.6 lets a document
declare an **application-layer vocabulary** that admits type names and attribute
keys this specification does not define, and a vocabulary needs no GEP — it is a
document you write plus the names your own tools recognize.

The line is drawn by one mechanical question:

> **Does the change put an obligation on every conforming implementation?**

- **Yes** — write a GEP. A profile cannot carry a MUST, because §8.6 rule 3 says
  a processor that recognizes no vocabulary at all is still conformant, and
  anything a processor may legally ignore is not an obligation.
- **No** — a profile is enough, and a GEP would be overreach.

Worked case: [`0008-form-block.md`](0008-form-block.md) registers `form` for its
§8.3 clause — a conforming renderer MUST NOT submit a `form` block. That is an
obligation on every processor, including one that has never heard of forms, so
it cannot live in an application layer. (Until [GEP 0013](0013-prose-body-for-vocabularies.md)
the GEP also rested on a second argument, that only §3 could give `form` a body
its fields could be addressed in. A vocabulary may declare a body mode now, so
that argument is gone and the §8.3 clause is the whole of the case.)

**The older test is withdrawn.** It asked *does GEML have to read inside the
block's body?*, and it worked while §8.6 rule 4 forbade a vocabulary a body
mode. GEP 0013 lifted that, so the question no longer separates anything: a
vocabulary may hold flow content, child ids and resolvable references, provided
a processor that cannot read them says so.

What is left over when the mechanical test answers "no" is a judgment, and it
should be made as one: **is this construct the format's, or an application's?**
A construct every reader of GEML should be able to read belongs in §3; one that
serves a single application belongs in a vocabulary. That question has no crisp
edge, which is why a profile now carries its own status and its own document —
the governance that the mechanical test used to make unnecessary.

## The other direction: a profile growing into the specification

The test above asks where something should START. Most things start in a
vocabulary, and some of them should not stay there. The route out is deliberately
narrow, because "it has proved useful" is true of every vocabulary that anyone
kept using and cannot on its own be the bar.

A construct living in a profile belongs in a GEP when **either** holds:

- **A second, independent vocabulary needs the same thing.** One vocabulary
  wanting a shape is a use case; two wanting it is a gap in the format. `view`
  took this route out of `table` over about two months, and `prose` bodies took
  it out of `geml-media`.
- **It needs an obligation** — the mechanical test above, applied late rather
  than early. A construct that turns out to need a MUST on every conforming
  processor has outgrown a layer that a processor may legally ignore.

Neither is "the maintainer likes it", and neither is satisfied by a single
vocabulary's convenience. Until one of them holds, the construct stays where it
is and the use cases accumulate — which is the point: a registry entry is
permanent, and the evidence for one should be something other than enthusiasm.

Naming follows from the answer rather than deciding it. §8.5 reserves
unhyphenated names for future versions of this specification, so the core type
is spelled `form`, while the same idea at the application layer is spelled
`web-form` and admitted by (say) a `geml-web/v1` vocabulary.

## Process

1. **Open a discussion issue** using the *GEML Enhancement Proposal* issue form
   (it is labelled `gep`). Describe the change, the motivation, and the effect on
   the conformance suite.
2. **Discuss.** Non-trivial changes wait for feedback. The bar is the one in
   [`../../GOVERNANCE.md`](../../GOVERNANCE.md): the spec is defined by its conformance
   suite, so a change is only real once it has conformance cases.
3. **Write the GEP.** Copy [`0000-template.md`](0000-template.md) to
   `NNNN-short-title.md` (use the issue number for `NNNN`) and open a PR that
   adds it under `spec/proposals/`, together with:
   - the spec edit (`GEML-spec.md` / `_CN.md`), and
   - new or updated conformance cases (`geml-parser/test/conformance/`).
4. **Merge.** A GEP lands when the spec edit, the conformance cases, and the
   reference implementation agree, and `npm test` is green.

## States

`draft` → `accepted` → `final` (shipped in a spec version), or `withdrawn` /
`rejected` with a recorded reason. The GEP file's front matter records its state.

## Index

| GEP | Title | State |
|-----|-------|-------|
| [0001](0001-drop-aside.md) | Drop the `aside` block type | final |
| [0002](0002-code-graph-representation.md) | Representing a code dependency graph as GEML | accepted |
| [0003](0003-geml-code-graph-format.md) | The `geml-code-graph` diagram format | accepted |
| [0004](0004-text-block.md) | Register a `text` typed block — an addressable prose container | final |
| [0005](0005-data-block.md) | Register a `data` typed block — the value tree, with a scoped format registry | final |
| [0006](0006-declared-projections.md) | Declared projections — a document names the files derived from it | draft |
| [0007](0007-emphasis-across-atoms.md) | Emphasis may span an inline atom | final |
| [0008](0008-form-block.md) | Register a `form` typed block — addressable fields, an inert destination | draft |
| [0009](0009-application-layer-profiles.md) | The profile mechanism is how GEML is extended | final |
| [0010](0010-language-projections.md) | Projections along the language axis — a translated document is a view, not a copy | draft |
| [0011](0011-inner-unit-coordinates.md) | Coordinates for units inside a block — a table's rows and cells, a value tree in `data` or merged `meta` | final |
| [0012](0012-view-block.md) | Register a `view` typed block — selection, derivation and aggregation of another relation | final |
| [0013](0013-prose-body-for-vocabularies.md) | A vocabulary may declare a body mode; an unrecognized one is announced | accepted |
