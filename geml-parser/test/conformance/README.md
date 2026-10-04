# GEML conformance suite

Each case is `{ name, geml, want }`, where `want` is a **normalized projection**
of `parse(geml)` — a compact, deterministic serialization of the document model
(grammar in [`_project.mjs`](_project.mjs)). The [specification](../../../spec/GEML-spec.md)
is where the rules live; every case is a check derived from its text, and adds no
rule of its own. A case whose expected output the text does not determine is a gap
in the specification, fixed there first; where a case and the text disagree, the
text decides and the case is wrong. What the specification leaves to the implementation (§9.2's bounds on block, list and inline nesting, the work a
processor spends on §9.3's chains) is kept out of the cases. The bounds §9.2 fixes are in them, made from its
table — see [Boundary cases](#boundary-cases). A second, independent GEML implementation
**conforms** when it reproduces every case its capabilities reach.

A case may also carry the fields below, and may give its input as `geml_base64` —
bytes, for §0.1's decoding — instead of `geml`. [`manifest.json`](manifest.json)
lists every case file with the capabilities it needs, and the capability each
field needs; a harness runs what its implementation's capabilities reach.
[`_runner.mjs`](_runner.mjs) is the reference harness.

| Field | Holds |
|---|---|
| `ids` | the document's block ids, declared and derived, in document order |
| `addresses` | the `#…` addresses a listing of the document gives, in order: block and heading ids, §4 prose addresses, `#meta` |
| `blocks` | the block tree — the grammar is below |
| `diagnostics` | the `code:severity` of each diagnostic Appendix A catalogues, compared as a multiset |
| `bound` | the name of the §9.2 fixed bound the case sits on; it is compared with nothing, and marks a case [`_bounds.mjs`](_bounds.mjs) makes |

A case in a file that needs `host` gives, instead of `geml`, a directory tree:
`files` maps root-relative paths to their content, and `main` names the document
to parse. The tree's root is the resolution root. The document is read with a host
that confines every read to the tree (§9.4) and resolves each relative path a
document names against that document's directory first and the root second (§3.3);
a path that leaves the tree reads nothing.

| File | Covers |
|------|--------|
| `inline.json` | emphasis / strong / strikethrough by delimiter-run flanking, the rule of three, escapes, intraword and nested cases |
| `precedence.json` | atom vs. emphasis order: code, math, links, images, footnotes, hard breaks, escapes |
| `lists.json` | ordered/unordered, `start`, indentation nesting, tight vs. loose, task markers |
| `interp.json` | `{{key}}` metadata interpolation: substitution in paragraphs/headings/list items, the verbatim-atom skips (code span, inline math), the `\{{key}}` escape, unknown keys kept literal |
| `transclusion.json` | the `embed` block and its target (a document, a fragment, a local id), and inline projection `![[…]]` in and out of a sentence |
| `safety.json` | the URL-scheme rule of [GEML-spec §9](../../../spec/GEML-spec.md#9-security-and-resource-limits): which destinations are neutralized in the MODEL, and — just as important — which must survive |
| `data.json` | the `data` block's value tree (§3.2): `json` and `jsonl` parsed and projected, the bodies that carry no value, and the value tree's limits — a repeated name, a lone surrogate, a number past binary64, a container past `data-depth` |
| `fences.json` | typed-block fences (§3): glued and spaced spellings, labeled closes, what is not a type name, the ` ``` ` shield |
| `vocabulary.json` | a `profile` declaration does not change the document model (§8.6) |
| `coordinates.json` | coordinate references (§5.2): rows, cells, columns, `[summary]`, `#meta`, value trees, header-less letters, out-of-range; a table's row width (§6) |
| `views.json` | the `view` block (§6.1): `where=`, `order=`, `limit=`, `select=`, `compute=`, `summary=`, `by=` / `aggregate=`; and the edges of `table-cells` (§6) and of a view chain's `chain-depth` (§9.3) |
| `ids.json` | heading-id derivation (§4): code spans, diacritics, Unicode letters, numbers and whitespace, collisions |
| `normalize.json` | §0.5: one leading U+FEFF removed, every line ending one U+000A, U+0000 and ill-formed UTF-8 as U+FFFD |
| `blocks.json` | the block tree (§3, §4): nesting by fence length, raw vs. flow bodies, labeled and unterminated closes, `%%` lines, attribute typing and escapes |
| `addresses.json` | what a listing gives (§4): `P-between-N`, `C-before-N`, `C-after-P`, what has none, a declared id shadowing a derived one, `#meta`, a repeated id, a heading with no id |
| `yaml.json` | the subset a `yaml` engine must read (§3.2), and what lies outside it |
| `documents.json` | what a document reads through a host: references into other documents one level deep (§5.2, §9.3), confinement (§9.4), the resolution root (§3.3), data files read at build time (§6, §6.1) and remote ones deferred (§3.3), `code` and `data` routes (§3.2, §3.3), and transclusion chains across documents (§9.3) |

Run via `npm test`. Two runners consume these cases: [`../conformance.test.mjs`](../conformance.test.mjs)
checks the reference parser, and [`../second-impl.test.mjs`](../second-impl.test.mjs)
checks a **second, independent implementation** ([`impl2.mjs`](impl2.mjs), written
only from the spec, importing none of the reference parser). impl2 builds the
projection and nothing else, so it declares no capability: it skips the files
that need one, and the `geml_base64` cases. Both reproducing every `want` is the
spec's acceptance test (§8).

A third, in another language, reads the same manifest:
[`geml-parser-rs/`](../../../geml-parser-rs/), a Rust implementation written from
the spec and this suite alone. It declares every capability, and runs the suite
natively and as WebAssembly through `_runner.mjs`, so its model is read by
`_project.mjs` itself.

## Boundary cases

The cases with a `bound` stand on the edges of §9.2's fixed bounds, and
[`_bounds.mjs`](_bounds.mjs) makes them from the specification's table of those
bounds: `data-depth` on both sides of its edge in `json`, `jsonl` and `yaml`,
`table-cells` one column past it, and `chain-depth` on both sides of a `view`
chain's edge. It makes the profiles' boundary cases the same way: geml-media's
from its own table, and geml-style's frame nesting from `chain-depth`, the bound
that profile takes from the core. A value is stated in that table and nowhere else; when it changes,
`node _bounds.mjs --write` remakes the cases. [`../bounds.test.mjs`](../bounds.test.mjs)
fails until it has, and holds every implementation in this repository to the
table's values.

## Security requirements: what this suite can and cannot certify

**Passing every case here does not make an implementation safe.** That is not a
caveat, it is a measured fact: `impl2.mjs` passed the whole suite while treating
`[x](javascript:…)` as a live destination — the exact XSS the reference has a
regression test for. `safety.json` exists because of that, and it caught a second
one on the day it landed (`java<TAB>script:` slipping through as a *document*
reference, because the shape was checked before the scheme).

The suite can only certify what a **projection of `parse()`** can see. That
covers the scheme rule: a neutralized destination is absent from the model, so
`link("" …)` / `img("")` / `embed("")` is checkable. Three kinds of requirement
are outside it, and they are **normative anyway** — an implementation that skips
them is unsafe whatever this suite says:

| Requirement | Why it is not here | Verify with |
|---|---|---|
| Nesting caps (blocks, lists, inline) degrade to a **diagnostic**, never a crash | diagnostics are not part of the projection, and pinning one cap value would fail an implementation that reasonably chose another | your own tests; §9.2 |
| Transclusion budgets — depth, expansion count, bytes per document and per page | expansion is a **render**-time act; what a transclusion expands to is not part of the document model (see above) | your own tests; §9.5 |
| Transclusion **cycle** detection terminates and reports | same: reported as a diagnostic, and the cycle only matters once something expands | your own tests; §9.5 |
| A transcluded target is processed **as a document in its own right** — its own metadata, references, relative base and external data | needs a second document to exist, and external data loads at render time | your own tests; §3 |
| Path confinement — a target may not escape the base directory, and `realpath` must be used, not a lexical prefix check | a property of the host environment, not of parsing | your own tests; §9.3 |
| No fetching at build time for `http(s)` sources | ditto | your own tests; §9.4 |

A checklist for a new implementation, in the order these have actually bitten:

1. Reject an unsafe scheme **before** deciding what shape the destination is.
   Strip `[\x00-\x20]` first — a browser does, so `java<TAB>script:` is
   `javascript:`.
2. Cap nesting in all three recursive descents (blocks, lists, inline) and emit a
   diagnostic at the cap. A 20 000-deep inline label must not overflow the stack.
3. Bound transclusion before expanding it, and detect cycles over the document
   graph rather than over paths — a diamond is not a cycle, but path-walking a
   diamond is exponential.
4. Resolve every external target through `realpath` and refuse anything outside
   the base. A symlink planted inside the tree defeats a lexical check.
5. Never let document data decide what gets **executed or instantiated**. GEML
   has no type tags for this reason; if you add a convenience that loads a class
   or runs a command from document text, you have reintroduced the
   `@type`/`!!python/object` family of bugs.

Projection grammar, in brief:

```
text   "abc"          emphasis  em( … )        strong  strong( … )    strike  s( … )
code   code("…")      math      math("…")      break   br             image   img("src")
link   link("target" … )   auto-ref  ref("target") | ref("target" -> "value")    footnote  fn("id")
embed  embed("target")     projection  project("target") | project("target" -> "value")
para   children, space-separated         heading  h<level>( … )
list   ul[…] | ol[…]   ( "*" = loose, "@N" = ordered start N )
item   li(…) | li[ ](…) | li[x](…)   with nested lists appended inside
data   data(<JSON>)        table / view  table(<columns> <row>… [summary <row>])   ( each a JSON array of cell texts )
other  block:<type>        %% line  hidden
```

`-> "value"` is the text a resolved coordinate says (GEML-spec §5.2). A JSON value
prints as `JSON.stringify` writes it. Adjacent text nodes print as one string and
an empty one as nothing: how an implementation splits text is not part of the
model. Map keys print sorted by UTF-16 code unit.

```
blocks  each item of the document, space-joined:
        p( … )  h<level>#<id>( … )  ul[…] / ol[…]  hidden
        <type>[#<id>][.<class>…][<attributes as JSON>]<body>
body    [ items… ]          a flow or prose body
        ( "<raw text>" )    a raw body, its lines joined by \n
        ( <JSON> )          a meta block: the keys it defines
```
