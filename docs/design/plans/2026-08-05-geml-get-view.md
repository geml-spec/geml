# `geml get --view` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `--view` flag to `geml get` that walks an `embed` chain to the entity block it points at, plus the matching `view`/`part` parameters on the MCP `geml_get` tool.

**Architecture:** `--view` is defined as "resolve to the entity block", so it is the identity on every non-`embed` block and needs no type allowlist. The walk is a new function in `geml.ts` that repeatedly calls the existing `selectUnits` — a heading id already selects its whole section with the same boundary an embed fragment uses, so fragment selection needs no new logic. Provenance is written to stderr in a pinned format, which the MCP layer parses out of `runCli`'s already-captured stderr.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Node ≥22, no runtime deps. Tests are plain `node:assert` suites run by `test/all.mjs`.

**Design doc:** `docs/design/specs/2026-08-05-geml-get-view-design.md` — read it first. Section references below (§2, §3.3, §7.3 …) point into it.

## Global Constraints

- Branch: `feat/geml-get-view`. Do **not** merge to `main` — the branch is parked until the feature is wanted.
- Build: `cd geml-parser && npm run build` (i.e. `./node_modules/.bin/tsc`). Full suite: `node test/all.mjs` — never `npm test` inside another npm (Windows PATH overflow). Run the expensive suite **once**, at the end, and take output + exit code from that same run.
- Coverage gate: `npm run coverage:check` must pass — 95% lines/statements/functions/branches.
- **No new diagnostic code** (§3). Reuse `transclusion-cycle`, `unresolvable-document`, `unresolved-reference`, `embed-target-not-geml`, `unchecked-cross-document-reference`.
- **Do not touch `geml.ts`'s top-level imports or re-exports.** The viewer's esbuild stubs (`integrations/geml-viewer/src/render-html-stub.js`, node-stub) mirror them and esbuild fails the whole build on any missing named export.
- **Do not change spec files.** `--view` introduces no language semantics (§9).
- Never send a network request while walking a chain (§3.1).
- Exit codes: `1` = did not get the entity block; `2` = usage error. Never `0` with an empty stdout.
- Commit messages: plain, no AI attribution, under the user's git identity.

---

## File Structure

| File | Responsibility for this feature |
|---|---|
| `geml-parser/src/geml.ts` | `runGet` flag parsing (`--view`, `--root`); the new `viewResolve()` walker; provenance to stderr; `runSet` rejection of `--view`; `SUBHELP.get` text |
| `geml-parser/src/mcp.ts` | `geml_get` inputSchema gains `view` + `part`; `run` passes them through and returns `{from, content}` in view mode |
| `geml-parser/test/embed.test.mjs` | All CLI cases (13 groups) — embed semantics already live here |
| `geml-parser/test/mcp.test.mjs` | The 3 MCP cases |
| `geml-parser/skill/references/authoring.geml` + 2 mirrors | `#cli` section documents `--view` |

`viewResolve()` goes in `geml.ts` next to `relJoinPath`/`relDirPath` (~line 906) so it sits with the other pure path/chain helpers, and it must stay a local function — exporting it would touch the re-export surface the viewer stubs mirror.

---

## Task 1: `--view` walks one hop, with provenance and confinement

**Files:**
- Modify: `geml-parser/src/geml.ts` — `runGet` (~2411), new `viewResolve()` near `relJoinPath` (~915)
- Test: `geml-parser/test/embed.test.mjs`

**Interfaces:**
- Consumes: existing `selectUnits(source, file, rawSel, where) -> {units, all}`, `sliceUnit(source, span, headOnly, bodyOnly) -> string`, `relJoinPath(base, target)`, `relDirPath(p)`, `readInput(file)`, `fail(msg, code)`.
- Produces:
  ```ts
  // One fully-resolved entity block, with the document it actually came from.
  interface ViewResult { doc: string; text: string; unit: Unit; all: Addressed[]; from: string }
  // Resolves ONE selected unit to the entity block(s) it stands for.
  function viewResolve(source: string, file: string, unit: Unit, root: string): ViewResult[]
  ```
  **The return type is an array from the start, and the resolution is recursive.** A frame can look onto more than one entity block (`src=other.geml` is a whole document, a heading fragment is a whole section — §4.3), and a section reached that way can itself contain an `embed`, which "per-unit application" says must also be pierced. Returning `ViewResult[]` and recursing covers the single-block case as a one-element array; a single-unit signature would have to be widened in Task 3 and would leave Tasks 1–5 disagreeing about the type.
  `from` is `<doc>#<id>`, or just `<doc>` for a fragment-less whole-document target. It is `""` for the identity case (a non-embed block resolves to itself, so there is no other document to name). Every later task keeps this signature.

- [ ] **Step 1: Write the failing test**

In `test/embed.test.mjs`, after the existing tests:

