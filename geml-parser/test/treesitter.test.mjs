// geml-code-graph tree-sitter fallback (Zig first): profile → export → adapter.
//
// Three layers under test, each on its own:
//   * adapters/treesitter.mjs  — pure resolution over hand-written JSONL (no wasm)
//   * detect.mjs / build.mjs   — Zig detection, the npx indexer step, the recipe
//   * treesitter-export.mjs    — the REAL grammar (web-tree-sitter + the wasm
//     bundle are devDependencies) over test/fixtures/zig-app/, then the adapter
//     on top: the end-to-end pins for the three name-resolution layers.
import { extract as tsExtract } from "../codemap/adapters/treesitter.mjs";
import { detectLanguages, indexerCommand, isSourcePath, TREESITTER_NPX_PKGS } from "../codemap/detect.mjs";
import { runExport } from "../codemap/treesitter-export.mjs";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // geml-parser/
const tmp = () => mkdtempSync(join(tmpdir(), "geml-ts-"));
const fixture = (fileMap) => {
  const dir = tmp();
  for (const [rel, content] of Object.entries(fileMap)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content ?? "");
  }
  return dir;
};
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

// The export is async (wasm init), so this suite runs its tests in sequence
// and reports like the others: "ok <name>" per test, exit 1 on the first failure.
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- adapter: resolution over hand-written JSONL -----------------------------

// A raw dir as treesitter-export.mjs writes it: meta.json + three JSONL tables.
const rawDir = ({ lang = "zig", defs = [], bindings = [], calls = [], parseErrors = 0, files = 1 } = {}) => {
  const dir = tmp();
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ lang, files, parseErrors }));
  writeFileSync(join(dir, "defs.jsonl"), jsonl(defs));
  writeFileSync(join(dir, "bindings.jsonl"), jsonl(bindings));
  writeFileSync(join(dir, "calls.jsonl"), jsonl(calls));
  return dir;
};
const def = (file, name, container = [], line = 1, pub = true) => ({ file, name, container, pub, lineStart: line, lineEnd: line + 2 });
const call = (file, line, caller, callee) => ({ file, line, caller, callee });
const names = (r) => new Map(r.symbols.map((s) => [s.anchor, s.name]));
const edgeKeys = (r) => {
  const nm = names(r);
  return r.edges.map((e) => `${nm.get(e.from)}->${e.to ? nm.get(e.to) : "«" + e.to_text + "»"}:${e.confidence}`);
};

test("treesitter adapter: symbols — anchors, owner-qualified names, File nodes, heuristic resolution, ~n for duplicates", () => {
  const raw = rawDir({
    defs: [
      def("src/a.zig", "run", [], 1),
      def("src/a.zig", "init", ["Client"], 5),
      def("src/a.zig", "go", ["main", "inner"], 9),
      // two anonymous-container fns that collapse to the same qualified name:
      def("src/a.zig", "init", ["Client"], 20),
    ],
  });
  const r = tsExtract({ raw, root: "/repo" });
  const fns = r.symbols.filter((s) => s.kind === "Function");
  assert.deepEqual(fns.map((s) => s.anchor), [
    "zig:src/a.zig#run", "zig:src/a.zig#Client.init", "zig:src/a.zig#main.inner.go", "zig:src/a.zig#Client.init~2",
  ], "anchor = <lang>:<file>#<container path>.<name>, duplicates ~2 by line order");
  assert.deepEqual(fns.map((s) => s.name), ["run", "Client.init", "inner.go", "Client.init"], "display name = immediate owner + name");
  assert.ok(fns.every((s) => s.lang === "zig" && s.resolution === "heuristic"), "lang from meta, resolution heuristic");
  assert.equal(fns[1].line_start, 5); assert.equal(fns[1].line_end, 7);
  const files = r.symbols.filter((s) => s.kind === "File");
  assert.deepEqual(files.map((s) => s.anchor), ["zig:src/a.zig"], "one File node per source file");
  assert.equal(files[0].name, "a.zig");
  rmSync(raw, { recursive: true, force: true });
});

