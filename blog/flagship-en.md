# Your AI agent shouldn't read the whole file to change one line

*GEML is a plain-text document format with addressable blocks: an agent reads or rewrites one section by its `#id` — no grepping, no re-reading the whole file — and the document keeps its own version history, without git.*

I finished it by hand.

A sprawling technical proposal — a plan to migrate and re-architect a data warehouse, thick with tables and charts, and still growing, because every agent run wrote its output back into the one document — and after days of driving Claude Code through revision after revision, the only way to ship a version I trusted was to sit down and fix the last mile myself. Not because the model wasn't capable. Because the *document* was working against both of us.

Every small change cost far more than its size. Ask the agent to adjust one section and it would grep, pull long stretches of the file into context just to get its bearings, and spend thousands of tokens locating a few lines. Then it would "helpfully" do more than I asked — reorganizing sections I never mentioned, reflowing a table two pages away. Tables drifted out of step with the prose; a number in a chart stopped matching the table it came from. Nothing caught any of it, because in a plain-text document nothing *can*: there's no unit the agent can grab and say "only this block," no link binding a chart to its source table, no record of what the last good version even was.

By the end I wasn't editing a document. I was babysitting one.

## What was actually missing

Every one of those failures is the same missing thing wearing a different mask: a plain-text document has no *structure you can address, check, or version.* So I built one. GEML is still plain text — you read it and diff it like Markdown — but every block is a typed, `#id`-addressable unit. Here's what that changes, mapped to each way that proposal fought me.

**The agent stops reading the whole file to touch a corner of it.** Every block has an `#id`. `geml get #id` returns just that block; `geml set #id` swaps it and leaves every other byte untouched. On the GEML spec — itself a real document written in GEML — pulling one block by id is a fraction of the file:

```console
$ wc -c GEML-spec.geml
19775 GEML-spec.geml
$ geml get GEML-spec.geml '#abstract' | wc -c
633
```

633 characters instead of 19,775 — about 3%, ~31× less into the model's context to touch that block, and the gap only widens as the document grows. Because the agent never loads the table two pages away, it can't "helpfully" reflow it.

**Numbers stop drifting.** A table computes its own columns, and a chart binds to that table by id instead of copying the numbers out:

```
=== table {#fy25 format=csv header=1 compute="FY [%.1f] = Q1 + Q2 + Q3 + Q4"}
Segment,  Q1, Q2, Q3, Q4
Cloud,     8, 10, 12, 14
Platform,  5,  6,  7,  9
===

=== diagram {#rev format=geml-chart data=#fy25 type=bar x=Segment y=FY}
===
```

The value exists once. Add a row and the total and the chart both follow — there's no second copy to fall out of sync, so "the chart disagrees with the table" stops being something that can happen.

**References resolve, or the build fails.** Point at any block by id — `[[#migration-plan]]`, a chart's `data=#fy25`, a footnote — and `geml check` turns an unresolved reference into a build error with a non-zero exit, not a silent dead link a reader finds for you weeks later.

**The last good version is built in.** `geml history` keeps every revision in a plain-text `.gemlhistory` sidecar next to the file — commit a version, read exactly what a past one said, restore any of them — offline, no git, no service. The version history I kept wishing the document had, living right beside it.

None of these is really four features. They're one root: a document needs structure you can address, check, and version. Everything else follows from that.

## Why not just Markdown?

That's the real question. Today, Markdown is the default — and for prose written and read by people, it's a good one: light, universal, renders everywhere.

The trouble is that the same minimalism that lets Markdown render everywhere means it doesn't carry what an agent needs: addressable blocks, checked references, data that computes and binds. To a tool, a `.md` file is basically one long string — no unit smaller than the whole document that it can reliably grab. You can bolt these on with extensions, but every non-standard scrap of syntax you add is a little less "renders everywhere" — Markdown's one real superpower. (I take the "why not just extend Markdown?" question head-on below.)

(Some reach for HTML instead — the direction Anthropic's "unreasonable effectiveness of HTML" post explores — but HTML is heavy: every `<tag>`, every inline style is tokens, and it's a rendering target, not a source. A side road; set it aside.)

What GEML does is keep what's good about Markdown — plain text, readable, diffs cleanly — and add the layer it lacks: addressable, checkable, versioned. And crucially, it isn't another Markdown dialect: one grammar, one spec, and a conformance suite a second implementation reproduces — so the same document means the same thing to whoever parses it. When you need the deliverable, `geml export` projects it to GitHub-Flavored Markdown or HTML. Light like Markdown to read and write; addressable like a data structure to operate on; compiled to whatever your reader already opens.

## What this isn't

Being blunt, because you should be skeptical of a new format:

- **"Why a fifteenth standard? Can't I just extend Markdown?"** You can try — Pandoc and kramdown do add `{#id}`-style attributes. But that's the disease, not the cure: every extension is another dialect, and the same `.md` already means different things to CommonMark, GFM, and Pandoc. More syntax only deepens the ambiguity — and the moment you use non-standard syntax, your `.md` stops rendering correctly in GitHub, Notion, and Slack, so you've traded away Markdown's one trump card. Besides, reference checking, get/set by id, and table-bound charts aren't syntax sugar; they need a parser with a document model and a build step. The real fix isn't another patch — it's a single, normative spec built for this from the start: one grammar, one spec, a conformance suite a second implementation reproduces, so "correct" is defined by the spec, not by whichever parser you happened to run. That's GEML — and it exports to Markdown, so you keep "renders everywhere" for delivery.
- **"Am I locked in?"** No — that's what `geml export` is for. GEML is your source; the world still gets `.md` and `.html`. Try it on one document; it's reversible.
- **"Models don't know how to write it."** Partly true today — it's new, and the training data is thin. Two things soften that: the grammar is small and regular (one typed-block shape for everything), which is the kind of thing models emit reliably; and you read and edit it by hand as easily as Markdown, so you're never hostage to the model getting it perfect.
- **It's early, and deliberately small.** The 1.0 spec is stable and the repo dogfoods it. There's an open proposal process (GEP) and a conformance suite a second implementation can reproduce. No adoption numbers to quote, and I won't invent any. If token cost, drifting numbers, dead references, and lost versions on big AI-edited documents have bitten you, this is for you. If they haven't, Markdown is fine — genuinely.

## Try it — and check my numbers

Don't take the ~31× on faith: clone the repo and run `geml get #id` on the spec yourself — the spec is written in GEML.

- **Playground**, in your browser, no install: https://geml-spec.github.io/geml/playground/ — break a reference and watch the build go red.
- **CLI:** `npm i -g @geml/geml`, then run `geml get`, `geml check`, and `geml history` against your own worst document.
- **Repo & spec:** https://github.com/geml-spec/geml — issues, critique, and a parser in a third language all welcome.

I built this because a document I couldn't hand to an agent beat me into finishing it by hand. I'd like to hear where it beats you — and where GEML doesn't hold up.
