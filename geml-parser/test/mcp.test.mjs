// `geml mcp` — the document-CRUD MCP server (src/mcp.ts).
//
// The acceptance criteria this suite pins, in the order they matter:
//
//   * nine tools, and the server actually starts over real stdio;
//   * a REFUSED write leaves the file byte-for-byte unchanged (the whole point
//     of routing an agent through this server rather than a text editor);
//   * path confinement holds against `../`, an absolute path, and a symlink
//     planted inside the workspace — this server WRITES, so an escape is worse
//     here than in the read-only code-graph server;
//   * `geml_revert_block` undoes ONE block after a bad edit while every other
//     byte of the document stays identical. That is the capability no general
//     file-editing tool has, so it gets the most explicit test in the file.
import { configure, handleLine, TOOLS, parseArgs, resolveInWorkspace } from "../dist/mcp.js";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "geml.js");
let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const DOC = `=== meta
title = "Test"
===

# Doc

=== note {#alpha}
first block
===

=== note {#beta}
second block, see [[#alpha]]
===

=== note {#gamma}
third block
===
`;

// A fresh workspace per test: these tests write, and must not see each other.
function ws(doc = DOC, name = "d.geml") {
  const dir = mkdtempSync(join(tmpdir(), "geml-mcp-"));
  writeFileSync(join(dir, name), doc);
  configure({ workspace: dir, history: true });
  return dir;
}

// Drive one tool through the JSON-RPC layer, exactly as a client would.
function call(name, args) {
  const out = [];
  handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }), (s) => out.push(s));
  const msg = JSON.parse(out[0]);
  if (msg.error) return { rpcError: msg.error };
  const text = msg.result?.content?.[0]?.text ?? "";
  let json;
  try { json = JSON.parse(text); } catch { /* plain text result */ }
  return { text, json, isError: msg.result?.isError === true };
}

function rpc(method, params) {
  const out = [];
  handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), (s) => out.push(s));
  return out.length ? JSON.parse(out[0]) : undefined;
}

// ---------------------------------------------------------------------------
// Protocol surface
// ---------------------------------------------------------------------------

test("nine tools, all under the geml_ prefix (no collision with the code-graph server)", () => {
  assert.equal(TOOLS.length, 9);
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(names, [
    "geml_list_ids", "geml_read_block", "geml_check", "geml_history_log",
    "geml_write_block", "geml_add_block", "geml_delete_block", "geml_rename_id", "geml_revert_block",
  ]);
  for (const t of TOOLS) {
    assert.ok(t.name.startsWith("geml_"), `${t.name} is namespaced`);
    assert.ok(t.description.length > 80, `${t.name} has a description written for a model, not a stub`);
    assert.equal(t.inputSchema.type, "object");
  }
});