test("treesitter adapter: layer ① — bare call resolves in the same file, innermost scope first; recursion is not an edge", () => {
  const raw = rawDir({
    defs: [
      def("src/a.zig", "helper", [], 1),
      def("src/a.zig", "helper", ["S"], 10),   // shadows the file-level helper inside S
      def("src/a.zig", "work", ["S"], 14),
      def("src/a.zig", "main", [], 20),
    ],
    calls: [
      call("src/a.zig", 15, { name: "work", container: ["S"] }, ["helper"]),  // inside S → S.helper
      call("src/a.zig", 21, { name: "main", container: [] }, ["helper"]),     // file scope → helper
      call("src/a.zig", 22, { name: "main", container: [] }, ["main"]),       // self-recursion: skipped
      call("src/a.zig", 23, { name: "main", container: [] }, ["nowhere"]),    // unknown → to_text
    ],
  });
  const r = tsExtract({ raw, root: "/repo" });
  assert.deepEqual(edgeKeys(r), [
    "S.work->S.helper:medium",
    "main->helper:medium",
    "main->«nowhere»:low",
  ]);
  assert.ok(r.edges.every((e) => e.resolution === "heuristic" && e.kind === "calls"));
  assert.deepEqual(r.edges[0].site, { file: "src/a.zig", line: 15 }, "call site recorded");
  rmSync(raw, { recursive: true, force: true });
});

test("treesitter adapter: layer ② — import, alias, struct namespace and self bindings resolve across files (re-export hop included)", () => {
  const raw = rawDir({
    files: 3,
    defs: [
      def("src/main.zig", "main", [], 5),
      def("src/net.zig", "init", ["Client"], 8),
      def("src/net.zig", "connect", ["Client"], 12),
      def("src/net.zig", "reset", ["Client"], 18),
      def("src/net.zig", "log", ["Client"], 22),
      def("src/net.zig", "ping", [], 30),
      def("src/util.zig", "send", ["Util"], 2),
      def("src/util.zig", "trace", [], 5),
    ],
    bindings: [
      { file: "src/main.zig", name: "std", kind: "import", target: null, scope: [], line: 1 },
      { file: "src/main.zig", name: "net", kind: "import", target: "src/net.zig", scope: [], line: 2 },
      { file: "src/main.zig", name: "Conn", kind: "alias", target: "src/net.zig", path: ["Client"], scope: [], line: 3 },
      { file: "src/net.zig", name: "util", kind: "import", target: "src/util.zig", scope: [], line: 1 },
      { file: "src/net.zig", name: "Reexported", kind: "alias", target: "src/util.zig", path: ["Util"], scope: [], line: 2 },
      { file: "src/net.zig", name: "Client", kind: "struct", scope: [], line: 4 },
      { file: "src/net.zig", name: "Self", kind: "self", scope: ["Client"], line: 5 },
    ],
    calls: [
      call("src/main.zig", 6, { name: "main", container: [] }, ["Conn", "init"]),                 // alias → net.zig Client.init
      call("src/main.zig", 7, { name: "main", container: [] }, ["net", "Client", "connect"]),     // import → nested container
      call("src/main.zig", 9, { name: "main", container: [] }, ["std", "debug", "print"]),        // external import → to_text
      call("src/main.zig", 10, { name: "main", container: [] }, ["net", "ping"]),                 // import → file-level fn
      call("src/main.zig", 11, { name: "main", container: [] }, ["net", "Reexported", "send"]),   // import → alias in that file → util.zig
      call("src/net.zig", 13, { name: "connect", container: ["Client"] }, ["self", "reset"]),     // self → current container
      call("src/net.zig", 14, { name: "connect", container: ["Client"] }, ["Self", "log"]),       // @This() binding → current container
      call("src/net.zig", 23, { name: "log", container: ["Client"] }, ["util", "trace"]),         // import from inside a container
      call("src/net.zig", 31, { name: "ping", container: [] }, ["Client", "init"]),               // struct namespace in the same file
      call("src/net.zig", 32, { name: "ping", container: [] }, ["Client", "missing"]),            // struct known, member not → to_text
    ],
  });
  const r = tsExtract({ raw, root: "/repo" });
  assert.deepEqual(edgeKeys(r), [
    "main->Client.init:medium",
    "main->Client.connect:medium",
    "main->«std.debug.print»:low",
    "main->ping:medium",
    "main->Util.send:medium",
    "Client.connect->Client.reset:medium",
    "Client.connect->Client.log:medium",
    "Client.log->trace:medium",
    "ping->Client.init:medium",
    "ping->«Client.missing»:low",
  ]);
  rmSync(raw, { recursive: true, force: true });
});

