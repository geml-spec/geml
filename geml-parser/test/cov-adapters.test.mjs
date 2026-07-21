// Branch-coverage tests for the codemap toolkit's pure modules and adapters —
// closes the arms the main suite (test/codemap.test.mjs) leaves open: the crg
// SQLite adapter (previously 0%), the browser stub's no-op contract, joern
// export-format variants, scip wire/nameOf/remap/recovery corners, detect /
// entries / emit / foldings / exclude / normalize edge branches, and the
// sfc-virtualize child-process paths.
import { emit } from "../codemap/emit.mjs";
import { findModuleRoots } from "../codemap/normalize.mjs";
import { gitIgnored } from "../codemap/exclude.mjs";
import { collectSourceFiles, detectLanguages, indexerCommand, tsProjectGroups, cargoWorkspace, sfcFlagOf } from "../codemap/detect.mjs";
import { detectEntries } from "../codemap/entries.mjs";
import { parseFoldings, serializeFoldings, defaultFoldings, loadOrSeedFoldings } from "../codemap/foldings.mjs";
import { extract as scipExtract, nameOf as scipNameOf, loadSfcRemap } from "../codemap/adapters/scip.mjs";
import { extract as joernExtract } from "../codemap/adapters/joern.mjs";
import { extract as crgExtract } from "../codemap/adapters/crg.mjs";
import stubDefault, * as stub from "../codemap/browser-stub.mjs";
import { DatabaseSync } from "node:sqlite";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // geml-parser/
const tmp = () => mkdtempSync(join(tmpdir(), "geml-cov-"));
// Best-effort teardown: crg's extract() never closes its DatabaseSync, so on
// Windows the .db stays locked for the process lifetime and rmSync EPERMs.
// Temp dirs live under tmpdir() — leaving one behind is fine, crashing is not.
const cleanup = (dir) => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked on Windows */ } };
const posix = (p) => p.replace(/\\/g, "/");
const fixture = (fileMap) => {
  const dir = tmp();
  for (const [rel, content] of Object.entries(fileMap)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content ?? "");
  }
  return dir;
};

// ============================= browser-stub ==================================
// The stub exists so node:* imports resolve in a browser bundle; calling any
// export would be a bug in product code, so the contract is "harmless no-op".
test("browser-stub: every export honours the harmless no-op contract", () => {
  assert.equal(stub.readFileSync("/any/file"), "");
  assert.equal(stub.writeFileSync("/any/file", "data"), undefined);
  assert.equal(stub.existsSync("/any/file"), false);
  assert.equal(stub.basename("a/b.txt"), "a/b.txt", "path helpers are identity/joiners, never parse");
  assert.equal(stub.dirname("a/b.txt"), "a/b.txt");
  assert.equal(stub.resolve("a", "b"), "a/b");
  assert.equal(stub.join("x", "y", "z"), "x/y/z");
  assert.equal(stub.fileURLToPath("file:///x"), "file:///x");
  assert.equal(stub.fileURLToPath(new URL("file:///y")), "file:///y", "non-strings stringify");
  assert.equal(stub.spawnSync("git", ["st"]).status, 1, "a failed spawn, so CLI probes read 'unavailable'");
  const h = stub.createHash("sha256");
  assert.equal(h.update("data"), h, "update chains");
  assert.equal(h.update("more").digest("hex"), "", "digest is empty, never a fake hash");
  assert.deepEqual(stubDefault, {}, "default export is an empty bag");
});

// ================================ crg ========================================
const CRG_DDL = `
CREATE TABLE nodes(id INTEGER, kind TEXT, name TEXT, qualified_name TEXT,
  file_path TEXT, line_start INTEGER, line_end INTEGER, language TEXT, is_test INTEGER);
CREATE TABLE edges(kind TEXT, source_qualified TEXT, target_qualified TEXT, file_path TEXT, line INTEGER);
`;

test("crg: symbols — anchors, collision numbering, File anchor, flags, path normalisation", () => {
  const dir = tmp();
  const root = dir; // native separators on purpose — the adapter must normalise
  const src = join(dir, "src", "a.py"); // backslashed on Windows
  const dbPath = join(dir, "graph.db");
  const db = new DatabaseSync(dbPath);
  db.exec(CRG_DDL);
  db.exec("CREATE TABLE flows(entry_point_id INTEGER, criticality REAL);");
  const ins = db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run(1, "File", "a.py", "f:a", src, null, null, "python", 0);
  ins.run(2, "Function", "dup", "q:dup2", src, 9, 12, "python", 0);   // later line → ~2
  ins.run(3, "Function", "dup", "q:dup1", src, 3, 6, "python", 0);    // earlier line → bare
  ins.run(4, "Function", "main", "q:main", src, 20, 25, null, 0);     // null language, entry
  ins.run(5, "Function", "t1", "q:t1", join(dir, "tests", "t.py"), 1, 2, "python", 1);
  ins.run(6, "Function", "low", "q:low", src, 30, 31, "python", 0);   // flow crit below bar
  ins.run(7, "Function", "out", "q:out", "/other/x.py", 1, 2, "python", 0); // outside root
  ins.run(8, "Function", "tie", "q:tie1", src, 40, 41, "python", 0);  // same line_start →
  ins.run(9, "Function", "tie", "q:tie2", src, 40, 41, "python", 0);  //   id breaks the tie
  ins.run(10, "Function", "nl", "q:nl0", src, null, null, "python", 0); // null line_start → 0
  ins.run(11, "Function", "nl", "q:nl2", src, 2, 3, "python", 0);
  ins.run(12, "Function", "nn", "q:nn1", src, null, null, "python", 0); // BOTH null line_starts →
  ins.run(13, "Function", "nn", "q:nn2", src, null, null, "python", 0); //   the id alone breaks the tie
  const insF = db.prepare("INSERT INTO flows VALUES (?,?)");
  insF.run(4, 0.9); insF.run(4, 0.4); insF.run(6, 0.5);
  db.close();

  const r = crgExtract({ db: dbPath, root });
  const by = new Map(r.symbols.map((s) => [s.anchor, s]));
  assert.ok(by.has("python:src/a.py#dup"), "earlier line_start owns the bare anchor");
  assert.ok(by.has("python:src/a.py#dup~2"), "later same-name symbol numbered ~2");
  assert.equal(by.get("python:src/a.py#dup").line_start, 3, "…and the bare one IS the earlier");
  assert.ok(by.has("python:src/a.py"), "File symbol anchor carries no #name");
  assert.equal(by.get("python:src/a.py").line_start, undefined, "null line_start → undefined");
  const main = by.get("unknown:src/a.py#main");
  assert.ok(main, "null language reads as 'unknown'");
  assert.equal(main.entry, true, "Function named main is an app entry");
  assert.equal(main.flow_crit, 0.9, "max flow criticality >= 0.6 rides along");
  assert.equal(by.get("python:src/a.py#low").flow_crit, undefined, "0.5 stays below the HAVING bar");
  assert.equal(by.get("python:tests/t.py#t1").is_test, true);
  assert.equal(by.get("python:src/a.py#dup").is_test, undefined, "0 → undefined, not false");
  assert.equal(by.get("python:/other/x.py#out").file, "/other/x.py", "path outside root kept verbatim");
  assert.ok(by.has("python:src/a.py#tie") && by.has("python:src/a.py#tie~2"), "line tie broken by id");
  assert.equal(by.get("python:src/a.py#nl").line_start, undefined, "null line sorts first (?? 0)");
  assert.ok(by.has("python:src/a.py#nn") && by.has("python:src/a.py#nn~2"), "both-null line_starts fall to the id tiebreak");
  assert.ok(r.symbols.every((s) => s.resolution === "heuristic"), "tree-sitter tier is heuristic");
  cleanup(dir);
});

test("crg: edges — kind map, dangling source, resolved vs to_text, missing flows table", () => {
  const dir = tmp();
  const src = join(dir, "src", "a.py");
  const dbPath = join(dir, "g.db");
  const db = new DatabaseSync(dbPath);
  db.exec(CRG_DDL); // NO flows table → the catch branch
  const ins = db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run(1, "Function", "f", "q:f", src, 1, 3, "python", 0);
  ins.run(2, "Function", "g", "q:g", src, 5, 7, "python", 0);
  const insE = db.prepare("INSERT INTO edges VALUES (?,?,?,?,?)");
  insE.run("CALLS", "q:f", "q:g", src, 2);                       // resolved → medium
  insE.run("CALLS", "q:f", "lib\\ext\\thing.py", src, null);     // unresolved → to_text, line ?? 0
  insE.run("CONTAINS", "q:f", "q:g", src, 1);                    // not an edge kind → skipped
  insE.run("CALLS", "q:ghost", "q:g", src, 1);                   // dangling source → skipped
  insE.run("IMPORTS_FROM", "q:g", "q:f", src, 6);                // kind map
  db.close();

  const r = crgExtract({ db: dbPath, root: dir });
  assert.equal(r.symbols.find((s) => s.name === "f").flow_crit, undefined, "no flows table → no crit, no crash");
  assert.equal(r.edges.length, 3, "CONTAINS and the dangling source produce nothing");
  const call = r.edges.find((e) => e.kind === "calls" && e.to);
  assert.equal(call.to, "python:src/a.py#g");
  assert.equal(call.confidence, "medium", "resolved heuristic edge is medium");
  assert.deepEqual(call.site, { file: "src/a.py", line: 2 });
  const unres = r.edges.find((e) => e.to_text);
  assert.equal(unres.to_text, "thing.py", "backslash path → posix → basename only");
  assert.equal(unres.confidence, "low");
  assert.equal(unres.site.line, 0, "null line → 0");
  assert.equal(r.edges.find((e) => e.kind === "imports").to, "python:src/a.py#f");
  cleanup(dir);
});

// ================================ joern ======================================
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

