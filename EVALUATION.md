# A Joint Evaluation of GEML

*English | [中文](EVALUATION_CN.md)*

> A design review of GEML by two reviewers from opposite ends of the markup
> world. We came in with one question: **what would it take for us to recommend
> GEML in place of Markdown and HTML?**

## Who is reviewing, and why both

- **John MacFarlane**, author of CommonMark, Djot, and Pandoc. His lens is
  markup-language design and specification rigor. Is the grammar deterministic?
  Is the spec normative? Will two independent implementations agree? Does the
  format earn the claims it makes?
- **Thariq Shihipar**, engineering lead on Anthropic's Claude Code team and
  author of *"The Unreasonable Effectiveness of HTML."* His lens is agent
  output. Does this format help a model ship a better artifact to a human? How
  does it fare against HTML on layout, color, interactivity, and round-trip
  editing, the axes where HTML has become the format agents reach for?

We were chosen as a pair on purpose. GEML sits between our two worlds. It wants
Markdown's plain-text legibility, plus a rigor Markdown never had, and it
deliberately refuses HTML's escape hatch. One of us cares whether the grammar is
sound. The other cares whether an agent and a browser can do anything useful
with it. A format that wins only one of those reviews does not get our
recommendation.

---

## TL;DR: the verdict, and the one move that changes it

GEML is the most thoughtfully designed plain-text format in its comparison
table. Its three headline bets are the right instincts, clearly descended from
Djot and Pandoc: one typed-block primitive, build-time reference checking, and
an AST-first document model.

But as it stands, **neither of us would yet recommend it over Markdown or
HTML.** Our reasons differ, and they point the same way:

- **MacFarlane:** GEML claims "no syntax ambiguity," but it has not done the
  work that claim requires. Lists and emphasis are under-specified, the EBNF is
  a draft, and the only definition of the language is a single reference parser
  built on naive regexes. A reference implementation is not a specification.
  That is the entire lesson of CommonMark. Two conforming GEML parsers would
  disagree today.
- **Shihipar:** GEML bans the raw-HTML escape hatch and ships no renderer of its
  own. So on the exact axis my essay is about, a thing a human can open and
  *use*, GEML currently produces nothing. It is more restrictive than even
  Markdown here. A `.geml` file is something you read, not something you
  operate.

The single move that flips both verdicts is the same one. It is best said in
GEML's own voice, as a positioning line GEML should put its name behind:

> **GEML is not trying to replace the browser. It is the artifact an agent hands
> a person, the job HTML does today.** Not a wall of Markdown, and not a
> 2,000-line `<div>` file the model has to get right by hand. It is one
> self-contained `.geml` document that a GEML runtime turns into a live,
> interactive page, with every block typed and reference-checked.

That positioning turns GEML's two most contested decisions into the pitch.
Banning the raw-HTML escape hatch is what keeps every artifact typed and
checkable. And "no renderer" flips from an omission into the headline
deliverable: the GEML runtime *is* the product, the browser-grade layer that
makes the artifact live. The rest of this document is about what it takes to
make that real.

---

## What "recommend over Markdown and HTML" actually requires

It is worth being explicit. "Beat Markdown" and "beat HTML" are different axes,
and they trade off against each other:

| Axis | Markdown's position | HTML's position | What GEML must do |
|---|---|---|---|
| **Rigor / determinism** | weak (no single parse, fragmented) | n/a (a different game) | **beat Markdown:** one defined parse, a normative test suite |
| **Expressiveness / rendering** | a ceiling agents have outgrown | the runtime everyone has | **match HTML's output:** a self-contained, interactive artifact a GEML runtime makes live |

Markdown is beaten on rigor. HTML is beaten only by producing what HTML
produces: a self-contained, interactive thing a person can open and use. There
is a natural tension here. A format that constrains hard enough to be checkable,
the MacFarlane win, tends to constrain away the visual richness, the Shihipar
win. The reverse is also true. **GEML wins both axes only if its artifact stays
typed and checkable, and a GEML runtime renders it, through the browser everyone
already has, into something as live as the HTML it replaces.** Hold that
thought. It is the spine of Part 4.

---

## Part 1: What GEML already gets right

Credit where it is due, from both of us:

