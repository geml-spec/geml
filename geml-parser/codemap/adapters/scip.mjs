// geml-code-graph adapter: SCIP index (index.scip, protobuf) → exchange format.
//
// Reads the protobuf DIRECTLY with a minimal embedded wire-format reader — the
// scip CLI ships no Windows binary, and the fields we need are few. Everything
// here is compiler-grade resolution, so edges are resolution:"cpg"; a direct
// hit is confidence:"high"; a call to an interface/abstract member with known
// implementations becomes medium + candidates; references to symbols not
// defined in the project become to_text (unresolved, low).
//
// Produce the index with scip-typescript (TS/JS) or rust-analyzer (Rust):
//   npx --yes @sourcegraph/scip-typescript index --output index.scip
//   rust-analyzer scip . --output rust.scip
//
// Caller attribution: a reference occurrence belongs to the innermost function
// DEFINITION whose enclosing_range contains it. scip-typescript and
// rust-analyzer both emit enclosing_range on definition occurrences; if absent
// we fall back to "the nearest preceding definition in the file" and mark the
// adapter degraded.
import { readFileSync } from "node:fs";
import { resolve as resolvePath, join, relative } from "node:path";

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
// Two producers, two symbol grammars behind the shared SCIP header
// "<scheme> <manager> <package> <version> <descriptors>":
//   scip-typescript  "scip-typescript npm @geml/geml 1.0.0 src/`geml.ts`/parse()."
//   rust-analyzer    "rust-analyzer cargo spike 0.1.0 util/multiply()."
//                    "rust-analyzer cargo spike 0.1.0 impl#[Widget]new()."
//                    "rust-analyzer cargo core https://… ops/arith/impl#[u32][`Mul<Self>`]mul()."
const isFuncSym = (s) => s.endsWith("().");
const isRustSym = (s) => s.startsWith("rust-analyzer ");
const langOf = (s) => (isRustSym(s) ? "rust" : "typescript");
// Term descriptor (`name.`): a const/property binding. scip-typescript gives
// `const Foo = () => …` — the dominant React component form — a TERM symbol,
// not a method one, so `().` alone would leave arrow components (and every
// `<Foo />` that renders them) out of the graph entirely. The discriminator
// is the definition's enclosing_range: scip-typescript emits it ONLY on
// function-like definitions (verified on the react fixture: `const Logo =
// () =>` carries one; object-literal consts, `createContext(...)` results and
// interface members carry none). Rust symbols are excluded — rust closures
// are locals and rust-analyzer's const semantics are unverified here.
const isTermSym = (s) => s.endsWith(".") && !s.endsWith("().");
const isArrowFnDef = (o) => isTermSym(o.symbol) && !isRustSym(o.symbol) && o.enclosing.length > 0;

// Descriptor tail: everything after the 4-token header. The version slot may
// be a URL (rust-analyzer sysroot crates) but never contains spaces; spaces
// inside descriptors only occur backtick-escaped, after the header.
const descriptorTail = (s) => {
  let i = -1;
  for (let n = 0; n < 4; n++) { i = s.indexOf(" ", i + 1); if (i < 0) return s; }
  return s.slice(i + 1);
};

// Tokenize a SCIP descriptor suffix (backtick-escape aware; `` = literal `).
// kinds: ns "a/", type "T#", term "x.", meta "m:", macro "m!", method "f().",
// typeParam "[T]", param "(p)".
function parseDescriptors(d) {
  const out = [];
  let i = 0;
  const readName = () => {
    if (d[i] === "`") {
      let s = ""; i++;
      while (i < d.length) {
        if (d[i] === "`") { if (d[i + 1] === "`") { s += "`"; i += 2; continue; } i++; break; }
        s += d[i++];
      }
      return s;
    }
    const start = i;
    while (i < d.length && /[A-Za-z0-9\-+$_]/.test(d[i])) i++;
    return d.slice(start, i);
  };
  while (i < d.length) {
    if (d[i] === "[") { i++; const name = readName(); if (d[i] === "]") i++; out.push({ kind: "typeParam", name }); continue; }
    if (d[i] === "(") { i++; const name = readName(); if (d[i] === ")") i++; out.push({ kind: "param", name }); continue; }
    const name = readName();
    const c = d[i];
    if (c === "(") { // method: name '(' disambiguator? ')' '.'
      while (i < d.length && d[i] !== ")") i++;
      i++;                       // ')'
      if (d[i] === ".") i++;
      out.push({ kind: "method", name });
      continue;
    }
    i++; // the descriptor suffix char (or one malformed char — progress either way)
    out.push({ kind: c === "/" ? "ns" : c === "#" ? "type" : c === "." ? "term" : c === ":" ? "meta" : c === "!" ? "macro" : "?", name });
  }
  return out;
}

