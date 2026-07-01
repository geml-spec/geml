// GEML History extension — commit / restore / verify.
//
// Implements the `.gemlhistory` companion spec: a self-contained, reverse-delta
// version history beside the live `.geml` file. The history file is itself a
// GEML document (meta + keyframe + revision + blob blocks). Reverse patches and
// hashes are tool-generated here; every commit re-applies its reverse patch and
// asserts a byte-exact round-trip before writing (the spec's verify gate).
//
// Revision id = `<YYYYMMDDTHHMMSSZ>-<first 8 hex of the version content hash>`.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Bytes, newlines, hashing
// ---------------------------------------------------------------------------

interface Loaded { lf: string; nl: string; }

function loadBytes(path: string): Loaded {
  const raw = readFileSync(path);
  const nl = raw.includes(13) /* \r */ && raw.includes(10) ? "\r\n" : "\n";
  return { lf: raw.toString("utf8").replace(/\r\n/g, "\n"), nl };
}

function bytesOf(lf: string, nl: string): Buffer {
  return Buffer.from(lf.replace(/\n/g, nl), "utf8");
}

function writeBytes(path: string, lf: string, nl: string): void {
  writeFileSync(path, bytesOf(lf, nl));
}

function fullHash(lf: string, nl: string): string {
  return "sha256:" + createHash("sha256").update(bytesOf(lf, nl)).digest("hex");
}

function shortOf(hash: string): string {
  return hash.replace(/^sha256:/, "").slice(0, 8);
}

function makeId(stamp: string, hash: string): string {
  return `${stamp}-${shortOf(hash)}`;
}

