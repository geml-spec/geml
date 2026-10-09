// Reader for the earlier sidecar format (a linear chain of reverse patches with
// `history-revision` / `history-keyframe` blocks). history.ts converts such a
// sidecar into the change-graph format the first time it reads one; nothing
// here writes. The algorithm is the one that format's tool used, kept verbatim
// so every revision it recorded reconstructs to the bytes its hash names.

import { createHash } from "node:crypto";
import { attrs, fullHash, locate, nlOf, textOf, tile, type Unit } from "./history-text.js";

/** One recorded revision, oldest first, with its full reconstructed text. */
export interface LegacyRevision {
  id: string; author?: string; summary?: string; hash: string; newline?: string; text: string;
}

/** A sidecar is in the earlier format when it carries its block types. */
export function isLegacy(sidecarText: string): boolean {
  return /^=+[ \t]*history-(revision|keyframe)\b/m.test(sidecarText);
}

const KEY = String.raw`(#[\p{L}\p{N}_-]+(?:~\d+)?|@[0-9a-f]+(?:~\d+)?)`;

function sha8(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex").slice(0, 8);
}

interface KeyedUnit { u: Unit; key: string }

function keyedUnits(lines: string[], hashed?: Map<string, string>): KeyedUnit[] {
  const counts = new Map<string, number>();
  const keyOf = (text: string): string => {
    let h = hashed?.get(text);
    if (h === undefined) { h = sha8(text); hashed?.set(text, h); }
    return h;
  };
  return tile(lines).map((u) => {
    const base = u.id ? `#${u.id}` : `@${keyOf(lines.slice(u.start, u.bodyEnd).join("\n"))}`;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    return { u, key: n === 0 ? base : `${base}~${n}` };
  });
}

function locateUnit(lines: string[], key: string, hashed?: Map<string, string>): Unit {
  const ku = keyedUnits(lines, hashed).find((x) => x.key === key);
  if (!ku) throw new Error(`history: unit ${key} not found while applying reverse patch`);
  return ku.u;
}

type Anchor = "at-start" | "at-end" | { after: string };
interface Op { kind: "delete" | "replace" | "insert" | "move"; key?: string; blob?: string; anchor?: Anchor }

function parseAnchor(s: string): Anchor {
  if (s === "at-start" || s === "at-end") return s;
  const m = new RegExp("^after\\s+" + KEY + "$", "u").exec(s);
  if (!m) throw new Error(`history: bad anchor: ${s}`);
  return { after: m[1]! };
}

function parseOps(body: string): Op[] {
  const ops: Op[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = new RegExp("^delete\\s+" + KEY + "$", "u").exec(line))) {
      ops.push({ kind: "delete", key: m[1]! });
    } else if ((m = new RegExp("^replace\\s+" + KEY + "\\s+<-\\s+blob:(\\S+)$", "u").exec(line))) {
      ops.push({ kind: "replace", key: m[1]!, blob: m[2]! });
    } else if ((m = /^insert\s+<-\s+blob:(\S+)\s+(.+)$/.exec(line))) {
      ops.push({ kind: "insert", blob: m[1]!, anchor: parseAnchor(m[2]!) });
    } else if ((m = new RegExp("^move\\s+" + KEY + "\\s+(.+)$", "u").exec(line))) {
      ops.push({ kind: "move", key: m[1]!, anchor: parseAnchor(m[2]!) });
    } else {
      throw new Error(`history: unrecognized reverse-patch op: ${line}`);
    }
  }
  return ops;
}

function insertAt(lines: string[], anchor: Anchor, payload: string[], hashed?: Map<string, string>): void {
  if (anchor === "at-start") { lines.splice(0, 0, ...payload); return; }
  if (anchor === "at-end") { lines.push(...payload); return; }
  const a = locateUnit(lines, anchor.after, hashed);
  lines.splice(a.endExcl, 0, ...payload);
}

