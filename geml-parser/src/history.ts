// GEML history (profile geml-history/v1) — a change graph beside the live file.
//
// The model is any-sync's object tree with GEML's own payload: every change
// names the changes it follows (`parents`, any number of them), carries
// forward operations addressed by block key, and is identified by a hash over
// its parents and its content. Two sidecars merge by taking the union of their
// changes; replaying a set of changes in the one deterministic order (causal
// first, then by id) gives every implementation the same document. When two
// changes that did not know about each other touch one block, the one later in
// that order wins and the other is reported.
//
// The live `.geml` stays the source of truth for the current version; the
// sidecar's snapshot mirrors it so reading the current state needs no replay.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  FENCE_OPEN, GEML_LANGUAGE_VERSION, attrs, fenceFor, fullHash, loadBytes, locate,
  nlNamed, nlOf, quoteAttr, sha256Hex, stampUTC, textOf, tile, writeBytes,
} from "./history-text.js";
import { isLegacy, readLegacy } from "./history-legacy.js";

export { stampUTC } from "./history-text.js";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type Anchor = "at-start" | { after: string };
export interface Op { kind: "create" | "update" | "remove" | "move"; key: string; blob?: string; anchor?: Anchor }

export interface Change {
  id: string;
  parents: string[];
  author?: string;
  summary?: string;
  newline: "lf" | "crlf";
  /** sha256 of the document this change and its ancestors replay to. */
  state: string;
  /** The id this change had in the earlier sidecar format, when it was converted from one. */
  was?: string;
  ops: Op[];
}

/** One block of the document as the replay model holds it. A removed block
 *  stays as a tombstone so that anchors naming it still resolve. */
interface Entry { key: string; lines: string[]; alive: boolean }

interface Snapshot { heads: string[]; hash: string; newline: "lf" | "crlf"; text: string; entries: Entry[] }

export interface History {
  /** Newline style the sidecar file itself is written in. */
  nl: string;
  changes: Map<string, Change>;
  blobs: Map<string, string>;
  snapshot?: Snapshot;
  /** Structural damage found while reading: duplicate ids and the like. */
  problems: string[];
  /** True when this history was converted from the earlier sidecar format. */
  converted: boolean;
}

/** A change that lost to a concurrent one on the same block. */
export interface LostEdit { key: string; kept: string; lost: string; how: "overwritten" | "removed" | "edited-after-remove" }

// ---------------------------------------------------------------------------
// Op lines
// ---------------------------------------------------------------------------

const KEY_RE = String.raw`([#~]\S+)`;
const ANCHOR_RE = String.raw`(at-start|after\s+[#~]\S+)`;

function parseAnchor(s: string): Anchor {
  if (s === "at-start") return s;
  return { after: s.replace(/^after\s+/, "") };
}

function anchorStr(a: Anchor): string {
  return a === "at-start" ? a : `after ${a.after}`;
}

