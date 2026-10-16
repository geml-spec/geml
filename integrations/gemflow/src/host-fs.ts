// The only module that touches the file system. Everything under core/ is pure.
import { randomBytes } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
  type Dirent,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { JOURNALS_DIR } from "./core/layout.js";
import { globToRegExp, hiddenDir, IGNORED_DIRS } from "./core/unit.js";

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

/** The real path of something that exists: the operating system's answer, else Node's own walk of the links; undefined when neither has one. */
function realOf(path: string): string | undefined {
  // The OS's answer also resolves what Node's walk does not: Windows junctions, substituted drives and 8.3 short names (a temp directory is often one).
  try { return realpathSync.native(path); } catch { /* not there, or the OS cannot say (some Windows volumes): Node's walk */ }
  try { return realpathSync(path); } catch { return undefined; }
}

/**
 * A path with its symbolic links resolved — on Windows its junctions,
 * substituted drives and short names too — so two spellings of one file
 * compare equal. A path that does not exist resolves through its nearest
 * parent that does, its missing names kept as written. Every path compared
 * with a root that went through this must go through it too.
 */
export function realPath(path: string): string {
  const missing: string[] = [];
  for (let at = resolve(path); ; ) {
    const real = realOf(at);
    if (real !== undefined) return missing.length === 0 ? real : join(real, ...missing);
    const parent = dirname(at);
    if (parent === at) return resolve(path);
    missing.unshift(basename(at));
    at = parent;
  }
}

/** Create a file that must not exist yet (flag "wx"), making parent directories. */
export function writeNew(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
}

/** Blind append: one call, no read. */
export function appendText(path: string, text: string): void {
  appendFileSync(path, text, "utf8");
}

/**
 * Append one journal block, writing the head first when the file is new.
 *
 * One `appendFileSync` either way: a journal is written by blind append (the
 * writer never reads the file), so the only question is whether this is the
 * first block. `existsSync` answers it without opening anything.
 */
export function appendOrCreate(path: string, head: string, block: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, existsSync(path) ? block : head + block, "utf8");
}

/** Whether a path is there — the journal asks before deciding to resume. */
export function exists(path: string): boolean {
  return existsSync(path);
}

const sleepMs = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

/**
 * What Windows answers while another process (an indexer, a virus scanner, an
 * editor) has a file open for a moment: the same call succeeds a moment later.
 * Elsewhere these codes are real permission errors and are never retried.
 */
const isBusy = (e: unknown): boolean => process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(codeOf(e) ?? "");

/** Call `op`, trying again while the file is busy (about half a second in all); anything else, or the last failure, throws. */
function whileBusy<T>(op: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try { return op(); } catch (e) {
      if (!isBusy(e) || attempt >= 10) throw e;
      sleepMs(10 * (attempt + 1));
    }
  }
}

/** Remove a file; one that is already gone is not an error. */
function removeFile(path: string): void {
  try { whileBusy(() => unlinkSync(path)); } catch (e) { if (codeOf(e) !== "ENOENT") throw e; }
}

/** Create the lock file, which must not exist, holding `token`. A half-made lock is removed. */
function createLock(lock: string, token: string): void {
  const fd = openSync(lock, "wx");
  try { writeSync(fd, token); } catch (e) {
    closeSync(fd);
    try { removeFile(lock); } catch { /* it ages into a stale lock */ }
    throw e;
  }
  closeSync(fd);
}

/** Take a stale lock away, unless it was replaced since it was judged stale. True when the lock is gone. */
function breakStale(lock: string, judgedAt: number): boolean {
  try {
    if (statSync(lock).mtimeMs !== judgedAt) return false;
    whileBusy(() => unlinkSync(lock));
    return true;
  } catch (e) { return codeOf(e) === "ENOENT"; }
}

/** Who holds a lock, as its file says: the pid it was written with. */
function holderOf(lock: string): string {
  try { return /^\d+/.exec(readFileSync(lock, "utf8"))?.[0] ?? "unknown"; } catch { return "unknown"; }
}

/** Remove our lock, unless someone broke it as stale and holds a new one. */
function release(lock: string, token: string): void {
  try { if (readFileSync(lock, "utf8") === token) removeFile(lock); } catch { /* gone, or a lock that ages into a stale one */ }
}

/**
 * Run `fn` holding `<path>.lock` (created with "wx"), so that processes
 * taking the same lock run one at a time. Waits up to `timeoutMs` for another
 * holder and then throws, naming the holder: a write is never silently dropped
 * (spec §5.5). A lock older than `staleMs` is a crashed holder's and is broken
 * — a lock is only ever held for the length of one journal operation, so
 * `staleMs` must be far longer than `fn` takes. The lock is removed however
 * `fn` ends. `fn` is synchronous: the lock is gone when it returns.
 */
