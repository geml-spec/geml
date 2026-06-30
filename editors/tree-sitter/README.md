# tree-sitter-geml (design brief — contributors wanted)

A tree-sitter grammar would unlock GEML syntax highlighting and structural
selection in **Neovim, Helix, and Zed** at once (they all consume tree-sitter +
`highlights.scm`, and parser authors self-register). It's a high-leverage,
self-serve distribution channel — and a great contribution. This is a brief, not
a finished grammar, because the core of GEML's block syntax is **context-
sensitive** in a way tree-sitter needs a hand-written external scanner for, and
shipping an unverified grammar that mis-highlights is worse than shipping none.

## The hard part: equal-length fences

A typed block opens on a run of `=` (length ≥ 3) and closes on a run of the
**same length**; a **longer** run nests a shorter one (GEML-spec §3):

```
==== outer
=== inner
body
===
====
```

tree-sitter's context-free grammar can't match "a close fence whose length equals
this open fence's length." This is exactly what tree-sitter's **external scanner**
(a small `src/scanner.c`) is for — the same mechanism Markdown's tree-sitter
grammar uses for fenced code and the same idea as Python's indent/dedent tokens.

The scanner must:
- on an open fence, **push** the run length onto a stack and emit a
  `block_open` token (capturing the type name + optional `{…}` attributes);
- emit a `block_close` token only when a line is a bare `=` run whose length
  **equals** the top of the stack, then **pop**;
- respect body mode: `code`/`diagram`/`math`/`table` bodies are **raw** (don't
  scan inline structure inside them); `note`/`aside` are flow; `meta` is data.

Everything else (ATX headings, lists by indentation, `%%` comment lines, the
attribute object, inline emphasis/code/math/`[[#id]]`/links/footnotes) is
ordinary grammar work and can follow the [spec](../../GEML-spec.md) and the
[conformance suite](../../geml-parser/test/conformance/).

## Suggested layout

```
grammar.js          # the grammar; externals: [$.block_open, $.block_close, …]
src/scanner.c       # the external scanner (fence run-length stack + body modes)
queries/highlights.scm
queries/injections.scm   # inject lang into code/diagram bodies by `lang=`/`format=`
test/corpus/        # tree-sitter test cases (can mirror geml-parser fixtures)
```

## Validate against the reference

The grammar is correct when it agrees with the reference parser on structure.
Reuse the conformance fixtures and the dogfood spec
([`GEML-spec.geml`](../../GEML-spec.geml)) as test inputs. See the
[parser-writing guide](../../docs/WRITING-A-PARSER.md) for the model and rules.

**Interested? Open an [implementation issue](https://github.com/geml-spec/geml-spec/issues/new?template=implementation.yml).**
We'll help and link it from the README.