function parseOps(body: string): Op[] {
  const ops: Op[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^create\\s+${KEY_RE}\\s+${ANCHOR_RE}\\s+<-\\s+blob:(\\S+)$`).exec(line))) {
      ops.push({ kind: "create", key: m[1]!, anchor: parseAnchor(m[2]!.replace(/\s+/, " ")), blob: m[3]! });
    } else if ((m = new RegExp(`^update\\s+${KEY_RE}\\s+<-\\s+blob:(\\S+)$`).exec(line))) {
      ops.push({ kind: "update", key: m[1]!, blob: m[2]! });
    } else if ((m = new RegExp(`^remove\\s+${KEY_RE}$`).exec(line))) {
      ops.push({ kind: "remove", key: m[1]! });
    } else if ((m = new RegExp(`^move\\s+${KEY_RE}\\s+${ANCHOR_RE}$`).exec(line))) {
      ops.push({ kind: "move", key: m[1]!, anchor: parseAnchor(m[2]!.replace(/\s+/, " ")) });
    } else {
      throw new Error(`history: unrecognized operation: ${line}`);
    }
  }
  return ops;
}

function opLine(op: Op): string {
  switch (op.kind) {
    case "create": return `create ${op.key} ${anchorStr(op.anchor!)} <- blob:${op.blob}`;
    case "update": return `update ${op.key} <- blob:${op.blob}`;
    case "remove": return `remove ${op.key}`;
    case "move": return `move ${op.key} ${anchorStr(op.anchor!)}`;
  }
}

const blobId = (payload: string): string => `b-${sha256Hex(payload).slice(0, 12)}`;

/** The id of a change: its timestamp, then a hash over everything it says —
 *  parents included, so an edit anywhere upstream changes every id below it. */
function changeId(stamp: string, c: Omit<Change, "id">, blobs: Map<string, string>): string {
  const lines = [
    `parents ${[...c.parents].sort().join(" ")}`,
    `author ${c.author ?? ""}`,
    `summary ${c.summary ?? ""}`,
    `newline ${c.newline}`,
    `state ${c.state}`,
  ];
  if (c.was) lines.push(`was ${c.was}`);
  lines.push(...c.ops.map(opLine), "--");
  for (const op of c.ops) if (op.blob) lines.push(op.blob, blobs.get(op.blob) ?? "\u0000missing");
  return `${stamp}-${sha256Hex(lines.join("\n")).slice(0, 12)}`;
}

const stampOf = (id: string): string => id.slice(0, id.indexOf("-") < 0 ? id.length : id.indexOf("-"));

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

const isBlank = (l: string): boolean => l.trim() === "";

/** Order a set of changes: every change after its parents; among changes that
 *  are ready together, the smaller id first — ids start with their UTC time,
 *  so concurrent changes replay oldest first and the later one wins. */
export function replayOrder(changes: Map<string, Change>, subset?: Set<string>): Change[] {
  const ids = subset ? [...subset] : [...changes.keys()];
  const inSet = new Set(ids);
  const pending = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of ids) {
    const c = changes.get(id)!;
    const ps = c.parents.filter((p) => inSet.has(p));
    pending.set(id, ps.length);
    for (const p of ps) (children.get(p) ?? children.set(p, []).get(p)!).push(id);
  }
  const ready: string[] = ids.filter((id) => pending.get(id) === 0).sort();
  const out: Change[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    out.push(changes.get(id)!);
    for (const ch of children.get(id) ?? []) {
      const n = pending.get(ch)! - 1;
      pending.set(ch, n);
      if (n === 0) {
        let lo = 0, hi = ready.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (ready[mid]! < ch) lo = mid + 1; else hi = mid; }
        ready.splice(lo, 0, ch);
      }
    }
  }
  if (out.length !== ids.length) throw new Error("history: the change graph has a cycle");
  return out;
}

/** The replay model: an ordered list of entries with tombstones. */
class Model {
  entries: Entry[];
  private byKey = new Map<string, Entry>();
  private lastIdx = -1;
  constructor(entries: Entry[] = []) {
    this.entries = entries.map((e) => ({ key: e.key, lines: [...e.lines], alive: e.alive }));
    for (const e of this.entries) this.byKey.set(e.key, e);
  }
  get(key: string): Entry | undefined { return this.byKey.get(key); }
  has(key: string): boolean { return this.byKey.has(key); }
  keys(): IterableIterator<string> { return this.byKey.keys(); }

  private indexOf(e: Entry): number {
    if (this.lastIdx >= 0 && this.entries[this.lastIdx] === e) return this.lastIdx;
    return this.entries.indexOf(e);
  }
  private slot(anchor: Anchor, self?: Entry): number {
    if (anchor === "at-start") return 0;
    const k = anchor.after;
    const a = this.byKey.get(k);
    if (!a) throw new Error(`history: anchor ${k} is not a block of this document`);
    if (a === self) throw new Error(`history: ${k} cannot be anchored to itself`);
    return this.indexOf(a) + 1;
  }
  private place(e: Entry, anchor: Anchor): void {
    const i = this.slot(anchor, e);
    if (i === this.entries.length) this.entries.push(e); else this.entries.splice(i, 0, e);
    this.lastIdx = i;
  }
  private detach(e: Entry): void {
    const i = this.indexOf(e);
    this.entries.splice(i, 1);
    this.lastIdx = -1;
  }

  /** Apply one operation. Returns what it displaced, for lost-edit reporting. */
  apply(op: Op, blobs: Map<string, string>): "created" | "updated" | "resurrected" | "ignored" | "removed" | "moved" {
    const payload = (): string[] => {
      const p = blobs.get(op.blob!);
      if (p === undefined) throw new Error(`history: unresolved blob:${op.blob}`);
      return p.split("\n");
    };
    const e = this.byKey.get(op.key);
    switch (op.kind) {
      case "create": {
        if (e && e.alive) { e.lines = payload(); return "updated"; }
        if (e) { e.lines = payload(); e.alive = true; this.detach(e); this.place(e, op.anchor!); return "resurrected"; }
        const n: Entry = { key: op.key, lines: payload(), alive: true };
        this.place(n, op.anchor!);
        this.byKey.set(n.key, n);
        return "created";
      }
      case "update": {
        if (!e) throw new Error(`history: update of ${op.key}, which no earlier change created`);
        if (!e.alive) return "ignored";
        e.lines = payload();
        return "updated";
      }
      case "remove": {
        if (!e) throw new Error(`history: remove of ${op.key}, which no earlier change created`);
        e.alive = false;
        return "removed";
      }
      case "move": {
        if (!e) throw new Error(`history: move of ${op.key}, which no earlier change created`);
        this.detach(e);
        this.place(e, op.anchor!);
        return "moved";
      }
    }
  }

  /** Run after every change. Two prose units that a merge left adjacent with no
   *  blank line between them would read back as ONE paragraph, so the earlier
   *  one gains a blank line. A single save never triggers this (its units are
   *  the tiling of the text it saved); it only fires where concurrent changes
   *  interleave, and running it after each change keeps a replay from the
   *  start and a replay from the snapshot identical. */
  settle(): void {
    const alive = this.entries.filter((x) => x.alive);
    for (let i = 0; i + 1 < alive.length; i++) {
      const a = alive[i]!, b = alive[i + 1]!;
      const aLast = a.lines[a.lines.length - 1] ?? "";
      const b0 = b.lines[0] ?? "";
      const aFenced = FENCE_OPEN.test(a.lines[0] ?? "");
      if (!aFenced && !isBlank(aLast) && !isBlank(b0) && !FENCE_OPEN.test(b0)) a.lines.push("");
    }
  }

  /** The document text: the live blocks, in order. */
  text(): string {
    return this.entries.filter((x) => x.alive).flatMap((x) => x.lines).join("\n");
  }

  /** Apply one change's operations, then settle. */
  applyChange(c: Change, blobs: Map<string, string>): void {
    for (const op of c.ops) this.apply(op, blobs);
    this.settle();
  }
}

/** Ancestor sets as bitsets, for "did this change know about that one?". */
class Ancestry {
  private index = new Map<string, number>();
  private bits: Uint32Array[] = [];
  constructor(order: Change[]) {
    const words = Math.ceil(order.length / 32) || 1;
    order.forEach((c, i) => this.index.set(c.id, i));
    order.forEach((c, i) => {
      const b = new Uint32Array(words);
      for (const p of c.parents) {
        const j = this.index.get(p);
        if (j === undefined) continue;
        b[j >> 5] = (b[j >> 5] ?? 0) | (1 << (j & 31));
        const pb = this.bits[j]!;
        for (let w = 0; w < words; w++) b[w] = (b[w] ?? 0) | (pb[w] ?? 0);
      }
      this.bits[i] = b;
    });
  }
  /** Is `a` an ancestor of `c`? */
  isAncestor(a: string, c: string): boolean {
    const i = this.index.get(a), j = this.index.get(c);
    if (i === undefined || j === undefined) return false;
    return (this.bits[j]![i >> 5]! & (1 << (i & 31))) !== 0;
  }
  ancestorCount(c: string): number {
    const j = this.index.get(c);
    if (j === undefined) return 0;
    let n = 0;
    for (const w of this.bits[j]!) { let v = w; while (v) { v &= v - 1; n++; } }
    return n;
  }
}

interface Replayed { model: Model; text: string; lost: LostEdit[] }

/** Replay changes (already in replay order) from an empty document. */
function replay(order: Change[], blobs: Map<string, string>, ancestry?: Ancestry): Replayed {
  const model = new Model();
  const lost: LostEdit[] = [];
  const writer = new Map<string, string>();   // key -> change that last set its content
  const remover = new Map<string, string>();  // key -> change that removed it
  for (const c of order) {
    for (const op of c.ops) {
      const before = model.get(op.key)?.lines.join("\n");
      const r = model.apply(op, blobs);
      if (!ancestry) continue;
      const concurrent = (other?: string): other is string => !!other && other !== c.id && !ancestry.isAncestor(other, c.id);
      if (r === "updated") {
        const w = writer.get(op.key);
        if (concurrent(w) && before !== model.get(op.key)!.lines.join("\n")) lost.push({ key: op.key, kept: c.id, lost: w, how: "overwritten" });
        writer.set(op.key, c.id);
      } else if (r === "ignored") {
        const rm = remover.get(op.key);
        if (concurrent(rm)) lost.push({ key: op.key, kept: rm, lost: c.id, how: "edited-after-remove" });
      } else if (r === "removed") {
        const w = writer.get(op.key);
        if (concurrent(w)) lost.push({ key: op.key, kept: c.id, lost: w, how: "removed" });
        remover.set(op.key, c.id);
      } else if (r === "created" || r === "resurrected") {
        writer.set(op.key, c.id);
        remover.delete(op.key);
      }
    }
    model.settle();
  }
  return { model, text: model.text(), lost };
}

/** Every ancestor of `id`, and `id`. */
function closure(changes: Map<string, Change>, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const x = stack.pop()!;
    if (out.has(x)) continue;
    const c = changes.get(x);
    if (!c) throw new Error(`history: change ${x} is missing (a parent nothing records)`);
    out.add(x);
    stack.push(...c.parents);
  }
  return out;
}

export function headsOf(changes: Map<string, Change>): string[] {
  const named = new Set<string>();
  for (const c of changes.values()) for (const p of c.parents) named.add(p);
  return [...changes.keys()].filter((id) => !named.has(id)).sort();
}

/** The document at one change: that change and everything it followed, replayed. */
export function reconstruct(h: History, id: string): string {
  const c = h.changes.get(id);
  if (!c) throw new Error(`history: unknown change ${id}`);
  return replay(replayOrder(h.changes, closure(h.changes, id)), h.blobs).text;
}

/** The current state: the snapshot when it names the current heads, else a replay. */
function current(h: History): { heads: string[]; model: Model; text: string } {
  const heads = headsOf(h.changes);
  const s = h.snapshot;
  if (s && s.heads.length === heads.length && s.heads.every((x, i) => x === heads[i])) {
    return { heads, model: new Model(s.entries), text: s.text };
  }
  const r = replay(replayOrder(h.changes), h.blobs);
  return { heads, model: r.model, text: r.text };
}

// ---------------------------------------------------------------------------
// Reading and writing the sidecar
// ---------------------------------------------------------------------------

function emptyHistory(nl: string): History {
  return { nl, changes: new Map(), blobs: new Map(), problems: [], converted: false };
}

function parseText(raw: string): History {
  const { lf, nl } = textOf(raw);
  if (isLegacy(lf)) return convertLegacy(lf, nl);
  const h = emptyHistory(nl);
  const lines = lf.split("\n");
  let snap: { heads: string[]; hash: string; newline: "lf" | "crlf"; text: string } | undefined;
  let units: string[] | undefined;
  for (const b of locate(lines)) {
    const body = lines.slice(b.start + 1, b.end).join("\n");
    const a = attrs(b.attrLine);
    if (b.type === "history-change") {
      const id = a.get("id") ?? "";
      if (h.changes.has(id)) { h.problems.push(`two changes share the id ${id}`); continue; }
      h.changes.set(id, {
        id,
        parents: (a.get("parents") ?? "").split(/\s+/).filter(Boolean),
        author: a.get("author"),
        summary: a.get("summary"),
        newline: a.get("newline") === "crlf" ? "crlf" : "lf",
        state: a.get("state") ?? "",
        was: a.get("was"),
        ops: parseOps(body),
      });
    } else if (b.type === "history-blob" && b.id) {
      if (h.blobs.has(b.id) && h.blobs.get(b.id) !== body) h.problems.push(`two blobs share the id ${b.id}`);
      h.blobs.set(b.id, body);
    } else if (b.type === "history-snapshot") {
      if (snap) { h.problems.push("the sidecar holds more than one snapshot"); continue; }
      snap = {
        heads: (a.get("heads") ?? "").split(/\s+/).filter(Boolean).sort(),
        hash: a.get("hash") ?? "",
        newline: a.get("newline") === "crlf" ? "crlf" : "lf",
        text: body,
      };
    } else if (b.type === "history-units") {
      units = body.split("\n").filter((l) => l.trim() !== "");
    }
  }
  if (snap) {
    const textLines = snap.text.split("\n");
    const entries: Entry[] = [];
    let at = 0;
    let ok = !!units;
    for (const u of units ?? []) {
      const t = u.trim();
      if (t.startsWith("-")) { entries.push({ key: t.slice(1), lines: [], alive: false }); continue; }
      const m = /^(\S+)\s+(\d+)$/.exec(t);
      if (!m) { ok = false; break; }
      const n = Number(m[2]);
      entries.push({ key: m[1]!, lines: textLines.slice(at, at + n), alive: true });
      at += n;
    }
    if (ok && at === textLines.length) h.snapshot = { ...snap, entries };
    else h.problems.push("the snapshot's unit list does not cover its text");
  }
  return h;
}

/** Read a sidecar; an earlier-format one is converted in memory. A file that
 *  holds no change at all was not written by this tool (every write records
 *  one), so it is refused rather than treated as an empty history — a save on
 *  top of it would otherwise overwrite whatever it is. */
export function loadHistory(path: string): History {
  const h = parseText(readFileSync(path, "utf8"));
  if (h.changes.size === 0) throw new Error(`history: unknown revision — ${baseNameOf(path)} records no changes; it is not a sidecar this tool wrote`);
  return h;
}

function render(h: History, baseName: string): string {
  const order = replayOrder(h.changes);
  const s = h.snapshot!;
  const parts: string[] = [`# History of ${baseName}\n`];
  parts.push(
    "=== meta\n" +
    'profile      = "geml-history/v1"\n' +
    `history-of   = "${baseName}"\n` +
    `geml-version = "${GEML_LANGUAGE_VERSION}"\n` +
    "===\n",
  );
  const sf = fenceFor(s.text);
  parts.push(`${sf} history-snapshot {heads="${s.heads.join(" ")}" hash="${s.hash}" newline=${s.newline}}\n${s.text}\n${sf}\n`);
  parts.push(`=== history-units\n${s.entries.map((e) => (e.alive ? `${e.key} ${e.lines.length}` : `-${e.key}`)).join("\n")}${s.entries.length ? "\n" : ""}===\n`);
  const written = new Set<string>();
  for (const c of [...order].reverse()) {
    const at = [
      `id="${c.id}"`,
      c.parents.length ? `parents="${c.parents.join(" ")}"` : "",
      c.author ? `author=${quoteAttr(c.author)}` : "",
      c.summary ? `summary=${quoteAttr(c.summary)}` : "",
      `newline=${c.newline}`,
      `state="${c.state}"`,
      c.was ? `was="${c.was}"` : "",
    ].filter(Boolean).join(" ");
    parts.push(`=== history-change {${at}}\n${c.ops.map(opLine).join("\n")}${c.ops.length ? "\n" : ""}===\n`);
    for (const op of c.ops) {
      if (!op.blob || written.has(op.blob)) continue;
      written.add(op.blob);
      const payload = h.blobs.get(op.blob)!;
      const bf = fenceFor(payload);
      parts.push(`${bf} history-blob {#${op.blob} lang=geml}\n${payload}\n${bf}\n`);
    }
  }
  return parts.join("\n");
}

function writeHistory(path: string, h: History, baseName: string): void {
  writeBytes(path, render(h, baseName), h.nl);
}

const baseNameOf = (p: string): string => p.replace(/^.*[\\/]/, "");

// ---------------------------------------------------------------------------
// Diff: the live document against the current state, as operations
// ---------------------------------------------------------------------------

interface LiveUnit { lines: string[]; body: string; full: string; idKey?: string }

function liveUnits(lf: string): LiveUnit[] {
  const lines = lf.split("\n");
  const seen = new Set<string>();
  return tile(lines).map((u) => {
    const ls = lines.slice(u.start, u.endExcl);
    let idKey: string | undefined;
    if (u.id && !seen.has(`#${u.id}`)) { idKey = `#${u.id}`; seen.add(idKey); }
    return { lines: ls, body: lines.slice(u.start, u.bodyEnd).join("\n"), full: ls.join("\n"), idKey };
  });
}

const bodyOf = (lines: string[]): string => {
  let n = lines.length;
  while (n > 0 && isBlank(lines[n - 1]!)) n--;
  return lines.slice(0, n).join("\n");
};

/** Longest increasing subsequence of `seq` (values are positions); returns the
 *  indexes into `seq` that form it. */
function lis(seq: number[]): number[] {
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  for (let x = 0; x < seq.length; x++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]!]! < seq[x]!) lo = mid + 1; else hi = mid; }
    prev[x] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = x;
  }
  const out: number[] = [];
  for (let cur = tails.length ? tails[tails.length - 1]! : -1; cur >= 0; cur = prev[cur]!) out.push(cur);
  return out.reverse();
}