- **The single typed-block primitive is genuinely elegant.** `=== type {attrs}
  … ===` covers code, tables, math, diagrams, callouts, and metadata. That is a
  real simplification over "a new syntax per feature, plus an HTML fallback." It
  is Djot's fenced-div instinct, generalized. For a model, one block shape to
  emit correctly means measurably fewer malformed-output branches than
  Markdown's pile of special cases.
- **Build-time reference checking is the feature to steal.** A dangling
  `[[#id]]`, a duplicate id, an unknown `{{meta}}` key, or a typo'd chart column
  becomes a hard diagnostic with a line number, not a silent 404 discovered
  three hops later. No light-markup format guarantees this. For an agent doing
  multi-file edits, it is the difference between a machine-checkable pass/fail
  and hope.
- **AST-first, with a document-model JSON and `diagnostics`.** Defining the
  format by its abstract model rather than its rendering is exactly right. The
  structured pass/fail is precisely what a CI loop or a self-correcting agent
  wants to consume.
- **The attribute model is borrowed from the right place.** `{#id .class
  key=val}` with sane value typing comes straight from Djot and pandoc-markdown.
  Good lineage, good taste.
- **Tables and charts share a single source of truth.** A chart reads a real
  table by `data=#id`, computed columns included, and errors on a missing
  column. That is the correct instinct. No data series drifts silently out of
  sync with its chart.
- **The table language shows restraint.** Cell addressing, `VLOOKUP`,
  `remote()`, and embedded programs are excluded by design. That keeps tables a
  document feature rather than a spreadsheet engine. The instinct to draw the
  line is right, though below we argue the line is drawn in an awkward place.

These are not small things. The disagreements that follow are the ones you have
with a serious design, not a careless one.

---

## Part 2: John MacFarlane's evaluation, markup design and spec rigor

Let me start by saying GEML has my fingerprints on it, in the best way. The
attribute syntax is Djot's. The AST orientation is Pandoc's. The
fewer-and-more-regular-constructs philosophy is the one I have argued for since
CommonMark. So read the following as notes from someone who wants this to
succeed and has made most of these mistakes himself.

### 2.1 The "no ambiguity" claim is not yet earned (the gating issue)

This is the heart of it. The README says "No syntax ambiguity," and §1 makes
determinism a constraint. But the document does not yet contain the machinery
that would make it true, and the reference parser actively contradicts it.

- **Lists are barely specified, and the parser cannot nest them.** Lists are the
  single hardest part of any Markdown-family grammar: nesting, indentation,
  loose vs. tight, ordered-list start numbers, lazy continuation. The spec gives
  them one EBNF line. The parser (`geml.ts`) matches list items with a flat
  regex and has no notion of nesting at all. This is exactly the corner where
  every Markdown implementation diverged for a decade.
- **Emphasis is specified at pre-CommonMark precision.** The rule "delimiters
  must attach to a non-space character" is necessary but nowhere near
  sufficient. The parser uses leftmost-regex matching. It will disagree with any
  other implementation on `*a **b* c**`, `**a*b**`, intraword emphasis, and
  every nested same-delimiter case. CommonMark needed the delimiter-run /
  flanking algorithm and roughly **130 emphasis examples** to pin this down to a
  single answer. GEML has neither the algorithm nor the examples.
- **Inline precedence is under-defined at the seams.** What exactly happens to
  `[text *with](url) emphasis*`? Link-versus-emphasis precedence needs a stated
  rule, not an implementation accident.

The fix is not more prose. It is the CommonMark discipline:

1. A **normative conformance suite** of input → document-model-JSON cases, in
   the hundreds, not 59, where the suite is the specification. CommonMark's
   `spec.txt` carries about 650 runnable examples for a reason.
2. An **explicit, stated algorithm** for the two hard problems, list parsing and
   emphasis resolution, so an implementer reproduces the parse from the spec
   rather than from reading the TypeScript.
3. A frozen grammar, with "draft" removed from the EBNF.

**Acceptance test:** a second, independent implementation, written only from the
spec, agrees with the reference parser on the whole suite. Until that happens,
"no ambiguity" is an aspiration, not a property. And it is the one claim on
which GEML's entire pitch against Markdown rests.

### 2.2 "One primitive" is partly a framing, and should be owned honestly

The block *frame* is uniform. The block *body* is a different sublanguage per
type. Tables use a pipe-grid or CSV/TSV. Diagrams use an external DSL. Math uses
LaTeX. Meta uses `key=val`. Code is verbatim. On top of that sits a genuine
expression language, `compute` / `summary`, with operator precedence,
aggregates, and `printf` specs, 400 lines in `table.ts`, living inside attribute
strings.

