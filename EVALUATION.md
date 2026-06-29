# A Joint Evaluation of GEML

*English | [中文](EVALUATION_CN.md)*

> A design review of GEML by two reviewers from opposite ends of the markup
> world, against one question: **would we recommend GEML in place of Markdown
> and HTML?** This evaluates the format as it stands on `main`.

## Who is reviewing

- **John MacFarlane** — author of CommonMark, Djot, and Pandoc. The lens is
  markup-language design and specification rigor: is the grammar deterministic,
  is the spec normative, will two independent implementations agree?
- **Thariq Shihipar** — engineering lead on Anthropic's Claude Code team and
  author of *"The Unreasonable Effectiveness of HTML."* The lens is agent
  output: does the format help a model ship a better artifact to a human, and
  how does it fare against HTML's runtime?

## Verdict — a scoped yes

We recommend GEML today as an **agent-authored, typed, checkable output format
(an IR) for structured documents** — reports, specs, dashboards, data-and-chart
artifacts — where the payoff is build-time reference checking and
table-as-source-of-truth surviving into a browser-rendered page. It is **not
yet** a drop-in Markdown replacement for casual prose, and it is not the tool for
bespoke interactive one-offs.

The two things that blocked a recommendation earlier are both resolved. The
grammar is now deterministic, with a conformance suite an independent
implementation reproduces — MacFarlane's bar. And a `.geml` file now renders, in
a self-contained HTML file and in the browser, with its checks shown —
Shihipar's bar. What remains is finite; it's named at the end.

## Part 1 — What GEML gets right

- **One typed-block primitive.** Code, tables, math, diagrams, callouts, and
  metadata are all `=== type {attrs} … ===`. One shape to learn, one shape for a
  model to emit — measurably fewer malformed-output branches than Markdown's pile
  of special cases.
- **Build-time reference checking that reaches the reader.** A dangling `[[#id]]`,
  a duplicate id, an unknown `{{meta}}` key, or a typo'd chart column is a hard
  diagnostic — and it survives into the artifact: the CLI exits non-zero, the
  browser extension paints it as an in-page banner. No light-markup format gives
  this.
- **Determinism, earned.** Emphasis is resolved by delimiter-run flanking and
  lists by a stated indentation model, both written into the spec (§5.3, §2.1);
  "draft" is gone from the EBNF. A **61-case conformance suite is reproduced by a
  second, independent implementation** — the literal acceptance test for "every
  input has exactly one parse."
- **A runtime — two of them.** `geml render` turns a document into one
  self-contained, interactive HTML file (inline CSS, sortable/filterable tables,
  charts as inline SVG drawn from their bound table). A Chrome extension renders
  `.geml` in the browser, file:// and web.
- **Tables and charts as one source of truth**, with the binding checked at build
  time and the data projected — not copied — into the chart.
- **Measured, not assumed.** A published generation-fluency benchmark
  (`geml-parser/bench/`) runs current models over a fixture suite, zero-shot vs. a
  one-page skill.

## Part 2 — MacFarlane: markup design & spec rigor

> My earlier objection was that "no ambiguity" hadn't been earned: lists and
> emphasis were under-specified, and the only definition of the language was a
> single regex-based parser. That is done. The two hard problems are now resolved
> by *stated algorithms* in the spec — the delimiter-run/flanking rule for
> emphasis, an indentation model for lists — and a second parser, written only
> from the spec and reusing none of the reference code, reproduces the entire
> conformance suite. The claim is earned for the core. The labeled-close fence
> (`=== #id`) and footnote definitions (`[^id]: text`) also closed two real traps.
>
> So I move to **recommending GEML as a checkable structured-document source.**
> What remains is breadth, not soundness:
>
> - **The formula DSL is still a stringly-typed mini-language** inside a quoted
>   attribute (`compute="FY = Q1 + Q2; …"`). A body-line rewrite was tried and
>   judged messier, so the near-term path is better diagnostics and skill
>   guidance — but the legibility question stays open, and the bench shows it is
>   where capable models still trip.
> - **No inline spans and no definition lists** — bread-and-butter for the
>   technical documents GEML targets.
> - **The type registry is closed** — new block types can't be declared with
>   checked semantics without forking the processor.
> - **Conversion is lossy and one-way** (`md → geml` only; thematic breaks
>   dropped). A format lives or dies by its converters; this one is thin.
>
> None of those are gates anymore. They are the path from "good" to "broad."

## Part 3 — Shihipar: agent output & the runtime

