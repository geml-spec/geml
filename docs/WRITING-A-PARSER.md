# Write a GEML parser in your language

*English | [中文](WRITING-A-PARSER_CN.md)*

The highest-impact thing you can do for GEML: implement it from the spec in another language. Two independent parsers that agree are the proof the spec is unambiguous — and what makes GEML a standard, not one repo.

It's a weekend project, and you can self-certify: reproduce a set of JSON conformance cases, then parse the spec's own `.geml` file cleanly. Building one? **Open an [implementation issue](https://github.com/geml-spec/geml/issues/new?template=implementation.yml)** — we'll help and link it. No need to finish it all at once.

## Conformant means five things

Your parser turns GEML source into a **document model** (blocks and inline nodes). It's a conforming *parser* (§8.2) when:

1. It reproduces every case in the conformance suite (below).
2. It parses the dogfood spec [`GEML-spec.geml`](../spec/in_geml_format/GEML-spec.geml) with **zero `error` diagnostics** — that exercises fences, attributes, references, tables, charts, and metadata.
3. References resolve (§8): every `#id` is unique, and every `[[#id]]`, `[[doc.geml#id]]`, `[text](#id)`, `[^id]`, a table's or chart's `src=`/`data=`, and an `embed`'s `src=` points at something real.
4. It normalizes its input exactly as **§0.5** says: UTF-8, strip one leading BOM, line endings → LF, `U+0000` → `U+FFFD`. Four lines of code, and skipping them is the most common way a second implementation silently disagrees with the reference on real-world files.
5. Every diagnostic carries the **code and severity** from [Appendix A](../spec/GEML-spec.md#appendix-a-diagnostic-catalogue). The message text is yours to word (or translate); the code is the contract, and it's what makes your error paths testable against ours.

The suite pins what the spec states algorithmically — inline emphasis, list nesting, ids, block structure, normalization, tables, views and the value tree; the dogfood covers the rest.

Two things you also owe an untrusted document, per §9: **bound your recursion depth** (block, list, and inline nesting — emit the `*-nesting-too-deep` error and keep going, never blow the stack), and **neutralize non-`http`/`https`/`mailto`/`tel` URL schemes when you build the model**, not at the rendering sink.

The bounds the spec fixes — how far a chain is followed, how deep a value tree nests, how many cells a table holds — are in §9.2's table of fixed bounds, the one place their values are written. Take them from there; the suite's cases on their edges carry a `bound` field and fail if you miss one. The nesting bounds are yours to choose, at least the table's `nesting-floor`: the reference parser admits 256 levels of block and list nesting and 100 of inline nesting (`geml-parser/src/bounds.ts`). So is the bound §9.2 asks for on the cells one document reads from elsewhere — every view copies its source, so twenty views of a million-cell table are twenty million cells: the reference stops at 4,000,000.

## The conformance suite

Plain JSON — copy it in and run it with your own harness. In [`geml-parser/test/conformance/`](../geml-parser/test/conformance/), [`manifest.json`](../geml-parser/test/conformance/manifest.json) lists every case file and the capabilities it needs — tables, block ids, the block tree, diagnostics, … — so run the files your parser's capabilities reach. The [README](../geml-parser/test/conformance/README.md) says what each file covers and defines the projection.

Each case is `{ name, geml, want }`:

```json
{ "name": "em inside strong", "geml": "**a *b* c**", "want": "strong(\"a \" em(\"b\") \" c\")" }
```

`want` is a **projection** of the parsed model — a compact string. Project *your* model the same way and assert it equals `want`. A case may also carry `ids`, `addresses`, `blocks` or `diagnostics`, or give its input as bytes (`geml_base64`): check the ones your capabilities cover.

[`_project.mjs`](../geml-parser/test/conformance/_project.mjs) is the reference projection — what the `want` strings are written in. What a document *means* is the specification's: every case is derived from its text, and where a case and the text disagree, the text decides. [`impl2.mjs`](../geml-parser/test/conformance/impl2.mjs) is a full parser + projection written only from the spec (a few hundred lines) — a worked example of what you're building.

## Build order

Each step maps to a spec section and what tests it. Do them incrementally.

0. **Normalize the input** (§0.5) — decode UTF-8, strip one leading BOM, collapse CRLF/CR to LF, replace `U+0000`. Do this first and everything downstream gets simpler; every step preserves the line count, so you can still index the original bytes by line. → `normalize.json`
1. **Fences + block scanner** (§2–§3) — a `=`-run opens a block, an equal-length run closes it, a longer fence nests; ATX headings, lists, paragraphs, `%%` lines. → `fences.json`, `blocks.json`, dogfood
2. **Attribute object** `{#id .class key=val}` (§4) — where an object begins and ends (to a fence line's last `}`; a heading's trailing group), items split on White_Space outside quoted spans, value typing; a bare word with no `=` is a boolean flag. → `blocks.json`, dogfood
3. **`meta` + `{{key}}` interpolation** (§3–§4) — substitute in flow source text, skipping the verbatim atoms (code spans, inline math) and escaped `\{{key}}`. → `interp.json`
4. **Inline** (§5) — emphasis/strong/strike (rule of three), code, math, links, auto-refs, footnotes, images, breaks, escapes. **The hard part; lean on the fixtures.** → `inline.json`, `precedence.json`
5. **Lists** (§2.1) — ordering, `start`, nesting, tight/loose, `[ ]`/`[x]`. → `lists.json`
6. **References + checks** (§8) — collect ids, resolve refs, error on duplicates and dangling. → `ids.json`, `addresses.json`, dogfood
7. **Tables and views** (§6, §6.1) — pipe grid and `format=csv`/`tsv` parse to one model, which holds facts; a `view` derives from one with `compute=`, `summary=`, `where=`, `order=`, `limit=`, `select=`, `by=`/`aggregate=`. → `coordinates.json`, `views.json`, dogfood
8. **Diagrams & charts** (§7) — diagram bodies are never interpreted; `geml-chart data=#id` charts a table by reference. → dogfood
9. **Documents through a host** (§3.3, §5.2, §9.3, §9.4) — references into other documents one level deep, the resolution root, data files and routes read when the document is, transclusion chains. → `documents.json`, whose cases give a file tree (`files`) and the document to read (`main`)

Step 0 plus 1–5 give a useful parser. 6 is what makes GEML *GEML*. 7–8 are the payoff.

## Self-certify

```
for entry in load("manifest.json").files:
    if not entry.requires ⊆ your_capabilities: continue
    for case in load(entry.file):
        doc = parse_in(case.files, case.main) if case.files else parse(case.geml or decode(base64(case.geml_base64)))
        assert project(doc) == case.want
        # and ids / addresses / blocks / diagnostics, where you have them

doc = parse(read("spec/in_geml_format/GEML-spec.geml"))
assert no "error" diagnostic in doc.diagnostics

# §0.5 — the same document, four ways, must give the same model
base = "# T\n\n- a\n- b\n"
assert parse(base) == parse("﻿" + base) == parse(base.replace("\n", "\r\n"))

# Appendix A — every code you emit is in the catalogue, at its declared severity
for d in parse(read("spec/in_geml_format/GEML-spec.geml")).diagnostics + your_error_fixtures():
    assert d.code in APPENDIX_A and d.severity == APPENDIX_A[d.code]
```

Suite green + dogfood clean + §0.5 + Appendix A = an independent, conformant GEML parser. Open an issue or PR ([`CONTRIBUTING.md`](../CONTRIBUTING.md)) and we'll add it to the README.

## Reference

- Spec: [`GEML-spec.md`](../spec/GEML-spec.md) (§0–§9 + Appendices A/B) + [`GEML-history-spec.md`](../spec/profiles/geml-history/geml-history-profile.md).
- [`GEML-spec.geml`](../spec/in_geml_format/GEML-spec.geml) — the spec in GEML; your end-to-end test.
- [`geml-parser/`](../geml-parser/) — the reference implementation (a guide; the spec is the definition).
