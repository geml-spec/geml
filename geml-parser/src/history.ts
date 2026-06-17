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
// Top-level fenced-block locator (source line spans; no nesting descent)
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

function blockText(lines: string[], b: Located): string {
  return lines.slice(b.start, b.end + 1).join("\n");
}

// ---------------------------------------------------------------------------
// Reverse-patch application (delete / replace / insert by block id)
// ---------------------------------------------------------------------------

interface Op { kind: "delete" | "replace" | "insert"; id?: string; blob?: string; anchor?: string; }

function parseOps(body: string): Op[] {
  const ops: Op[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = /^delete\s+#([A-Za-z][A-Za-z0-9_-]*)$/.exec(line))) {
      ops.push({ kind: "delete", id: m[1]! });
    } else if ((m = /^replace\s+#([A-Za-z][A-Za-z0-9_-]*)\s+<-\s+blob:(\S+)$/.exec(line))) {
      ops.push({ kind: "replace", id: m[1]!, blob: m[2]! });
    } else if ((m = /^insert\s+<-\s+blob:(\S+)\s+(?:after\s+#([A-Za-z][A-Za-z0-9_-]*)|(at-start|at-end))$/.exec(line))) {
      ops.push({ kind: "insert", blob: m[1]!, anchor: m[2] ?? m[3]! });
    } else {
      throw new Error(`history: unrecognized reverse-patch op: ${line}`);
    }
  }
  return ops;
}

/** Apply a reverse patch to `textLf`, returning the parent-revision text. */
function applyReverse(textLf: string, ops: Op[], blobs: Map<string, string>): string {
  let lines = textLf.split("\n");
  const find = (id: string): Located => {
    const b = locate(lines).find((x) => x.id === id);
    if (!b) throw new Error(`history: block #${id} not found while applying reverse patch`);
    return b;
  };
  for (const op of ops) {
    if (op.kind === "delete") {
      const b = find(op.id!);
      let end = b.end + 1;
      if (end < lines.length && lines[end] === "") end++; // absorb one trailing blank
      lines.splice(b.start, end - b.start);
    } else if (op.kind === "replace") {
      const b = find(op.id!);
      const payload = blobs.get(op.blob!);
      if (payload === undefined) throw new Error(`history: unresolved blob:${op.blob}`);
      lines.splice(b.start, b.end - b.start + 1, ...payload.split("\n"));
    } else {
      const payload = blobs.get(op.blob!);
      if (payload === undefined) throw new Error(`history: unresolved blob:${op.blob}`);
      const ins = [...payload.split("\n"), ""]; // block + one trailing blank
      if (op.anchor === "at-start") {
        lines.splice(0, 0, ...ins);
      } else if (op.anchor === "at-end") {
        lines.push(...ins);
      } else {
        const a = find(op.anchor!);
        lines.splice(a.end + 1, 0, "", ...payload.split("\n"));
      }
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Diff (forward v_parent -> v_new) producing a reverse patch (v_new -> v_parent)
// ---------------------------------------------------------------------------

interface Patch { ops: Op[]; blobs: { id: string; payload: string }[]; }

function diffReverse(oldLf: string, newLf: string): Patch {
  const oldLines = oldLf.split("\n");
  const newLines = newLf.split("\n");
  const oldB = locate(oldLines).filter((b) => b.id);
  const newB = locate(newLines).filter((b) => b.id);
  const oldById = new Map(oldB.map((b) => [b.id!, b]));
  const newById = new Map(newB.map((b) => [b.id!, b]));

  const ops: Op[] = [];
  const blobs: { id: string; payload: string }[] = [];

  // added in new -> reverse deletes
  for (const b of newB) {
    if (!oldById.has(b.id!)) ops.push({ kind: "delete", id: b.id! });
  }
  // modified -> reverse replaces (carry old content)
  for (const b of newB) {
    const o = oldById.get(b.id!);
    if (o && blockText(oldLines, o) !== blockText(newLines, b)) {
      const bid = `b-${b.id!}`;
      blobs.push({ id: bid, payload: blockText(oldLines, o) });
      ops.push({ kind: "replace", id: b.id!, blob: bid });
    }
  }
  // removed from new -> reverse inserts (carry old content + anchor)
  for (let i = 0; i < oldB.length; i++) {
    const o = oldB[i]!;
    if (!newById.has(o.id!)) {
      const bid = `b-${o.id!}`;
      blobs.push({ id: bid, payload: blockText(oldLines, o) });
      const prev = oldB[i - 1];
      ops.push({ kind: "insert", blob: bid, anchor: prev ? prev.id! : "at-start" });
    }
  }
  return { ops, blobs };
}

function opLine(op: Op): string {
  if (op.kind === "delete") return `delete #${op.id}`;
  if (op.kind === "replace") return `replace #${op.id} <- blob:${op.blob}`;
  const anchor = op.anchor === "at-start" || op.anchor === "at-end" ? op.anchor : `after #${op.anchor}`;
  return `insert <- blob:${op.blob} ${anchor}`;
}

// ---------------------------------------------------------------------------
// History document model
// ---------------------------------------------------------------------------

interface Revision { id: string; parent?: string; author?: string; summary?: string; hash: string; ops: Op[]; }

interface History {
  nl: string;
  metaLines: string[];
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
  let metaLines: string[] = [];
  for (const b of blocks) {
    const body = lines.slice(b.start + 1, b.end).join("\n");
    if (b.type === "meta") {
      metaLines = lines.slice(b.start + 1, b.end);
      const m = /^\s*current\s*=\s*"?([^"\n]+?)"?\s*$/m.exec(body);
      if (m) current = m[1]!;
    } else if (b.type === "keyframe") {
      const id = attr(b.attrLine, "id")!;
      keyframes.set(id, body);
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
  return { nl, metaLines, current, keyframes, revisions, blobs };
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
    for (const b of patch.blobs) h.blobs.set(b.id, b.payload);
    h.revisions.set(id, { id, parent: prevId, author: o.author, summary: o.summary, hash, ops: patch.ops });
    h.keyframes.delete(prevId); // demote previous tip mirror (keyframes at intervals only)
    h.keyframes.set(id, working);
    h.current = id;
  } else {
    h = {
      nl, metaLines: [], current: id,
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
