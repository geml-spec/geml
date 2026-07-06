// geml-code-graph adapter: SCIP index (index.scip, protobuf) → exchange format.
//
// Reads the protobuf DIRECTLY with a minimal embedded wire-format reader — the
// scip CLI ships no Windows binary, and the fields we need are few. Everything
// here is compiler-grade resolution, so edges are resolution:"cpg"; a direct
// hit is confidence:"high"; a call to an interface/abstract member with known
// implementations becomes medium + candidates; references to symbols not
// defined in the project become to_text (unresolved, low).
//
// Produce the index with scip-typescript (TS/JS):
//   npx --yes @sourcegraph/scip-typescript index --output index.scip
//
// Caller attribution: a reference occurrence belongs to the innermost function
// DEFINITION whose enclosing_range contains it. scip-typescript emits
// enclosing_range on definition occurrences; if absent we fall back to "the
// nearest preceding definition in the file" and mark the adapter degraded.
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// ---- minimal protobuf wire reader ------------------------------------------
function varint(buf, p) {
  let x = 0n, s = 0n, b;
  do { b = buf[p.i++]; x |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80);
  return x;
}
// Iterate fields of one message region [start, end): yields {no, wt, val|sub}.
function* fields(buf, start, end) {
  const p = { i: start };
  while (p.i < end) {
    const key = Number(varint(buf, p));
    const no = key >> 3, wt = key & 7;
    if (wt === 0) yield { no, wt, val: varint(buf, p) };
    else if (wt === 1) { yield { no, wt, val: buf.readBigUInt64LE(p.i) }; p.i += 8; }
    else if (wt === 2) { const len = Number(varint(buf, p)); yield { no, wt, a: p.i, b: p.i + len }; p.i += len; }
    else if (wt === 5) { yield { no, wt, val: BigInt(buf.readUInt32LE(p.i)) }; p.i += 4; }
    else throw new Error(`scip: unsupported wire type ${wt}`);
  }
}
const str = (buf, f) => buf.toString("utf8", f.a, f.b);
// repeated int32, packed (len-delimited varints) or single varint value
function packedInts(buf, f, out) {
  if (f.wt === 0) { out.push(Number(f.val)); return; }
  const p = { i: f.a };
  while (p.i < f.b) out.push(Number(varint(buf, p)));
}

// ---- SCIP field numbers (scip.proto) ---------------------------------------
// Index: metadata=1, documents=2, external_symbols=3
// Document: relative_path=1, occurrences=2, symbols=3, language=4
// Occurrence: range=1, symbol=2, symbol_roles=3, enclosing_range=7
// SymbolInformation: symbol=1, relationships=4, display_name=6
// Relationship: symbol=1, is_implementation=3
const ROLE_DEFINITION = 0x1;

function parseScip(path) {
  const buf = readFileSync(path);
  const docs = [];
  let projectRoot = "";
  for (const f of fields(buf, 0, buf.length)) {
    if (f.no === 1 && f.wt === 2) {
      // Metadata → project_root (field 3): the directory the indexer ran in.
      // Needed to re-anchor document paths when a SUBPROJECT of the repo was
      // indexed (scip paths are relative to the indexed project, not the repo).
      for (const m of fields(buf, f.a, f.b)) {
        if (m.no === 3 && m.wt === 2) projectRoot = str(buf, m);
      }
      continue;
    }
    if (f.no !== 2 || f.wt !== 2) continue;
    const doc = { path: "", occ: [], rel: [] };
    for (const d of fields(buf, f.a, f.b)) {
      if (d.no === 1 && d.wt === 2) doc.path = str(buf, d);
      else if (d.no === 2 && d.wt === 2) {
        const o = { range: [], symbol: "", roles: 0, enclosing: [] };
        for (const x of fields(buf, d.a, d.b)) {
          if (x.no === 1) packedInts(buf, x, o.range);
          else if (x.no === 2 && x.wt === 2) o.symbol = str(buf, x);
          else if (x.no === 3 && x.wt === 0) o.roles = Number(x.val);
          else if (x.no === 7) packedInts(buf, x, o.enclosing);
        }
        doc.occ.push(o);
      } else if (d.no === 3 && d.wt === 2) {
        // SymbolInformation → implementation relationships only
        let sym = "";
        const impl = [];
        for (const x of fields(buf, d.a, d.b)) {
          if (x.no === 1 && x.wt === 2) sym = str(buf, x);
          else if (x.no === 4 && x.wt === 2) {
            let rsym = "", isImpl = false;
            for (const r of fields(buf, x.a, x.b)) {
              if (r.no === 1 && r.wt === 2) rsym = str(buf, r);
              else if (r.no === 3 && r.wt === 0) isImpl = r.val !== 0n;
            }
            if (isImpl && rsym) impl.push(rsym);
          }
        }
        if (impl.length) doc.rel.push({ sym, impl });
      }
    }
    docs.push(doc);
  }
  return { docs, projectRoot };
}

