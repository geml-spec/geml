// Format readers (spec §3.2 "Engines supplied for a run", §8.2(10), §9.1): a
// `data` block's `src=` file in a format no built-in engine reads is handed to
// a reader the INVOKER supplies — ParseOptions.readers, the CLI's `--reader`,
// an MCP server's own `--reader` — never one the document names. A coordinate
// edit into such a file rewrites the file: only a value already there, read
// back through the same reader, refused unless it reads back as exactly the
// text written.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, readerProblems, sourceFormat } from "../dist/geml.js";
import { set, add, del, VerbError } from "../dist/verbs.js";
import { configure, handleLine } from "../dist/mcp.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "..", "dist", "geml.js");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const errs = (doc) => doc.diagnostics.filter((d) => d.severity === "error");
const warns = (doc) => doc.diagnostics.filter((d) => d.severity === "warning");

// A small format to read: `key = value` lines, a value being a number or a
// "string". `lenient` skips anything after a value — the defect §3.2 names —
// so the read-back check can be shown to hold without the reader's help.
function kvReader({ format = "kv", extensions = [".kv"], lenient = false, check } = {}) {
  return {
    format,
    extensions,
    read(text) {
      const value = {};
      const extents = [];
      let at = 0;
      for (const line of text.split("\n")) {
        const m = /^([a-z_]+) = ("[^"]*"|-?\d+(?:\.\d+)?)(.*)$/.exec(line.replace(/\r$/, ""));
        if (line.trim() !== "") {
          if (!m) throw new Error(`not a \`key = value\` line: ${JSON.stringify(line)}`);
          if (m[3].trim() !== "" && !lenient) throw new Error(`trailing text after a value: ${JSON.stringify(m[3])}`);
          const start = at + m[1].length + 3;
          value[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : Number(m[2]);
          extents.push({ at: [m[1]], start, end: start + m[2].length });
        }
        at += line.length + 1;
      }
      return { value, extents, diagnostics: check ? check(value) : [] };
    },
  };
}

// An in-memory host: what `resolveDoc`, `sourcePath` and `readers` would be.
function memCtx(files, readers) {
  return {
    docOpts: () => ({
      resolveDoc: (p) => (p in files ? files[p] : null),
      docExists: (p) => p in files,
      sourcePath: (p) => (p in files ? `/mem/${p}` : null),
      ...(readers ? { readers } : {}),
    }),
    note: () => {},
  };
}
const raw = (text) => ({ kind: "raw", text });
const refusal = (fn) => {
  try { fn(); } catch (e) { if (e instanceof VerbError) return e; throw e; }
  assert.fail("expected a refusal");
};

test("readerProblems: names and extensions are claimed once, never a registry's", () => {
  assert.deepEqual(readerProblems([kvReader()]), []);
  const bad = readerProblems([
    kvReader({ format: "json" }),
    kvReader({ format: "a", extensions: [".x"] }),
    kvReader({ format: "a", extensions: [".y"] }),
    kvReader({ format: "b", extensions: [".X"] }),
    kvReader({ format: "c", extensions: [".yaml", "tscn"] }),
    { format: "d", extensions: [".d"] },
  ]);
  for (const want of [/registry defines/, /two readers claim the format `a`/, /both claim `\.x`/, /`\.yaml`, which a built-in format reads/, /`tscn`, which is not an extension/, /needs a `format` name/]) {
    assert.ok(bad.some((p) => want.test(p)), `${want} in ${JSON.stringify(bad)}`);
  }
});

test("sourceFormat: an extension nothing claims is null; format= wins only among claimed files", () => {
  const readers = [kvReader()];
  assert.equal(sourceFormat("cfg.env", undefined, readers), null);
  assert.equal(sourceFormat("cfg.env", "json", readers), null, "format= does not open a file nothing claims");
  assert.equal(sourceFormat("a.kv", undefined, readers).fmt, "kv");
  assert.equal(sourceFormat("a.kv", undefined, readers).reader.format, "kv");
  assert.equal(sourceFormat("a.KV", undefined, readers).fmt, "kv", "extensions compare case-insensitively");
  assert.equal(sourceFormat("a.kv", "json", readers).fmt, "json");
  assert.equal(sourceFormat("a.jsonl", undefined, readers).fmt, "jsonl");
  assert.equal(sourceFormat("a.kv", undefined, undefined), null, "no reader handed to the run");
});

test("a reader handed to the run reads a src= file; coordinates into it resolve and are checked", () => {
  const resolveDoc = (p) => (p === "game.kv" ? 'speed = 0.5\nname = "Dodge"\n' : null);
  const ok = parse('=== data {#g src=game.kv}\n===\n\nEvery [[#g["speed"]]] seconds.\n', { resolveDoc, readers: [kvReader()] });
  assert.deepEqual(ok.diagnostics, []);
  assert.deepEqual(ok.children[0].value, { speed: 0.5, name: "Dodge" });
  const typo = parse('=== data {#g src=game.kv}\n===\n\nEvery [[#g["sped"]]] seconds.\n', { resolveDoc, readers: [kvReader()] });
  assert.ok(errs(typo).some((d) => d.code === "unresolved-reference" && /sped/.test(d.message)), "a coordinate the file does not hold is still an error");
});

test("a reader is handed the file's real path, not the document-relative route", () => {
  const seen = [];
  const spy = { format: "spy", extensions: [".spy"], read: (_t, ctx) => { seen.push(ctx.path); return { value: {}, extents: [] }; } };
  parse("=== data {#s src=sub/x.spy}\n===\n", { resolveDoc: () => "", sourcePath: (p) => `/abs/root/${p}`, readers: [spy] });
  assert.deepEqual(seen, ["/abs/root/sub/x.spy"]);
  parse("=== data {#s src=sub/x.spy}\n===\n", { resolveDoc: () => "", readers: [spy] });
  assert.deepEqual(seen, ["/abs/root/sub/x.spy", "sub/x.spy"], "without sourcePath, the route as written");
});

test("without the reader the block has no value tree, and what addresses it defers", () => {
  const resolveDoc = () => { throw new Error("must not be opened"); };
  const doc = parse('=== data {#g src=game.kv}\n===\n\nEvery [[#g["anything"]]] seconds.\n', { resolveDoc });
  assert.equal(errs(doc).length, 0);
  const w = warns(doc);
  assert.equal(w.length, 1);
  assert.equal(w[0].code, "data-format-no-engine");
  assert.match(w[0].message, /no reader in this run claims `\.kv`/);
  // the same for a reserved format with no engine, written inline
  const toml = parse('=== data {#t format=toml}\na = 1\n===\n\nSee [[#t["a"]]] and ![[#t["a"]]].\n');
  assert.equal(errs(toml).length, 0, "a coordinate into a raw toml body defers rather than failing");
});

test("a reader's own diagnostics carry its format name; a rejected file is data-parse", () => {
  const check = (v) => (v.speed > 1 ? [{ code: "too-fast", at: ["speed"], message: "faster than a player can dodge" }, { code: "advice", at: [], message: "slow down", severity: "warning" }] : []);
  const doc = parse("=== data {#g src=game.kv}\n===\n", { resolveDoc: () => "speed = 3\n", readers: [kvReader({ check })] });
  assert.deepEqual(doc.diagnostics.map((d) => `${d.code}:${d.severity}`), ["kv/too-fast:error", "kv/advice:warning"]);
  assert.match(doc.diagnostics[0].message, /\["speed"\]: faster than a player can dodge/);
  const rejected = parse("=== data {#g src=game.kv}\n===\n", { resolveDoc: () => "speed: 3\n", readers: [kvReader()] });
  assert.deepEqual(rejected.diagnostics.map((d) => d.code), ["data-parse"]);
  assert.match(rejected.diagnostics[0].message, /not `kv` its reader reads/);
  const nan = { format: "nan", extensions: [".nan"], read: () => ({ value: { x: NaN }, extents: [] }) };
  const outside = parse("=== data {#g src=x.nan}\n===\n", { resolveDoc: () => "x", readers: [nan] });
  assert.deepEqual(outside.diagnostics.map((d) => d.code), ["data-parse"], "the value domain's limits hold for a reader too");
});

test("format= naming a reader reads an inline body as well", () => {
  const doc = parse('=== data {#g format=kv}\nspeed = 2\n===\n', { readers: [kvReader()] });
  assert.deepEqual(doc.diagnostics, []);
  assert.deepEqual(doc.children[0].value, { speed: 2 });
});

test("set through a coordinate rewrites the src= file — one value, nothing else", () => {
  const doc = '=== data {#g src=game.kv}\n===\n';
  const files = { "game.kv": 'speed = 0.5\nname = "Dodge"\n' };
  const r = set(doc, "d.geml", '#g["speed"]', { part: "whole", named: [], content: raw("0.3") }, memCtx(files, [kvReader()]));
  assert.equal(r.text, doc, "the document is unchanged");
  assert.deepEqual(r.external, { path: "/mem/game.kv", before: files["game.kv"], text: 'speed = 0.3\nname = "Dodge"\n' });
  const crlf = { "game.kv": 'speed = 0.5\r\nname = "Dodge"\r\n' };
  const rc = set(doc, "d.geml", '#g["name"]', { part: "whole", named: [], content: raw('"Creeps"') }, memCtx(crlf, [kvReader()]));
  assert.equal(rc.external.text, 'speed = 0.5\r\nname = "Creeps"\r\n', "the file keeps its own line endings");
});

test("set into a src= file is refused unless the value reads back as exactly the text written", () => {
  const doc = '=== data {#g src=game.kv}\n===\n';
  const files = { "game.kv": "speed = 0.5\nlives = 3\n" };
  const strict = refusal(() => set(doc, "d.geml", '#g["speed"]', { part: "whole", named: [], content: raw("0.3]") }, memCtx(files, [kvReader()])));
  assert.equal(strict.reason, "broken-result");
  assert.match(strict.message, /no longer reads as `kv`/);
  // a lenient reader reads `0.3]` as `0.3`: the read-back check still refuses
  const lenient = refusal(() => set(doc, "d.geml", '#g["speed"]', { part: "whole", named: [], content: raw("0.3]") }, memCtx(files, [kvReader({ lenient: true })])));
  assert.equal(lenient.reason, "broken-result");
  assert.match(lenient.message, /does not read back as one value/);
});

test("a src= file takes no insertion or removal, and nothing without its reader", () => {
  const doc = '=== data {#g src=game.kv}\n===\n';
  const files = { "game.kv": "speed = 0.5\n" };
  const ctx = memCtx(files, [kvReader()]);
  assert.equal(refusal(() => set(doc, "d.geml", '#g["lives"]', { part: "whole", named: [], content: raw("3") }, ctx)).reason, "bad-address", "a key the file lacks would be an insertion");
  const inserted = refusal(() => add(doc, "d.geml", { content: raw("1"), append: false, after: '#g["speed"]' }, ctx));
  assert.equal(inserted.reason, "bad-address");
  assert.match(inserted.message, /only takes a replacement/);
  const removed = refusal(() => del(doc, "d.geml", ['#g["speed"]'], ctx));
  assert.equal(removed.reason, "bad-address");
  assert.match(removed.message, /only takes a replacement/);
  const none = refusal(() => set(doc, "d.geml", '#g["speed"]', { part: "whole", named: [], content: raw("0.3") }, memCtx(files)));
  assert.equal(none.reason, "bad-address");
  assert.match(none.message, /no reader in this run claims `game\.kv`/);
});

test("a built-in json src= file is rewritten by the same splice an inline body takes", () => {
  const doc = '=== data {#c src=cfg.json}\n===\n';
  const files = { "cfg.json": '{\n  "port": 8140,\n  "name": "geml"\n}\n' };
  const r = set(doc, "d.geml", '#c["port"]', { part: "whole", named: [], content: raw("8141") }, memCtx(files));
  assert.equal(r.external.text, '{\n  "port": 8141,\n  "name": "geml"\n}\n');
  const yaml = { "cfg.yaml": "port: 8140\n" };
  assert.equal(refusal(() => set('=== data {#c src=cfg.yaml}\n===\n', "d.geml", '#c["port"]', { part: "whole", named: [], content: raw("1") }, memCtx(yaml))).reason, "bad-address", "yaml is read, not written");
});

test("the CLI takes --reader: check, get, set into the file, and -o - as a dry run", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-readers-"));
  try {
    writeFileSync(join(dir, "kv-reader.mjs"), `export default { readers: [(${kvReader.toString()})()] };\n`);
    writeFileSync(join(dir, "game.kv"), "speed = 0.5\n");
    writeFileSync(join(dir, "d.geml"), '=== data {#g src=game.kv}\n===\n\nEvery ![[#g["speed"]]] seconds.\n');
    const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: dir, encoding: "utf8", input: a.includes("--in") ? "0.3" : undefined, timeout: 60000 });
    const bare = run("check", "d.geml");
    assert.equal(bare.status, 0, bare.stderr);
    assert.match(bare.stdout + bare.stderr, /data-format-no-engine|no reader in this run claims/);
    const checked = run("check", "d.geml", "--reader", "kv-reader.mjs");
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout + checked.stderr, /ok: no diagnostics/);
    const got = run("get", "d.geml", '#g["speed"]', "--reader", "kv-reader.mjs");
    assert.equal(got.stdout.trim(), "0.5");
    const dry = run("set", "d.geml", '#g["speed"]', "--in", "-", "-o", "-", "--reader", "kv-reader.mjs");
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(dry.stdout, "speed = 0.3\n");
    assert.equal(readFileSync(join(dir, "game.kv"), "utf8"), "speed = 0.5\n", "-o - writes nothing");
    const wrote = run("set", "d.geml", '#g["speed"]', "--in", "-", "--reader", "kv-reader.mjs");
    assert.equal(wrote.status, 0, wrote.stderr);
    assert.equal(readFileSync(join(dir, "game.kv"), "utf8"), "speed = 0.3\n");
    assert.match(readFileSync(join(dir, "d.geml"), "utf8"), /=== data \{#g src=game\.kv\}/, "the document is untouched");
    const missing = run("check", "d.geml", "--reader", "nope.mjs");
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--reader nope\.mjs: cannot load it/);
    const eq = run("check", "d.geml", "--reader=kv-reader.mjs");
    assert.equal(eq.status, 2);
    assert.match(eq.stderr, /--reader takes its module as the next argument/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the MCP server writes a src= file only through a reader it was started with", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-readers-mcp-"));
  const call = (name, args) => {
    const out = [];
    handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), (s) => out.push(s));
    return JSON.parse(JSON.parse(out[0]).result.content[0].text);
  };
  try {
    writeFileSync(join(dir, "game.kv"), "speed = 0.5\n");
    writeFileSync(join(dir, "cfg.json"), '{"port": 8140}\n');
    writeFileSync(join(dir, "d.geml"), '=== data {#g src=game.kv}\n===\n\n=== data {#c src=cfg.json}\n===\n');
    configure({ root: dir, history: false, readers: [kvReader()] });
    const w = call("geml_set", { file: "d.geml", id: '#g["speed"]', body: "0.3" });
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.equal(readFileSync(join(dir, "game.kv"), "utf8"), "speed = 0.3\n");
    const json = call("geml_set", { file: "d.geml", id: '#c["port"]', body: "1" });
    assert.equal(json.ok, false, "a built-in json file is not written over MCP — it could as well be package.json");
    assert.equal(json.reason, "bad-address");
    assert.equal(readFileSync(join(dir, "cfg.json"), "utf8"), '{"port": 8140}\n');
    configure({ readers: undefined });
    const without = call("geml_set", { file: "d.geml", id: '#g["speed"]', body: "0.1" });
    assert.equal(without.ok, false);
    assert.equal(readFileSync(join(dir, "game.kv"), "utf8"), "speed = 0.3\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A spy that reads `kv` and records the path it was handed.
function pathSpy(seen) {
  const kv = kvReader();
  return { ...kv, read(text, ctx) { seen.push(ctx?.path); return kv.read(text); } };
}

test("a coordinate into ANOTHER document's reader-backed `src=` is checked with the run's readers", () => {
  // The check scanned the borrowed document with no readers and no resolver, so
  // a coordinate into it was never checked: a key that is not there passed,
  // while rendering the same projection printed the value. Its `src=` means its
  // own directory, so the decoy beside this document must not answer.
  const seen = [];
  const files = { "sub/b.geml": "=== data {#g src=game.kv}\n===\n", "sub/game.kv": "speed = 0.5\n", "game.kv": "jump = 1\n" };
  const opts = { resolveDoc: (p) => files[p] ?? null, sourcePath: (p) => `/abs/root/${p}`, readers: [pathSpy(seen)] };
  assert.deepEqual(parse('see [[sub/b.geml#g["speed"]]]\n', opts).diagnostics, []);
  assert.deepEqual(seen, ["/abs/root/sub/game.kv"], "the reader is handed the borrowed document's file");
  assert.deepEqual(errs(parse('see [[sub/b.geml#g["jump"]]]\n', opts)).map((d) => d.code), ["unresolved-reference"]);
  // With no reader, the block has no value tree in this run and the coordinate
  // defers (§3.2), as it does inside its own document.
  assert.deepEqual(errs(parse('see [[sub/b.geml#g["jump"]]]\n', { resolveDoc: opts.resolveDoc })), []);
});

test("a view over another document hands that document's readers its own files", () => {
  // The borrowed document is parsed with its `src=` rebased onto its directory;
  // the path a reader is handed has to be rebased the same way.
  const seen = [];
  const files = {
    "sub/b.geml": "=== data {#g src=game.kv}\n===\n\n=== table {#t}\n| A |\n|---|\n| 1 |\n===\n",
    "sub/game.kv": "speed = 0.5\n",
  };
  const opts = { resolveDoc: (p) => files[p] ?? null, sourcePath: (p) => `/abs/root/${p}`, readers: [pathSpy(seen)] };
  assert.deepEqual(errs(parse("=== view {#v src=sub/b.geml#t}\n===\n", opts)), []);
  assert.deepEqual(seen, ["/abs/root/sub/game.kv"]);
});

console.log(`readers: ${passed} passed`);
