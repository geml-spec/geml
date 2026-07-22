# Seed posts (geml-code-graph) — English

> The engineer propagation point. Lands harder in dev communities than "a document format" does: everyone using a coding agent has been burned by an agent groping through grep to trace a call chain. Same rules as the main seed posts — problem first, one link, say you built it, ask for critique and actually reply, stagger per community.

## Posting these without being "that guy" (codegraph extras)

- **Lead with the problem, not the project.** "The agent swore nothing else called it, then prod broke" lands long before "what geml-code-graph is."
- **One link:** prefer the **live code-graph of this very repo** in the playground — clickable, and far more convincing than a screenshot.
- **Sell the "text vs. database" contrast**, don't get dragged into "feature-vs-Sourcegraph/IDE" — that's your weakness against their strength. The pitch: it's *text* your agent can grep, diff, version, and that never falls out of sync.
- **Honesty is the moat:** volunteer the blind spots up front (`#unresolved`: function pointers / dynamic dispatch don't resolve). Dev communities reward that and distrust omniscient hype.

---

## Reddit — show-and-tell

**Best targets, in order:** **r/ExperiencedDevs** (blast-radius / "what breaks if I change this" lands directly); **r/LocalLLaMA** and **r/LLMDevs** (the context/token angle); **r/programming** last, with the "one text primitive, no new syntax" framing.

**Title options (pick one, per sub):**

- *I had an agent trace who called a function. It grepped, swore there were only three callers — prod broke the next day.*
- *Tracing a call chain with an AI agent is a hidden tax: it greps half the repo into context and still misses the caller behind an interface.*
- *Show: three commands turn your whole codebase's call graph into plain text your agent can grep, diff, and version.*

**Body:**

> Full-stack repo, changing a function signature, I had Claude Code trace who called it first. It grepped the name, found three call sites, told me confidently that was all of them. I changed it — tests green, ship — and the next day, an error in prod: a fourth caller, behind an interface, dispatched at runtime under a name grep never caught. The agent didn't see it because to an agent your codebase is a pile of text files: it greps what it can see and misses what it can't.
>
> Root cause: the agent had no call graph it could actually hold and query. Your IDE's "find references" is locked in the editor, won't cross the TS↔Java boundary, and the agent can't use it anyway; Sourcegraph-class tools are a database + server, not in your repo, stale in two weeks. So I made the call graph plain text — `geml codemap build`, three commands, lays the whole graph out as a tree of GEML documents: every method an `#id` block, `#calls` (what it calls) / `#called-by` (who calls it, with file:line sites) both ways, and the agent uses the same `geml get #id` it already uses to edit docs. On valkey: 14,406 symbols → 44 documents (not fourteen thousand tiny files); with Joern's precise resolution, 23,235 cross-file resolved calls, `verify` sub-second.
>
> The part I care about: it's honest. Calls it can't resolve (function pointers, dynamic dispatch) go into an `#unresolved` table, listed plainly — blind spots, not "absence" — so you know exactly where to fall back to grep. A dangling edge is a build failure; it keeps `.gemlhistory` version history; a commit hook refreshes it so it never drifts. TS/JS zero-setup, Java/C/Py/Go/Kt add Joern.
>
> The playground hosts a live code-graph of **this very repo**, clickable in the browser: https://geml-spec.github.io/geml/playground/
>
> I'd genuinely like to know: how do you have agents trace call chains and estimate "what does changing this break" today — and where does this fall down?

*(If it fits the sub, concede a neighbor for credibility: "IDE call hierarchies are great inside the editor — this is for the agent, and for a graph that lives in your repo as text.")*

---

## Discord / community intro (Claude Code, LLM-dev, LocalLLaMA)

Shorter, lowercase-casual, for `#show-and-tell` / `#introductions`:

> hey all — changed a function signature last week, had the agent trace who called it. it grepped, said "just these three, safe" — prod broke the next day on a fourth caller behind an interface it couldn't grep. the thing that got me: to an agent your codebase is just text files, it only sees what grep sees.
>
> so i precomputed the whole call graph as plain-text GEML: `geml codemap build`, every method an `#id` block, two tables (what-it-calls / who-calls-it) you query in a second — the agent uses the same `geml get #id` it edits docs with, no db, no server. calls it can't resolve go in an `#unresolved` table, honestly flagged as blind spots (function pointers, dynamic dispatch) instead of pretending it saw everything. valkey: 14,406 symbols in just 44 docs, hundreds of thousands of edges still open instantly. there's an MCP wrapper to wire it straight into an agent.
>
> live code-graph of the repo itself, no install: https://geml-spec.github.io/geml/playground/
>
> mostly after critique — how are you feeding "codebase structure" to your agents right now, and where does this break?