```js
test("get --view reads through an embed window to the entity block", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-view-"));
  writeFileSync(join(dir, "part.geml"), "=== note {#tip}\nBorrowed body.\n===\n");
  writeFileSync(join(dir, "host.geml"), '=== embed {#e src="part.geml#tip"}\n===\n');
  const r = spawnSync(process.execPath, [CLI, "get", "host.geml", "#e", "--view"],
    { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "=== note {#tip}\nBorrowed body.\n===\n");
  assert.match(r.stderr, /^view: #e -> part\.geml#tip$/m, `provenance missing: ${r.stderr}`);
  // Without the flag the frame itself still comes back, unchanged.
  const plain = spawnSync(process.execPath, [CLI, "get", "host.geml", "#e"],
    { cwd: dir, encoding: "utf8" });
  assert.equal(plain.stdout, '=== embed {#e src="part.geml#tip"}\n===\n');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd geml-parser && node test/embed.test.mjs`
Expected: FAIL — stdout is the embed block, not the note (the flag is not parsed yet, so `--view` is ignored).

- [ ] **Step 3: Implement `viewResolve` (one hop) and wire the flag**

Add near `relDirPath` in `src/geml.ts`:

```ts
// `--view` (§2): resolve a selected unit to the ENTITY block it stands for.
// An embed block has no content of its own, so reading "what is here" means
// following `src=` into the target document — which §3 requires be parsed as a
// document in its own right, so each hop re-selects with the SAME selector
// grammar `get` uses. A heading fragment therefore selects its whole section
// for free: render.ts's findEmbedTarget documents that boundary as the one
// `geml get` already uses.
interface ViewResult { doc: string; text: string; unit: Unit; all: Addressed[]; from: string }

function viewResolve(source: string, file: string, unit: Unit, root: string): ViewResult[] {
  const src = unit.type === "embed" ? embedSrcOf(source, unit) : undefined;
  if (src === undefined) {
    // Identity on any non-embed block: it IS the entity block (§2.1).
    return [{ doc: file, text: source, unit, all: [], from: "" }];
  }
  const hash = src.indexOf("#");
  const docPath = hash < 0 ? src : src.slice(0, hash);
  const frag = hash < 0 ? undefined : src.slice(hash + 1);
  const rel = relJoinPath(relDirPath(file), docPath);
  const text = readConfined(rel, root);          // Task 4 gives this its errors
  const { units, all } = selectUnits(text, rel, `#${frag}`, rel);
  const from = `${rel}#${frag}`;
  // Task 2 makes this recursive (a target may itself be a frame) and Task 3
  // handles a fragment-less `src`. One hop, one element, for now.
  return [{ doc: rel, text, unit: units[0]!, all, from }];
}

// The `src=` of an embed unit, read off its head line (the unit carries the
// span, not the parsed attrs).
function embedSrcOf(source: string, unit: Unit): string | undefined {
  const head = sliceUnit(source, unit.span, true, false).trim();
  const braces = /\{[^}]*\}/.exec(head);
  if (!braces) return undefined;
  const v = parseAttrs(braces[0]).attrs["src"];
  return typeof v === "string" ? v : undefined;
}
```

In `runGet`, after the existing flag lines:

```ts
  const view = args.includes("--view");
```

and replace the text-output loop's body so a viewed unit is sliced out of the
hop's own document:

```ts
  for (const u of units) {
    if (!view) { process.stdout.write(sliceUnit(source, u.span, headOnly, bodyOnly)); continue; }
    for (const res of viewResolve(source, where, u, viewRoot)) {
      if (res.from !== "") console.error(`view: ${rawSel} -> ${res.from}`);
      process.stdout.write(sliceUnit(res.text, res.unit.span, headOnly, bodyOnly));
    }
  }