/** Make each string unique by its occurrence count, so equal paragraphs pair up in order. */
function occurrences(xs: string[]): string[] {
  const n = new Map<string, number>();
  return xs.map((x) => { const k = n.get(x) ?? 0; n.set(x, k + 1); return `${k}\u0000${x}`; });
}

interface DiffResult { ops: Op[]; blobs: Map<string, string> }

function diff(model: Model, lf: string, seed: string): DiffResult {
  const live = liveUnits(lf);
  const old = model.entries.filter((e) => e.alive);
  const oldIdx = new Map(old.map((e, i) => [e, i]));
  const matchOld = new Array<number>(live.length).fill(-1);   // live i -> old index
  const oldTaken = new Array<boolean>(old.length).fill(false);

  // 1. Units with an id pair by id. One whose entry is a tombstone stays
  //    unmatched: its `create` brings the block back.
  live.forEach((u, i) => {
    if (!u.idKey) return;
    const e = model.get(u.idKey);
    if (e?.alive) { matchOld[i] = oldIdx.get(e)!; oldTaken[matchOld[i]!] = true; }
  });

  // 2. Units without one pair by identical text, in order first, then out of order.
  const oldFree = old.map((_, i) => i).filter((i) => !oldTaken[i] && old[i]!.key.startsWith("~"));
  const liveFree = live.map((_, i) => i).filter((i) => !live[i]!.idKey);
  const oldTok = occurrences(oldFree.map((i) => bodyOf(old[i]!.lines)));
  const liveTok = occurrences(liveFree.map((i) => live[i]!.body));
  const posInOld = new Map(oldTok.map((t, j) => [t, j]));
  const pairs: [number, number][] = [];
  liveTok.forEach((t, j) => { const o = posInOld.get(t); if (o !== undefined) pairs.push([o, j]); });
  for (const [o, j] of pairs) { matchOld[liveFree[j]!] = oldFree[o]!; oldTaken[oldFree[o]!] = true; }

  // 3. The pairs that keep their relative order stay put; the rest move.
  const matched = live.map((_, i) => i).filter((i) => matchOld[i]! >= 0);
  const keep = new Set(lis(matched.map((i) => matchOld[i]!)).map((k) => matched[k]!));

  // 4. Between two kept neighbours, leftover old and live units without ids pair
  //    by position: a paragraph edited in place is still the same block.
  const anchorsLive = [-1, ...[...keep].sort((a, b) => a - b), live.length];
  for (let g = 0; g + 1 < anchorsLive.length; g++) {
    const l1 = anchorsLive[g]!, l2 = anchorsLive[g + 1]!;
    const o1 = l1 < 0 ? -1 : matchOld[l1]!, o2 = l2 >= live.length ? old.length : matchOld[l2]!;
    const ol: number[] = [];
    for (let o = o1 + 1; o < o2; o++) if (!oldTaken[o] && old[o]!.key.startsWith("~")) ol.push(o);
    const lv: number[] = [];
    for (let i = l1 + 1; i < l2; i++) if (matchOld[i]! < 0 && !live[i]!.idKey) lv.push(i);
    const n = Math.min(ol.length, lv.length);
    for (let k = 0; k < n; k++) { matchOld[lv[k]!] = ol[k]!; oldTaken[ol[k]!] = true; keep.add(lv[k]!); }
  }

  // 5. Keys for what is new: an id when the unit has one, else a fresh `~` key.
  const used = new Set<string>(model.keys());
  const keys = live.map((u, i) => {
    if (matchOld[i]! >= 0) return old[matchOld[i]!]!.key;
    if (u.idKey) return u.idKey;
    for (let salt = 0; ; salt++) {
      const k = `~${sha256Hex(`${seed}\n${i}\n${salt}\n${u.full}`).slice(0, 8)}`;
      if (!used.has(k)) { used.add(k); return k; }
    }
  });

  const ops: Op[] = [];
  const blobs = new Map<string, string>();
  const blobFor = (payload: string): string => { const id = blobId(payload); blobs.set(id, payload); return id; };
  old.forEach((e, o) => { if (!oldTaken[o]) ops.push({ kind: "remove", key: e.key }); });
  live.forEach((u, i) => {
    if (matchOld[i]! >= 0 && old[matchOld[i]!]!.lines.join("\n") !== u.full) ops.push({ kind: "update", key: keys[i]!, blob: blobFor(u.full) });
  });
  let prev: string | undefined;
  live.forEach((u, i) => {
    const anchor: Anchor = prev === undefined ? "at-start" : { after: prev };
    if (matchOld[i]! < 0) ops.push({ kind: "create", key: keys[i]!, anchor, blob: blobFor(u.full) });
    else if (!keep.has(i)) ops.push({ kind: "move", key: keys[i]!, anchor });
    prev = keys[i]!;
  });
  return { ops, blobs };
}