test("joern: display names, dedupe, ~2 numbering, langs, missing fields, edge confidences", () => {
  const dir = tmp();
  const rootPosix = posix(dir);
  const m = (o) => o;
  writeFileSync(join(dir, "methods.jsonl"), jsonl([
    // dedupe: identical key, wide first / narrow second → keep wide
    m({ fullName: "pkg.A.run", signature: "void()", file: rootPosix + "/src/a.java", name: "run", lineStart: 1, lineEnd: 10 }),
    m({ fullName: "pkg.A.run", signature: "void()", file: rootPosix + "/src/a.java", name: "run", lineStart: 1, lineEnd: 4 }),
    // dedupe: narrow first / wide second → replace
    m({ fullName: "pkg.A.pre", signature: "v()", file: rootPosix + "/src/a.java", name: "pre", lineStart: 12, lineEnd: 13 }),
    m({ fullName: "pkg.A.pre", signature: "v()", file: rootPosix + "/src/a.java", name: "pre", lineStart: 12, lineEnd: 19 }),
    // same name+sig+file, DIFFERENT fullName → distinct symbols, ~2 by line
    m({ fullName: "pkg.B.go", signature: "void()", file: "src/b.java", name: "go", lineStart: 2, lineEnd: 3 }),
    m({ fullName: "pkg.C.go", signature: "void()", file: "src/b.java", name: "go", lineStart: 20, lineEnd: 22 }),
    // C-style: dotless fullName, no lines, empty signature, and it's main → entry
    m({ fullName: "main", signature: "", file: "src/m.c", name: "main" }),
    // constructors / static init, class-qualified and dotless
    m({ fullName: "pkg.K.<init>", signature: "void()", file: "src/k.java", name: "<init>", lineStart: 1, lineEnd: 2 }),
    m({ fullName: "<init>", signature: "void()", file: "src/k2.java", name: "<init>", lineStart: 1, lineEnd: 1 }),
    m({ fullName: "pkg.K.<clinit>", signature: "void()", file: "src/k.java", name: "<clinit>", lineStart: 5, lineEnd: 6 }),
    m({ fullName: "<clinit>", signature: "void()", file: "src/k3.java", name: "<clinit>", lineStart: 1, lineEnd: 1 }),
    // fullName missing entirely
    m({ signature: "s()", file: "src/n.java", name: "anon", lineStart: 1, lineEnd: 1 }),
    // owner ends with "." → empty simple name; owner ends with "$" → same via $-split
    m({ fullName: "a..m", signature: "s()", file: "src/o.java", name: "m", lineStart: 1, lineEnd: 1 }),
    m({ fullName: "x$.m", signature: "s()", file: "src/p.java", name: "m", lineStart: 1, lineEnd: 1 }),
    // inner class: $ split keeps the innermost
    m({ fullName: "pkg.Outer$Inner.act", signature: "s()", file: "src/q.java", name: "act", lineStart: 1, lineEnd: 2 }),
    // language table: python hit, unknown extension fallback
    m({ fullName: "z.f", signature: "s()", file: "src/z.py", name: "f", lineStart: 1, lineEnd: 1 }),
    m({ fullName: "w", signature: "s()", file: "data.weird", name: "w", lineStart: 1, lineEnd: 1 }),
  ]));
  writeFileSync(join(dir, "calls.jsonl"), jsonl([
    // one internal callee → high
    { callerFullName: "pkg.A.run", callerSignature: "void()", callerFile: rootPosix + "/src/a.java", line: 3, name: "go",
      callees: [{ fullName: "pkg.B.go", signature: "void()", file: "src/b.java" }] },
    // two internal callees → dispatch: first + candidates, medium
    { callerFullName: "pkg.A.run", callerSignature: "void()", callerFile: rootPosix + "/src/a.java", line: 4, name: "go",
      callees: [{ fullName: "pkg.C.go", signature: "void()", file: "src/b.java" }, { fullName: "pkg.B.go", signature: "void()", file: "src/b.java" }] },
    // callee not among methods → filters to none → to_text low
    { callerFullName: "pkg.A.run", callerSignature: "void()", callerFile: rootPosix + "/src/a.java", line: 5, name: "printf",
      callees: [{ fullName: "ext.X", signature: "s()", file: "ext.java" }] },
    // callees key absent → ?? [] → to_text; line absent → 0
    { callerFullName: "pkg.A.run", callerSignature: "void()", callerFile: rootPosix + "/src/a.java", name: "puts" },
    // caller unknown → dropped entirely
    { callerFullName: "nobody", callerSignature: "x", callerFile: "src/a.java", line: 9, name: "z", callees: [] },
  ]));

  const r = joernExtract({ raw: dir, root: dir });
  const fns = r.symbols.filter((s) => s.kind === "Function");
  const byName = new Map(fns.map((s) => [s.name, s]));
  assert.equal(byName.get("A.run").line_end, 10, "dup key: widest span wins over the later narrow one");
  assert.equal(byName.get("A.pre").line_end, 19, "dup key: later wider record replaces the narrow one");
  const gos = fns.filter((s) => /(^|\.)go$/.test(s.name));
  assert.deepEqual(gos.map((s) => s.anchor).sort(), ["java:src/b.java#go(void())", "java:src/b.java#go(void())~2"],
    "distinct fullNames sharing name+sig+file get ~2 by line order");
  const main = byName.get("main");
  assert.equal(main.entry, true);
  assert.equal(main.line_start, undefined, "missing lineStart → undefined");
  assert.equal(main.line_end, undefined);
  assert.equal(main.signature, undefined, "empty signature → undefined");
  assert.equal(main.lang, "c");
  assert.ok(byName.has("K.new") && byName.has("new"), "constructors: class-qualified and bare");
  assert.ok(byName.has("K.static{}") && byName.has("static{}"), "static initialisers likewise");
  assert.equal(byName.get("anon").name, "anon", "missing fullName → plain method name");
  assert.equal(fns.filter((s) => s.name === "m").length, 2, "degenerate owners (a.. / x$.) fall back to the bare name");
  assert.ok(byName.has("Inner.act"), "inner class $-splits to the innermost simple name");
  assert.equal(byName.get("z.f")?.lang ?? fns.find((s) => s.file === "src/z.py").lang, "python");
  assert.equal(fns.find((s) => s.file === "data.weird").lang, "unknown", "unmapped extension → unknown");
  assert.ok(r.symbols.some((s) => s.kind === "File" && s.file === "src/b.java"), "one File symbol per source file");

  assert.equal(r.edges.length, 4, "the unknown caller contributed no edge");
  const high = r.edges.find((e) => e.confidence === "high");
  assert.equal(high.to, "java:src/b.java#go(void())");
  const med = r.edges.find((e) => e.confidence === "medium");
  assert.equal(med.to, "java:src/b.java#go(void())", "dispatch: sorted-first target as to");
  assert.deepEqual(med.candidates, ["java:src/b.java#go(void())~2"], "…the rest as candidates");
  assert.match(med.note, /dispatch, 2 candidates/);
  const lows = r.edges.filter((e) => e.confidence === "low");
  assert.deepEqual(lows.map((e) => e.to_text).sort(), ["printf", "puts"]);
  assert.equal(lows.find((e) => e.to_text === "puts").site.line, 0, "missing line → 0");
  cleanup(dir);
});

test("joern: no root — rootFs empty, absolute paths lose only their leading slash", () => {
  const dir = tmp();
  writeFileSync(join(dir, "methods.jsonl"), jsonl([
    { fullName: "q", signature: "s()", file: "/abs/q.c", name: "q", lineStart: 1, lineEnd: 2 },
  ]));
  writeFileSync(join(dir, "calls.jsonl"), "");
  const r = joernExtract({ raw: dir });
  assert.equal(r.symbols.find((s) => s.kind === "Function").file, "abs/q.c");
  cleanup(dir);
});

test("joern: records without line numbers — dedupe span math and anchor ordering default to 0", () => {
  const dir = tmp();
  writeFileSync(join(dir, "methods.jsonl"), jsonl([
    // same key, lineless FIRST: prev's ?? 0 arms; the real span replaces it
    { fullName: "pkg.D.x", signature: "s()", file: "src/d.java", name: "x" },
    { fullName: "pkg.D.x", signature: "s()", file: "src/d.java", name: "x", lineStart: 1, lineEnd: 5 },
    // same key, lineless SECOND: the incoming record's ?? 0 arms; the real span stays
    { fullName: "pkg.D.y", signature: "s()", file: "src/d.java", name: "y", lineStart: 2, lineEnd: 6 },
    { fullName: "pkg.D.y", signature: "s()", file: "src/d.java", name: "y" },
    // distinct fullNames sharing an anchor base, one lineless → ?? 0 sorts it first (both insert orders)
    { fullName: "pkg.E.z", signature: "s()", file: "src/e.java", name: "z", lineStart: 3, lineEnd: 4 },
    { fullName: "pkg.F.z", signature: "s()", file: "src/e.java", name: "z" },
    { fullName: "pkg.E.w", signature: "s()", file: "src/f.java", name: "w" },
    { fullName: "pkg.F.w", signature: "s()", file: "src/f.java", name: "w", lineStart: 7, lineEnd: 8 },
  ]));
  writeFileSync(join(dir, "calls.jsonl"), "");
  const r = joernExtract({ raw: dir, root: dir });
  const fns = r.symbols.filter((s) => s.kind === "Function");
  assert.equal(fns.find((s) => s.name === "D.x").line_end, 5, "real span replaces the lineless twin");
  assert.equal(fns.find((s) => s.name === "D.y").line_end, 6, "lineless twin never replaces a real span");
  assert.equal(fns.find((s) => s.name.endsWith(".z") && s.anchor.endsWith("~2")).line_start, 3,
    "lineless record owns the bare anchor — missing lineStart sorts as 0");
  assert.equal(fns.find((s) => s.name.endsWith(".w") && s.anchor.endsWith("~2")).line_start, 7);
  cleanup(dir);
});

// ================================ scip =======================================
// Minimal SCIP protobuf writer (same shape as the main suite's).
const vint = (n) => { const b = []; do { const x = n & 0x7f; n = Math.floor(n / 128); b.push(n ? x | 0x80 : x); } while (n); return b; };
const lenField = (no, bytes) => [...vint((no << 3) | 2), ...vint(bytes.length), ...bytes];
const intField = (no, v) => [...vint(no << 3), ...vint(v)];
const strField = (no, s) => lenField(no, [...Buffer.from(s, "utf8")]);
const packedField = (no, ints) => lenField(no, ints.flatMap(vint));
const scipOcc = ({ range, symbol, roles = 0, enclosing }) => lenField(2, [
  ...packedField(1, range), ...strField(2, symbol),
  ...(roles ? intField(3, roles) : []),
  ...(enclosing ? packedField(7, enclosing) : []),
]);
const scipDoc = (path, occs) => lenField(2, [...strField(1, path), ...occs.flat()]);
// SymbolInformation with is_implementation relationships
const scipSymInfo = (sym, implOf) => lenField(3, [
  ...strField(1, sym),
  ...implOf.flatMap((t) => lenField(4, [...strField(1, t), ...intField(3, 1)])),
]);
const TS = "scip-typescript npm t 1.0.0 ";
const RA = "rust-analyzer cargo c 1.0.0 ";