// rust-analyzer display names: free functions keep their plain name (the
// module path lives in the file/container), members read Type::name. An
// `impl#` scope stands for an impl block — its SELF TYPE is the first
// [type-param] after it (`impl#[Widget]new().` → Widget::new; a trait impl
// carries the trait as a second bracket: `impl#[u32][`Mul<Self>`]mul().` →
// u32::mul).
const rustNameOf = (s) => {
  const ds = parseDescriptors(descriptorTail(s));
  let mi = -1;
  for (let j = ds.length - 1; j >= 0; j--) if (ds[j].kind === "method") { mi = j; break; }
  if (mi < 0 || !ds[mi].name) return ds.at(-1)?.name || s.split("/").pop() || s;
  let owner;
  for (let j = mi - 1; j >= 0; j--) {
    const x = ds[j];
    if (x.kind === "ns") break; // crossed into the module path — a free function
    if (x.kind === "type") {
      owner = x.name;
      if (owner === "impl") owner = ds.slice(j + 1, mi).find((t) => t.kind === "typeParam")?.name;
      break;
    }
  }
  return owner ? `${owner}::${ds[mi].name}` : ds[mi].name;
};

// Exported for tests: pure string → display name across both grammars.
export const nameOf = (s) => {
  if (isRustSym(s)) return rustNameOf(s);
  // Class members read class-qualified (`RenderCtx.block`), constructors as
  // `Cls.new` — free functions (no `Owner#` scope) keep their plain name.
  if (/`?<constructor>`?\(\)\.$/.test(s)) {
    const cm = /([A-Za-z0-9_$]+)#`?<constructor>`?\(\)\.$/.exec(s);
    return cm ? `${cm[1]}.new` : "new";
  }
  const m = /(?:([A-Za-z0-9_$]+)#)?([^\/#.`]+)\(\)\.$/.exec(s);
  if (m) return m[1] ? `${m[1]}.${m[2]}` : m[2];
  // Term symbol (arrow-function component/const, class property arrow):
  // `…/Logo.` → Logo, `…/A#onClick.` → A.onClick.
  const t = /(?:([A-Za-z0-9_$]+)#)?([A-Za-z0-9_$]+)\.$/.exec(s);
  if (t) return t[1] ? `${t[1]}.${t[2]}` : t[2];
  return s.split("/").pop() ?? s;
};

// ---- SFC shadow remap (Vue/Svelte virtualization) ---------------------------
// When the index was produced over a virtual dir (codemap/sfc-virtualize.mjs),
// `remapDir` points at it. Occurrences in shadow files (src/App.vue.ts) are
// attributed back to the original .vue/.svelte path + line through the
// per-shadow map.json; occurrences that map nowhere are pure generated code
// and are DROPPED, never misattributed. Additive: without remapDir nothing
// in extract() changes.
//
// Two SFC-specific recoveries:
//   1. Generated wrappers (svelte2tsx $$render, Volar __VLS_*) are never
//      symbols; a reference whose only enclosing definition is generated —
//      or that sits at the shadow's top level, as Volar's template projection
//      does — is attributed to a synthetic `<Component>.template` node when
//      its mapped line lands in the template/markup region.
//   2. svelte2tsx puts the whole <script> inside $$render, so user functions
//      are scip `local N` symbols (no display_name, no enclosing_range).
//      Function-shaped locals are admitted as definitions: the name comes
//      from the shadow text at the definition range, the span from a small
//      brace scan. Non-function locals (params, lets) stay invisible.
const GENERATED_NAME = /^(\$\$|__VLS_|__sveltets)/;

export function loadSfcRemap(remapDir, root) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(remapDir, "sfc-manifest.json"), "utf8"));
  } catch {
    return null; // no manifest — treat as a plain index
  }
  const rootAbs = resolvePath(root);
  const bySh = new Map();
  for (const f of manifest.files ?? []) {
    let side;
    try { side = JSON.parse(readFileSync(join(remapDir, f.map), "utf8")); } catch { continue; }
    const origAbs = resolvePath(manifest.src, f.original);
    const rel = relative(rootAbs, origAbs).replace(/\\/g, "/");
    bySh.set(f.shadow, {
      original: rel.startsWith("..") ? f.original : rel,
      component: side.component ?? f.original.split("/").pop(),
      framework: side.framework,
      regions: side.regions ?? [],
      map: new Map(side.lines ?? []), // 1-based generated line -> original line
      shadowAbs: join(remapDir, f.shadow),
      _text: undefined,
    });
  }
  return { bySh, dirAbs: resolvePath(remapDir), rootAbs };
}