// ---------------------------------------------------------------------------
// Recording a change
// ---------------------------------------------------------------------------

interface Recorded { id: string; state: string; entries: Entry[] }

/** Append one change that takes the current state to `lf`. Throws, writing
 *  nothing, when the operations do not reproduce `lf` exactly. */
function record(h: History, lf: string, nl: string, stamp: string, meta: { author?: string; summary?: string; was?: string }, force = false): Recorded | undefined {
  const cur = current(h);
  const seed = `${stamp}\n${meta.author ?? ""}`;
  const d = diff(cur.model, lf, seed);
  if (d.ops.length === 0 && cur.heads.length <= 1 && !force && h.changes.size > 0) return undefined;
  const check = new Model(cur.model.entries);
  for (const [k, v] of d.blobs) h.blobs.set(k, v);
  for (const op of d.ops) check.apply(op, h.blobs);
  check.settle();
  if (check.text() !== lf) {
    throw new Error("history: the recorded operations do NOT reproduce the document; nothing was saved");
  }
  const body: Omit<Change, "id"> = {
    parents: cur.heads, author: meta.author, summary: meta.summary,
    newline: nlNamed(nl), state: fullHash(lf, nl), was: meta.was, ops: d.ops,
  };
  const id = changeId(stamp, body, h.blobs);
  h.changes.set(id, { id, ...body });
  h.snapshot = { heads: [id], hash: body.state, newline: body.newline, text: lf, entries: check.entries };
  return { id, state: body.state, entries: check.entries };
}

