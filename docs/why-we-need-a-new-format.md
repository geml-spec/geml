# Why Do We Need a New Text Format in the Era of LLMs?

Everyone asks this question: "We already have Markdown, AsciiDoc, JSON, and XML. Why do we need to invent a new format?"

To answer this, let's start with a painful scenario you might be experiencing every day.

## The Scenario: Human-Agent Co-Authoring

Imagine you are writing or refining a long document—a manifesto, a technical spec, or an architecture proposal. Because the document is long and evolves constantly, you frequently swap, trim, or rearrange sections, while cross-references and embedded data remain scattered throughout the text or across other files.

*   **If you do it by hand**: Updating links across a long document is error-prone. You are bound to leave silent broken references behind.
*   **If you hand it to an AI Agent**: Edits easily scope-creep beyond your intended target. The agent might rewrite a whole paragraph's tone or content into something you didn't want.
*   **If you rely on Git**: If you don't want to clutter Git with dozens of immature draft commits, manually reviewing and picking through diffs (and rolling back just the bad parts) leaves you feeling like an overworked editor.

Why is this so painful? Because traditional text formats were never designed for this kind of "human-machine co-authoring."

## The Old Paradigm of "Separation" is Collapsing

Text is the most universal medium for knowledge work and engineering collaboration—people think and express in it; machines read it, edit it, and act on it.

However, the same piece of text has to serve two readers whose needs pull in opposite directions:
*   **Machines want precision**, which comes from formal constraints and tool-enforced verification.
*   **People want comprehension**, which comes from natural structure and expression.

For decades, **"separation" was the only workable answer**. Every format was optimized for its own consumer:
*   **People writing for people**: Word / Google Docs / Markdown. Optimized for comfortable reading, giving up the precision machines want.
*   **People writing for machines**: Programming languages / protocols / schemas. Precise execution, at the cost of requiring humans to learn a profession first.
*   **Machines writing for people**: A rendering pipeline tailored per device and medium.
*   **Machines writing for machines**: JSON / Protobuf. Efficient interchange; human readability is just an afterthought.

This separation worked because of a hidden premise: **each text had one kind of author and one primary kind of reader.** Whoever was writing knew exactly who they were writing for.

However, **LLMs completely canceled that premise.**

The same document is now read, written, and rewritten by people and agents *together*. For the first time, both readers sit at the two ends of the same text, and "optimize for your one consumer" has no one left to point at. That is what "now" means: **the text didn't change; the readers did.**

## The Two Crises Brought by the Reader Change

Once the readers change, the old way of working gives out at both ends.

### Crisis 1: The Person Holding the Net is Gone

Any engineering deliverable is only a version snapshot frozen at one moment. Behind that snapshot sit countless intermediates: requirement drafts, data, structural experiments, review comments, abandoned options, and one diff after another. These fragments are scattered across the formats of those four patterns mentioned above.

That fragment network used to be held together by *people*. To drive a machine, you had to understand the machine; to persuade a reader, you had to understand the reader. That forced understanding—plus infrequent change—let one person or a small team remember which fragment was authoritative and which reference still held. 

AI dropped the barrier to driving machines to zero. Nobody has to understand the machine anymore, so the global mental map loses its source. Add to that the fact that a model's output is stochastic. When "no understanding" is stacked on "no reproducibility," the engineering process devolves from a white box into a black box.

### Crisis 2: Fragment Explosion and the Loss of the Source of Truth

What we call AI engineering—context engineering, evals, guardrails, agent workflows—is essentially all calibration of that black box. But **calibration itself manufactures copies**.

Every pass piles more into the context. The same fact gets summarized once, restated once, locally patched once, and pasted into a prompt once. The chain snaps where nobody is looking: a chart cites a number in a table, a section cites another section's conclusion, the agent moves the structure, the human rewrites the prose—and nobody knows when a dependency broke. 

A copy is drift from the moment it is made: the Single Source of Truth gets copied, converted, and scattered into stale shards. It is no longer single. Copies pile up past what a model can hold in one pass, so the work gets split finer and another layer goes on top—fragmentation snowballs on its own.

## The Solution: Reference the Truth, Don't Copy It

The fix points straight ahead: **let fragments reference the truth instead of copying it.**

Every fragment must know where its source is and **lookup the value (Transclusion)** when needed. The slice it takes is small and short-lived, refetched when stale, never a long-lived copy. Most importantly, the dependency network between fragments must become something a machine can hold and **strongly verify**. Only when state is pinned down—predictable and reproducible—can the engineering loop close again.

To do that, the format carrying the text has to provide four core capabilities at the syntax level:
1. **Block-level Addressing**
2. **Reference-based Projection (Transclusion / Embeds)**
3. **Build-time Verification**
4. **Block-level Reversion**

### Why Do Existing Formats Fall Short?

It's not for lack of trying. Markdown and HTML have links, wikis have backlinks, Obsidian has `![[…]]` embeds, and AsciiDoc has `include`.

But they all have fatal flaws:
*   **Navigation links only**: The far end can change quietly or be deleted, and you will never know on your end.
*   **Embedding without verification**: The source disappears, and the reference keeps pointing serenely at nothing (silent 404s).
*   **Coarse granularity**: Addressing mostly stops at the document or heading level, unable to target a specific paragraph, table, or chart.
*   **No build errors**: None of them treats a broken link as a strict *build error*.

For a reference to be a **lookup** rather than a **signpost**, the missing piece is the gate: change the source and every reference follows; delete the source and the build goes red on the spot.

### Why Syntax Rather Than an External Tool?