/** UTC basic ISO-8601, e.g. 20260617T103012Z. */
export function stampUTC(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

// ---------------------------------------------------------------------------
// Top-level fenced-block locator (for the history file's own structure)
// ---------------------------------------------------------------------------

const FENCE_OPEN = /^(={3,})[ \t]+([A-Za-z][A-Za-z0-9_-]*)[ \t]*(\{.*\})?[ \t]*$/;

interface Located { type: string; id?: string; attrLine: string; fenceLen: number; start: number; end: number; }

function locate(lines: string[]): Located[] {
  const out: Located[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = FENCE_OPEN.exec(lines[i]!);
    if (m) {
      const fenceLen = m[1]!.length;
      const attrLine = m[3] ?? "";
      const idm = /#([A-Za-z][A-Za-z0-9_-]*)/.exec(attrLine);
      let j = i + 1;
      while (j < lines.length) {
        const t = lines[j]!.replace(/\s+$/, "");
        if (/^=+$/.test(t) && t.length === fenceLen) break;
        j++;
      }
      out.push({ type: m[2]!, id: idm?.[1], attrLine, fenceLen, start: i, end: Math.min(j, lines.length - 1) });
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

function attr(attrLine: string, key: string): string | undefined {
  const m = new RegExp(`${key}=("([^"]*)"|[^\\s}]+)`).exec(attrLine);
  return m ? (m[2] !== undefined ? m[2] : m[1]) : undefined;
}

function fenceFor(contentLf: string): string {
  let longest = 0;
  for (const line of contentLf.split("\n")) {
    const m = /^=+/.exec(line);
    if (m) longest = Math.max(longest, m[0].length);
  }
  return "=".repeat(Math.max(longest + 1, 3));
}

// ---------------------------------------------------------------------------
// Document units & reverse-patch engine (gap-aware)
// ---------------------------------------------------------------------------

// Unit-key = `#id` (explicit), or `@<8hex content hash>` (derived) with `~n`
// disambiguating equal-content units by document-order occurrence (§4).
const KEY = String.raw`(#[A-Za-z][A-Za-z0-9_-]*|@[0-9a-f]+(?:~\d+)?)`;

function sha8(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex").slice(0, 8);
}

// A UNIT covers a maximal run: a fenced block OR a flow segment (heading /
// paragraph / list), plus the blank lines that follow it. Units tile every
// line, so joining them reproduces the document byte-for-byte — and because
// prose segments are units too, positions amid prose are anchorable (gap-aware).
interface Unit { start: number; bodyEnd: number; endExcl: number; id?: string }

function tile(lines: string[]): Unit[] {
  const units: Unit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const start = i;
    if (lines[i]!.trim() === "") { // leading / standalone blank run
      while (i < n && lines[i]!.trim() === "") i++;
      units.push({ start, bodyEnd: i, endExcl: i });
      continue;
    }
    const fo = FENCE_OPEN.exec(lines[i]!);
    let id: string | undefined;
    if (fo) {
      const fenceLen = fo[1]!.length;
      id = /#([A-Za-z][A-Za-z0-9_-]*)/.exec(fo[3] ?? "")?.[1];
      i++;
      while (i < n) {
        const t = lines[i]!.replace(/\s+$/, "");
        const close = /^=+$/.test(t) && t.length === fenceLen;
        i++;
        if (close) break;
      }
    } else { // flow segment: consecutive non-blank, non-fence lines
      i++;
      while (i < n && lines[i]!.trim() !== "" && !FENCE_OPEN.test(lines[i]!)) i++;
    }
    const bodyEnd = i;
    while (i < n && lines[i]!.trim() === "") i++; // own trailing blanks
    units.push({ start, bodyEnd, endExcl: i, id });
  }
  return units;
}

interface KeyedUnit { u: Unit; key: string }

function keyedUnits(lines: string[]): KeyedUnit[] {
  const counts = new Map<string, number>();
  return tile(lines).map((u) => {
    if (u.id) return { u, key: `#${u.id}` };
    const base = `@${sha8(lines.slice(u.start, u.bodyEnd).join("\n"))}`;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    return { u, key: n === 0 ? base : `${base}~${n}` };
  });
}

function locateUnit(lines: string[], key: string): Unit {
  const ku = keyedUnits(lines).find((x) => x.key === key);
  if (!ku) throw new Error(`history: unit ${key} not found while applying reverse patch`);
  return ku.u;
}

type Anchor = "at-start" | "at-end" | { after: string };
interface Op { kind: "delete" | "replace" | "insert" | "move"; key?: string; blob?: string; anchor?: Anchor }

function parseAnchor(s: string): Anchor {
  if (s === "at-start" || s === "at-end") return s;
  const m = new RegExp("^after\\s+" + KEY + "$").exec(s);
  if (!m) throw new Error(`history: bad anchor: ${s}`);
  return { after: m[1]! };
}

function anchorStr(a: Anchor): string {
  return a === "at-start" || a === "at-end" ? a : `after ${a.after}`;
}

function parseOps(body: string): Op[] {
  const ops: Op[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = new RegExp("^delete\\s+" + KEY + "$").exec(line))) {
      ops.push({ kind: "delete", key: m[1]! });
    } else if ((m = new RegExp("^replace\\s+" + KEY + "\\s+<-\\s+blob:(\\S+)$").exec(line))) {
      ops.push({ kind: "replace", key: m[1]!, blob: m[2]! });
    } else if ((m = /^insert\s+<-\s+blob:(\S+)\s+(.+)$/.exec(line))) {
      ops.push({ kind: "insert", blob: m[1]!, anchor: parseAnchor(m[2]!) });
    } else if ((m = new RegExp("^move\\s+" + KEY + "\\s+(.+)$").exec(line))) {
      ops.push({ kind: "move", key: m[1]!, anchor: parseAnchor(m[2]!) });
    } else {
      throw new Error(`history: unrecognized reverse-patch op: ${line}`);
    }
  }
  return ops;
}

// Each blob carries a unit's full text (its lines plus the blank lines it owns),
// so insert / replace are byte-exact without separate spacing bookkeeping.
function insertAt(lines: string[], anchor: Anchor, payload: string[]): void {
  if (anchor === "at-start") { lines.splice(0, 0, ...payload); return; }
  if (anchor === "at-end") { lines.push(...payload); return; }
  const a = locateUnit(lines, anchor.after);
  lines.splice(a.endExcl, 0, ...payload);
}

/** Apply a reverse patch to `textLf`, returning the parent-revision text. */
function applyReverse(textLf: string, ops: Op[], blobs: Map<string, string>): string {
  const lines = textLf.split("\n");
  const blob = (id: string): string[] => {
    const p = blobs.get(id);
    if (p === undefined) throw new Error(`history: unresolved blob:${id}`);
    return p.split("\n");
  };
  for (const op of ops) {
    if (op.kind === "delete") {
      const u = locateUnit(lines, op.key!);
      lines.splice(u.start, u.endExcl - u.start);
    } else if (op.kind === "replace") {
      const u = locateUnit(lines, op.key!);
      lines.splice(u.start, u.endExcl - u.start, ...blob(op.blob!));
    } else if (op.kind === "insert") {
      insertAt(lines, op.anchor!, blob(op.blob!));
    } else { // move: cut the unit (with its owned blanks) and re-insert at anchor
      const u = locateUnit(lines, op.key!);
      const cut = lines.slice(u.start, u.endExcl);
      lines.splice(u.start, u.endExcl - u.start);
      insertAt(lines, op.anchor!, cut);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Diff (forward v_parent -> v_new) producing a reverse patch (v_new -> v_parent)
// ---------------------------------------------------------------------------

interface Patch { ops: Op[]; blobs: { id: string; payload: string }[]; }

/** LCS alignment of unit-key sequences; aMatch[i] = matched index in b, or -1. */
function lcsMatch(a: string[], b: string[]): number[] {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const aMatch = new Array<number>(n).fill(-1);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { aMatch[i] = j; i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return aMatch;
}

function diffReverse(oldLf: string, newLf: string): Patch {
  const oldLines = oldLf.split("\n");
  const newLines = newLf.split("\n");
  const oldU = keyedUnits(oldLines);
  const newU = keyedUnits(newLines);
  const oldKeys = oldU.map((x) => x.key);
  const newKeys = newU.map((x) => x.key);
  const aMatch = lcsMatch(newKeys, oldKeys);
  const oldMatched = new Array<boolean>(oldU.length).fill(false);
  for (const j of aMatch) if (j >= 0) oldMatched[j] = true;

  const ops: Op[] = [];
  const blobs: { id: string; payload: string }[] = [];
  let blobN = 0;
  const addBlob = (payload: string): string => { const id = `b${++blobN}`; blobs.push({ id, payload }); return id; };
  const full = (lines: string[], u: Unit) => lines.slice(u.start, u.endExcl).join("\n");

  // 1. units in new but unmatched -> reverse delete
  for (let i = 0; i < newU.length; i++) if (aMatch[i] === -1) ops.push({ kind: "delete", key: newKeys[i]! });

  // 2. matched units whose full text differs (id'd content change, or spacing) -> reverse replace
  for (let i = 0; i < newU.length; i++) {
    const j = aMatch[i]!;
    if (j >= 0 && full(newLines, newU[i]!.u) !== full(oldLines, oldU[j]!.u)) {
      ops.push({ kind: "replace", key: newKeys[i]!, blob: addBlob(full(oldLines, oldU[j]!.u)) });
    }
  }

  // 3. units in old but unmatched -> reverse insert, in old order, anchored by predecessor
  for (let j = 0; j < oldU.length; j++) {
    if (!oldMatched[j]) {
      const prev = j > 0 ? oldKeys[j - 1]! : null;
      ops.push({ kind: "insert", blob: addBlob(full(oldLines, oldU[j]!.u)), anchor: prev ? { after: prev } : "at-start" });
    }
  }
  return { ops, blobs };
}

function opLine(op: Op): string {
  if (op.kind === "delete") return `delete ${op.key}`;
  if (op.kind === "replace") return `replace ${op.key} <- blob:${op.blob}`;
  if (op.kind === "insert") return `insert <- blob:${op.blob} ${anchorStr(op.anchor!)}`;
  return `move ${op.key} ${anchorStr(op.anchor!)}`;
}

// ---------------------------------------------------------------------------
// History document model
// ---------------------------------------------------------------------------

interface Revision { id: string; parent?: string; author?: string; summary?: string; hash: string; ops: Op[]; }

interface History {
  nl: string;
  current: string;
  keyframes: Map<string, string>; // id -> snapshot content (LF)
  revisions: Map<string, Revision>;
  blobs: Map<string, string>;
}

function parseHistory(path: string): History {
  const { lf, nl } = loadBytes(path);
  const lines = lf.split("\n");
  const blocks = locate(lines);
  const keyframes = new Map<string, string>();
  const revisions = new Map<string, Revision>();
  const blobs = new Map<string, string>();
  let current = "";
  for (const b of blocks) {
    const body = lines.slice(b.start + 1, b.end).join("\n");
    if (b.type === "meta") {
      const m = /^\s*current\s*=\s*"?([^"\n]+?)"?\s*$/m.exec(body);
      if (m) current = m[1]!;
    } else if (b.type === "keyframe") {
      keyframes.set(attr(b.attrLine, "id")!, body);
    } else if (b.type === "revision") {
      const id = attr(b.attrLine, "id")!;
      revisions.set(id, {
        id,
        parent: attr(b.attrLine, "parent"),
        author: attr(b.attrLine, "author"),
        summary: attr(b.attrLine, "summary"),
        hash: attr(b.attrLine, "hash") ?? "",
        ops: parseOps(body),
      });
    } else if (b.type === "blob") {
      blobs.set(b.id!, body);
    }
  }
  return { nl, current, keyframes, revisions, blobs };
}

function chainFrom(h: History): Revision[] {
  const out: Revision[] = [];
  let id: string | undefined = h.current;
  const seen = new Set<string>();
  while (id) {
    const r = h.revisions.get(id);
    if (!r) throw new Error(`history: revision ${id} missing (broken chain)`);
    if (seen.has(id)) throw new Error(`history: cycle at ${id}`);
    seen.add(id);
    out.push(r);
    id = r.parent;
  }
  return out; // newest -> oldest
}

/** Reconstruct the content of revision `targetId`. */
export function reconstruct(h: History, targetId: string): string {
  const chain = chainFrom(h);
  const t = chain.findIndex((r) => r.id === targetId);
  if (t < 0) throw new Error(`history: unknown revision ${targetId}`);
  // nearest keyframe at-or-newer than target (chain[0] = newest)
  let kf = -1;
  for (let i = t; i >= 0; i--) if (h.keyframes.has(chain[i]!.id)) { kf = i; break; }
  if (kf < 0) throw new Error(`history: no keyframe to reconstruct ${targetId}`);
  let text = h.keyframes.get(chain[kf]!.id)!;
  for (let i = kf; i < t; i++) text = applyReverse(text, chain[i]!.ops, h.blobs);
  return text;
}

// ---------------------------------------------------------------------------
// Render history (newest-first)
// ---------------------------------------------------------------------------

function renderHistory(h: History, baseName: string): string {
  const chain = chainFrom(h);
  const parts: string[] = [];
  parts.push(`# History of ${baseName}\n`);
  parts.push(
    "=== meta\n" +
    `history-of        = "${baseName}"\n` +
    'geml-version      = "0.1"\n' +
    `current           = "${h.current}"\n` +
    "keyframe-interval = 10\n" +
    "===\n"
  );
  // committed-current keyframe
  const kfContent = h.keyframes.get(h.current)!;
  const kf = fenceFor(kfContent);
  parts.push(
    "# Committed-current mirror (always present):\n" +
    `${kf} keyframe {id="${h.current}" hash="${chain[0]!.hash}"}\n` +
    `${kfContent}\n${kf}\n`
  );
  for (const r of chain) {
    const at = [
      `id="${r.id}"`,
      r.parent ? `parent="${r.parent}"` : "",
      r.author ? `author="${r.author}"` : "",
      r.summary ? `summary="${r.summary}"` : "",
      `hash="${r.hash}"`,
    ].filter(Boolean).join(" ");
    parts.push(`=== revision {${at}}\n${r.ops.map(opLine).join("\n")}${r.ops.length ? "\n" : ""}===\n`);
    // blobs referenced by this revision
    for (const op of r.ops) {
      if (op.blob && h.blobs.has(op.blob)) {
        const payload = h.blobs.get(op.blob)!;
        const bf = fenceFor(payload);
        parts.push(`${bf} blob {#${op.blob} lang=geml}\n${payload}\n${bf}\n`);
      }
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

export interface CommitOpts { gemlPath: string; historyPath: string; summary: string; author?: string; at?: Date; }

export function commit(o: CommitOpts): { id: string; hash: string } {
  const { lf: working, nl } = loadBytes(o.gemlPath);
  const hash = fullHash(working, nl);
  const stamp = stampUTC(o.at ?? new Date());
  const id = makeId(stamp, hash);
  const baseName = o.gemlPath.replace(/^.*[\\/]/, "");

  let h: History;
  if (existsSync(o.historyPath)) {
    h = parseHistory(o.historyPath);
    const prevId = h.current;
    const prevContent = reconstruct(h, prevId); // committed current
    const patch = diffReverse(prevContent, working);

    // verify gate: the reverse patch must reproduce the parent byte-for-byte
    const blobMap = new Map(patch.blobs.map((b) => [b.id, b.payload]));
    const back = applyReverse(working, patch.ops, blobMap);
    if (bytesOf(back, nl).compare(bytesOf(prevContent, nl)) !== 0) {
      throw new Error("history: reverse patch does NOT round-trip to the previous revision; aborting commit");
    }
    // Blob ids are minted per-diff (b1, b2, …). Renumber this commit's blobs to
    // start past the highest id already stored, so a later commit never reuses
    // an earlier revision's blob id — an overwrite in the shared store silently
    // corrupts reconstruction of older revisions, whose `replace … <- blob:bN`
    // would then resolve to the wrong (newer) content.
    let maxBlob = 0;
    for (const k of h.blobs.keys()) { const mm = /^b(\d+)$/.exec(k); if (mm) maxBlob = Math.max(maxBlob, Number(mm[1])); }
    const remap = new Map(patch.blobs.map((b, i) => [b.id, `b${maxBlob + i + 1}`]));
    patch.ops = patch.ops.map((op) => (op.blob ? { ...op, blob: remap.get(op.blob)! } : op));
    patch.blobs = patch.blobs.map((b) => ({ id: remap.get(b.id)!, payload: b.payload }));

    for (const b of patch.blobs) h.blobs.set(b.id, b.payload);
    h.revisions.set(id, { id, parent: prevId, author: o.author, summary: o.summary, hash, ops: patch.ops });
    h.keyframes.delete(prevId); // demote previous tip mirror (keyframes at intervals only)
    h.keyframes.set(id, working);
    h.current = id;
  } else {
    h = {
      nl, current: id,
      keyframes: new Map([[id, working]]),
      revisions: new Map([[id, { id, author: o.author, summary: o.summary, hash, ops: [] }]]),
      blobs: new Map(),
    };
  }
  writeBytes(o.historyPath, renderHistory(h, baseName), nl);
  return { id, hash };
}

export interface VerifyResult { ok: boolean; errors: string[]; warnings: string[]; checked: number; }

export function verify(historyPath: string, gemlPath?: string): VerifyResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const h = parseHistory(historyPath);
  let checked = 0;
  let chain: Revision[] = [];
  try { chain = chainFrom(h); } catch (e) { errors.push(String((e as Error).message)); }
  for (const r of chain) {
    try {
      const content = reconstruct(h, r.id);
      const got = fullHash(content, h.nl);
      if (got !== r.hash) errors.push(`revision ${r.id}: reconstructed hash ${got} != recorded ${r.hash}`);
      checked++;
    } catch (e) {
      errors.push(`revision ${r.id}: ${(e as Error).message}`);
    }
  }
  if (gemlPath && existsSync(gemlPath)) {
    const { lf, nl } = loadBytes(gemlPath);
    if (fullHash(lf, nl) !== (chain[0]?.hash ?? "")) {
      warnings.push("uncommitted changes: hash(doc.geml) differs from current");
    }
  }
  return { ok: errors.length === 0, errors, warnings, checked };
}

export interface RestoreOpts { historyPath: string; gemlPath: string; revision: string; write?: boolean; force?: boolean; }

export function restore(o: RestoreOpts): string {
  const h = parseHistory(o.historyPath);
  // accept an unambiguous id prefix
  const ids = [...h.revisions.keys()];
  const matches = ids.filter((x) => x === o.revision || x.startsWith(o.revision) || x.endsWith(o.revision));
  if (matches.length !== 1) throw new Error(`history: revision selector "${o.revision}" matched ${matches.length} revisions`);
  const target = matches[0]!;
  const content = reconstruct(h, target);
  if (o.write) {
    if (existsSync(o.gemlPath)) {
      const { lf, nl } = loadBytes(o.gemlPath);
      if (fullHash(lf, nl) !== h.revisions.get(h.current)!.hash && !o.force) {
        throw new Error("history: uncommitted changes in doc.geml; rerun with force to discard them, or commit first");
      }
    }
    // destructive linear truncation to `target`
    const chain = chainFrom(h);
    const keep = new Set<string>();
    let id: string | undefined = target;
    while (id) { keep.add(id); id = h.revisions.get(id)!.parent; }
    for (const r of chain) if (!keep.has(r.id)) { h.revisions.delete(r.id); h.keyframes.delete(r.id); }
    h.keyframes.clear();
    h.keyframes.set(target, content);
    h.current = target;
    const { nl } = loadBytes(o.historyPath);
    writeBytes(o.gemlPath, content, nl);
    writeBytes(o.historyPath, renderHistory(h, o.gemlPath.replace(/^.*[\\/]/, "")), nl);
  }
  return content;
}

// ---------------------------------------------------------------------------
// Read-only queries — power the CLI's `history log` and `revert`
// ---------------------------------------------------------------------------

export interface RevisionInfo {
  id: string; parent?: string; author?: string; summary?: string; hash: string;
  offset: number;   // 0 = current tip, 1 = its parent, … (the `--to -N` selector)
  current: boolean;
}

/** Revisions newest-first, each tagged with the `-N` offset that selects it. */
export function listRevisions(historyPath: string): RevisionInfo[] {
  const h = parseHistory(historyPath);
  return chainFrom(h).map((r, i) => ({
    id: r.id, parent: r.parent, author: r.author, summary: r.summary, hash: r.hash,
    offset: i, current: i === 0,
  }));
}

/** Resolve a revision selector to its id + reconstructed full text. Selectors:
 *  `-N` (N revisions back from current; `-0` is the tip), `latest`/`current`, or
 *  an unambiguous id prefix/suffix (the same forms `restore` accepts). */
export function resolveContent(historyPath: string, selector: string): { id: string; text: string } {
  const h = parseHistory(historyPath);
  const chain = chainFrom(h);                       // chain[0] = current tip
  let id: string;
  const off = /^-(\d+)$/.exec(selector);
  if (off) {
    const n = Number(off[1]);
    if (n >= chain.length) throw new Error(`history: offset -${n} is out of range (only ${chain.length} revision(s))`);
    id = chain[n]!.id;
  } else if (selector === "latest" || selector === "current") {
    id = chain[0]!.id;
  } else {
    const ids = [...h.revisions.keys()];
    const matches = ids.filter((x) => x === selector || x.startsWith(selector) || x.endsWith(selector));
    if (matches.length !== 1) throw new Error(`history: revision selector "${selector}" matched ${matches.length} revisions`);
    id = matches[0]!;
  }
  return { id, text: reconstruct(h, id) };
}

/** Walk the chain newest→oldest; return the first revision whose block (as
 *  extracted by `pick`) differs from `currentBlock` — i.e. the block's previous
 *  *distinct* version, skipping revisions that never touched it. Used by
 *  `revert --changed`. `undefined` if no earlier revision changed the block. */
export function firstChangedContent(
  historyPath: string,
  currentBlock: string,
  pick: (fullText: string) => string | undefined,
): { id: string; text: string } | undefined {
  const h = parseHistory(historyPath);
  for (const r of chainFrom(h)) {
    const text = reconstruct(h, r.id);
    const b = pick(text);
    if (b !== undefined && b !== currentBlock) return { id: r.id, text };
  }
  return undefined;
}
