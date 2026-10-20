// What git and gh say about the project, for the branch unit and the git
// signals, and which checkout a directory is in, for the work item a tool call
// is attributed to and the place the journals live. Every call is an argument
// vector (no shell) with a timeout; a tool that is missing or fails reads as
// "not established", never as false.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realPath } from "./host-fs.js";
import type { GitFacts } from "./core/signals.js";

/**
 * What git says about the project. `noCommits`: HEAD names a branch that has no
 * commit yet, so there is no history to compare and no work to track; `branch`
 * is still that branch's name.
 */
/** What git says of the checkout; `unanswered` when git did not answer at all (a busy machine): nothing is known then, not even that there is no branch. */
export interface RepoFacts { branch?: string; defaultBranch?: string; committed?: boolean; noCommits?: boolean; unanswered?: boolean }
export type GhFacts = ({ available: true } & GitFacts) | { available: false; reason: string };

const TIMEOUT_MS = 10_000;

interface Ran {
  ok: boolean;
  out: string;
  err: string;
  /** The program is not there. */
  missing: boolean;
  /** Why it could not be run or did not finish (`ETIMEDOUT`, `EACCES`, `EINVAL` for a Windows script spawned without a shell, ...). */
  error?: string;
}

function run(cmd: string, args: string[], cwd: string, trim = true, timeout = TIMEOUT_MS): Ran {
  const r = spawnSync(cmd, args, {
    cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    // Never wait for a person: a prompt would hold the hook until the timeout.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
  });
  const error = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    ok: r.status === 0 && !r.error,
    out: trim ? (r.stdout ?? "").trim() : r.stdout ?? "",
    err: (r.stderr ?? "").trim(),
    // ENOENT is also what a working directory that is not there looks like.
    missing: error === "ENOENT" && existsSync(cwd),
    ...(r.error ? { error: error ?? r.error.message } : {}),
  };
}

/** `run` with extra environment variables (a private index for the content tree). */
function runIn(cmd: string, args: string[], cwd: string, env: Record<string, string>): Ran {
  const r = spawnSync(cmd, args, {
    cwd, encoding: "utf8", timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  return { ok: r.status === 0 && !r.error, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), missing: false };
}

/**
 * What hardly changes for a checkout — its top, its index's path, its default
 * branch and that branch's ref — read once and read again after MEMO_MS: one
 * request asks it several times (a git run costs 100–200 ms on Windows), and a
 * long-lived server (gemflow mcp) reads it afresh soon enough.
 */
const MEMO_MS = 5_000;
const memo = new Map<string, { at: number; value: unknown }>();

/** Forget what was remembered: the next question goes to git (a test that answers several requests in one process, as several processes would). */
export function forgetGitFacts(): void {
  memo.clear();
}
function remembered<T>(key: string, read: () => T): T {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit !== undefined && now - hit.at < MEMO_MS) return hit.value as T;
  const value = read();
  memo.set(key, { at: now, value });
  return value;
}

/** The default branch's ref: the local branch, else the remote's; undefined when there is neither. */
function baseRefOf(root: string): string | undefined {
  return remembered(`base\0${root}`, () => {
    const name = defaultBranchOf(root);
    return name === undefined ? undefined
      : [`refs/heads/${name}`, `refs/remotes/origin/${name}`].find((ref) => run("git", ["rev-parse", "--verify", "--quiet", ref], root).ok);
  });
}

/** The remote's default branch, else a local `main` or `master`. */
function defaultBranchOf(root: string): string | undefined {
  return remembered(`default\0${root}`, () => readDefaultBranch(root));
}

function readDefaultBranch(root: string): string | undefined {
  const origin = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  if (origin.ok && origin.out !== "") return origin.out.replace(/^origin\//, "");
  for (const name of ["main", "master"]) {
    if (run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], root).ok) return name;
  }
  return undefined;
}

/** How many commits HEAD has that the default branch has not: its local branch, or failing that the remote's. */
function commitsAhead(root: string, defaultBranch: string): number | undefined {
  for (const base of [`refs/heads/${defaultBranch}`, `refs/remotes/origin/${defaultBranch}`]) {
    const r = run("git", ["rev-list", "--count", `${base}..HEAD`], root);
    if (r.ok && /^\d+$/.test(r.out)) return Number(r.out);
  }
  return undefined;
}

