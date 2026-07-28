# geml `revert` — the block-level undo (history phase)

Date: 2026-07-24
Status: approved (brainstorming) — pending implementation plan
Supersedes: §4.5 of `2026-07-24-geml-block-mutation-cli-design.md` (there marked
DEFERRED to the history phase). This is that phase's forward-facing design.

## 1. Purpose & framing

The block-mutation CLI (`set`/`add`/`delete`/`rename`) gives an agent the forward
edits. This phase gives it the **undo**: `revert` is the block-level counterpart
that reads the `.gemlhistory` substrate and puts one block back.

`revert` and `history` are two faces of the *same* substrate, not the same
feature:

| | `history` | `revert` |
|---|---|---|
| level | version store / timeline | a single edit action |
| granularity | whole document × one revision | one `#id` block / section |
| does | `commit` snapshots; `log`/`show`/`verify` inspect; `restore` rolls the *whole* doc back | splices one block's historical version into the *current* doc (incl. resurrecting a deleted block) |
| vs substrate | *is* the version store | *reads* it (requires a prior `history commit`) |
| git analogy | `commit` / `log` / `show` / `reset --hard <rev>` | `checkout <rev> -- <one unit>`, but finer (block-level) |
| belongs to | version management | the editing verbs (`get`/`set`/`add`/`delete`/`rename`/`revert`) |

### The unifying model: `revert` = undo = inverse operation

`revert #id --rev R` means **"make `#id` look like it did at revision R."** The
three actions it can take are exactly the inverses of the three block-level
forward verbs:

| forward | inverse (= `revert`) | who executes it | needs history? |
|---|---|---|---|
| `add` (absent → present) | **delete** (present → absent) | `revert` (remove) *or* `delete` | remove: yes |
| `delete` (present → absent) | **add / resurrect** (absent → present) | `revert` (resurrect) | yes |
| `set` (old → new content) | **splice back** (new → old) | `revert` (splice) | yes |
| `rename` (old → new id) | `rename` (new → old id) | **`rename` itself** | no |

Three of the four inverses route through `revert`'s history-backed reconcile;
`rename` is its own stateless inverse and stays out of the reconcile family
(see §7 for why the reconcile model *cannot* undo a rename).

## 2. Command surface

```
geml revert <file.geml> #id [--rev <sel>] [--changed]
            [--after #x | --before #x | --append]   # resurrect only
            [--head] [--dry-run] [-o out] [--history PATH]
```

- `<sel>` (`--rev`): `-N` (N revisions back) | `latest` | id-prefix. **Default `-1`.**
  > **Superseded (2026-07-28).** `latest` (and its alias `current`) were removed from
  > the resolver; passing either now fails with `revision selector "latest" matched 0
  > revisions`. The tip is selected with `0`, which `history log` prints as its first
  > column. Current surface: `0` | `-N` | id-prefix, plus `--changed`. This line is
  > left as the record of what was designed on 2026-07-24.