So the real surface a human or a model must master is one frame, plus N body
sublanguages, plus an attribute expression language. That is arguably *more*
total surface than Markdown, merely organized more tidily. This is fine. But the
README's "one grammar to learn" is true only at the framing level. The honest
version of the pitch is "one uniform frame, so the structure is regular and
checkable," not "one grammar."

### 2.3 The formula DSL in a quoted attribute is a design smell

`compute="FY [%.1f] = Q1 + Q2 + Q3 + Q4; YoY [%.1f%%] = (FY - PriorFY) * 100 /
PriorFY"` buries a whole expression language inside a string. It has its own
lexer, parser, precedence, `[printf]`, `;` separators, and single-quoted column
names, because the attribute is already double-quoted. All of it sits inside a
string, inside an attribute, inside a one-physical-line fence header. This
violates the spirit of "fully legible plain text." Org-mode, cited as the
inspiration, at least keeps formulas on their own `#+TBLFM:` line. Either lift
computation onto its own body lines, where it is visible and diffable, or decide
tables are a document feature and drop computation. The half-measure, a
spreadsheet smuggled into a string, is the worst of both. (Thariq reaches the
same conclusion from the generation side. When both the parser-theory reviewer
and the model-output reviewer independently flag the same construct, it is worth
listening.)

### 2.4 The fence model is clever but fragile

The rule is: the closing fence must be exactly the opening length, and you nest
with longer fences. Applied to a single delimiter character for all structure,
it has two hazards.

- **Editing cascades.** Adding a deeper nested block can force you to lengthen
  every enclosing fence. That is a non-local edit.
- **It is decided by the deepest payload.** You cannot know the correct outer
  fence length until you have seen the innermost one. Your own history spec
  concedes this. It routes deep payloads into separate `blob`s "because correct
  fence-length nesting is error-prone."

There are two ways out, either of them acceptable. Let the close fence be a run
of `=` of at least the opening length, so nesting never forces you to lengthen
the outside. Or allow an optional named / heredoc close (`=== code … ===code`).
Both keep the close local and unambiguous.

### 2.5 Missing primitives for an "expressive" format

For something named *General Expressive*, three gaps stand out.

- **No inline spans.** Djot and Pandoc let you write `[a phrase]{.term}` to mark
  prose semantically inline. GEML has block-level classes but no inline
  equivalent. So a "semantic class, never a styling hook" philosophy cannot
  reach inside a sentence. Add bracketed spans.
- **No definition or description lists.** These are bread-and-butter for the
  technical and reference documents GEML is otherwise aimed at.
- **A closed, hardcoded type registry.** New block types are "warnings, kept
  raw," with no way to declare a new type's body mode and validation in-document
  or via a sidecar schema. So "one primitive for everything" hits a wall the
  moment an organization needs `=== requirement {#REQ-1}` with checked
  semantics. Today that requires forking the processor. A declarable registry,
  whether a `=== typedef` or an external schema GEML validates against, is what
  lets the single primitive actually scale to "everything" without the core
  shipping every domain.

### 2.6 Interop is the lifeblood, and it is thin

Pandoc taught me that a format lives or dies by its converters. GEML ships a
lossy `md → geml`. It **drops thematic breaks**, which is silent data loss, and
turns raw HTML into text-with-a-note. There is nothing in the other direction:
no `geml → html`, no `geml → markdown`, no bridge to a Pandoc-style AST. The
tell is in this very repository. The README's "renders as" examples are
displayed by **GitHub's Markdown/HTML renderer**, because GEML has no renderer
of its own. A format whose own showcase is rendered by translating away from it
has not closed the loop. Define GEML by its AST, which it nearly already is, and
write the renderer that makes a `.geml` file *show* something. That renderer is
exactly what Part 4 turns into GEML's headline deliverable.

### 2.7 `.gemlhistory` is scope creep that dilutes the core

