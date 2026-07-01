# Governance

GEML is young, and for now it has a single lead maintainer — its original author.
At this stage one maintainer is the most practical way to move the specification
forward, but it is a starting point, not the intended end state. The project is
committed to **neutral, multi-party governance**, and — as adoption grows — to
placing the specification under an independent standards body.

The sections below set out how decisions are made, how the spec is kept
independent of any single implementation, and how stewardship is meant to broaden
over time, so that depending on GEML need not mean depending on one person.

## How decisions are made

- **Spec changes** go through a **GEML Enhancement Proposal (GEP)**: open an
  issue labelled `gep` describing the change, the motivation, examples, and the
  effect on the conformance suite. Non-trivial changes wait for discussion.
- **The conformance suite is the contract.** A spec change is not real until it
  has a conformance case (`geml-parser/test/conformance/`); an implementation is
  not conformant until it passes the suite. This is the mechanism that keeps
  independent implementations from drifting — not anyone's say-so.
- **Bug fixes and tooling** are ordinary pull requests.

## Neutrality: spec vs. implementation

- The **specification** (`GEML-spec*.md`, `GEML-history-spec*.md`) is licensed
  CC-BY-4.0 and is independent of any single implementation. Anyone may build a
  conformant parser without permission.
- The **reference implementation** (`geml-parser/`, `geml-viewer/`) is MIT. It
  is the *first* conformant implementation, not the definition of GEML.

## Succession & growth

- The single-maintainer model is explicitly **transitional**. As active
  maintainers join — target: **three or more, from more than one party** —
  decisions move to a small committee governed by a public, written process, and
  this document is updated to match. Longer term, stewardship of the
  specification may pass to an independent standards body.
- Because the spec is CC-BY-4.0 and the conformance suite is language-agnostic,
  the format has **no single point of failure**: if the maintainer steps away,
  anyone can continue it from the spec and the tests.

## Versioning

The spec is versioned independently of the reference implementation. Breaking
spec changes bump the spec version and ship with updated conformance cases.