A convention that lives in a linter is merely advice that can be bypassed. A constraint that lives in the grammar is a contract every parser implementation *has* to honor. By baking block `#id`s, embeds, and the checking gate directly into the specification, any parser written from that document will consistently refuse the same broken reference. This is the fundamental difference between a format and a product.

### Won't Big Context, Caching, and Memory Make This Obsolete?

The most common pushback: context windows have crossed a million tokens, so reading large text is no longer a burden; prompt caching makes re-reading nearly free; agent memory persists knowledge across sessions; and context engineering, harnesses, and graph tooling are all busy taming the intermediate-artifact sprawl — besides, a new format can't cure engineering's diseases anyway. Why not wait for the models and the tooling?

Because that whole stack optimizes the same side. **Big context makes the copy readable, caching makes the copy cheap, memory makes the copy persist — every layer optimizes the copy. None of them touches the original: who is authoritative, how to point at one block, what stops a bad write, and how to retreat when one gets through.** The more copy technology flourishes, the more it needs an original with addresses, fingerprints, and checks to reconcile against — otherwise all you are optimizing is how fast you read something stale. HTTP caching did not abolish the URI; the URI is what made caching possible.

Two concrete tests. First, **caches shatter on write**: a prompt cache matches by prefix, and in a co-written living document every edit invalidates everything after the edit point — and every serious caching layer in history has ended up forcing addresses and version fingerprints out of the store beneath it (HTTP got URIs + ETags; the document world's pair is block `#id` + `.gemlhistory` revisions — precise invalidation and per-block refresh need something to point at). Second, **the writing problem grows with the window instead of shrinking**: whatever enters the context can be rewritten, so whether the untouched 99% comes back verbatim from a full rewrite is a probabilistic promise, while under `write(id)` it is never on the write path at all — a structural property. Agents run edits in loops by the hundreds; promises compound, properties don't.

**Then look at what the frontier tools themselves are doing.** With contexts already in the millions of tokens, the leading harnesses all refuse whole-file rewrites: Claude Code's edit tool anchors on old_string/new_string replacement, Aider uses search/replace blocks, Cursor has its own targeting protocol — every one of them privately mints "edit by block", and no two are compatible. N teams independently inventing incompatible addressing is the classic signal that a shared layer belongs one level down: before REST, every system had its own set of RPC verbs too. So the busy engineering layer is not evidence against the format — it is the format's client list: graphs need stable node identities (`#id`), loops need post-write checks (`geml check`), harnesses need partial reads (`geml get`). And over the same period, llms.txt, MCP's typed schemas, and structured tool use all appeared — the industry is voting for "context and structure both get cheaper", not "context replaces structure".

**As for "a new format can't cure engineering's diseases" — exactly right, and by design.** The four capabilities are deliberately the narrowest possible layer: retrieval quality, context budgets, orchestration, and memory belong to the engineering layer, and the format should not touch them. The smaller a format's ambition, the better its odds of becoming a standard — XML tried to cure everything, JSON did one thing, and JSON is the one that lived. The format's place is under those engineering efforts, as their foundation — not in place of them.

So the answer was never "the models aren't good enough" — they will keep getting better. It is that addressing, projection, verification, and reversion are properties of the **original**, not abilities of the **reader**: however strong the reader gets, it cannot substitute for a source that has addresses, gates bad writes, and rolls back exactly the block that broke.

## How GEML is Designed

GEML doesn't ask anyone to abandon their existing formats (you can still write a standard blog in Markdown). Instead, it adds the missing network to the existing ecosystem, providing a reliable base for long-lived engineering docs, specs, and agent knowledge bases.

The four capabilities are matched by four concrete designs in GEML's plain text:

### ① One Typed Block + Native `#id` (Addressing)
In GEML, the whole language relies on one block syntax:
```geml
=== type {#id .class key=val}
content
===
```
Code, tables, diagrams, math, callouts, and metadata are all just this block, differing only in `type`. Any block can carry a globally unique `#id`, which is a **block-level reference handle, not a document-level navigation link**. You can change one block without touching the rest. Feed the LLM just that one block—a slice as small as you like, refetched from the source whenever it goes stale.

### ② Block Embedding (Projection)
You can use the `=== embed {src=doc.geml#id}` syntax. A reference is a lookup: what renders in place is that block's **current** state, not a hand-made copy. A deliverable becomes a block-grained assembly—exactly the blocks you need, taken from wherever they live, instead of whole documents carried over.

### ③ Build-Time Checking: `geml check` (Verification)
A reference that doesn't resolve is a **build error**, not a silent 404 discovered at render time. Whether it's chart-to-table bindings, cross-document references, or embed targets—they all pass the same gate. A broken link stops the build right there. Bad writes are rejected before they propagate.

### ④ A Sidecar History: `.gemlhistory` (Revert)
This is an independent rollback mechanism outside of Git. A plain-text sidecar file locally remembers how every block evolved, and `geml revert` rolls back **just the block that went wrong**. 
When an agent breaks one block while a human has edited elsewhere in the same file, a Git file-level rollback would throw the human's work away. **That block-level granularity is structurally beyond Git, and this is where GEML provides it.** It works offline, and an agent can read the history itself to understand how the document came to be what it is today.

## Conclusion

Let's go back to editing that long document. With GEML, every section and paragraph block carries an explicit `#id`, allowing you to restrict the agent to a specific block so edits don't bleed out. If a section is removed or an ID changed, `geml check` turns broken references into immediate build errors rather than silent dead links. And `.gemlhistory` tracks block-level micro-revisions locally—allowing you to safely revert a single over-edited paragraph without spamming Git commits or losing the rest of your manually refined prose.

The nature of text hasn't changed, but the collaborative network in which we read and write it is long overdue for an upgrade.
