# GEML History — Versioning & Reconstruction Extension

*English | [中文](GEML-history-spec_CN.md)*

## Companion Specification (Draft)

| Field | Value |
|-------|-------|
| Extends | GEML 1.0 (see [`GEML-spec.md`](GEML-spec.md)) |
| Version | 1.0 |
| Status | Draft |
| File extension | `.gemlhistory` |

---

## Abstract

This companion specification defines a self-contained versioning layer for GEML.
A document keeps its **current** version, and only that version, in its `.geml`
file. A sibling file with the same base name and the extension `.gemlhistory`
records the document's history as **reverse deltas from the current version**,
together with full **keyframe** snapshots. The history file is *self-contained*:
it always carries a tool-maintained keyframe mirroring the committed current
version, so any past revision can be reconstructed — and the live file rolled
back to any past revision — without depending on the live `.geml`, on an
external version-control system, or on any online service. The two files
deliberately separate the **hot path** (the current version, read and edited
constantly) from the **cold path** (history, loaded only when needed). The
history file is produced and verified by tooling; consumers (including AI agents)
read it as plain text.

## Contents

1. [Scope and relationship to GEML](#1-scope-and-relationship-to-geml)
2. [File roles](#2-file-roles)
3. [The `.gemlhistory` document](#3-the-gemlhistory-document)
4. [Block identity and ids](#4-block-identity-and-ids)
5. [Reverse-patch operations](#5-reverse-patch-operations)
6. [Reconstruction](#6-reconstruction)
7. [Rollback](#7-rollback)
8. [Revision ids, integrity and hashing](#8-revision-ids-integrity-and-hashing)
9. [Conformance](#9-conformance)
10. [Tooling and AI usage (informative)](#10-tooling-and-ai-usage-informative)

## Conventions

The key words **MUST**, **MUST NOT**, **MAY**, and **SHOULD** carry the
requirement levels defined in the core specification. A **revision** is one
recorded state of the document, identified by a commit **id** (§8); **current**
denotes the latest revision. The **live file** is the working copy `doc.geml`;
**committed current** denotes the content recorded for the current revision in
the history file.

---

## 1. Scope and relationship to GEML

This extension adds no new grammar to GEML. Versioning rides entirely on the
existing typed-block primitive (§3 of the core spec), the attribute object (§4),
and stable ids and references (§5). A processor that does not implement this
extension is unaffected: the `.geml` file remains a complete, valid GEML
document on its own, renderable by any ordinary GEML tool.

The history layer is **optional**. Its presence is signalled only by the
existence of a sibling `.gemlhistory` file.

---

## 2. File roles

For a document `doc.geml`:

- **`doc.geml`** — the **canonical current version** and the hot path. It is the
  file read, edited, and rendered by ordinary GEML tools that know nothing of
  this extension; it is the **source of truth** for the current version. It
  stays small and clean regardless of how long history grows.
- **`doc.gemlhistory`** — the **self-contained history**. It records the
  committed current version as a tool-maintained **keyframe** (a mirror of
  `doc.geml`, refreshed on every commit), plus reverse deltas and periodic
  keyframes for earlier revisions.

Ownership is unambiguous: the live `doc.geml` is the source of truth for the
current version; the committed-current keyframe inside `doc.gemlhistory` is a
tool-maintained mirror, never hand-edited, and the two are reconciled by the
hash check (§8).

Two consequences follow:

- **Self-containment.** Because the history file carries the committed current
  version, reconstruction of any revision does **not** depend on the live file
  and works even when the live file has uncommitted changes or is absent.
- **Graceful degradation.** Conversely, if `doc.gemlhistory` is lost or damaged,
  the current document is still fully intact in `doc.geml`; only the recoverable
  history is affected.

---

## 3. The `.gemlhistory` document

A `.gemlhistory` file is itself a GEML document. The history extension registers
four block types:

| Type | Body mode | Role |
|------|-----------|------|
| `meta` | data | history-file header (one `key=val` per line) |
| `revision` | raw | one entry per revision: metadata in attributes, reverse-patch operations in the body |
| `blob` | raw | a verbatim payload (a block's content at some revision), referenced by id from patch operations |
| `keyframe` | raw | a verbatim full snapshot of a revision's complete `.geml` content |

A keyframe for the **current** revision is always present (the committed-current
mirror); further keyframes appear periodically (see `keyframe-interval`).

Because `keyframe` and `blob` bodies embed whole GEML fragments verbatim, their
opening fence MUST be longer than the longest fence inside the payload (core
spec §3); a payload that uses `===` is wrapped in `====`, and so on.

### 3.1 Header (`=== meta`)

| Key | Meaning |
|-----|---------|
| `history-of` | base name of the live file, e.g. `"doc.geml"` |
| `geml-version` | GEML language version the history conforms to |
| `current` | the id of the current revision (§8) |
| `keyframe-interval` | recommended number of revisions between keyframe snapshots |

### 3.2 Example

```
# History of budget.geml

=== meta
history-of        = "budget.geml"
geml-version      = "1.0"
current           = "20260617T103012Z-33ab12cd"
keyframe-interval = 10
===

# Committed-current mirror (always present):

==== keyframe {id="20260617T103012Z-33ab12cd" hash="sha256:33ab12cd…"}
# Budget plan

=== meta
title = "Budget plan"
===

=== table {#budget caption="Annual cost"}
| Plan  | Months | Rate |
|-------|-------:|-----:|
| Basic |      1 |   25 |
===

=== note {#risks}
Vendor lock-in is the main risk.
===
====

=== revision {id="20260617T103012Z-33ab12cd" parent="20260501T140000Z-22cd34de" author="george" summary="Add risk note; revise budget rate" hash="sha256:33ab12cd…"}
delete #risks
replace #budget <- blob:b-22cd34de-budget
===

==== blob {#b-22cd34de-budget lang=geml}
=== table {#budget caption="Annual cost"}
| Plan  | Months | Rate |
|-------|-------:|-----:|
| Basic |      1 |   30 |
===
====

=== revision {id="20260501T140000Z-22cd34de" parent="20260410T091500Z-11ef56ab" author="george" summary="Remove legacy rate note" hash="sha256:22cd34de…"}
insert <- blob:b-11ef56ab-legacy after #budget
===

==== blob {#b-11ef56ab-legacy lang=geml}
=== note {#legacy}
Legacy rate basis, retained for reference.
===
====

=== revision {id="20260410T091500Z-11ef56ab" author="george" summary="Initial draft" hash="sha256:11ef56ab…"}
===
```

The root revision is a `revision` with **no** reverse-patch body and no
`parent`: it has no predecessor. A `revision` whose payload would otherwise
require deep fence nesting MUST carry that payload as a separate top-level
`blob`, referenced as `blob:<id>`. (Inline payload wrapped in a longer fence is
permitted but discouraged, because correct fence-length nesting is error-prone.)

**Block ordering (recommended).** Physical order does not affect correctness —
a processor indexes blocks by type and by revision id regardless of position.
For readability and streaming efficiency, however, a `.gemlhistory` file
**SHOULD** be laid out **newest-first**: `meta`, then the committed-current
`keyframe`, then `revision` blocks from current back to the root, with each
`blob` placed immediately after the `revision` that references it. This aligns
the file's top-to-bottom order with the reverse-patch walk (§6), puts the
most-read entries (the current mirror and the most recent changes) first, and
lets a reader that needs only recent revisions stop early. `meta` **MAY** carry
an index of interval-keyframe ids so that older entry points can be sought
without scanning.

---

## 4. Block identity and ids

Reverse patches address blocks by **block identity** (distinct from a *revision*
id, §8):

<<<<<<< HEAD
- If a block carries an explicit `#id`, that id is its identity.
- Otherwise the tool derives a stable key from the block's content hash and its
  structural position (anchored to the nearest id-bearing block or heading).
  Identity bookkeeping for id-less blocks lives in the `.gemlhistory` file and is
  **never written back** into the live `.geml`.
=======
- 若块带显式 `#id`，该 id 即其身份。
- 否则由工具依据块的内容哈希与结构位置（锚定到最近的带 id 块或标题）派生一个稳定键。
  id-less 块的身份记账存放于 `.gemlhistory` 文件，**绝不回写**活动的 `.geml`。
- 流式块（标题、段落、列表）同样可按派生键寻址，因此逆向补丁可锚定到散文位置，而不仅是
  带围栏的块。
>>>>>>> 06e276b (feat(geml-parser): history 差分泛化——id-less 块派生键 + 块相邻 move)

Block ids remain **optional** in the language; this extension does NOT mandate
ids on any block. Two properties make mandatory ids unnecessary:

1. **Keyframes are full snapshots**, so block matching is used only to make the
   delta between adjacent revisions compact — never to guarantee the correctness
   of a reconstruction. When an id-less block cannot be matched confidently, the
   delta degrades to a coarser whole-block replacement, and the nearest keyframe
   remains an exact fallback.
2. **Headings auto-derive ids** (core spec §4), so section-level anchors are
   always available even with no explicit ids in the document.

Tools **SHOULD** record an explicit `#id` on blocks that are likely to be
referenced or revised and that need stable cross-version identity (tables,
diagrams, notes, significant sections). *Caveat:* a heading's auto-derived id is
a function of its text, so renaming a heading changes its id and a differ will
see the change as a delete-plus-add rather than a rename. Stable tracking across
renames requires an explicit id.

---

## 5. Reverse-patch operations

A `revision` body is a line-oriented list of operations that transform the
content of a revision into the content of its `parent`. A **block-key** is
`#<id>` for an id-bearing block, or a tool-derived key token for an id-less
block. An **anchor** is one of `at-start`, `at-end`, `after <block-key>`, or
`before <block-key>`.

| Operation | Undoes (in the newer revision) | Effect (toward the parent) |
|-----------|--------------------------------|----------------------------|
| `delete <block-key>` | an added block | remove the block |
| `replace <block-key> <- blob:<id>` | a modified block | set the block's content to the parent's payload |
| `insert <- blob:<id> <anchor>` | a removed block | re-insert the block with its parent-revision content at the anchor |
| `move <block-key> <anchor>` | a moved block | reposition the block |

Operations within a revision are applied in the order written. Every `blob:<id>`
reference MUST resolve to a `blob` block in the same `.gemlhistory` file; an
unresolved reference is a build **error**, consistent with the core spec's
reference-validation rule (§5).

---

## 6. Reconstruction

To reconstruct (view) the document at a target revision *R* (read-only; the
files are not modified):

1. Select the nearest keyframe at *R* or newer on the chain. The history file
   always contains a keyframe for the current revision (the committed-current
   mirror); additional `keyframe` blocks provide earlier entry points.
   Reconstruction therefore does **not** depend on the live `doc.geml` and works
   even when the live file has uncommitted changes or is absent.
2. Apply reverse patches backward along the `parent` chain, one revision at a
   time, until *R* is reached.
3. Verify the result: the hash of the reconstructed content MUST equal the
   `hash` recorded for *R* (§8).

Keyframes bound the number of reverse steps for any target revision and confine
the impact of a corrupted patch to a single inter-keyframe segment. Reverse
patches for every consecutive revision pair are retained so that any step is
available; keyframes are additional and serve as bounded, verifiable entry
points.

---

## 7. Rollback

Rollback rewrites the live file to a past revision and continues from there.
History is **linear**: there is no branching and no merge.

Because the history file is self-contained (§2), the reconstruction of the
target revision does not depend on the current state of the live file.

**Uncommitted-changes policy.** Rollback overwrites the live file. If
`doc.geml` has uncommitted changes (§8), a processor **MUST NOT** discard them
implicitly: it **MUST** refuse the rollback unless the caller explicitly
consents to discarding them — an interactive confirmation, or an explicit force
option in non-interactive (scripted or agent) use. The processor **SHOULD**
point to `commit` as the way to preserve the current edits instead.

To roll back to a revision *R*:

1. Reconstruct revision *R* (§6).
2. Write the reconstructed content to the live `doc.geml`.
3. Truncate the history so that *R* becomes `current`: discard every `revision`
   and `keyframe` newer than *R* on the chain, and the `blob` blocks referenced
   only by those discarded revisions; refresh the committed-current keyframe to
   *R*; set `meta.current` to *R*'s id.

Rollback is **destructive**: the revisions after *R* (including the former
current revision) are permanently discarded and are not recoverable. A
subsequent edit is committed as a new revision with a fresh id (a new
timestamp); ids are never reused, so a post-rollback revision can never be
confused with the discarded tip. (A tool MAY, as an optional safeguard, snapshot
the discarded tip before truncation; this is not required.)

---

## 8. Revision ids, integrity and hashing

- Each version's content `hash` is **SHA-256** over the exact UTF-8 bytes of
  that version's complete `.geml` content, written in hexadecimal and prefixed
  `sha256:`. Every `revision` records the `hash` of the version it represents;
  the committed-current keyframe records the `hash` of the current revision.
- A revision's **id** is `<timestamp>-<short>`, where `<timestamp>` is the commit
  time in UTC basic ISO-8601 (`YYYYMMDDTHHMMSSZ`) and `<short>` is the first 8
  hexadecimal characters of that version's content `hash` (the eight after the
  `sha256:` prefix). Ids therefore sort chronologically and are unique in
  practice. The full `hash` — never the 8-character short form — is what
  reconstruction is verified against. A `parent` is the id of the preceding
  revision; the root revision has no `parent`. Tools accept any unambiguous id
  prefix (e.g. the short hash, or the timestamp) as a selector.

Two conditions of differing severity are distinguished:

- **Corruption → error.** A broken `parent` chain (a revision's `parent` is not
  the id of the revision before it, or the chain does not reach the root), an
  unresolved `blob:` reference, or a reconstruction whose hash does not match the
  recorded hash indicate that the history itself is damaged and **MUST** be
  reported as errors.
- **Uncommitted changes → warning.** A difference between `hash(doc.geml)` and
  the `hash` recorded for `current` means only that the live file has been
  edited since the last commit. This is a normal editing state, **not**
  corruption: it **MUST** be reported as a warning and **MUST NOT** block
  read-only operations (view, verify) or the reconstruction of any revision.

*Note (non-normative):* because the short id is derived from the version's
content hash rather than from a parent-binding commit hash, the id chain is not
cryptographically tamper-evident. For document history this is acceptable; an
implementation that needs tamper-evidence can keep the same `timestamp-<short>`
id format and derive `<short>` from `sha256(parent ‖ content ‖ metadata)`
instead, without any other change.

---

## 9. Conformance

A conforming history processor MUST:

1. Treat `doc.geml` as the sole source of truth for the current version and
   render it without requiring `doc.gemlhistory`.
2. Parse `doc.gemlhistory` as a conforming GEML document (core spec §3–§5).
3. Maintain a committed-current keyframe in the history file so that
   reconstruction is independent of the live file's state.
4. Reconstruct any revision (selected by its id) from the nearest keyframe at or
   newer than it on the chain by applying reverse patches, verify the result
   against the recorded hash, and do so even when the live file has uncommitted
   changes or is missing (§6, §8).
5. Report **errors** for corruption: a broken `parent` chain, an unresolved
   `blob:` reference, or a reconstruction whose hash does not match.
6. Report a difference between `hash(doc.geml)` and `current` as an
   **uncommitted-changes warning**, and never block read-only operations on it.
7. Perform rollback (§7) as a destructive, linear truncation, and **MUST NOT**
   discard uncommitted changes without the caller's explicit consent
   (confirmation or force).
8. NOT mandate ids on any block, and NOT depend on git or any online service.

---

## 10. Tooling and AI usage (informative)

The history file is **generated and verified by tooling**, not hand-authored.
Recording a revision (`commit`) refreshes the committed-current keyframe, writes
the reverse patch and any blobs, and records the new hash and id. Reverse
patches require exact block-content extraction, fence-length bookkeeping, and
hashing — operations that are error-prone to produce by hand (including for AI
agents). The recommended division of labour:

- An AI agent reads and edits the live `doc.geml` freely.
- An AI agent **MAY read** `doc.gemlhistory` (it is plain text, block-keyed, and
  carries a human-readable `summary` per revision) to understand how and why the
  document evolved — without git and without any online service.
- An AI agent **SHOULD NOT** hand-write reverse patches, blobs, ids, or hashes.
  Instead it invokes the history tool to record a revision (`commit`),
  reconstruct a revision (`show`/`view`), verify integrity (`verify`), or roll
  back (`restore`).

Because the history travels with the document as a sibling plain-text file, this
information is available offline, survives copying and forwarding, and is
self-describing — properties that out-of-band version control and online
document histories do not provide.