export function withLock<T>(path: string, fn: () => T, o: { timeoutMs?: number; staleMs?: number } = {}): T {
  const lock = `${path}.lock`;
  const timeoutMs = o.timeoutMs ?? 5000, staleMs = o.staleMs ?? 30_000;
  const token = `${process.pid} ${randomBytes(6).toString("hex")}`;
  mkdirSync(dirname(path), { recursive: true });
  const start = Date.now();
  for (;;) {
    let busy: unknown;
    try {
      createLock(lock, token);
      break;
    } catch (e) {
      if (codeOf(e) !== "EEXIST" && !isBusy(e)) throw e;
      busy = e;
    }
    if (codeOf(busy) === "EEXIST") {
      let mtime: number;
      try { mtime = statSync(lock).mtimeMs; } catch (e) {
        if (codeOf(e) === "ENOENT") continue; // released between our attempt and our look
        mtime = Date.now();                   // cannot look (Windows, a delete in progress): treat as fresh and wait
      }
      if (Date.now() - mtime > staleMs && breakStale(lock, mtime)) continue;
      if (Date.now() - start > timeoutMs) {
        const age = Math.max(0, Math.round((Date.now() - mtime) / 1000));
        throw new Error(`gemflow: ${lock} is held by another process (pid ${holderOf(lock)}, for ${age}s); gave up after ${timeoutMs} ms. If no gemflow process is running, delete ${lock}.`);
      }
    } else if (Date.now() - start > timeoutMs) {
      throw new Error(`gemflow: cannot take ${lock}: ${(busy as Error).message}`, { cause: busy });
    }
    sleepMs(25);
  }
  try { return fn(); } finally { release(lock, token); }
}

/**
 * Replace a file whole: write a sibling temp file, flush it, then rename it
 * over the target, so a reader (or a crash) sees the old text or the new text,
 * never half of one. On Windows the rename waits out a reader that has the
 * target open; a write that cannot be made throws.
 */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // The process id alone is not a name nobody else is writing under: a second writer in this process, or a run that
  // died and whose id came round again, would share it.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, text, "utf8");
      try { fsyncSync(fd); } catch (e) { if (!["EINVAL", "ENOTSUP"].includes(codeOf(e) ?? "")) throw e; }
    } finally { closeSync(fd); }
    whileBusy(() => renameSync(tmp, path));
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never made, or already gone */ }
    throw e;
  }
}

/**
 * Whether any file under `root` matches `glob` (project-relative,
 * `/`-separated, as `globToRegExp` reads it): true at the first match, false
 * when the walk finished without one, undefined when it gave up after `limit`
 * entries - then nobody knows, and a caller must not read it as no. The walk
 * starts below the glob's literal leading directories (`out/final/*.mp4` is
 * looked for under `out/final` only), and meets the same rules from there as
 * from the root: names are case-sensitive, `.git`, `node_modules` and `.geml`
 * are skipped, symbolic links to directories are not followed, and a
 * directory that cannot be read is skipped.
 */
export function globExists(root: string, glob: string, limit = 50_000): boolean | undefined {
  const re = globToRegExp(glob);
  const dirs = glob.split("/").slice(0, -1);
  const wild = dirs.findIndex((seg) => /[*?]/.test(seg));
  const prefix = wild < 0 ? dirs : dirs.slice(0, wild);
  // The walk skips these; a glob that names one outright finds nothing either, but for the project's
  // own .geml/ named as the glob's first segment (hiddenDir), which the walk then enters.
  if (prefix.length > 0 && hiddenDir(glob, prefix.join("/")) !== undefined) return false;
  let start = root;
  for (const seg of prefix) {
    let entries: Dirent[];
    try { entries = readdirSync(start, { withFileTypes: true }); } catch { return false; }
    // Found by its exact name among the entries, so a file system that ignores case does not find `Out` for `out`.
    if (!entries.some((e) => e.name === seg && e.isDirectory())) return false;
    start = join(start, seg);
  }
  let seen = 0, exhausted = false;
  const walk = (dir: string, rel: string): boolean => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const ent of entries) {
      if (IGNORED_DIRS.has(ent.name)) continue;
      if (++seen > limit) { exhausted = true; return false; }
      const name = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) {
        if (name === JOURNALS_DIR) continue;
        if (walk(join(dir, ent.name), name)) return true;
        if (exhausted) return false;
      } else if (re.test(name)) return true;
    }
    return false;
  };
  return walk(start, prefix.join("/")) ? true : exhausted ? undefined : false;
}