test("initialize / tools/list / ping speak JSON-RPC 2.0", () => {
  ws();
  const init = rpc("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(init.result.serverInfo.name, "geml-docs");
  assert.ok(init.result.capabilities.tools);
  assert.equal(rpc("tools/list").result.tools.length, 9);
  assert.deepEqual(rpc("ping").result, {});
  // A notification gets no reply at all.
  assert.equal(rpc("notifications/initialized"), undefined);
});

test("an unknown tool is a protocol error, not a silent success", () => {
  ws();
  const r = call("geml_nope", {});
  assert.equal(r.rpcError.code, -32602);
});

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

test("geml_list_ids returns every addressable id", () => {
  ws();
  const ids = call("geml_list_ids", { file: "d.geml" }).json.map((b) => b.id);
  assert.deepEqual(ids, ["doc", "alpha", "beta", "gamma"]);
});

test("geml_read_block returns ONE block, with or without the leading #", () => {
  ws();
  const withHash = call("geml_read_block", { file: "d.geml", id: "#alpha" }).text;
  const without = call("geml_read_block", { file: "d.geml", id: "alpha" }).text;
  assert.equal(withHash, without);
  assert.match(withHash, /^=== note \{#alpha\}\nfirst block\n===/);
  assert.ok(!withHash.includes("second block"), "only the addressed block comes back");
});

test("geml_check reports diagnostics with their Appendix A codes", () => {
  const dir = ws();
  assert.equal(call("geml_check", { file: "d.geml" }).json.ok, true);
  writeFileSync(join(dir, "broken.geml"), "see [[#nowhere]]\n");
  const bad = call("geml_check", { file: "broken.geml" }).json;
  assert.equal(bad.ok, false);
  assert.equal(bad.errors, 1);
  assert.equal(bad.diagnostics[0].code, "unresolved-reference");
});

test("geml_history_log says so plainly when there is no sidecar yet", () => {
  ws();
  const log = call("geml_history_log", { file: "d.geml" }).json;
  assert.deepEqual(log.revisions, []);
  assert.match(log.note, /no \.gemlhistory sidecar yet/);
});

// ---------------------------------------------------------------------------
// Invariant 1 — a refused write never reaches disk
// ---------------------------------------------------------------------------

test("a write that would break the document is REFUSED and the file is byte-identical", () => {
  const dir = ws();
  const file = join(dir, "d.geml");
  const before = readFileSync(file);

  const r = call("geml_write_block", { file: "d.geml", id: "beta", part: "body", body: "now see [[#ghost]]" });

  assert.equal(r.json.ok, false);
  assert.equal(r.isError, true, "the client sees a tool error, so the model cannot read it as success");
  assert.equal(r.json.diagnostics[0].code, "unresolved-reference");
  assert.match(r.json.hint, /the file on disk is unchanged/);
  assert.deepEqual(readFileSync(file), before, "not one byte of the document changed");
});

test("a refusal names every problem, not just the first", () => {
  const dir = ws();
  const r = call("geml_write_block", { file: "d.geml", id: "beta", part: "body", body: "[[#ghost1]] and [[#ghost2]]" });
  assert.equal(r.json.ok, false);
  const refs = r.json.diagnostics.map((d) => d.message).join(" ");
  assert.match(refs, /ghost1/);
  assert.match(refs, /ghost2/, "the second broken reference is reported too");
});

test("a good write lands, and records the pre-write state as a revision", () => {
  const dir = ws();
  const file = join(dir, "d.geml");
  const r = call("geml_write_block", { file: "d.geml", id: "alpha", part: "body", body: "rewritten" });
  assert.equal(r.json.ok, true);
  assert.ok(r.json.revision, "a revision id came back");
  const now = readFileSync(file, "utf8");
  assert.ok(now.includes("rewritten"));
  assert.ok(!now.includes("first block"));
  assert.ok(existsSync(join(dir, "d.gemlhistory")), "the sidecar was created before the write");
});

test("--no-history writes without taking a snapshot", () => {
  const dir = ws();
  configure({ workspace: dir, history: false });
  const r = call("geml_write_block", { file: "d.geml", id: "alpha", part: "body", body: "rewritten" });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.revision, undefined);
  assert.ok(!existsSync(join(dir, "d.gemlhistory")), "no sidecar when history is off");
});

// ---------------------------------------------------------------------------
// Invariant 3 — path confinement
// ---------------------------------------------------------------------------

test("`../` traversal is refused", () => {
  ws();
  for (const tool of ["geml_read_block", "geml_write_block"]) {
    const r = call(tool, { file: "../../../etc/passwd", id: "x", body: "y" });
    assert.equal(r.isError, true);
    assert.match(r.text, /escapes the workspace|no such file/);
  }
});

test("an absolute path outside the workspace is refused", () => {
  ws();
  const r = call("geml_read_block", { file: "/etc/passwd", id: "x" });
  assert.equal(r.isError, true);
  // On POSIX /etc/passwd escapes the workspace; on Windows it hits the
  // "no such file" branch first — both are a refusal (matches :199).
  assert.match(r.text, /escapes the workspace|no such file/);
});

test("a SYMLINK planted inside the workspace cannot smuggle a path out", () => {
  const dir = ws();
  const outside = mkdtempSync(join(tmpdir(), "geml-outside-"));
  const secret = join(outside, "secret.geml");
  writeFileSync(secret, "=== note {#s}\ntop secret\n===\n");
  try {
    symlinkSync(secret, join(dir, "link.geml"));
  } catch {
    console.log("ok   (symlink unsupported on this platform — skipped)");
    passed++;
    return;
  }
  const r = call("geml_read_block", { file: "link.geml", id: "s" });
  assert.equal(r.isError, true, "following the link out of the workspace is refused");
  assert.match(r.text, /escapes the workspace/);
  assert.ok(!r.text.includes("top secret"), "the outside content never came back");
  rmSync(outside, { recursive: true, force: true });
});

test("geml_check's `root` may narrow inside the workspace but never escape it", () => {
  const dir = ws();
  mkdirSync(join(dir, "sub"));
  assert.ok(call("geml_check", { file: "d.geml", root: "sub" }).json, "an inside root is accepted");
  const r = call("geml_check", { file: "d.geml", root: "../.." });
  assert.equal(r.isError, true);
  assert.match(r.text, /escapes the workspace/);
});

test("resolveInWorkspace rejects a directory, an empty path, and a nonexistent file", () => {
  const dir = ws();
  mkdirSync(join(dir, "adir"));
  assert.throws(() => resolveInWorkspace("adir"), /not a file/);
  assert.throws(() => resolveInWorkspace(""), /required/);
  // A file that simply does not exist inside the workspace is refused the same
  // on every OS. (The /etc/passwd test hits this branch only where the file is
  // absent — Windows — so this keeps the confinement covered on Linux too.)
  assert.throws(() => resolveInWorkspace("ghost.geml"), /no such file in the workspace/);
});

test("resolveInWorkspace refuses an absolute path to a real file OUTSIDE the workspace (any OS)", () => {
  ws();
  const outside = mkdtempSync(join(tmpdir(), "geml-outside-"));
  const f = join(outside, "real.geml");
  writeFileSync(f, "=== note {#x}\nhi\n===\n");
  // The file EXISTS, so realpath succeeds and the escape check is what must
  // reject it — covering the core confinement branch on every OS without a
  // symlink (which Windows skips), and where `../` paths hit "no such file" first.
  assert.throws(() => resolveInWorkspace(f), /escapes the workspace/);
  rmSync(outside, { recursive: true, force: true });
});

test("geml_check refuses a `root` directory that does not exist in the workspace", () => {
  ws();
  const r = call("geml_check", { file: "d.geml", root: "no-such-dir" });
  assert.equal(r.isError, true, JSON.stringify(r.json ?? r.text));
  assert.match(r.text, /no such directory in the workspace/);
});

// ---------------------------------------------------------------------------
// Invariant 2 + the differentiator — revert ONE block, leave the rest alone
// ---------------------------------------------------------------------------

test("geml_revert_block undoes ONE block after a bad edit; every other byte is unchanged", () => {
  const dir = ws();
  const file = join(dir, "d.geml");

  // 1. A legitimate edit to a DIFFERENT block — the work we must not lose.
  assert.equal(call("geml_write_block", { file: "d.geml", id: "gamma", part: "body", body: "third block, improved" }).json.ok, true);
  const good = readFileSync(file, "utf8");
  assert.ok(good.includes("third block, improved"));

  // 2. A bad-but-valid edit to #alpha: it parses, so nothing refuses it.
  assert.equal(call("geml_write_block", { file: "d.geml", id: "alpha", part: "body", body: "GARBAGE the model hallucinated" }).json.ok, true);
  assert.ok(readFileSync(file, "utf8").includes("GARBAGE"));

  // 3. Revert ONLY #alpha.
  const rev = call("geml_revert_block", { file: "d.geml", id: "alpha" });
  assert.equal(rev.json.ok, true, JSON.stringify(rev.json));

  const after = readFileSync(file, "utf8");
  assert.ok(!after.includes("GARBAGE"), "the bad block is gone");
  assert.ok(after.includes("first block"), "#alpha is back to its previous content");
  assert.ok(after.includes("third block, improved"), "the UNRELATED good edit survived the revert");

  // The strong claim: the document differs from the good state ONLY inside
  // #alpha. Compare every line outside that block byte-for-byte.
  const outside = (s) => s.split("\n").filter((l) => !l.includes("GARBAGE") && !l.includes("first block"));
  assert.deepEqual(outside(after), outside(good), "every byte outside #alpha is identical");
});

test("geml_revert_block (default) undoes the block just touched — even after a SINGLE edit", () => {
  // The reviewer's minimal case: ONE edit, then revert with no `rev`. The CLI's
  // own default `-1` overshoots (out-of-ranges / no-ops); the MCP default
  // (`--rev changed`) walks to #alpha's previous distinct version.
  const dir = ws();
  const file = join(dir, "d.geml");
  call("geml_write_block", { file: "d.geml", id: "alpha", part: "body", body: "BAD single edit" });
  assert.ok(readFileSync(file, "utf8").includes("BAD single edit"));
  const rev = call("geml_revert_block", { file: "d.geml", id: "alpha" });
  assert.equal(rev.json?.ok, true, JSON.stringify(rev.json ?? rev.text));
  const after = readFileSync(file, "utf8");
  assert.ok(!after.includes("BAD single edit"), "the single bad edit is undone");
  assert.ok(after.includes("first block"), "#alpha restored to its pre-edit content");
});

test("geml_revert_block (default) undoes a block even after ANOTHER block was written since", () => {
  // Why the default is `--rev changed`, not `latest`: `latest` (the tip) is the
  // state after the #gamma write, where #alpha already equals current -> it
  // would silently no-op (ok:true, nothing undone). `--rev changed` walks back to
  // #alpha's own previous version, so the stale intervening write can't mask it.
  const dir = ws();
  const file = join(dir, "d.geml");
  call("geml_write_block", { file: "d.geml", id: "alpha", part: "body", body: "BAD alpha" });
  call("geml_write_block", { file: "d.geml", id: "gamma", part: "body", body: "later gamma edit" });
  const rev = call("geml_revert_block", { file: "d.geml", id: "alpha" });
  assert.equal(rev.json?.ok, true, JSON.stringify(rev.json ?? rev.text));
  const after = readFileSync(file, "utf8");
  assert.ok(!after.includes("BAD alpha"), "#alpha's bad edit is undone");
  assert.ok(after.includes("first block"), "#alpha restored to its pre-edit content");
  assert.ok(after.includes("later gamma edit"), "the intervening #gamma edit is preserved");
});

test("geml_history_log's offsets are the selectors geml_revert_block takes", () => {
  const dir = ws();
  call("geml_write_block", { file: "d.geml", id: "alpha", part: "body", body: "v2" });
  call("geml_write_block", { file: "d.geml", id: "alpha", part: "body", body: "v3" });
  const revs = call("geml_history_log", { file: "d.geml" }).json.revisions;
  assert.ok(revs.length >= 2);
  assert.equal(revs[0].offset, 0);
  assert.equal(revs[0].current, true);
  const r = call("geml_revert_block", { file: "d.geml", id: "alpha", rev: "-1" });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
});

test("every revision selector the tool DESCRIPTIONS name is one the resolver accepts", () => {
  // A tool description is the model's only instruction manual: a selector named
  // there and rejected at runtime is a defect the model cannot route around.
  // This drifted once already — `latest` was dropped from the resolver while
  // both the description and the guide still advertised it — so pull the
  // selectors out of the prose and put each through the real tool.
  const dir = ws();
  const revertTool = TOOLS.find((t) => t.name === "geml_revert_block");
  const prose = `${revertTool.description} ${revertTool.inputSchema.properties.rev.description}`;

  // Word-shaped selectors are the ones that rot: `-N`/`0` are grammar and an id
  // is data, but a keyword like `latest` only works while the resolver knows it.
  const keywords = [...prose.matchAll(/`([a-z][a-z]+)`/g)].map((m) => m[1]);
  const notSelectors = new Set(["rev", "geml_history_log", "id", "prefix", "true", "false"]);
  const claimed = [...new Set(keywords)].filter((w) => !notSelectors.has(w));

  call("geml_write_block", { file: "d.geml", id: "alpha", part: "body", body: "v2" });
  call("geml_write_block", { file: "d.geml", id: "alpha", part: "body", body: "v3" });

  for (const sel of claimed) {
    const r = call("geml_revert_block", { file: "d.geml", id: "alpha", rev: sel });
    assert.ok(
      !/matched 0 revisions/.test(r.json?.hint ?? ""),
      `the description names \`${sel}\` as a selector, but the resolver rejects it: ${r.json?.hint}`,
    );
  }

  // And the selectors the description DOES name are exercised for real.
  const revs = call("geml_history_log", { file: "d.geml" }).json.revisions;
  for (const sel of ["0", "-1", revs[revs.length - 1].id]) {
    const r = call("geml_revert_block", { file: "d.geml", id: "alpha", rev: sel });
    assert.ok(
      !/matched 0 revisions/.test(r.json?.hint ?? ""),
      `documented selector \`${sel}\` was rejected: ${r.json?.hint}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The remaining write tools
// ---------------------------------------------------------------------------

test("geml_add_block appends, and inserts before/after an anchor", () => {
  const dir = ws();
  assert.equal(call("geml_add_block", { file: "d.geml", content: "=== note {#tail}\nend\n===\n", position: "append" }).json.ok, true);
  assert.equal(call("geml_add_block", { file: "d.geml", content: "=== note {#head}\ntop\n===\n", position: "before", anchor: "alpha" }).json.ok, true);
  const ids = call("geml_list_ids", { file: "d.geml" }).json.map((b) => b.id);
  assert.ok(ids.includes("tail") && ids.includes("head"));
  assert.ok(ids.indexOf("head") < ids.indexOf("alpha"), "`before` really placed it before the anchor");
});

test("geml_add_block needs an anchor for before/after, and rejects a bad position", () => {
  ws();
  assert.match(call("geml_add_block", { file: "d.geml", content: "x", position: "before" }).text, /needs an `anchor`/);
  assert.match(call("geml_add_block", { file: "d.geml", content: "x", position: "sideways" }).text, /append\|before\|after/);
});

test("an id clash on insert is refused and the file is unchanged", () => {
  const dir = ws();
  const before = readFileSync(join(dir, "d.geml"));
  const r = call("geml_add_block", { file: "d.geml", content: "=== note {#alpha}\ndupe\n===\n", position: "append" });
  assert.equal(r.json.ok, false);
  assert.deepEqual(readFileSync(join(dir, "d.geml")), before);
});

test("geml_delete_block removes a block, and a dangling reference is reported but NOT blocking", () => {
  const dir = ws();
  // #alpha is referenced by #beta: deleting it is deliberate, so it proceeds
  // and the caller is told what it broke (the CLI's documented contract).
  const r = call("geml_delete_block", { file: "d.geml", ids: ["alpha"] });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  const after = readFileSync(join(dir, "d.geml"), "utf8");
  assert.ok(!after.includes("first block"), "the block is gone");
  assert.ok(r.json.diagnostics.some((d) => d.code === "unresolved-reference"), "the now-dangling reference is reported");
});

test("a write that would EMPTY the document is refused, not allowed to destroy it", () => {
  // The MCP's last line of defense: a CLI that exits 0 having written nothing
  // (here, deleting the ONLY block) must never be read as "the new document is
  // empty" and land — an empty document parses clean and would destroy the file.
  const dir = ws("=== note {#only}\nthe whole document\n===\n", "solo.geml");
  const r = call("geml_delete_block", { file: "solo.geml", ids: ["only"] });
  assert.equal(r.isError, true, JSON.stringify(r.json ?? r.text));
  assert.match(r.text, /produced no output|nothing was written/);
  assert.ok(readFileSync(join(dir, "solo.geml"), "utf8").includes("the whole document"), "the file was NOT destroyed");
});

test("geml_delete_block requires at least one id", () => {
  ws();
  assert.match(call("geml_delete_block", { file: "d.geml", ids: [] }).text, /at least one block/);
});

test("geml_rename_id renames the block AND every reference to it", () => {
  const dir = ws();
  const r = call("geml_rename_id", { file: "d.geml", old: "alpha", new: "renamed" });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  const after = readFileSync(join(dir, "d.geml"), "utf8");
  assert.ok(after.includes("{#renamed}"), "the block id changed");
  assert.ok(after.includes("[[#renamed]]"), "the reference in #beta followed it");
  assert.ok(!after.includes("#alpha"), "no stale id is left behind");
  assert.equal(call("geml_check", { file: "d.geml" }).json.ok, true, "the document is still valid");
});

test("a no-op write is reported as such rather than churning a revision", () => {
  ws();
  const r = call("geml_write_block", { file: "d.geml", id: "alpha", part: "body", body: "first block" });
  assert.equal(r.json.ok, true);
  assert.match(r.json.hint, /No change/);
});

test("a document with PRE-EXISTING errors refuses writes, and says the edit was not the cause", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-mcp-"));
  const file = join(dir, "b.geml");
  writeFileSync(file, "=== note {#x}\nbroken: [[#missing]]\n===\n\n=== note {#y}\nfixable\n===\n");
  configure({ workspace: dir, history: true });
  const before = readFileSync(file);

  // The CLI's pre-write check refuses on ANY error in the result, including one
  // the document already had. So editing an unrelated block is refused too —
  // the document is locked until the existing break is repaired. That is worth
  // pinning: the value is entirely in the model being TOLD why.
  const r = call("geml_write_block", { file: "b.geml", id: "y", part: "body", body: "edited anyway" });
  assert.equal(r.json.ok, false);
  assert.deepEqual(readFileSync(file), before, "nothing was written");
  assert.match(r.json.hint, /ALREADY in the document before this edit/);
  assert.match(r.json.hint, /Repair them first/);

  // And repairing the actual break is never blocked — the escape hatch works.
  const fix = call("geml_write_block", { file: "b.geml", id: "x", part: "body", body: "repaired" });
  assert.equal(fix.json.ok, true, JSON.stringify(fix.json));
  assert.equal(call("geml_check", { file: "b.geml" }).json.ok, true);
});

// ---------------------------------------------------------------------------
// Cross-document references resolve INSIDE the workspace, and only there
// ---------------------------------------------------------------------------

test("a cross-document reference resolves when the target is in the workspace", () => {
  const dir = ws();
  writeFileSync(join(dir, "other.geml"), "=== note {#target}\nover here\n===\n");
  writeFileSync(join(dir, "src.geml"), "see [text](other.geml#target)\n");
  const r = call("geml_check", { file: "src.geml" }).json;
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.diagnostics.length, 0, "a resolvable cross-doc ref is neither error nor warning");
});

test("a cross-document reference to a MISSING id in a real file is an error", () => {
  const dir = ws();
  writeFileSync(join(dir, "other.geml"), "=== note {#target}\nover here\n===\n");
  writeFileSync(join(dir, "src.geml"), "see [text](other.geml#nosuch)\n");
  const r = call("geml_check", { file: "src.geml" }).json;
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics[0].code, "unresolved-cross-document-reference");
});

test("a cross-document reference cannot READ a file outside the workspace", () => {
  const dir = ws();
  const outside = mkdtempSync(join(tmpdir(), "geml-outside-"));
  writeFileSync(join(outside, "secret.geml"), "=== note {#leak}\nclassified\n===\n");
  // The document names a target above the workspace root; resolution must fail
  // closed rather than reach out of the confinement root.
  writeFileSync(join(dir, "src.geml"), "see [t](../../etc/passwd#x) and [u](" + join(outside, "secret.geml") + "#leak)\n");
  const r = call("geml_check", { file: "src.geml" }).json;
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.every((d) => d.code === "unresolvable-document"), JSON.stringify(r.diagnostics));
  assert.ok(!JSON.stringify(r).includes("classified"), "no content from outside the workspace leaked into the reply");
  rmSync(outside, { recursive: true, force: true });
});

test("a cross-document reference to a nonexistent in-workspace file fails closed (any OS)", () => {
  const dir = ws();
  // ghost.geml does not exist, so docResolver's realpath throws and it returns
  // null — the ref is unresolvable, not a crash and not a leak. Platform-
  // independent: the /etc/passwd cases above hit the confinement RETURN on Linux
  // (the file exists there) and this CATCH on Windows; this covers it on both.
  writeFileSync(join(dir, "src.geml"), "see [t](ghost.geml#x)\n");
  const r = call("geml_check", { file: "src.geml" }).json;
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.some((d) => d.code === "unresolvable-document"), JSON.stringify(r.diagnostics));
});

test("a write is validated against cross-document targets too", () => {
  const dir = ws();
  writeFileSync(join(dir, "other.geml"), "=== note {#target}\nover here\n===\n");
  const ok = call("geml_write_block", { file: "d.geml", id: "gamma", part: "body", body: "see [t](other.geml#target)" });
  assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
  const bad = call("geml_write_block", { file: "d.geml", id: "gamma", part: "body", body: "see [t](other.geml#ghost)" });
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.diagnostics[0].code, "unresolved-cross-document-reference");
});

// ---------------------------------------------------------------------------
// Protocol edges
// ---------------------------------------------------------------------------

test("a malformed frame is ignored rather than answered or crashed on", () => {
  ws();
  const out = [];
  handleLine("{not json", (s) => out.push(s));
  handleLine("   ", (s) => out.push(s));
  assert.deepEqual(out, [], "no reply to a frame that was never a request");
});

test("an unknown METHOD gets -32601, and a notification still gets nothing", () => {
  ws();
  assert.equal(rpc("resources/list").error.code, -32601);
  const out = [];
  handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" }), (s) => out.push(s));
  assert.deepEqual(out, []);
});

test("a write whose sidecar cannot be created still lands the edit", () => {
  const dir = ws();
  // Occupy the sidecar path with a DIRECTORY so committing must fail. The edit
  // is the caller's work — losing it to a bookkeeping failure would be worse
  // than losing the revert point.
  mkdirSync(join(dir, "d.gemlhistory"));
  const r = call("geml_write_block", { file: "d.geml", id: "alpha", part: "body", body: "still written" });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.equal(r.json.revision, undefined, "no revision was recorded");
  assert.ok(readFileSync(join(dir, "d.geml"), "utf8").includes("still written"));
});

// ---------------------------------------------------------------------------
// Startup — the `claude mcp add …` command has to actually work
// ---------------------------------------------------------------------------

test("parseArgs requires --workspace and validates it is a directory", () => {
  assert.throws(() => parseArgs([]), /--workspace <dir> is required/);
  assert.throws(() => parseArgs(["--workspace", join(tmpdir(), "definitely-not-here-9137")]), /not a directory/);
  const dir = mkdtempSync(join(tmpdir(), "geml-mcp-"));
  assert.equal(parseArgs(["--workspace", dir]).history, true);
  assert.equal(parseArgs([`--workspace=${dir}`, "--no-history"]).history, false);
  assert.throws(() => parseArgs(["--workspace", dir, "--bogus"]), /unknown option/);
});

test("`geml mcp --workspace <dir>` starts and answers a real stdio handshake", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-mcp-"));
  writeFileSync(join(dir, "d.geml"), DOC);
  const frames = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "geml_read_block", arguments: { file: "d.geml", id: "alpha" } } }),
  ].join("\n") + "\n";

  const r = spawnSync(process.execPath, [CLI, "mcp", "--workspace", dir], { input: frames, encoding: "utf8", timeout: 30000 });
  const replies = r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(replies.length, 3, `three frames in, three out (stderr: ${r.stderr})`);
  assert.equal(replies[0].result.serverInfo.name, "geml-docs");
  assert.equal(replies[1].result.tools.length, 9);
  assert.match(replies[2].result.content[0].text, /first block/);
});

test("`geml mcp` without --workspace exits 2 with usage, rather than serving everything", () => {
  const r = spawnSync(process.execPath, [CLI, "mcp"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--workspace <dir> is required/);
});

// ---------------------------------------------------------------------------
// argument handling + protocol edges (the agent-facing contract)
// ---------------------------------------------------------------------------

test("write_block: an unknown `part` is rejected by name, before anything is written", () => {
  const dir = ws();
  const before = readFileSync(join(dir, "d.geml"), "utf8");
  const r = call("geml_write_block", { file: "d.geml", id: "alpha", body: "x", part: "sideways" });
  assert.ok(r.isError, "reported as an error result");
  assert.match(r.text, /part must be whole\|head\|body, got `sideways`/);
  assert.equal(readFileSync(join(dir, "d.geml"), "utf8"), before, "the document is untouched");
  rmSync(dir, { recursive: true, force: true });
});

test("write_block: part=head and part=body each target only that span", () => {
  const dir = ws();
  const h = call("geml_write_block", { file: "d.geml", id: "alpha", body: "=== note {#alpha .lead}", part: "head" });
  assert.ok(!h.isError, h.text);
  let doc = readFileSync(join(dir, "d.geml"), "utf8");
  assert.match(doc, /=== note \{#alpha \.lead\}/, "head replaced");
  assert.match(doc, /first block/, "body untouched by a head write");
  const b = call("geml_write_block", { file: "d.geml", id: "alpha", body: "rewritten body", part: "body" });
  assert.ok(!b.isError, b.text);
  doc = readFileSync(join(dir, "d.geml"), "utf8");
  assert.match(doc, /rewritten body/, "body replaced");
  assert.match(doc, /=== note \{#alpha \.lead\}/, "head survives a body write");
  rmSync(dir, { recursive: true, force: true });
});

test("write_block: `part` defaults to whole — the block is replaced head and body", () => {
  const dir = ws();
  const r = call("geml_write_block", { file: "d.geml", id: "alpha", body: "=== note {#alpha}\nbrand new\n===" });
  assert.ok(!r.rpcError, JSON.stringify(r.rpcError));
  assert.ok(!r.isError, r.text);
  const doc = readFileSync(join(dir, "d.geml"), "utf8");
  assert.match(doc, /brand new/);
  assert.doesNotMatch(doc, /first block/, "the whole block went, not just the head");
  rmSync(dir, { recursive: true, force: true });
});

test("delete_block: removing a REFERENCED block is allowed; the dangling ref is a diagnostic, not a veto", () => {
  const dir = ws(); // #beta contains [[#alpha]]
  const r = call("geml_delete_block", { file: "d.geml", ids: ["alpha"] });
  assert.ok(!r.rpcError, JSON.stringify(r.rpcError));
  assert.ok(!r.isError, `deletion must not be refused by the reference it breaks: ${r.text}`);
  const doc = readFileSync(join(dir, "d.geml"), "utf8");
  assert.doesNotMatch(doc, /=== note \{#alpha\}/, "the block is gone");
  assert.match(doc, /\[\[#alpha\]\]/, "the now-dangling reference is left for the caller to decide about");
  rmSync(dir, { recursive: true, force: true });
});

test("a NOTIFICATION whose reply fails gets no error frame (nothing to reply to)", () => {
  const dir = ws();
  const out = [];
  // No `id` = a notification. If writing its reply throws, the handler must stay
  // silent rather than invent a response to a message that wanted none.
  handleLine(JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {} }), () => { throw new Error("transport down"); });
  assert.equal(out.length, 0, "no frame written for a notification");
  rmSync(dir, { recursive: true, force: true });
});

test("delete_block: `ids` accepts a single id, not only an array", () => {
  const dir = ws();
  const r = call("geml_delete_block", { file: "d.geml", ids: "gamma" });
  assert.ok(!r.rpcError, JSON.stringify(r.rpcError));
  assert.ok(!r.isError, r.text);
  const doc = readFileSync(join(dir, "d.geml"), "utf8");
  assert.doesNotMatch(doc, /#gamma/, "the single named block is gone");
  assert.match(doc, /#alpha/, "the others stay");
  rmSync(dir, { recursive: true, force: true });
});

test("tools/call with no `arguments` object degrades to an error result, not a crash", () => {
  const dir = ws();
  const out = [];
  handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "geml_read_block" } }), (s) => out.push(s));
  const msg = JSON.parse(out[0]);
  assert.ok(msg.result?.isError, "an error RESULT (the model can read it), not a protocol error");
  assert.match(msg.result.content[0].text, /error: /);
  rmSync(dir, { recursive: true, force: true });
});

test("an internal failure while replying becomes a JSON-RPC internal error (-32603)", () => {
  const dir = ws();
  // The first write throws (a broken transport); the handler must convert that
  // into an internal-error frame rather than dying silently.
  let calls = 0;
  const out = [];
  handleLine(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "initialize", params: {} }), (s) => {
    if (++calls === 1) throw new Error("transport down");
    out.push(s);
  });
  assert.equal(out.length, 1, "a second frame was written");
  const msg = JSON.parse(out[0]);
  assert.equal(msg.id, 11);
  assert.equal(msg.error.code, -32603);
  assert.match(msg.error.message, /transport down/);
  rmSync(dir, { recursive: true, force: true });
});

test("mcp --help prints usage and exits 0 (spawned as a main module)", () => {
  const MCP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp.js");
  const r = spawnSync(process.execPath, [MCP, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: geml mcp --workspace <dir>/);
});

console.log(`${passed} test(s) passed.`);
