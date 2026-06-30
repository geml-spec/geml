# GEML Enhancement Proposals (GEPs)

A GEP is how a change to the **GEML specification** is proposed, discussed, and
recorded. Bug fixes and tooling changes do not need a GEP — just open a PR. A GEP
is for changes to the *format itself*: new block types, attribute semantics,
inline syntax, conformance rules.

## Process

1. **Open a discussion issue** using the *GEML Enhancement Proposal* issue form
   (it is labelled `gep`). Describe the change, the motivation, and the effect on
   the conformance suite.
2. **Discuss.** Non-trivial changes wait for feedback. The bar is the one in
   [`../GOVERNANCE.md`](../GOVERNANCE.md): the spec is defined by its conformance
   suite, so a change is only real once it has conformance cases.
3. **Write the GEP.** Copy [`0000-template.md`](0000-template.md) to
   `NNNN-short-title.md` (use the issue number for `NNNN`) and open a PR that
   adds it under `proposals/`, together with:
   - the spec edit (`GEML-spec.md` / `_CN.md`), and
   - new or updated conformance cases (`geml-parser/test/conformance/`).
4. **Merge.** A GEP lands when the spec edit, the conformance cases, and the
   reference implementation agree, and `npm test` is green.

## States

`draft` → `accepted` → `final` (shipped in a spec version), or `withdrawn` /
`rejected` with a recorded reason. The GEP file's front matter records its state.

## Index

_(none yet — the format is at 1.0; this directory starts empty by design.)_
