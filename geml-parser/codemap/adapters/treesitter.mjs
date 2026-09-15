// geml-code-graph adapter: tree-sitter export (defs/bindings/calls JSONL from
// codemap/treesitter-export.mjs) → exchange format (DESIGN §3.1/3.2).
//
// The RESOLUTION half of the fallback indexer, and the honest one: everything
// here is syntax-level, so every symbol and edge carries resolution:"heuristic"
// and nothing is ever `high`. Three layers, tried in order for each call site:
//   ① a bare name resolves in the SAME FILE, innermost scope first (a method
//      calling its sibling, then the file's top level)             → medium
//   ② a dotted path is followed through the bindings the export saw —
//      `const net = @import("net.zig")` lands in that file; an alias
//      (`const Conn = @import("net.zig").Client`, `pub const X = other.X`)
//      is substituted, re-exports included; a named container
//      (`const Client = struct {…}`) and `self`/`@This()` scope the member  → medium
//      A path whose FIRST hop is structurally known but whose member is not
//      (`Client.missing`, `std.debug.print`) is a real hole — it becomes
//      to_text, never a guess.
//   ③ an unbound head (a parameter, a local, a call result) can only be
//      matched by its LAST segment against every definition in the repo:
//      one hit → `to` at low confidence with a note; several → `candidates`
//      and no primary target; none → to_text.
// Language-agnostic: the profile that produced the tables decided what a
// definition, a binding and a call are; this file only joins them.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const readJsonl = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const MAX_HOPS = 8; // alias chains and re-exports; also the cycle guard
// Layer ③ lists same-named candidates only up to here. Past it the name is
// simply common (`deinit` has 133 definitions in Zig's std) and a candidate
// list would flood every one of them with backlinks — the edge becomes
// to_text, with the count kept in a note.
const MAX_CANDIDATES = 8;

// Source text for an unresolved path: `@file:src/x.zig` / `@pkg:std` read
// back as the import call they were, `<expr>` as `(…)`.
const display = (segs) => segs.map((s) =>
  s.startsWith("@file:") ? `@import("${s.slice(6).split("/").pop()}")`
    : s.startsWith("@pkg:") ? `@import("${s.slice(5)}")`
      : s === "<expr>" ? "(…)" : s).join(".");

