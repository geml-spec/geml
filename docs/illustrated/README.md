# GEML, illustrated

*English | [中文](README_CN.md)*

One page per block type, per profile, and for the CLI. Each page opens with a
**decision board** — one row per rule: the rule, its source, its status — then
one figure per situation (GEML on the left; on the right what the processor
actually does: `geml check` diagnostics, `geml list` addresses, `--to html`
markup), and closes with **evidence**: the probe files and their measured output.

Four statuses: **Specified** (written into the specification or an accepted
GEP), **GEP draft** (defined by a proposal, possibly implemented, not yet in the
spec), **Observed** (not specified; what the reference implementation does
today), and **Implementation gap** (the spec says one thing, the implementation
does another — the fix list is read from here). A fifth, **Draft gap**, marks
something a draft should say and does not.

The pages are self-contained HTML in two languages (`X.html` English,
`X_CN.html` 中文), opened directly in a browser; each is also published as a
claude.ai artifact for reading on a phone.

## Block types

| # | Covers | English | 中文 | Status |
|---|---|---|---|---|
| 1 | shared fence and attribute rules · `meta` · `math` · `note` · `text` | [01-simple-blocks.html](01-simple-blocks.html) | [_CN](01-simple-blocks_CN.html) | written; measured on geml 1.9.2, local build |
| 2 | `code` · `data`, one `src=` route syntax | [02-code-data.html](02-code-data.html) | [_CN](02-code-data_CN.html) | written |
| 3 | `table`, and GEP-0012's `view` | [03-table-view.html](03-table-view.html) | [_CN](03-table-view_CN.html) | written |
| 4 | `diagram`: external DSLs, `geml-chart`, `geml-code-graph` | [04-diagram.html](04-diagram.html) | [_CN](04-diagram_CN.html) | written |
| 5 | `embed`: block and inline projection, translation | [05-embed.html](05-embed.html) | [_CN](05-embed_CN.html) | written |

## The form proposal, the CLI, and the profiles

| # | Covers | English | 中文 | Status |
|---|---|---|---|---|
| 6 | `form` and the `form-*` family (GEP-0008, draft) with the `geml-form/v1` profile | [06-form.html](06-form.html) | [_CN](06-form_CN.html) | written (the 15 settled review decisions) |
| 7 | the `geml` CLI: every verb, its addresses and exit codes | [07-cli.html](07-cli.html) | [_CN](07-cli_CN.html) | written; every verb run against one probe document |
| 8 | `geml-history/v1` and `.gemlhistory` | [08-profile-history.html](08-profile-history.html) | [_CN](08-profile-history_CN.html) | written; real sidecar from a save/set/save round |
| 9 | `geml-codemap/v1` | [09-profile-codemap.html](09-profile-codemap.html) | [_CN](09-profile-codemap_CN.html) | written; playground/codemap verify 35/35 |
| 10 | `geml-style/v1` | [10-profile-style.html](10-profile-style.html) | [_CN](10-profile-style_CN.html) | written; clean + broken sheet, 10 of 12 diagnostics exercised |
| 11 | `geml-translator/v1` (GEP-0010) | [11-profile-translator.html](11-profile-translator.html) | [_CN](11-profile-translator_CN.html) | written; one doc gap (below) |

## Implementation gaps found so far

| Page · board | Spec | geml 1.9.2 actually |
|---|---|---|
| 1 · 11 | with two or more `meta` blocks, another block declaring `{#meta}` is a `reserved-id` error (§4, A.2) | passes with no diagnostic |
| 1 · 19 | `![[#id]]` on a multi-paragraph `text` is an `inline-transclusion-not-inline` error (§5.2) | reports that error, plus a spurious `transclusion-cycle` |

## Draft gaps found so far

| Page · board | Draft | Gap |
|---|---|---|
| 3 · 18, 4 · 15 | GEP-0012 (`view`) | never mentions charts; once compute moves to view, `geml-chart`'s `data=` needs to accept a view or a chart over a computed column has no source |
| 5 · inline | GEP-0011 (coordinates) | says a coordinate through an embed should "name the address that does work"; the measured message explains why but gives no address |
| 3 · 18 (follow-up) | GEP-0012 (`view`) | `src=` admits only a csv/tsv file, a table or another view; a record-array `data` block, a `.json`/`.jsonl` file (both already relations under §7.1 for charts) and a GEP-0011 coordinate into a value tree (`#cfg["items"]`) are not mentioned. Needs a normalization rule (keys → columns in first-seen order, missing key and `null` → empty cell, non-scalar → `data-not-records`) so a chart or a second view over such a view cannot tell what the source was |

## Documentation gaps found so far

| Page · board | Should exist | Actually |
|---|---|---|
| 11 · 10 | a `spec/profiles/geml-translator/` profile document and an index row in `spec/profiles/README.md`, since the profile is registered in `profiles.ts` | only the registration and the GEP-0010 text; the README's "index and registry are the same table said twice" no longer holds |

Fix one, and flip the status on the corresponding row.
