# geml `revert` history-phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: this plan is executed **inline in this session** (user directive: no subagents, no background). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `revert` into the block-level undo — reconcile one `#id` to a past revision, adding the *resurrect* (undo delete) and *remove* (undo add) cells alongside today's *splice* (undo set), with anchor-inferred resurrect placement and two `rename`×history safety guards.

**Architecture:** Rewrite the single `runRevert(args)` function in `src/geml.ts` into a four-cell reconcile driven by `(curBlock, oldBlock)` presence, reusing existing guarded-write helpers (`spliceBlock`, `insertFragment`) and history helpers (`resolveContent`, `firstChangedContent`). Add one placement helper (`resurrectPosition`) and reuse `normalizeBlockId` (from `block-edit.ts`) for the rename-victim guards. No parser/renderer change.

**Tech Stack:** TypeScript → `tsc` → `dist/`; tests are `.mjs` driving `dist/geml.js` via `spawnSync`, aggregated by `test/all.mjs`; coverage via c8 (`npm run coverage:check`).

## Global Constraints

- Branch: **`claude/geml-command-consistency-q45khg`** — do not switch branches.
- Change surface: **`src/geml.ts` + `test/revert.test.mjs` + the three READMEs only.** No parser/renderer/history-module semantics change.
- Commits under the user's git identity (`xiongjy2104`); **NO model attribution** (no Co-Authored-By / Generated-with). Use `git -c core.hooksPath=/dev/null commit` to skip the code-graph hook.
- Default `--rev` stays **`-1`**.
- `revert` output: in-place for a file (default); `-o path` redirects; `-o -` → stdout. `--dry-run` writes nothing.
- **Execution mode (user directive):** per task — write the test cases, run `npm run build` (tsc typecheck only), then commit. **Defer running the suites + coverage to the final task**, run inline/foreground.
- Reuse (do not reinvent): `blockSpans`, `splitLines`, `narrowToHead`, `spliceBlock`, `insertFragment`, `positionals`, `flag`, `readInput`, `resolverFor`, `parse`, `historyPathFor`, `historyError`, `normalizeBlockId`; history imports `resolveContent`, `firstChangedContent`.

---

## File structure

- **Modify** `geml-parser/src/geml.ts`:
  - rewrite `runRevert` (currently ~1617–1674) into the reconcile;
  - add helper `resurrectPosition(...)` next to it;
  - add the two rename-victim guards inside `runRevert`;
  - add the history warning to `runRename` (~1453);
  - update `SUBHELP.revert` and the `USAGE` revert line;
  - add `existsSync` to the `node:fs` import.
- **Modify** `geml-parser/test/revert.test.mjs`: update one existing case (`#nope` → both-absent message), append resurrect/remove/position/guard cases.
- **Modify** `geml-parser/README.md`, `README.md`, `README_CN.md`: add the per-command undo map + updated `revert` surface (parser README authoritative; root/CN mirror briefly).

---

### Task V1: reconcile core — splice + resurrect + remove + placement

**Files:**
- Modify: `geml-parser/src/geml.ts` (`runRevert`, new `resurrectPosition`, `SUBHELP.revert`, `USAGE`, fs import)
- Test: `geml-parser/test/revert.test.mjs`

**Interfaces:**
- Consumes: `blockSpans(source): Map<string,Span>` (Span `{start,end}`, physical-line coords, document order); `splitLines(s): string[]` (lines keep EOLs); `narrowToHead(span): Span`; `spliceBlock(source,id,replacement,file,headOnly?): string`; `insertFragment(source,lines,at,fragment,file): string`; `resolveContent(historyPath,sel): {id,text}`; `firstChangedContent(historyPath,current,pick): {id,text}|undefined`; `historyPathFor`, `historyError`, `positionals`, `flag`, `readInput`.
- Produces: `runRevert(args: string[]): void`; `resurrectPosition(source, revText, id, before?, after?, append, file): {at:number; where:string; warn:boolean}`.

- [ ] **Step 1: add `existsSync` to the fs import** (needed in Task V2; harmless now)

In `geml-parser/src/geml.ts`, the `node:fs` import — add `existsSync`:

```ts
import { writeFileSync, readFileSync, realpathSync, existsSync } from "node:fs";
```
(Merge into the existing `node:fs` import line; keep whatever else it already imports.)