export function extract({ raw }) {
  const meta = JSON.parse(readFileSync(join(raw, "meta.json"), "utf8"));
  const lang = meta.lang;
  const defs = readJsonl(join(raw, "defs.jsonl"));
  const bindings = readJsonl(join(raw, "bindings.jsonl"));
  const calls = readJsonl(join(raw, "calls.jsonl"));
  if (meta.parseErrors) {
    console.error(`treesitter adapter: ${meta.parseErrors} file(s) had syntax errors — their definitions and calls are partial (grammar older than the code?)`);
  }

  // ---- symbols ---------------------------------------------------------------
  // anchor = <lang>:<file>#<container path>.<name>; two definitions that
  // collapse to the same qualified name (anonymous containers) get ~2, ~3 by
  // line order, so the numbering is stable across rebuilds.
  const qualified = (d) => [...(d.container ?? []), d.name].join(".");
  const groups = new Map();
  for (const d of defs) {
    const base = `${lang}:${d.file}#${qualified(d)}`;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(d);
  }
  const anchorOf = new Map();
  for (const [base, list] of groups) {
    list.sort((a, b) => (a.lineStart ?? 0) - (b.lineStart ?? 0));
    list.forEach((d, i) => anchorOf.set(d, i === 0 ? base : `${base}~${i + 1}`));
  }
  const symbols = [];
  const seenFiles = new Set();
  const defIndex = new Map(); // `${file}\0${qualified}` -> anchor (first definition wins)
  const byName = new Map();   // bare name -> Set(anchor)          (layer ③)
  for (const d of defs) {
    const anchor = anchorOf.get(d);
    const container = d.container ?? [];
    symbols.push({
      anchor, lang, kind: "Function",
      name: container.length ? `${container.at(-1)}.${d.name}` : d.name,
      file: d.file, line_start: d.lineStart, line_end: d.lineEnd,
      entry: d.name === "main" && container.length === 0 ? true : undefined,
      resolution: "heuristic",
    });
    const k = `${d.file}\0${qualified(d)}`;
    if (!defIndex.has(k)) defIndex.set(k, anchor);
    if (!byName.has(d.name)) byName.set(d.name, new Set());
    byName.get(d.name).add(anchor);
    if (!seenFiles.has(d.file)) {
      seenFiles.add(d.file);
      symbols.push({ anchor: `${lang}:${d.file}`, lang, kind: "File", name: d.file.split("/").pop(), file: d.file, resolution: "heuristic" });
    }
  }

  // ---- bindings, indexed by file → scope → name ------------------------------
  const bindIndex = new Map();
  for (const b of bindings) {
    if (!bindIndex.has(b.file)) bindIndex.set(b.file, new Map());
    const perFile = bindIndex.get(b.file);
    const sk = (b.scope ?? []).join(".");
    if (!perFile.has(sk)) perFile.set(sk, new Map());
    if (!perFile.get(sk).has(b.name)) perFile.get(sk).set(b.name, b);
  }
  // Visible scopes from inside `container`: innermost container outward to the
  // file's top level.
  const prefixes = (container) => {
    const out = [];
    for (let i = container.length; i >= 0; i--) out.push(container.slice(0, i));
    return out;
  };
  const findDef = (file, container, segs) => {
    for (const p of prefixes(container)) {
      const a = defIndex.get(`${file}\0${[...p, ...segs].join(".")}`);
      if (a) return a;
    }
    return null;
  };
  const findBinding = (file, container, name) => {
    const perFile = bindIndex.get(file);
    if (!perFile) return null;
    for (const p of prefixes(container)) {
      const b = perFile.get(p.join("."))?.get(name);
      if (b) return b;
    }
    return null;
  };

  // ---- resolution ------------------------------------------------------------
  // Each function returns { to } | { unresolved: true, text? } (a real hole →
  // to_text, `text` naming the target when the source spelling would hide it,
  // e.g. an alias of an external) or null (nothing structural → layer ③).
  const UNRESOLVED = { unresolved: true };

  // `segs` looked up at a known place: a file's top level or a container.
  function inScope(file, scope, segs, hops) {
    if (hops > MAX_HOPS || !segs.length) return null;
    const a = defIndex.get(`${file}\0${[...scope, ...segs].join(".")}`);
    if (a) return { to: a };
    const b = bindIndex.get(file)?.get(scope.join("."))?.get(segs[0]);
    if (b) return viaBinding(b, segs.slice(1), hops + 1); // re-export, nested import, nested container
    return UNRESOLVED;
  }
  function viaBinding(b, rest, hops) {
    if (hops > MAX_HOPS) return null;
    switch (b.kind) {
      case "import": return b.target ? inScope(b.target, [], rest, hops + 1) : { unresolved: true, text: display([b.name, ...rest]) };
      case "alias": {
        const segs = [...(b.path ?? []), ...rest];
        return b.target ? inScope(b.target, [], segs, hops + 1) : resolvePath(b.file, b.scope ?? [], segs, hops + 1);
      }
      case "struct": return inScope(b.file, [...(b.scope ?? []), b.name], rest, hops + 1);
      case "self": return inScope(b.file, b.scope ?? [], rest, hops + 1);
      default: return null;
    }
  }
  function resolvePath(file, container, segs, hops = 0) {
    if (hops > MAX_HOPS || !segs.length) return null;
    const [head, ...rest] = segs;
    if (head.startsWith("@file:")) return inScope(head.slice(6), [], rest, hops + 1);
    if (head.startsWith("@pkg:")) return UNRESOLVED;
    if (head === "<expr>") return null;
    if (!rest.length) { // layer ①
      const a = findDef(file, container, [head]);
      if (a) return { to: a };
      const b = findBinding(file, container, head);
      return b?.kind === "alias" ? viaBinding(b, [], hops + 1) : null;
    }
    const b = findBinding(file, container, head); // layer ②
    if (b) return viaBinding(b, rest, hops + 1);
    if (head === "self" || head === "Self") { // an unbound receiver named self: the current container
      const a = findDef(file, container, rest);
      if (a) return { to: a };
    }
    return null;
  }
  function byNameFallback(segs) { // layer ③
    const cands = [...(byName.get(segs.at(-1)) ?? [])].sort();
    if (cands.length === 1) return { to: cands[0], confidence: "low", note: "name match only" };
    if (cands.length > MAX_CANDIDATES) return { unresolved: true, note: `name match only, ${cands.length} same-named — not listed` };
    if (cands.length > 1) return { candidates: cands, confidence: "low", note: `name match only, ${cands.length} same-named` };
    return UNRESOLVED;
  }

  // ---- edges -----------------------------------------------------------------
  const edges = [];
  for (const c of calls) {
    if (!c.caller) continue; // test block / file scope: no node to hang the edge on
    const from = defIndex.get(`${c.file}\0${[...(c.caller.container ?? []), c.caller.name].join(".")}`);
    if (!from) continue;
    const segs = c.callee ?? [];
    // Names are looked up from INSIDE the caller: its own body (a fn-local
    // alias, a nested fn) first, then its container(s), then the file.
    const scope = [...(c.caller.container ?? []), c.caller.name];
    let r = resolvePath(c.file, scope, segs);
    let confidence = "medium";
    if (!r) { r = byNameFallback(segs); confidence = r.confidence ?? "low"; }
    if (r.to === from) continue; // recursion is not an edge
    const site = { file: c.file, line: c.line };
    if (r.unresolved) {
      const e = { kind: "calls", from, to_text: r.text ?? display(segs), resolution: "heuristic", confidence: "low", site };
      if (r.note) e.note = r.note;
      edges.push(e);
    } else if (r.candidates) {
      const cands = r.candidates.filter((a) => a !== from);
      if (cands.length === 1) edges.push({ kind: "calls", from, to: cands[0], resolution: "heuristic", confidence: "low", note: "name match only", site });
      else if (cands.length) edges.push({ kind: "calls", from, resolution: "heuristic", confidence: "low", candidates: cands, note: r.note, site });
      else edges.push({ kind: "calls", from, to_text: display(segs), resolution: "heuristic", confidence: "low", site });
    } else {
      const e = { kind: "calls", from, to: r.to, resolution: "heuristic", confidence, site };
      if (r.note) e.note = r.note;
      edges.push(e);
    }
  }

  return { symbols, edges };
}
