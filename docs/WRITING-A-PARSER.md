# Write a GEML parser in your language

The highest-impact thing you can do for GEML: implement it from the spec in another language. Two independent parsers that agree are the proof the spec is unambiguous — and what makes GEML a standard, not one repo.

It's a weekend project, and you can self-certify: reproduce a set of JSON conformance cases, then parse the spec's own `.geml` file cleanly. Building one? **Open an [implementation issue](https://github.com/geml-spec/geml-spec/issues/new?template=implementation.yml)** — we'll help and link it. No need to finish it all at once.

## Conformant means three things

Your parser turns GEML source into a **document model** (blocks and inline nodes). It's conformant when:

1. It reproduces every case in the conformance suite (below).
2. It parses the dogfood spec [`GEML-spec.geml`](../GEML-spec.geml) with **zero `error` diagnostics** — that exercises fences, attributes, references, tables, charts, and metadata.
3. References resolve (§8): every `#id` is unique, and every `[[#id]]`, `[text](#id)`, `[^id]`, chart `data=#id`, and `output of=#id` points at something real.

The suite pins the ambiguous parts (inline emphasis, list nesting); the dogfood covers the rest.

## The conformance suite

Plain JSON — copy it in and run it with your own harness. In [`geml-parser/test/conformance/`](../geml-parser/test/conformance/):

| File | Covers |
|------|--------|
| `inline.json` | emphasis / strong / strikethrough, the rule of three, escapes, nesting |
| `precedence.json` | atom vs. emphasis order: code, math, links, images, footnotes, breaks |
| `lists.json` | ordered/unordered, `start`, indentation nesting, tight vs. loose, task markers |

Each case is `{ name, geml, want }`:

```json
{ "name": "em inside strong", "geml": "**a *b* c**", "want": "strong(\"a \" em(\"b\") \" c\")" }
```

`want` is a **projection** of the parsed model — a compact string. Project *your* model the same way and assert it equals `want`.

### Projection format

```
text            "abc"                       (JSON-quoted)
emphasis        em( … )
strong          strong( … )
strikethrough   s( … )
code span       code("…")
inline math     math("…")
hard break      br
image           img("src")
link            link("target" children…)    target = href | #anchor | doc#anchor
auto-reference  ref("target")
footnote ref    fn("id")
paragraph       children, space-separated
heading level N hN( children… )
list            ul[…] | ol[…]   suffix "*" if loose, "@N" if ordered start ≠ 1
list item       li(…) | li[ ](…) | li[x](…)   nested lists appended inside
```

Children join with one space. [`_project.mjs`](../geml-parser/test/conformance/_project.mjs) is the reference projection — the tiebreaker if anything is unclear. [`impl2.mjs`](../geml-parser/test/conformance/impl2.mjs) is a full parser + projection written only from the spec (a few hundred lines) — a worked example of what you're building.

## Build order

Each step maps to a spec section and what tests it. Do them incrementally.

1. **Fences + block scanner** (§2–§3) — a `=`-run opens a block, an equal-length run closes it, a longer fence nests; ATX headings, lists, paragraphs, `%%` lines. → dogfood
2. **Attribute object** `{#id .class key=val}` (§4) — value typing; a bare word with no `=` is a boolean flag. → dogfood
3. **`meta` + `{{key}}` interpolation** (§3–§4). → dogfood
4. **Inline** (§5) — emphasis/strong/strike (rule of three), code, math, links, auto-refs, footnotes, images, breaks, escapes. **The hard part; lean on the fixtures.** → `inline.json`, `precedence.json`
5. **Lists** (§2.1) — ordering, `start`, nesting, tight/loose, `[ ]`/`[x]`. → `lists.json`
6. **References + checks** (§8) — collect ids, resolve refs, error on duplicates and dangling. → dogfood
7. **Tables** (§6) — pipe grid and `format=csv`/`tsv` parse to one model; `compute=`, `summary=`. → dogfood
8. **Diagrams & charts** (§7) — diagram bodies are never interpreted; `geml-chart data=#id` charts a table by reference. → dogfood

Steps 1–5 give a useful parser. 6 is what makes GEML *GEML*. 7–8 are the payoff.

## Self-certify

```
for file in [inline.json, precedence.json, lists.json]:
    for case in load(file):
        assert project(parse(case.geml)) == case.want

doc = parse(read("GEML-spec.geml"))
assert no "error" diagnostic in doc.diagnostics
```

Suite green + dogfood clean = an independent, conformant GEML parser. Open an issue or PR ([`CONTRIBUTING.md`](../CONTRIBUTING.md)) and we'll add it to the README.

## Reference

- Spec: [`GEML-spec.md`](../GEML-spec.md) (§1–§8) + [`GEML-history-spec.md`](../GEML-history-spec.md).
- [`GEML-spec.geml`](../GEML-spec.geml) — the spec in GEML; your end-to-end test.
- [`geml-parser/`](../geml-parser/) — the reference implementation (a guide; the spec is the definition).
