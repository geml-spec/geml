# geml-history profile v1 — a mergeable change graph

*English | [中文](geml-history-profile_CN.md)*

## Application-layer profile (Stable)

| Field | Value |
|-------|-------|
| Profile | `geml-history/v1`, declared as `profile =` in `=== meta` (§1.1) |
| Nature | An application layer over GEML 1.0 (see [`GEML-spec.md`](../../GEML-spec.md)), not part of it |
| Status | Stable |
| File extension | `.gemlhistory` |
| Tooling | `geml history save\|get\|restore\|verify\|merge\|setup-git` |

---

## Abstract

This profile defines a versioning layer for GEML that merges. A document keeps
its current version in its `.geml` file. A sibling file with the same base name
and the extension `.gemlhistory` records the document's history as a **change
graph**: every change names the changes it follows, carries forward operations
addressed by block, and is identified by a hash over its parents and its
content. Two copies of a history merge by taking the union of their changes,
and replaying a set of changes in one deterministic order gives every
implementation the same document. When two changes that did not know about each
other touch one block, the change later in that order wins and the other is
reported; it stays in the history.

The model is the object tree of any-sync, the protocol Anytype synchronizes
with: changes with several parents, heads, snapshots, content-derived ids. The
payload is GEML's own: plain-text block operations a person or an agent can
read. The file is self-contained, needs no version-control system and no online
service, and is produced and verified by tooling.

## Contents