const inRegion = (info, origLine) =>
  info.regions.some((r) => origLine >= r.start && origLine <= r.end);

// Shadow text as lines + line-start offsets (lazy, cached per shadow).
function shadowText(info) {
  if (!info._text) {
    const raw = readFileSync(info.shadowAbs, "utf8");
    info._text = { raw, lines: raw.split("\n") };
  }
  return info._text;
}

// End line of a local definition's body: from the definition name forward,
// the first `{` before any top-level `;` opens the body — match braces
// (skipping strings, template literals and comments) back to depth 0. An
// arrow with an expression body (no brace) stays single-line. Wrong guesses
// degrade attribution exactly like the adapter's documented degraded mode.
function braceSpanEnd(text, startOffset, startLine) {
  const s = text.raw;
  let i = startOffset, open = -1;
  for (const cap = Math.min(s.length, startOffset + 400); i < cap; i++) {
    const c = s[i];
    if (c === "{") { open = i; break; }
    if (c === ";") return startLine;
  }
  if (open < 0) return startLine;
  let depth = 0, line = startLine;
  for (i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "\n") { line++; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (i++; i < s.length; i++) {
        if (s[i] === "\\") { i++; continue; }
        if (s[i] === "\n" && q !== "`") break;
        if (s[i] === "\n") line++;
        if (s[i] === q) break;
      }
      continue;
    }
    if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; i--; continue; }
    if (c === "/" && s[i + 1] === "*") {
      for (i += 2; i < s.length; i++) { if (s[i] === "\n") line++; if (s[i] === "*" && s[i + 1] === "/") { i++; break; } }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return line; }
  }
  return line;
}

