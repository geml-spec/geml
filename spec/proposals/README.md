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

The line between the two is mechanical, not a matter of taste. §8.6 rule 4:
admission licenses **names only** and MUST NOT change the document model, so a
profile-admitted type keeps the `raw` body §8.2(6) gives an unknown one.
So the question is:

> **Does GEML have to read inside the block's body?**

- **No** — the body is opaque to GEML and something else interprets it. A
  profile is enough, and a GEP would be overreach. `style-rule`, `style-screen`,
  `style-state` (geml-style) and `revision`, `keyframe`, `blob` (geml-history)
  are all of this kind.
- **Yes** — the body carries flow content, child ids, or references that §8.2(5)
  requires to resolve. **Only the specification can do this**, because only §3's
  registry assigns a body mode and §8.6 forbids a profile from changing it.
  Write a GEP.

Worked case: [`0008-form-block.md`](0008-form-block.md) registers `form` because
its fields are addressable — `[[#signup#email]]` has to resolve, and an
unresolved reference is an **error** (§8.2(5)). Admitted through a profile
instead, the body would stay raw, no field id would exist, and every such
reference would be an error: the feature the GEP exists for is precisely the one
a profile cannot deliver. The GEP is careful to show what the application layer
*can* already do — a `table {.form}` bound through a stylesheet — and where that
stops.

A second test, independent of the first: **does the change put an obligation on
conforming implementations?** GEP 0008 also adds a §8.3 clause — a conforming
renderer MUST NOT submit a `form` block. That cannot live in a profile, because
§8.6 rule 3 says a processor that recognizes no vocabulary at all is still
conformant. Anything a processor may legally ignore cannot carry a MUST.

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
| [0009](0009-application-layer-profiles.md) | The profile mechanism is how GEML is extended | draft |
