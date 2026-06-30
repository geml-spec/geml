# Write a GEML parser in your language

This is the single highest-impact contribution you can make to GEML.

A format becomes a *standard* — rather than one person's project — when **more
than one person, in more than one language, implements it from the spec and they
agree.** That agreement is also the only real proof the spec is unambiguous. GEML
ships with the machinery to make this a weekend project and to let you
**self-certify**: a normative conformance suite of input→output cases, plus a
dogfood document that exercises the whole format.

If you build one — Python, Rust, Go, Zig, anything — **open an issue**. We will
link it prominently and help you get the suite green. You don't need permission
and you don't need to finish everything at once.

## What "conformant" means

Your parser takes GEML source and produces a **document model** (a tree of
blocks and inline nodes). You are conformant when:

1. For every case in the conformance suite, your model — run through the
   **projection** below — reproduces the expected string exactly; and
2. The dogfood spec [`GEML-spec.geml`](../GEML-spec.geml) parses with **zero
   `error` diagnostics** (this exercises fences, attributes, references, tables,
   charts, and metadata end to end); and
3. Build-time reference checks hold (§8): every `#id` is unique, and every
   reference (`[[#id]]`, `[text](#id)`, `[^id]`, chart `data=#id`, `output of=#id`)
   resolves, else it is an `error`.

(1) pins the genuinely *algorithmic*, ambiguity-prone rules — inline emphasis and
list nesting — where prose specs historically drift (this is the lesson of
CommonMark vs. the original Markdown). (2) and (3) cover the rest of the format,
which is specified concretely enough in prose that the dogfood is a sufficient
acceptance test.

## The conformance suite

Plain JSON, no JavaScript required — copy the files into your project and run
them with your own test harness. They live in
[`geml-parser/test/conformance/`](../geml-parser/test/conformance/):

| File | Covers |
|------|--------|
| `inline.json` | emphasis / strong / strikethrough by delimiter-run flanking, the rule of three, escapes, intraword and nested cases |
| `precedence.json` | atom vs. emphasis order: code, math, links, images, footnotes, hard breaks, escapes |
| `lists.json` | ordered/unordered, `start`, indentation nesting, tight vs. loose, task markers |

Each case is:

```json
{ "name": "em inside strong", "geml": "**a *b* c**", "want": "strong(\"a \" em(\"b\") \" c\")" }
```

`want` is the **projection** of `parse(geml)` — a compact, deterministic
serialization of the model. To compare, write a small function that turns *your*
model into the same string, then assert it equals `want`.

### The projection contract

Reproduce this exactly (it is the comparison format, not part of GEML itself):

```
text           -> a JSON-quoted string            "abc"
emphasis        -> em( … )
strong          -> strong( … )
strikethrough   -> s( … )
code span       -> code("…")          (value JSON-quoted)
inline math     -> math("…")
hard break      -> br
image           -> img("src")
link            -> link("target" children…)   target = href | #anchor | doc#anchor
auto-reference  -> ref("target")               target = #anchor | doc#anchor
footnote ref    -> fn("id")
paragraph       -> its children, space-separated
heading level N -> hN( children… )
list            -> ul[…]  |  ol[…]    suffix "*" if loose, "@N" if ordered start ≠ 1
list item       -> li(…) | li[ ](…) | li[x](…)   nested lists appended inside, space-separated
```

Children inside a container are joined with a single space. A reference
implementation of the projection is
[`_project.mjs`](../geml-parser/test/conformance/_project.mjs) — read it as the
tiebreaker if any wording above is unclear.

A complete, independent reference projection-plus-parser written **only from the
spec** (it imports none of the reference parser) is
[`impl2.mjs`](../geml-parser/test/conformance/impl2.mjs) — a worked example of
exactly what you're building (a few hundred lines).

## Suggested build order

Each step maps to a spec section and the tests that exercise it. Implement and
self-certify incrementally.

1. **Fences & the block scanner** (§2–§3): a run of `=` (≥3) opens a typed block;
   the close is an *equal-length* run; a longer fence nests a shorter one. ATX
   headings (`#`…`######`), lists, paragraphs, the `%%` hidden line. → dogfood.
2. **The attribute object** `{#id .class key=val}` (§4): value typing (quoted =
   string, `true`/`false` = bool, number syntax = number, bare word = string, a
   bare word with no `=` = boolean flag). → dogfood.
3. **`meta` (data body) + `{{key}}` interpolation** (§3–§4). → dogfood.
4. **Inline** (§5): emphasis/strong/strike by delimiter-run flanking and the rule
   of three; code, math, links, auto-refs, footnotes, images, hard breaks,
   escapes. → `inline.json`, `precedence.json`. This is the hard part; lean on
   the fixtures.
5. **Lists** (§2.1): ordered/unordered, `start`, indentation nesting, tight vs.
   loose, `[ ]`/`[x]` task markers. → `lists.json`.
6. **References & build-time checks** (§8): collect ids, resolve every reference,
   emit `error` diagnostics for duplicates and dangling refs. → dogfood + your
   own cases.
7. **Tables** (§6): the visual pipe grid and the `format=csv`/`tsv` data form
   parse to the *same* model; computed columns (`compute=`) and the summary row
   (`summary=`). → dogfood.
8. **Diagrams & charts** (§7): a `diagram` body is never interpreted (host DSL);
   `format=geml-chart data=#id` charts a table by reference, with the column refs
   checked. → dogfood.

Steps 1–5 already make a useful parser. 6 is what makes GEML *GEML*. 7–8 are the
structured-content payoff.

## Self-certify

Pseudo-code — adapt to your test framework:

```
for file in [inline.json, precedence.json, lists.json]:
    for case in load(file):
        got = project(parse(case.geml))
        assert got == case.want,  f"{case.name}: want {case.want}, got {got}"

doc = parse(read("GEML-spec.geml"))
assert no diagnostic in doc.diagnostics has severity == "error"
```

When the suite is green and the dogfood parses clean, you have an independent,
conformant GEML implementation — and GEML has its second one. Open an issue or PR
(see [`CONTRIBUTING.md`](../CONTRIBUTING.md)); we'll add it to the README.

## Reference

- Normative spec: [`GEML-spec.md`](../GEML-spec.md) (§1–§8), history extension
  [`GEML-history-spec.md`](../GEML-history-spec.md).
- The spec, written in GEML: [`GEML-spec.geml`](../GEML-spec.geml) (your end-to-end
  acceptance test).
- Reference implementation (TypeScript): [`geml-parser/`](../geml-parser/) — a
  guide, not the definition; the spec is.
