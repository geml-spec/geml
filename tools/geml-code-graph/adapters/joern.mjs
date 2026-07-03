// geml-code-graph adapter: Joern CPG export → exchange format (DESIGN §3.2/3.4).
//
// Consumes the raw JSONL written by joern-export.sc (methods.jsonl +
// calls.jsonl) — so the node side never touches the JVM. Everything here is
// resolution:"cpg". Confidence mapping (§3.4):
//   exactly one internal callee            → high
//   several internal callees (dispatch)    → first as `to` + the rest as
//                                            `candidates`, medium
//   no internal callee (external/pointer)  → to_text, low (unresolved)
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LANG_BY_EXT = {
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  java: "java", js: "javascript", mjs: "javascript", ts: "typescript",
  py: "python", kt: "kotlin", go: "go", rb: "ruby", swift: "swift",
  cs: "csharp", php: "php",
};
const langOf = (file) => LANG_BY_EXT[file.split(".").pop()?.toLowerCase()] ?? "unknown";

const readJsonl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

export function extract({ raw, root }) {
  const rootFs = root ? root.replace(/\\/g, "/").replace(/\/?$/, "/") : "";
  const rel = (p) => {
    p = String(p).replace(/\\/g, "/");
    return rootFs && p.startsWith(rootFs) ? p.slice(rootFs.length) : p.replace(/^\//, "");
  };

  const methods = readJsonl(join(raw, "methods.jsonl"));
  const calls = readJsonl(join(raw, "calls.jsonl"));

  // Identity: fullName|signature|file — the same tuple joern-export.sc keys on.
  const keyOf = (m) => `${m.fullName}|${m.signature}|${rel(m.file)}`;

  // Some frontends (javasrc2cpg: constructors, overload/bridge pairs) emit
  // several method records with an IDENTICAL fullName|signature|file — one
  // logical method must become one symbol, so dedupe by key first, keeping the
  // record with the widest line span (the real body over a synthetic stub).
  const byKey = new Map();
  for (const m of methods) {
    const k = keyOf(m);
    const prev = byKey.get(k);
    if (!prev || (m.lineEnd ?? 0) - (m.lineStart ?? 0) > (prev.lineEnd ?? 0) - (prev.lineStart ?? 0)) {
      byKey.set(k, m);
    }
  }
  const uniqueMethods = [...byKey.values()];

  // Anchors: "<lang>:<relfile>#<name>(<sig>)"; same-file same-name-and-sig
  // duplicates that remain distinct (different fullName) get ~2, ~3 by line order.
  const byAnchorBase = new Map();
  for (const m of uniqueMethods) {
    const base = `${langOf(m.file)}:${rel(m.file)}#${m.name}(${m.signature})`;
    if (!byAnchorBase.has(base)) byAnchorBase.set(base, []);
    byAnchorBase.get(base).push(m);
  }
  const anchorByKey = new Map();
  for (const [base, list] of byAnchorBase) {
    list.sort((a, b) => (a.lineStart ?? 0) - (b.lineStart ?? 0));
    list.forEach((m, i) => anchorByKey.set(keyOf(m), i === 0 ? base : `${base}~${i + 1}`));
  }

  const symbols = [];
  const seenFiles = new Set();
  for (const m of uniqueMethods) {
    const file = rel(m.file);
    symbols.push({
      anchor: anchorByKey.get(keyOf(m)),
      lang: langOf(file),
      kind: "Function",
      name: m.name,
      file,
      line_start: m.lineStart ?? undefined,
      line_end: m.lineEnd ?? undefined,
      signature: m.signature || undefined,
      entry: m.name === "main" ? true : undefined,
      resolution: "cpg",
    });
    // Derive one File symbol per source file so emit gets stable heading ids.
    if (!seenFiles.has(file)) {
      seenFiles.add(file);
      symbols.push({
        anchor: `${langOf(file)}:${file}`,
        lang: langOf(file),
        kind: "File",
        name: file.split("/").pop(),
        file,
        resolution: "cpg",
      });
    }
  }

  const edges = [];
  for (const c of calls) {
    const from = anchorByKey.get(`${c.callerFullName}|${c.callerSignature}|${rel(c.callerFile)}`);
    if (!from) continue;
    const site = { file: rel(c.callerFile), line: c.line ?? 0 };
    const targets = (c.callees ?? [])
      .map((t) => anchorByKey.get(`${t.fullName}|${t.signature}|${rel(t.file)}`))
      .filter(Boolean);
    if (targets.length === 0) {
      edges.push({ kind: "calls", from, to_text: c.name, resolution: "cpg", confidence: "low", site });
    } else if (targets.length === 1) {
      edges.push({ kind: "calls", from, to: targets[0], resolution: "cpg", confidence: "high", site });
    } else {
      const [first, ...rest] = [...new Set(targets)].sort();
      edges.push({
        kind: "calls", from, to: first, resolution: "cpg", confidence: "medium",
        note: `dispatch, ${targets.length} candidates`, candidates: rest, site,
      });
    }
  }

  return { symbols, edges };
}
