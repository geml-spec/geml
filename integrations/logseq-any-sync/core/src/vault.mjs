// The vault on disk: where pages live, how they are written, the machine-local
// sync state, backups, and the scoped git commit. Nothing here knows which app
// the vault mirrors.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export const STATE_FILE = ".geml-sync.json";
export const BACKUP_DIR = ".geml-backup";
export const PAGES_DIR = "pages";
export const INDEX_FILE = "space.geml";

/** POSIX-style path relative to the vault. */
export const relPath = (vault, abs) => relative(vault, abs).split(sep).join("/");

export function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${process.pid}-${randomUUID()}`);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** A file name for a page: its name, lower-cased, letters/digits/CJK kept. */
export function slugFor(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9一-鿿]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "page";
}

/** A free `pages/<slug>.geml`, compared case-insensitively (macOS and Windows
 *  file systems are), never one the vault already uses. */
export function freePagePath(vault, name, taken) {
  const lower = new Set([...taken].map((p) => p.toLowerCase()));
  const base = slugFor(name);
  for (let n = 1; ; n++) {
    const rel = `${PAGES_DIR}/${n === 1 ? base : `${base}-${n}`}.geml`;
    if (!lower.has(rel.toLowerCase()) && !existsSync(join(vault, rel))) return rel;
  }
}

/** Every `.geml` under pages/, as vault-relative paths. */
export function pageFiles(vault) {
  const root = join(vault, PAGES_DIR);
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".geml")) out.push(relPath(vault, p));
    }
  };
  walk(root);
  return out.sort();
}

export function readState(vault) {
  try {
    const s = JSON.parse(readFileSync(join(vault, STATE_FILE), "utf8"));
    if (s && s.version === 1 && s.files && typeof s.files === "object") return s;
  } catch { /* absent or unreadable: a fresh state */ }
  return { version: 1, cursor: 0, files: {} };
}

export function writeState(vault, state) {
  atomicWrite(join(vault, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

/** Keep a copy of what the app held before the bridge changed it. */
export function backup(vault, ref, doc) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  atomicWrite(join(vault, BACKUP_DIR, String(ref).replace(/[^A-Za-z0-9_-]/g, "_"), `${stamp}.json`), JSON.stringify(doc, null, 2) + "\n");
}

/** The vault's own `.gitignore` lines: machine-local state never travels. */
export function ensureIgnores(vault) {
  const p = join(vault, ".gitignore");
  const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
  const want = [STATE_FILE, `${BACKUP_DIR}/`].filter((l) => !cur.split(/\r?\n/).includes(l));
  if (want.length) writeFileSync(p, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + want.join("\n") + "\n");
}

export const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return undefined; } };

/**
 * Commit exactly `paths` (vault-relative), never anything else in the
 * repository: a pathspec commit leaves every other staged or unstaged change
 * alone. Does nothing outside a git repository.
 */
export function gitCommit(vault, paths, message) {
  const git = (args) => {
    try { return { ok: true, out: execFileSync("git", args, { cwd: vault, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (e) { return { ok: false, out: String(e.stderr ?? e.message) }; }
  };
  if (!git(["rev-parse", "--show-toplevel"]).ok) return { committed: false, why: "not a git repository" };
  const uniq = [...new Set(paths)];
  if (!uniq.length) return { committed: false, why: "nothing written" };
  const present = uniq.filter((p) => existsSync(join(vault, p)));
  if (present.length && !git(["add", "--", ...present]).ok) return { committed: false, why: "git add failed" };
  const status = git(["status", "--porcelain", "--", ...uniq]);
  if (!status.ok || !status.out.trim()) return { committed: false, why: "no changes" };
  const c = git(["commit", "-q", "-m", message, "--", ...uniq]);
  return c.ok ? { committed: true } : { committed: false, why: c.out.trim() };
}