export function repoFacts(root: string): RepoFacts {
  let head = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root);
  // A git that did not answer (a busy machine) is asked once more, given longer; still silent, it says nothing of the branch —
  // never that the branch has no commits, which would take the work item away and refuse what is done on it.
  if (!head.ok && head.error === "ETIMEDOUT") head = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root, true, 3 * TIMEOUT_MS);
  if (!head.ok && head.error === "ETIMEDOUT") return { unanswered: true };
  if (!head.ok || head.out === "") {
    // A repository whose branch has no commit yet: rev-parse has no HEAD to resolve, but symbolic-ref still reads the branch's name.
    const unborn = run("git", ["symbolic-ref", "--short", "-q", "HEAD"], root);
    return unborn.ok && unborn.out !== "" ? { branch: unborn.out, noCommits: true } : {};
  }
  const facts: RepoFacts = { branch: head.out };
  const defaultBranch = defaultBranchOf(root);
  if (defaultBranch === undefined) return facts;
  facts.defaultBranch = defaultBranch;
  if (facts.branch === defaultBranch) facts.committed = false;
  else if (facts.branch !== "HEAD") {
    // A detached HEAD is on no branch: whether "the branch" has commits is not established.
    const ahead = commitsAhead(root, defaultBranch);
    if (ahead !== undefined) facts.committed = ahead > 0;
  }
  return facts;
}

/**
 * What a checkout holds, as one id (an `until = change` signal's evidence):
 * the git tree of its working content — every tracked and untracked file git
 * does not ignore, as it is on disk — written from a copy of the index, so the
 * real index is never touched and only changed files are hashed. A commit
 * changes nothing (same content, same tree); an edit, a rebase or a pull does.
 * Paths under .geml and node_modules are left out, so Gemflow's own writes
 * change nothing. Undefined when git cannot say (no repository, git missing).
 */