function convertLegacy(lf: string, nl: string): History {
  const h = emptyHistory(nl);
  h.converted = true;
  for (const r of readLegacy(lf)) {
    record(h, r.text, nlOf(r.newline) ?? nl, stampOf(r.id), { author: r.author, summary: r.summary, was: r.id }, true);
  }
  return h;
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

export interface SaveOpts { gemlPath: string; historyPath: string; summary: string; author?: string; at?: Date; }

/** Record the live file as a change. With nothing to record, returns the head it already is. */
export function save(o: SaveOpts): { id: string; hash: string } {
  // A summary is one attribute on one line; §4 has no escape for a newline, so
  // a summary carrying one would end the change's attribute line and forge the
  // lines after it. Refused by name.
  for (const [k, v] of [["summary", o.summary], ["author", o.author]] as const) {
    if (v !== undefined && /[\r\n]/.test(v)) throw new Error(`${k} must be a single line: a newline would end the change's attribute line and start new lines of the sidecar`);
  }
  const { lf, nl } = loadBytes(o.gemlPath);
  const h = existsSync(o.historyPath) ? loadHistory(o.historyPath) : emptyHistory(nl);
  const r = record(h, lf, nl, stampUTC(o.at ?? new Date()), { author: o.author, summary: o.summary });
  if (!r) {
    if (h.converted) writeHistory(o.historyPath, h, baseNameOf(o.gemlPath));
    const head = headsOf(h.changes)[0]!;
    return { id: head, hash: h.changes.get(head)!.state };
  }
  if (!existsSync(o.historyPath)) h.nl = nl;
  writeHistory(o.historyPath, h, baseNameOf(o.gemlPath));
  return { id: r.id, hash: r.state };
}

export interface VerifyResult { ok: boolean; errors: string[]; warnings: string[]; checked: number; }

function lostWarning(l: LostEdit, h: History): string {
  const who = (id: string): string => { const a = h.changes.get(id)?.author; return a ? `${id} (${a})` : id; };
  if (l.how === "overwritten") return `concurrent edits to ${l.key}: kept ${who(l.kept)}, superseded ${who(l.lost)}`;
  if (l.how === "removed") return `${l.key} was removed by ${who(l.kept)} while ${who(l.lost)} edited it; the edit is in the history`;
  return `${who(l.lost)} edited ${l.key} after ${who(l.kept)} removed it; the edit is in the history`;
}

export function verify(historyPath: string, gemlPath?: string): VerifyResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  // A sidecar that cannot be READ is the caller's error to word (it names the
  // path); one that reads but does not parse is a verify failure.
  const raw = readFileSync(historyPath, "utf8");
  let h: History;
  try { h = parseText(raw); } catch (e) { return { ok: false, errors: [(e as Error).message], warnings, checked: 0 }; }
  if (h.changes.size === 0) return { ok: false, errors: ["the sidecar records no changes"], warnings, checked: 0 };
  errors.push(...h.problems);
  if (h.converted) warnings.push("the sidecar is in the earlier format; the next save rewrites it as a change graph");
  for (const [k, v] of h.blobs) if (blobId(v) !== k) errors.push(`blob ${k} does not match its content`);
  for (const c of h.changes.values()) {
    for (const p of c.parents) if (!h.changes.has(p)) errors.push(`change ${c.id}: parent ${p} is missing`);
    for (const op of c.ops) if (op.blob && !h.blobs.has(op.blob)) errors.push(`change ${c.id}: unresolved blob:${op.blob}`);
    if (!h.converted) {
      const { id: _id, ...body } = c;
      if (changeId(stampOf(c.id), body, h.blobs) !== c.id) errors.push(`change ${c.id}: the id does not match its content`);
    }
  }
  let order: Change[];
  try { order = replayOrder(h.changes); } catch (e) { return { ok: false, errors: [(e as Error).message], warnings, checked: 0 }; }
  const anc = new Ancestry(order);
  let checked = 0;
  // States are checked incrementally while each change's ancestors are exactly
  // the changes before it in the order; a change that runs alongside another
  // branch is replayed on its own.
  const running = new Model();
  for (let i = 0; i < order.length; i++) {
    const c = order[i]!;
    try {
      running.applyChange(c, h.blobs);
      let text: string;
      if (anc.ancestorCount(c.id) === i) {
        text = running.text();
      } else {
        text = replay(replayOrder(h.changes, closure(h.changes, c.id)), h.blobs).text;
      }
      if (fullHash(text, nlOf(c.newline)!) !== c.state) errors.push(`change ${c.id}: the document it replays to does not match its recorded state`);
      checked++;
    } catch (e) {
      errors.push(`change ${c.id}: ${(e as Error).message}`);
    }
  }
  let all: Replayed;
  try { all = replay(order, h.blobs, anc); } catch {
    // The failing change is already reported above; there is no whole state to compare.
    return { ok: false, errors: [...new Set(errors)], warnings, checked };
  }
  for (const l of all.lost) warnings.push(lostWarning(l, h));
  const heads = headsOf(h.changes);
  if (heads.length > 1) warnings.push(`the history has ${heads.length} heads; the next save or \`geml history merge\` joins them`);
  const s = h.snapshot;
  if (!h.converted) {
    if (!s) errors.push("the sidecar has no snapshot");
    else if (s.heads.join(" ") !== heads.join(" ")) warnings.push("the snapshot is older than the change graph; the next save refreshes it");
    else if (s.text !== all.text || fullHash(s.text, nlOf(s.newline)!) !== s.hash) errors.push("the snapshot does not match the document its heads replay to");
  }
  if (gemlPath && existsSync(gemlPath)) {
    const { lf, nl } = loadBytes(gemlPath);
    if (lf !== all.text || (heads.length === 1 && fullHash(lf, nl) !== h.changes.get(heads[0]!)!.state)) {
      warnings.push("uncommitted changes: the live file differs from the history's current state");
    }
  }
  const unique = [...new Set(errors)];
  return { ok: unique.length === 0, errors: unique, warnings, checked };
}

