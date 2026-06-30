# Governance

GEML is young and currently led by its original author as **BDFL** (benevolent
dictator for life) — the fastest workable model at this size. This document
states that openly, along with the path off it, so the project's neutrality and
succession are not a mystery to anyone deciding whether to depend on GEML.

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

- The BDFL model is explicitly **temporary**. Once there are multiple active
  maintainers — target: **three or more, from more than one party** — decisions
  move to a small committee with a public, written process, and this document is
  updated to match.
- Because the spec is CC-BY-4.0 and the conformance suite is language-agnostic,
  the format itself has **no single point of failure**: if the author steps away,
  anyone can continue it from the spec and the tests.

## Versioning

The spec is versioned independently of the reference implementation. Breaking
spec changes bump the spec version and ship with updated conformance cases.
