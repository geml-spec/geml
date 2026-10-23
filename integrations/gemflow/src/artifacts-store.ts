// The artifacts on disk (core/artifacts.ts): the home's .geml/artifacts.geml and
// the copies beside it in .geml/artifacts/. Each sync reads the files a work
// item wrote that git does not keep and copies a version of any whose content
// changed; a GEML document keeps one copy, its later versions in that copy's
// .gemlhistory. The table is rewritten under its lock, read again there, so
// sessions syncing at once each add their own rows.
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { historyPathFor } from "@geml/geml";
import { save as saveHistory } from "@geml/geml/dist/history.js";
import { exists, readText, withLock, writeAtomic } from "./host-fs.js";
import { unkeptOf } from "./host-git.js";
import { GEML_DIR, ARTIFACTS_DOC } from "./core/layout.js";
import { COPY_LIMIT, copyName, isGemlPath, isImagePath, isMadeForPeople, readArtifacts, withArtifacts, type ArtifactKind, type ArtifactRow } from "./core/artifacts.js";

const lf = (s: string): string => s.replace(/\r\n?/g, "\n");
const slashed = (p: string): string => p.split(sep).join("/");

/** The table's rows; none when there is no table yet. */
export function readArtifactRows(home: string): ArtifactRow[] {
  const path = join(home, ARTIFACTS_DOC);
  return exists(path) ? readArtifacts(readText(path)) : [];
}

/** A row's copy, as an absolute path: under the home's .geml for one in the artifacts directory, else the path it names. */
export function copyPath(home: string, where: string): string {
  return where.startsWith("artifacts/") ? join(home, GEML_DIR, where) : where;
}

/** The table changed by `change` under its lock, read again there; written back when it changed. Answers the rows. */
function changeRows(home: string, change: (rows: ArtifactRow[]) => ArtifactRow[]): ArtifactRow[] {
  const path = join(home, ARTIFACTS_DOC);
  return withLock(path, () => {
    const was = exists(path) ? readText(path) : null;
    const before = was === null ? [] : readArtifacts(was);
    const rows = change([...before]);
    const text = withArtifacts(was, rows);
    if (was === null ? rows.length > 0 : lf(text) !== lf(was)) writeAtomic(path, text);
    return rows;
  });
}

/** A file's SHA-256, read a megabyte at a time. */
function hashFile(path: string): string {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return h.digest("hex");
}

/** The newest version the table has of an artifact. */
function latest(rows: readonly ArtifactRow[], item: string, kind: ArtifactKind, name: string): ArtifactRow | undefined {
  return rows.filter((r) => r.item === item && r.kind === kind && r.name === name).at(-1);
}

/**
 * A version of the file at `abs`, known to the table by `name`, when its
 * content is not the last version's: copied (a GEML document into its one
 * copy, the version saved into the copy's .gemlhistory), or kept by where it
 * is when bigger than COPY_LIMIT. Undefined when it is not there, or did not
 * change.
 */
function versionOf(home: string, rows: readonly ArtifactRow[], item: string, abs: string, name: string, kind: ArtifactKind): ArtifactRow | undefined {
  let st;
  try { st = statSync(abs); } catch { return undefined; }
  if (!st.isFile()) return undefined;
  const at = new Date(Math.floor(st.mtimeMs)).toISOString();
  const prev = latest(rows, item, kind, name);
  // Unchanged since the last look: the same size and time, not read again.
  if (prev !== undefined && prev.size === st.size && prev.at === at) return undefined;
  const sha256 = hashFile(abs);
  if (prev?.sha256 === sha256) return undefined;
  const version = String(rows.filter((r) => r.item === item && r.kind === kind && r.name === name).length + 1);
  const row = (where: string): ArtifactRow => ({ item, kind, name, where, version, size: st.size, at, sha256 });
  if (st.size > COPY_LIMIT) return row(slashed(abs));
  const dir = join(home, GEML_DIR, "artifacts");
  mkdirSync(dir, { recursive: true });
  if (isGemlPath(name)) {
    // One copy, its versions in its .gemlhistory; the copy is named by the first version's hash.
    const kept = prev !== undefined && prev.where.startsWith("artifacts/") && isGemlPath(prev.where) ? prev.where : `artifacts/${copyName(sha256, name)}`;
    const copy = join(home, GEML_DIR, kept);
    try {
      writeAtomic(copy, readText(abs));
      saveHistory({ gemlPath: copy, historyPath: historyPathFor(copy), summary: `version ${version}`, author: "gemflow", at: new Date(Math.floor(st.mtimeMs)) });
      return row(kept);
    } catch { /* a document history cannot take: copied whole as any file is */ }
  }
  const where = `artifacts/${copyName(sha256, name)}`;
  const target = join(home, GEML_DIR, where);
  if (!exists(target)) copyFileSync(abs, target);
  return row(where);
}