1. [Scope and relationship to GEML](#1-scope-and-relationship-to-geml)
2. [File roles](#2-file-roles)
3. [The `.gemlhistory` document](#3-the-gemlhistory-document)
4. [Block keys](#4-block-keys)
5. [Operations](#5-operations)
6. [Ids and hashes](#6-ids-and-hashes)
7. [Replay](#7-replay)
8. [The snapshot](#8-the-snapshot)
9. [Recording a change](#9-recording-a-change)
10. [Merging](#10-merging)
11. [Restore and revert](#11-restore-and-revert)
12. [A sidecar in the earlier format](#12-a-sidecar-in-the-earlier-format)
13. [Conformance](#13-conformance)
14. [Tooling and AI usage (informative)](#14-tooling-and-ai-usage-informative)

## Conventions

The key words **MUST**, **MUST NOT**, **MAY**, **SHOULD** and **SHOULD NOT** carry the
requirement levels defined in the core specification. A **change** is one
recorded edit of the document, identified by its **id** (§6). A change's
**parents** are the changes it follows; a change no other change names as a
parent is a **head**. The **live file** is the working copy `doc.geml`.

---

## 1. Scope and relationship to GEML

This profile adds no grammar to GEML. It rides on the typed-block primitive
(core §3), the attribute object (§4) and ids (§5). A processor that does not
implement it is unaffected: the `.geml` file remains a complete, valid GEML
document on its own.

The history layer is **optional** in the sense core §8.6 gives that word: a
processor that has never heard of `geml-history/v1` is fully conformant, and
this document binds only tools that choose to implement it.

### 1.1 Declaring the vocabulary

`.gemlhistory` declares its vocabulary like any other document:

```geml
=== meta
profile      = "geml-history/v1"
history-of   = "budget.geml"
geml-version = "1.0"
===
```

The declaration admits this profile's four block types and their attribute keys;
without it a conforming processor reports each of them as `unknown-block-type`
(core §8.2(6)), which is correct behaviour, not a defect.

| Block type | Attribute keys | Defined in |
|---|---|---|
| `history-change` | `id`, `parents`, `author`, `summary`, `newline`, `state`, `was` | §3, §6, §12 |
| `history-snapshot` | `heads`, `hash`, `newline` | §8 |
| `history-units` | — | §8 |
| `history-blob` | `lang` | §3, §5 |

`history-blob` also carries an ordinary `{#id}`, which needs no admitting.

There is **no implicit detection** — not from the `.gemlhistory` extension, not
from `history-of` (core §8.6.2 rule 2). Admission licenses names only: all four
types are `raw` (§8.6.2 rule 4), so a document reads the same whether or not it
declares the profile.

---

## 2. File roles

For a document `doc.geml`:

- **`doc.geml`** is the **current version** and the hot path: read, edited and
  rendered by ordinary GEML tools. It is the source of truth for the current
  version.
- **`doc.gemlhistory`** is the **history**: the change graph, the blobs its
  operations name, and a snapshot of the document its heads replay to (§8),
  which mirrors the live file after every recorded change.

Because the snapshot is in the history file, reading the current state needs no
replay, and every past state can be rebuilt without the live file. If the
history file is lost, the document is still intact in `doc.geml`.

---

## 3. The `.gemlhistory` document

A `.gemlhistory` file is itself a GEML document:

| Type | Role |
|------|------|
| `meta` | header: `profile`, `history-of` (the live file's base name), `geml-version` |
| `history-snapshot` | the document the current heads replay to, verbatim (§8) |
| `history-units` | how the snapshot's text divides into blocks, with their keys (§8) |
| `history-change` | one change: metadata in attributes, operations in the body (§5) |
| `history-blob` | a block's text, named by operations |

`history-snapshot` and `history-blob` bodies hold GEML verbatim, so their
opening fence MUST be longer than the longest fence inside (core §3).

```
# History of budget.geml

=== meta
profile      = "geml-history/v1"
history-of   = "budget.geml"
geml-version = "1.0"
===

==== history-snapshot {heads="20261009T100800Z-7e41c0a9d2b3" hash="sha256:…" newline=lf}
# Budget plan

=== table {#budget caption="Annual cost"}
| Plan  | Months | Rate |
|-------|-------:|-----:|
| Basic |      1 |   30 |
===

Vendor lock-in is the main risk.
====

=== history-units
~3f9a1c2e 2
#budget 6
~7d02b4e1 1
-~0b7d55e1
===

=== history-change {id="20261009T100800Z-7e41c0a9d2b3" parents="20261009T100500Z-3f9a11e0b7c4 20261009T100700Z-9c8d22f1a6e5" summary="Merge" newline=lf state="sha256:…"}
===

=== history-change {id="20261009T100700Z-9c8d22f1a6e5" parents="20261009T100000Z-1a2b44c0e9f7" author="anytype" summary="Rate from the app" newline=lf state="sha256:…"}
update #budget <- blob:b-90e1d7a3c2f0
===

==== history-blob {#b-90e1d7a3c2f0 lang=geml}
=== table {#budget caption="Annual cost"}
…
===

====
```

**Layout (recommended).** Physical order does not affect meaning. A tool
SHOULD write `meta`, the snapshot and its unit list, then the changes newest
first (the reverse of replay order, §7), each followed by the blobs it is the
newest change to name.

---

## 4. Block keys

Operations address blocks by **key**.

- A document is tiled into **units** that together reproduce it byte for byte.
  A unit is a typed block — from its opening fence to the line that closes it as
  core §3 says, an equal-length `=` run or, when the block has an id, its
  labeled fence `=== #id` — or a **flow segment**: a maximal run of consecutive
  non-blank lines that open no fence. Each unit owns the blank lines that follow
  it; blank lines before the first unit are a unit of their own.
- A unit with an id — a typed block's `#id`, or the explicit `{#id}` on the
  heading that opens a flow segment — has the key `#<id>`. The first unit in
  document order to carry an id has that key; a later unit repeating it is
  treated as a unit without one.
- A unit without an id has a tool-assigned key: `~` followed by eight lowercase
  hexadecimal digits, unique among every key the history has used. These keys
  live only in the history file and are **never written into the live
  document**.

Ids remain optional in the language; this profile mandates none. A tool
SHOULD encourage an explicit `#id` on blocks that need a stable identity across
edits and renames.

---

## 5. Operations

A `history-change` body is a list of operations, one per line, applied in the
order written. An **anchor** is `at-start` or `after <key>`.

| Operation | Effect |
|---|---|
| `create <key> <anchor> <- blob:<id>` | a block with this key and text, placed at the anchor |
| `update <key> <- blob:<id>` | the block's text becomes the blob's |
| `remove <key>` | the block is removed (it stays as a tombstone, §7) |
| `move <key> <anchor>` | the block moves to the anchor |

A blob's text is the unit's whole text: its lines and the blank lines it owns.
Every `blob:<id>` MUST name a `history-blob` in the same file.

---

## 6. Ids and hashes

- A **state hash** is `sha256:` followed by the lowercase hexadecimal SHA-256 of
  a document's exact UTF-8 bytes, in the newline style its change records
  (`newline=lf` or `crlf`).
- A change's `state` is the state hash of the document the change and all of its
  ancestors replay to (§7).
- A **blob id** is `b-` followed by the first 12 hexadecimal digits of the
  SHA-256 of its text. Equal texts share one blob, and the union of two
  histories cannot assign one id to two texts.
- A **change id** is `<timestamp>-<hash12>`. `<timestamp>` is the time of the
  change in UTC basic ISO-8601 (`YYYYMMDDTHHMMSSZ`). `<hash12>` is the first 12
  hexadecimal digits of the SHA-256 of these lines, joined with LF:

  ```
  parents <the parent ids, sorted, joined with one space>
  author <author, or nothing>
  summary <summary, or nothing>
  newline <lf|crlf>
  state <state>
  was <was>            (only when the change carries one, §12)
  <each operation line, in order>
  --
  <for each operation that names a blob, in order: the blob id, then its text>
  ```

  A change's id therefore covers its parents' ids: altering any change alters
  the id every later change depends on.

`parents` is absent on a root change. Tools accept, as a **selector**, an id or
an unambiguous prefix or suffix of one, `0` for the current head, and `-N` for
the change N places before it in replay order.

---

## 7. Replay

**Order.** A set of changes closed under ancestry replays in one order: a change
comes after all of its parents; among changes whose parents have all been
replayed, the one with the smaller id (compared as strings) comes first. Ids
begin with their time, so changes that did not know about each other replay
oldest first.

**Model.** Replay keeps an ordered list of **entries**, each a key, a text and a
flag saying whether the block is alive. It starts empty. Each change's
operations apply in order:

| Operation | The key is alive | The key is a tombstone | The key is unknown |
|---|---|---|---|
| `create` | its text is set; it stays where it is | its text is set and it comes back alive at the anchor | a new entry at the anchor |
| `update` | its text is set | no effect | error |
| `remove` | it becomes a tombstone | no effect | error |
| `move` | it moves to the anchor | it moves to the anchor | error |

`at-start` places an entry first; `after <key>` places it directly after that
entry, alive or not. An anchor naming an unknown key, or the entry being placed,
is an error. Tombstones keep their place, so an anchor a concurrent change
removed still resolves.

**Settling.** After each change's operations, for every two consecutive alive
entries *a* and *b*: when *a* does not begin with a typed-block opening line,
*a*'s last line is not blank, and *b*'s first line is neither blank nor a
typed-block opening line, a blank line is appended to *a*. Two paragraphs a
merge leaves side by side would otherwise read as one. A change recorded from a
document (§9) never needs this; it applies only where concurrent changes
interleave.

**The document** is the text of the alive entries, in order, joined.

**Lost edits.** Where changes that did not know about each other meet one block,
the order decides, and a processor MUST report the loser:

- an `update` or `create` that replaces text a non-ancestor change set: the later
  change is kept, the earlier one lost;
- a `remove` of a block whose text a non-ancestor change set: the removal is
  kept, the edit lost;
- an `update` of a block a non-ancestor change removed: the removal is kept, the
  edit lost.

A replacement by identical text is not a loss. The losing change stays in the
history; its document can be rebuilt and its block restored (§11).

---

## 8. The snapshot

`history-snapshot` holds the document the current heads replay to, verbatim. Its
`heads` lists the heads it was made for, sorted; `hash` is its state hash in
`newline`'s style. The `history-units` block that follows lists the model's
entries in order, one per line: an alive entry as `<key> <number of lines>`, a
tombstone as `-<key>`. The alive entries' line counts MUST sum to the snapshot's
line count; reading the snapshot's text in those counts gives each entry its
text.

The snapshot is a cache: replaying every change from the start is the
definition, and a snapshot whose `heads` are not the current heads is stale and
is not used. A tool MUST rewrite the snapshot whenever it records a change.

---

## 9. Recording a change

Saving the live file records one change whose parents are the current heads and
whose operations take the current state to the live file. A tool:

- pairs units by key, first the ones with ids;
- SHOULD pair units without ids whose text is identical, keeping their keys; a
  pair out of order is a `move`;
- SHOULD treat an unpaired old unit and an unpaired new unit standing at the same
  place between paired neighbours as the same block edited (`update`), so that a
  paragraph edited in place keeps its key;
- records the rest as `create` and `remove`;
- MUST verify, before writing, that applying the operations to the current state
  reproduces the live file byte for byte, and write nothing when it does not;
- records nothing when the live file is the current state and there is one head.

A `summary` or `author` containing a line break MUST be refused: an attribute has
no escape for one.

---

## 10. Merging

Two histories of one document merge by **union**: every change and every blob of
either. A change id names one change and a blob id one text; the same id with
different content is corruption. After a union with several heads, a tool joins
them with a change whose parents are all the heads and which has no operations;
its `state` is the document the union replays to. Merging is commutative: either
copy merging the other reaches the same document, and — given the same time and
author for the joining change — the same change.

A history may hold several heads; reading it replays all of them. The next
recorded change joins them.

**Replicas.** A tool keeping a document in step with another holder of it — an
app, another device — records that holder's state as a change whose parent is
the change the holder last had, then joins the heads. The live file need not be
involved until the merge is written to it.

**git.** A `.gemlhistory` is a single file, which git's line merge would treat
as conflicting text. `geml history setup-git` registers a merge driver that
merges the two sides by union; the live `.geml` is merged by git as usual, and
the next save records whatever git produced.

---

## 11. Restore and revert

Nothing is removed from a history. Restoring the document to a change writes
that change's document to the live file and records it as a new change;
reverting one block does the same for that block. A processor MUST NOT discard
uncommitted changes in the live file without the caller's explicit consent — an
interactive confirmation, or a force option in scripted or agent use — and
SHOULD point to `save` as the way to keep them.

---

## 12. A sidecar in the earlier format

A sidecar whose blocks are `history-revision` and `history-keyframe` is in the
format this profile used before the change graph: a linear chain of reverse
patches. A processor MAY read such a sidecar by rebuilding every revision,
checking each against the hash it recorded, and recording the revisions in order
as changes; the first save then writes the change graph. Each converted change
carries the revision's id as `was`, and selectors match it.

---

## 13. Conformance

A conforming history processor MUST:

1. treat `doc.geml` as the source of truth for the current version and render it
   without requiring `doc.gemlhistory`;
2. parse `doc.gemlhistory` as a conforming GEML document;
3. replay changes in the order and with the operation semantics of §7, including
   settling, so that any set of changes gives the same document in every
   implementation;
4. compute state hashes, blob ids and change ids as §6 defines them;
5. report as **errors**: an id that does not match its content; a blob whose id
   does not match its text; a parent, blob or anchor that does not resolve; an
   operation on an unknown key; a change whose replayed document does not match
   its `state`; a cycle; two changes or two snapshots under one id or in one file;
   a snapshot whose units do not cover its text, or that does not match the
   document its heads replay to;
6. report as **warnings**, never blocking a read: every lost edit (§7); several
   heads; a live file that differs from the current state;
7. never discard a change, and never discard uncommitted live edits without
   consent (§11);
8. write `profile = "geml-history/v1"` into every `.gemlhistory` it writes;
9. NOT mandate ids on any block, and NOT depend on git or any online service.

The profile's [`conformance.json`](conformance.json) holds sidecars a processor
must verify with no error, the number of changes it must replay, and the edits
it must report as lost.

---

## 14. Tooling and AI usage (informative)

The history file is generated and verified by tooling. Recording a change needs
exact unit extraction, key bookkeeping, fence-length handling and hashing —
error-prone by hand, for agents as for people. An agent reads and edits the live
`doc.geml` freely; it MAY read `doc.gemlhistory` to see how and why the document
changed (every change carries a summary and an author); it SHOULD NOT write
changes, blobs, keys or ids by hand, and calls the tool instead (`save`, `get`,
`restore`, `verify`, `merge`).

Because the history travels with the document as a plain-text sibling, it is
available offline, survives copying, and can be merged with another copy of
itself without a server.