export interface RestoreOpts { historyPath: string; gemlPath: string; revision: string; write?: boolean; force?: boolean; at?: Date; }

/** The document at a change. With `write`, the live file becomes it and that is
 *  recorded as a new change — nothing in the history is discarded. */
export function restore(o: RestoreOpts): string {
  const h = loadHistory(o.historyPath);
  const target = resolveRevision(h, o.revision);
  const content = checkedState(h, target);
  if (o.write) {
    if (existsSync(o.gemlPath) && !o.force && !isCurrentIn(h, o.gemlPath)) {
      throw new Error("history: uncommitted changes in doc.geml; rerun with force to discard them, or save first");
    }
    const nl = nlOf(h.changes.get(target)!.newline)!;
    writeBytes(o.gemlPath, content, nl);
    save({ gemlPath: o.gemlPath, historyPath: o.historyPath, summary: `restore to ${target}`, at: o.at });
  }
  return content;
}

export interface MergeOpts { historyPath: string; otherPath: string; gemlPath?: string; force?: boolean; at?: Date; author?: string }
export interface MergeResult { id?: string; added: number; lost: string[] }

/** Add `b`'s changes and blobs to `a`. Returns how many changes were new. */
function union(a: History, b: History): number {
  const problems: string[] = [];
  for (const [k, v] of b.blobs) {
    if (a.blobs.has(k) && a.blobs.get(k) !== v) problems.push(`two blobs share the id ${k}`);
    else a.blobs.set(k, v);
  }
  let added = 0;
  for (const [k, c] of b.changes) {
    const mine = a.changes.get(k);
    if (!mine) { a.changes.set(k, c); added++; continue; }
    if (JSON.stringify(mine) !== JSON.stringify(c)) problems.push(`two different changes share the id ${k}`);
  }
  if (problems.length) throw new Error(`history: cannot merge — ${problems.join("; ")}`);
  return added;
}