- [ ] **Step 2: replace `runRevert` with the reconcile**

Replace the whole current `function runRevert(...) { ... }` body (the block ending at the `console.error(\`reverted ...\`)` line) with:

```ts
function runRevert(args: string[]): void {
  const changed = args.includes("--changed");
  const dryRun = args.includes("--dry-run");
  const headOnly = args.includes("--head");
  const out = flag(args, "-o") ?? flag(args, "--out");
  const to = flag(args, "--rev") ?? "-1";
  const before = flag(args, "--before");
  const after = flag(args, "--after");
  const append = args.includes("--append");
  if ((append ? 1 : 0) + (before !== undefined ? 1 : 0) + (after !== undefined ? 1 : 0) > 1) {
    fail("revert takes at most one position: --append | --before #id | --after #id", 2);
  }
  const [file, rawId] = positionals(args, ["--rev", "--history", "-o", "--out", "--before", "--after"]);
  if (!file || !rawId) fail(SUBHELP.revert);
  if (file === "-") fail("revert needs a real file (it reads that file's .gemlhistory)", 2);
  const id = rawId.replace(/^#/, "");
  const historyPath = flag(args, "--history") ?? historyPathFor(file);

  const source = readInput(file);
  const curFull = blockSpans(source).get(id);            // undefined => absent now
  const curBlock = curFull === undefined ? undefined : ((): string => {
    const span = headOnly ? narrowToHead(curFull) : curFull;
    return splitLines(source).slice(span.start, span.end).join("");
  })();

  // Extract #id's block from a reconstructed revision (undefined => absent there).
  const pick = (text: string): string | undefined => {
    const s = blockSpans(text).get(id);
    if (!s) return undefined;
    const span = headOnly ? narrowToHead(s) : s;
    return splitLines(text).slice(span.start, span.end).join("");
  };

  const target = ((): { id: string; text: string } => {
    try {
      if (changed) {
        const found = firstChangedContent(historyPath, curBlock ?? "", pick);
        if (!found) fail(`no earlier revision changes \`${id}\``, 1);
        return found;
      }
      return resolveContent(historyPath, to);
    } catch (e) {
      fail(historyError(e, file, historyPath), 1);
    }
  })();

  const oldBlock = pick(target.text);                     // undefined => absent at R

  // Common write path (bespoke message; -o path redirects; -o - -> stdout).
  const emit = (updated: string, verb: string): void => {
    const dest = out ?? file;
    if (dest === "-") process.stdout.write(updated);
    else writeFileSync(dest, updated);
    console.error(`${verb}${dest === file ? "" : dest === "-" ? " -> stdout" : ` -> ${dest}`}`);
  };

  // both absent
  if (curBlock === undefined && oldBlock === undefined) {
    fail(`\`${id}\` exists in neither the document nor ${target.id} (try --changed)`, 1);
  }

  // both present -> SPLICE (undo set) — today's behaviour
  if (curBlock !== undefined && oldBlock !== undefined) {
    if (oldBlock === curBlock) {
      console.error(`#${id} is unchanged at ${target.id}; nothing to revert${changed ? "" : " (try --rev -2, or --changed)"}`);
      return;
    }
    if (dryRun) {
      console.error(`would revert #${id} to ${target.id}:`);
      process.stdout.write(oldBlock.endsWith("\n") ? oldBlock : oldBlock + "\n");
      return;
    }
    emit(spliceBlock(source, id, oldBlock, file, headOnly), `reverted #${id} to ${target.id}`);
    return;
  }

  // --head is only meaningful for the splice cell
  if (headOnly) {
    fail("--head only applies when the block exists in both the document and the target revision", 2);
  }

  // absent now, present at R -> RESURRECT (undo delete)
  if (curBlock === undefined && oldBlock !== undefined) {
    // [Task V2 inserts the resurrect-direction rename guard here]
    const { at, where, warn } = resurrectPosition(source, target.text, id, before, after, append, file);
    if (dryRun) {
      console.error(`would resurrect #${id} from ${target.id} at ${where}:`);
      process.stdout.write(oldBlock.endsWith("\n") ? oldBlock : oldBlock + "\n");
      return;
    }
    if (warn) console.error(`warning: anchors for #${id} are gone; appended at end`);
    emit(insertFragment(source, splitLines(source), at, oldBlock, file), `resurrected #${id} from ${target.id} at ${where}`);
    return;
  }

  // present now, absent at R -> REMOVE (undo add)
  // [Task V2 inserts the remove-direction rename guard here]
  if (dryRun) {
    console.error(`would remove #${id} (absent at ${target.id})`);
    return;
  }
  const span = curFull!;
  const beforeIds = parse(source, { resolveDoc: resolverFor(file) }).ids;
  const updated = splitLines(source).filter((_, i) => i < span.start || i >= span.end).join("");
  const reparsed = parse(updated, { resolveDoc: resolverFor(file) });
  const errs = reparsed.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) {
    const first = errs[0]!;
    fail(`removing #${id} would break the document: ${first.message} (line ${first.line}); not written`, 1);
  }
  const now = new Set(reparsed.ids);
  const dropped = beforeIds.find((x) => x !== id && !now.has(x));
  if (dropped !== undefined) fail(`removing #${id} would drop block \`#${dropped}\`; not written`, 1);
  emit(updated, `removed #${id} (absent at ${target.id})`);
}
```

- [ ] **Step 3: add the `resurrectPosition` helper** immediately after `runRevert`

```ts
// Choose the physical-line insertion point for a resurrected block. Explicit
// --append/--before/--after win; otherwise infer from the block's neighbours in
// revision R: the nearest id BEFORE it that still exists now (insert after it),
// else the nearest id AFTER it that still exists (insert before it), else append
// at end (warn=true). Anchors are addressable ids; the deleted block's own former
// descendants are naturally skipped (they are absent now too).
function resurrectPosition(
  source: string, revText: string, id: string,
  before: string | undefined, after: string | undefined, append: boolean, file: string,
): { at: number; where: string; warn: boolean } {
  const lines = splitLines(source);
  const here = blockSpans(source);
  if (append) return { at: lines.length, where: "end", warn: false };
  if (before !== undefined) {
    const a = before.replace(/^#/, "");
    const s = here.get(a);
    if (!s) fail(`no block with id \`${a}\` in ${file}`, 1);
    return { at: s.start, where: `before #${a}`, warn: false };
  }
  if (after !== undefined) {
    const a = after.replace(/^#/, "");
    const s = here.get(a);
    if (!s) fail(`no block with id \`${a}\` in ${file}`, 1);
    return { at: s.end, where: `after #${a}`, warn: false };
  }
  const revIds = [...blockSpans(revText).keys()];
  const idx = revIds.indexOf(id);
  for (let i = idx - 1; i >= 0; i--) {
    const s = here.get(revIds[i]!);
    if (s) return { at: s.end, where: `after #${revIds[i]}`, warn: false };
  }
  for (let i = idx + 1; i < revIds.length; i++) {
    const s = here.get(revIds[i]!);
    if (s) return { at: s.start, where: `before #${revIds[i]}`, warn: false };
  }
  return { at: lines.length, where: "end", warn: true };
}
```

- [ ] **Step 4: update `SUBHELP.revert` and the `USAGE` revert line**

`SUBHELP.revert` (currently the `usage: geml revert ...` string) →

```ts
  revert: "usage: geml revert <file.geml> #id [--rev <sel>] [--changed] [--append|--before #x|--after #x] [--head] [--dry-run] [-o out]  (reconcile #id to a revision: splice / resurrect / remove; sel: -N | latest | id-prefix; default -1)",
```

`USAGE` revert line (currently `geml revert <file.geml> #id [--rev <sel>] [--head]   restore ONE block to a past revision`) →

```
  geml revert <file.geml> #id [--rev <sel>] [--head]   undo one block to a past revision (splice / resurrect / remove)
```

- [ ] **Step 5: update the existing `#nope` test to the both-absent message**

In `test/revert.test.mjs`, the case `"revert on an unknown id exits 1 with a clean error"` — change the message assertion (a truly-absent id is now the both-absent branch):

```js
test("revert on an id absent from both the doc and the target exits 1 cleanly", () => {
  reset();
  const r = run(["revert", geml, "#nope"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /exists in neither the document nor /);
});
```

- [ ] **Step 6: append the resurrect / remove / placement test cases**

Insert before the `// -- history log` section. Each builds its own fixture (like the section/`--head` cases):

```js
// -- resurrect / remove (the new reconcile cells) --------------------------

test("resurrect: a deleted block returns between its surviving neighbours", () => {
  const g = p("res.geml"), h = p("res.gemlhistory");
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#b}\nbbb\n===\n\n=== note {#c}\nccc\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(8) });
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#c}\nccc\n===\n");   // delete #b
  const r = run(["revert", g, "#b", "--rev", "-1"]);
  assert.equal(r.code, 0, r.err);
  const s = read(g);
  assert.ok(s.includes("=== note {#b}\nbbb\n==="), "#b resurrected");
  assert.ok(s.indexOf("#a") < s.indexOf("#b") && s.indexOf("#b") < s.indexOf("#c"), "between #a and #c");
  assert.match(r.err, /resurrected #b .* at after #a/);
});

test("resurrect: no preceding anchor falls back to the following one", () => {
  const g = p("res2.geml"), h = p("res2.gemlhistory");
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#b}\nbbb\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(9) });
  writeFileSync(g, "=== note {#b}\nbbb\n===\n");   // delete #a (the first block)
  const r = run(["revert", g, "#a", "--rev", "-1"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(read(g).indexOf("#a") < read(g).indexOf("#b"), "#a before #b");
  assert.match(r.err, /at before #b/);
});

test("resurrect: all anchors gone -> append at end + warn", () => {
  const g = p("res3.geml"), h = p("res3.gemlhistory");
  writeFileSync(g, "=== note {#x}\nxxx\n===\n\n=== note {#y}\nyyy\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(10) });
  writeFileSync(g, "=== note {#z}\nzzz\n===\n");   // x and y gone, z is new
  const r = run(["revert", g, "#x", "--rev", "-1"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /anchors for #x are gone; appended at end/);
  assert.ok(read(g).indexOf("#z") < read(g).indexOf("#x"), "#x appended after #z");
});

test("resurrect: --after overrides the inferred position", () => {
  const g = p("res4.geml"), h = p("res4.gemlhistory");
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#b}\nbbb\n===\n\n=== note {#c}\nccc\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(11) });
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#c}\nccc\n===\n");   // delete #b
  const r = run(["revert", g, "#b", "--rev", "-1", "--after", "#c"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(read(g).indexOf("#c") < read(g).indexOf("#b"), "#b after #c (override)");
});

test("remove: reverting an added block deletes it (undo add)", () => {
  const g = p("rem.geml"), h = p("rem.gemlhistory");
  writeFileSync(g, "=== note {#a}\naaa\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(12) });
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#new}\nnnn\n===\n");   // add #new (uncommitted)
  const r = run(["revert", g, "#new", "--rev", "-1"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!read(g).includes("#new"), "#new removed");
  assert.ok(read(g).includes("=== note {#a}\naaa\n==="), "#a untouched");
  assert.match(r.err, /removed #new \(absent at /);
});

test("--dry-run resurrect prints the block and writes nothing", () => {
  const g = p("dr.geml"), h = p("dr.gemlhistory");
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#b}\nbbb\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(13) });
  writeFileSync(g, "=== note {#a}\naaa\n===\n");
  const before = read(g);
  const r = run(["revert", g, "#b", "--rev", "-1", "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes("=== note {#b}\nbbb\n==="));
  assert.equal(read(g), before, "file not written");
});

test("--head cannot resurrect a deleted block (usage error)", () => {
  const g = p("hd.geml"), h = p("hd.gemlhistory");
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#b}\nbbb\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(14) });
  writeFileSync(g, "=== note {#a}\naaa\n===\n");
  const r = run(["revert", "--head", g, "#b", "--rev", "-1"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--head only applies/);
});
```

- [ ] **Step 7: typecheck** — `cd geml-parser && npm run build` — expect no TS errors (do NOT run the suites yet).

- [ ] **Step 8: commit**

```bash
git add geml-parser/src/geml.ts geml-parser/test/revert.test.mjs
git -c core.hooksPath=/dev/null commit -m "feat(cli): revert reconciles a block to a revision — splice/resurrect/remove + anchor placement"
```

---

### Task V2: rename × history guards

**Files:**
- Modify: `geml-parser/src/geml.ts` (`runRevert` two guard sites; `runRename` history warning)
- Test: `geml-parser/test/revert.test.mjs`

**Interfaces:**
- Consumes: `normalizeBlockId(blockSrc, newId): string` (from `./block-edit.js`, already imported — rewrites a block's id across every head form; two blocks are "the same modulo id" iff their normalized forms are equal); `existsSync`; `resolveContent`.

- [ ] **Step 1: resurrect-direction guard** — at the `[Task V2 inserts the resurrect-direction rename guard here]` marker in `runRevert` (inside the resurrect branch, before `resurrectPosition`):

```ts
    const cmpKey = normalizeBlockId(oldBlock, "__cmp__");
    for (const [cid, cs] of blockSpans(source)) {
      if (cid === id) continue;
      const csrc = splitLines(source).slice(cs.start, cs.end).join("");
      if (normalizeBlockId(csrc, "__cmp__") === cmpKey) {
        fail(`#${id} looks renamed to #${cid}; use 'rename #${cid} #${id}' to undo the rename`, 1);
      }
    }
```

- [ ] **Step 2: remove-direction guard** — at the `[Task V2 inserts the remove-direction rename guard here]` marker (inside the remove cell, before the `dryRun` check):

```ts
  {
    const cmpKey = normalizeBlockId(curBlock!, "__cmp__");
    for (const [rid, rs] of blockSpans(target.text)) {
      if (rid === id) continue;
      const rsrc = splitLines(target.text).slice(rs.start, rs.end).join("");
      if (normalizeBlockId(rsrc, "__cmp__") === cmpKey) {
        fail(`#${id} looks renamed from #${rid}; revert would delete it — use 'rename #${id} #${rid}'`, 1);
      }
    }
  }
```

- [ ] **Step 3: rename history warning** — in `runRename`, after the `if (before.ids.includes(newId)) fail(...)` line and before `rewriteId`:

```ts
  if (file !== "-") {
    const hp = historyPathFor(file);
    if (existsSync(hp)) {
      try {
        if (blockSpans(resolveContent(hp, "latest").text).has(oldId)) {
          console.error(`warning: #${oldId} has history; revert across this rename is not tracked — see docs`);
        }
      } catch { /* unreadable/empty history: no warning */ }
    }
  }
```

- [ ] **Step 4: append the guard test cases** (before `// -- history log`)

```js
// -- rename x history guards -----------------------------------------------

test("rename warns when the old id has recorded history", () => {
  const g = p("rn.geml"), h = p("rn.gemlhistory");
  writeFileSync(g, "=== note {#old}\nbody\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(15) });
  const r = run(["rename", g, "#old", "#new"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /#old has history; revert across this rename is not tracked/);
  assert.ok(read(g).includes("=== note {#new}\nbody\n==="), "rename still applied");
});

test("revert refuses to resurrect a rename victim (points to rename)", () => {
  const g = p("rv1.geml"), h = p("rv1.gemlhistory");
  writeFileSync(g, "=== note {#a}\nsame body\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(16) });
  writeFileSync(g, "=== note {#b}\nsame body\n===\n");   // as if renamed #a -> #b
  const r = run(["revert", g, "#a", "--rev", "-1"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /#a looks renamed to #b; use 'rename #b #a'/);
  assert.ok(read(g).includes("#b") && !read(g).includes("#a"), "no duplicate written");
});

test("revert refuses to remove a rename victim (the dangerous direction)", () => {
  const g = p("rv2.geml"), h = p("rv2.gemlhistory");
  writeFileSync(g, "=== note {#old}\nsame body\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(17) });
  writeFileSync(g, "=== note {#new}\nsame body\n===\n");   // as if renamed #old -> #new
  const r = run(["revert", g, "#new", "--rev", "-1"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /#new looks renamed from #old; revert would delete it/);
  assert.ok(read(g).includes("#new"), "block not deleted");
});
```

- [ ] **Step 5: typecheck** — `cd geml-parser && npm run build` — expect no TS errors.

- [ ] **Step 6: commit**

```bash
git add geml-parser/src/geml.ts geml-parser/test/revert.test.mjs
git -c core.hooksPath=/dev/null commit -m "feat(cli): rename/revert guards — warn on renamed-away history, refuse revert of a rename victim"
```

---

### Task V3: docs — the per-command undo map

**Files:**
- Modify: `geml-parser/README.md` (CLI section), `README.md`, `README_CN.md`

- [ ] **Step 1: parser README** — in the CLI prose (after the mutation/output paragraph), add the undo map:

```markdown
Undo is `revert`, which reconciles one block to a past revision (`--rev`, default
`-1`): it **splices** back changed content, **resurrects** a deleted block
(placed by its old neighbours, or `--append`/`--before`/`--after`), or **removes**
a block that did not exist then. So each forward edit has an inverse:

| forward edit | undo |
|---|---|
| `set #id` | `revert #id` (splice) |
| `delete #id` | `revert #id` (resurrect) |
| `add #id` | `revert #id` (remove) — or `delete #id` |
| `rename #old #new` | `rename #new #old` (self-inverse) |

`revert` reads the `.gemlhistory` sidecar, so `set`/`delete`/`add` undo needs a
prior `geml history commit`; `rename` is its own inverse and needs no history.
```

Also update the parser README `revert` line in the CLI code block to:

```sh
geml revert doc.geml '#id' [--rev -1]     # undo a block: splice / resurrect / remove
```

- [ ] **Step 2: root `README.md`** — add one line under the Ecosystem "Versioned History" bullet (after the existing `geml revert` sentence):

```markdown
`revert` is the block-level undo: it splices changed content back, resurrects a deleted block, or removes one that did not exist at the target revision — the inverse of `set`/`delete`/`add` (and `rename` undoes itself with `rename #new #old`).
```

- [ ] **Step 3: `README_CN.md`** — mirror under the 「历史版本化」bullet:

```markdown
`revert` 就是块级 undo:把改动过的内容 splice 回去、复活已删的块、或删掉在目标修订版里根本不存在的块——正好是 `set`/`delete`/`add` 的逆(`rename` 用 `rename #new #old` 自我撤销)。
```

- [ ] **Step 4: commit**

```bash
git add geml-parser/README.md README.md README_CN.md
git -c core.hooksPath=/dev/null commit -m "docs(readme): per-command undo map + revert splice/resurrect/remove surface"
```

---

### Task Final: full suite + coverage (inline, foreground)

- [ ] **Step 1: run the whole suite**

```bash
cd geml-parser && npm test
```
Expected: all suites pass, `0` occurrences of `not ok`, `revert.test.mjs` shows its new count of `test(s) passed`.

- [ ] **Step 2: coverage gate**

```bash
cd geml-parser && npm run coverage:check
```
Expected: exit 0; `All files` line ≥ 95 on statements/branch/functions/lines.

- [ ] **Step 3: if anything fails**, fix inline (source or test), re-run Step 1–2. No commit needed if only re-running; commit any fix with a plain message under the user identity.

- [ ] **Step 4: report** the suite + coverage numbers to the user. (Version bump deliberately NOT done — `revert` behaviour change is minor-to-major, decided at release.)

---

## Self-Review

**Spec coverage** (against `2026-07-24-geml-revert-history-phase-design.md`):
- §3 reconcile four cells → Task V1 (splice/resurrect/remove/no-op/both-absent). ✅
- §4 `--rev -1` default + `--changed` (present & deleted) → V1 (`firstChangedContent(curBlock ?? "")`). ✅ undo-add-via-`--changed` is intentionally not a target (spec §4 note). ✅
- §5 resurrect placement (preceding/following anchor, append+warn, overrides) → V1 `resurrectPosition`. ✅
- §6 undo map → Task V3. ✅
- §7 rename×history guards (rename warn, both-direction hint+refuse; integrity rationale unchanged) → Task V2. ✅
- §8 errors/messages (`-` usage, both-absent, no-op, history errors via `historyError`, `--head`+resurrect/remove usage, guard refusal) → V1/V2. ✅ (`--head` collapses remove+resurrect into one usage check — cleaner than the spec's separate wording; equivalent.)
- §10 tests → V1/V2 cases; §11 scope (CLI+tests+README only, no version bump) → Global Constraints + Task Final. ✅

**Placeholder scan:** none — every step carries real code or an exact command. The two `[Task V2 inserts ...]` markers are intentional insertion anchors, resolved in V2.

**Type consistency:** `resurrectPosition` returns `{at,where,warn}`, destructured identically in `runRevert`. `emit(updated, verb)` used at all three write sites. `normalizeBlockId(src, sentinel): string` used identically in both guards. `pick`/`curBlock` are `string | undefined` throughout; `firstChangedContent` gets `curBlock ?? ""`.