Reverse deltas, keyframes, SHA-256, and a bespoke `delete/replace/insert/move`
patch language together reimplement a large slice of version control. And they
do it with weaker guarantees. The spec itself admits the id chain is "not
cryptographically tamper-evident." There is no branching, rollback is
destructive, and the patch sublanguage is one the spec says agents **must not**
hand-write, which contradicts "fully legible, AI-writable plain text." The
"without git" framing is weak. The target users are developers and agents in
repositories, and they overwhelmingly have git, which already gives
content-addressed, tamper-evident, branching history and an enormous tool
ecosystem. This is a lot of spec and parser surface for a narrow git-less niche,
and it competes for attention with the three ideas that actually differentiate
GEML. My advice: spin it out of the core pitch. Keep it only if a crisp,
explicit git-less audience is the goal, and stop counting it as a core
differentiator.

### 2.8 Confront the XML ghost, and the boundary of checking

Two honesty edits for the positioning.

- **"One uniform primitive for everything structured" was XML's pitch too.** The
  arc from XML to Markdown is the story of humans rejecting a uniform-but-rigid
  primitive in favor of lightweight, special-cased, ergonomic syntax. GEML is
  betting against that history. It should say why it won't share XML's fate. My
  own answer would be: because the special cases live in body modes and a
  declarable registry, not in the surface grammar. But GEML has to make that
  argument, not dodge it.
- **Be honest about where checking stops.** Reference-checking is real for
  *ids*, but it does not reach *content*. A malformed Mermaid or LaTeX body
  sails straight through, since the processor "MUST NOT interpret the body."
  That is a defensible boundary, but the README should state it, because
  "build-time checking" reads as stronger than it is.

---

## Part 3: Thariq Shihipar's evaluation, agent output and the HTML lens

*The following is Thariq's assessment, integrated as the second voice in this
review.*

### 3.1 First reaction

My whole thesis is "stop asking Claude for walls of Markdown when the output
wants layout." So I read GEML through one question: does this help an agent ship
a better artifact to a human? My take is split. As a **source and interchange
format**, GEML is the most agent-legible thing in its comparison table: one
block shape, hard reference checking, structured tables that stay in text. But
the spec bans the raw-HTML escape hatch, says a conforming processor "MUST NOT
depend on raw HTML," and **ships no renderer**. So on the exact axis my essay is
about, visual richness, color, interactivity, a thing a human can *operate*,
GEML today produces nothing. A `.geml` file is something you read. A
self-contained `.html` file is something you use. GEML is impressive as the
layer *under* the artifact, and a non-starter as the artifact itself.

### 3.2 What GEML genuinely does well for agents

- **One uniform block primitive lowers the malformed-output rate.** Markdown's
  failure modes for models are the special cases: a table separator off by a
  pipe, a fence colliding with indentation, frontmatter that isn't quite YAML.
  Collapsing everything into `=== type {attrs}` means one grammar to emit
  correctly instead of a dozen. Fewer branches in the generator means fewer
  broken renders.
- **Build-time reference checking turns silent link-rot into an actionable
  error.** This is the feature I'd steal. An agent doing multi-file edits gets a
  machine-checkable diagnostic with a line number, not a 404 discovered later.
  The document-model JSON with `diagnostics` is the structured signal a
  self-correcting loop wants.
- **Tables and charts share a single source of truth, and everything stays in
  the text modality at low token cost.** A table is `| a | b |`, not a `<table>`
  tower. It also diffs cleanly line-by-line for patch-based editing.
- **Deterministic, low-ambiguity structure.** ATX-only headings and typed
  attributes mean less for a model to get subtly wrong, in principle. (John's
  Part 2 is the asterisk on "in principle.")

### 3.3 Where GEML is worse than HTML for what my essay cares about

- **No canonical presentation and no universal runtime, so it is more
  restrictive than even Markdown.** My HTML argument rests on two legs: the
  browser is a runtime everyone already has, and HTML self-renders into
  something visual and interactive. GEML kicks both legs out. Ship a human a
  `.geml` with a Mermaid block and no toolchain, and they get **literal DSL
  source in a fenced block**, not a diagram. Markdown-on-GitHub at least renders
  that Mermaid. GEML banned its only universal fallback and didn't replace it
  with a runtime.
- **No interactivity story at all.** The artifacts I celebrate are *behavioral*:
  a working mini-editor, a planning board, an annotated PR view, a slide deck,
  side-by-side design comparisons in a grid. But `.class` is "a semantic label,
  never a styling hook." There are no events, no scripting, no layout
  primitives. GEML can describe a document's *structure*, never its *behavior*.