test("treesitter adapter: layer ③ — an unbound head falls back to a repo-wide name match: unique → low `to`, several → candidates, none → to_text", () => {
  const raw = rawDir({
    files: 2,
    defs: [
      def("src/a.zig", "main", [], 1),
      def("src/a.zig", "connect", ["Client"], 10),
      def("src/a.zig", "send", ["Client"], 14),
      def("src/b.zig", "send", ["Util"], 2),
    ],
    calls: [
      call("src/a.zig", 2, { name: "main", container: [] }, ["c", "connect"]),        // unique name → to (low)
      call("src/a.zig", 3, { name: "main", container: [] }, ["c", "send"]),           // two `send`s → candidates, no `to`
      call("src/a.zig", 4, { name: "main", container: [] }, ["c", "frobnicate"]),     // nobody → to_text
      call("src/a.zig", 5, { name: "main", container: [] }, ["<expr>", "connect"]),   // `foo().connect()`: head unknowable → same fallback
    ],
  });
  const r = tsExtract({ raw, root: "/repo" });
  const nm = names(r);
  const [e1, e2, e3, e4] = r.edges;
  assert.equal(nm.get(e1.to), "Client.connect"); assert.equal(e1.confidence, "low");
  assert.match(e1.note, /name match only/, "a low `to` says why it is low");
  assert.equal(e2.to, undefined, "ambiguous: no primary target");
  assert.deepEqual(e2.candidates.map((c) => nm.get(c)).sort(), ["Client.send", "Util.send"]);
  assert.equal(e2.confidence, "low");
  assert.equal(e3.to_text, "c.frobnicate"); assert.equal(e3.confidence, "low");
  assert.equal(nm.get(e4.to), "Client.connect");
  rmSync(raw, { recursive: true, force: true });
});

test("treesitter adapter: calls with no caller (test blocks, file scope) or an unknown caller are dropped; parse errors are reported, not fatal", () => {
  const raw = rawDir({
    parseErrors: 1,
    defs: [def("src/a.zig", "f", [], 1)],
    calls: [
      call("src/a.zig", 2, null, ["f"]),
      call("src/a.zig", 3, { name: "ghost", container: [] }, ["f"]),
    ],
  });
  const errs = [];
  const orig = console.error; console.error = (m) => errs.push(String(m));
  let r;
  try { r = tsExtract({ raw, root: "/repo" }); } finally { console.error = orig; }
  assert.equal(r.edges.length, 0);
  assert.ok(errs.some((m) => /1 file\(s\) had syntax errors/.test(m)), `parse-error note on stderr, got: ${errs.join(" | ")}`);
  rmSync(raw, { recursive: true, force: true });
});

test("treesitter adapter: a caller's OWN scope is searched too — fn-body aliases and nested fns resolve (zig std `const p = std.debug.print; p(…)`)", () => {
  const raw = rawDir({
    defs: [
      def("src/a.zig", "dump", ["Custom"], 10),
      def("src/a.zig", "inner", ["Custom", "dump"], 12),   // a fn declared inside dump's body
      def("src/a.zig", "main", [], 30),
    ],
    bindings: [
      { file: "src/a.zig", name: "std", kind: "import", target: null, scope: [], line: 1 },
      { file: "src/a.zig", name: "p", kind: "alias", path: ["std", "debug", "print"], scope: ["Custom", "dump"], line: 11 },
    ],
    calls: [
      call("src/a.zig", 14, { name: "dump", container: ["Custom"] }, ["p"]),        // body-local alias → external → to_text names the TARGET
      call("src/a.zig", 15, { name: "dump", container: ["Custom"] }, ["inner"]),    // nested fn → medium
      call("src/a.zig", 31, { name: "main", container: [] }, ["p"]),                // not visible from main → nobody named p → to_text "p"
    ],
  });
  const r = tsExtract({ raw, root: "/repo" });
  assert.deepEqual(edgeKeys(r), [
    "Custom.dump->«std.debug.print»:low",
    "Custom.dump->dump.inner:medium",
    "main->«p»:low",
  ]);
  rmSync(raw, { recursive: true, force: true });
});

