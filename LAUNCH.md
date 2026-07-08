# GEML launch playbook (local, not tracked)

The wedge, the assets, and ready-to-paste copy. Strategy/why lives in the
go-to-market memory; this is the operational doc.

**Positioning (lead with this everywhere):** *Docs that fail the build when a
reference breaks — so an AI agent can't silently rot your documentation.*
NOT "replace Markdown", NOT "AI-native" (both trigger the "yet another standard"
dismissal).

Playground: https://geml-spec.github.io/geml/playground/
Repo: https://github.com/geml-spec/geml · npm: `@geml/geml`

---

## Launch sequence (do NOT fire Show HN cold)

- [ ] **0. Record the 15s GIF** — split screen, an agent edits the same doc:
      Markdown ships the broken link silently / GEML `geml check` goes red, CI
      fails. (Screen-record the playground "Break a reference" click.) Drop it in
      the READMEs (placeholder comment is already in place above the fold).
- [ ] **1. Seed quietly** — post the playground + GIF in Latent Space and
      LLM Devs Discords: "made this so my coding agent stops rotting my docs —
      does this resonate?" Collect 2–3 reactions/quotes as ammo.
- [ ] **2. One real case study** — get one CI pipeline (yours or a friendly OSS
      repo's docs) to fail on a broken ref via the GitHub Action; write it up.
- [ ] **3. Show HN** — Tue–Thu ~8–9am ET. Title + first comment below. Man the
      thread for 4 straight hours; agree-then-narrow when someone names djot/etc.
- [ ] **4. Lobsters** (`plt`/`practices`), same week.
- [ ] **5. Reddit, staggered, re-angled per sub** — r/LocalLLaMA, r/LLMDevs
      (agent-rot), then r/programming (compiler angle), r/commandline (CLI).
- [ ] **6. Newsletters / awesome-lists** riding the spike — TLDR AI, Latent
      Space/AINews, Turing Post; PRs to jamesmurdza/awesome-ai-devtools and
      awesome-MCP / awesome-LLM-tools.

---

## Show HN — ready to paste

**Title:** `Show HN: GEML – a doc format where a broken cross-reference is a compile error`

**URL:** `https://geml-spec.github.io/geml/playground/`

**First comment (post immediately):**

> I kept letting Claude/Cursor edit my docs and READMEs in bulk, and kept watching an agent confidently move a section and silently orphan every link and `[[#anchor]]` pointing at it. Markdown renders the broken result happily — there's no build step to catch it.
>
> GEML is a small plain-text format with one idea Markdown can't retrofit: **references are checked at build time.** Put `#id` on any block; reference it with `[[#id]]`, `[text](#id)`, a footnote, or a chart's `data=#id`. A dangling or cross-document-broken reference is a hard error with a non-zero exit, so `geml check` fails CI the moment an edit — yours or an agent's — breaks a link. In the playground, hit "Break a reference" and watch it go red.
>
> Everything is one primitive — `=== type {…} ===` typed blocks — so code, tables, diagrams, math, and metadata share one grammar, which also makes it less ambiguous for a model to emit than Markdown's pile of special cases.
>
> I know about djot, AsciiDoc, MDX, Org, and Typst — most handle structured content better than I do, and Typst/LaTeX *do* error on a missing label. What I haven't seen is reference integrity — **including cross-document** — as a first-class, build-failing default in a *Markdown-class* plain-text format meant for interchange (not a PDF typesetting system). That's the whole wedge. It's MIT, the spec is CC-BY with a conformance suite reproduced by a second independent implementation (so it's not "whatever my parser happens to do"), and `geml export` converts back to Markdown, so trying it is reversible. Repo: https://github.com/geml-spec/geml · `npm i -g @geml/geml`
>
> Happy to hear why this is a bad idea.

---

## Comparison table (README + blog + the "why not X" pre-empt)

| | **GEML** | Markdown | MDX | AsciiDoc | Typst |
|---|:--:|:--:|:--:|:--:|:--:|
| Broken reference fails the build — **incl. cross-document, by default** | ✅ | ❌ | ❌ | ⚠️ warns | ⚠️ in-doc only; it's a PDF typesetter |
| One uniform primitive for all structured content | ✅ | ❌ | ⚠️ MD+JSX | ❌ | ❌ |
| Stays plain text, no raw-HTML/JSX escape hatch | ✅ | ❌ | ❌ | ⚠️ | ✅ |
| Self-contained version-history sidecar | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Ubiquity / ecosystem / editor support** | ❌ brand new | ✅✅✅ | ✅ | ✅ | ✅ |
| First-class PDF/print | ⚠️ via HTML | ⚠️ | ⚠️ | ✅ | ✅✅ |

Keep the **Ubiquity** row — conceding the weakness buys credibility.

---

## TODO copy (ask Claude to draft when ready)

- [ ] Flagship blog post: "I let an AI rewrite my docs for a month — in Markdown
      they rotted, in GEML the build caught it."
- [ ] Discord seed post (Latent Space / LLM Devs) — 3-4 sentences + playground link.
- [ ] Reddit variants (r/LocalLLaMA, r/LLMDevs, r/programming, r/commandline).
- [ ] "Cross-references should be type-checked" — short opinion piece.
- [ ] Language-agnostic conformance fixtures + "write a GEML parser in your
      language" guide (recruits independent implementer #2 — top standards move).