/**
 * The files a work item wrote (project paths under `root`) that git does not
 * keep, one version each whose content changed since the table last had it.
 * Answers the table's rows; nothing changes where git cannot say which it
 * keeps.
 */
export function syncWritten(root: string, home: string, item: string, everything: readonly string[]): ArtifactRow[] {
  // Only what is made for a person: a script or a config the work wrote for itself is no artifact.
  const written = everything.filter(isMadeForPeople);
  const unkept = written.length === 0 ? new Set<string>() : unkeptOf(root, written);
  if (unkept === undefined || unkept.size === 0) return readArtifactRows(home);
  return changeRows(home, (rows) => {
    for (const path of written.filter((p) => unkept.has(p))) {
      const v = versionOf(home, rows, item, join(root, path), path, isImagePath(path) ? "image" : "file");
      if (v !== undefined) rows.push(v);
    }
    return rows;
  });
}

/** A document git keeps that the work item changed: its path, its last commit and that commit's time. */
export interface GitDoc { path: string; sha: string; at: string }

/** The work item's documents in git, one row each, the ones it had replaced: git keeps their versions. */
export function syncDocs(home: string, item: string, docs: readonly GitDoc[]): ArtifactRow[] {
  const wanted = docs.map((d): ArtifactRow => ({ item, kind: "doc", name: d.path, where: "git", version: d.sha.slice(0, 8), size: null, at: d.at, sha256: "" }));
  const same = (a: readonly ArtifactRow[], b: readonly ArtifactRow[]): boolean => a.length === b.length && a.every((r, i) => JSON.stringify(r) === JSON.stringify(b[i]));
  const now = readArtifactRows(home);
  if (same(now.filter((r) => r.item === item && r.kind === "doc"), wanted)) return now;
  return changeRows(home, (rows) => [...rows.filter((r) => !(r.item === item && r.kind === "doc")), ...wanted]);
}

/**
 * A link the work item published or shared: a new row when the table has no
 * row of that version under that name — a resumed or forked session's
 * transcript holds the publishes before it again. Without a name it keeps the
 * one it had, else goes by `fallback` (its published file's name), else its
 * address.
 */
export function recordLink(home: string, item: string, link: { name?: string; fallback?: string; url: string; version?: string; at: string }): ArtifactRow[] {
  return changeRows(home, (rows) => {
    const versions = rows.filter((r) => r.item === item && r.kind === "link" && r.where === link.url);
    const prev = versions.at(-1);
    const name = link.name !== undefined && link.name !== "" ? link.name : prev?.name ?? (link.fallback !== undefined && link.fallback !== "" ? link.fallback : link.url);
    if (versions.some((r) => r.version === (link.version ?? "") && r.name === name)) return rows;
    rows.push({ item, kind: "link", name, where: link.url, version: link.version ?? "", size: null, at: link.at, sha256: "" });
    return rows;
  });
}

/**
 * A file the model says the work item made (a picture it generated): a
 * version of it when its content is new, by its project path when it is
 * under `root`, else its own. Answers the row recorded, or undefined.
 */