test("treesitter adapter: layer ③ caps the candidate list — past MAX_CANDIDATES same-named defs the edge is to_text, never a 133-row backlink flood", () => {
  const defs = [def("src/a.zig", "main", [], 1)];
  for (let i = 0; i < 9; i++) defs.push(def(`src/f${i}.zig`, "deinit", [`T${i}`], 2));   // 9 same-named: over the cap
  for (let i = 0; i < 3; i++) defs.push(def(`src/g${i}.zig`, "reset", [`R${i}`], 2));    // 3: under it
  const raw = rawDir({
    files: 13, defs,
    calls: [
      call("src/a.zig", 2, { name: "main", container: [] }, ["x", "deinit"]),
      call("src/a.zig", 3, { name: "main", container: [] }, ["x", "reset"]),
    ],
  });
  const r = tsExtract({ raw, root: "/repo" });
  const [over, under] = r.edges;
  assert.equal(over.to_text, "x.deinit"); assert.equal(over.candidates, undefined);
  assert.match(over.note, /9 same-named/, "the count survives as a note so the reader knows it was ambiguity, not absence");
  assert.equal(under.candidates.length, 3); assert.equal(under.to, undefined);
  rmSync(raw, { recursive: true, force: true });
});

// ---- detect + indexer command ------------------------------------------------

test("detect: build.zig -> a single treesitter (Zig) job; .zig files alone also qualify", () => {
  const fx = fixture({ "build.zig": "", "src/main.zig": "pub fn main() void {}\n" });
  const jobs = detectLanguages(fx);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].indexer, "treesitter");
  assert.equal(jobs[0].adapter, "treesitter");
  assert.equal(jobs[0].language, "Zig");
  assert.equal(jobs[0].tsLang, "zig");
  assert.equal(jobs[0].gemlLang, undefined, "no Joern frontend");
  assert.equal(jobs[0].signal, "build.zig");
  rmSync(fx, { recursive: true, force: true });
  const fx2 = fixture({ "src/a.zig": "", "src/b.zig": "" });
  const jobs2 = detectLanguages(fx2);
  assert.equal(jobs2.length, 1); assert.equal(jobs2[0].signal, ".zig");
  rmSync(fx2, { recursive: true, force: true });
  assert.ok(isSourcePath("x/y.zig"), "refresh treats .zig as source");
});

test("detect: mixed tsconfig.json + build.zig -> scip first, then treesitter; a Gradle Java repo with a stray .zig stays a single Joern job", () => {
  const fx = fixture({ "tsconfig.json": "{}", "web/app.ts": "x", "build.zig": "", "src/main.zig": "" });
  const jobs = detectLanguages(fx);
  assert.deepEqual(jobs.map((j) => j.indexer), ["scip", "treesitter"]);
  rmSync(fx, { recursive: true, force: true });
  const files = { "build.gradle": "", "tools/gen.zig": "" };
  for (const c of "ABCDEFGHIJKLMNOPQRST") files[`src/main/java/${c}.java`] = `class ${c} {}`; // 20 .java : 1 .zig — under the 5% bar
  const gradle = fixture(files);
  const gj = detectLanguages(gradle);
  assert.deepEqual(gj.map((j) => `${j.indexer}:${j.gemlLang}`), ["joern:JAVASRC"], "one Java Joern job, unchanged by a <5% .zig presence");
  rmSync(gradle, { recursive: true, force: true });
});

test("indexerCommand: treesitter job -> pinned npx packages, export script, GEML_* env, raw dir under _build; excludes ride along", () => {
  const job = { language: "Zig", indexer: "treesitter", adapter: "treesitter", tsLang: "zig" };
  const cmd = indexerCommand(job, { root: "/r", buildDir: "/r/.geml-code-graph/_build", tsScript: "/x/treesitter-export.mjs" });
  assert.equal(cmd.adapter, "treesitter");
  assert.equal(basename(cmd.raw), "treesitter-zig");
  assert.equal(cmd.argv[0], "npx");
  assert.ok(cmd.argv.includes("-y"));
  for (const p of TREESITTER_NPX_PKGS) assert.ok(cmd.argv.includes(p), `pins ${p}`);
  assert.match(TREESITTER_NPX_PKGS.find((p) => p.startsWith("web-tree-sitter@")), /^web-tree-sitter@0\.25\./, "0.27 rejects the bundle's legacy dylink wasm; 0.25 loads both");
  assert.deepEqual(cmd.argv.slice(-2), ["node", "/x/treesitter-export.mjs"]);
  assert.equal(cmd.env.GEML_SRC, "/r");
  assert.equal(cmd.env.GEML_OUT, cmd.raw);
  assert.equal(cmd.env.GEML_LANG, "zig");
  assert.equal(cmd.env.GEML_EXCLUDE, undefined, "no excludes → no env key (stable fingerprint)");
  assert.equal(cmd.cwd, "/r");
  const cmd2 = indexerCommand(job, { root: "/r", buildDir: "/r/b", tsScript: "/x/t.mjs", excludeGlobs: ["vendor/**", "gen/*"], gitignore: false });
  assert.equal(cmd2.env.GEML_EXCLUDE, "vendor/**\ngen/*");
  assert.equal(cmd2.env.GEML_NO_GITIGNORE, "1");
});