- **Cold-start fluency is a real, underrated problem.** HTML's unreasonable
  effectiveness *is* the training distribution. Models are fluent with zero
  prompting. Models have seen approximately **zero GEML**. Until that changes,
  every generation needs the grammar carried in-context, and the model will
  drift toward Markdown habits and reach for the raw-HTML hatch that isn't
  there. This has to be **measured**, not asserted.
- **The single-`=` fence-length nesting rule is a generation footgun.** To nest,
  a model must track **global fence depth** and lengthen the outer fence. That
  is a non-local constraint it must plan before writing the opening fence.
  HTML's `<tag>`/`</tag>` is verbose but local: you never need to know how deep
  you are to close correctly. For an autoregressive model, locality beats
  brevity. (Your own history spec routes around this rule for being
  "error-prone." When a companion spec avoids your rule, it's a hazard.)
- **The compute/summary DSL inside quoted attributes stacks three
  quoting/escaping regimes** in a place where a model sees a string, not
  structure. That is a plausible source of exactly the malformed output the
  single-primitive design is meant to eliminate.

### 3.4 The bridge, reacted to as Thariq

Here's the framing that flips me from skeptic to interested: **GEML is the
artifact, not a rival runtime.** What an agent hands a person is the `.geml` file
itself. A GEML runtime renders it, through the browser everyone already has,
into the self-contained, interactive thing I currently tell people to hand-ask
Claude for in raw HTML. The agent authors clean, low-token, reference-checked
GEML. It gets the malformed-output reduction, the hard error on a broken link,
the single-source-of-truth tables, the cheap diffs. The runtime supplies the
layout, color, rendered diagrams, charts drawn from the table model, and
**interactivity**. "No raw HTML in the source" stops being a restriction and
becomes the point: the artifact stays typed and checkable end to end. That is
strictly better than asking a model to hand-author 2,000 lines of `<div>` soup
and hoping the cross-references line up, because right now **nothing checks that
HTML**.

This reframing must own two things. First, GEML's deliberately closed
vocabulary, semantic `.class` only, a fixed inline set, a closed chart-channel
set, caps the *ceiling* of the artifact. A runtime can only render affordances
the format can name. My favorite HTML artifacts use bespoke one-off
interactions. So GEML either grows a principled "interactive component" block
type, escaping the closed set without reopening the raw-HTML hatch, or it
concedes that it targets the structured-document 80%, not the bespoke-tool 20%.
That is a fine scope. But state it. Second, that runtime then *is* the dependency
GEML claimed not to need. "No renderer" stops being a virtue the moment the
value proposition is "GEML *is* the artifact." Rendering through the browser
keeps the dependency from being fatal, but it is still a dependency. Own that
too.

### 3.5 My bar for recommending GEML over Markdown/HTML

Concrete and testable. I'd tell people to use GEML when it ships, demonstrably,
all of:

1. **An excellent GEML runtime that renders a `.geml` file into a
   self-contained, interactive artifact.** Single file, any browser, no server.
   It produces at least the affordances my essay names: a planning board, an
   annotated diff view, a slide deck, a sortable/filterable table, a
   side-by-side grid. This is the gating item. Today it produces nothing.
2. **A handful of killer self-contained interactive artifacts authored as
   GEML,** shown next to the HTML a human would otherwise hand-ask for. If the
   rendered artifact isn't as good, the indirection isn't worth it.
3. **Demonstrated token efficiency vs. hand-HTML** on the same artifacts, source
   tokens and edit-patch tokens, with the runtime closing the visual gap. A
   measured number, not an intuition.
4. **Evidence current Claude models emit valid GEML** zero-shot or with a short
   system prompt or skill. Run a fixture suite and report the **valid-parse
   rate** and **diagnostic-clean rate**, with the failure breakdown on the two
   footguns: fence depth and the formula DSL. High-90s valid-parse with a
   one-page skill, and I believe the cold-start problem is tractable.
5. **Round-trip editing.** A human or model edits the rendered artifact and the
   change lands back in source without corruption.
6. **Renderer-availability honesty.** Bundle the common diagram renderers into
   the default runtime so a `diagram` block becomes a picture out of the box, or
   stop implying diagrams "render."
7. **The reference-checking and table-as-source-of-truth guarantees survive into
   the rendered artifact** the human actually receives. The cross-checks are the
   differentiator. They can't evaporate when the runtime draws it.

Bottom line: as a from-scratch **rival runtime to HTML, GEML loses today**, and
it shouldn't try to be one. As the **typed, checkable artifact whose runtime
renders through the browser**, it competes for exactly HTML's slot, the thing an
agent hands a person. That is the most compelling pitch in this review, the one
place John's "constrain and check" bet and my "HTML effectiveness" bet point the
same direction. Ship items 1 through 4 and you won't have to convince me. The
artifacts will.

---

## Part 4: The central tension, and the positioning we both endorse

We came in from opposite ends and converged on the same sentence. Here it is,
jointly and plainly, and deliberately in the first person, because this is the
sentence GEML should lead with on its own homepage, not a recommendation we are
making *about* GEML:

> **GEML is not trying to replace the browser. It is the artifact an agent hands
> a person, the job HTML does today.** The deliverable is one self-contained
> `.geml` file, and a GEML runtime turns it into a live, interactive document:
> tables you can sort and filter, charts drawn straight from their data, links
> you can click, diagrams that actually render. It means to win that slot on
> HTML's own terms, **self-contained and interactive**, while adding what
> hand-authored HTML cannot. Every block is typed and reference-checked, so the
> runtime supplies the interactivity, uniformly and correctly, instead of the
> model hand-building it line by line in throwaway markup. And the thing a
> person receives stays legible plain text, far cheaper to emit, diff, and edit
> than the `<div>` soup it replaces.

This dissolves the tension in the two-axis table above. GEML beats Markdown on
**rigor**: one defined parse, a normative suite, typed and reference-checked
blocks. And it means to match HTML on **expressiveness** by being self-contained
and interactive in its own right, never asking the model to hand-write event
handlers or `<div>` soup. The agent emits a small, verifiable document. A GEML
runtime makes it live. The honest catch lives in that last clause. HTML's
deepest advantage is that its runtime, the browser, is already on every machine,
and GEML's is not. So the runtime is GEML's headline deliverable. And it almost
certainly has to render through the browser, the way a Markdown previewer or a
notebook viewer does, to inherit that ubiquity rather than fight it.

It also reframes GEML's two most contested decisions as features.

- **"No raw-HTML escape hatch"** stops being a restriction and becomes the
  guarantee that every artifact stays typed and reference-checked. Raw HTML is
  exactly the escape that would break the checkable model. The moment a block
  can carry arbitrary markup, nothing can promise the cross-references resolve
  or that a chart still matches its data.
- **"No renderer"** must now invert. The GEML runtime becomes the headline
  deliverable, not an omission. The moment the pitch is "GEML *is* the
  artifact," the runtime that makes it live is the product. Shipping it well is
  the whole game.

The catch is equally plain: **none of this exists yet.** The positioning is a
promise until that runtime ships and is excellent. That is what the roadmap is
for.

---

## Part 5: A roadmap to "recommended"

Prioritized, with acceptance criteria. **P0 items are gating.** Without them,
neither of us recommends GEML over the status quo.

### P0: Make it true (the gates)

1. **Make the spec normative and deterministic.**
   - Ship a **conformance suite** of input → document-model-JSON cases, several
     hundred of them, where the suite is the spec. Pin **list parsing** and
     **emphasis resolution** with an explicit, stated algorithm: the
     delimiter-run/flanking approach for emphasis, an indentation model for
     lists. Remove "draft" from the EBNF.
   - **Acceptance:** a second, independent implementation written only from the
     spec agrees with the reference parser across the entire suite.
2. **Ship the runtime: render `.geml` into a self-contained, interactive
   artifact.**
   - One self-contained file, any browser, no server. Diagrams and charts render
     to actual pictures (bundle Mermaid/Graphviz/D2). Tables render with their
     computed columns. Cross-references are navigable. Include at least basic
     interactivity; a sortable/filterable table is the minimum bar.
   - **Acceptance:** this repository's own "renders as" examples are produced by
     the GEML runtime, not by GitHub's Markdown renderer. A human with only a
     browser can open and *use* the artifact.
3. **Measure agent fluency, and publish it.**
   - Run current Claude models over a GEML fixture suite, zero-shot and with a
     one-page skill or system prompt. Report **valid-parse rate** and
     **diagnostic-clean rate**, with a failure breakdown isolating fence-depth
     nesting and the formula DSL.
   - **Acceptance:** high-90s valid-parse with a short skill. If a one-page skill
     can't get there, the format is fighting the training distribution, and the
     P1 footgun fixes become P0.

### P1: Make it genuinely better than the alternatives

4. **Defuse the two footguns.** Relax the close fence to a run of `=` of at least
   the opening length (or add a named/heredoc close), and **lift compute/summary
   formulas out of quoted attribute strings** onto their own visible, diffable
   body lines.
5. **Add the expressiveness primitives a real authoring format needs:** inline
   spans `[text]{.class}`, definition lists, and a **declarable open type
   registry** (`=== typedef` or an external schema), so domains add *checked*
   block types without forking the processor.
6. **Round-trip editing.** Edits to the rendered artifact, or at least a
   canonical `html → geml` / `md → geml` path, land back in source without
   corruption, losslessly where the constructs overlap.
7. **Stop the conversion data loss.** Preserve thematic breaks and raw HTML
   through `md → geml`, as a real construct or a faithfully-roundtrippable raw
   block, and add the reverse direction.

### P2: Scope discipline and honest positioning

8. **Re-scope `.gemlhistory`.** Spin it out of the core pitch. Lean on git where
   git exists. Keep it only if a crisp git-less audience is the explicit, stated
   target. Stop counting it among the headline differentiators.
9. **Fix the positioning.** Lead with "**GEML is the agent's output artifact:
   typed, checkable, self-contained, interactive**," not "replace md/html."
   Confront the XML comparison directly, and name the cold-start training-data
   reality rather than letting the AI-friendly claim imply zero-shot fluency
   that hasn't been measured.
10. **Honesty edits to README/COMPARISON.** State that diagrams don't render
    without a toolchain today, that build-time checking covers *ids* and not
    body *content*, and that the "renders as" examples are produced by an
    external renderer. Credibility with both of our communities depends on
    these.

---

## Part 6: A scorecard we would both sign

| Criterion | Today | Bar to clear | Owner of the concern |
|---|---|---|---|
| Single defined parse (no ambiguity) | ◐ flanking + nesting algorithms, 45-case normative suite; 2nd impl pending | normative suite + 2nd implementation agrees | MacFarlane |
| Lists & emphasis pinned down | ✓ delimiter-flanking + indentation model, in the suite | explicit stated algorithm + examples | MacFarlane |
| Renders to a self-contained, interactive artifact | ✗ none | runtime ships, excellent, bundles renderers | Shihipar |
| Diagrams/charts render to pictures by default | ✗ source text only | bundled renderers | Shihipar |
| Reference checking survives into the artifact | partial (source only) | guaranteed in the rendered output | both |
| Agent valid-parse rate (with short skill) | unmeasured | high-90s, published | Shihipar |
| Fence nesting is local/safe | ✗ global depth | ≥-length or named close | both |
| Formulas are legible, not stringly-typed | ✗ in attributes | own body lines | both |
| Inline spans / definition lists / declarable types | ✗ | shipped | MacFarlane |
| Round-trip editing | ✗ | lossless where constructs overlap | Shihipar |
| Lossless, reversible Markdown conversion | ✗ lossy one-way | reversible | MacFarlane |
| Scope honest (history, "renders", checking boundary) | overclaims | corrected | both |

When most of the **P0** rows turn green, you will not need to convince either of
us. The conformance suite will satisfy MacFarlane, and the artifacts will
satisfy Shihipar. That is the bar.

---

## Closing

GEML is a genuinely good idea, carried about 60% of the way. Its bets are the
right ones, and they descend from the best parts of Djot, Pandoc, and the
hard-won CommonMark lessons: a single checkable primitive, an AST-first model,
references that fail loudly. What holds it back is the same gap on both of our
axes. It has *described* a rigorous, expressive format without yet *building* the
two things that would make the description true: a normative specification that
guarantees one parse, and a runtime that turns the checkable document into the
live artifact a human can actually use.

Do those two things. Adopt the "GEML *is* the artifact" framing that reconciles
our two worldviews, a typed, checkable, self-contained, interactive deliverable
rendered through the browser everyone already has. And trim the scope creep that
distracts from the core. Then GEML stops being a clever format we admire and
becomes one we recommend. We would both like to get there. The work between here
and there is clear, finite, and worth doing.

— *John MacFarlane & Thariq Shihipar*
