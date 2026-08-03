# The Doc-as-a-Base Manifesto

*English | [中文](https://github.com/geml-spec/geml/blob/main/docs/MANIFESTO_CN.md)*

> Documents no longer need just a format. They need a set of verbs.

Humans and machines used to keep separate documents, with people ferrying meaning between the two.  
Now one document has two readers: the first reads and moves on; the second reads and starts editing.  
And AI engineering is multiplying documents — fragmenting them — faster than ever. The old mode, a human interpreter in the middle, can no longer keep up.

## We name it

For this reader, we declare a new architectural style:

**Doc-as-a-Base**. Just as [REST](https://www.ics.uci.edu/~fielding/pubs/dissertation/top.htm) gave scattered resources one naming scheme (the URI) and one shared set of verbs (GET / PUT / POST / DELETE), Doc-as-a-Base gives every block of a document one naming scheme (`#id`) and one shared set of verbs (get / set / add / delete).

The *base* reads as **base of truth**:

> **Doc-as-a-Base**: a document that is still plain text, but comes with its own verbs —
> every block has a name and can be fetched alone; references are verified, and a broken one turns the build red;
> an embed is a lookup, not a copy; a revert rolls back one block instead of redoing the whole page.
> It is the **base** of every deliverable: `.md` and `.html` are views projected from it.

## What we value more

In the new paradigm, we hold:

**Addressing by block** over reading and writing whole documents  
**References that fetch** over copy and paste  
**Errors at build time** over silent rot  
**Rolling back one block** over redoing the whole page

The old paradigm's tools are not without value — some of them we still use every day — but to co-write with the machine reader, we value the left side more.

These four preferences are not a scorecard for existing formats. Each format was born for one concrete problem, and most solve theirs well. They were simply never asked to solve this one: machines rewriting documents, block by block, again and again. In 2004, the year Markdown was born, nobody yet needed a document that a program could rewrite atomically.

## The four laws of Doc-as-a-Base

Any format built for the second reader must satisfy all four at once: without addressing there are no safe writes; without projection there is only copying; without verification nothing stops a bad write; without reversibility there is no recovery. Each law carries a decidable criterion.

### Law 1 · Addressability

**Every structural block must carry a stable, machine-recognizable primary key, and be readable and replaceable on its own, out of context.**

Criterion: `read(id)` returns that block and nothing else; `write(id)` replaces that block and nothing else — the rest is not merely left unchanged, it is never even loaded.

What is never loaded cannot be corrupted — isolation, not self-discipline.

### Law 2 · Projection

**A reference must fetch a value, not point at a location.**

Criterion: once embedded, a change at the source changes every embedding site; there is no second copy for a human to keep in sync.

Copies drift from the moment they exist; projection abolishes "syncing the copies" as a category of work.

### Law 3 · Verifiability

**References between blocks must be verified at build time.**

Criterion: an unresolved reference fails the build with a non-zero exit.

One more gate on the write path: a bad write is stopped before it lands, without waiting for review.

### Law 4 · Reversibility

**When something goes wrong, it must be possible to roll back only the block that went wrong.**

Criterion: the rollback touches that block alone; the rest of the file stays identical, byte for byte.

Git cannot structurally provide this granularity: it operates on files and commits. When an agent corrupts one block while a person is working elsewhere in the same file, a file-level rollback sweeps the person's work away with it. That is not a flaw in Git — it simply lives at a different layer.

Addressability, projection, verifiability, reversibility — each is a solved problem somewhere. What is uncommon is holding all four inside one human-readable plain-text format:

| School | Nature of state | Addressable / referenceable | Projectable / embeddable | Verifiable | History / provenance |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Word / Docs** | Opaque state | ❌ No block-level keys; access via platform APIs | ❌ Copy-paste only | ❌ No verification | On the platform's servers, not with the text |
| **Markdown / AsciiDoc** | A character stream | ⚠️ Heading anchors or dialect ids; no read/write verbs | ⚠️ Dialect embeds (Obsidian `![[…]]`, AsciiDoc `include::`), mutually incompatible | ❌ Broken links silent by default | None; delegated to external Git |
| **JSON / XML** | Serialized data | ✔️ id / XPath / Pointer | ⚠️ XML has XInclude (bolt-on); JSON leans on `$ref` dialects | ✔️ Schema validation, external toolchain | None; delegated to external Git |
| **GEML** | **Plain text + block structure** | **✔️ Native `#id` on every block** | **✔️ `=== embed` — the reference fetches** | **✔️ Strict build-time checks; a broken link turns red** | **✔️ `.gemlhistory` travels beside the file** |

## Reference implementation

[GEML](https://github.com/geml-spec/geml) is one implementation built to these four laws — they map to four actions you can verify right now:

```console
$ geml get  spec/GEML-spec.geml '#abstract'   # addressability: fetch just this block
$ geml check bad.geml                          # verifiability: broken reference, non-zero exit
error: unresolved reference `#nope` (line 3)
$ geml revert doc.geml '#api-auth'             # reversibility: roll back just this block
```

Projection is a block type:

```
=== embed {src=spec/GEML-spec.geml#abstract}
===
```

Rendering shows the target block as it stands right now; if the target disappears, `geml check` turns the build red on the spot.

One reproducible number: the spec file runs about 56 KB; `geml get '#abstract'` returns about 590 bytes — roughly **95×**. The number is not the point, the mechanism is: blocks stay constant, so the ratio is "whole document divided by one block", and it grows as the document grows — the bigger your document, the more the agent never has to read. The spec itself is written in GEML; clone it and check for yourself.

Hooking up an agent takes one line:

```console
$ claude mcp add geml -- npx -y @geml/geml@latest mcp --root /abs/path/to/docs
```

The tools share the CLI's verbs (`geml set` → `geml_set`); every write is parsed before it lands, a write that would corrupt the document is rejected with diagnostics, and a block-level history entry is saved before each write.

## Boundaries

Said once, never repeated.

**It is not a database.** Queries are O(N) scans over a character stream — no indexes; concurrency tops out at a whole-file lock; there are no cross-file transactions. What it borrows from databases is the **operational semantics** — locate by key, verify references, fetch to embed, roll back one block — not the runtime properties. Putting it under high-concurrency read/write load is using the wrong layer.

**The ecosystem is brand new.** GitHub does not render `.geml` natively; converting existing Markdown in is lossy; models start out less fluent in it than in Markdown; and there is exactly one implementation — the second, independent one is an open call.

**Verification does not catch bad prose.** It catches structural damage and broken references. If an agent writes something stupid, verification will not say a word.

## Who this is for

If you have an agent maintaining a growing technical document — a spec, a runbook, a knowledge base — over the long term, and you have already been bitten by "fixed the right place, quietly broke another", these four laws are what you are missing — **whether you end up using GEML or building your own thing that satisfies them**.

If you have never been bitten, Markdown is doing fine.

And if you are reading this and thinking "I could implement these four better" — you are exactly the reader we are hoping for: the conformance suite is public, a second independent implementation is what this spec needs most right now, and the way in is [Status & contributing](https://github.com/geml-spec/geml/blob/main/README.md#status--contributing) in the README.

This manifesto has no signature page. Writing one file in the GEML format is signing it.
