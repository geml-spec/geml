# GEML launch playbook (tracker branch — not on main)

The wedge, the assets, and ready-to-paste copy. Strategy/why lives in
`PROMOTION-PLAN.md` (v2); this is the operational doc. Finished long-form
copy: `blog/` (flagship, EN+中文) · `seeds/` (Reddit/Discord variants) ·
`research/` (MD-vs-HTML). Progress checklist: `task.geml`.

**Positioning (lead with this everywhere):** *Your AI agent shouldn't read the
whole file to change one line. GEML documents are **addressable** — an agent
reads or patches one block by `#id` (`geml get/set`, ~31× less context on a
real doc) — and **versioned**, with history that lives next to the file.*
Reference checking (`geml check` goes red in CI) is a supporting proof, not
the headline. NOT "replace Markdown", NOT "AI-native" (both trigger the
"yet another standard" dismissal); `geml export` gives Markdown/HTML back.

Playground: https://geml-spec.github.io/geml/playground/
Repo: https://github.com/geml-spec/geml · npm: `@geml/geml`

---

## Launch sequence (do NOT fire Show HN cold)

- [ ] **0. Re-verify the public numbers** — the blog/seeds quote
      `19775 → 633 (~31×)` measured on `spec/GEML-spec.geml`; the file has
      changed since drafting. Re-run `wc -c` + `geml get '#abstract' | wc -c`
      on current main and update blog + seeds before anything ships.
- [ ] **1. Record the 15s GIF (new-wedge script)** — same big doc, same agent,
      split screen. Left (Markdown): to change one section the agent greps,
      streams huge chunks of the file into context (token counter spinning),
      and reflows a table it wasn't asked to touch. Right (GEML):
      `geml get '#plan'` pulls one block (token counter tiny), edit,
      `geml set '#plan'` — every other byte untouched. No narration.
      Drop it above the fold in both READMEs (under the hero tagline).
- [ ] **2. Seed quietly** — Discord (Latent Space, LLM Devs, Claude Code):
      the ready-to-paste intro is in `seeds/seed-posts-en.md` (lowercase,
      problem-first, playground link only). Collect 2–3 reactions/quotes.
- [ ] **3. One real case study** — a real oversized doc, before/after token
      counts for a one-block edit (`geml get` vs. read-the-file), plus the
      GitHub Action catching a broken ref in CI as the supporting proof.
- [ ] **4. Show HN** — Tue–Thu ~8–9am ET. Title + first comment below. Man the
      thread for 4 straight hours; agree-then-narrow when someone names
      djot/AsciiDoc/Typst (concede typesetters error on labels; the wedge is
      addressable + versioned plain text for interchange).
- [ ] **5. Lobsters** (`plt`/`practices`), same week.
- [ ] **6. Reddit, staggered, re-angled per sub** — r/ExperiencedDevs and
      r/devops first (agents-editing-big-docs + token cost land directly),
      then r/LocalLLaMA, r/LLMDevs (context/token angle), then r/programming
      ("one spec vs. a pile of dialects"), r/commandline (CLI). Bodies in
      `seeds/seed-posts-en.md`.
- [ ] **7. Newsletters / awesome-lists** riding the spike — TLDR AI, Latent
      Space/AINews, Turing Post; PRs to jamesmurdza/awesome-ai-devtools and
      awesome-MCP / awesome-LLM-tools.

---

## Show HN — ready to paste

**Title:** `Show HN: GEML – a doc format where an AI agent edits one block by id, not the whole file`

**URL:** `https://geml-spec.github.io/geml/playground/`

**First comment (post immediately):**