export function treeFingerprint(root: string): string | undefined {
  const top = remembered(`top\0${root}`, () => run("git", ["rev-parse", "--show-toplevel"], root));
  if (!top.ok || top.out === "") return undefined;
  const index = remembered(`index\0${top.out}`, () => run("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], top.out));
  if (!index.ok || index.out === "") return undefined;
  const dir = mkdtempSync(join(tmpdir(), "gemflow-tree-"));
  try {
    const copy = join(dir, "index");
    if (existsSync(index.out)) copyFileSync(index.out, copy);
    const env = { GIT_INDEX_FILE: copy };
    const exclude = [":(exclude,glob)**/.geml/**", ":(exclude,glob)**/node_modules/**"];
    if (!runIn("git", ["add", "-A", "--", ".", ...exclude], top.out, env).ok) return undefined;
    const tree = runIn("git", ["write-tree"], top.out, env);
    return tree.ok && tree.out !== "" ? `tree:${tree.out}` : undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A commit: its hash, committer time, subject, and the files it changed, `/`-separated and relative to the directory git ran in. */
export interface CommitFacts { sha: string; at: string; subject: string; files: string[] }

/** An ISO time as git's own date format, which every git reads: `2026-10-15 01:23:45 +0000`. */
const gitDate = (iso: string): string | undefined => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 19)} +0000`;
};

/**
 * The commits on HEAD a work item's window holds, newest first, at most
 * `limit`: with `ownBranch`, the ones the default branch has not (a
 * branch's own); otherwise the ones committed since `since` and until
 * `until`, only those that touch `paths` when given. Empty when git cannot
 * say: no repository, no default branch, no commits.
 */
export function commitsOf(root: string, w: { ownBranch?: boolean; since?: string; until?: string; paths?: readonly string[] }, limit = 20): CommitFacts[] {
  const args = ["-c", "core.quotePath=false", "log", `--max-count=${limit}`, "--relative", "--name-only", "--format=%x1e%H%x1f%cI%x1f%s"];
  if (w.ownBranch === true) {
    const base = baseRefOf(root);
    if (base === undefined) return [];
    args.push(`${base}..HEAD`);
  } else {
    const since = w.since !== undefined ? gitDate(w.since) : undefined;
    const until = w.until !== undefined ? gitDate(w.until) : undefined;
    if (since !== undefined) args.push(`--since=${since}`);
    if (until !== undefined) args.push(`--until=${until}`);
    args.push("HEAD");
  }
  // --full-diff: a commit that touched one of the paths lists every file it changed, not only those.
  if (w.paths !== undefined && w.paths.length > 0) args.push("--full-diff", "--", ...w.paths);
  const r = run("git", args, root, false);
  if (!r.ok) return [];
  const out: CommitFacts[] = [];
  for (const chunk of r.out.split("\u001e").slice(1)) {
    const [head = "", ...rest] = chunk.split(/\r?\n/);
    const [sha, at, subject] = head.split("\u001f");
    if (sha === undefined || at === undefined || subject === undefined) continue;
    out.push({ sha, at, subject, files: rest.filter((line) => line !== "") });
  }
  return out;
}

/** Whether `name` is an existing local branch of the repository at `root`. */
export function isLocalBranch(root: string, name: string): boolean {
  return run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], root).ok;
}

/** The git checkout a directory is in, as real paths. */
export interface Checkout {
  /** The working tree's top directory. */
  top: string;
  /** The repository's common directory, the same from every checkout of it. */
  common: string;
  /** The main working tree; absent when the common directory is no `.git` directory inside one (a bare repository, a separate git directory). */
  main?: string;
}

/**
 * The checkout `dir` is in: `git -C <dir> rev-parse --show-toplevel` and the
 * common directory, whose parent is the main working tree when it is a `.git`
 * directory — a worktree's `.git` file points into it. Undefined outside any
 * working tree: no repository, a bare one, git missing, the directory gone.
 */
export function checkoutOf(dir: string): Checkout | undefined {
  const r = run("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], dir);
  if (!r.ok) return undefined;
  const lines = r.out.split(/\r?\n/).filter((l) => l !== "");
  const [topLine, commonLine] = lines.slice(-2);
  if (lines.length < 2 || topLine === undefined || commonLine === undefined) return undefined;
  const top = realPath(resolve(dir, topLine));
  const common = realPath(resolve(dir, commonLine));
  return basename(common) === ".git" ? { top, common, main: dirname(common) } : { top, common };
}

/**
 * The directory whose `.geml/journals/` holds a project's journals: the main
 * working tree's copy of the project's directory, which every checkout of the
 * repository shares — a branch has one journal whichever checkout it is worked
 * in, and removing a worktree loses none of it. A project in no repository, or
 * in one with no main working tree to share, keeps its own (`root`, as given).
 * git is asked only when the nearest `.git` at or above the root is a file (a
 * worktree's): a `.git` directory there makes the root part of the main
 * working tree already.
 */
export function journalBaseOf(root: string): string {
  const real = realPath(root);
  for (let d = real; ; ) {
    let gitDir: boolean | undefined;
    try { gitDir = statSync(join(d, ".git")).isDirectory(); } catch { gitDir = undefined; }
    if (gitDir === true) return root;
    // The `.git` file says where the main working tree is; git is asked only when it cannot be read. A git that
    // failed once (a timeout while a plugin reloads) once made a worktree start a journal of its own.
    if (gitDir === false) return sharedBase(linkedCheckout(d) ?? checkoutOf(real), real, root);
    const up = dirname(d);
    if (up === d) return root;
    d = up;
  }
}

/** The files git tracks under `dir`, absolute; none where `dir` is in no repository; undefined when git cannot say. */
export function trackedUnder(dir: string): Set<string> | undefined {
  if (!existsSync(dir)) return new Set();
  const r = run("git", ["-C", dir, "ls-files", "-z"], dir, false);
  if (!r.ok) return /not a git repository/i.test(r.err) ? new Set() : undefined;
  return new Set(r.out.split("\0").filter((p) => p !== "").map((p) => resolve(dir, p)));
}

/**
 * A linked working tree's checkout, read from its `.git` file (`gitdir: <dir>`)
 * and that directory's `commondir`, with no git run; undefined when either
 * cannot be read, or the `.git` file is a submodule's (no `commondir`).
 */
function linkedCheckout(top: string): Checkout | undefined {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(join(top, ".git"), "utf8"));
    if (m === null) return undefined;
    const gitDir = resolve(top, m[1]!);
    const commonDir = join(gitDir, "commondir");
    if (!existsSync(commonDir)) return undefined;
    const common = realPath(resolve(gitDir, readFileSync(commonDir, "utf8").trim()));
    const out: Checkout = { top: realPath(top), common };
    return basename(common) === ".git" ? { ...out, main: dirname(common) } : out;
  } catch {
    return undefined;
  }
}

/** The main working tree's copy of the project directory `real`; `root` when there is none, or it is this one. */
function sharedBase(c: Checkout | undefined, real: string, root: string): string {
  if (c?.main === undefined) return root;
  const rel = relative(c.top, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return root;
  const base = rel === "" ? c.main : join(c.main, rel);
  return base === real ? root : base;
}

const unavailable = (reason: string): GhFacts => ({ available: false, reason });

/** Why gh could not be asked at all, if that is the case. */
function notRun(r: Ran): string | undefined {
  if (r.missing) return "gh is not installed";
  if (r.error === "ETIMEDOUT") return `gh did not answer within ${TIMEOUT_MS / 1000} s`;
  if (r.error) return `gh could not be run (${r.error})`;
  return undefined;
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** The first line gh printed to say what went wrong, for the reason shown to a person. */
function firstLine(r: Ran): string {
  const line = (r.err || r.out).split(/\r?\n/, 1)[0]!.trim();
  return line === "" ? "" : `: ${line.length > 200 ? `${line.slice(0, 200)}...` : line}`;
}

/** The newest pull request among those whose head is the branch (the highest number), and nothing when there is none. */
function newestPr(list: unknown): { state: string } | undefined | null {
  if (!Array.isArray(list)) return null;
  let newest: { state: string; number: number } | undefined;
  for (const pr of list as { state?: unknown; number?: unknown }[]) {
    if (pr === null || typeof pr !== "object" || typeof pr.state !== "string" || typeof pr.number !== "number") return null;
    if (newest === undefined || pr.number > newest.number) newest = { state: pr.state, number: pr.number };
  }
  return newest;
}

/** What a finished run's conclusion means for CI: a skipped or neutral run did not fail. */
const PASSING = new Set(["success", "skipped", "neutral"]);
/** The conclusions of a run that finished and failed; one still going has none. */
const FAILING = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);

/**
 * The pull request of `branch` and the CI runs on its head, as `gh` reports
 * them. The binary is `o.gh`, else `GEMFLOW_GH`, else `gh`. The pull request is
 * the newest one whose head is the branch (`pr list --head`, which never reads
 * a branch named `123` as pull request 123 the way `pr view` does); a branch
 * with none is a fact (not open, not merged); a gh that is missing, not logged
 * in, or has no GitHub remote to ask is `available: false` with a reason, so
 * the signals stay not established rather than turning false. Of the runs on
 * the head each workflow counts by its newest run alone. A binary ending in
 * `.js`, `.mjs` or `.cjs` is a stand-in run by this Node, which Windows needs:
 * it starts no script from its shebang.
 */
export function ghFacts(root: string, branch: string, o: { gh?: string } = {}): GhFacts {
  const bin = o.gh || process.env["GEMFLOW_GH"] || "gh";
  const script = /\.[cm]?js$/i.test(bin);
  const gh = (args: string[]): Ran => (script ? run(process.execPath, [bin, ...args], root) : run(bin, args, root));
  const pr = gh(["pr", "list", "--head", branch, "--state", "all", "--json", "state,number"]);
  const failed = notRun(pr);
  if (failed) return unavailable(failed);
  if (!pr.ok) return unavailable(`gh could not be queried (not logged in, or no GitHub remote)${firstLine(pr)}`);
  const newest = newestPr(parseJson(pr.out));
  if (newest === null) return unavailable("gh returned output that is not a JSON list of pull requests for `pr list`");
  const facts: { available: true } & GitFacts = { available: true, prOpen: newest?.state === "OPEN", prMerged: newest?.state === "MERGED" };
  // Only the runs on the commit the branch is at now count: an older run says nothing about it.
  const head = run("git", ["rev-parse", "HEAD"], root);
  if (head.ok && head.out !== "") {
    const runs = gh(["run", "list", "--branch", branch, "--limit", "20", "--json", "workflowName,conclusion,headSha,createdAt"]);
    const list = runs.ok ? parseJson(runs.out) : undefined;
    if (Array.isArray(list)) {
      const newestOf = new Map<string, { at: string; success: boolean; failed: boolean }>();
      for (const r of list as { workflowName?: unknown; conclusion?: unknown; headSha?: unknown; createdAt?: unknown }[]) {
        if (r === null || typeof r !== "object" || r.headSha !== head.out) continue;
        const workflow = String(r.workflowName ?? "");
        const at = typeof r.createdAt === "string" ? r.createdAt : "";
        const seen = newestOf.get(workflow);
        // gh lists the newest first, so on equal (or missing) times the earlier line stands.
        if (seen === undefined || at > seen.at) newestOf.set(workflow, { at, success: PASSING.has(String(r.conclusion)), failed: FAILING.has(String(r.conclusion)) });
      }
      facts.ci = [...newestOf].map(([workflow, v]) => ({ workflow, success: v.success, ...(v.failed ? { failed: true as const } : {}) }));
      facts.head = head.out;
    }
  }
  return facts;
}

/**
 * Local branches with commits their upstream does not have, across the
 * repository — a worktree's branch too, since worktrees share it. `newestAt`
 * is the branch tip's commit time. A branch with no upstream is not listed: it
 * was never pushed, so nothing is "not pushed yet" about it.
 */
export function branchesAhead(root: string): { branch: string; ahead: number; newestAt?: string }[] {
  const r = run("git", ["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(upstream:track)%09%(committerdate:iso-strict)"], root);
  if (!r.ok) return [];
  const out: { branch: string; ahead: number; newestAt?: string }[] = [];
  for (const line of r.out.split(/\r?\n/)) {
    const [branch, track, at] = line.split("\t");
    const m = /ahead (\d+)/.exec(track ?? "");
    if (branch !== undefined && branch !== "" && m) out.push({ branch, ahead: Number(m[1]), ...(at !== undefined && at !== "" ? { newestAt: at } : {}) });
  }
  return out;
}

/** The conclusions of a check that finished and failed, as gh's statusCheckRollup spells them (a check run's, or a status's state). */
const ROLLUP_FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const ROLLUP_PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * The open pull requests the person opened, with their checks: `green` when
 * every check finished and passed, `failing` the checks that finished and
 * failed. None when gh cannot be asked — the band then just says nothing of
 * pull requests. The binary is chosen as ghFacts chooses it.
 */
export function openPullRequests(root: string, o: { gh?: string } = {}): { number: number; branch: string; green: boolean; failing: string[] }[] {
  const bin = o.gh || process.env["GEMFLOW_GH"] || "gh";
  const script = /\.[cm]?js$/i.test(bin);
  const args = ["pr", "list", "--state", "open", "--author", "@me", "--limit", "30", "--json", "number,headRefName,statusCheckRollup"];
  const r = script ? run(process.execPath, [bin, ...args], root) : run(bin, args, root);
  if (!r.ok) return [];
  const list = parseJson(r.out);
  if (!Array.isArray(list)) return [];
  const out: { number: number; branch: string; green: boolean; failing: string[] }[] = [];
  for (const pr of list as { number?: unknown; headRefName?: unknown; statusCheckRollup?: unknown }[]) {
    if (pr === null || typeof pr !== "object" || typeof pr.number !== "number" || typeof pr.headRefName !== "string") continue;
    const checks = Array.isArray(pr.statusCheckRollup) ? (pr.statusCheckRollup as Record<string, unknown>[]) : [];
    const read = checks.filter((c) => c !== null && typeof c === "object").map((c) => {
      const conclusion = String(c["conclusion"] ?? c["state"] ?? "").toUpperCase();
      const done = c["status"] === undefined || String(c["status"]).toUpperCase() === "COMPLETED";
      return { name: String(c["name"] ?? c["context"] ?? "check"), passed: done && ROLLUP_PASSED.has(conclusion), failed: done && ROLLUP_FAILED.has(conclusion) };
    });
    out.push({ number: pr.number, branch: pr.headRefName, green: read.length > 0 && read.every((c) => c.passed), failing: [...new Set(read.filter((c) => c.failed).map((c) => c.name))] });
  }
  return out;
}

/** A local branch as the outline reads it: its tip, how far ahead of the default branch, whether the default branch holds it, where it is checked out. */
export interface BranchFact { tip: string; ahead?: number; inDefault: boolean; worktree?: string }

/**
 * Every local branch at once — a few git runs for all of them, not one per
 * work item — and the default branch's ref they are measured against.
 */
export function branchesFacts(root: string): { ok: boolean; base?: string; branches: Map<string, BranchFact> } {
  const branches = new Map<string, BranchFact>();
  const base = baseRefOf(root);
  // `%(ahead-behind:…)` is git 2.41's; before it, one count per branch.
  let refs = base === undefined ? undefined : run("git", ["for-each-ref", "refs/heads", `--format=%(refname:short)%09%(objectname)%09%(ahead-behind:${base})`], root);
  const counted = refs?.ok === true;
  if (!counted) refs = run("git", ["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(objectname)"], root);
  if (refs === undefined || !refs.ok) return { ok: false, branches };
  const merged = new Set(base === undefined ? [] : run("git", ["branch", "--merged", base, "--format=%(refname:short)"], root).out.split(/\r?\n/).filter((b) => b !== ""));
  for (const line of refs.out.split(/\r?\n/)) {
    const [branch, tip, aheadBehind] = line.split("\t");
    if (branch === undefined || branch === "" || tip === undefined) continue;
    let ahead: number | undefined = counted ? Number((aheadBehind ?? "").split(" ")[0]) : undefined;
    if (!counted && base !== undefined) {
      const c = run("git", ["rev-list", "--count", `${base}..refs/heads/${branch}`], root);
      ahead = c.ok ? Number(c.out) : undefined;
    }
    branches.set(branch, { tip, ...(ahead !== undefined && Number.isFinite(ahead) ? { ahead } : {}), inDefault: merged.has(branch) });
  }
  // The linked worktrees: the main working tree comes first in the list, and a branch checked out there is in no worktree of its own.
  const wt = run("git", ["worktree", "list", "--porcelain"], root);
  let at: string | undefined;
  let seen = 0;
  for (const line of wt.ok ? wt.out.split(/\r?\n/) : []) {
    if (line.startsWith("worktree ")) at = seen++ === 0 ? undefined : line.slice("worktree ".length);
    const m = /^branch refs\/heads\/(.+)$/.exec(line);
    const b = m === null ? undefined : branches.get(m[1]!);
    if (b !== undefined && at !== undefined) b.worktree = at;
  }
  return { ok: true, ...(base !== undefined ? { base } : {}), branches };
}

/** Whether the default branch `base` holds commit `sha`; undefined when git cannot say (a commit it no longer has). */
export function holdsCommit(root: string, base: string, sha: string): boolean | undefined {
  const r = run("git", ["merge-base", "--is-ancestor", sha, base], root);
  if (r.ok) return true;
  // Not an ancestor is a quiet exit 1; a commit git does not have says so on stderr.
  return r.error === undefined && r.err === "" ? false : undefined;
}

/** The project's pull requests by the branch each was opened from, the newest of a branch's; none when gh cannot be asked. */
export function pullRequestsByBranch(root: string, o: { gh?: string } = {}): Map<string, { number: number; state: "open" | "merged" | "closed" }> {
  const bin = o.gh || process.env["GEMFLOW_GH"] || "gh";
  const args = ["pr", "list", "--state", "all", "--limit", "100", "--json", "number,state,headRefName"];
  const r = /\.[cm]?js$/i.test(bin) ? run(process.execPath, [bin, ...args], root) : run(bin, args, root);
  const out = new Map<string, { number: number; state: "open" | "merged" | "closed" }>();
  const list = r.ok ? parseJson(r.out) : undefined;
  if (!Array.isArray(list)) return out;
  for (const pr of list as { number?: unknown; state?: unknown; headRefName?: unknown }[]) {
    if (pr === null || typeof pr !== "object" || typeof pr.number !== "number" || typeof pr.headRefName !== "string") continue;
    const state = String(pr.state ?? "").toLowerCase();
    if (state !== "open" && state !== "merged" && state !== "closed") continue;
    const had = out.get(pr.headRefName);
    if (had === undefined || had.number < pr.number) out.set(pr.headRefName, { number: pr.number, state });
  }
  return out;
}

/** ghFacts, asked at most once per branch by the function this returns: one request or tool call may read gh's facts twice (a refresh, then the status). */
export function ghOncePerBranch(): (root: string, branch: string) => GhFacts {
  const asked = new Map<string, GhFacts>();
  return (root, branch) => {
    const hit = asked.get(branch);
    if (hit) return hit;
    const facts = ghFacts(root, branch);
    asked.set(branch, facts);
    return facts;
  };
}