function joinHeads(h: History, stamp: string, author?: string): string | undefined {
  const heads = headsOf(h.changes);
  if (heads.length <= 1) {
    const r = replay(replayOrder(h.changes), h.blobs);
    h.snapshot = { heads, hash: heads.length ? h.changes.get(heads[0]!)!.state : fullHash(r.text, h.nl), newline: heads.length ? h.changes.get(heads[0]!)!.newline : nlNamed(h.nl), text: r.text, entries: r.model.entries };
    return undefined;
  }
  const r = replay(replayOrder(h.changes), h.blobs);
  const newline = h.changes.get(heads[heads.length - 1]!)!.newline;
  const body: Omit<Change, "id"> = { parents: heads, author, summary: "Merge", newline, state: fullHash(r.text, nlOf(newline)!), ops: [] };
  const id = changeId(stamp, body, h.blobs);
  h.changes.set(id, { id, ...body });
  h.snapshot = { heads: [id], hash: body.state, newline, text: r.text, entries: r.model.entries };
  return id;
}

/** Take the union of two sidecars of one document, join their heads with a
 *  merge change, and (with `gemlPath`) write the merged document to the live file. */
export function merge(o: MergeOpts): MergeResult {
  const a = loadHistory(o.historyPath);
  if (o.gemlPath && existsSync(o.gemlPath) && !o.force && a.changes.size > 0 && !isCurrentIn(a, o.gemlPath)) {
    throw new Error("history: uncommitted changes in the live file; save first, or rerun with force to discard them");
  }
  const b = loadHistory(o.otherPath);
  const added = union(a, b);
  const id = joinHeads(a, stampUTC(o.at ?? new Date()), o.author);
  const order = replayOrder(a.changes);
  const lost = replay(order, a.blobs, new Ancestry(order)).lost.map((l) => lostWarning(l, a));
  const baseName = o.gemlPath ? baseNameOf(o.gemlPath) : baseNameOf(o.historyPath).replace(/\.gemlhistory$/, ".geml");
  writeHistory(o.historyPath, a, baseName);
  if (o.gemlPath) writeBytes(o.gemlPath, a.snapshot!.text, nlOf(a.snapshot!.newline)!);
  return { id, added, lost };
}

/** git merge driver: union `theirs` into `ours` (written in place). The live
 *  `.geml` is merged by git itself; the next save records whatever it holds. */
