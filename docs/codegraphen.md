# Your AI agent shouldn't grep half the repo to trace one call chain

*Three commands lay your whole codebase's call graph out as a tree of plain-text GEML documents: every method an `#id` block, with `#calls` / `#called-by` edges both ways — what it calls, who calls it, visible in a second. Grep-able, diff-able, versioned, no database.*

The agent told me, flatly: "Nothing else calls it. Safe to change."

Day two after ship, it blew up.

It was a full-stack repo, front end and back end in one tree. I was changing a function's signature and had the agent trace who called it first. It grepped the name, turned up three call sites, read a few files, and told me confidently: just these three, line them up and you're done. So I did — tests green, commit, ship. The next day, an error in prod: there was a fourth caller, behind an interface, reached at runtime under a name that didn't match, that grep never caught. The agent didn't see it because it *couldn't*: to an agent, your codebase is a pile of text files. It greps what it can see and confidently misses what it can't.

That afternoon I wasn't editing code. I was supplying the agent with the map it should have had and didn't.

## What was actually missing

The missing thing is specific: **the agent had no call graph it could actually hold and query.**

Your IDE has "find all references" and a call hierarchy, sure. But that's a heavyweight index locked inside your editor: it churns on a big monorepo, it won't cross the TS-calls-Java boundary inside that one repo, and — the killer — **your agent can't use it.** It lives behind a GUI, not as text the agent can read. Sourcegraph-class tools go further, but they're a database plus a server: not something your agent greps, not versioned alongside your code, stale within two weeks.

So every time it traces a call chain or estimates "what does changing this break," the agent starts from zero: grep a name, pull huge stretches of files into context, burn thousands of tokens, assemble a mental map that's half right — then miss the dynamic dispatch, miss the caller in the neighboring package, and hand you a confident, incomplete answer.

What was missing is a call graph that's just *text* — addressable, checkable, versioned — the exact thing GEML already does for documents, pointed at code this time. So I built one. Three commands:

```sh
npm i -g @geml/geml         # needs Node 22+
geml codemap build          # --root defaults to . : detect languages -> index -> one merged graph in ./.geml-code-graph/
geml codemap serve          # opens your browser on the graph
```

- **TS/JS** — zero setup: `build` fetches the scip indexer itself.
- **Java / C / Python / Go / Kotlin** — one extra download, [Joern](https://docs.joern.io/installation): unzip its release and hand build that folder (or put it on PATH and skip the flag).
- Front end and back end in one repo? It all merges into **one graph.**

## Why it's text, not a database — that's the whole trick

Your entire codebase's call graph is a tree of GEML documents: one document per source directory, every method an empty `#id` block (the block's `src=` points straight at the source lines), plus up to three edge tables — `#calls` (what it calls), `#called-by` (who calls it), `#unresolved` (the blind spots the extractor couldn't resolve).

So the three most everyday moves collapse into a `geml get`:

```sh
# what it calls (downstream, for troubleshooting) — follow the doc.geml#id refs on down
geml get .geml-code-graph/server.c.geml '#processCommand'
geml get .geml-code-graph/server.c.geml '#calls'

# who calls it (upstream, the blast radius) — with the file:line call sites
geml get .geml-code-graph/server.c.geml '#called-by'

# where a symbol actually lives — name straight to anchor
node -e "console.log(require('./.geml-code-graph/_index/name-lookup.json')['processCommand'])"
```

And here's the best part: because it's plain, addressable text blocks, **your agent uses the same `geml get #id` it already uses to edit documents.** No new API to learn, no database to connect, no server to stand up. It greps, it diffs, it keeps history in a `.gemlhistory` sidecar. That fourth caller from the opening? It's now sitting in the `#called-by` table in plain text, with the line it's called from.

## It holds up at scale

"Text, for hundreds of thousands of edges?" Yes — precisely because the graph is *data tables*, not a file per node.

On a real project like valkey: **14,406 symbols, laid out as 44 documents** — not fourteen thousand tiny files (file count down ~300×), with no loss of addressing granularity: `geml get doc.geml '#symbol'` still lands on a single method. Bring up Joern's precise resolution and it's 9,192 methods, 66,543 call sites, **23,235 cross-file resolved calls**, `verify` runs sub-second, the browser opens instantly. Tens of thousands of source files and hundreds of thousands of edges stay instant to open and query.

## And it won't lie to you, or go stale

- **Every edge is really checked.** `geml codemap verify` turns any edge that doesn't resolve into a build failure (exit 1). The moment the graph goes red, it's out of date — rebuild before you trust it to navigate. A detectable dangling reference is a feature, not a defect.
- **Versioned in place.** Add `--history` to build and changed documents snapshot into their own `.gemlhistory`; `geml history log` shows how the graph grew with the code, and `geml revert doc '#method' --to -1` rolls one method's edges back a version.
- **Never out of sync.** A commit hook refreshes it in the background on every code change — code and graph push together, so the graph always keeps up with the code.
- **It's itself a diagram format.** One line — `=== diagram {format=geml-code-graph src=.geml-code-graph/index.geml} ===` — embeds the whole graph in any GEML document. A live architecture diagram in your design doc, instead of a hand-drawn screenshot that rots the day you save it.

## The blunt part

You should be skeptical of anything new, so here are the edges up front:

- **It marks its own blind spots; it doesn't pretend it saw everything.** The `#unresolved` table holds calls the extractor couldn't resolve — **blind spots, not evidence of absence**: function pointers, dynamic dispatch, reflection all land there. It lists them honestly so you know exactly where to fall back to grep, instead of handing you an answer that's incomplete but dressed up as complete. That honesty is precisely what lets you trust the rest.
- **Precision is tiered, not hyped.** C/C++/Java/JS/Python/Rust are first tier (`resolution: cpg`, high confidence); Go/Ruby/Kotlin get a smoke test first and the report says so. For virtual dispatch and multi-implementation interfaces it gives you a whole candidate set rather than forcing a single "looks right" answer — **that set is the answer, don't just trust the first one.**
- **Early, and deliberately small.** It ships inside the `@geml/geml` package; to wire it into an agent there's a thin MCP wrapper (`geml codemap mcp`), and the plain CLI path works without it.

## The most striking part isn't the graph

In the end, the thing worth sitting with isn't "another code-graph tool."

It's that **I added no new syntax to GEML.** The entire call graph is those same three pieces — addressable blocks, checkable references, version history — pointed, unchanged, at code. One primitive: yesterday it laid out a technical proposal thick with tables and charts, today it lays out your whole codebase.

A code graph is one of the most familiar and most demanding things an engineer deals with — if a plain-text primitive can take *that* on, you've got a pretty good sense of how far it stretches. That's the real reason I aimed it at code graphs: it's the hardest whetstone I could find.

## Try it — and check my numbers

Don't take any of these numbers on faith; running it yourself is faster:

- **On your own biggest, messiest repo:** `npm i -g @geml/geml`, then `geml codemap build && geml codemap serve` — watch it lay out the whole call graph in seconds, hover a method to light up its entire chain, click a node and the source snaps in beside the graph.
- **Don't want to install?** The playground hosts a live code-graph of **this very repo**, clickable in the browser: https://geml-spec.github.io/geml/playground/ — and break a reference to watch the build go red.
- **Repo & spec:** https://github.com/geml-spec/geml — issues, critique, and an adapter in a third language all welcome.

I built this graph because an agent that couldn't see a call chain cost me a prod incident. I'd like to hear how you trace call chains and estimate blast radius today — and where this doesn't hold up for you.