> Earlier I said GEML produced *nothing* a human could open and use, and on that
> basis I said no. That sentence is no longer true.
>
> The CLI renderer is real, not a stub: `showcase.html` is one self-contained file
> — inline CSS, three sortable/filterable tables, five charts as inline SVG drawn
> straight from the `#fy25` table, and the only network calls are KaTeX/Mermaid,
> loaded *only when the document uses them*. A prose-and-tables document is
> genuinely zero-network. The chart reads the table model, so the
> single-source-of-truth guarantee survives into the output.
>
> **The browser extension is the bigger deal for my axis.** My HTML argument
> stands on two legs: the browser is a runtime everyone already has, and the
> artifact self-renders. Earlier GEML kicked both legs out. The extension restores
> the first: `.geml` renders *in the browser*, and the build-time checks reach the
> reader as an in-page banner — the differentiator surviving all the way to the
> screen, which a generic text viewer can't do. The honest version of "universal"
> is not "the browser parses GEML" (it doesn't), but "the artifact renders through
> the browser the way a notebook viewer does, carrying its checks." They took it.
>
> Against my seven-item bar: **a self-contained interactive runtime — met.
> Checks survive into the artifact — met. Renderer-availability honesty — met**
> (they state KaTeX/Mermaid are CDN-when-used and that graphviz/d2/plantuml show
> as source). **Valid-parse rate — measured, and published below the bar I set**:
> with the skill, feature-use jumps (haiku 17→83%, sonnet 67→100%) but parse-clean
> is only 67–83%, short of the high-90s I asked for. **Killer artifacts vs.
> hand-HTML — partial** (good format demos, no side-by-side). **Token efficiency —
> still unmeasured. Round-trip editing — still none.**
>
> So: **from "no" to a scoped yes** — recommend GEML as an agent's typed,
> checkable output IR for the structured-document 80%. Caveats, decisively: carry
> the one-page skill and keep the parser in the loop (zero-shot isn't there);
> avoid the `compute`/`summary` DSL with smaller models (the live footgun); this
> is not the bespoke-tool 20% — for a one-off widget, still hand-ask for HTML; and
> it's a dev-mode CLI/extension, not yet a frictionless install.

## Part 4 — Scorecard

| Criterion | Status | Note |
|---|:---:|---|
| Single defined parse (no ambiguity) | ✓ | flanking + nesting algorithms; 61-case suite; independent 2nd implementation agrees |
| Lists & emphasis pinned down | ✓ | stated algorithm + suite |
| Renders to a self-contained, interactive artifact | ✓ | `geml render` CLI **+** browser extension |
| Reference checks survive into the artifact | ✓ | CLI non-zero exit; viewer diagnostics banner |
| Tables/charts as a single source of truth, in the output | ✓ | chart projects the table model; not copied |
| Honest scope (history / "renders" / checking boundary) | ✓ | renderer-availability stated; README repositioned |
| Diagrams render to pictures by default | ◐ | charts = inline SVG; mermaid/KaTeX CDN-when-used; graphviz/d2/plantuml = source (stated) |
| Fence nesting is local/safe | ◐ | labeled `=== #id` close shipped; weak models still miscount |
| Agent valid-parse rate (with a short skill) | ◐ | measured: feature-use 83–100%, parse-clean 67–83% (< high-90s) |
| Formulas legible, not stringly-typed | ✗ | body-line redesign tried, judged messier; legibility open |
| Inline spans / definition lists / declarable types | ✗ | not shipped |
| Round-trip editing | ✗ | no edit-artifact-back-to-source path |
| Token efficiency vs. hand-HTML | ✗ | unmeasured |
| Lossless, reversible Markdown conversion | ✗ | lossy one-way |

## Part 5 — The bar to an unqualified recommendation

1. **Generation parse-clean to the high-90s.** Empirically gated by the
   **compute/summary formula DSL** (the one we both flagged; the bench proves it)
   plus weak-model fence nesting. The cleanest fix is contested — the body-line
   rewrite was rejected as messier — so this is an open *design* question, not
   just a TODO.
2. **Round-trip editing.** Edit the rendered artifact (or md/html) back to source
   without corruption.
3. **Token-efficiency measurement** vs. hand-HTML, with one killer artifact shown
   side-by-side.
4. **Expressiveness breadth** (MacFarlane): inline spans, definition lists,
   declarable block types.

## Closing

GEML has gone from "a clever format we admire" to "a format we'd recommend for
agent-authored structured artifacts — with the skill and the parser in the loop."
The two things we gated on, it shipped: one defined parse, proven by an
independent implementation; and a runtime that renders the artifact, through the
browser, with the checks intact. The remaining list is finite, and the hardest
item on it has already been named.

— *John MacFarlane & Thariq Shihipar*
