// `geml mcp` — the document-CRUD MCP server (src/mcp.ts), which also serves the
// read-only code-graph tools when --root holds a code graph.
//
// The acceptance criteria this suite pins, in the order they matter:
//
//   * ten document tools, and the server actually starts over real stdio;
//   * a REFUSED write leaves the file byte-for-byte unchanged (the whole point
//     of routing an agent through this server rather than a text editor);
//   * path confinement holds against `../`, an absolute path, and a symlink
//     planted inside the workspace — this server WRITES, so an escape is worse
//     here than in the read-only code-graph server;
//   * `geml_revert` undoes ONE block after a bad edit while every other
//     byte of the document stays identical. That is the capability no general
//     file-editing tool has, so it gets the most explicit test in the file.
import { configure, handleLine, TOOLS, allTools, loadGraphTools, parseArgs, resolveInRoot } from "../dist/mcp.js";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, rmSync, realpathSync } from "node:fs";
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
  configure({ root: dir, history: true });
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

// The geml_ prefix used to guard against a client that had BOTH servers
// registered. Now the code-graph tools are served from this same process, so
// the namespacing is what keeps the two tables apart inside one tools/list.
test("eleven document tools, all under the geml_ prefix", () => {
  assert.equal(TOOLS.length, 11);
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(names, [
    "geml_list", "geml_find", "geml_get", "geml_check", "geml_history", "geml_to",
    "geml_set", "geml_add", "geml_delete", "geml_rename", "geml_revert",
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
  assert.equal(init.result.serverInfo.name, "geml");
  assert.ok(init.result.capabilities.tools);
  // The roster itself is pinned by the inventory test above; what matters here
  // is that tools/list serves exactly it, whatever it currently holds.
  assert.equal(rpc("tools/list").result.tools.length, TOOLS.length);
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

test("geml_list returns every addressable block, id-less ones included", () => {
  ws();
  const rows = call("geml_list", { file: "d.geml" }).json;
  // Selector design §6: the listing covers EVERY block, so the fixture's
  // anonymous `=== meta` now appears too — flagged `anon`, addressed by its
  // type. The id-bearing blocks still report an `id`, which is what every
  // other tool on this server takes.
  assert.deepEqual(rows.map((b) => b.address), ["=== meta", "#doc", "#alpha", "#beta", "#gamma"]);
  assert.deepEqual(rows.filter((b) => b.id).map((b) => b.id), ["doc", "alpha", "beta", "gamma"]);
  assert.deepEqual(rows.filter((b) => b.anon).map((b) => b.address), ["=== meta"]);
});

test("geml_get and geml_set reach a block with NO id, via the listed address", () => {
  // The listing reports an address for every id-less block; that address has to
  // be usable through this server too, or `geml_list` would be advertising a
  // capability only the CLI has. The parameter is still named `id` — renaming it
  // would break registered clients for a cosmetic gain — so it accepts either.
  const dir = ws("=== note\nfirst\n===\n\n=== note\nsecond\n===\n", "anon.geml");
  const addr = call("geml_list", { file: "anon.geml" }).json[0].address;
  assert.match(addr, /^=== note@[0-9a-f]{8}$/, `listing gave ${addr}`);
  assert.equal(call("geml_get", { file: "anon.geml", id: addr }).text, "=== note\nfirst\n===\n");
  // The bare `@<hex>` form works too — hashId used to make it `#@<hex>`.
  assert.equal(call("geml_get", { file: "anon.geml", id: "@" + addr.split("@")[1] }).text,
    "=== note\nfirst\n===\n");

  const w = call("geml_set", { file: "anon.geml", id: addr, part: "body", body: "REWRITTEN\n" });
  assert.equal(w.json.ok, true, w.text);
  assert.match(readFileSync(join(dir, "anon.geml"), "utf8"), /=== note\nREWRITTEN\n===/);
  // Writing moved the address — it is a function of content (selector §3.2).
  assert.notEqual(call("geml_list", { file: "anon.geml" }).json[0].address, addr);
});

test("geml_set refuses an address matching several blocks instead of picking one", () => {
  ws("=== note\na\n===\n\n=== note\nb\n===\n", "many.geml");
  const r = call("geml_set", { file: "many.geml", id: "=== note", part: "body", body: "x\n" });
  assert.ok(r.isError, "a type filter matching 2 must not write either of them");
  assert.match(r.text, /matches 2 blocks/);
});

test("geml_get returns ONE block, with or without the leading #", () => {
  ws();
  const withHash = call("geml_get", { file: "d.geml", id: "#alpha" }).text;
  const without = call("geml_get", { file: "d.geml", id: "alpha" }).text;
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

test("geml_history says so plainly when there is no sidecar yet", () => {
  ws();
  const log = call("geml_history", { file: "d.geml" }).json;
  assert.deepEqual(log.revisions, []);
  assert.match(log.note, /no \.gemlhistory sidecar yet/);
});

test("geml_to converts a WHOLE document, writes nothing, and reuses the CLI's own defaults", () => {
  const dir = ws();
  // The importer: Markdown in, GEML out — the one conversion the block tools
  // cannot express. `to` is omitted, so the CLI's per-input default applies.
  writeFileSync(join(dir, "notes.md"), "# Title\n\nbody text\n");
  const imported = call("geml_to", { file: "notes.md" });
  assert.match(imported.text, /^# Title/m, "md input defaults to --to geml");
  assert.ok(!existsSync(join(dir, "notes.geml")), "a conversion writes NOTHING");

  // A GEML input defaults to the document model, and md/html are available too.
  assert.equal(call("geml_to", { file: "d.geml" }).json.kind, "document");
  assert.match(call("geml_to", { file: "d.geml", to: "md" }).text, /first block/);
  assert.match(call("geml_to", { file: "d.geml", to: "html" }).text, /<!doctype html>/i);
  assert.match(call("geml_to", { file: "d.geml", to: "geml" }).text, /=== note \{#alpha\}/);

  // `from` overrides the extension; an unknown format is this server's error.
  writeFileSync(join(dir, "plain.txt"), "# From txt\n\nbody\n");
  assert.match(call("geml_to", { file: "plain.txt", from: "md", to: "geml" }).text, /^# From txt/m);
  const bad = call("geml_to", { file: "d.geml", to: "pdf" });
  assert.ok(bad.isError);
  assert.match(bad.text, /unknown `to` format: pdf/);
  const badFrom = call("geml_to", { file: "d.geml", from: "rst" });
  assert.ok(badFrom.isError);
  assert.match(badFrom.text, /unknown `from` format: rst/, "this server names the refused argument, not the CLI");

  // A broken document surfaces its diagnostics rather than handing back output
  // the model was told nothing about.
  writeFileSync(join(dir, "broken.geml"), "see [[#nowhere]]\n");
  const broke = call("geml_to", { file: "broken.geml", to: "md" });
  assert.ok(broke.isError);
  assert.match(broke.text, /unresolved-reference|unresolved reference/);
});

// ---------------------------------------------------------------------------
// Invariant 1 — a refused write never reaches disk
// ---------------------------------------------------------------------------

test("a write that would break the document is REFUSED and the file is byte-identical", () => {
  const dir = ws();
  const file = join(dir, "d.geml");
  const before = readFileSync(file);

  const r = call("geml_set", { file: "d.geml", id: "beta", part: "body", body: "now see [[#ghost]]" });

  assert.equal(r.json.ok, false);
  assert.equal(r.isError, true, "the client sees a tool error, so the model cannot read it as success");
  assert.equal(r.json.diagnostics[0].code, "unresolved-reference");
  assert.match(r.json.hint, /the file on disk is unchanged/);
  assert.deepEqual(readFileSync(file), before, "not one byte of the document changed");
});

test("a refusal names every problem, not just the first", () => {
  const dir = ws();
  const r = call("geml_set", { file: "d.geml", id: "beta", part: "body", body: "[[#ghost1]] and [[#ghost2]]" });
  assert.equal(r.json.ok, false);
  const refs = r.json.diagnostics.map((d) => d.message).join(" ");
  assert.match(refs, /ghost1/);
  assert.match(refs, /ghost2/, "the second broken reference is reported too");
});

test("a good write lands, and records the pre-write state as a revision", () => {
  const dir = ws();
  const file = join(dir, "d.geml");
  const r = call("geml_set", { file: "d.geml", id: "alpha", part: "body", body: "rewritten" });
  assert.equal(r.json.ok, true);
  assert.ok(r.json.revision, "a revision id came back");
  const now = readFileSync(file, "utf8");
  assert.ok(now.includes("rewritten"));
  assert.ok(!now.includes("first block"));
  assert.ok(existsSync(join(dir, "d.gemlhistory")), "the sidecar was created before the write");
});

test("--no-history writes without taking a snapshot", () => {
  const dir = ws();
  configure({ root: dir, history: false });
  const r = call("geml_set", { file: "d.geml", id: "alpha", part: "body", body: "rewritten" });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.revision, undefined);
  assert.ok(!existsSync(join(dir, "d.gemlhistory")), "no sidecar when history is off");
});

// ---------------------------------------------------------------------------
// Invariant 3 — path confinement
// ---------------------------------------------------------------------------

test("`../` traversal is refused", () => {
  ws();
  for (const tool of ["geml_get", "geml_set"]) {
    const r = call(tool, { file: "../../../etc/passwd", id: "x", body: "y" });
    assert.equal(r.isError, true);
    assert.match(r.text, /escapes the server root|no such file/);
  }
});

test("an absolute path outside the workspace is refused", () => {
  ws();
  const r = call("geml_get", { file: "/etc/passwd", id: "x" });
  assert.equal(r.isError, true);
  // On POSIX /etc/passwd escapes the workspace; on Windows it hits the
  // "no such file" branch first — both are a refusal (matches :199).
  assert.match(r.text, /escapes the server root|no such file/);
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
  const r = call("geml_get", { file: "link.geml", id: "s" });
  assert.equal(r.isError, true, "following the link out of the workspace is refused");
  assert.match(r.text, /escapes the server root/);
  assert.ok(!r.text.includes("top secret"), "the outside content never came back");
  rmSync(outside, { recursive: true, force: true });
});

test("geml_check's `root` may narrow inside the workspace but never escape it", () => {
  const dir = ws();
  mkdirSync(join(dir, "sub"));
  assert.ok(call("geml_check", { file: "d.geml", root: "sub" }).json, "an inside root is accepted");
  const r = call("geml_check", { file: "d.geml", root: "../.." });
  assert.equal(r.isError, true);
  assert.match(r.text, /escapes the server root/);
});

test("resolveInRoot rejects a directory, an empty path, and a nonexistent file", () => {
  const dir = ws();
  mkdirSync(join(dir, "adir"));
  assert.throws(() => resolveInRoot("adir"), /not a file/);
  assert.throws(() => resolveInRoot(""), /required/);
  // A file that simply does not exist inside the workspace is refused the same
  // on every OS. (The /etc/passwd test hits this branch only where the file is
  // absent — Windows — so this keeps the confinement covered on Linux too.)
  assert.throws(() => resolveInRoot("ghost.geml"), /no such file under the server root/);
});

test("resolveInRoot refuses an absolute path to a real file OUTSIDE the workspace (any OS)", () => {
  ws();
  const outside = mkdtempSync(join(tmpdir(), "geml-outside-"));
  const f = join(outside, "real.geml");
  writeFileSync(f, "=== note {#x}\nhi\n===\n");
  // The file EXISTS, so realpath succeeds and the escape check is what must
  // reject it — covering the core confinement branch on every OS without a
  // symlink (which Windows skips), and where `../` paths hit "no such file" first.
  assert.throws(() => resolveInRoot(f), /escapes the server root/);
  rmSync(outside, { recursive: true, force: true });
});

test("geml_check refuses a `root` directory that does not exist in the workspace", () => {
  ws();
  const r = call("geml_check", { file: "d.geml", root: "no-such-dir" });
  assert.equal(r.isError, true, JSON.stringify(r.json ?? r.text));
  assert.match(r.text, /no such directory under the server root/);
});

// ---------------------------------------------------------------------------
// Invariant 2 + the differentiator — revert ONE block, leave the rest alone
// ---------------------------------------------------------------------------

test("geml_revert undoes ONE block after a bad edit; every other byte is unchanged", () => {
  const dir = ws();
  const file = join(dir, "d.geml");

  // 1. A legitimate edit to a DIFFERENT block — the work we must not lose.
  assert.equal(call("geml_set", { file: "d.geml", id: "gamma", part: "body", body: "third block, improved" }).json.ok, true);
  const good = readFileSync(file, "utf8");
  assert.ok(good.includes("third block, improved"));

  // 2. A bad-but-valid edit to #alpha: it parses, so nothing refuses it.
  assert.equal(call("geml_set", { file: "d.geml", id: "alpha", part: "body", body: "GARBAGE the model hallucinated" }).json.ok, true);
  assert.ok(readFileSync(file, "utf8").includes("GARBAGE"));

  // 3. Revert ONLY #alpha.
  const rev = call("geml_revert", { file: "d.geml", id: "alpha" });
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

test("geml_revert (default) undoes the block just touched — even after a SINGLE edit", () => {
  // The reviewer's minimal case: ONE edit, then revert with no `rev`. The CLI's
  // own default `-1` overshoots (out-of-ranges / no-ops); the MCP default
  // (`--rev changed`) walks to #alpha's previous distinct version.
  const dir = ws();
  const file = join(dir, "d.geml");
  call("geml_set", { file: "d.geml", id: "alpha", part: "body", body: "BAD single edit" });
  assert.ok(readFileSync(file, "utf8").includes("BAD single edit"));
  const rev = call("geml_revert", { file: "d.geml", id: "alpha" });
  assert.equal(rev.json?.ok, true, JSON.stringify(rev.json ?? rev.text));
  const after = readFileSync(file, "utf8");
  assert.ok(!after.includes("BAD single edit"), "the single bad edit is undone");
  assert.ok(after.includes("first block"), "#alpha restored to its pre-edit content");
});

test("geml_revert (default) undoes a block even after ANOTHER block was written since", () => {
  // Why the default is `--rev changed`, not `latest`: `latest` (the tip) is the
  // state after the #gamma write, where #alpha already equals current -> it
  // would silently no-op (ok:true, nothing undone). `--rev changed` walks back to
  // #alpha's own previous version, so the stale intervening write can't mask it.
  const dir = ws();
  const file = join(dir, "d.geml");
  call("geml_set", { file: "d.geml", id: "alpha", part: "body", body: "BAD alpha" });
  call("geml_set", { file: "d.geml", id: "gamma", part: "body", body: "later gamma edit" });
  const rev = call("geml_revert", { file: "d.geml", id: "alpha" });
  assert.equal(rev.json?.ok, true, JSON.stringify(rev.json ?? rev.text));
  const after = readFileSync(file, "utf8");
  assert.ok(!after.includes("BAD alpha"), "#alpha's bad edit is undone");
  assert.ok(after.includes("first block"), "#alpha restored to its pre-edit content");
  assert.ok(after.includes("later gamma edit"), "the intervening #gamma edit is preserved");
});

test("geml_history's offsets are the selectors geml_revert takes", () => {
  const dir = ws();
  call("geml_set", { file: "d.geml", id: "alpha", part: "body", body: "v2" });
  call("geml_set", { file: "d.geml", id: "alpha", part: "body", body: "v3" });
  const revs = call("geml_history", { file: "d.geml" }).json.revisions;
  assert.ok(revs.length >= 2);
  assert.equal(revs[0].offset, 0);
  assert.equal(revs[0].current, true);
  const r = call("geml_revert", { file: "d.geml", id: "alpha", rev: "-1" });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
});

test("geml_history with `rev` returns that revision's text, using the CLI's selector grammar", () => {
  // The second tier of `geml history get`: an agent about to revert can read
  // what the document looked like at a revision without restoring it. The
  // selector grammar is the CLI's, so `0` / `-N` / an id all resolve here too.
  ws();
  call("geml_set", { file: "d.geml", id: "alpha", part: "body", body: "v2" });
  const revs = call("geml_history", { file: "d.geml" }).json.revisions;
  const tip = call("geml_history", { file: "d.geml", rev: "0" }).json;
  assert.equal(tip.id, revs[0].id, "`0` is the tip, as on the CLI");
  assert.match(tip.text, /first block/, "the tip holds the PRE-write state this server saved");
  assert.equal(call("geml_history", { file: "d.geml", rev: revs[0].id }).json.text, tip.text,
    "an id selects the same revision as its offset");
  // No sidecar at all: the LIST tier answers "nothing yet", but naming a
  // revision of a document that has no history is an error — the caller asked
  // for specific content and there is none.
  const dir = ws();
  writeFileSync(join(dir, "fresh.geml"), "=== note {#solo}\nbody\n===\n");
  assert.deepEqual(call("geml_history", { file: "fresh.geml" }).json.revisions, []);
  const missing = call("geml_history", { file: "fresh.geml", rev: "0" });
  assert.match(missing.text, /no \.gemlhistory sidecar for fresh\.geml/);
});

test("every revision selector the tool DESCRIPTIONS name is one the resolver accepts", () => {
  // A tool description is the model's only instruction manual: a selector named
  // there and rejected at runtime is a defect the model cannot route around.
  // This drifted once already — `latest` was dropped from the resolver while
  // both the description and the guide still advertised it — so pull the
  // selectors out of the prose and put each through the real tool.
  const dir = ws();
  const revertTool = TOOLS.find((t) => t.name === "geml_revert");
  const prose = `${revertTool.description} ${revertTool.inputSchema.properties.rev.description}`;

  // Word-shaped selectors are the ones that rot: `-N`/`0` are grammar and an id
  // is data, but a keyword like `latest` only works while the resolver knows it.
  const keywords = [...prose.matchAll(/`([a-z][a-z]+)`/g)].map((m) => m[1]);
  const notSelectors = new Set(["rev", "geml_history", "id", "prefix", "true", "false"]);
  const claimed = [...new Set(keywords)].filter((w) => !notSelectors.has(w));

  call("geml_set", { file: "d.geml", id: "alpha", part: "body", body: "v2" });
  call("geml_set", { file: "d.geml", id: "alpha", part: "body", body: "v3" });

  for (const sel of claimed) {
    const r = call("geml_revert", { file: "d.geml", id: "alpha", rev: sel });
    assert.ok(
      !/matched 0 revisions/.test(r.json?.hint ?? ""),
      `the description names \`${sel}\` as a selector, but the resolver rejects it: ${r.json?.hint}`,
    );
  }

  // And the selectors the description DOES name are exercised for real.
  const revs = call("geml_history", { file: "d.geml" }).json.revisions;
  for (const sel of ["0", "-1", revs[revs.length - 1].id]) {
    const r = call("geml_revert", { file: "d.geml", id: "alpha", rev: sel });
    assert.ok(
      !/matched 0 revisions/.test(r.json?.hint ?? ""),
      `documented selector \`${sel}\` was rejected: ${r.json?.hint}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The remaining write tools
// ---------------------------------------------------------------------------

test("geml_add appends, and inserts before/after an anchor", () => {
  const dir = ws();
  assert.equal(call("geml_add", { file: "d.geml", content: "=== note {#tail}\nend\n===\n", position: "append" }).json.ok, true);
  assert.equal(call("geml_add", { file: "d.geml", content: "=== note {#head}\ntop\n===\n", position: "before", anchor: "alpha" }).json.ok, true);
  const ids = call("geml_list", { file: "d.geml" }).json.map((b) => b.id);
  assert.ok(ids.includes("tail") && ids.includes("head"));
  assert.ok(ids.indexOf("head") < ids.indexOf("alpha"), "`before` really placed it before the anchor");
});

test("geml_add needs an anchor for before/after, and rejects a bad position", () => {
  ws();
  assert.match(call("geml_add", { file: "d.geml", content: "x", position: "before" }).text, /needs an `anchor`/);
  assert.match(call("geml_add", { file: "d.geml", content: "x", position: "sideways" }).text, /append\|before\|after/);
});

test("an id clash on insert is refused and the file is unchanged", () => {
  const dir = ws();
  const before = readFileSync(join(dir, "d.geml"));
  const r = call("geml_add", { file: "d.geml", content: "=== note {#alpha}\ndupe\n===\n", position: "append" });
  assert.equal(r.json.ok, false);
  assert.deepEqual(readFileSync(join(dir, "d.geml")), before);
});

test("geml_delete removes a block, and a dangling reference is reported but NOT blocking", () => {
  const dir = ws();
  // #alpha is referenced by #beta: deleting it is deliberate, so it proceeds
  // and the caller is told what it broke (the CLI's documented contract).
  const r = call("geml_delete", { file: "d.geml", ids: ["alpha"] });
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
  const r = call("geml_delete", { file: "solo.geml", ids: ["only"] });
  assert.equal(r.isError, true, JSON.stringify(r.json ?? r.text));
  assert.match(r.text, /produced no output|nothing was written/);
  assert.ok(readFileSync(join(dir, "solo.geml"), "utf8").includes("the whole document"), "the file was NOT destroyed");
});

test("geml_delete requires at least one id", () => {
  ws();
  assert.match(call("geml_delete", { file: "d.geml", ids: [] }).text, /at least one block/);
});

test("geml_rename renames the block AND every reference to it", () => {
  const dir = ws();
  const r = call("geml_rename", { file: "d.geml", old: "alpha", new: "renamed" });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  const after = readFileSync(join(dir, "d.geml"), "utf8");
  assert.ok(after.includes("{#renamed}"), "the block id changed");
  assert.ok(after.includes("[[#renamed]]"), "the reference in #beta followed it");
  assert.ok(!after.includes("#alpha"), "no stale id is left behind");
  assert.equal(call("geml_check", { file: "d.geml" }).json.ok, true, "the document is still valid");
});

test("a no-op write is reported as such rather than churning a revision", () => {
  ws();
  const r = call("geml_set", { file: "d.geml", id: "alpha", part: "body", body: "first block" });
  assert.equal(r.json.ok, true);
  assert.match(r.json.hint, /No change/);
});

test("a document with PRE-EXISTING errors refuses writes, and says the edit was not the cause", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-mcp-"));
  const file = join(dir, "b.geml");
  writeFileSync(file, "=== note {#x}\nbroken: [[#missing]]\n===\n\n=== note {#y}\nfixable\n===\n");
  configure({ root: dir, history: true });
  const before = readFileSync(file);

  // The CLI's pre-write check refuses on ANY error in the result, including one
  // the document already had. So editing an unrelated block is refused too —
  // the document is locked until the existing break is repaired. That is worth
  // pinning: the value is entirely in the model being TOLD why.
  const r = call("geml_set", { file: "b.geml", id: "y", part: "body", body: "edited anyway" });
  assert.equal(r.json.ok, false);
  assert.deepEqual(readFileSync(file), before, "nothing was written");
  assert.match(r.json.hint, /ALREADY in the document before this edit/);
  assert.match(r.json.hint, /Repair them first/);

  // And repairing the actual break is never blocked — the escape hatch works.
  const fix = call("geml_set", { file: "b.geml", id: "x", part: "body", body: "repaired" });
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
  const ok = call("geml_set", { file: "d.geml", id: "gamma", part: "body", body: "see [t](other.geml#target)" });
  assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
  const bad = call("geml_set", { file: "d.geml", id: "gamma", part: "body", body: "see [t](other.geml#ghost)" });
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
  const r = call("geml_set", { file: "d.geml", id: "alpha", part: "body", body: "still written" });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.equal(r.json.revision, undefined, "no revision was recorded");
  assert.ok(readFileSync(join(dir, "d.geml"), "utf8").includes("still written"));
});

// ---------------------------------------------------------------------------
// Startup — the `claude mcp add …` command has to actually work
// ---------------------------------------------------------------------------

test("parseArgs requires --root and validates it is a directory", () => {
  assert.throws(() => parseArgs([]), /--root <dir> is required/);
  assert.throws(() => parseArgs(["--root", join(tmpdir(), "definitely-not-here-9137")]), /not a directory/);
  const dir = mkdtempSync(join(tmpdir(), "geml-mcp-"));
  assert.equal(parseArgs(["--root", dir]).history, true);
  assert.equal(parseArgs([`--root=${dir}`, "--no-history"]).history, false);
  assert.throws(() => parseArgs(["--root", dir, "--bogus"]), /unknown option/);
});

test("`geml mcp --root <dir>` starts and answers a real stdio handshake", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-mcp-"));
  writeFileSync(join(dir, "d.geml"), DOC);
  const frames = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "geml_get", arguments: { file: "d.geml", id: "alpha" } } }),
  ].join("\n") + "\n";

  const r = spawnSync(process.execPath, [CLI, "mcp", "--root", dir], { input: frames, encoding: "utf8", timeout: 30000 });
  const replies = r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(replies.length, 3, `three frames in, three out (stderr: ${r.stderr})`);
  assert.equal(replies[0].result.serverInfo.name, "geml");
  assert.equal(replies[1].result.tools.length, TOOLS.length, "the spawned server serves the same roster");
  assert.match(replies[2].result.content[0].text, /first block/);
});

test("`geml mcp` without --root exits 2 with usage, rather than serving everything", () => {
  const r = spawnSync(process.execPath, [CLI, "mcp"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--root <dir> is required/);
});

// ---------------------------------------------------------------------------
// argument handling + protocol edges (the agent-facing contract)
// ---------------------------------------------------------------------------

test("write_block: an unknown `part` is rejected by name, before anything is written", () => {
  const dir = ws();
  const before = readFileSync(join(dir, "d.geml"), "utf8");
  const r = call("geml_set", { file: "d.geml", id: "alpha", body: "x", part: "sideways" });
  assert.ok(r.isError, "reported as an error result");
  assert.match(r.text, /part must be whole\|head\|body, got `sideways`/);
  assert.equal(readFileSync(join(dir, "d.geml"), "utf8"), before, "the document is untouched");
  rmSync(dir, { recursive: true, force: true });
});

test("write_block: part=head and part=body each target only that span", () => {
  const dir = ws();
  const h = call("geml_set", { file: "d.geml", id: "alpha", body: "=== note {#alpha .lead}", part: "head" });
  assert.ok(!h.isError, h.text);
  let doc = readFileSync(join(dir, "d.geml"), "utf8");
  assert.match(doc, /=== note \{#alpha \.lead\}/, "head replaced");
  assert.match(doc, /first block/, "body untouched by a head write");
  const b = call("geml_set", { file: "d.geml", id: "alpha", body: "rewritten body", part: "body" });
  assert.ok(!b.isError, b.text);
  doc = readFileSync(join(dir, "d.geml"), "utf8");
  assert.match(doc, /rewritten body/, "body replaced");
  assert.match(doc, /=== note \{#alpha \.lead\}/, "head survives a body write");
  rmSync(dir, { recursive: true, force: true });
});

test("write_block: `part` defaults to whole — the block is replaced head and body", () => {
  const dir = ws();
  const r = call("geml_set", { file: "d.geml", id: "alpha", body: "=== note {#alpha}\nbrand new\n===" });
  assert.ok(!r.rpcError, JSON.stringify(r.rpcError));
  assert.ok(!r.isError, r.text);
  const doc = readFileSync(join(dir, "d.geml"), "utf8");
  assert.match(doc, /brand new/);
  assert.doesNotMatch(doc, /first block/, "the whole block went, not just the head");
  rmSync(dir, { recursive: true, force: true });
});

test("delete_block: removing a REFERENCED block is allowed; the dangling ref is a diagnostic, not a veto", () => {
  const dir = ws(); // #beta contains [[#alpha]]
  const r = call("geml_delete", { file: "d.geml", ids: ["alpha"] });
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
  const r = call("geml_delete", { file: "d.geml", ids: "gamma" });
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
  handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "geml_get" } }), (s) => out.push(s));
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
  assert.match(r.stdout, /usage: geml mcp --root <dir>/);
});


// The version the MCP handshake reports must be the version on npm. These were
// two independent literals and had silently diverged (handshake 0.1.0 against a
// 1.4.x package) — a comment saying "keep in sync" is not a mechanism.
test("serverInfo.version is the package version, not a second literal", () => {
  ws();
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const init = rpc("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(init.result.serverInfo.version, pkg.version);
});

// The flag was --workspace before. A bare `unknown option` would strand anyone
// upgrading with a client config they cannot debug — the only symptom a client
// surfaces is that the server did not start.
test("the old --workspace flag names its replacement instead of failing blankly", () => {
  for (const argv of [["--workspace", "/tmp"], ["-w", "/tmp"], ["--workspace=/tmp"]]) {
    assert.throws(() => parseArgs(argv), /--workspace is now --root/, argv.join(" "));
  }
});

// ---------------------------------------------------------------------------
// Code-graph tools, served from this same process
// ---------------------------------------------------------------------------
// `geml codemap mcp` and `geml mcp` were two stdio servers, so a client had to
// register two entries and run two processes. They are now one: when --root
// holds a code graph, this server also serves the three read-only graph tools.
//
// Merging forced one disagreement to be settled. Standalone `codemap mcp` lets
// the client name `graph_dir` per call — safe there, because that server only
// reads. This process WRITES, so the tests below pin the tightened rule: a
// client-named graph_dir is narrowed to --root exactly like every other path,
// and the env-var default the standalone server honours is shut out.
await loadGraphTools();

const GRAPH_AUTH = `=== meta
module = auth
===

=== code {#login src=src/login.ts#L1-9 anchor="a1"}
===

=== table {#called-by format=csv}
from, to, kind, site
#login, #issueToken, call, src/login.ts:3
===
`;

// A root that holds BOTH a .geml document and a code graph — the shape the
// merge exists for (one directory, one server, one client entry).
function wsGraph({ index = true, dirName = ".geml-code-graph" } = {}) {
  const dir = ws();
  const graph = join(dir, dirName);
  mkdirSync(join(graph, "_index"), { recursive: true });
  if (index) writeFileSync(join(graph, "index.geml"), "=== meta\nrepo = demo\n===\n");
  writeFileSync(join(graph, "auth.geml"), GRAPH_AUTH);
  writeFileSync(join(graph, "_index", "name-lookup.json"), JSON.stringify({ login: [{ doc: "auth.geml", id: "login" }] }));
  return { dir, graph };
}

test("no code graph under --root: the graph tools are not served at all", () => {
  ws();
  configure({ graph: undefined });
  const names = allTools().map((t) => t.name);
  assert.equal(names.length, TOOLS.length, "the document tools, and nothing else");
  assert.ok(!names.includes("geml_codemap_search"), "a graph tool a client cannot use must not be listed");
  // Listed or not, calling one must not fall back to some other directory.
  assert.ok(call("geml_codemap_search", { query: "login" }).rpcError, "unknown tool");
});

test("a code graph under --root: both tables from one process, one handshake", () => {
  const { graph } = wsGraph();
  configure({ graph });
  const names = allTools().map((t) => t.name);
  assert.equal(names.length, TOOLS.length + 4);
  assert.deepEqual(names.slice(TOOLS.length),
    ["geml_codemap_search", "geml_codemap_callchain", "geml_codemap_list", "geml_codemap_node"]);
  // The whole point: one tools/list carries both tables.
  const listed = rpc("tools/list").result.tools.map((t) => t.name);
  assert.deepEqual(listed, names);
});

test("the code-graph tools actually work through this server", () => {
  const { graph } = wsGraph();
  configure({ graph });

  const found = call("geml_codemap_search", { query: "login", exact: true });
  assert.match(found.text, /^login	auth\.geml#login/m);

  const block = call("geml_codemap_node", { doc: "auth.geml", id: "login" });
  assert.ok(block.text.includes("src/login.ts#L1-9"), block.text);

  const callers = call("geml_codemap_node", { doc: "auth.geml", id: "#called-by" });
  assert.ok(callers.text.includes("#login"), callers.text);

  // A document tool and a graph tool answer from the SAME configured root.
  assert.ok(call("geml_list", { file: "d.geml" }).json.some((b) => b.id === "alpha"));
});

test("a client-named graph_dir may narrow into --root, never escape it", () => {
  const { dir, graph } = wsGraph();
  configure({ graph });

  // Narrowing to the same directory by relative name is fine.
  assert.match(call("geml_codemap_search", { query: "login", exact: true, graph_dir: ".geml-code-graph" }).text,
    /^login	auth\.geml#login/m);

  // Escapes: absolute, `../`, and a symlink planted inside the root.
  const outside = mkdtempSync(join(tmpdir(), "geml-mcp-outside-"));
  mkdirSync(join(outside, "_index"), { recursive: true });
  writeFileSync(join(outside, "_index", "name-lookup.json"), JSON.stringify({ login: [{ doc: "SECRET", id: "x" }] }));
  // Windows refuses symlinks without elevation (EPERM); the absolute and `../`
  // escapes still cover the guard there, so plant the link only when we can.
  const escapes = [outside, "../"];
  try {
    symlinkSync(outside, join(dir, "link-out"));
    escapes.push("link-out");
  } catch { /* symlinks unavailable on this platform */ }
  for (const escape of escapes) {
    const r = call("geml_codemap_search", { query: "login", exact: true, graph_dir: escape });
    assert.ok(r.isError, `graph_dir ${escape} must be refused`);
    assert.match(r.text, /escapes the server root|no such directory under the server root/, r.text);
    assert.ok(!r.text.includes("SECRET"), "a refused read must not leak what it would have returned");
  }

  // The graph server's own guard still applies underneath ours: `doc` stays in
  // the graph dir even when graph_dir itself was legal.
  const esc = call("geml_codemap_node", { doc: "../d.geml", id: "alpha" });
  assert.ok(esc.isError && /escapes the graph dir/.test(esc.text), esc.text);
  rmSync(outside, { recursive: true, force: true });
});

test("GEML_GRAPH_DIR cannot redirect this server", () => {
  const { graph } = wsGraph();
  configure({ graph });
  // The standalone server falls back to this env var. Here the directory is
  // resolved before the tool runs, so an env var set in the client's shell —
  // which the operator running --root never chose — must not be consulted.
  const prev = process.env.GEML_GRAPH_DIR;
  process.env.GEML_GRAPH_DIR = mkdtempSync(join(tmpdir(), "geml-mcp-env-"));
  try {
    assert.match(call("geml_codemap_search", { query: "login", exact: true }).text, /^login	auth\.geml#login/m);
  } finally {
    if (prev === undefined) delete process.env.GEML_GRAPH_DIR; else process.env.GEML_GRAPH_DIR = prev;
  }
});

test("--graph must be a directory inside --root", () => {
  const { dir, graph } = wsGraph();
  assert.equal(parseArgs(["--root", dir, "--graph", graph]).graph, realpathSync(graph));
  assert.equal(parseArgs(["--root", dir, "--graph=.geml-code-graph"]).graph, realpathSync(graph));
  assert.throws(() => parseArgs(["--root", dir, "--graph", tmpdir()]), /--graph must live inside --root/);
  assert.throws(() => parseArgs(["--root", dir, "--graph", "nope"]), /--graph is not a directory/);
});

// Auto-detection has to be SURE it found a graph: an unrelated directory that
// happens to be named .geml-code-graph must not make three broken tools appear.
// An explicit --graph is the operator's word and only has to exist.
test("the default graph is adopted only when .geml-code-graph holds an index.geml", () => {
  const withIndex = wsGraph();
  assert.equal(parseArgs(["--root", withIndex.dir]).graph, realpathSync(withIndex.graph));

  const noIndex = wsGraph({ index: false });
  assert.equal(parseArgs(["--root", noIndex.dir]).graph, undefined);
  assert.equal(parseArgs(["--root", noIndex.dir, "--graph", noIndex.graph]).graph, realpathSync(noIndex.graph));
});

test("a real `geml mcp --root` process serves the graph tools over stdio", () => {
  const { dir } = wsGraph();
  const frames = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "geml_codemap_search", arguments: { query: "login", exact: true } } },
  ].map((f) => JSON.stringify(f)).join("\n") + "\n";
  const r = spawnSync(process.execPath, [resolve(dirname(CLI), "mcp.js"), "--root", dir], { input: frames, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const msgs = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(msgs.find((m) => m.id === 2).result.tools.some((t) => t.name === "geml_codemap_search"),
    "the graph tools must be loaded BEFORE the first tools/list can arrive");
  assert.match(msgs.find((m) => m.id === 3).result.content[0].text, /auth\.geml/);
});

// ---------------------------------------------------------------------------
// The naming contract: a tool name IS its CLI path
// ---------------------------------------------------------------------------

// Every tool mirrors the command it wraps — `geml set` -> `geml_set`,
// `geml codemap search` -> `geml_codemap_search` — so one vocabulary covers both
// surfaces and a model that learned the CLI already knows the tools. This test
// exists because that correspondence is the kind of thing that rots silently:
// add a tool called `geml_write_block` and nothing else would complain.
test("every tool name is `geml_` + its CLI path, and each maps to a real command", () => {
  const { graph } = wsGraph();
  configure({ graph });
  const names = allTools().map((t) => t.name);

  // The document tools: the CLI command paths, verbatim. `list` is `geml get`
  // with no id and `history` is the `geml history` GROUP (only its read verb,
  // `get`, is served) — the two places where the tool is narrower than the path
  // it names, which is why the help text says "command path" and not "verb".
  const docVerbs = ["list", "find", "get", "check", "history", "to", "set", "add", "delete", "rename", "revert"];
  assert.deepEqual(names.slice(0, docVerbs.length), docVerbs.map((v) => `geml_${v}`));

  // The graph tools: `geml codemap <sub>`.
  const graphSubs = ["search", "callchain", "list", "node"];
  assert.deepEqual(names.slice(docVerbs.length), graphSubs.map((s) => `geml_codemap_${s}`));

  // No leftover shape from the old naming: no `_block`/`_id` suffixes, no
  // unprefixed name, no `get_`/`open_`/`_symbols` verbiage.
  for (const n of names) {
    assert.ok(n.startsWith("geml_"), `${n} must carry the geml_ prefix`);
    assert.doesNotMatch(n, /_block$|_id$|_symbols?$|^get_|^open_|^resolve_|^search_|^trace_/, `${n} keeps a retired naming shape`);
  }

  // And the CLI really does answer to each document verb (a name that mirrors
  // nothing is the failure this guards): every verb appears in `geml --help`.
  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" }).stdout;
  for (const v of docVerbs) {
    if (v === "to") continue;                 // the bare transform entry: `geml <file> --to <fmt>`
    assert.match(help, new RegExp(`geml ${v}\\b`), `\`geml ${v}\` is missing from --help`);
  }

  // And the help a user actually reads before registering the server has to name
  // the tools it will get. This text is prose in SUBHELP, so the rename missed
  // it entirely: `geml mcp --help` went on advertising geml_list_ids and
  // resolve_name long after both were gone. Derive the expectation from
  // allTools() so it cannot drift again.
  const mcpHelp = spawnSync(process.execPath, [CLI, "mcp", "--help"], { encoding: "utf8" }).stdout;
  for (const n of names) assert.ok(mcpHelp.includes(n), `\`geml mcp --help\` never mentions ${n}`);
  for (const retired of [
    "geml_list_ids", "geml_read_block", "geml_write_block", "geml_add_block",
    "geml_delete_block", "geml_rename_id", "geml_revert_block", "geml_history_log",
    "resolve_name", "open_symbol", "get_backlinks",
  ]) {
    assert.ok(!mcpHelp.includes(retired), `\`geml mcp --help\` still advertises the retired ${retired}`);
    assert.ok(!help.includes(retired), `\`geml --help\` still advertises the retired ${retired}`);
  }
});

// The MCP registry keys a release on the version in server.json, NOT the one in
// package.json — and nothing else in the build reads server.json, so it drifts
// silently. It did: a 1.4.5 publish resolved to 1.4.4 and the registry refused
// it as a duplicate, which is only discoverable by dispatching the release
// workflow and watching it fail. Pin the three fields to each other instead.
test("server.json declares the version and package this build actually publishes", () => {
  const at = (...p) => join(dirname(fileURLToPath(import.meta.url)), "..", ...p);
  const pkg = JSON.parse(readFileSync(at("package.json"), "utf8"));
  const server = JSON.parse(readFileSync(at("server.json"), "utf8"));

  assert.equal(server.version, pkg.version, "server.json .version lags package.json — the registry would see a duplicate");
  assert.equal(server.packages.length, 1, "one published package; a second needs its own version assertion");
  const npm = server.packages[0];
  assert.equal(npm.version, pkg.version, "server.json packages[0].version lags package.json — the registry would point at the wrong tarball");
  assert.equal(npm.identifier, pkg.name, "server.json points at a different npm package than this one");

  // The Claude Code plugin is the third place a version is declared, and the
  // one where lagging is silent: a plugin's users "only receive updates when
  // you bump this field", so a stale value does not fail anything — it just
  // means nobody gets the new skill text or hooks. It sat at 1.7.0 while the
  // package shipped 1.7.5.
  // Same for the Codex plugin: a second harness, a second manifest, the same
  // silent-lag failure mode.
  for (const [dir, manifestDir] of [["claude-plugin", ".claude-plugin"], ["codex-plugin", ".codex-plugin"]]) {
    const plugin = JSON.parse(readFileSync(at("..", "integrations", dir, manifestDir, "plugin.json"), "utf8"));
    assert.equal(plugin.version, pkg.version, `${dir}/${manifestDir}/plugin.json lags package.json — installed plugins would never see this release`);
  }

  // Both plugins also carry a launch command for this same server — inline in
  // the Claude manifest, in a separate .mcp.json for Codex, because that is
  // what each harness reads. Drop `--root .` from one and that harness's users
  // get a server confined to the wrong directory, with nothing failing.
  const claudeLaunch = JSON.parse(readFileSync(at("..", "integrations", "claude-plugin", ".claude-plugin", "plugin.json"), "utf8")).mcpServers.geml;
  const codexLaunch = JSON.parse(readFileSync(at("..", "integrations", "codex-plugin", ".mcp.json"), "utf8")).mcp_servers.geml;
  assert.deepEqual(codexLaunch, claudeLaunch, "the two plugins start the geml server differently — one harness is misconfigured");
  assert.deepEqual(codexLaunch.args.slice(-2), ["--root", "."], "the bundled server must stay confined to the session's project directory");

  // Three more manifests carry that same launch command, two of them a version,
  // and nothing in this build reads any of them either — the same silent-lag
  // failure mode, once per vendor. gemini-extension.json and kimi.plugin.json
  // sit at the REPOSITORY ROOT because that is where each vendor looks: the
  // Gemini gallery crawler requires the manifest "in the absolute root of the
  // repository or the release archive", and Kimi Code reads kimi.plugin.json
  // from the plugin root. The Grok one is a directory a marketplace PR vendors
  // a copy of, so a stale version there ships straight to a reviewer.
  const grokDir = at("..", "integrations", "grok-plugin");
  for (const [what, file] of [
    ["gemini-extension.json", at("..", "gemini-extension.json")],
    ["grok-plugin/.grok-plugin/plugin.json", join(grokDir, ".grok-plugin", "plugin.json")],
  ]) {
    assert.equal(
      JSON.parse(readFileSync(file, "utf8")).version,
      pkg.version,
      `${what} lags package.json — that listing would advertise a version this build never published`,
    );
  }
  for (const [what, file] of [
    ["gemini-extension.json", at("..", "gemini-extension.json")],
    ["kimi.plugin.json", at("..", "kimi.plugin.json")],
    ["grok-plugin/.mcp.json", join(grokDir, ".mcp.json")],
  ]) {
    assert.deepEqual(
      JSON.parse(readFileSync(file, "utf8")).mcpServers.geml,
      claudeLaunch,
      `${what} starts the geml server differently — that harness is misconfigured`,
    );
  }

  // The manifest is also what tells a client how to start the server; these two
  // are the difference between a working entry and one that launches nothing.
  assert.equal(npm.transport.type, "stdio");
  assert.deepEqual(
    npm.packageArguments.filter((a) => a.type === "positional").map((a) => a.value),
    ["mcp"],
    "the published launch command must still be `<pkg> mcp`",
  );
});

// `geml_codemap_node(source: true)` reads real files, and the directory it
// reads them from is recorded in `_index/refresh.json` INSIDE the graph — data
// this server did not choose. Starting the server has to bound that to --root,
// or a hand-edited recipe turns a graph reader into a file reader.
test("the source reader is bounded to --root when the server starts", () => {
  const { dir, graph } = wsGraph();
  const outside = mkdtempSync(join(tmpdir(), "geml-mcp-src-"));
  mkdirSync(join(outside, "src"), { recursive: true });
  writeFileSync(join(outside, "src", "login.ts"), "SECRET SOURCE\n");
  writeFileSync(join(graph, "_index", "refresh.json"), JSON.stringify({ root: outside }));
  configure({ root: dir, graph });

  const out = call("geml_codemap_node", { doc: "auth.geml", id: "login", source: true });
  assert.ok(!out.text.includes("SECRET SOURCE"), "a recipe cannot redirect the reader out of --root");
  assert.match(out.text, /outside this server's --root/);
  rmSync(outside, { recursive: true, force: true });
});


test("geml_get view returns {from, content}; without view it is still a string", () => {
  const dir = ws('=== embed {#e src="part.geml#tip"}\n===\n', "host.geml");
  writeFileSync(join(dir, "part.geml"), "=== note {#tip}\nBorrowed.\n===\n");
  const v = call("geml_get", { file: "host.geml", id: "#e", view: true }).json;
  assert.equal(v.from, "part.geml#tip", "provenance must survive the hop — there is no stderr here");
  assert.equal(v.content, "=== note {#tip}\nBorrowed.\n===\n");
  const plain = call("geml_get", { file: "host.geml", id: "#e" }).text;
  assert.equal(plain, '=== embed {#e src="part.geml#tip"}\n===\n', "back-compat: a plain string");
});

test("geml_get part=body pairs with view, and a bad part is refused", () => {
  const dir = ws('=== embed {#e src="part.geml#tip"}\n===\n', "host.geml");
  writeFileSync(join(dir, "part.geml"), "=== note {#tip}\nBorrowed.\n===\n");
  const v = call("geml_get", { file: "host.geml", id: "#e", view: true, part: "body" }).json;
  assert.equal(v.content, "Borrowed.\n", "no fences — that is what part is for");
  // `part` on its own (no view) narrows the frame itself.
  assert.equal(call("geml_get", { file: "host.geml", id: "#e", part: "head" }).text,
    '=== embed {#e src="part.geml#tip"}\n');
  const bad = call("geml_get", { file: "host.geml", id: "#e", part: "middle" });
  assert.match(bad.text, /part must be whole\|head\|body/);
});

test("the view provenance line has the format the MCP layer parses", () => {
  // If the CLI's format drifts, geml_get's `from` silently becomes null, so pin
  // the shape here where both sides are visible. `-> \S+` and not `-> \S+#\S+`:
  // a fragment-less whole-document target has no `#`.
  const dir = ws('=== embed {#e src="part.geml#tip"}\n===\n', "host.geml");
  writeFileSync(join(dir, "part.geml"), "=== note {#tip}\nBorrowed.\n===\n");
  const r = spawnSync(process.execPath, [CLI, "get", "host.geml", "#e", "--view"],
    { cwd: dir, encoding: "utf8" });
  assert.match(r.stderr, /^view: \S+ -> \S+$/m, `format drifted: ${JSON.stringify(r.stderr)}`);
  assert.equal(call("geml_get", { file: "host.geml", id: "#e", view: true }).json.from, "part.geml#tip");
});

test("the server root is handed to the CLI, so a document that links out of its own directory stays editable", () => {
  // The shape: a document in a subdirectory linking to a sibling higher up. That
  // link resolves from the SERVER ROOT and from nowhere else, and a write is
  // refused when the result would not parse — so before the root was forwarded,
  // `geml_set` could not edit such a document at all, not even by writing a
  // block back unchanged. The server knew the root the whole time.
  const dir = ws();
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sibling.md"), "# Sibling\n");
  const rel = "sub/linked.geml";
  writeFileSync(join(dir, rel),
    '=== meta\ntitle = "T"\n===\n\n# H {#h}\n\nSee [sibling](../sibling.md).\n\n=== note {#n}\nbody\n===\n');

  const got = call("geml_get", { file: rel, id: "#n" });
  assert.equal(got.isError, undefined ?? false, `get: ${got.text}`);

  const set = call("geml_set", { file: rel, id: "#n", body: "=== note {#n}\nrewritten\n===\n" });
  assert.notEqual(set.isError, true, `set must not read its own unresolved link as breakage: ${set.text}`);
  assert.match(readFileSync(join(dir, rel), "utf8"), /rewritten/, "the block was written");

  // …and the link is still there to be resolved, so this was never about
  // loosening the check — only about giving it the root it already had.
  assert.match(readFileSync(join(dir, rel), "utf8"), /\.\.\/sibling\.md/);
});

test("the forwarded root is CANONICAL, so a root reached through a symlink still resolves", () => {
  // `resolveInRoot` canonicalizes every `file`, so handing the root over raw
  // mixes two spellings of one directory: the CLI's lexical gate compares the
  // reference's absolute path against the root with `relative()`, and a
  // symlinked root is lexically outside a canonical target — every
  // cross-document reference in the workspace then resolves to nothing.
  //
  // This is the DEFAULT on macOS, where `os.tmpdir()` is a symlink
  // (`/var/folders/…` -> `/private/var/folders/…`), so the suite passed on
  // Windows and CI went red. The symlink here is explicit, so the case
  // reproduces on every platform instead of only the ones with a symlinked
  // temp directory.
  const real = mkdtempSync(join(realpathSync(tmpdir()), "geml-mcp-real-"));
  const link = join(mkdtempSync(join(realpathSync(tmpdir()), "geml-mcp-link-")), "root");
  try {
    symlinkSync(real, link, "junction");
  } catch {
    return; // no symlink privilege (plain Windows without developer mode): nothing to assert
  }
  writeFileSync(join(real, "other.geml"), "=== note {#target}\nover here\n===\n");
  writeFileSync(join(real, "d.geml"), '=== meta\ntitle = "T"\n===\n\n=== note {#gamma}\nbody\n===\n');

  // The server is configured with the SYMLINK path, the way a client's config
  // would hand it over.
  configure({ root: link, history: true });
  const r = call("geml_set", { file: "d.geml", id: "gamma", part: "body", body: "see [t](other.geml#target)" });
  assert.equal(r.json?.ok, true, `a sibling in the same workspace must resolve: ${r.text}`);

});

console.log(`${passed} test(s) passed.`);