function applyReverse(textLf: string, ops: Op[], blobs: Map<string, string>): string {
  const lines = textLf.split("\n");
  const blob = (id: string): string[] => {
    const p = blobs.get(id);
    if (p === undefined) throw new Error(`history: unresolved blob:${id}`);
    return p.split("\n");
  };
  const hashed = new Map<string, string>();
  const byKey = new Map(keyedUnits(lines, hashed).map((k) => [k.key, k.u]));
  const resolveSnap = (key: string): Unit => {
    const u = byKey.get(key);
    if (!u) throw new Error(`history: unit ${key} not found while applying reverse patch`);
    return u;
  };
  interface RangeEdit { start: number; endExcl: number; repl: string[] }
  const rangeEdits: RangeEdit[] = [];
  const anchored: Op[] = [];
  for (const op of ops) {
    if (op.kind === "delete") {
      const u = resolveSnap(op.key!);
      rangeEdits.push({ start: u.start, endExcl: u.endExcl, repl: [] });
    } else if (op.kind === "replace") {
      const u = resolveSnap(op.key!);
      rangeEdits.push({ start: u.start, endExcl: u.endExcl, repl: blob(op.blob!) });
    } else {
      anchored.push(op);
    }
  }
  rangeEdits.sort((a, b) => b.start - a.start);
  for (const e of rangeEdits) lines.splice(e.start, e.endExcl - e.start, ...e.repl);
  for (const op of anchored) {
    if (op.kind === "insert") {
      insertAt(lines, op.anchor!, blob(op.blob!), hashed);
    } else {
      const u = locateUnit(lines, op.key!, hashed);
      const cut = lines.slice(u.start, u.endExcl);
      lines.splice(u.start, u.endExcl - u.start);
      insertAt(lines, op.anchor!, cut, hashed);
    }
  }
  return lines.join("\n");
}

interface Revision { id: string; parent?: string; author?: string; summary?: string; hash: string; newline?: string; ops: Op[] }

function hashMatches(lf: string, r: Revision, fileNl: string): boolean {
  const own = nlOf(r.newline);
  if (own) return fullHash(lf, own) === r.hash;
  return fullHash(lf, fileNl) === r.hash || fullHash(lf, fileNl === "\r\n" ? "\n" : "\r\n") === r.hash;
}

/**
 * Every revision of an earlier-format sidecar, oldest first, each with its
 * reconstructed text checked against the hash it recorded. Throws when the
 * chain is broken or a revision does not reproduce its hash: a sidecar that
 * cannot be read faithfully is not converted.
 */
export function readLegacy(sidecarText: string): LegacyRevision[] {
  const { lf, nl } = textOf(sidecarText);
  const lines = lf.split("\n");
  const keyframes = new Map<string, string>();
  const revisions = new Map<string, Revision>();
  const blobs = new Map<string, string>();
  let current = "";
  for (const b of locate(lines)) {
    const body = lines.slice(b.start + 1, b.end).join("\n");
    const a = attrs(b.attrLine);
    if (b.type === "meta") {
      const m = /^\s*current\s*=\s*"?([^"\n]+?)"?\s*$/m.exec(body);
      if (m && !current) current = m[1]!;
    } else if (b.type === "history-keyframe") {
      keyframes.set(a.get("id") ?? "", body);
    } else if (b.type === "history-revision") {
      const id = a.get("id") ?? "";
      if (revisions.has(id)) throw new Error(`history: two revisions share the id ${id}`);
      revisions.set(id, {
        id, parent: a.get("parent"), author: a.get("author"), summary: a.get("summary"),
        hash: a.get("hash") ?? "", newline: a.get("newline"), ops: parseOps(body),
      });
    } else if (b.type === "history-blob" && b.id) {
      blobs.set(b.id, body);
    }
  }
  const chain: Revision[] = [];
  const seen = new Set<string>();
  for (let id: string | undefined = current; id; id = revisions.get(id)?.parent) {
    const r = revisions.get(id);
    if (!r) throw new Error(`history: revision ${id} missing (broken chain)`);
    if (seen.has(id)) throw new Error(`history: cycle at ${id}`);
    seen.add(id);
    chain.push(r);
  }
  if (chain.length === 0) throw new Error("history: the sidecar names no current revision");
  const top = keyframes.get(chain[0]!.id);
  if (top === undefined) throw new Error(`history: no keyframe for the current revision ${chain[0]!.id}`);
  const out: LegacyRevision[] = [];
  let text = top;
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i]!;
    if (i > 0) text = keyframes.get(r.id) ?? applyReverse(text, chain[i - 1]!.ops, blobs);
    if (!hashMatches(text, r, nl)) throw new Error(`history: revision ${r.id} does not reproduce its recorded hash`);
    out.push({ id: r.id, author: r.author, summary: r.summary, hash: r.hash, newline: r.newline, text });
  }
  return out.reverse();
}