> I spent days driving Claude Code through revision after revision of one sprawling technical proposal, and what beat me wasn't the model — it was the document. To change one section the agent would grep, pull long stretches of the file into context just to get its bearings, and burn thousands of tokens locating a few lines. Then it would "helpfully" reflow a table two pages away. Numbers drifted apart from the tables they came from, and there was no version to roll back to. I finished it by hand.
>
> The root cause: to a tool, a `.md` file is one long string — there is no unit smaller than the whole document that it can reliably grab. GEML is a small plain-text format built around fixing exactly that: every block is typed and carries an `#id`. `geml get file.geml '#id'` returns just that block; `geml set` swaps just that block and refuses the write if it would break the document. On the GEML spec itself — a real document written in GEML — pulling one block is ~633 chars instead of ~19.8K, roughly **31× less context**, and the gap widens as the document grows. Because the agent never loads the table two pages away, it can't "helpfully" reflow it.
>
> The rest follows from the same root — structure you can address, check, and version: charts bind to tables by id so a number exists once and can't drift; a dangling or cross-document-broken reference is a build **error** (`geml check`, non-zero exit — in the playground, hit "Break a reference" and watch it go red); and `geml history` keeps every revision in a plain-text `.gemlhistory` sidecar next to the file — restore or roll back one block, offline, no git.
>
> Two things I'll pre-empt. *"Just extend Markdown?"* — Pandoc/kramdown do bolt on `{#id}`, but every extension is another dialect, and the same `.md` already parses differently under CommonMark/GFM/Pandoc; get/set-by-id, bound charts, and reference checking need a document model and a build step, not more syntax. One grammar, one normative spec, a conformance suite reproduced by a second independently-written parser. *"Am I locked in?"* — no: `geml export` projects back to GitHub-Flavored Markdown/HTML; trying it is reversible.
>
> A bonus for the engineers here: the same primitive scales to code. `geml codemap build` writes your codebase's whole call graph as GEML documents — every method an `#id` block with `#calls`/`#called-by` edge tables — and `geml codemap serve` opens it as an interactive graph; three commands, works on mixed TS/Java/Python/Go repos.
>
> It's early and deliberately small: 1.0 spec (stable), MIT code / CC-BY spec, no adoption numbers to invent. If token cost, drifting numbers, dead references, and lost versions on big AI-edited documents have bitten you, this is for you; if not, Markdown is genuinely fine. Repo: https://github.com/geml-spec/geml · `npm i -g @geml/geml`
>
> Happy to hear where this breaks for your workflow.

---

## Comparison table (README + blog + the "why not X" pre-empt)

| | **GEML** | Markdown | MDX | AsciiDoc | Typst |
|---|:--:|:--:|:--:|:--:|:--:|
| **Addressable blocks — an agent reads/patches one `#id`, not the file** | ✅ get/set | ❌ | ❌ | ⚠️ ids exist, no get/set tooling | ⚠️ labels, but a typesetter |
| Token-frugal agent edits (one block ≈ 3% of a real doc) | ✅ ~31× | ❌ whole file | ❌ | ❌ | ❌ |
| Self-contained version-history sidecar (no git, per-block revert) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Broken reference fails the build — **incl. cross-document, by default** | ✅ | ❌ | ❌ | ⚠️ warns | ⚠️ in-doc only |
| One uniform primitive for all structured content | ✅ | ❌ | ⚠️ MD+JSX | ❌ | ❌ |
| Stays plain text, no raw-HTML/JSX escape hatch | ✅ | ❌ | ❌ | ⚠️ | ✅ |
| **Ubiquity / ecosystem / editor support** | ❌ brand new | ✅✅✅ | ✅ | ✅ | ✅ |
| First-class PDF/print | ⚠️ via HTML | ⚠️ | ⚠️ | ✅ | ✅✅ |

Keep the **Ubiquity** row — conceding the weakness buys credibility.

---

## Engineer hook — geml-code-graph in three lines

For Show HN replies, Discord, and the r/commandline / r/programming variants
(this is the "one primitive, serious payload" proof):

```sh
npm i -g @geml/geml     # Node 22+
geml codemap build      # detect languages -> index -> one merged call graph in ./.geml-code-graph/
geml codemap serve      # opens the browser on the graph
```

Every method is an `#id` block with `#calls` / `#called-by` tables — the whole
graph is grep-able, diff-able, `.gemlhistory`-versioned plain text, and
`=== diagram {format=geml-code-graph src=.geml-code-graph/index.geml} ===`
embeds it in any GEML document.

---

## TODO copy (ask Claude to draft when ready)

- [x] Flagship blog post (new wedge): *Your AI agent shouldn't read the whole
      file to change one line* — `blog/flagship-en.md` / `blog/flagship-zh.md`.
- [x] Discord seed post + Reddit variants — `seeds/seed-posts-en.md` / `-zh.md`.
- [ ] Self-hosting story: "The GEML spec is written in GEML and validates
      itself" (kills the "toy" accusation; the bilingual dogfood + CI check
      are already live on main).
- [ ] "Why AI-edited documents need an addressable format" — short opinion
      piece (supersedes the old "cross-references should be type-checked"
      angle, which is now a supporting proof).
- [x] Language-agnostic conformance fixtures + "write a GEML parser in your
      language" guide (`docs/WRITING-A-PARSER.md` on main).