export function recordFile(root: string, home: string, item: string, path: string, kind: "image" | "file"): ArtifactRow | undefined {
  const abs = isAbsolute(path) ? path : join(root, path);
  const rel = slashed(relative(root, abs));
  const name = rel !== "" && !rel.startsWith("../") && !isAbsolute(rel) ? rel : slashed(abs);
  let made: ArtifactRow | undefined;
  changeRows(home, (rows) => {
    made = versionOf(home, rows, item, abs, name, kind);
    if (made !== undefined) rows.push(made);
    return rows;
  });
  return made;
}

/**
 * Bytes the person gave (an upload), copied under their hash and known to the
 * table by `name`; nothing new when this item has these bytes already.
 * Answers the row recorded, or undefined.
 */
export function recordBytes(home: string, item: string, given: { name: string; bytes: Buffer; kind: "image" | "file"; at: string }): ArtifactRow | undefined {
  const sha256 = createHash("sha256").update(given.bytes).digest("hex");
  let made: ArtifactRow | undefined;
  changeRows(home, (rows) => {
    if (rows.some((r) => r.item === item && r.sha256 === sha256)) return rows;
    const where = `artifacts/${copyName(sha256, given.name)}`;
    const target = join(home, GEML_DIR, where);
    mkdirSync(dirname(target), { recursive: true });
    if (!exists(target)) writeFileSync(target, given.bytes);
    const version = String(rows.filter((r) => r.item === item && r.kind === given.kind && r.name === given.name).length + 1);
    made = { item, kind: given.kind, name: given.name, where, version, size: given.bytes.length, at: given.at, sha256 };
    rows.push(made);
    return rows;
  });
  return made;
}

/** The directory the copies are in. */
export const artifactsDir = (home: string): string => dirname(join(home, GEML_DIR, "artifacts", "x"));

/** Two paths the same, separators aside; letter case aside where the file system ignores it. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => { const s = p.split("\\").join("/").replace(/\/+$/, ""); return process.platform === "win32" ? s.toLowerCase() : s; };
  return norm(a) === norm(b);
}

/** Whether `path` is `dir` or inside it, separators aside; letter case aside where the file system ignores it. */
export function isUnder(path: string, dir: string): boolean {
  const norm = (p: string): string => { const s = p.split("\\").join("/").replace(/\/+$/, ""); return process.platform === "win32" ? s.toLowerCase() : s; };
  const d = norm(dir);
  const p = norm(path);
  return p === d || p.startsWith(`${d}/`);
}

/**
 * The files named taken out of the table, every version of them under any
 * work item: what turned out not to be for the person (a draft handed to git
 * commit as its message). The copies no row keeps any more move into `trash`,
 * a GEML copy's history with it. Answers how many rows went.
 */
export function forgetFiles(root: string, home: string, paths: readonly string[], trash: string): number {
  const names = paths.flatMap((p) => {
    const abs = isAbsolute(p) ? p : join(root, p);
    const rel = slashed(relative(root, abs));
    return [slashed(abs), ...(rel !== "" && !rel.startsWith("../") && !isAbsolute(rel) ? [rel] : [])];
  });
  let gone: ArtifactRow[] = [];
  const kept = changeRows(home, (rows) => {
    gone = rows.filter((r) => r.kind !== "link" && names.some((n) => samePath(n, r.name)));
    return rows.filter((r) => !gone.includes(r));
  });
  for (const r of gone) {
    if (!r.where.startsWith("artifacts/") || kept.some((k) => k.where === r.where)) continue;
    for (const copy of [copyPath(home, r.where), historyPathFor(copyPath(home, r.where))]) {
      if (!exists(copy)) continue;
      mkdirSync(trash, { recursive: true });
      try { renameSync(copy, join(trash, basename(copy))); } catch { copyFileSync(copy, join(trash, basename(copy))); unlinkSync(copy); }
    }
  }
  return gone.length;
}