// ---- export with the real grammar + adapter: the end-to-end pins ------------

test("treesitter export (real wasm): Zig fixture → defs/bindings/calls JSONL; test-block and file-scope calls carry no caller", async () => {
  const out = tmp();
  const fxRoot = join(PKG, "test", "fixtures", "zig-app");
  const r = await runExport({ src: fxRoot, out, lang: "zig", gitignore: false, log: () => {} });
  assert.equal(r.files, 3);
  assert.equal(r.parseErrors, 0, "the grammar parses the fixture cleanly");
  for (const f of ["meta.json", "defs.jsonl", "bindings.jsonl", "calls.jsonl"]) assert.ok(existsSync(join(out, f)), f);
  const rows = (f) => readFileSync(join(out, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const defs = rows("defs.jsonl");
  assert.deepEqual(
    defs.map((d) => `${d.file}:${[...d.container, d.name].join(".")}${d.pub ? "+" : "-"}`).sort(),
    [
      "src/main.zig:helper-", "src/main.zig:main+",
      "src/net.zig:Client.connect+", "src/net.zig:Client.init+", "src/net.zig:Client.log-", "src/net.zig:Client.reset-", "src/net.zig:Client.send+", "src/net.zig:ping+",
      "src/util.zig:Util.send+", "src/util.zig:trace+",
    ].sort(),
  );
  const connect = defs.find((d) => d.name === "connect");
  assert.deepEqual([connect.lineStart, connect.lineEnd], [12, 16], "fn span from the grammar, not one line");
  const bindings = rows("bindings.jsonl");
  const b = (file, name) => bindings.find((x) => x.file === file && x.name === name);
  assert.deepEqual(b("src/main.zig", "std"), { file: "src/main.zig", name: "std", kind: "import", target: null, scope: [], line: 1 }, "external package import");
  assert.deepEqual(b("src/main.zig", "net"), { file: "src/main.zig", name: "net", kind: "import", target: "src/net.zig", scope: [], line: 2 }, "relative file import resolved against the importing file");
  assert.deepEqual(b("src/main.zig", "Conn"), { file: "src/main.zig", name: "Conn", kind: "alias", target: "src/net.zig", path: ["Client"], scope: [], line: 3 });
  assert.deepEqual(b("src/net.zig", "Client"), { file: "src/net.zig", name: "Client", kind: "struct", scope: [], line: 4 });
  assert.deepEqual(b("src/net.zig", "Self"), { file: "src/net.zig", name: "Self", kind: "self", scope: ["Client"], line: 5 });
  assert.equal(b("src/main.zig", "client"), undefined, "value bindings are not namespaces");
  const calls = rows("calls.jsonl");
  assert.ok(!calls.some((c) => /^@(?!file:|pkg:)/.test(c.callee[0])), "builtins (@import, @This) are not call rows");
  assert.ok(calls.some((c) => c.callee[0] === "@file:src/util.zig" && c.callee[1] === "trace"), "an `@import(\"util.zig\").trace()` head is rewritten to the file it names");
  const inTest = calls.filter((c) => c.file === "src/util.zig");
  assert.equal(inTest.length, 0, "a call inside `test \"…\" {}` is dropped at export (decision A: no Test nodes)");
  const mainCalls = calls.filter((c) => c.caller?.name === "main").map((c) => c.callee.join("."));
  assert.deepEqual(mainCalls, ["Conn.init", "net.Client.connect", "c.send", "std.debug.print", "helper", "net.ping", "net.Reexported.send"]);
  const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
  assert.deepEqual(meta, { lang: "zig", files: 3, parseErrors: 0, defs: 10, bindings: bindings.length, calls: calls.length });

  // adapter on top: the fixture's pinned relations (the smoke-test gate)
  const g = tsExtract({ raw: out, root: fxRoot });
  const keys = new Set(edgeKeys(g));
  for (const k of [
    "main->Client.init:medium",          // alias `Conn = @import("net.zig").Client`
    "main->Client.connect:medium",       // import → nested container member
    "main->«std.debug.print»:low",       // external package
    "main->helper:medium",               // same file
    "main->ping:medium",                 // import → file-level fn
    "main->Util.send:medium",            // import → re-export alias → third file
    "Client.connect->Client.reset:medium", // self.
    "Client.connect->Client.log:medium",   // Self (@This) binding
    "Client.log->trace:medium",          // import from inside a container
    "ping->Client.init:medium",          // struct namespace, same file
    "ping->Client.connect:low",          // `c.connect()`: unbound head, unique name
    "ping->trace:medium",                // `@import("util.zig").trace()`: import expression as the head
  ]) assert.ok(keys.has(k), `edge ${k} (got: ${[...keys].join(", ")})`);
  const send = g.edges.find((e) => e.site.file === "src/main.zig" && e.site.line === 8);
  assert.equal(send.to, undefined); assert.equal(send.candidates.length, 2, "`c.send()` is ambiguous between Client.send and Util.send");
  assert.equal(g.edges.length, 13);
  rmSync(out, { recursive: true, force: true });
});

test("treesitter export CLI: env-driven entry writes the raw dir; a bad GEML_LANG is refused without touching the disk", () => {
  const out = join(tmp(), "raw");
  const script = join(PKG, "codemap", "treesitter-export.mjs");
  const r = spawnSync(process.execPath, [script], {
    encoding: "utf8", env: { ...process.env, GEML_SRC: join(PKG, "test", "fixtures", "zig-app"), GEML_OUT: out, GEML_LANG: "zig", GEML_NO_GITIGNORE: "1" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /3 files, 10 fns/, "one-line summary on stderr");
  assert.ok(existsSync(join(out, "calls.jsonl")));
  const bad = spawnSync(process.execPath, [script], {
    encoding: "utf8", env: { ...process.env, GEML_SRC: PKG, GEML_OUT: join(out, "nope"), GEML_LANG: "../../etc" },
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /GEML_LANG/);
  assert.ok(!existsSync(join(out, "nope")));
  const unknown = spawnSync(process.execPath, [script], {
    encoding: "utf8", env: { ...process.env, GEML_SRC: PKG, GEML_OUT: join(out, "nope"), GEML_LANG: "cobol" },
  });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no tree-sitter profile \(have: zig\)/, "a well-formed but unknown profile name is refused by name");
  const missing = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, GEML_SRC: "", GEML_OUT: "", GEML_LANG: "" } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /GEML_SRC, GEML_OUT and GEML_LANG are required/);
  rmSync(dirname(out), { recursive: true, force: true });
});

// The real `geml codemap build --root` over a Zig project spawns npx (network
// on first run) — opt-in, like nothing else in the suite may depend on the net.
test("e2e: zig project -> auto-detected treesitter build + verify (GEML_TS_E2E=1)", () => {
  if (!process.env.GEML_TS_E2E) { console.log("   (GEML_TS_E2E not set — skipping the npx-backed build e2e)"); return; }
  const fx = tmp();
  mkdirSync(join(fx, "src"), { recursive: true });
  for (const f of ["main.zig", "net.zig", "util.zig"]) {
    writeFileSync(join(fx, "src", f), readFileSync(join(PKG, "test", "fixtures", "zig-app", "src", f)));
  }
  writeFileSync(join(fx, "build.zig"), "");
  // --out is resolved against the cwd, so name it: never let a test drop a
  // .geml-code-graph/ into the package dir.
  const out = join(fx, ".geml-code-graph");
  const r = spawnSync(process.execPath, [join(PKG, "codemap", "build.mjs"), "--root", fx, "--out", out, "--no-gitignore"], { encoding: "utf8", timeout: 600_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Zig \(build\.zig\) -> treesitter/);
  const recipe = JSON.parse(readFileSync(join(out, "_index", "refresh.json"), "utf8"));
  const step = recipe.steps.find((s) => s.env?.GEML_LANG === "zig");
  assert.ok(step, "recipe records the treesitter step");
  assert.equal(step.argv[0], "npx");
  assert.equal(step.env.GEML_SRC, ".");
  const v = spawnSync(process.execPath, [join(PKG, "codemap", "verify.mjs"), out], { encoding: "utf8" });
  assert.equal(v.status, 0, v.stdout + v.stderr);
  rmSync(fx, { recursive: true, force: true });
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); } catch (e) { console.log("not ok", name); console.error(e && e.stack ? e.stack : e); process.exit(1); }
  passed++; console.log("ok", name);
}
console.log(`${passed} test(s) passed.`);