export function mergeDriver(oursPath: string, theirsPath: string, at?: Date): void {
  const a = loadHistory(oursPath);
  const b = loadHistory(theirsPath);
  union(a, b);
  joinHeads(a, stampUTC(at ?? new Date()));
  const m = /^# History of (.+)$/m.exec(readFileSync(oursPath, "utf8"));
  writeHistory(oursPath, a, m?.[1] ?? "doc.geml");
}

/** Register the merge driver for this repository: `.gitattributes` names it,
 *  `.git/config` defines it (git keeps driver commands out of the tree). */
export function setupGit(dir: string): string[] {
  const done: string[] = [];
  const attrPath = join(dir, ".gitattributes");
  const line = "*.gemlhistory merge=geml-history";
  const cur = existsSync(attrPath) ? readFileSync(attrPath, "utf8") : "";
  if (!cur.split(/\r?\n/).includes(line)) {
    writeFileSync(attrPath, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n");
    done.push(`.gitattributes: ${line}`);
  }
  for (const [k, v] of [["merge.geml-history.name", "union of geml-history change graphs"], ["merge.geml-history.driver", "geml history merge-driver %O %A %B"]] as const) {
    const r = spawnSync("git", ["config", k, v], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git config ${k} failed: ${(r.stderr || "").trim() || "is this a git repository?"}`);
    done.push(`git config ${k} "${v}"`);
  }
  return done;
}

// ---------------------------------------------------------------------------
// Read-only queries — power the CLI's `history get` and `revert`
// ---------------------------------------------------------------------------

export interface RevisionInfo {
  id: string; parents: string[]; author?: string; summary?: string; hash: string;
  offset: number;   // 0 = the latest change in replay order, 1 = the one before it, …
  current: boolean;
  head: boolean;
}

function isCurrentIn(h: History, gemlPath: string): boolean {
  const heads = headsOf(h.changes);
  if (heads.length !== 1) return false;
  const { lf, nl } = loadBytes(gemlPath);
  return fullHash(lf, nl) === h.changes.get(heads[0]!)!.state;
}

/** Is the live file exactly the history's single head? False means unsaved
 *  drift, or heads that a save has yet to join. */
export function isCurrent(historyPath: string, gemlPath: string): boolean {
  let h: History;
  // A sidecar that cannot be read is not one the file matches; the save that
  // follows is what refuses it, with the reason.
  try { h = loadHistory(historyPath); } catch { return false; }
  return isCurrentIn(h, gemlPath);
}

/** Changes, latest first in replay order, each tagged with its `-N` offset. */
export function listRevisions(historyPath: string): RevisionInfo[] {
  const h = loadHistory(historyPath);
  const heads = new Set(headsOf(h.changes));
  return [...replayOrder(h.changes)].reverse().map((c, i) => ({
    id: c.id, parents: c.parents, author: c.author, summary: c.summary, hash: c.state,
    offset: i, current: i === 0, head: heads.has(c.id),
  }));
}

/** Resolve a selector to a change id, for every command that takes one:
 *  `0` (the current head), `-N` (N changes back in replay order), or an
 *  unambiguous id — prefix, suffix or exact, of its id or of the id it had in
 *  the earlier sidecar format. */
export function resolveRevision(h: History, selector: string): string {
  const order = [...replayOrder(h.changes)].reverse();
  if (/^(0|-\d+)$/.test(selector)) {
    const n = Math.abs(Number(selector));
    if (n === 0) {
      const heads = headsOf(h.changes);
      if (heads.length > 1) throw new Error(`history: ${heads.length} heads and no change joining them — run \`geml history save\` to join them`);
    }
    if (n >= order.length) throw new Error(`history: offset ${selector} is out of range (only ${order.length} revision(s))`);
    return order[n]!.id;
  }
  const hit = (x: string | undefined): boolean => !!x && (x === selector || x.startsWith(selector) || x.endsWith(selector));
  const matches = order.filter((c) => hit(c.id) || hit(c.was)).map((c) => c.id);
  if (matches.length !== 1) throw new Error(`history: revision selector "${selector}" matched ${matches.length} revisions`);
  return matches[0]!;
}

// Content handed to a caller — what `revert` splices into the document — must
// match the state recorded for its change; a read that skipped this would let a
// hand-edited sidecar put altered text into the file under a real change's name.
function checkedState(h: History, id: string): string {
  const text = reconstruct(h, id);
  const c = h.changes.get(id)!;
  if (fullHash(text, nlOf(c.newline)!) !== c.state) {
    throw new Error(`history: change ${id} does not match its recorded state — the sidecar was changed by something other than \`geml history\`; run \`geml history verify\``);
  }
  return text;
}

export function resolveContent(historyPath: string, selector: string): { id: string; text: string } {
  const h = loadHistory(historyPath);
  const id = resolveRevision(h, selector);
  return { id, text: checkedState(h, id) };
}

/** Walk the changes latest→earliest and return the first whose document holds
 *  the block (as `pick` extracts it) in a form other than `currentBlock` — the
 *  block's previous distinct version, skipping changes where it is absent.
 *  Used by `revert --rev changed`. */
export function firstChangedContent(
  historyPath: string,
  currentBlock: string,
  pick: (fullText: string) => string | undefined,
): { id: string; text: string } | undefined {
  const h = loadHistory(historyPath);
  for (const c of [...replayOrder(h.changes)].reverse()) {
    const text = checkedState(h, c.id);
    const b = pick(text);
    if (b !== undefined && b !== currentBlock) return { id: c.id, text };
  }
  return undefined;
}