// ---- SCIP symbol grammar helpers -------------------------------------------
// e.g. "scip-typescript npm @geml/geml 1.0.0 src/`geml.ts`/parse()."
const isFuncSym = (s) => s.endsWith("().");
const nameOf = (s) => {
  // "`<constructor>`()." reads as noise — name the constructor after its
  // class (the symbol segment before the member: …/RenderCtx#`<constructor>`().)
  if (/`?<constructor>`?\(\)\.$/.test(s)) {
    const cm = /([A-Za-z0-9_$]+)#`?<constructor>`?\(\)\.$/.exec(s);
    return cm ? `${cm[1]}()` : "constructor()";
  }
  const m = /([^\/#.`]+)\(\)\.$/.exec(s);
  return m ? m[1] : s.split("/").pop() ?? s;
};

export function extract({ raw: scipPath, root }) {
  const { docs, projectRoot } = parseScip(scipPath);
  // scip-typescript emits OS-native separators in relative_path on Windows;
  // the codemap profile is posix throughout.
  for (const d of docs) d.path = d.path.replace(/\\/g, "/");
  // Document paths are relative to the INDEXED project (metadata.project_root),
  // which may be a subdirectory of the codemap's --root. Re-anchor them so a
  // multi-language merge keeps one coherent repo-relative path space.
  if (projectRoot && root) {
    const norm = (p) => p.replace(/^file:\/\/\/?/, "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const rootN = norm(resolvePath(root));
    const projN = norm(decodeURIComponent(projectRoot));
    if (projN !== rootN && projN.startsWith(rootN + "/")) {
      const prefix = decodeURIComponent(projectRoot).replace(/^file:\/\/\/?/, "").replace(/\\/g, "/").replace(/\/+$/, "").slice(rootN.length + 1);
      for (const d of docs) d.path = `${prefix}/${d.path}`;
    }
  }

  // range = [startLine, startChar, endLine(, endChar)] (0-based); normalize.
  const spanOf = (r) => (r.length === 3 ? [r[0], r[0]] : [r[0], r[2]]);

  // 1. definitions of function symbols
  const defs = new Map(); // symbol -> {file, name, line_start, line_end, encl:[sl,el]}
  for (const d of docs) {
    for (const o of d.occ) {
      if (!(o.roles & ROLE_DEFINITION) || !isFuncSym(o.symbol)) continue;
      const [nl] = spanOf(o.range);
      const encl = o.enclosing.length ? spanOf(o.enclosing) : [nl, nl];
      const prev = defs.get(o.symbol);
      // keep the widest definition (impl over overload signatures)
      if (!prev || encl[1] - encl[0] > prev.encl[1] - prev.encl[0]) {
        defs.set(o.symbol, { file: d.path, name: nameOf(o.symbol), line_start: encl[0] + 1, line_end: encl[1] + 1, encl });
      }
    }
  }
  const enclosingDegraded = [...defs.values()].every((v) => v.encl[0] === v.encl[1]);

  // implementations map: interface/abstract member symbol -> implementing symbols
  const implOf = new Map();
  for (const d of docs) {
    for (const { sym, impl } of d.rel) {
      for (const target of impl) {
        if (!implOf.has(target)) implOf.set(target, []);
        implOf.get(target).push(sym);
      }
    }
  }

  const symbols = [];
  const seenFiles = new Set();
  for (const [sym, v] of defs) {
    symbols.push({
      anchor: sym, lang: "typescript", kind: "Function", name: v.name,
      file: v.file, line_start: v.line_start, line_end: v.line_end,
      entry: v.name === "main" ? true : undefined,
      resolution: "cpg",
    });
    if (!seenFiles.has(v.file)) {
      seenFiles.add(v.file);
      symbols.push({ anchor: `file:${v.file}`, lang: "typescript", kind: "File", name: v.file.split("/").pop(), file: v.file, resolution: "cpg" });
    }
  }

  // 2. calls: reference occurrences of function symbols, attributed to the
  //    innermost containing definition of the same file.
  const perFileDefs = new Map(); // file -> defs sorted by span size asc
  for (const [sym, v] of defs) {
    if (!perFileDefs.has(v.file)) perFileDefs.set(v.file, []);
    perFileDefs.get(v.file).push({ sym, ...v });
  }
  for (const list of perFileDefs.values()) list.sort((a, b) => (a.encl[1] - a.encl[0]) - (b.encl[1] - b.encl[0]));
  const callerAt = (file, line) => {
    const list = perFileDefs.get(file);
    if (!list) return undefined;
    if (!enclosingDegraded) {
      for (const d of list) if (line >= d.encl[0] && line <= d.encl[1]) return d.sym; // innermost first (sorted asc)
      return undefined;
    }
    // degraded: nearest preceding definition start
    let best;
    for (const d of list) if (d.encl[0] <= line && (!best || d.encl[0] > best.encl[0])) best = d;
    return best?.sym;
  };

  const edges = [];
  for (const d of docs) {
    for (const o of d.occ) {
      if ((o.roles & ROLE_DEFINITION) || !isFuncSym(o.symbol)) continue;
      const [line] = spanOf(o.range);
      const from = callerAt(d.path, line);
      if (!from || from === o.symbol) continue;
      const site = { file: d.path, line: line + 1 };
      if (defs.has(o.symbol)) {
        const impls = (implOf.get(o.symbol) ?? []).filter((s) => defs.has(s));
        if (impls.length) {
          edges.push({ kind: "calls", from, to: o.symbol, resolution: "cpg", confidence: "medium", note: `dispatch, ${impls.length + 1} candidates`, candidates: [...new Set(impls)].sort(), site });
        } else {
          edges.push({ kind: "calls", from, to: o.symbol, resolution: "cpg", confidence: "high", site });
        }
      } else {
        edges.push({ kind: "calls", from, to_text: nameOf(o.symbol), resolution: "cpg", confidence: "low", site });
      }
    }
  }

  if (enclosingDegraded) {
    console.error("scip adapter: no enclosing_range in this index — caller attribution degraded to nearest-preceding definition");
  }
  return { symbols, edges };
}