test("scip nameOf: descriptor-grammar corners (short header, escapes, params, meta/macro, no-method)", () => {
  assert.equal(scipNameOf("rust-analyzer c"), "c", "fewer than 4 header tokens → whole string is the tail; last token name wins");
  assert.equal(scipNameOf("rust-analyzer cargo c 1.0 `a``b`()."), "a`b", "`` escapes a literal backtick");
  assert.equal(scipNameOf("rust-analyzer cargo c 1.0 (p)f()."), "f", "leading (param) descriptor consumed");
  assert.equal(scipNameOf("rust-analyzer cargo c 1.0 a:b!c%d()."), "d", "meta/macro/unknown descriptors skipped over");
  assert.equal(scipNameOf("rust-analyzer cargo c 1.0 x/Type#"), "Type", "no method descriptor → last descriptor name");
  assert.equal(scipNameOf("rust-analyzer cargo c 1.0 ()."), "1.0 ().".split("/").pop() === "1.0 ()." ? scipNameOf("rust-analyzer cargo c 1.0 ().") : "", "does not throw");
  assert.equal(scipNameOf("rust-analyzer cargo c 1.0 "), "rust-analyzer cargo c 1.0 ", "empty tail → path-pop fallback");
  assert.equal(scipNameOf("scip-typescript npm p 1.0.0 src/`a.ts`/`<constructor>`()."), "new", "ownerless constructor");
  assert.equal(scipNameOf("gibberish without descriptors"), "gibberish without descriptors", "non-symbol → identity");
  assert.equal(scipNameOf("a/b"), "b", "…or its last path segment");
});

