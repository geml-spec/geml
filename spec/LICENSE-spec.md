# Specification license — CC-BY-4.0

The GEML **specification documents** are licensed under the Creative Commons
Attribution 4.0 International License (`CC-BY-4.0`), so anyone may read, share,
adapt, and **build a conformant implementation** of GEML, for any purpose,
including commercially — with attribution.

This deliberately differs from the MIT license on the code (see
[`LICENSE`](../LICENSE)): a specification is not software. Separating the two makes
explicit that GEML is defined by its spec, not by any single implementation, and
that an independent implementation is welcome and unencumbered.

## Documents covered

- `GEML-spec.md`, `GEML-spec_CN.md`
- `in_geml_format/GEML-spec.geml`, `in_geml_format/GEML-spec_CN.geml` (the
  specification, written in GEML — and their `.gemlhistory` sidecars)

The list is **one** specification and the GEML rendering of it. Everything else
— the profiles under `spec/profiles/`, the GEPs under `spec/proposals/`, all of
`docs/` — is commentary, process or an application layer, and travels with the
code license.

## Not covered

Everything else in the repository is MIT (see [`LICENSE`](../LICENSE)) — the
profiles in `profiles/`, the GEPs in `proposals/`, everything under `docs/`, and
the reference implementation. Those are application layers, process, commentary
and code, not the specification. The list above is exhaustive: if a file is not
on it, it is MIT.

Two entries have left this list, and both left for the same reason — being
*about* the specification, or *on top of* it, is not being it.

`docs/comparisons/COMPARISON*` made one directory carry two licenses: the
`GEML-vs-*` walkthroughs beside it were already MIT, and so were
`COMPARISON*.gemlhistory`, while `COMPARISON*.geml` was not.

`GEML-history-spec*` was a companion specification until it became the
`geml-history/v1` profile ([`profiles/geml-history/`](profiles/geml-history/geml-history-profile.md)).
It defines a versioning layer that rides entirely on GEML's existing grammar and
that a conformant GEML processor may know nothing about — an application layer,
peer to `geml-style/v1` and `geml-codemap/v1`, which were always MIT.

## License text

SPDX-License-Identifier: `CC-BY-4.0`

Full legal code: <https://creativecommons.org/licenses/by/4.0/legalcode>
Human-readable summary: <https://creativecommons.org/licenses/by/4.0/>

Attribution: "GEML — General Expressive Markup Language" with a link to this
repository satisfies the attribution requirement.
