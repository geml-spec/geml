# GEML conformance suite

Each case is `{ name, geml, want }`, where `want` is a **normalized projection**
of `parse(geml)` — a compact, deterministic serialization of the document model
(grammar in [`_project.mjs`](_project.mjs)). The suite is the **normative
reference** for the rules the prose spec states algorithmically: inline emphasis
(GEML-spec §5.3), list nesting (§2.1), metadata interpolation (§4), and the syntax
and model shape of transclusion (§3, §5.3). What a transclusion *expands to* is not
part of the document model, so that is pinned by the parser's own suites; what this
suite fixes is how the two forms parse and what they carry. A second, independent
GEML implementation **conforms** when it reproduces every `want`.

| File | Covers |
|------|--------|
| `inline.json` | emphasis / strong / strikethrough by delimiter-run flanking, the rule of three, escapes, intraword and nested cases |
| `precedence.json` | atom vs. emphasis order: code, math, links, images, footnotes, hard breaks, escapes |
| `lists.json` | ordered/unordered, `start`, indentation nesting, tight vs. loose, task markers |
| `interp.json` | `{{key}}` metadata interpolation: substitution in paragraphs/headings/list items, the verbatim-atom skips (code span, inline math), the `\{{key}}` escape, unknown keys kept literal |
| `transclusion.json` | the `embed` block and its target (a document, a fragment, a local id), and inline projection `![[…]]` in and out of a sentence |

Run via `npm test`. Two runners consume these cases: [`../conformance.test.mjs`](../conformance.test.mjs)
checks the reference parser, and [`../second-impl.test.mjs`](../second-impl.test.mjs)
checks a **second, independent implementation** ([`impl2.mjs`](impl2.mjs), written
only from the spec, importing none of the reference parser). Both reproducing
every `want` is the spec's acceptance test (§8).

Projection grammar, in brief:

```
text   "abc"          emphasis  em( … )        strong  strong( … )    strike  s( … )
code   code("…")      math      math("…")      break   br             image   img("src")
link   link("target" … )   auto-ref  ref("target")    footnote  fn("id")
embed  embed("target")     projection  project("target")
para   children, space-separated         heading  h<level>( … )
list   ul[…] | ol[…]   ( "*" = loose, "@N" = ordered start N )
item   li(…) | li[ ](…) | li[x](…)   with nested lists appended inside
```