// Admit a `local N` definition occurrence when the shadow text says it is a
// function. Returns { name, encl: [startLine0, endLine0] } or null.
function localFnAt(info, range) {
  const text = shadowText(info);
  const l0 = range[0], cs = range[1], ce = range.length === 3 ? range[2] : range[3];
  const lineText = text.lines[l0] ?? "";
  const name = lineText.slice(cs, ce);
  if (!/^[A-Za-z_$][\w$]*$/.test(name) || GENERATED_NAME.test(name)) return null;
  const before = lineText.slice(0, cs), after = lineText.slice(ce);
  const isFn = /\bfunction\s*\*?\s*$/.test(before)
    || /^\s*=\s*(async\s*)?\(/.test(after)
    || /^\s*=\s*(async\s*)?function\b/.test(after)
    || /^\s*=\s*(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(after);
  if (!isFn) return null;
  let off = 0;
  for (let i = 0; i < l0; i++) off += text.lines[i].length + 1;
  return { name, encl: [l0, braceSpanEnd(text, off + ce, l0)] };
}

export function extract({ raw: scipPath, root, remapDir }) {
  const { docs, projectRoot } = parseScip(scipPath);
  // scip-typescript emits OS-native separators in relative_path on Windows;
  // the codemap profile is posix throughout.
  for (const d of docs) d.path = d.path.replace(/\\/g, "/");
  const sfc = remapDir ? loadSfcRemap(remapDir, root) : null;
  if (sfc) {
    // Virtual-dir index: shadow docs keep their raw path for now (it keys the
    // map lookup; the final passes swap in the original .vue/.svelte path).
    // Real project files arrive ../-relative to the virtual dir — anchor them
    // repo-relative. Anything else living INSIDE the virtual dir (svelte
    // shims, global type stubs) is indexing scaffolding, not source: dropped.
    for (const d of docs) {
      const info = sfc.bySh.get(d.path);
      if (info) { d.sfc = info; continue; }
      const abs = resolvePath(sfc.dirAbs, d.path);
      if (!relative(sfc.dirAbs, abs).replace(/\\/g, "/").startsWith("..")) { d.drop = true; continue; }
      const repoRel = relative(sfc.rootAbs, abs).replace(/\\/g, "/");
      if (!repoRel.startsWith("..")) d.path = repoRel;
    }
  } else if (projectRoot && root) {
    // Document paths are relative to the INDEXED project (metadata.project_root),
    // which may be a subdirectory of the codemap's --root. Re-anchor them so a
    // multi-language merge keeps one coherent repo-relative path space.
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

  // scip `local N` symbols are per-document — namespace their def/ref key by
  // the document so two shadows' locals never collide. Non-local symbols keep
  // the raw symbol string as their key (and anchor).
  const localKey = (d, sym) => `local:${d.path}#${sym.slice("local ".length)}`;

  // 1. definitions of function symbols
  const defs = new Map(); // key -> {file, name, line_start, line_end, encl:[sl,el]}
  for (const d of docs) {
    if (d.drop) continue;
    for (const o of d.occ) {
      if (!(o.roles & ROLE_DEFINITION)) continue;
      // Merged admission: method symbols AND arrow-function terms (react branch:
      // a term definition carrying an enclosing_range is function-like) take the
      // standard path; SFC shadow-doc locals (svelte2tsx wraps the <script> in
      // $$render, so every user function is a local) take the sfc branch.
      if (isFuncSym(o.symbol) || isArrowFnDef(o)) {
        const [nl] = spanOf(o.range);
        const encl = o.enclosing.length ? spanOf(o.enclosing) : [nl, nl];
        const prev = defs.get(o.symbol);
        // keep the widest definition (impl over overload signatures)
        if (!prev || encl[1] - encl[0] > prev.encl[1] - prev.encl[0]) {
          defs.set(o.symbol, { file: d.path, name: nameOf(o.symbol), line_start: encl[0] + 1, line_end: encl[1] + 1, encl });
        }
      } else if (d.sfc && o.symbol.startsWith("local ")) {
        const lf = localFnAt(d.sfc, o.range);
        if (lf) {
          defs.set(localKey(d, o.symbol), {
            file: d.path, name: lf.name,
            line_start: lf.encl[0] + 1, line_end: lf.encl[1] + 1, encl: lf.encl,
          });
        }
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
  const addFileSym = (file, lang) => {
    if (seenFiles.has(file)) return;
    seenFiles.add(file);
    symbols.push({ anchor: `file:${file}`, lang, kind: "File", name: file.split("/").pop(), file, resolution: "cpg" });
  };
  // Definitions that survive into `symbols` — in remap mode the edge pass
  // must not emit edges to/from a definition that was dropped as generated.
  const survivors = new Set();
  for (const [sym, v] of defs) {
    // lang follows the producing indexer's symbol scheme, so a merged
    // TS + Rust codemap keeps each definition honestly labelled.
    const lang = langOf(sym);
    let file = v.file, line_start = v.line_start, line_end = v.line_end;
    const info = sfc?.bySh.get(v.file);
    if (info) {
      // generated wrappers/helpers never become symbols; a definition whose
      // line maps nowhere in the original is pure generated code — dropped.
      if (GENERATED_NAME.test(v.name)) continue;
      const ls = info.map.get(v.line_start);
      if (ls === undefined) continue;
      file = info.original;
      line_start = ls;
      line_end = Math.max(ls, info.map.get(v.line_end) ?? ls);
    }
    survivors.add(sym);
    symbols.push({
      anchor: sym, lang, kind: "Function", name: v.name,
      file, line_start, line_end,
      entry: v.name === "main" ? true : undefined,
      resolution: "cpg",
    });
    addFileSym(file, lang);
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
  const usedRegions = new Map(); // shadow doc path -> info (template node demanded)
  for (const d of docs) {
    if (d.drop) continue;
    for (const o of d.occ) {
      if (o.roles & ROLE_DEFINITION) continue;
      // Callable reference admission, merged: method symbols always count
      // (resolved or to_text); TERM symbols only when they resolve to an
      // admitted arrow-function definition — otherwise every property READ
      // would become a phantom call; shadow-doc locals via their per-document
      // key. Everything else is not a call.
      let symKey;
      if (isFuncSym(o.symbol)) symKey = o.symbol;
      else if (defs.has(o.symbol)) symKey = o.symbol; // term ref -> admitted arrow-fn def
      else if (d.sfc && o.symbol.startsWith("local ") && defs.has(localKey(d, o.symbol))) symKey = localKey(d, o.symbol);
      else continue;
      const [line] = spanOf(o.range);
      let from = callerAt(d.path, line);
      let site = { file: d.path, line: line + 1 };
      if (d.sfc) {
        const origLine = d.sfc.map.get(line + 1);
        if (!from || !survivors.has(from)) {
          // top-level (Volar's template projection) or generated-only caller
          // ($$render): the reference belongs to the component's template
          // when its mapped line lands there — otherwise drop, never guess.
          if (origLine === undefined || !inRegion(d.sfc, origLine)) continue;
          from = `sfc:${d.sfc.original}#template`;
          usedRegions.set(d.path, d.sfc);
        }
        if (origLine === undefined) continue; // generated echo of a real reference
        site = { file: d.sfc.original, line: origLine };
      }
      if (!from || from === symKey) continue;
      if (defs.has(symKey)) {
        if (sfc && !survivors.has(symKey)) continue; // callee was dropped as generated
        const impls = (implOf.get(symKey) ?? []).filter((s) => defs.has(s) && (!sfc || survivors.has(s)));
        if (impls.length) {
          edges.push({ kind: "calls", from, to: symKey, resolution: "cpg", confidence: "medium", note: `dispatch, ${impls.length + 1} candidates`, candidates: [...new Set(impls)].sort(), site });
        } else {
          edges.push({ kind: "calls", from, to: symKey, resolution: "cpg", confidence: "high", site });
        }
      } else {
        const toText = nameOf(o.symbol);
        // shadow docs call generated helpers (__VLS_asFunctionalElement, …)
        // once per template element — machinery, not user blind spots.
        if (d.sfc && GENERATED_NAME.test(toText)) continue;
        edges.push({ kind: "calls", from, to_text: toText, resolution: "cpg", confidence: "low", site });
      }
    }
  }
  // Synthetic template nodes — one per SFC whose template/markup gained an
  // edge: the honest caller for `@click="save"` / `on:click={bump}`.
  for (const info of usedRegions.values()) {
    const starts = info.regions.map((r) => r.start), ends = info.regions.map((r) => r.end);
    symbols.push({
      anchor: `sfc:${info.original}#template`, lang: "typescript", kind: "Function",
      name: `${info.component}.template`, file: info.original,
      line_start: Math.min(...starts), line_end: Math.max(...ends),
      resolution: "cpg",
    });
    addFileSym(info.original, "typescript");
  }

  if (enclosingDegraded) {
    console.error("scip adapter: no enclosing_range in this index — caller attribution degraded to nearest-preceding definition");
  }
  return { symbols, edges };
}