- Input must be a real file (it reads that file's `.gemlhistory`); `-` is a usage
  error — unchanged from today.
- Output: writes **in place** by default (revert is a mutation); `-o` redirects,
  `-o -` forces stdout — consistent with `set`/`add`/`delete`/`rename`.

## 3. Core algorithm — reconcile `#id` to revision R

Reconstruct R's full text and extract `#id` → `oldBlock` (may be absent). Read
the current document → `curBlock` (may be absent). Act on the pair:

| `curBlock` | `oldBlock` | action | undoes | message |
|---|---|---|---|---|
| present (differs) | present | **splice** old over current | `set` | `reverted #id to R` |
| absent (deleted) | present | **resurrect** — insert old (see §5) | `delete` | `resurrected #id from R at <where>` |
| present | absent (didn't exist) | **remove** current | `add` | `removed #id (absent at R)` |
| present (identical) | present | no-op | — | `#id is unchanged at R; nothing to revert` |
| absent | absent | error | — | `#id exists in neither the document nor R (try --changed)` |

Every write is **guarded**: after the splice/insert/remove, reparse and refuse
to write if it introduces an `error` diagnostic or drops an *unrelated* id.
Per action the guard also asserts the intended id outcome — present after
splice/resurrect, gone after remove. `--dry-run` prints the action and the block
that would land, writing nothing.

## 4. `--rev` and `--changed`

- **`--rev <sel>` (default `-1`)** — state-addressed: jump `#id` to how it was at
  exactly that revision. May cross several changes in one step.
- **`--changed`** — change-addressed ("undo the last change to *this* block"):
  walk back to `#id`'s previous *distinct* state, skipping revisions that never
  touched it. Cases:
  - `#id` present now → its previous distinct version (today's behavior).
  - `#id` deleted now → the most recent revision that still contained `#id`
    (i.e. the version just before deletion → resurrect it).
  - `#id` just added (no earlier revision *has* it) → `--changed` finds no prior
    distinct version and reports so. Undo-an-add targets a revision where the
    block was absent via `--rev` (e.g. `--rev -1`), which the reconcile resolves
    to a *remove*. (`--changed` lands only on revisions where the block exists,
    so "previous state = absence" is not a `--changed` target — by design.)

The default stays `-1` (not `--changed`): `revert #id` undoes to one commit back,
which is the common "edit → commit → oops → revert" path. `--changed` is the
opt-in for skipping commits that didn't touch the block.

## 5. Resurrect position — anchor inference + override

When resurrecting (block absent now), its old textual slot is gone; the new
block's insertion point is chosen as:

1. **Preceding anchor** — in R's ordered id list, the nearest addressable id
   *before* `#id` that still exists in the current document → insert **after** it.
2. Else **following anchor** — the nearest addressable id *after* `#id` in R that
   still exists now → insert **before** it.
3. Else — **append at end of document + warn** (`anchors gone; appended at end`).
4. **Override** — `--after #x` / `--before #x` / `--append` force the position,
   bypassing inference (reusing `add`'s position vocabulary for consistency).

Anchors are addressable ids only (typed blocks, headings, footnote defs); bare
prose is not an anchor. A resurrect that would collide with an existing id is
impossible by construction (resurrect only fires when `#id` is absent), but the
reparse guard still runs.

## 6. Per-command undo map (deliverable — also into the parser README)

| forward edit | how you undo it | needs `.gemlhistory`? |
|---|---|---|
| `set #id` | `revert #id` (splice prior version) | yes |
| `delete #id` | `revert #id` (resurrect) | yes |
| `add #id` | `revert #id` (remove) **or** `delete #id` | remove: yes / delete: no |
| `rename #old #new` | `rename #new #old` (self-inverse) | no |

## 7. `rename` × history boundary (documented limitation this phase)

Because the history diff engine keys blocks by `#id`, a `rename #old #new` commit
is recorded as **delete `#old` + add `#new`** on two different ids. So a
`revert` that crosses a rename boundary misfires under the reconcile model:

- `revert #new --rev R` (R predates the rename): `#new` is absent at R → the
  reconcile would **remove** `#new` (delete the block). Wrong.
- `revert #old --rev R`: `#old` is present at R but `#new` still exists now →
  resurrecting `#old` yields **two** copies. Wrong.

The reconcile model works per-id and therefore *cannot* compute a rename's
inverse. This phase does **not** try to. Instead:

- **Undoing a rename** is `rename #new #old` — stateless, self-inverse, no history.
- **Cross-rename content revert** (revert a block's content to *before* a rename)
  is a documented limitation: `rename` the id back first, revert, then rename
  forward again — or select by the old id.
- **Guards** (a rename shows up as body-identical content under a *different* id;
  match on the body — the block minus its id — since rename changes only the id):
  - `rename #old #new` **warns** when `#old` has recorded history
    (`#old has history; revert across this rename is not tracked — see docs`).
  - **resurrect direction** — `revert #old` about to resurrect a block whose body
    matches an existing block `#X` in the current doc → hint + refuse:
    `#old looks renamed to #X; use 'rename #X #old' to undo the rename` (avoids a
    duplicate copy).
  - **remove direction** — `revert #new` about to remove a block whose body
    matches a block under a *different* id `#Y` present at R → hint + refuse:
    `#new looks renamed from #Y; revert would delete it — use 'rename #new #Y'`
    (avoids silently deleting a renamed-in block, the dangerous direction).

Integrity constraint that rules out the alternative: `.gemlhistory` stores a
content-hash + reverse-patch chain, and `verify` reconstructs each revision and
checks `hash(reconstructed bytes) == recorded hash`. Rewriting `#old → #new` in
stored revisions would change their reconstructed bytes (hash mismatch → `verify`
fails) and would corrupt the historical record (`restore` of an old revision
would return `#new` where the real past had `#old`). A faithful, integrity-safe
solution — a **rename lineage log** so `revert #new` follows `#new`'s prior life
as `#old` — is a clean future upgrade, explicitly out of scope here.

## 8. Errors & messages (stderr; exit codes unchanged: 0 ok / 1 op error / 2 usage)

- `-` input → `revert needs a real file (it reads that file's .gemlhistory)` (2).
- both absent → `#id exists in neither the document nor R (try --changed)` (1).
- no-op (identical) → informational on stderr, exit 0, no write.
- history-layer failures (missing/corrupt sidecar, bad selector) → formatted via
  the existing `historyError(...)` path (1).
- `--head` + resurrect → usage error `--head cannot resurrect a deleted block`
  (2). `--head` remains valid for splice (head-line only) and is a no-op-or-error
  case for remove (removing a head line alone is ill-defined → usage error).
- guard refusal → `not written: <reason>` (1), nothing written.

## 9. Non-goals / limitations

- Cross-rename content revert (see §7) — needs a lineage log, deferred.
- `redo` is not a first-class verb: after a `revert`, `history commit` then
  `revert` again returns to the prior state — sufficient, not formalized.
- Bare prose has no id and is not addressable by `revert`.
- `revert` never batches multiple ids (unlike `delete`); it is one block per call
  by design (a single, inspectable undo).

## 10. Test cases (prepared per task, run together at the end)

- **splice** — set then commit then revert restores prior content (regression of
  today's behavior).
- **resurrect** — delete + commit + revert with: preceding anchor present;
  only a following anchor present; all anchors gone → append + warn;
  `--after #x` / `--before #x` / `--append` override.
- **remove** — add + commit + revert removes the added block.
- **no-op** — revert to an identical revision → message, exit 0, no write.
- **both absent** — error + `--changed` hint, exit 1.
- **`--changed`** — present-now (previous distinct version) and deleted-now
  (last revision that had the block).
- **`--dry-run`** — for splice, resurrect, and remove: prints, writes nothing.
- **`-o` / `-o -`** — redirect and stdout.
- **guard** — a malformed splice/insert that would break the doc is refused.
- **`--head`** — splice head-only works; `--head` + resurrect → usage error.
- **rename boundary** — `rename` warns when the old id has history; `revert`
  resurrecting an id whose content matches an existing block hints + refuses.

## 11. Scope note

Forward-facing new code is essentially **one thing** — the reconcile that adds
the *resurrect* and *remove* cells (today's `revert` only splices and hard-fails
the rest) — plus the two `rename`×history guards in §7. `add`- and `rename`-undo
reuse verbs that already exist. No parser/renderer semantics change; this is CLI
+ tests + the README undo map. Version bump decided at release (a `revert`
default/behavior change is minor-to-major; not bumped in this phase).