```

`viewRoot` for now is `relDirPath(where)`; Task 4 adds `--root` and moves this
loop behind a buffer so a failure emits nothing.

- [ ] **Step 4: Run the test to make sure it passes**

Run: `cd geml-parser && npm run build && node test/embed.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add geml-parser/src/geml.ts geml-parser/test/embed.test.mjs
git commit -m "get --view: read through an embed window to the entity block"
```

---

## Task 2: Multi-hop chains, cycles, and the depth limit

**Files:**
- Modify: `geml-parser/src/geml.ts` — `viewResolve`
- Test: `geml-parser/test/embed.test.mjs`

**Interfaces:**
- Consumes: `viewResolve` from Task 1, `EMBED_DEPTH_LIMIT` (already `const EMBED_DEPTH_LIMIT = 8` at ~765).
- Produces: `ViewError`; `oneHop(source, file, src, root) -> {doc, text, units, all, from}`; `viewResolve` gains the optional `depth`/`seen` parameters and recurses. Its public signature (first four parameters, `ViewResult[]` return) is unchanged.

- [ ] **Step 1: Write the failing tests**

```js
test("get --view follows a multi-layer chain to the entity block, not the next frame", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-view-multi-"));
  writeFileSync(join(dir, "c.geml"), "=== note {#leaf}\nDeepest.\n===\n");
  writeFileSync(join(dir, "b.geml"), '=== embed {#mid src="c.geml#leaf"}\n===\n');
  writeFileSync(join(dir, "a.geml"), '=== embed {#top src="b.geml#mid"}\n===\n');
  const r = spawnSync(process.execPath, [CLI, "get", "a.geml", "#top", "--view"],
    { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "=== note {#leaf}\nDeepest.\n===\n", "must land on C, not B's frame");
  assert.match(r.stderr, /view: #top -> c\.geml#leaf/);
});

test("get --view refuses a cyclic chain instead of looping", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-view-cycle-"));
  writeFileSync(join(dir, "x.geml"), '=== embed {#a src="y.geml#b"}\n===\n');
  writeFileSync(join(dir, "y.geml"), '=== embed {#b src="x.geml#a"}\n===\n');
  const r = spawnSync(process.execPath, [CLI, "get", "x.geml", "#a", "--view"],
    { cwd: dir, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /transclusion-cycle|cycle/);
  assert.equal(r.stdout, "", "must not emit a half-resolved block (§3.3)");
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd geml-parser && node test/embed.test.mjs`
Expected: the multi-hop test FAILS (stdout is B's frame — one hop only); the cycle test FAILS or times out.

- [ ] **Step 3: Make the walk a loop with a visited set**

First define the error type the walk throws — Task 4 reuses it, but it is thrown
here first, so it lands here:

```ts
class ViewError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
```

Then make `viewResolve` recursive, and split the single-hop body out into
`oneHop`:

```ts
// One hop: read the target document and select what the fragment names.
// Returns several units when the fragment names a section, or none is given
// (Task 3). `from` names where the content came from, for provenance.
function oneHop(source: string, file: string, src: string, root: string):
    { doc: string; text: string; units: Unit[]; all: Addressed[]; from: string } {
  const hash = src.indexOf("#");
  const docPath = hash < 0 ? src : src.slice(0, hash);
  const frag = hash < 0 ? undefined : src.slice(hash + 1);
  const rel = relJoinPath(relDirPath(file), docPath);
  const text = readConfined(rel, root);
  const { units, all } = selectUnits(text, rel, `#${frag}`, rel);
  return { doc: rel, text, units, all, from: `${rel}#${frag}` };
}

function viewResolve(source: string, file: string, unit: Unit, root: string,
                     depth = 0, seen: ReadonlySet<string> = new Set()): ViewResult[] {
  const src = unit.type === "embed" ? embedSrcOf(source, unit) : undefined;
  if (src === undefined) {
    return [{ doc: file, text: source, unit, all: [], from: "" }];   // entity block
  }
  if (depth >= EMBED_DEPTH_LIMIT) {
    throw new ViewError("depth",
      `chain still not on an entity block after ${EMBED_DEPTH_LIMIT} hops (the renderer expands no deeper either)`);
  }
  const hop = oneHop(source, file, src, root);
  // Same key shape as the check's cycle detector: a document plus what was
  // selected in it.
  const key = `${hop.doc}#${hop.units.map((u) => u.id ?? "").join(",")}`;
  if (seen.has(key)) {
    throw new ViewError("transclusion-cycle",
      `transclusion-cycle: \`${hop.from}\` is already being expanded in this chain`);
  }
  const nextSeen = new Set(seen).add(key);
  // Per-unit application, recursively: what a frame looks onto may itself be a
  // frame, and a section may hold a mix (§4.3).
  return hop.units.flatMap((u) => viewResolve(hop.text, hop.doc, u, root, depth + 1, nextSeen)
    // When the inner step was the identity it has no provenance of its own, so
    // carry this hop's — `from` must always name where the bytes came from.
    .map((r) => (r.from === "" ? { ...r, from: hop.from } : r)));
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd geml-parser && npm run build && node test/embed.test.mjs`
Expected: PASS. The cycle test must finish well under its 20 s timeout.

- [ ] **Step 5: Commit**

```bash
git add geml-parser/src/geml.ts geml-parser/test/embed.test.mjs
git commit -m "get --view: walk multi-layer chains, refuse cycles and over-deep chains"
```

---

## Task 3: Identity on non-embed blocks, per-unit application, whole-document targets

**Files:**
- Modify: `geml-parser/src/geml.ts` — `runGet` output loop
- Test: `geml-parser/test/embed.test.mjs`

**Interfaces:**
- Consumes: `viewResolve` (Tasks 1–2).
- Produces: no new symbols. Establishes that `--view` is applied per selected unit.

- [ ] **Step 1: Write the failing tests**

```js
test("get --view is the identity on a block that is not an embed", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-view-id-"));
  writeFileSync(join(dir, "part.geml"), "=== note {#tip}\nBorrowed body.\n===\n");
  const a = spawnSync(process.execPath, [CLI, "get", "part.geml", "#tip"], { cwd: dir, encoding: "utf8" });
  const b = spawnSync(process.execPath, [CLI, "get", "part.geml", "#tip", "--view"], { cwd: dir, encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.stdout, a.stdout, "an entity block resolves to itself (chain length 0)");
});

test("get --view applies per unit: a multi-match selector resolves each block", () => {
  // One embed and one plain note under the same heading: the embed is pierced,
  // the note is returned as-is, order preserved.
  const dir = mkdtempSync(join(tmpdir(), "geml-view-each-"));
  writeFileSync(join(dir, "part.geml"), "=== note {#tip}\nBorrowed.\n===\n");
  writeFileSync(join(dir, "host.geml"), [
    "## Sect {#s}", "",
    '=== embed {#e src="part.geml#tip"}', "===", "",
    "=== note {#own}", "Local.", "===", "",
  ].join("\n"));
  const r = spawnSync(process.execPath, [CLI, "get", "host.geml", "## Sect {#s}", "--view"],
    { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Borrowed\./, "the embed must be resolved");
  assert.match(r.stdout, /Local\./, "the sibling note must survive");
  assert.ok(r.stdout.indexOf("Borrowed.") < r.stdout.indexOf("Local."), "order must be preserved");
});

test("get --view on a fragment-less src resolves the WHOLE target document", () => {
  // `src=other.geml` (§4.3) is one frame onto many entity blocks. `meta` is
  // frontmatter, not content, so it is excluded — matching render.ts's
  // selectEmbed no-anchor branch.
  const dir = mkdtempSync(join(tmpdir(), "geml-view-whole-"));
  writeFileSync(join(dir, "part.geml"), [
    "=== meta", 'title = "T"', "===", "",
    "=== note {#one}", "First.", "===", "",
    "=== note {#two}", "Second.", "===", "",
  ].join("\n"));
  writeFileSync(join(dir, "host.geml"), '=== embed {#e src="part.geml"}\n===\n');
  const r = spawnSync(process.execPath, [CLI, "get", "host.geml", "#e", "--view"],
    { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /First\./);
  assert.match(r.stdout, /Second\./);
  assert.doesNotMatch(r.stdout, /title = /, "meta is frontmatter, not content");
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd geml-parser && node test/embed.test.mjs`
Expected: the identity test may already pass (Task 1 returns the unit unchanged); the per-unit test FAILS if the section path does not thread `--view` through every unit; the whole-document test FAILS with a selector built as `#undefined`.

- [ ] **Step 3: Confirm per-unit application, and make a fragment-less `src` mean the whole document**

The loop from Task 1 already iterates `units` — keep `viewResolve` inside it, and
keep `reportMatches` running first:

```ts
  if (units.length > 1) reportMatches(units[0]!.type ?? "", units);
```

Then handle the missing fragment. `oneHop` already returns `units: Unit[]` and
`viewResolve` already recurses over them (Tasks 1–2), so this is a change inside
`oneHop` only — no signature moves. When `frag` is undefined, select every
top-level block except `meta`, the same rule as `render.ts`'s `selectEmbed`
no-anchor branch (`render.ts:143`):

```ts
  if (frag === undefined) {
    // `src=other.geml`: the frame looks onto the whole document. `meta` is
    // frontmatter, not content.
    const every = allUnitsOf(text, rel);
    return { doc: rel, text, units: every.filter((u) => u.type !== "meta"), all: [], from: rel };
  }
```

`allUnitsOf` does not exist yet. **Do not invent a new selector string for it** —
`selectUnits` takes the documented selector grammar and `=== *` is not part of
it. Instead reuse whatever `listIds` (called in `runGet`'s `list` branch) uses to
enumerate a document's addressable blocks, and wrap it so it returns `Unit[]`.
Read `listIds` first and follow it; if it produces `Addressed[]` rather than
`Unit[]`, map through the same helper `selectUnits` uses internally.

Note the provenance shape this introduces: a whole-document hop has no `#`, so
its line reads `view: <sel> -> <doc>`. Task 8's pinned pattern must accept both
forms (`-> \S+`, not `-> \S+#\S+`).

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd geml-parser && npm run build && node test/embed.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add geml-parser/src/geml.ts geml-parser/test/embed.test.mjs
git commit -m "get --view: identity on entity blocks, applied per selected unit"
```

---

## Task 4: Failure semantics — all-or-nothing, `--root` confinement, no network

**Files:**
- Modify: `geml-parser/src/geml.ts` — `ViewError`, `readConfined`, `runGet`
- Test: `geml-parser/test/embed.test.mjs`

**Interfaces:**
- Consumes: `viewResolve`, `relJoinPath`, `relDirPath`, `ViewError` (defined in Task 2).
- Produces:
  ```ts
  function readConfined(rel: string, root: string): string   // throws ViewError
  ```
  `runGet` gains `--root` (default `relDirPath(file)`).

- [ ] **Step 1: Write the failing tests**

```js
test("get --view fails (exit 1, empty stdout) when the chain cannot reach an entity block", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-view-broken-"));
  writeFileSync(join(dir, "part.geml"), "=== note {#tip}\nBorrowed.\n===\n");
  const cases = [
    ['=== embed {#e src="gone.geml#tip"}\n===\n', /cannot resolve|unresolvable/],
    ['=== embed {#e src="part.geml#nosuch"}\n===\n', /unresolved reference|no block/],
    ['=== embed {#e src="notes.txt#tip"}\n===\n', /not a `?\.?geml|embed-target-not-geml/],
    ['=== embed {#e src="https://example.invalid/p.geml#tip"}\n===\n', /not checked|unchecked/],
  ];
  for (const [doc, why] of cases) {
    writeFileSync(join(dir, "host.geml"), doc);
    const r = spawnSync(process.execPath, [CLI, "get", "host.geml", "#e", "--view"],
      { cwd: dir, encoding: "utf8", timeout: 15_000 });
    assert.equal(r.status, 1, `${doc} should fail: ${r.stdout}`);
    assert.equal(r.stdout, "", `no half-product on stdout for ${doc}`);
    assert.match(r.stderr, why);
  }
});

test("get --view is all-or-nothing across a multi-match selector", () => {
  // Two embeds, the second broken: nothing at all is printed (§3.3).
  const dir = mkdtempSync(join(tmpdir(), "geml-view-allornothing-"));
  writeFileSync(join(dir, "part.geml"), "=== note {#tip}\nBorrowed.\n===\n");
  writeFileSync(join(dir, "host.geml"),
    '=== embed {#ok src="part.geml#tip"}\n===\n\n=== embed {#bad src="gone.geml#tip"}\n===\n');
  const r = spawnSync(process.execPath, [CLI, "get", "host.geml", "=== embed", "--view"],
    { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "", "the good one must not be emitted either");
  assert.match(r.stderr, /gone\.geml/, "stderr must name which one broke");
});

test("get --view will not read outside the confinement root", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-view-escape-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "secret.geml"), "=== note {#s}\nsecret\n===\n");
  writeFileSync(join(dir, "sub", "host.geml"), '=== embed {#e src="../secret.geml#s"}\n===\n');
  const r = spawnSync(process.execPath, [CLI, "get", join("sub", "host.geml"), "#e", "--view"],
    { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 1, "default root is the document's own directory");
  assert.equal(r.stdout, "");
  // Widening the root explicitly is allowed.
  const ok = spawnSync(process.execPath, [CLI, "get", join("sub", "host.geml"), "#e", "--view", "--root", "."],
    { cwd: dir, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /secret/);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd geml-parser && node test/embed.test.mjs`
Expected: FAIL — today a broken chain throws an unhandled error or prints a partial result, and there is no `--root`.

- [ ] **Step 3: Implement the failure path**

```ts
// Document-driven file reads need a confinement root: `src=` comes from file
// CONTENT, so without this a document could name any path on the machine.
// `.geml` only, and never a URL — §3.1: a read command must not become an SSRF
// entry point just because it walks a chain.
function readConfined(rel: string, root: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) {
    throw new ViewError("unchecked-cross-document-reference",
      `unchecked-cross-document-reference: \`${rel}\` is not local; --view never fetches over the network`);
  }
  if (!/\.geml$/i.test(rel)) {
    throw new ViewError("embed-target-not-geml", `embed-target-not-geml: \`${rel}\` is not a \`.geml\` document`);
  }
  const abs = resolve(root, rel);
  if (abs !== resolve(root) && !abs.startsWith(resolve(root) + sep)) {
    throw new ViewError("unresolvable-document",
      `unresolvable-document: \`${rel}\` lies outside the confinement root \`${root}\``);
  }
  try { return readFileSync(abs, "utf8"); }
  catch { throw new ViewError("unresolvable-document", `unresolvable-document: cannot resolve \`${rel}\``); }
}
```

In `oneHop`, a fragment that selects nothing becomes:

```ts
  if (units.length === 0) {
    throw new ViewError("unresolved-reference", `unresolved reference \`#${frag}\` in \`${rel}\``);
  }
```

In `runGet`, buffer everything before writing a byte, so failure emits nothing:

```ts
  const viewRoot = flag(args, "--root") ?? relDirPath(where) ?? ".";
  if (view) {
    const out: string[] = [];
    const notes: string[] = [];
    try {
      for (const u of units) {
        for (const res of viewResolve(source, where, u, viewRoot)) {
          if (res.from !== "") notes.push(`view: ${rawSel} -> ${res.from}`);
          out.push(sliceUnit(res.text, res.unit.span, headOnly, bodyOnly));
        }
      }
    } catch (e) {
      if (e instanceof ViewError) fail(e.message, 1);
      throw e;
    }
    for (const n of notes) console.error(n);
    process.stdout.write(out.join(""));
    return;
  }
```

`resolve`/`sep`/`readFileSync` are already imported in `geml.ts` — verify before
adding any import, and **do not** add one to the top-level import list without
mirroring the viewer stubs (Global Constraints).

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd geml-parser && npm run build && node test/embed.test.mjs`
Expected: PASS. The `https://example.invalid` case must fail fast — if it hangs, a request is being made and §3.1 is violated.

- [ ] **Step 5: Commit**

```bash
git add geml-parser/src/geml.ts geml-parser/test/embed.test.mjs
git commit -m "get --view: all-or-nothing failures, confined reads, never a network fetch"
```

---

## Task 5: `--view --json` carries `from`, and `--view --head/--body`

**Files:**
- Modify: `geml-parser/src/geml.ts` — `runGet` json branch
- Test: `geml-parser/test/embed.test.mjs`

**Interfaces:**
- Consumes: `viewResolve`, existing `unitNode(source, file, unit, all)`.
- Produces: the json node gains a `from` key **only** in view mode.

- [ ] **Step 1: Write the failing tests**

```js
test("get --view --json adds a from field; without --view there is none", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-view-json-"));
  writeFileSync(join(dir, "part.geml"), "=== note {#tip}\nBorrowed.\n===\n");
  writeFileSync(join(dir, "host.geml"), '=== embed {#e src="part.geml#tip"}\n===\n');
  const v = JSON.parse(spawnSync(process.execPath,
    [CLI, "get", "host.geml", "#e", "--view", "--json"], { cwd: dir, encoding: "utf8" }).stdout);
  assert.equal(v.type, "note", "the model node is the ENTITY block's");
  assert.deepEqual(v.from, { doc: "part.geml", id: "tip" });
  const plain = JSON.parse(spawnSync(process.execPath,
    [CLI, "get", "host.geml", "#e", "--json"], { cwd: dir, encoding: "utf8" }).stdout);
  assert.equal(plain.type, "embed");
  assert.equal("from" in plain, false, "from must not appear without --view (back-compat)");
});

test("get --view --body returns just the entity block's body", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-view-body-"));
  writeFileSync(join(dir, "part.geml"), "=== note {#tip}\nBorrowed.\n===\n");
  writeFileSync(join(dir, "host.geml"), '=== embed {#e src="part.geml#tip"}\n===\n');
  const r = spawnSync(process.execPath, [CLI, "get", "host.geml", "#e", "--view", "--body"],
    { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "Borrowed.\n");
  const h = spawnSync(process.execPath, [CLI, "get", "host.geml", "#e", "--view", "--head"],
    { cwd: dir, encoding: "utf8" });
  assert.equal(h.stdout, "=== note {#tip}\n");
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd geml-parser && node test/embed.test.mjs`
Expected: the json test FAILS (node is the embed's, no `from`). The head/body test may already pass via Task 1's `sliceUnit(hop.text, …)`.

- [ ] **Step 3: Thread view through the json branch**

```ts
  if (json) {
    const nodes = units.flatMap((u) => {
      if (!view) return [unitNode(source, file, u, all)];
      return viewResolve(source, where, u, viewRoot).map((res) => {
        const node = unitNode(res.text, res.doc, res.unit, res.all) as Record<string, unknown>;
        if (res.from !== "") {
          // A whole-document target has no `#` (§4.3), so `id` is absent there.
          const h = res.from.lastIndexOf("#");
          node["from"] = h < 0 ? { doc: res.from }
                               : { doc: res.from.slice(0, h), id: res.from.slice(h + 1) };
        }
        return node;
      });
    });
    console.log(JSON.stringify(units.length === 1 ? nodes[0] : nodes, null, 2));
    return;
  }
```

Wrap it in the same `try`/`ViewError` handling as Task 4 so a broken chain in
json mode also exits 1 with empty stdout.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd geml-parser && npm run build && node test/embed.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add geml-parser/src/geml.ts geml-parser/test/embed.test.mjs
git commit -m "get --view: json node carries from, head/body slice the entity block"
```

---

## Task 6: `set --view` is a usage error

**Files:**
- Modify: `geml-parser/src/geml.ts` — `runSet`
- Test: `geml-parser/test/embed.test.mjs`

**Interfaces:**
- Consumes: `fail(msg, code)`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```js
test("set --view is refused, and the error points at the right move", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-view-set-"));
  writeFileSync(join(dir, "part.geml"), "=== note {#tip}\nBorrowed.\n===\n");
  writeFileSync(join(dir, "host.geml"), '=== embed {#e src="part.geml#tip"}\n===\n');
  const r = spawnSync(process.execPath, [CLI, "set", "host.geml", "#e", "--view", "--in", "-"],
    { cwd: dir, encoding: "utf8", input: "x\n" });
  assert.equal(r.status, 2, "a read-only flag on a write verb is a usage error");
  assert.match(r.stderr, /read-only/);
  assert.match(r.stderr, /src/, "must say to edit the target document instead");
  // The target document is untouched.
  assert.equal(readFileSync(join(dir, "part.geml"), "utf8"), "=== note {#tip}\nBorrowed.\n===\n");
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd geml-parser && node test/embed.test.mjs`
Expected: FAIL — `--view` is currently ignored by `set` (it is not a positional, so it is silently dropped).

- [ ] **Step 3: Reject it in `runSet`**

At the top of `runSet`, beside the other flag validation:

```ts
  if (args.includes("--view")) {
    fail("--view is read-only. To edit the target, read the frame's `src` and edit that document.", 2);
  }
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `cd geml-parser && npm run build && node test/embed.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add geml-parser/src/geml.ts geml-parser/test/embed.test.mjs
git commit -m "set: refuse --view, a read-only flag, and point at editing the target"
```

---

## Task 7: MCP `geml_get` gains `view` and `part`

**Files:**
- Modify: `geml-parser/src/mcp.ts` — `geml_get` tool (~334)
- Test: `geml-parser/test/mcp.test.mjs`

**Interfaces:**
- Consumes: `runCli(args) -> {ok, stdout, stderr}`, `resolveInRoot`, `selectorArg`; the `part` validation shape from `geml_set` (~482).
- Produces: `geml_get` returns a **string** as today, or `{from, content}` when `view` is true.

- [ ] **Step 1: Write the failing tests**

```js
test("geml_get view returns {from, content}; without view it is still a string", () => {
  const dir = ws('=== embed {#e src="part.geml#tip"}\n===\n', "host.geml");
  writeFileSync(join(dir, "part.geml"), "=== note {#tip}\nBorrowed.\n===\n");
  const v = call("geml_get", { file: "host.geml", id: "#e", view: true }).json;
  assert.equal(v.from, "part.geml#tip", "provenance must survive the MCP hop (there is no stderr here)");
  assert.equal(v.content, "=== note {#tip}\nBorrowed.\n===\n");
  const plain = call("geml_get", { file: "host.geml", id: "#e" }).text;
  assert.equal(plain, '=== embed {#e src="part.geml#tip"}\n===\n', "back-compat: a plain string");
});

test("geml_get part=body pairs with view, and a bad part is refused", () => {
  const dir = ws('=== embed {#e src="part.geml#tip"}\n===\n', "host.geml");
  writeFileSync(join(dir, "part.geml"), "=== note {#tip}\nBorrowed.\n===\n");
  const v = call("geml_get", { file: "host.geml", id: "#e", view: true, part: "body" }).json;
  assert.equal(v.content, "Borrowed.\n", "no fences — that is why part exists");
  const bad = call("geml_get", { file: "host.geml", id: "#e", part: "middle" });
  assert.match(bad.text, /part must be whole\|head\|body/);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd geml-parser && node test/mcp.test.mjs`
Expected: FAIL — `view`/`part` are not in the schema and are ignored.

- [ ] **Step 3: Implement it**

Add to `geml_get`'s `inputSchema.properties`:

```ts
        view: {
          type: "boolean",
          description: "Read THROUGH an `embed` block to the entity block it stands for, following a multi-layer chain to its end. On any other block this changes nothing. Returns {from, content} so you can tell which document the content actually came from — its references and relative paths resolve against THAT document, not this one.",
        },
        part: { type: "string", enum: ["whole", "head", "body"], description: "How much of the block to return (default: whole). `body` is usually what you want with `view`." },
```

and replace `run`:

```ts
    run: (args) => {
      const real = resolveInRoot(args.file);
      const sel = selectorArg(args.id);
      const part = args.part ?? "whole";
      if (!["whole", "head", "body"].includes(part)) throw new Error(`part must be whole|head|body, got \`${part}\``);
      const flag = part === "head" ? ["--head"] : part === "body" ? ["--body"] : [];
      const run = runCli(["get", real, sel, ...flag, ...(args.view ? ["--view"] : [])]);
      if (!run.ok) throw new Error(run.stderr || `nothing matches ${sel}`);
      if (!args.view) return run.stdout;
      // MCP has no stderr, and provenance is mandatory (§4): lift it out of the
      // pinned `view: <sel> -> <doc>#<id>` line (§7.3) into a field of its own.
      const m = /^view: .*? -> (.+)$/m.exec(run.stderr);
      return { from: m ? m[1] : null, content: run.stdout };
    },
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd geml-parser && npm run build && node test/mcp.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add geml-parser/src/mcp.ts geml-parser/test/mcp.test.mjs
git commit -m "mcp: geml_get gains view and part, keeping provenance across the hop"
```

---

## Task 8: Pin the provenance format, document it, and run the gates

**Files:**
- Modify: `geml-parser/src/geml.ts` — `SUBHELP.get`
- Modify: `geml-parser/skill/references/authoring.geml` (`#cli` section) + both mirrors
- Test: `geml-parser/test/mcp.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test that pins the format**

```js
test("the view provenance line has the format the MCP layer parses (§7.3)", () => {
  // If this drifts, geml_get's `from` silently becomes null — the two sides
  // must agree on one format, so assert the CLI's output shape directly.
  const dir = ws('=== embed {#e src="part.geml#tip"}\n===\n', "host.geml");
  writeFileSync(join(dir, "part.geml"), "=== note {#tip}\nBorrowed.\n===\n");
  const r = spawnSync(process.execPath, [CLI, "get", "host.geml", "#e", "--view"],
    { cwd: dir, encoding: "utf8" });
  // `-> \S+` and not `-> \S+#\S+`: a fragment-less whole-document target has no
  // `#` (§4.3), and the format has to cover both shapes.
  assert.match(r.stderr, /^view: \S+ -> \S+$/m, `format drifted: ${JSON.stringify(r.stderr)}`);
  assert.equal(call("geml_get", { file: "host.geml", id: "#e", view: true }).json.from, "part.geml#tip");
});
```

`mcp.test.mjs` needs `spawnSync`/`CLI` in scope — add them to its imports if absent, matching `embed.test.mjs`.

- [ ] **Step 2: Run it to make sure it fails (or passes for the right reason)**

Run: `cd geml-parser && node test/mcp.test.mjs`
Expected: PASS if Tasks 1 and 7 agree; a FAIL here means the two sides already drifted — fix the format, not the test.

- [ ] **Step 3: Document `--view` in help and in the skill**

`SUBHELP.get` — append to the usage string:

```
[--view]
```

and to its explanation:

```
--view = read THROUGH an `embed` to the entity block it stands for (multi-layer chains followed to the end; the identity on any other block). Provenance goes to stderr. Read-only: `set` refuses it. Chain reads are confined to --root (default: the document's own directory) and never fetch over the network.
```

In `geml-parser/skill/references/authoring.geml`, `#cli` section, add one bullet:

```
- `geml get f.geml '#e' --view` — read THROUGH an `embed` to the block it
  stands for (chains followed to the end; on any other block it changes
  nothing). Out-of-band provenance on stderr says which document the content
  came from — its refs resolve against THAT document. Read-only; `set` refuses
  it. MCP: `geml_get {view: true, part: "body"}`.
```

Then copy the file to both mirrors so the three-way drift test stays green:

```bash
cd <repo root>
cp geml-parser/skill/references/authoring.geml .claude/skills/geml/references/authoring.geml
cp geml-parser/skill/references/authoring.geml integrations/claude-plugin/skills/geml/references/authoring.geml
rm -f geml-parser/skill/references/authoring.gemlhistory
node geml-parser/dist/geml.js check geml-parser/skill/references/authoring.geml
```

- [ ] **Step 4: Run the whole suite and the coverage gate — ONCE**

Run: `cd geml-parser && npm run coverage:check`
Expected: exit 0; every suite green and all four coverage metrics ≥ 95. Take the
test result and the coverage verdict from this single run — do not re-run to see
the other half.

- [ ] **Step 5: Commit**

```bash
git add geml-parser/src/geml.ts geml-parser/skill geml-parser/test/mcp.test.mjs \
        ../.claude/skills/geml/references/authoring.geml \
        ../integrations/claude-plugin/skills/geml/references/authoring.geml
git commit -m "get --view: pin the provenance format, document it in help and the skill"
```

---

## Self-Review

**Spec coverage** — every section of the design doc maps to a task:

| Spec | Task |
|---|---|
| §2 semantics, §2.1 identity | 1, 3 |
| §2.2 why a flag | (design rationale, nothing to build) |
| §3 stop conditions, §3.1 no network, §3.2 depth, §3.3 exit codes + all-or-nothing | 2, 4 |
| §4 provenance, §4.1 stderr, §4.2 json `from`, §4.3 multi-result | 1, 5, 3 |
| §5 `set` refuses | 6 |
| §6 flag combinations | 5 (head/body), 4 (`--root`) |
| §7 MCP `view`/`part`, §7.2 `{from, content}`, §7.3 format contract | 7, 8 |
| §8 tests | every task (TDD) |
| §9 changes, incl. not touching `detectTransclusionCycles` | 2 (own walker), Global Constraints |
| §10 non-goals | nothing to build |

**Type consistency** — one signature throughout: `viewResolve(source, file, unit, root) -> ViewResult[]`, declared in Task 1 and only ever gaining the optional `depth`/`seen` parameters in Task 2. The return type is an array **from Task 1**, because §4.3 lets one frame look onto several entity blocks; a single-`Unit` version would have had to be widened mid-plan and would leave Tasks 1–5 disagreeing. `ViewResult.from` is a string everywhere — `<doc>#<id>`, or bare `<doc>` for a whole-document target, or `""` for the identity case — and it is destructured into `{doc, id?}` only at the json boundary (Task 5) and re-parsed out of stderr only at the MCP boundary (Task 7). Both of those places handle the missing-`#` form. `ViewError` and `oneHop` are both introduced in Task 2, where they are first used; `readConfined` (Task 4) is called by `oneHop`, so **Task 2's build will not typecheck until Task 4 lands** — either execute in order and stub `readConfined` as `readFileSync(resolve(root, rel), "utf8")` in Task 2, replacing it in Task 4, or fold Tasks 2 and 4 together. The plan assumes in-order execution with the stub.

**Verify-before-writing items** (the plan names the constraint rather than guessing the API):
- `allUnitsOf` in Task 3 — read `listIds` first and reuse its enumeration; do not invent a selector string.
- Whether `resolve`/`sep`/`readFileSync` are already imported in `geml.ts` (Task 4) — if not, adding one must be mirrored in the viewer's esbuild stubs per Global Constraints.
- `--view` with no selector (the `list` form) must be a usage error, like `--head`/`--body`: add the `fail(…, 2)` guard beside the existing one in `runGet`. Silently ignoring it would make `get f --view` print byte-for-byte what `get f` prints.
