# Seed posts — English

## Posting these without being "that guy"

- **Lead with the problem, not the project.** "An agent burned thousands of tokens to edit three lines" lands long before anyone cares what GEML is.
- **One link, max** — the playground. Drop the repo only if someone asks in the thread.
- **Ask for critique and mean it**, then actually reply. An author who engages beats ten drive-by posts.
- **Say you built it.** These communities tolerate clearly-labeled, technically-substantive self-promotion; none tolerate stealth marketing.
- **Re-angle per community and stagger** — don't cross-post the same body to five places in a day.

---

## Reddit — show-and-tell

**Best targets, in order:** **r/ExperiencedDevs** and **r/devops** (agents editing big docs + token cost land directly); **r/LocalLLaMA** / **r/LLMDevs** (the context/token angle); **r/programming** last, and only with the "one spec vs. a pile of dialects" framing.

**Title options (pick one, per sub):**

- *I gave a coding agent a giant doc to edit. It burned thousands of tokens finding three lines — so I made the document addressable.*
- *Editing a big doc with an AI agent is a hidden tax: it re-reads the whole file to change one block.*
- *Show: a plain-text doc format where an agent patches one block by `#id` instead of re-reading the whole file.*

**Body:**

> I spent days pointing Claude Code at a giant technical proposal — a data-warehouse migration, tables and charts, growing every time the agent wrote another section back into it. Every small edit cost far more than its size: to change one section the agent would grep, pull huge stretches of the file into context, and spend thousands of tokens locating a few lines — then "helpfully" rewrite more than I asked. Tables drifted, a chart stopped matching its table, and there was no version to roll back to. I finished it by hand.
>
> The root cause: to a tool, a `.md` file is one long string — no unit smaller than the whole document it can grab. So I built a small plain-text format (GEML) where every block has an `#id`. `geml get #id` returns just that block, `geml set #id` patches just that block — on a real 19,775-char doc, pulling one block is 633 chars, ~31× less into context. Charts bind to tables by id so numbers can't drift; `geml check` makes a dangling reference a build error; `geml history` keeps versions in a plain-text sidecar, no git.
>
> It isn't trying to be a prettier Markdown, and it isn't another dialect — one spec, and it `export`s back to Markdown/HTML so you're not locked in. Early and deliberately small. Browser playground, no install: https://geml-spec.github.io/geml/playground/
>
> I'd genuinely like to know where this falls down for your workflow.

*(If it fits the sub, concede a neighbor to buy credibility: "Typst and LaTeX error on a missing label too, but they're typesetting systems, not a Markdown-class interchange format.")*

---

## Discord / community intro (Claude Code, LLM-dev, Write the Docs)

Shorter, lowercase-casual, for a `#show-and-tell` / `#introductions` channel:

> hey all — spent last week watching a coding agent edit a huge technical doc, and what killed me wasn't the model, it was the document: to change one section it'd re-read the whole file (thousands of tokens), rewrite more than I asked, and there was no version to roll back to. finished it by hand.
>
> so i built a small plain-text format where every block has an `#id` — the agent reads/patches one block (`geml get/set #id`, ~31× less into context on a real file) instead of slurping the whole thing; charts bind to tables so numbers don't drift; it keeps its own version history; and it `export`s back to markdown so you're not locked in.
>
> browser playground, no install: https://geml-spec.github.io/geml/playground/
>
> mostly after critique — curious where this breaks for how you all edit big docs with agents today.