test("scip wire: fixed64/fixed32 fields, unpacked range ints, non-document top-level fields", () => {
  const bytes = Buffer.from([
    ...intField(4, 7),                                     // top-level field no 4 (not documents)
    ...intField(2, 3),                                     // top-level no 2 but wrong wire type
    ...lenField(2, [
      ...strField(1, "src/w.ts"),
      ...[...vint((15 << 3) | 1), 1, 2, 3, 4, 5, 6, 7, 8], // unknown fixed64 field → parsed, ignored
      ...[...vint((14 << 3) | 5), 1, 2, 3, 4],             // unknown fixed32 field → parsed, ignored
      ...lenField(2, [                                     // occurrence: range as SINGLE varints
        ...intField(1, 0), ...intField(1, 0), ...intField(1, 5),
        ...strField(2, TS + "src/`w.ts`/f()."), ...intField(3, 1),
      ]),
    ]),
  ]);
  const dir = tmp();
  const raw = join(dir, "index.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw, root: dir });
  const f = r.symbols.find((s) => s.kind === "Function");
  assert.equal(f.name, "f", "definition survives the wire-format detours");
  assert.equal(f.line_start, 1, "unpacked range ints accumulate exactly like packed ones");
  cleanup(dir);
});

test("scip wire: an unsupported wire type degrades gracefully (clean skip, no throw)", () => {
  const dir = tmp();
  const raw = join(dir, "bad.scip");
  writeFileSync(raw, Buffer.from([(1 << 3) | 3])); // field 1, wire type 3 (deprecated group start)
  // Hardened decoder STOPS on an unmodelled wire type instead of throwing — a
  // malformed .scip must not abort the whole build (audit L5 DoS). Was: threw.
  const r = scipExtract({ raw, root: dir });
  assert.equal(r.symbols.length, 0);
  assert.equal(r.edges.length, 0);
  cleanup(dir);
});

test("scip: implementation relationships turn interface calls into medium dispatch", () => {
  const I = TS + "src/`i.ts`/I#m().";
  const C = TS + "src/`i.ts`/C#m().";
  const F = TS + "src/`i.ts`/f().";
  const bytes = Buffer.from([
    ...scipDoc("src/i.ts", [
      scipOcc({ range: [1, 2, 1, 3], symbol: I, roles: 1, enclosing: [1, 0, 1, 9] }),
      scipOcc({ range: [4, 2, 4, 3], symbol: C, roles: 1, enclosing: [4, 0, 6, 1] }),
      scipOcc({ range: [8, 9, 8, 10], symbol: F, roles: 1, enclosing: [8, 0, 10, 1] }),
      scipOcc({ range: [9, 4, 9, 5], symbol: I }), // call to the interface member inside f
      scipSymInfo(C, [I]),                          // C.m implements I.m
    ]),
  ]);
  const dir = tmp();
  const raw = join(dir, "index.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw, root: dir });
  const e = r.edges.find((x) => x.to === I);
  assert.ok(e, "interface-member call resolves");
  assert.equal(e.from, F);
  assert.equal(e.confidence, "medium", "known implementations demote high → medium dispatch");
  assert.match(e.note, /dispatch, 2 candidates/);
  assert.deepEqual(e.candidates, [C]);
  cleanup(dir);
});

test("scip: overloads keep the widest definition regardless of record order", () => {
  const G = TS + "src/`o.ts`/g().";
  const H = TS + "src/`o.ts`/h().";
  const bytes = Buffer.from([
    ...scipDoc("src/o.ts", [
      scipOcc({ range: [0, 9, 0, 10], symbol: G, roles: 1, enclosing: [0, 0, 5, 1] }),  // wide first
      scipOcc({ range: [7, 9, 7, 10], symbol: G, roles: 1, enclosing: [7, 0, 7, 5] }),  // narrow → skipped
      scipOcc({ range: [9, 9, 9, 10], symbol: H, roles: 1, enclosing: [9, 0, 9, 5] }),  // narrow first
      scipOcc({ range: [11, 9, 11, 10], symbol: H, roles: 1, enclosing: [11, 0, 20, 1] }), // wide → replaces
    ]),
  ]);
  const dir = tmp();
  const raw = join(dir, "index.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw, root: dir });
  const g = r.symbols.find((s) => s.name === "g");
  assert.deepEqual([g.line_start, g.line_end], [1, 6], "wide impl kept over the later overload signature");
  const h = r.symbols.find((s) => s.name === "h");
  assert.deepEqual([h.line_start, h.line_end], [12, 21], "later wider record replaces the narrow one");
  cleanup(dir);
});

test("scip macro-erase: root defaults to cwd (absolute doc path) and a missing source refuses", () => {
  // root undefined: resolve(".", <absolute path>) still lands on the file.
  const dir = tmp();
  const srcAbs = join(dir, "erased.rs");
  writeFileSync(srcAbs, "fn lost() {\n    helper();\n}\n");
  const bytes = Buffer.from([
    ...scipDoc(posix(srcAbs), [
      scipOcc({ range: [1, 4, 1, 10], symbol: RA + "helper()." }), // orphan call, no defs at all
    ]),
  ]);
  const raw = join(dir, "a.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw }); // NO root
  const lost = r.symbols.find((s) => s.name === "lost");
  assert.ok(lost, "recovered from the source with root defaulted");
  assert.equal(lost.resolution, "heuristic");

  // unreadable source: refuse quietly, synthesize nothing.
  const bytes2 = Buffer.from([
    ...scipDoc("src/missing.rs", [
      scipOcc({ range: [1, 4, 1, 10], symbol: RA + "helper()." }),
    ]),
  ]);
  const raw2 = join(dir, "b.scip");
  writeFileSync(raw2, bytes2);
  const r2 = scipExtract({ raw: raw2, root: dir });
  assert.equal(r2.symbols.filter((s) => s.kind === "Function").length, 0, "no witness file → no invented fn");
  cleanup(dir);
});

test("scip macro-erase: an admitted def SPLITS orphan runs into two regions", () => {
  const dir = tmp();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "lib.rs"), [
    "fn first() {",   // 0 — erased
    "    a();",       // 1 — orphan
    "}",              // 2
    "", "",           // 3-4
    "fn mid() {",     // 5 — admitted
    "    x();",       // 6
    "}",              // 7
    "fn second() {",  // 8 — erased
    "",               // 9
    "    b();",       // 10 — orphan
    "}",              // 11
  ].join("\n"));
  const bytes = Buffer.from([
    ...scipDoc("src/lib.rs", [
      scipOcc({ range: [5, 3, 5, 6], symbol: RA + "mid().", roles: 1, enclosing: [5, 0, 7, 1] }),
      scipOcc({ range: [1, 4, 1, 5], symbol: RA + "a()." }),
      scipOcc({ range: [10, 4, 10, 5], symbol: RA + "b()." }),
    ]),
  ]);
  const raw = join(dir, "x.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw, root: dir });
  const names = r.symbols.filter((s) => s.kind === "Function").map((s) => s.name).sort();
  assert.deepEqual(names, ["first", "mid", "second"], "one recovery per region, split at the admitted def");
  const second = r.symbols.find((s) => s.name === "second");
  assert.equal(second.line_start, 9, "second region reaches back only to the admitted def's end");
  cleanup(dir);
});

test("scip macro-erase: two signatures inside ONE region split its calls between them", () => {
  const dir = tmp();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "two.rs"), [
    "fn alpha() {",   // 0
    "    callee();",  // 1 — orphan
    "}",              // 2
    "fn beta() {",    // 3
    "    callee();",  // 4 — orphan
    "}",              // 5
  ].join("\n"));
  const bytes = Buffer.from([
    ...scipDoc("src/two.rs", [
      scipOcc({ range: [1, 4, 1, 10], symbol: RA + "callee()." }),
      scipOcc({ range: [4, 4, 4, 10], symbol: RA + "callee()." }),
    ]),
  ]);
  const raw = join(dir, "x.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw, root: dir });
  const alpha = r.symbols.find((s) => s.name === "alpha");
  const beta = r.symbols.find((s) => s.name === "beta");
  assert.ok(alpha && beta, "both erased fns recovered from one region");
  assert.deepEqual([alpha.line_start, alpha.line_end], [1, 3], "alpha ends where beta's signature starts");
  assert.deepEqual([beta.line_start, beta.line_end], [4, 5], "beta reaches only to its last orphan call line, not the file end");
  const froms = r.edges.map((e) => r.symbols.find((s) => s.anchor === e.from)?.name).sort();
  assert.deepEqual(froms, ["alpha", "beta"], "each call attributed to ITS signature");
  cleanup(dir);
});

test("scip degraded mode: several defs without enclosing_range — nearest PRECEDING def wins", () => {
  const bytes = Buffer.from([
    ...scipDoc("src/d.ts", [
      scipOcc({ range: [0, 9, 0, 11], symbol: TS + "src/`d.ts`/f0().", roles: 1 }), // no enclosing anywhere
      scipOcc({ range: [5, 9, 5, 11], symbol: TS + "src/`d.ts`/f5().", roles: 1 }),
      scipOcc({ range: [7, 2, 7, 4], symbol: TS + "src/`d.ts`/f0()." }),  // after f5 → caller f5
      scipOcc({ range: [3, 2, 3, 4], symbol: TS + "src/`d.ts`/f5()." }),  // between → caller f0
    ]),
  ]);
  const dir = tmp();
  const raw = join(dir, "index.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw, root: dir });
  const name = (a) => scipNameOf(a);
  const pairs = r.edges.map((e) => `${name(e.from)}->${name(e.to)}`).sort();
  assert.deepEqual(pairs, ["f0->f5", "f5->f0"], "degraded attribution: nearest preceding definition");
  cleanup(dir);
});

test("scip loadSfcRemap: manifest field defaults, unreadable side map, original outside root", () => {
  const dir = tmp();
  const vdir = join(dir, "virtual");
  mkdirSync(vdir, { recursive: true });
  // no manifest at all → null
  assert.equal(loadSfcRemap(join(dir, "nope"), dir), null);
  // manifest without `files` → empty map, no crash
  writeFileSync(join(vdir, "sfc-manifest.json"), JSON.stringify({ version: 1, src: posix(join(dir, "elsewhere")) }));
  assert.equal(loadSfcRemap(vdir, join(dir, "root")).bySh.size, 0);
  // one unreadable side map (skipped) + one minimal side map (defaults) + src outside root
  writeFileSync(join(vdir, "sfc-manifest.json"), JSON.stringify({
    version: 1, src: posix(join(dir, "elsewhere")),
    files: [
      { shadow: "a.vue.ts", original: "a.vue", map: "missing.map.json" },
      { shadow: "b.vue.ts", original: "sub/b.vue", map: "b.map.json" },
    ],
  }));
  writeFileSync(join(vdir, "b.map.json"), "{}"); // no component/regions/lines
  const r = loadSfcRemap(vdir, join(dir, "root"));
  assert.equal(r.bySh.size, 1, "the unreadable side map is skipped, not fatal");
  const info = r.bySh.get("b.vue.ts");
  assert.equal(info.original, "sub/b.vue", "original outside --root keeps the manifest-relative path");
  assert.equal(info.component, "b.vue", "component defaults to the original's basename");
  assert.deepEqual(info.regions, []);
  assert.equal(info.map.size, 0);
  cleanup(dir);
});

test("scip remap: generated-named defs drop (and calls to them), unmapped lines stay unattributed", () => {
  const dir = tmp();
  const vdir = join(dir, "virtual");
  mkdirSync(join(vdir, "src"), { recursive: true });
  writeFileSync(join(vdir, "sfc-manifest.json"), JSON.stringify({
    version: 1, src: posix(dir),
    files: [{ shadow: "src/E.vue.ts", original: "src/E.vue", map: "src/E.vue.ts.map.json" }],
  }));
  writeFileSync(join(vdir, "src", "E.vue.ts.map.json"), JSON.stringify({
    version: 1, original: "src/E.vue", framework: "vue", component: "E",
    lines: [[4, 3], [5, 4]], // generated 4,5 → original 3,4; NOTHING else maps
    regions: [{ name: "template", start: 8, end: 10 }],
  }));
  const S = TS + "src/`E.vue.ts`/save().";
  const V = TS + "src/`E.vue.ts`/__VLS_helper().";
  const bytes = Buffer.from([
    ...scipDoc("src/E.vue.ts", [
      // save: gen lines 4..7 — end line 7 is unmapped → line_end falls back to line_start
      scipOcc({ range: [3, 9, 3, 13], symbol: S, roles: 1, enclosing: [3, 0, 6, 1] }),
      // generated helper DEF (would be a symbol if not name-filtered)
      scipOcc({ range: [4, 9, 4, 13], symbol: V, roles: 1, enclosing: [4, 0, 4, 9] }),
      // call to the dropped generated def, from inside save (mapped line)
      scipOcc({ range: [4, 20, 4, 24], symbol: V }),
      // call to an external fn at an UNMAPPED generated line inside save
      scipOcc({ range: [5, 20, 5, 24], symbol: TS + "src/`x.ts`/ext()." }),
    ]),
  ]);
  const raw = join(dir, "index.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw, root: dir, remapDir: vdir });
  const fns = r.symbols.filter((s) => s.kind === "Function");
  assert.deepEqual(fns.map((s) => s.name), ["save"], "__VLS_* def never becomes a symbol");
  assert.deepEqual([fns[0].line_start, fns[0].line_end], [3, 3], "unmapped end line falls back to the start");
  assert.equal(r.edges.length, 0, "call to a dropped def and an unmapped-line call both vanish, never misattribute");
  cleanup(dir);
});

test("scip nameOf: empty descriptor names fall through the whole fallback chain", () => {
  assert.equal(scipNameOf("rust-analyzer cargo c 1.0 /"), "rust-analyzer cargo c 1.0 /",
    "empty ns descriptor name + trailing slash exhaust every fallback — identity");
});

test("scip svelte-locals: function-shaped locals admitted, brace-scan corners, generated callees skipped", () => {
  const dir = tmp();
  const vdir = join(dir, "virtual");
  mkdirSync(join(vdir, "src"), { recursive: true });
  // Shadow text crafted to walk every braceSpanEnd/localFnAt corner. 0-based:
  const L = [
    /* 0*/ "function $$render() {",
    /* 1*/ '  function save() { helper("a{b"); }',            // `function …` decl; brace inside a string
    /* 2*/ "  const go = () => {",                            // `= (` arrow with a block body
    /* 3*/ "    save();",
    /* 4*/ '    const s = "esc\\"ape { x";',                  // escaped quote + brace inside string
    /* 5*/ "    const t = `tpl",                              // template literal spans a newline
    /* 6*/ "line`;",
    /* 7*/ "    // line comment {",                           // brace inside a line comment
    /* 8*/ "    /* block }",                                  // close-brace inside a block comment
    /* 9*/ "       comment */",
    /*10*/ "  };",
    /*11*/ "  const one = () => save();",                     // expression body: `;` before any `{`
    /*12*/ "  const fx = async function () { save(); };",     // `= async function`
    /*13*/ "  const aid = async x => x;",                     // ident arrow; def line left UNMAPPED
    /*14*/ "  let plain = 5;",                                // not function-shaped — refused
    /*15*/ "  const $$gen = () => { save(); };",              // generated name — refused
    /*16*/ "  const bad = () => {",                           // body never closes …
    /*17*/ '    const u = "oops',                             // … unterminated string hits the newline
    /*18*/ "    save(",
    /*19*/ "  const tail = () =>",                            // EOF before `{` or `;`
  ];
  writeFileSync(join(vdir, "src", "C.svelte.ts"), L.join("\n"));
  writeFileSync(join(vdir, "sfc-manifest.json"), JSON.stringify({
    version: 1, src: posix(dir),
    files: [{ shadow: "src/C.svelte.ts", original: "src/C.svelte", map: "src/C.svelte.ts.map.json" }],
  }));
  writeFileSync(join(vdir, "src", "C.svelte.ts.map.json"), JSON.stringify({
    version: 1, original: "src/C.svelte", framework: "svelte", component: "C",
    // gen(1-based) -> orig; aid (gen 14), bad (17) and tail (20) stay unmapped → dropped, never misattributed
    lines: [[2, 2], [3, 3], [4, 4], [11, 8], [12, 12], [13, 13], [18, 9], [19, 10]],
    regions: [{ name: "markup", start: 20, end: 22 }],
  }));
  const at = (l, name) => { const cs = L[l].indexOf(name); return { l, cs, ce: cs + name.length }; };
  const def3 = (l, name, n) => { const p = at(l, name); return scipOcc({ range: [p.l, p.cs, p.ce], symbol: `local ${n}`, roles: 1 }); };
  const def4 = (l, name, n) => { const p = at(l, name); return scipOcc({ range: [p.l, p.cs, p.l, p.ce], symbol: `local ${n}`, roles: 1 }); };
  const I = TS + "src/`C.svelte.ts`/IFace#m().";
  const CI = TS + "src/`C.svelte.ts`/CImpl#m().";
  const bytes = Buffer.from([
    ...scipDoc("src/C.svelte.ts", [
      def3(1, "save", 1),                    // 3-length range arm
      def4(2, "go", 2), def4(11, "one", 3), def4(12, "fx", 4), def4(13, "aid", 5),
      def4(14, "plain", 6), def4(15, "$$gen", 7), def4(16, "bad", 8), def4(19, "tail", 10),
      scipOcc({ range: [99, 0, 99, 4], symbol: "local 42", roles: 1 }),  // beyond EOF → lineText ""
      // interface + implementation, both on MAPPED lines → both survive remap
      scipOcc({ range: [17, 0, 17, 2], symbol: I, roles: 1, enclosing: [17, 0, 17, 6] }),
      scipOcc({ range: [18, 0, 18, 2], symbol: CI, roles: 1, enclosing: [18, 0, 18, 6] }),
      scipSymInfo(CI, [I]),
      scipOcc({ range: [3, 4, 3, 8], symbol: "local 1" }),               // go() calls save()
      scipOcc({ range: [3, 0, 3, 2], symbol: "local 6" }),               // ref to a NON-function local
      scipOcc({ range: [3, 10, 3, 14], symbol: TS + "src/`C.svelte.ts`/__sveltets_2_any()." }), // generated callee
      scipOcc({ range: [3, 16, 3, 22], symbol: TS + "src/`C.svelte.ts`/helper()." }),           // real external
      scipOcc({ range: [3, 24, 3, 26], symbol: I }),          // interface call → dispatch under remap
      scipOcc({ range: [3, 28, 3, 30], symbol: "local 5" }),  // call to aid — admitted def, DROPPED symbol
    ]),
  ]);
  const raw = join(dir, "index.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw, root: dir, remapDir: vdir });
  const fns = r.symbols.filter((s) => s.kind === "Function");
  assert.deepEqual(fns.map((s) => s.name).sort(), ["CImpl.m", "IFace.m", "fx", "go", "one", "save"],
    "function/arrow/ident-arrow locals admitted; let-binding, $$-generated and unmapped-line defs are not");
  const go = fns.find((s) => s.name === "go");
  assert.equal(go.file, "src/C.svelte", "shadow symbols read as the original SFC");
  assert.deepEqual([go.line_start, go.line_end], [3, 8],
    "brace scan survives strings/template-newlines/comments; mapped end line rides the sidecar");
  const one = fns.find((s) => s.name === "one");
  assert.deepEqual([one.line_start, one.line_end], [12, 12], "expression-body arrow stays single-line");
  const call = r.edges.find((e) => e.to);
  assert.ok(call, "local -> local call resolves");
  assert.equal(call.confidence, "high");
  assert.equal(r.symbols.find((s) => s.anchor === call.from).name, "go");
  assert.equal(r.symbols.find((s) => s.anchor === call.to).name, "save");
  assert.deepEqual(call.site, { file: "src/C.svelte", line: 4 });
  assert.deepEqual(r.edges.filter((e) => e.to_text).map((e) => e.to_text), ["helper"],
    "__sveltets_* machinery callee skipped; a real external callee stays a blind-spot row");
  const disp = r.edges.find((e) => e.confidence === "medium");
  assert.ok(disp && disp.to === I, "interface call inside the component still dispatches under remap");
  assert.match(disp.note, /dispatch, 2 candidates/);
  assert.equal(r.symbols.find((s) => s.anchor === disp.candidates[0]).name, "CImpl.m");
  assert.ok(!r.edges.some((e) => e.to === "local:src/C.svelte.ts#5"),
    "a call to the dropped aid def vanishes, never dangles");
  cleanup(dir);
});

// ================================ emit =======================================
const symF = (name, anchor, file = "src/a.ts", extra = {}) => ({
  anchor, lang: "typescript", kind: "Function", name, file,
  line_start: 1, line_end: 3, resolution: "cpg", ...extra,
});
const fileS = (file) => ({
  anchor: `file:${file}`, lang: "typescript", kind: "File",
  name: file.split("/").pop(), file, resolution: "cpg",
});

test("emit: classes, root container, hints via suffix match, cross-doc edges, rewrite skip", () => {
  const dir = tmp();
  const out = join(dir, "map"), build = join(dir, "build");
  mkdirSync(out, { recursive: true });
  mkdirSync(build, { recursive: true });
  const mk = () => ({
    symbols: [
      symF("run", "t:a#run"),
      symF("helper", "t:a#helper", "src/a.ts", { line_start: 10, line_end: 12 }),
      symF("getX", "t:a#getX", "src/a.ts", { line_start: 20, line_end: 21 }),
      symF("Other.main", "t:b#om", "lib/b.ts"),
      symF("R::main", "t:c#rm", "lib2/c.ts"),
      symF("_private", "t:a#priv", "src/a.ts", { line_start: 30, line_end: 31 }),
      symF("rootfn", "t:r#root", "main.c"),
      { anchor: "t:t#t1", lang: "typescript", kind: "Test", name: "tcase", file: "test/x.test.ts", line_start: 1, line_end: 2, resolution: "cpg" },
      symF("flowy", "t:a#flowy", "src/a.ts", { flow_crit: 0.9, line_start: 40, line_end: 41 }),
      symF("mainA", "t:a#mainA", "src/a.ts", { entry: true, line_start: 50, line_end: 51 }),
      symF("noline", "t:a#noline", "src/a.ts", { line_start: undefined, line_end: undefined }),
      symF("czz", "t:a#czz", "src/c.ts"),   // second file in src/ WITHOUT a File symbol
      symF("idx", "t:i#idx", "index/z.ts"), // container 'index' → doc-name collision with index.geml
      fileS("src/a.ts"), fileS("lib/b.ts"), fileS("lib2/c.ts"), fileS("main.c"),
      fileS("test/x.test.ts"), fileS("index/z.ts"),
    ],
    edges: [
      { kind: "calls", from: "t:zzz#ghost", to: "t:a#helper", resolution: "cpg", confidence: "high", site: { file: "x", line: 1 } },
      { kind: "calls", from: "t:a#run", to: "t:a#helper", resolution: "cpg", site: { file: "src/a.ts", line: 2 } },
      { kind: "calls", from: "t:a#run", to: "t:b#om", resolution: "cpg", confidence: "medium",
        candidates: ["t:a#getX", "t:none#x"], site: { file: "src/a.ts", line: 3 } },
      { kind: "calls", from: "t:a#helper", to: "t:a#mainA", resolution: "cpg", confidence: "high" }, // NO site
      { kind: "calls", from: "t:a#flowy", to: "t:a#mainA", resolution: "cpg", confidence: "high", site: { file: "src/a.ts", line: 40 } },
      { kind: "calls", from: "t:a#run", to_text: "printf", resolution: "cpg", confidence: "low", site: { file: "src/a.ts", line: 5 } },
      { kind: "imports", from: "t:a#run", to: "t:a#helper", resolution: "cpg" },
      { kind: "calls", from: "t:c#rm", to: "t:a#run", resolution: "cpg", confidence: "high", site: { file: "lib2/c.ts", line: 2 } },
    ],
    outDir: out, buildDir: build, repoName: "t", container: "dir", commit: "c0",
    entryHints: [
      { file: "lib/b.ts", name: "main", via: "spring-boot" }, // matches Other.main via ".main"
      { file: "lib2/c.ts", name: "main", via: "cargo-bin" },  // matches R::main via "::main"
    ],
  });
  const stats = emit(mk());
  const d = readFileSync(join(out, "src.geml"), "utf8");
  assert.match(d, /\{#getX \.leaf \.accessor /, "no-out-edge getter with an in-edge is a leaf accessor");
  assert.match(d, /\{#flowy \.flow-entry /, "flow_crit rides into a renderer class");
  assert.match(d, /\{#mainA [^}]*\.app-entry[^}]*entry-via="main"/, "adapter entry flag defaults via=main");
  assert.match(d, /\{#mainA \.leaf \.app-entry/, "in-edges only → mainA is also a leaf, classes in fixed order");
  assert.match(d, /\{#s_private name="_private"/, "non-alpha-leading name slugs to s_… and keeps its display name");
  assert.match(d, /\{#noline[^}]*src=src\/a\.ts anchor=/, "no line_start → src without a #L range");
  assert.match(d, /## a\.ts \{#a-ts\}/, "file heading with its File-symbol id");
  assert.match(d, /## c\.ts\n/, "file WITHOUT a File symbol still gets a heading — just unnamed");
  assert.match(d, /#run,\s+lib\.geml#Other-main,\s+call,\s+medium/, "cross-doc ref + non-high confidence");
  assert.match(d, /#run,\s+#getX,\s+candidate/, "known candidate lands as its own row");
  assert.doesNotMatch(d, /t:none#x/, "unknown candidate dropped");
  assert.match(d, /#helper,\s+#mainA,\s+call,$/m, "site-less in-edge → empty site cell (trailing comma, cell trimmed)");
  assert.match(d, /=== table \{#unresolved format=csv hidden\}/, "unresolved table stays hidden");
  assert.match(d, /#run,\s+printf/);
  const rootDoc = readFileSync(join(out, "root.geml"), "utf8");
  assert.match(rootDoc, /module = root\n/, "(root) container displays as root");
  assert.doesNotMatch(rootDoc, /^src = /m, "…and carries no src= line");
  const t = readFileSync(join(out, "test.geml"), "utf8");
  assert.match(t, /\{#tcase \.test /, "test-path symbol classed .test");
  assert.ok(existsSync(join(out, "index-2.geml")), "container named 'index' dodges the reserved index.geml");
  const lib = readFileSync(join(out, "lib.geml"), "utf8");
  assert.match(lib, /\{#Other-main [^}]*\.app-entry[^}]*entry-via="spring-boot"/, "hint name matched via .main suffix");
  const lib2 = readFileSync(join(out, "lib2.geml"), "utf8");
  assert.match(lib2, /\{#R-main \.app-entry[^}]*entry-via="cargo-bin"/, "hint name matched via ::main suffix");
  const idx = readFileSync(join(out, "index.geml"), "utf8");
  assert.match(idx, /entry = lib\.geml#Other-main lib2\.geml#R-main src\.geml#mainA/, "app entries sorted by doc");
  assert.match(idx, /=== table \{#module-edges/, "cross-container calls aggregate");
  assert.match(idx, /src,\s+lib,\s+1/);
  assert.match(idx, /lib2,\s+src,\s+1/);
  assert.equal(stats.resolved, 5, "resolved counts only edges that emit a row — BOTH endpoints known; the ghost-FROM edge and to_text do not count (audit bug#5)");
  assert.ok(stats.written > 0);

  // Second emit, same input, same dirs: byte-identical → nothing rewritten.
  const stats2 = emit(mk());
  assert.equal(stats2.written, 0, "unchanged docs are never rewritten (mtime = what a change touched)");
  assert.equal(stats2.docs, stats.docs);
  cleanup(dir);
});

test("emit: file/module container modes and the empty map", () => {
  const dir = tmp();
  const outF = join(dir, "f"), outM = join(dir, "m"), outE = join(dir, "e");
  emit({
    symbols: [symF("run", "t:a#run"), fileS("src/a.ts")], edges: [],
    outDir: outF, repoName: "t", container: "file", commit: "x",
  });
  const df = readFileSync(join(outF, "src--a.ts.geml"), "utf8");
  assert.match(df, /module = src\/a\.ts\n/, "file mode: the container IS the file");
  assert.match(df, /src = src\/a\.ts\n/, "file mode srcDir is the file path itself");
  emit({
    symbols: [symF("run", "t:a#run"), symF("rootfn", "t:r#r", "main.c"), fileS("src/a.ts"), fileS("main.c")],
    edges: [], outDir: outM, repoName: "t", container: "module", commit: "x",
  });
  assert.ok(existsSync(join(outM, "src.geml")), "module mode groups by top-level dir");
  assert.ok(existsSync(join(outM, "root.geml")), "root-level file lands in (root)");
  const st = emit({ symbols: [], edges: [], outDir: outE, repoName: "e" });
  assert.equal(st.containers, 0);
  const idx = readFileSync(join(outE, "index.geml"), "utf8");
  assert.doesNotMatch(idx, /=== table/, "empty map: no modules table, no module-edges table");
  assert.match(idx, /resolution-default = heuristic/, "no cpg symbols → heuristic default");
  cleanup(dir);
});

test("emit: exact-name hint, missing line_end, same-doc app entries, in-edge ordering, rewrite on change", () => {
  const dir = tmp();
  const out = join(dir, "o"), build = join(dir, "b");
  const mk = (extra) => ({
    symbols: [
      symF("alpha", "t:a#alpha", "src/a.ts", { entry: true, line_start: 1, line_end: undefined }),
      symF("beta", "t:a#beta", "src/a.ts", { entry: true, line_start: 10, line_end: 12 }),
      symF("gamma", "t:a#gamma", "src/a.ts", { line_start: 20, line_end: 22 }),
      symF("delta", "t:a#delta", "src/a.ts", { line_start: 30, line_end: 32 }),
      ...(extra ? [symF("epsilon", "t:a#eps", "src/a.ts", { line_start: 40, line_end: 41 })] : []),
      fileS("src/a.ts"),
    ],
    edges: [
      // in-edges on alpha: two share file AND line (source-anchor tiebreak), one earlier line
      { kind: "calls", from: "t:a#beta", to: "t:a#alpha", resolution: "cpg", confidence: "high", site: { file: "src/a.ts", line: 7 } },
      { kind: "calls", from: "t:a#gamma", to: "t:a#alpha", resolution: "cpg", confidence: "high", site: { file: "src/a.ts", line: 7 } },
      { kind: "calls", from: "t:a#delta", to: "t:a#alpha", resolution: "cpg", confidence: "high", site: { file: "src/a.ts", line: 2 } },
      ...(extra ? [{ kind: "calls", from: "t:a#eps", to: "t:a#alpha", resolution: "cpg", confidence: "high", site: { file: "src/a.ts", line: 40 } }] : []),
    ],
    outDir: out, buildDir: build, repoName: "t", container: "dir", commit: "c",
    entryHints: [{ file: "src/a.ts", name: "gamma", via: "exact-hint" }],
  });
  emit(mk(false));
  const d = readFileSync(join(out, "src.geml"), "utf8");
  assert.match(d, /\{#alpha [^}]*src=src\/a\.ts#L1-1 /, "missing line_end falls back to line_start");
  assert.match(d, /\{#gamma [^}]*\.app-entry[^}]*entry-via="exact-hint"/, "hint matched by EXACT name");
  const sited = d.match(/^#(?:beta|gamma|delta),\s+#alpha,\s+call,\s+src\/a\.ts:\d+$/gm);
  assert.deepEqual(sited.map((r) => r.split(",")[0]), ["#delta", "#beta", "#gamma"],
    "in-edges sort by site line first, then by source anchor on a line tie");
  const idx = readFileSync(join(out, "index.geml"), "utf8");
  assert.match(idx, /entry = src\.geml#alpha src\.geml#beta src\.geml#gamma/,
    "several app entries in ONE doc order by anchor");
  const s2 = emit(mk(false));
  assert.equal(s2.written, 0, "byte-identical rerun writes nothing");
  const s3 = emit(mk(true));
  assert.ok(s3.written >= 1, "a changed doc IS rewritten in place");
  const manifest = JSON.parse(readFileSync(join(build, "edges-manifest.json"), "utf8"));
  assert.ok(manifest["t:a#eps"], "edges-manifest rewritten when the edge set changed");
  cleanup(dir);
});

// =============================== entries =====================================
test("entries: bin dedupe, root package, wrangler, nuxt-page, next, kit, mounts, workers", () => {
  const texts = {
    "/r/c/Cargo.toml": '[package]\nname="c"\n[[bin]]\nname="t"\npath="src\\\\bin\\\\tool.rs"\n[[bin]]\nname="m"\npath="src/main.rs"\n',
    "/r/c/src/main.rs": "fn main() {}\n",
    "/r/web/wrangler.toml": 'name = "w"\nmain = "./src/worker.ts"\n',
    "/r/web4/src/main.tsx": "createRoot(document.getElementById('root')).render(x);\n",
    "/r/web5/src/main.ts": "import { mount } from 'svelte';\nmount(App, { target: document.body });\n",
    "/r/web6/src/index.ts": "export default { fetch(req) { return new Response('x'); } };\n",
  };
  const jsons = {
    "/r/package.json": { bin: { a: "./src/cli.js", b: 42 } }, // root pkg; one non-string bin
    "/r/web/package.json": null,                              // readJson gives null → ?? {}
    "/r/web2/package.json": { dependencies: { next: "14" } },
    "/r/web3/package.json": { dependencies: { "@sveltejs/kit": "2" } },
    "/r/web4/package.json": { dependencies: { react: "18" } },
    "/r/web5/package.json": { devDependencies: { svelte: "4" } },
    // web6 throws, web7 exists but its entry file is unreadable
    "/r/web7/package.json": {},
  };
  const hints = detectEntries("/r", {
    files: [
      "c/src/bin/tool.rs", "c/src/main.rs", "src/cli.js",
      "web/src/worker.ts", "web/nuxt.config.ts", "web/pages/index.vue",
      "web2/app/page.tsx", "web3/src/routes/+page.svelte",
      "web4/src/main.tsx", "web5/src/main.ts", "web6/src/index.ts", "web7/src/app.ts",
    ],
    manifests: ["c/Cargo.toml"],
    pkgs: ["package.json", "web/package.json", "web2/package.json", "web3/package.json",
      "web4/package.json", "web5/package.json", "web6/package.json", "web7/package.json"],
    readText: (p) => {
      const t = texts[posix(p)];
      if (t === undefined) throw new Error("no " + p);
      return t;
    },
    readJson: (p) => {
      const k = posix(p);
      if (k === "/r/web6/package.json") throw new Error("corrupt manifest");
      if (!(k in jsons)) throw new Error("no " + p);
      return jsons[k];
    },
  });
  const key = (h) => `${h.file}|${h.via}|${h.name ?? ""}`;
  const keys = hints.map(key);
  assert.ok(keys.includes("c/src/bin/tool.rs|cargo-bin|main"), "src/bin target");
  assert.equal(keys.filter((k) => k === "c/src/bin/tool.rs|cargo-bin|main").length, 1,
    "[[bin]] pointing at the same file dedupes (seen-key)");
  assert.equal(keys.filter((k) => k === "c/src/main.rs|cargo-bin|main").length, 1, "default bin + [[bin]] dedupe too");
  assert.ok(keys.includes("src/cli.js|pkg-bin|"), "ROOT package.json bin resolves without a dir prefix");
  assert.ok(!hints.some((h) => h.file.includes("42")), "non-string bin value ignored");
  assert.ok(keys.includes("web/src/worker.ts|worker-fetch|"), "wrangler main");
  assert.ok(keys.includes("web/pages/index.vue|nuxt-page|"), "nuxt without app.vue falls to the index page");
  assert.ok(keys.includes("web2/app/page.tsx|next-page|"));
  assert.ok(keys.includes("web3/src/routes/+page.svelte|kit-route|"));
  assert.ok(keys.includes("web4/src/main.tsx|react-mount|"));
  assert.ok(keys.includes("web5/src/main.ts|svelte-mount|"));
  assert.ok(keys.includes("web6/src/index.ts|worker-fetch|"), "export default { fetch } marker");
  assert.ok(!hints.some((h) => h.file.startsWith("web7/")), "unreadable conventional file emits nothing");
});

test("entries: nuxt app shell, non-.rs under src/bin, svelte dep without a mount marker", () => {
  const hints = detectEntries("/r", {
    files: ["c/src/bin/notes.txt", "c/src/bin/t.rs", "web8/app.vue", "web9/src/main.ts"],
    manifests: ["c/Cargo.toml"],
    pkgs: ["web8/package.json", "web9/package.json"],
    readText: (p) => {
      if (posix(p) === "/r/web9/src/main.ts") return "console.log('no bootstrap here');\n";
      throw new Error("no " + p); // Cargo.toml unreadable → the toml-less arm
    },
    readJson: (p) => {
      const k = posix(p);
      if (k === "/r/web8/package.json") return { dependencies: { nuxt: "3" } };
      if (k === "/r/web9/package.json") return { dependencies: { svelte: "4" } };
      throw new Error("no " + p);
    },
  });
  const keys = hints.map((h) => `${h.file}|${h.via}`);
  assert.ok(keys.includes("c/src/bin/t.rs|cargo-bin"), ".rs under src/bin hints");
  assert.ok(!keys.some((k) => k.startsWith("c/src/bin/notes.txt")), "non-.rs under src/bin does not");
  assert.ok(keys.includes("web8/app.vue|nuxt-app"), "the app shell wins over the pages/index fallback");
  assert.ok(!keys.some((k) => k.startsWith("web9/")), "svelte dep without a mount marker stays silent");
});

// =============================== foldings ====================================
test("foldings: strip-shared-prefix off round-trips; language-less/unknown-language defaults", () => {
  const text = serializeFoldings({ foldPrefixes: [], sourceRoots: [], testRoots: [], stripSharedPrefix: false });
  assert.match(text, /- strip-shared-prefix: off/);
  assert.equal(parseFoldings(text).stripSharedPrefix, false);
  const noLang = defaultFoldings({ moduleRoots: ["mods/a", "mods/b"] });
  assert.deepEqual(noLang.foldPrefixes, ["mods"], "languages omitted → structural seeds only");
  const mixed = defaultFoldings({ moduleRoots: [], languages: ["Java", "Rust"] });
  assert.deepEqual(mixed.foldPrefixes, ["crates"], "unknown language contributes nothing; Rust adds crates");
  assert.deepEqual(defaultFoldings({ languages: ["Rust"] }).foldPrefixes, ["crates"], "moduleRoots omitted entirely");
});

test("foldings: an unwritable seed target degrades to defaults with a warning, never crashes", () => {
  const dir = tmp();
  const f = join(dir, "afile");
  writeFileSync(f, "not a directory");
  const r = loadOrSeedFoldings({ outDir: f, moduleRoots: ["crates/x"], languages: ["Rust"] });
  assert.equal(r.seeded, true, "the build proceeds as a (failed) first seed");
  assert.deepEqual(r.config, defaultFoldings({ moduleRoots: ["crates/x"], languages: ["Rust"] }));
  cleanup(dir);
});

// ============================ exclude / normalize ============================
test("exclude: check-ignore exits non-zero but still reported matches — they count", () => {
  const hit = gitIgnored("/r", ["a.java", "bin/x"], () => {
    const e = new Error("exit 1");
    e.stdout = "bin/x\n";
    throw e;
  });
  assert.deepEqual([...hit], ["bin/x"], "partial stdout on a throwing exec is still honoured");
});

test("exclude: a throwing exec WITHOUT stdout ignores nothing; empty file list never execs", () => {
  assert.deepEqual([...gitIgnored("/r", ["a.java"], () => { throw new Error("git missing"); })], []);
  assert.deepEqual([...gitIgnored("/r", [], () => { throw new Error("never reached"); })], []);
});

test("normalize: findModuleRoots on a missing directory returns no roots", () => {
  assert.deepEqual(findModuleRoots(join(tmpdir(), "geml-definitely-missing-" + Date.now())), []);
});

// ================================ detect =====================================
test("detect: unreadable root, odd dirents, dotless/dotfile names in the walk", () => {
  const missing = collectSourceFiles(join(tmpdir(), "geml-nope-" + Date.now()));
  assert.deepEqual(missing, { files: [], manifests: [], pkgs: [] });
  const dirent = (name, dir, file) => ({ name, isDirectory: () => dir, isFile: () => file });
  const r = collectSourceFiles("/root", {
    readdir: (d) => (posix(d) === "/root"
      ? [dirent("weird-socket", false, false), dirent("Makefile", false, true),
        dirent(".gitignore", false, true), dirent("a.ts", false, true)]
      : []),
  });
  assert.deepEqual(r.files, ["a.ts"], "non-file dirents and extensionless names never count as source");
});

test("detect: pure helpers — homeless ts file, workspace section ends, unreadable package.json", () => {
  assert.deepEqual(tsProjectGroups(["x/a.ts"], ["web"], []),
    [{ subroot: "", hasTsconfig: false, sfcExts: [] }], "no enclosing manifest dir → the root group");
  const ws = cargoWorkspace('[workspace]\nmembers = ["a"]\n\n[dependencies]\nserde = "1"\n');
  assert.deepEqual(ws, { members: ["a"], exclude: [] }, "a following table header ends the workspace section");
  assert.equal(sfcFlagOf({ sfcExts: ["vue"] }, "/p/package.json", () => { throw new Error("nope"); }), undefined);
});

test("detect: pkgs omitted + dotless source file; loose root group stays dropped", () => {
  const jobs = detectLanguages("/r", { files: ["a.ts", "noext"], manifests: [] });
  assert.deepEqual(jobs, [], "tsconfig-less non-SFC group is loose files, not a project");
});

test("detect: root-level vue app without tsconfig — signal names the root package.json", () => {
  const jobs = detectLanguages("/r", {
    files: ["App.vue", "a.ts"], manifests: [], pkgs: ["package.json"],
    readJson: () => ({ dependencies: { vue: "3" } }),
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sfc, "vue");
  assert.equal(jobs[0].signal, "package.json +vue-sfc");
});

test("detect: unreadable root Cargo.toml is memberless; nested standalone crates fold into the outer", () => {
  const jobs = detectLanguages("/r", {
    files: ["src/lib.rs", "x/src/lib.rs"],
    manifests: ["Cargo.toml", "x/Cargo.toml"],
    readText: () => { throw new Error("boom"); },
  });
  assert.deepEqual(jobs.map((j) => j.subroot ?? ""), ["x", ""], "x is not a member → its own run; root sweep stays");
  const nested = detectLanguages("/r", {
    files: ["t/a/src/lib.rs", "t/a/b/src/lib.rs"],
    manifests: ["t/a/Cargo.toml", "t/a/b/Cargo.toml"],
  });
  assert.deepEqual(nested.map((j) => j.subroot), ["t/a"], "a crate under another standalone crate rides that run");
});

test("detect: job ordering — joern after scip regardless of detection order; subroot depth then name", () => {
  const a = detectLanguages("/r", { files: ["a.ts", "A.java"], manifests: ["tsconfig.json", "pom.xml"] });
  assert.deepEqual(a.map((j) => j.indexer), ["scip", "joern"], "TS detected first still sorts scip-first");
  const b = detectLanguages("/r", { files: ["a.ts", "app/b.ts"], manifests: ["tsconfig.json", "app/tsconfig.json"] });
  assert.deepEqual(b.map((j) => j.subroot ?? ""), ["app", ""], "deepest subroot first");
  const c = detectLanguages("/r", { files: ["aa/x.ts", "ab/y.ts"], manifests: ["aa/tsconfig.json", "ab/tsconfig.json"] });
  assert.deepEqual(c.map((j) => j.subroot), ["aa", "ab"], "equal depth → lexicographic");
});

test("detect: indexerCommand tolerates an unknown SFC framework in the flag", () => {
  const cmd = indexerCommand(
    { indexer: "scip", language: "TypeScript", sfc: "vue,mystery" },
    { root: "/r", buildDir: "/b", sfcScript: "/s.mjs" },
  );
  assert.ok(cmd.pre.argv.includes("@vue/language-core"), "known framework packages ride along");
  assert.ok(!cmd.pre.argv.some((x) => /mystery/.test(x)), "unknown framework contributes no packages");
});

test("detect: joern-first detection still sorts scip first; subrooted SFC job slugs its virtual dir", () => {
  const a = detectLanguages("/r", { files: ["a.ts", "A.java"], manifests: ["pom.xml", "tsconfig.json"] });
  assert.deepEqual(a.map((j) => j.indexer), ["scip", "joern"], "Java detected FIRST still sorts after scip");
  const cmd = indexerCommand(
    { indexer: "scip", language: "TypeScript", sfc: "svelte", subroot: "apps/web" },
    { root: "/r", buildDir: "/b", sfcScript: "/s.mjs" },
  );
  assert.ok(posix(cmd.raw).endsWith("/index-apps-web.scip"), "subrooted index carries the slug");
  assert.ok(posix(cmd.remapDir).endsWith("/virtual-apps-web"), "…and so does its virtual dir");
  assert.ok(posix(cmd.pre.env.GEML_SRC).endsWith("apps/web"), "the virtualizer walks the subroot");
  assert.ok(cmd.pre.argv.includes("svelte2tsx"), "svelte packages ride the npx -p set");
});

// ============================ sfc-virtualize =================================
const SFC = join(PKG, "codemap", "sfc-virtualize.mjs");
const runSfc = (env, opts = {}) => spawnSync(process.execPath, [SFC], {
  encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...opts,
  env: { ...process.env, GEML_SRC: undefined, GEML_OUT: undefined, ...env },
});

test("sfc-virtualize: GEML_OUT is required (exit 2)", () => {
  const r = runSfc({});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /GEML_OUT/);
});

test("sfc-virtualize: no SFCs under GEML_SRC-defaulted cwd, and an unreadable GEML_SRC (exit 1)", () => {
  const fx = fixture({ "readme.txt": "no components here" });
  const r = runSfc({ GEML_OUT: join(fx, "out") }, { cwd: fx }); // GEML_SRC defaults to cwd
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing to do/);
  const r2 = runSfc({ GEML_SRC: join(fx, "missing-sub"), GEML_OUT: join(fx, "out2") });
  assert.equal(r2.status, 1, "walking an unreadable root finds nothing, exits the same way");
  assert.match(r2.stderr, /nothing to do/);
  cleanup(fx);
});

test("sfc-virtualize: unresolvable converter libraries name themselves and the npx recipe (exit 1)", () => {
  const fx = fixture({
    "src/App.vue": "<template><div/></template>",
    "src/W.svelte": "<h1>hi</h1>",
  });
  mkdirSync(join(fx, "node_modules"), { recursive: true }); // an EMPTY project node_modules origin
  // A RELATIVE _npx .bin PATH entry: found by the npx-origin probe, but
  // createRequire refuses relative paths — the catch keeps the build alive.
  const r = runSfc({
    GEML_SRC: fx, GEML_OUT: join(fx, "virtual"),
    PATH: "rel/_npx/bad/node_modules/.bin" + delimiter + process.env.PATH,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot resolve @vue\/language-core/);
  assert.match(r.stderr, /svelte2tsx/);
  assert.match(r.stderr, /npx -y -p/, "the error carries the hermetic recipe");
  cleanup(fx);
});

// (No PATH-less child run: on Windows libuv injects PATH into every spawned
// child even under an explicit env block, so `process.env.PATH ?? ""` can
// never take its "" arm here — verified empirically.)
test("sfc-virtualize: fake converters via the npx PATH origin — volar 2.x arm, reject/no-embed failures, VLQ corners, shim fallbacks", () => {
  const fx = fixture({
    "app/src/App.vue": '<script setup lang="ts">\nconst x = 1;\n</script>\n<template>\n  <div>{{ x }}</div>\n</template>\n',
    "app/src/Reject.vue": "<template><div/></template>\n",
    "app/src/NoEmbed.vue": "<template><p/></template>\n",
    "app/src/Widget.svelte": '<script lang="ts">\n  let n = 0;\n</script>\n\n<button>{n}</button>\n\n',
    "_npx/h/node_modules/typescript/package.json": JSON.stringify({ name: "typescript", version: "5.9.9", main: "index.js" }),
    "_npx/h/node_modules/typescript/index.js": "module.exports = { ScriptSnapshot: { fromString: (t) => ({ raw: t }) } };\n",
    "_npx/h/node_modules/@vue/language-core/package.json": JSON.stringify({ name: "@vue/language-core", version: "2.9.9", main: "index.js" }),
    // Fake Volar surface: 2.x options API (resolveVueCompilerOptions), a
    // rejectable file, an embedded-less file, offset mappings WITHOUT lengths,
    // and no vueSfc descriptor (forces the raw-text template fallback).
    "_npx/h/node_modules/@vue/language-core/index.js": [
      '"use strict";',
      "module.exports = {",
      "  resolveVueCompilerOptions: (o) => o,",
      "  createVueLanguagePlugin: (ts, opts, vueOptions, idFn) => ({",
      "    createVirtualCode: (id, langId, snapshot) => {",
      "      idFn(id);",
      "      if (/Reject\\.vue$/.test(id)) return null;",
      "      return { id, raw: snapshot.raw };",
      "    },",
      "  }),",
      "  forEachEmbeddedCode: function* (code) {",
      "    if (/NoEmbed\\.vue$/.test(code.id)) { yield { id: 'style_css' }; return; }",
      "    const gen = '// generated\\nconst render = 1;\\n';",
      "    yield {",
      "      id: 'script_ts',",
      "      snapshot: { getText: (a, b) => gen.slice(a, b), getLength: () => gen.length },",
      "      mappings: [{ sourceOffsets: [0], generatedOffsets: [0] }],",
      "    };",
      "  },",
      "};",
    ].join("\n"),
    "_npx/h/node_modules/svelte2tsx/package.json": JSON.stringify({ name: "svelte2tsx", main: "index.js" }),
    // Bare-function export (no .svelte2tsx property) with a crafted VLQ map:
    // empty row, column-only segment, 5-field segment (name delta), negative
    // delta, continuation-bit char — decodes to [[1,1],[4,2],[5,1]].
    "_npx/h/node_modules/svelte2tsx/index.js":
      '"use strict";\n'
      + "module.exports = function fakeSvelte2tsx(text, opts) {\n"
      + "  if (!opts.isTsFile) throw new Error('fake expects lang=ts');\n"
      + "  return { code: '// gen\\nlet a;\\n', map: { mappings: 'AAAA;;A;AACAA,AADAA;gBAAA' } };\n"
      + "};\n",
    "_npx/h/node_modules/svelte2tsx/svelte-shims.d.ts": "// fake shim (the v4 name is deliberately ABSENT)\n",
  });
  const srcDir = join(fx, "app");
  const out = join(fx, "out");
  mkdirSync(join(out, "svelte-shims.d.ts"), { recursive: true }); // shim DEST occupied by a dir → copy fails, build shrugs
  const nonBin = join(fx, "_npx", "h", "node_modules");           // matches /_npx/ but not /.bin$/ — probe walks past it
  const bin = join(nonBin, ".bin");
  mkdirSync(bin, { recursive: true });
  const r = runSfc({
    GEML_SRC: srcDir, GEML_OUT: out,
    PATH: nonBin + delimiter + bin + delimiter + process.env.PATH,
  });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /2 shadow\(s\) \(1 vue, 1 svelte\), 2 FAILED/);
  assert.match(r.stderr, /FAILED src\/Reject\.vue: not a valid vue file/);
  assert.match(r.stderr, /FAILED src\/NoEmbed\.vue: no script embedded code/);
  const appMap = JSON.parse(readFileSync(join(out, "src", "App.vue.ts.map.json"), "utf8"));
  assert.deepEqual(appMap.lines, [[1, 1]], "length-less volar mapping still yields its line pair");
  assert.deepEqual(appMap.regions, [{ name: "template", start: 4, end: 6 }],
    "no vueSfc descriptor → template region recovered from the raw text");
  const wMap = JSON.parse(readFileSync(join(out, "src", "Widget.svelte.ts.map.json"), "utf8"));
  assert.deepEqual(wMap.lines, [[1, 1], [4, 2], [5, 1]],
    "VLQ decoder: empty rows, col-only segments, 5-field names, negative deltas, continuation bits");
  assert.deepEqual(wMap.regions, [{ name: "template", start: 5, end: 5 }], "markup region trims trailing blanks");
  const tsconfig = JSON.parse(readFileSync(join(out, "tsconfig.json"), "utf8"));
  assert.ok(!tsconfig.files.includes("svelte-shims.d.ts"), "uncopyable shim stays out of the tsconfig");
  assert.ok(tsconfig.compilerOptions.rootDirs[1].endsWith("app"), "separate out dir keeps a real relative src root");
  cleanup(fx);
});

// The real-converter runs need npx (and possibly the registry) — same guard as
// the main suite's smoke test: probe npx, and skip on network failure.
const npxProbe = spawnSync("npx --version", { shell: true, encoding: "utf8", timeout: 60_000 });
const hasNpx = !npxProbe.error && npxProbe.status === 0;
const SFC_PKGS = "-p @vue/language-core -p svelte2tsx -p svelte -p typescript@5";
const runSfcNpx = (src, out) => spawnSync(
  `npx -y ${SFC_PKGS} node "${SFC}"`,
  { shell: true, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GEML_SRC: src, GEML_OUT: out } },
);
const npxNetworkDown = (r) =>
  r.status !== 0 && /ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRE|network|registry\.npmjs/i.test((r.stdout || "") + (r.stderr || ""));

test("sfc-virtualize: vue + svelte projection, template-less vue, one failing SFC (needs npx)", () => {
  if (!hasNpx) { console.log("   (npx unavailable — skipping the converter runs)"); return; }
  const fx = fixture({
    "package.json": JSON.stringify({ name: "m", version: "1.0.0" }),
    "src/App.vue": '<script setup lang="ts">\nimport { helper } from "./helper";\nfunction save() { helper(); }\n</script>\n\n<template>\n  <button @click="save">Go</button>\n</template>\n',
    "src/NoTpl.vue": "<script setup>\nexport function calc() { return 1; }\n</script>\n",
    "src/Cmp.svelte": "<script>\n  let n = 0;\n  function bump() { n += 1; }\n</script>\n\n<button on:click={bump}>+</button>\n",
    "src/Bad.svelte": "<script>\nlet x = 1;\n</script>\n{#if x}\n",
    "src/helper.ts": "export function helper() { return 1; }\n",
  });
  mkdirSync(join(fx, "node_modules"), { recursive: true });
  // GEML_OUT === GEML_SRC: shadows land beside their sources; relSrc collapses to "."
  const r = runSfcNpx(fx, fx);
  if (npxNetworkDown(r)) {
    console.log("   (npx cannot reach the registry — skipping the converter runs)");
    cleanup(fx);
    return;
  }
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}\n${r.stdout}`);
  assert.match(r.stderr, /3 shadow\(s\) \(2 vue, 1 svelte\)/, "both frameworks projected");
  assert.match(r.stderr, /1 FAILED/, "the malformed svelte component failed loudly, not silently");
  assert.match(r.stderr, /FAILED src\/Bad\.svelte/);
  const manifest = JSON.parse(readFileSync(join(fx, "sfc-manifest.json"), "utf8"));
  assert.equal(manifest.files.length, 3);
  assert.ok(existsSync(join(fx, "src", "App.vue.ts")), "vue shadow written");
  assert.ok(existsSync(join(fx, "src", "Cmp.svelte.ts")), "svelte shadow written");
  assert.ok(!existsSync(join(fx, "src", "Bad.svelte.ts")), "failed SFC leaves no shadow");
  const cmpMap = JSON.parse(readFileSync(join(fx, "src", "Cmp.svelte.ts.map.json"), "utf8"));
  assert.equal(cmpMap.framework, "svelte");
  assert.ok(cmpMap.lines.length > 0, "the VLQ decoder produced a line map");
  assert.ok(cmpMap.regions.some((g) => g.start <= 6 && g.end >= 6), "markup region covers the button line");
  assert.ok(existsSync(join(fx, "src", "NoTpl.vue.js")), "script-setup without lang=ts projects a .js shadow");
  const noTplMap = JSON.parse(readFileSync(join(fx, "src", "NoTpl.vue.js.map.json"), "utf8"));
  assert.deepEqual(noTplMap.regions, [], "template-less vue file yields no template region");
  const tsconfig = JSON.parse(readFileSync(join(fx, "tsconfig.json"), "utf8"));
  assert.ok(tsconfig.files.includes("src/App.vue.ts"));
  assert.ok(tsconfig.files.some((f) => f.endsWith("src/helper.ts")), "real TS rides along");
  assert.ok(tsconfig.compilerOptions.rootDirs.includes("."), "src==out collapses relSrc to '.'");
  assert.ok(tsconfig.compilerOptions.paths, "a project node_modules feeds the paths fallback");
  cleanup(fx);
});

test("sfc-virtualize: vue-only project, separate out dir, junction dirent skipped (needs npx)", () => {
  if (!hasNpx) { console.log("   (npx unavailable — skipping)"); return; }
  const fx = fixture({
    "app/src/Solo.vue": '<script setup lang="ts">\nfunction ping() { return 1; }\n</script>\n\n<template>\n  <button @click="ping">p</button>\n</template>\n',
    "elsewhere/x.txt": "junction target",
  });
  const srcDir = join(fx, "app");
  // A junction dirent is neither directory nor file to the walker — skipped.
  try { symlinkSync(join(fx, "elsewhere"), join(srcDir, "link"), "junction"); } catch { /* unsupported fs */ }
  const out = join(fx, "virtual-out");
  const r = runSfcNpx(srcDir, out);
  if (npxNetworkDown(r)) {
    console.log("   (npx cannot reach the registry — skipping)");
    cleanup(fx);
    return;
  }
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}\n${r.stdout}`);
  assert.match(r.stderr, /1 shadow\(s\) \(1 vue, 0 svelte\)/, "vue-only counts");
  assert.doesNotMatch(r.stderr, /FAILED/, "no failure suffix on a clean run");
  const tsconfig = JSON.parse(readFileSync(join(out, "tsconfig.json"), "utf8"));
  assert.notEqual(tsconfig.compilerOptions.rootDirs[1], ".", "separate out dir keeps a real relative src root");
  assert.ok(existsSync(join(out, "src", "Solo.vue.ts")), "shadow lands in the OUT tree");
  cleanup(fx);
});

test("sfc-virtualize: every SFC failing is a build failure, not an empty success (needs npx)", () => {
  if (!hasNpx) { console.log("   (npx unavailable — skipping)"); return; }
  const fx = fixture({ "src/Only.svelte": "{#if x}\n" });
  const out = join(fx, "virtual");
  const r = runSfcNpx(fx, out);
  if (npxNetworkDown(r)) {
    console.log("   (npx cannot reach the registry — skipping)");
    cleanup(fx);
    return;
  }
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /every SFC failed/);
  cleanup(fx);
});

console.log(`\n${passed} test(s) passed.`);
process.exit(0);
