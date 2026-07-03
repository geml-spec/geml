// geml-code-graph emit: exchange-format symbols/edges → the graph/ document tree of
// docs/DESIGN-geml-code-graph.md §5 — per-directory GEML documents (one block per
// symbol), mirrored backlink documents, index.geml, and name-lookup.json.
//
// Emission is deterministic (§6): stable sort orders everywhere, and a file is
// only written when its bytes changed — mtime is the "what was regenerated"
// signal the acceptance criteria observe.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, posix } from "node:path";

const esc = (s) => String(s).replace(/`/g, "'");
const linkText = (s) => esc(s).replace(/[\[\]]/g, "");
const attrVal = (s) => String(s).replace(/"/g, "'");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// Test territory (path conventions; same avowed heuristic as GEP-0002).
const TEST_DIR = /(^|\/)(test|tests|testing|__tests__|spec|specs)(\/|$)/i;
const TEST_FILE = /(^test_|^tests?\.|[._-]tests?\.|\.test\.|\.spec\.)/i;
const isTestPath = (p) => {
  p = String(p).replace(/\\/g, "/");
  return TEST_DIR.test(p) || TEST_FILE.test(p.slice(p.lastIndexOf("/") + 1));
};

const slugName = (name) => {
  let s = String(name).replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  if (!/^[A-Za-z]/.test(s)) s = "s" + s;
  return s;
};
const slugPath = (p) => (p === "" || p === "(root)" ? "root" : p.replace(/\//g, "--").replace(/[^A-Za-z0-9_.-]/g, "-"));
const dirOf = (rel) => { const i = rel.lastIndexOf("/"); return i < 0 ? "(root)" : rel.slice(0, i); };

export function emit({ symbols, edges, outDir, buildDir, repoName }) {
  // ---- ids: sym-<slug>-<hashN>, N=6 escalating to 10 on collision (§4.2) ----
  const idOf = new Map(); // anchor -> block id suffix owner
  {
    const byShort = new Map();
    for (const s of symbols) {
      const short = `${slugName(s.name)}-${sha(s.anchor).slice(0, 6)}`;
      if (!byShort.has(short)) byShort.set(short, []);
      byShort.get(short).push(s.anchor);
    }
    for (const [short, anchors] of byShort) {
      if (anchors.length === 1) idOf.set(anchors[0], short);
      else for (const a of anchors) idOf.set(a, `${short.slice(0, short.lastIndexOf("-"))}-${sha(a).slice(0, 10)}`);
    }
  }
  const symId = (a) => `sym-${idOf.get(a)}`;
  const blId = (a) => `bl-${idOf.get(a)}`;

  const byAnchor = new Map(symbols.map((s) => [s.anchor, s]));

  // ---- degrees: leaves need out-degree INCLUDING unresolved calls (§3.2) ----
  const outCalls = new Map(); // anchor -> count (resolved + unresolved)
  const inCallSites = new Map(); // anchor -> [resolved incoming call edges]
  for (const e of edges) {
    if (e.kind !== "calls") continue;
    outCalls.set(e.from, (outCalls.get(e.from) ?? 0) + 1);
    if (e.to !== undefined) {
      if (!inCallSites.has(e.to)) inCallSites.set(e.to, []);
      inCallSites.get(e.to).push(e);
    }
  }
  const isLeaf = (s) =>
    (s.kind === "Function" || s.kind === "Test") &&
    !(outCalls.get(s.anchor) > 0) && (inCallSites.get(s.anchor)?.length ?? 0) >= 1;

  // ---- partitions: (lang, dir) -> document ----
  const splitKey = (k) => { const i = k.indexOf(" "); return [k.slice(0, i), k.slice(i + 1)]; };
  const partKey = (s) => `${s.lang} ${dirOf(s.file)}`;
  const docOf = new Map(); // partKey -> doc path relative to outDir (posix)
  {
    const taken = new Set(["index.geml"]);
    for (const s of symbols) {
      const k = partKey(s);
      if (docOf.has(k)) continue;
      const base = `${s.lang}/${slugPath(dirOf(s.file))}`;
      let name = `${base}.geml`;
      for (let i = 2; taken.has(name); i++) name = `${base}-${i}.geml`;
      taken.add(name);
      docOf.set(k, name);
    }
  }
  const blDocOf = (k) => `_backlinks/${docOf.get(k)}`;
  const docOfAnchor = (a) => docOf.get(partKey(byAnchor.get(a)));
  const relRef = (fromDoc, toDoc) => posix.relative(posix.dirname(fromDoc), toDoc);

  // A reference to symbol `a` as seen from document `fromDoc` (§5.2).
  const refTo = (a, fromDoc) => {
    const toDoc = docOfAnchor(a);
    if (toDoc === fromDoc) return `[[#${symId(a)}]]`;
    return `[${linkText(byAnchor.get(a).name)}](${relRef(fromDoc, toDoc)}#${symId(a)})`;
  };

  // ---- edge lines per source symbol (§5.2 table) ----
  const RESOLUTION_DEFAULT = symbols.some((s) => s.resolution === "cpg") ? "cpg" : "heuristic";
  const outBySrc = new Map(); // anchor -> edges[]
  for (const e of edges) {
    if (!outBySrc.has(e.from)) outBySrc.set(e.from, []);
    outBySrc.get(e.from).push(e);
  }
  const KIND_ORDER = ["calls", "imports", "inherits", "tested-by", "references"];
  const edgeLines = (anchor, fromDoc) => {
    const list = outBySrc.get(anchor);
    if (!list) return [];
    const lines = [];
    for (const kind of KIND_ORDER) {
      const ofKind = list.filter((e) => e.kind === kind);
      if (!ofKind.length) continue;
      const isDefault = (e) => e.to !== undefined && e.resolution === RESOLUTION_DEFAULT
        && (e.confidence === "high" || e.confidence === "medium") && !e.candidates;
      // default tier: one aggregated line; calls additionally split off .leaf targets
      const agg = [...new Set(ofKind.filter(isDefault).map((e) => e.to))]
        .sort((x, y) => symId(x).localeCompare(symId(y)));
      const plain = kind === "calls" ? agg.filter((a) => !isLeaf(byAnchor.get(a))) : agg;
      const leafy = kind === "calls" ? agg.filter((a) => isLeaf(byAnchor.get(a))) : [];
      if (plain.length) lines.push(`${kind}: ${plain.map((a) => refTo(a, fromDoc)).join(" ")}`);
      if (leafy.length) lines.push(`calls-leaf: ${leafy.map((a) => refTo(a, fromDoc)).join(" ")}`);
      // exception tier: one list item per edge, annotation spelled out
      const odd = ofKind.filter((e) => e.to !== undefined && !isDefault(e))
        .sort((x, y) => symId(x.to).localeCompare(symId(y.to)));
      for (const e of odd) {
        const ann = [e.resolution !== RESOLUTION_DEFAULT ? e.resolution : null, e.confidence]
          .filter(Boolean).join(", ");
        const note = e.note ? ` — ${esc(e.note)}` : "";
        const cand = e.candidates?.length
          ? ` candidates: ${e.candidates.map((a) => refTo(a, fromDoc)).join(" ")}` : "";
        lines.push(`- ${kind} ${refTo(e.to, fromDoc)} (${ann}${note})${cand}`);
      }
      // unresolved tier: plain code spans, never references (§5.2)
      const unres = [...new Set(ofKind.filter((e) => e.to === undefined && e.to_text).map((e) => e.to_text))].sort();
      if (unres.length) lines.push(`${kind}-unresolved: ${unres.map((t) => `\`${esc(t)}\``).join(" ")}`);
    }
    const inn = inCallSites.get(anchor)?.length ?? 0;
    if (inn) {
      const k = partKey(byAnchor.get(anchor));
      lines.push(`called-by: [${inn} 个调用点](${relRef(fromDoc, blDocOf(k))}#${blId(anchor)})`);
    }
    return lines;
  };

  // ---- group symbols per partition, per file ----
  const parts = new Map(); // partKey -> Map(file -> {fileSym, members[]})
  for (const s of symbols) {
    const k = partKey(s);
    if (!parts.has(k)) parts.set(k, new Map());
    const files = parts.get(k);
    if (!files.has(s.file)) files.set(s.file, { fileSym: undefined, members: [] });
    const slot = files.get(s.file);
    if (s.kind === "File") slot.fileSym = s;
    else slot.members.push(s);
  }

  // ---- write helper: deterministic, only-on-change ----
  const stats = { docs: 0, written: 0, bytes: 0 };
  const allDocs = [];      // every emitted .geml (written or unchanged), outDir-relative
  const writtenDocs = [];  // the subset actually (re)written this build
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

  const classesOf = (s) =>
    `.${s.kind}${s.entry ? " .entry" : ""}${s.flow_crit ? " .flow-entry" : ""}`
    + `${isTestPath(s.file) ? " .test" : ""}${isLeaf(s) ? " .leaf" : ""}`;
  const blockFor = (s, fromDoc) => {
    const attrs = [`#${symId(s.anchor)}`, classesOf(s), `anchor="${attrVal(s.anchor)}"`, `file="${attrVal(s.file)}"`];
    if (s.line_start !== undefined) attrs.push(`lines="${s.line_start}-${s.line_end ?? s.line_start}"`);
    const head = s.signature && s.signature !== s.name
      ? `\`${esc(s.name)}\` — \`${esc(s.signature)}\``
      : `\`${esc(s.name)}\``;
    const body = [head, ...edgeLines(s.anchor, fromDoc)];
    return `=== note {${attrs.join(" ")}}\n${body.join("\n")}\n===\n`;
  };

  // ---- forward documents ----
  const indexRows = [];
  for (const [k, files] of [...parts.entries()].sort((a, b) => docOf.get(a[0]).localeCompare(docOf.get(b[0])))) {
    const doc = docOf.get(k);
    const [lang, dir] = splitKey(k);
    const all = [...files.values()].flatMap((f) => [...(f.fileSym ? [f.fileSym] : []), ...f.members]);
    const testCount = all.filter((s) => isTestPath(s.file)).length;
    const chunks = [
      "=== meta\n"
      + `graph-of = "${attrVal(repoName)}"\npartition = "${attrVal(dir)}"\nlang = "${attrVal(lang)}"\n`
      + `nodes = ${all.length}\n${testCount ? `tests = ${testCount}\n` : ""}`
      + `resolution-default = "${RESOLUTION_DEFAULT}"\n===\n`,
      `# ${esc(dir)}\n`,
    ];
    const entries = all.filter((s) => s.entry).sort((a, b) => a.file.localeCompare(b.file));
    if (entries.length) {
      chunks.push(`Entry points: ${entries.map((s) =>
        `[main — ${linkText(s.file.split("/").pop())}](#${symId(s.anchor)})`).join(" · ")}\n`);
    }
    for (const [file, { fileSym, members }] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const base = file.split("/").pop();
      chunks.push(fileSym ? `## ${esc(base)} {#${symId(fileSym.anchor)}}\n` : `## ${esc(base)}\n`);
      if (fileSym) {
        const fl = edgeLines(fileSym.anchor, doc);
        if (fl.length) chunks.push(fl.join("\n") + "\n");
      }
      members.sort((a, b) => (a.line_start ?? 0) - (b.line_start ?? 0) || a.anchor.localeCompare(b.anchor));
      for (const s of members) chunks.push(blockFor(s, doc));
    }
    writeIfChanged(doc, chunks.join("\n"));
    indexRows.push({ doc, lang, dir, nodes: all.length, testCount });
  }

  // ---- backlink documents (§5.3) ----
  let backlinkDocs = 0;
  const blParts = new Map(); // partKey -> [target symbols with in-calls]
  for (const [target] of inCallSites) {
    const s = byAnchor.get(target);
    if (!s) continue;
    const k = partKey(s);
    if (!blParts.has(k)) blParts.set(k, []);
    blParts.get(k).push(s);
  }
  for (const [k, targets] of [...blParts.entries()].sort((a, b) => blDocOf(a[0]).localeCompare(blDocOf(b[0])))) {
    const doc = blDocOf(k);
    const [lang, dir] = splitKey(k);
    const chunks = [
      "=== meta\n"
      + `graph-of = "${attrVal(repoName)}"\nkind = "backlinks"\npartition = "${attrVal(dir)}"\nlang = "${attrVal(lang)}"\n`
      + `symbols = ${targets.length}\n===\n`,
      `# Called by — ${esc(dir)}\n`,
    ];
    targets.sort((a, b) => symId(a.anchor).localeCompare(symId(b.anchor)));
    for (const t of targets) {
      const sites = [...inCallSites.get(t.anchor)]
        .sort((x, y) => (x.site?.file ?? "").localeCompare(y.site?.file ?? "") || (x.site?.line ?? 0) - (y.site?.line ?? 0) || x.from.localeCompare(y.from));
      const items = sites.map((e) => {
        const caller = byAnchor.get(e.from);
        const where = e.site ? ` — ${esc(e.site.file)}:${e.site.line}` : "";
        const ann = e.confidence !== "medium" && e.confidence !== "high" ? ` (${e.confidence})` : "";
        return `- ${refTo(e.from, doc)}${where}${ann}` + (caller ? "" : "");
      });
      chunks.push(
        `=== note {#${blId(t.anchor)} .backlinks anchor="${attrVal(t.anchor)}"}\n`
        + `\`${esc(t.name)}\` 的调用方(${sites.length}):\n${items.join("\n")}\n===\n`,
      );
    }
    writeIfChanged(doc, chunks.join("\n"));
    backlinkDocs++;
  }

  // ---- name-lookup (§5.4) ----
  const lookup = new Map(); // Map, not {}: symbol names like "constructor" collide with Object.prototype
  for (const s of symbols) {
    if (s.kind === "File") continue;
    if (!lookup.has(s.name)) lookup.set(s.name, []);
    lookup.get(s.name).push({ anchor: s.anchor, doc: docOfAnchor(s.anchor), id: symId(s.anchor) });
  }
  const sortedLookup = {};
  for (const name of [...lookup.keys()].sort()) {
    sortedLookup[name] = lookup.get(name).sort((a, b) => a.anchor.localeCompare(b.anchor));
  }
  writeIfChanged("_index/name-lookup.json", JSON.stringify(sortedLookup, null, 2) + "\n");

  // ---- index.geml ----
  const CAP = 6;
  const groupMains = (list) => {
    const byDoc = new Map();
    for (const s of list) {
      const d = docOfAnchor(s.anchor);
      if (!byDoc.has(d)) byDoc.set(d, []);
      byDoc.get(d).push(s);
    }
    return [...byDoc.entries()]
      .sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]))
      .map(([d, ss]) => {
        const dir = dirOf(ss[0].file);
        const shown = ss.sort((a, b) => a.file.localeCompare(b.file)).slice(0, CAP)
          .map((s) => `[${linkText(s.file.split("/").pop())}](${d}#${symId(s.anchor)})`).join(" · ");
        const more = ss.length > CAP ? ` · +${ss.length - CAP} more in [${linkText(dir)}](${d})` : "";
        return `- **${linkText(dir)}**: ${shown}${more}`;
      });
  };
  const allEntries = symbols.filter((s) => s.entry);
  const srcMains = allEntries.filter((s) => !isTestPath(s.file));
  const testMains = allEntries.filter((s) => isTestPath(s.file));
  const crit = symbols.filter((s) => s.flow_crit).sort((a, b) => b.flow_crit - a.flow_crit).slice(0, 10);
  const partRow = (r) => `- [${linkText(`${r.lang}/${r.dir}`)}](${r.doc}) — ${r.nodes} nodes`
    + (r.testCount && r.testCount < r.nodes ? ` (${r.testCount} test)` : "");
  const srcParts = indexRows.filter((r) => r.testCount / r.nodes < 0.5).sort((a, b) => b.nodes - a.nodes);
  const testParts = indexRows.filter((r) => r.testCount / r.nodes >= 0.5).sort((a, b) => b.nodes - a.nodes);
  const index = [
    "=== meta\n"
    + `graph-of = "${attrVal(repoName)}"\nkind = "geml-code-graph-index"\ndocuments = ${indexRows.length}\n`
    + `symbols = ${symbols.length}\nresolution-default = "${RESOLUTION_DEFAULT}"\n===\n`,
    `# Call-graph navigation — ${esc(repoName)}\n`,
    "One document per source directory, one block per symbol. Edges are checked\n"
    + "references (`calls:` lines; suspicious edges expanded with confidence;\n"
    + "`calls-unresolved:` lists what the extractor could not resolve). Reverse\n"
    + "navigation lives in `_backlinks/` (each symbol's `called-by:` line points\n"
    + "at its backlink block); name lookup in `_index/name-lookup.json`. Classes:\n"
    + "`.entry` `.flow-entry` `.Test` `.test` `.leaf`.\n",
    ...(srcMains.length ? ["## Program entry points (`main`)\n", ...groupMains(srcMains), ""] : []),
    ...(testMains.length ? ["## Test entry points (`main`)\n", ...groupMains(testMains), ""] : []),
    ...(crit.length ? ["## Critical flow entries\n", ...crit.map((s) =>
      `- ${refTo(s.anchor, "index.geml")} — criticality ${s.flow_crit} — ${linkText(s.file)}`), ""] : []),
    ...(srcParts.length ? ["## Partitions — source\n", ...srcParts.map(partRow), ""] : []),
    ...(testParts.length ? ["## Partitions — tests\n", ...testParts.map(partRow), ""] : []),
  ].join("\n");
  writeIfChanged("index.geml", index);

  // ---- edges-manifest (internal, P2 groundwork §7) ----
  if (buildDir) {
    const manifest = {};
    for (const a of [...outBySrc.keys()].sort()) {
      manifest[a] = outBySrc.get(a)
        .map((e) => ({ kind: e.kind, ...(e.to !== undefined ? { to: e.to } : { to_text: e.to_text }), confidence: e.confidence }))
        .sort((x, y) => (x.kind + (x.to ?? x.to_text)).localeCompare(y.kind + (y.to ?? y.to_text)));
    }
    mkdirSync(buildDir, { recursive: true });
    const p = join(buildDir, "edges-manifest.json");
    const content = JSON.stringify(manifest, null, 1) + "\n";
    if (!existsSync(p) || readFileSync(p, "utf8") !== content) writeFileSync(p, content);
  }

  return {
    ...stats,
    backlinkDocs,
    symbols: symbols.length,
    edges: edges.length,
    resolved: edges.filter((e) => e.to !== undefined).length,
    allDocs,
    writtenDocs,
    leaves: symbols.filter((s) => isLeaf(s)).length,
  };
}
