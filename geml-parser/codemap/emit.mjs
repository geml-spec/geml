// geml-code-graph emit — exchange-format symbols/edges → the codemap document
// tree of docs/DESIGN-codemap-delta.md (§4–6) / docs/codemap-profile.md:
//   one .geml per container (module|dir|file), each with EXACTLY ONE meta
//   (module/src/entry/resolution-default), empty-body `code` blocks per method
//   (src=path#Lx-y, anchor=; symbol-level classes .leaf/.test), and up to three
//   CSV edge tables: #calls (out), #called-by (in, aggregated), #unresolved
//   (blind spots, hidden). Plus index.geml (aggregates) and name-lookup.json.
//
// Generated documents are PURE DATA: no diagram blocks (a codemap-aware
// renderer offers the layered-flow view; embedding elsewhere uses
// `=== diagram {format=geml-code-graph src=…}`).
//
// Emission is deterministic: stable sort orders everywhere; a file is only
// written when its bytes changed (mtime = "what a change touched").
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { buildNormalizer } from "./normalize.mjs";

const esc = (s) => String(s).replace(/`/g, "'");
const attrVal = (s) => String(s).replace(/"/g, "'");
// Plain-text cells: no commas/newlines (CSV), and no square brackets — table
// cells are inline-parsed, so `f[i](&x)` would otherwise read as a LINK with an
// unresolvable target. Brackets become parens: still readable, never markup.
const csvCell = (s) => String(s).replace(/[,\r\n]/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").trim();
const sha6 = (s, len = 6) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, len);

// Test territory (path conventions; the avowed heuristic of GEP-0002).
const TEST_DIR = /(^|\/)(test|tests|testing|__tests__|spec|specs)(\/|$)/i;
const TEST_FILE = /(^test_|^tests?\.|[._-]tests?\.|\.test\.|\.spec\.)/i;
const isTestPath = (p) => {
  p = String(p).replace(/\\/g, "/");
  return TEST_DIR.test(p) || TEST_FILE.test(p.slice(p.lastIndexOf("/") + 1));
};

const slugName = (name) => {
  let s = String(name).replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  if (!/^[A-Za-z]/.test(s)) s = "s" + s;
  return s;
};
const slugPath = (p) => (p === "" || p === "(root)" ? "root" : p.replace(/\//g, "--").replace(/[^A-Za-z0-9_.-]/g, "-"));
const dirOf = (rel) => { const i = rel.lastIndexOf("/"); return i < 0 ? "(root)" : rel.slice(0, i); };
const topOf = (rel) => { const i = rel.indexOf("/"); return i < 0 ? "(root)" : rel.slice(0, i); };

export function emit({ symbols, edges, outDir, buildDir, repoName, container = "dir", commit, root }) {
  const byAnchor = new Map(symbols.map((s) => [s.anchor, s]));
  const methods = symbols.filter((s) => s.kind === "Function" || s.kind === "Test");
  const files = symbols.filter((s) => s.kind === "File");

  // ---- containers ----
  const containerOf = (s) =>
    container === "file" ? s.file : container === "module" ? topOf(s.file) : dirOf(s.file);
  // Display-path normalisation: strip each module's shared ceremony prefix so
  // `module=`/doc names read as the real structure. Applies in every container
  // mode (dir and file) — a file-mode container path carries the same source
  // roots (geml-parser/src/render.ts -> geml-parser/render.ts). Grouping still
  // keys on the TRUE path (containerOf) and `src=` stays the true path — only
  // the displayed module path shortens. root may be absent (older callers / crg
  // tier): then displayOf is the identity.
  const normMap = root ? buildNormalizer(root, methods.map(containerOf), { repoName, fileMode: container === "file" }) : new Map();
  const displayOf = (name) => normMap.get(name) ?? name;
  const containers = new Map(); // name -> { docName, methods[], files[] }
  const taken = new Set(["index.geml"]);
  const containerFor = (name) => {
    if (!containers.has(name)) {
      let doc = `${slugPath(displayOf(name))}.geml`;
      for (let i = 2; taken.has(doc); i++) doc = `${slugPath(displayOf(name))}-${i}.geml`;
      taken.add(doc);
      containers.set(name, { docName: doc, methods: [], files: [] });
    }
    return containers.get(name);
  };
  for (const s of methods) containerFor(containerOf(s)).methods.push(s);
  for (const s of files) {
    const c = containers.get(containerOf(s));
    if (c) c.files.push(s); // only files that actually host methods
  }
  const docOfAnchor = new Map();
  for (const [name, c] of containers) {
    for (const s of [...c.methods, ...c.files]) docOfAnchor.set(s.anchor, c.docName);
  }

  // ---- block ids: short name when unique in its doc, else name-<sha6(anchor)> ----
  const idOf = new Map(); // anchor -> id
  for (const [, c] of containers) {
    const byName = new Map();
    for (const s of [...c.methods, ...c.files]) {
      const base = slugName(s.name);
      if (!byName.has(base)) byName.set(base, []);
      byName.get(base).push(s);
    }
    for (const [base, list] of byName) {
      if (list.length === 1) { idOf.set(list[0].anchor, base); continue; }
      // Escalate hash length only when the default 6 hex chars actually collide
      // within this name group — keeps ids short in the common case.
      let len = 6;
      let ids;
      for (;;) {
        ids = list.map((s) => `${base}-${sha6(s.anchor, len)}`);
        if (new Set(ids).size === ids.length) break;
        // sha256 hex is 64 chars — beyond that only IDENTICAL anchors can
        // still collide, which is a caller bug (build.mjs dedupes anchors):
        // fail loudly instead of escalating forever.
        if (len >= 64) throw new Error(`emit: duplicate anchors in name group "${base}" — anchors must be unique`);
        len += 2;
      }
      list.forEach((s, i) => idOf.set(s.anchor, ids[i]));
    }
  }

  // ---- edges (stage A: the `calls` relation only) ----
  const calls = edges.filter((e) => e.kind === "calls");
  const outCalls = new Map();   // anchor -> total outgoing (incl. unresolved) — leaf rule
  const inBySym = new Map();    // target anchor -> [{fromAnchor, kind, site, confidence}]
  const outBySym = new Map();   // source anchor -> [{toAnchor, kind, confidence}] resolved
  const unresBySym = new Map(); // source anchor -> Set(to_text)
  const addIn = (target, rec) => {
    if (!byAnchor.has(target)) return;
    if (!inBySym.has(target)) inBySym.set(target, []);
    inBySym.get(target).push(rec);
  };
  for (const e of calls) {
    if (!docOfAnchor.has(e.from)) continue;
    outCalls.set(e.from, (outCalls.get(e.from) ?? 0) + 1);
    if (e.to !== undefined && docOfAnchor.has(e.to)) {
      if (!outBySym.has(e.from)) outBySym.set(e.from, []);
      const conf = e.confidence === "high" || !e.confidence ? "" : e.confidence;
      outBySym.get(e.from).push({ to: e.to, kind: "call", confidence: conf });
      addIn(e.to, { from: e.from, kind: "call", site: e.site, confidence: conf });
      for (const c of e.candidates ?? []) {
        if (!docOfAnchor.has(c)) continue;
        outBySym.get(e.from).push({ to: c, kind: "candidate", confidence: "" });
        addIn(c, { from: e.from, kind: "candidate", site: e.site, confidence: "" });
      }
    } else if (e.to_text) {
      if (!unresBySym.has(e.from)) unresBySym.set(e.from, new Set());
      unresBySym.get(e.from).add(e.to_text);
    }
  }
  const isLeaf = (s) =>
    (s.kind === "Function" || s.kind === "Test") &&
    !(outCalls.get(s.anchor) > 0) && (inBySym.get(s.anchor)?.length ?? 0) >= 1;
  // Bean-style accessors that also call nothing: pure noise in a flow view.
  // Marked so renderers can hide them by default; the edge tables keep them.
  const isAccessor = (s) => isLeaf(s) && /^(get|set|is)(?![a-z])/.test(s.name);

  // ---- entry: called from outside its container, or an app entry (main) ----
  const isEntry = (s) => {
    if (s.entry) return true;
    const doc = docOfAnchor.get(s.anchor);
    return (inBySym.get(s.anchor) ?? []).some((r) => docOfAnchor.get(r.from) !== doc);
  };

  // A reference to `anchor` as seen from `fromDoc`.
  const refTo = (anchor, fromDoc) => {
    const doc = docOfAnchor.get(anchor);
    const id = idOf.get(anchor);
    return doc === fromDoc ? `#${id}` : `${posix.relative(posix.dirname(fromDoc), doc)}#${id}`;
  };

  // ---- write helper: deterministic, only-on-change ----
  const stats = { docs: 0, written: 0, bytes: 0 };
  const allDocs = [];
  const writtenDocs = [];
  const writeIfChanged = (relPath, content) => {
    const p = join(outDir, relPath);
    mkdirSync(dirname(p), { recursive: true });
    stats.docs++;
    stats.bytes += content.length;
    if (relPath.endsWith(".geml")) allDocs.push(relPath);
    if (existsSync(p) && readFileSync(p, "utf8") === content) return false;
    writeFileSync(p, content);
    stats.written++;
    if (relPath.endsWith(".geml")) writtenDocs.push(relPath);
    return true;
  };

  const RESOLUTION_DEFAULT = symbols.some((s) => s.resolution === "cpg") ? "cpg" : "heuristic";
  const csv = (id, columns, rows, extraAttrs = "") => {
    if (!rows.length) return null; // empty tables are not generated
    // Column width by loop, not Math.max(...spread) — a spread call over a
    // repo-scale table's rows blows the argument limit (same failure class
    // as the build.mjs merge).
    const widths = columns.map((c, i) => {
      let w = c.length;
      for (const r of rows) { const l = String(r[i] ?? "").length; if (l > w) w = l; }
      return w;
    });
    const line = (cells) => cells.map((v, i) =>
      i === cells.length - 1 ? String(v ?? "") : (String(v ?? "") + ",").padEnd(widths[i] + 2)).join("").replace(/\s+$/, "");
    return `=== table {#${id} format=csv${extraAttrs}}\n${line(columns)}\n${rows.map(line).join("\n")}\n===\n`;
  };

  // ---- container documents ----
  const indexRows = [];
  const appEntries = [];
  for (const [name, c] of [...containers.entries()].sort((a, b) => a[1].docName.localeCompare(b[1].docName))) {
    const doc = c.docName;
    c.methods.sort((a, b) => a.file.localeCompare(b.file) || (a.line_start ?? 0) - (b.line_start ?? 0) || a.anchor.localeCompare(b.anchor));

    const entries = c.methods.filter(isEntry);
    for (const s of c.methods) if (s.entry) appEntries.push(s.anchor);
    const testCount = c.methods.filter((s) => isTestPath(s.file)).length;
    // src= = the TRUE source directory (real path, for locating code); module=
    // and the heading = the normalised DISPLAY path (ceremony stripped).
    const srcDir = container === "file" ? name : name === "(root)" ? "" : `${name}/`;
    const disp = displayOf(name);
    const dispLabel = disp === "(root)" ? "root" : disp;

    const chunks = [
      "=== meta\n"
      + `module = ${csvCell(dispLabel)}\n`
      + (srcDir ? `src = ${csvCell(srcDir)}\n` : "")
      + (entries.length ? `entry = ${entries.map((s) => `#${idOf.get(s.anchor)}`).join(" ")}\n` : "")
      + `resolution-default = ${RESOLUTION_DEFAULT}\n===\n`,
      `# ${esc(dispLabel)}\n`,
    ];

    // method blocks, grouped under a `##` file heading when the container spans
    // several files (containment = document structure)
    const byFile = new Map();
    for (const s of c.methods) {
      if (!byFile.has(s.file)) byFile.set(s.file, []);
      byFile.get(s.file).push(s);
    }
    const multiFile = byFile.size > 1;
    const fileSymByPath = new Map(c.files.map((f) => [f.file, f]));
    for (const [file, list] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (multiFile) {
        const fileSym = fileSymByPath.get(file);
        const base = file.split("/").pop();
        chunks.push(fileSym ? `## ${esc(base)} {#${idOf.get(fileSym.anchor)}}\n` : `## ${esc(base)}\n`);
      }
      for (const s of list) {
        const cls = `${isTestPath(s.file) ? " .test" : ""}${isLeaf(s) ? " .leaf" : ""}${isAccessor(s) ? " .accessor" : ""}${s.flow_crit ? " .flow-entry" : ""}`;
        const src = `${s.file}${s.line_start !== undefined ? `#L${s.line_start}-${s.line_end ?? s.line_start}` : ""}`;
        // The display name rides along whenever id sanitisation changed it
        // ("RenderCtx.block" -> id RenderCtx-block): renderers label nodes
        // with the real name, ids stay reference-grammar clean.
        const id = idOf.get(s.anchor);
        const nameAttr = s.name !== id ? ` name="${attrVal(s.name)}"` : "";
        chunks.push(`=== code {#${id}${cls}${nameAttr} src=${attrVal(src)} anchor="${attrVal(s.anchor)}"}\n===\n`);
      }
    }

    // #calls
    const callRows = [];
    for (const s of c.methods) {
      for (const r of (outBySym.get(s.anchor) ?? [])
        .sort((x, y) => (x.kind === y.kind ? refTo(x.to, doc).localeCompare(refTo(y.to, doc)) : 0))) {
        callRows.push([`#${idOf.get(s.anchor)}`, refTo(r.to, doc), r.kind, r.confidence]);
      }
    }
    const callsTable = csv("calls", ["from", "to", "kind", "confidence"], callRows);
    if (callsTable) chunks.push(callsTable);

    // #called-by (aggregated in-edges)
    const inRows = [];
    for (const s of c.methods) {
      const recs = (inBySym.get(s.anchor) ?? [])
        .sort((x, y) => (x.site?.file ?? "").localeCompare(y.site?.file ?? "") || (x.site?.line ?? 0) - (y.site?.line ?? 0) || x.from.localeCompare(y.from));
      for (const r of recs) {
        const site = r.site ? `${r.site.file}:${r.site.line}` : "";
        inRows.push([refTo(r.from, doc), `#${idOf.get(s.anchor)}`, r.kind, csvCell(site)]);
      }
    }
    const inTable = csv("called-by", ["from", "to", "kind", "site"], inRows);
    if (inTable) chunks.push(inTable);

    // #unresolved (hidden)
    const unRows = [];
    for (const s of c.methods) {
      for (const t of [...(unresBySym.get(s.anchor) ?? [])].sort()) {
        unRows.push([`#${idOf.get(s.anchor)}`, csvCell(t)]);
      }
    }
    const unTable = csv("unresolved", ["from", "to"], unRows, " hidden");
    if (unTable) chunks.push(unTable);

    writeIfChanged(doc, chunks.join("\n"));
    indexRows.push({ module: dispLabel, doc, methods: c.methods.length, entries: entries.length, tests: testCount });
  }

  // ---- index.geml ----
  appEntries.sort((a, b) => docOfAnchor.get(a).localeCompare(docOfAnchor.get(b)) || a.localeCompare(b));
  const moduleEdges = new Map(); // "fromDoc toDoc" -> count (cross-container resolved calls)
  for (const [from, recs] of outBySym) {
    const fd = docOfAnchor.get(from);
    for (const r of recs) {
      if (r.kind !== "call") continue;
      const td = docOfAnchor.get(r.to);
      if (fd === td) continue;
      const key = `${fd} ${td}`;
      moduleEdges.set(key, (moduleEdges.get(key) ?? 0) + 1);
    }
  }
  const modName = (doc) => indexRows.find((r) => r.doc === doc)?.module ?? doc;
  const index = [
    "=== meta\n"
    + `repo = ${csvCell(repoName)}\n`
    + (commit ? `commit = ${csvCell(commit)}\n` : "")
    + `container = ${container}\n`
    + (appEntries.length ? `entry = ${appEntries.map((a) => `${docOfAnchor.get(a)}#${idOf.get(a)}`).join(" ")}\n` : "")
    + `resolution-default = ${RESOLUTION_DEFAULT}\n===\n`,
    `# Code map — ${esc(repoName)}\n`,
    csv("modules", ["module", "doc", "methods", "entries", "tests"],
      indexRows.sort((a, b) => b.methods - a.methods)
        .map((r) => [csvCell(r.module), r.doc, r.methods, r.entries, r.tests])) ?? "",
    csv("module-edges", ["from", "to", "calls"],
      [...moduleEdges.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, n]) => { const [fd, td] = k.split(" "); return [csvCell(modName(fd)), csvCell(modName(td)), n]; })) ?? "",
  ].filter(Boolean).join("\n");
  writeIfChanged("index.geml", index);

  // ---- name-lookup ----
  // Class-qualified names ("Cls.method") are ALSO findable by the bare member
  // name — an agent asking "who is handleLogin" should not need to know the
  // class first; ambiguity across classes is intrinsic and the lookup already
  // answers with every candidate.
  const lookup = new Map();
  const addLookup = (name, s) => {
    if (!lookup.has(name)) lookup.set(name, []);
    lookup.get(name).push({ anchor: s.anchor, doc: docOfAnchor.get(s.anchor), id: idOf.get(s.anchor) });
  };
  for (const s of methods) {
    addLookup(s.name, s);
    const dot = s.name.indexOf(".");
    if (dot > 0 && dot < s.name.length - 1) addLookup(s.name.slice(dot + 1), s);
  }
  const sortedLookup = {};
  for (const name of [...lookup.keys()].sort()) {
    sortedLookup[name] = lookup.get(name).sort((a, b) => a.anchor.localeCompare(b.anchor));
  }
  writeIfChanged("_index/name-lookup.json", JSON.stringify(sortedLookup, null, 2) + "\n");

  // ---- edges-manifest (internal) ----
  if (buildDir) {
    const manifest = {};
    for (const a of [...outBySym.keys()].sort()) {
      manifest[a] = outBySym.get(a).map((r) => ({ kind: r.kind, to: r.to }))
        .sort((x, y) => (x.kind + x.to).localeCompare(y.kind + y.to));
    }
    mkdirSync(buildDir, { recursive: true });
    const p = join(buildDir, "edges-manifest.json");
    const content = JSON.stringify(manifest, null, 1) + "\n";
    if (!existsSync(p) || readFileSync(p, "utf8") !== content) writeFileSync(p, content);
  }

  return {
    ...stats,
    allDocs,
    writtenDocs,
    containers: containers.size,
    symbols: symbols.length,
    methods: methods.length,
    edges: edges.length,
    resolved: calls.filter((e) => e.to !== undefined && docOfAnchor.has(e.to)).length,
    leaves: methods.filter((s) => isLeaf(s)).length,
    entries: appEntries.length,
  };
}
