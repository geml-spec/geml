import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, realpathSync, utimesSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { withLock, writeAtomic, globExists } from "../dist/host-fs.js";
import { checkoutOf, commitsOf, ghFacts, journalBaseOf, repoFacts, treeFingerprint } from "../dist/host-git.js";

const made = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "gemflow-host-")); made.push(d); return d; };
after(() => { delete process.env.FAKE_GH_MODE; for (const d of made) try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a scratch directory left behind is harmless */ } });

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const git = (d, ...a) => {
  const r = spawnSync("git", ["-C", d, ...a], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const repo = () => {
  const d = tmp();
  git(d, "init", "-q", "-b", "main"); git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t"); git(d, "config", "commit.gpgsign", "false");
  return d;
};

test("withLock runs the function under a lock file and removes it", () => {
  const d = tmp(); const p = join(d, "j.geml");
  const v = withLock(p, () => { assert.ok(existsSync(p + ".lock")); return 7; });
  assert.equal(v, 7);
  assert.ok(!existsSync(p + ".lock"));
});

test("withLock waits out a held lock and breaks a stale one", () => {
  const d = tmp(); const p = join(d, "j.geml");
  writeFileSync(p + ".lock", "999999");
  assert.throws(() => withLock(p, () => 1, { timeoutMs: 100, staleMs: 60_000 }), /is held/);
  const old = new Date(Date.now() - 120_000);
  utimesSync(p + ".lock", old, old);
  assert.equal(withLock(p, () => 2, { timeoutMs: 100, staleMs: 60_000 }), 2);
});

test("a held lock is reported with its holder, how long it has been held and what to do", () => {
  const d = tmp(); const p = join(d, "j.geml");
  writeFileSync(p + ".lock", "4242");
  assert.throws(
    () => withLock(p, () => 1, { timeoutMs: 50, staleMs: 60_000 }),
    (e) => /is held by another process/.test(e.message) && /pid 4242/.test(e.message) && /delete/.test(e.message) && e.message.includes(p + ".lock"),
  );
  assert.equal(readFileSync(p + ".lock", "utf8"), "4242", "a lock that is not stale is left alone");
});

test("withLock releases the lock when the function throws, and the error is the function's", () => {
  const d = tmp(); const p = join(d, "j.geml");
  assert.throws(() => withLock(p, () => { throw new RangeError("boom"); }), RangeError);
  assert.ok(!existsSync(p + ".lock"));
  assert.equal(withLock(p, () => "again"), "again");
});

test("withLock does not remove a lock that someone else holds now (ours was broken as stale while we ran)", () => {
  const d = tmp(); const p = join(d, "j.geml");
  withLock(p, () => { writeFileSync(p + ".lock", "31337 someone-else"); });
  assert.equal(readFileSync(p + ".lock", "utf8"), "31337 someone-else");
});

test("withLock makes the journal's directory", () => {
  const d = tmp(); const p = join(d, ".geml", "journals", "feat", "x.geml");
  withLock(p, () => { assert.ok(existsSync(p + ".lock")); });
  assert.ok(!existsSync(p + ".lock"));
});

test("withLock keeps another process out until it is released (one lock, two processes)", async () => {
  const d = tmp(); const p = join(d, "j.geml"); const mark = join(d, "mark");
  const hostFs = new URL("../dist/host-fs.js", import.meta.url).href;
  const script = join(d, "holder.mjs");
  writeFileSync(script, `
    import { withLock } from ${JSON.stringify(hostFs)};
    import { writeFileSync } from "node:fs";
    withLock(${JSON.stringify(p)}, () => {
      writeFileSync(${JSON.stringify(mark)}, "in");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      writeFileSync(${JSON.stringify(mark)}, "done");
    });
  `);
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  for (let i = 0; i < 400 && !existsSync(p + ".lock"); i++) sleep(25);
  assert.ok(existsSync(p + ".lock"), "the other process took the lock");
  const seen = withLock(p, () => readFileSync(mark, "utf8"), { timeoutMs: 10_000 });
  assert.equal(seen, "done", "we got the lock only after the holder finished");
  assert.equal(await exited, 0);
});

test("writeAtomic creates parents and replaces the file whole", () => {
  const d = tmp(); const p = join(d, "a", "b", "c.geml");
  writeAtomic(p, "one"); writeAtomic(p, "two");
  assert.equal(readFileSync(p, "utf8"), "two");
});

test("writeAtomic leaves the text exactly as given (CRLF and non-ASCII) and no temp file behind", () => {
  const d = tmp(); const p = join(d, "j.geml");
  const text = "=== meta\r\nname = \"登录\"\r\n===\r\n";
  writeAtomic(p, text);
  assert.equal(readFileSync(p, "utf8"), text);
  assert.deepEqual(readdirSync(d), ["j.geml"]);
});

test("writeAtomic's temp file has a name nobody else is writing: not the process id alone", () => {
  const d = tmp(); const p = join(d, "j.geml");
  // What another writer (a second Workspace in this process, a crashed run whose pid came round again) may have under the old, predictable name.
  const theirs = `${p}.${process.pid}.tmp`;
  writeFileSync(theirs, "someone else's half-written file");
  writeAtomic(p, "mine");
  assert.equal(readFileSync(p, "utf8"), "mine");
  assert.equal(readFileSync(theirs, "utf8"), "someone else's half-written file", "left alone, neither used nor removed");
  rmSync(theirs);
  mkdirSync(theirs);
  writeAtomic(p, "again");
  assert.equal(readFileSync(p, "utf8"), "again", "a directory with that name does not block the write either");
});

test("writeAtomic that cannot replace its target throws and leaves no temp file", () => {
  const d = tmp(); const p = join(d, "target");
  mkdirSync(p);
  assert.throws(() => writeAtomic(p, "x"));
  assert.deepEqual(readdirSync(d), ["target"]);
});

test("globExists searches the project, skipping .git, node_modules and .geml", () => {
  const d = tmp();
  mkdirSync(join(d, "out"), { recursive: true }); writeFileSync(join(d, "out", "ep01.mp4"), "");
  mkdirSync(join(d, "node_modules", "x"), { recursive: true }); writeFileSync(join(d, "node_modules", "x", "y.mp4"), "");
  assert.equal(globExists(d, "out/*.mp4"), true);
  assert.equal(globExists(d, "**/y.mp4"), false);
});

test("globExists reaches inside .geml/ when the glob names it outright, never into its journals", () => {
  const d = tmp();
  mkdirSync(join(d, ".geml", "matters"), { recursive: true }); writeFileSync(join(d, ".geml", "matters", "a.png"), "");
  mkdirSync(join(d, ".geml", "journals"), { recursive: true }); writeFileSync(join(d, ".geml", "journals", "x.geml"), "");
  assert.equal(globExists(d, ".geml/matters/*.png"), true);
  assert.equal(globExists(d, ".geml/journals/*.geml"), false);
  assert.equal(globExists(d, ".geml/**/x.geml"), false, "a glob that enters .geml/ still walks past its journals");
  assert.equal(globExists(d, "**/a.png"), false, "a glob that does not name .geml/ still skips it");
});

test("globExists agrees with the work-item glob: * stays in a segment, ** crosses, ? is one character", () => {
  const d = tmp();
  mkdirSync(join(d, "episodes", "s1"), { recursive: true });
  writeFileSync(join(d, "episodes", "s1", "ep02.geml"), "");
  mkdirSync(join(d, ".geml", "journals"), { recursive: true });
  writeFileSync(join(d, ".geml", "journals", "ep09.geml"), "");
  assert.equal(globExists(d, "episodes/*.geml"), false);
  assert.equal(globExists(d, "episodes/**/*.geml"), true);
  assert.equal(globExists(d, "episodes/s?/ep02.geml"), true);
  assert.equal(globExists(d, "episodes/s??/ep02.geml"), false);
  assert.equal(globExists(d, "**/ep09.geml"), false, "the runtime's own directory is not the project");
  assert.equal(globExists(d, "ep02.geml"), false, "a glob is a whole project-relative path");
});

test("globExists gives up at its limit - not established, which is not no - and on a root that is not there", () => {
  const d = tmp();
  for (let i = 0; i < 3; i++) writeFileSync(join(d, `a${i}.mp4`), "");
  assert.equal(globExists(d, "*.mp4"), true);
  assert.equal(globExists(d, "*.mp4", 1), true, "the first entry looked at is within the limit");
  assert.equal(globExists(d, "*.mp4", 0), undefined, "past the limit nothing is known");
  assert.equal(globExists(d, "*.webm", 2), undefined, "three entries, two looked at, no match yet");
  assert.equal(globExists(d, "*.webm", 3), false, "all three looked at: a real no");
  assert.equal(globExists(join(d, "nope"), "*.mp4"), false);
});

test("globExists walks only below the glob's literal directories, so a big tree elsewhere does not use up the limit", () => {
  const d = tmp();
  mkdirSync(join(d, "elsewhere"));
  for (let i = 0; i < 20; i++) writeFileSync(join(d, "elsewhere", `f${i}.txt`), "");
  mkdirSync(join(d, "out", "final"), { recursive: true });
  writeFileSync(join(d, "out", "final", "ep01.mp4"), "");
  assert.equal(globExists(d, "out/final/*.mp4", 3), true, "root: 2 entries are read for the prefix, not counted; then one entry");
  assert.equal(globExists(d, "out/**/*.mp4", 3), true);
  assert.equal(globExists(d, "out/final/*.webm", 3), false, "one entry below the prefix: a no that was established");
  assert.equal(globExists(d, "**/*.webm", 3), undefined, "without a prefix the walk goes through elsewhere's files too, and gives up");
  assert.equal(globExists(d, "missing/dir/*.mp4"), false);
  assert.equal(globExists(d, "out/final/ep01.mp4"), true, "a glob with no wildcard at all is a path");
});

test("globExists keeps the rules of a whole walk when it starts below the root: case, links, and the runtime's own directories", { skip: process.platform === "win32" }, () => {
  const d = tmp();
  mkdirSync(join(d, "real", "sub"), { recursive: true }); writeFileSync(join(d, "real", "sub", "x.mp4"), "");
  symlinkSync(join(d, "real"), join(d, "link"));
  mkdirSync(join(d, ".geml", "codemap"), { recursive: true }); writeFileSync(join(d, ".geml", "codemap", "index.geml"), "");
  mkdirSync(join(d, ".geml", "journals"), { recursive: true }); writeFileSync(join(d, ".geml", "journals", "x.geml"), "");
  mkdirSync(join(d, "node_modules", "p"), { recursive: true }); writeFileSync(join(d, "node_modules", "p", "y.geml"), "");
  mkdirSync(join(d, "Episodes")); writeFileSync(join(d, "Episodes", "e.geml"), "");
  assert.equal(globExists(d, "real/sub/*.mp4"), true);
  assert.equal(globExists(d, "link/sub/*.mp4"), false, "a link to a directory is not followed, at the root or in a prefix");
  assert.equal(globExists(d, ".geml/codemap/*.geml"), true, "a glob whose first segment is .geml reaches inside it");
  assert.equal(globExists(d, ".geml/journals/*.geml"), false, "never into the journals");
  assert.equal(globExists(d, "node_modules/p/*.geml"), false, "another ignored directory is not the project, even when the glob names it");
  assert.equal(globExists(d, "Episodes/*.geml"), true);
  assert.equal(globExists(d, "episodes/*.geml"), false, "the glob is case-sensitive, whatever the file system is");
  assert.equal(globExists(d, "./real/sub/*.mp4"), false, "no path starts with ./");
  assert.equal(globExists(d, "../x/*.mp4"), false);
});

test("globExists skips a directory it cannot read and keeps looking elsewhere", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const d = tmp();
  mkdirSync(join(d, "a-locked")); writeFileSync(join(d, "a-locked", "x.mp4"), "");
  mkdirSync(join(d, "b-open")); writeFileSync(join(d, "b-open", "y.mp4"), "");
  chmodSync(join(d, "a-locked"), 0o000);
  try { assert.equal(globExists(d, "**/y.mp4"), true); } finally { chmodSync(join(d, "a-locked"), 0o755); }
});

test("repoFacts reads branch, default branch and whether the branch has commits", () => {
  const d = tmp();
  const git = (...a) => spawnSync("git", ["-C", d, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
  writeFileSync(join(d, "f"), "1"); git("add", "f"); git("commit", "-qm", "one");
  assert.deepEqual(repoFacts(d), { branch: "main", defaultBranch: "main", committed: false });
  git("checkout", "-qb", "feat/x");
  assert.deepEqual(repoFacts(d), { branch: "feat/x", defaultBranch: "main", committed: false });
  writeFileSync(join(d, "f"), "2"); git("commit", "-qam", "two");
  assert.deepEqual(repoFacts(d), { branch: "feat/x", defaultBranch: "main", committed: true });
  assert.deepEqual(repoFacts(tmp()), {});
});

test("commitsOf: a branch's own commits, or the ones in a time window, only those touching some paths when asked; newest first, with every file each changed", () => {
  const d = tmp();
  const git = (date, ...a) => {
    const r = spawnSync("git", ["-C", d, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    assert.equal(r.status, 0, r.stderr);
  };
  const T1 = "2026-10-01 10:00:00 +0000", T2 = "2026-10-02 10:00:00 +0000", T3 = "2026-10-03 10:00:00 +0000";
  git(T1, "init", "-q", "-b", "main"); git(T1, "config", "user.email", "t@t"); git(T1, "config", "user.name", "t"); git(T1, "config", "commit.gpgsign", "false");
  writeFileSync(join(d, "a.txt"), "1"); git(T1, "add", "a.txt"); git(T1, "commit", "-qm", "one");
  git(T1, "checkout", "-qb", "feat/x");
  mkdirSync(join(d, "src")); writeFileSync(join(d, "src", "b 一.ts"), "1"); git(T2, "add", "-A"); git(T2, "commit", "-qm", "two");
  writeFileSync(join(d, "a.txt"), "2"); writeFileSync(join(d, "c.md"), "c"); git(T3, "add", "-A"); git(T3, "commit", "-qm", "three");
  const brief = (cs) => cs.map((c) => [c.subject, c.files]);
  assert.deepEqual(brief(commitsOf(d, { ownBranch: true })), [["three", ["a.txt", "c.md"]], ["two", ["src/b 一.ts"]]]);
  const [last] = commitsOf(d, { ownBranch: true }, 1);
  assert.match(last.sha, /^[0-9a-f]{40,64}$/);
  assert.equal(Date.parse(last.at), Date.parse("2026-10-03T10:00:00Z"));
  assert.deepEqual(brief(commitsOf(d, { since: "2026-10-01T12:00:00.250Z", until: "2026-10-02T12:00:00Z" })), [["two", ["src/b 一.ts"]]]);
  assert.deepEqual(brief(commitsOf(d, { since: "2026-10-01T00:00:00Z", paths: ["c.md"] })), [["three", ["a.txt", "c.md"]]], "every file the commit changed, not only the path asked about");
  assert.equal(commitsOf(d, { since: "not a time" }).length, 3, "a time that cannot be read limits nothing");
  git(T3, "checkout", "-q", "main");
  assert.deepEqual(commitsOf(d, { ownBranch: true }), [], "the default branch has none of its own");
  assert.deepEqual(commitsOf(tmp(), { ownBranch: true }), [], "no repository");
});

test("treeFingerprint: the working content's tree; a commit changes nothing, an edit or a new file does; Gemflow's own .geml files change nothing", () => {
  const d = repo();
  writeFileSync(join(d, "f"), "1"); git(d, "add", "f"); git(d, "commit", "-qm", "one");
  const clean = treeFingerprint(d);
  assert.match(clean, /^tree:[0-9a-f]{40,64}$/);
  mkdirSync(join(d, ".geml"), { recursive: true });
  writeFileSync(join(d, ".geml", "context.geml"), "x");
  assert.equal(treeFingerprint(d), clean, "a write under .geml is no change of the work item");
  writeFileSync(join(d, "f"), "22");
  const edited = treeFingerprint(d);
  assert.notEqual(edited, clean);
  assert.equal(treeFingerprint(d), edited, "the same content, the same fingerprint");
  git(d, "commit", "-qam", "two");
  assert.equal(treeFingerprint(d), edited, "a commit is no change of the content");
  assert.equal(git(d, "diff", "--cached", "--name-only"), "", "the real index is untouched: nothing staged");
  writeFileSync(join(d, "new.txt"), "n");
  assert.notEqual(treeFingerprint(d), edited, "an untracked file is content too");
  assert.equal(treeFingerprint(tmp()), undefined, "no repository, no fingerprint");
});

test("repoFacts on a branch with no commits yet names the branch and says there are none", () => {
  const d = repo();
  assert.deepEqual(repoFacts(d), { branch: "main", noCommits: true }, "rev-parse cannot resolve HEAD here; symbolic-ref can");
  git(d, "symbolic-ref", "HEAD", "refs/heads/feat/x");
  assert.deepEqual(repoFacts(d), { branch: "feat/x", noCommits: true }, "no default branch is known, and nothing is committed: nothing more is said");
  mkdirSync(join(d, "sub"));
  assert.deepEqual(repoFacts(join(d, "sub")), { branch: "feat/x", noCommits: true }, "from a subdirectory too");
  writeFileSync(join(d, "f"), "1"); git(d, "add", "f"); git(d, "commit", "-qm", "one");
  assert.deepEqual(repoFacts(d), { branch: "feat/x" }, "the first commit ends it: no noCommits, and still no default branch to compare with");
  assert.deepEqual(repoFacts(tmp()), {}, "no repository at all stays unsaid");
});

test("repoFacts on a detached head names no commits (not established), and a missing directory is no repository", () => {
  const d = repo();
  writeFileSync(join(d, "f"), "1"); git(d, "add", "f"); git(d, "commit", "-qm", "one");
  git(d, "checkout", "-q", "--detach");
  assert.deepEqual(repoFacts(d), { branch: "HEAD", defaultBranch: "main" });
  assert.deepEqual(repoFacts(join(d, "no-such-directory")), {});
});

test("repoFacts takes the default branch from the remote's HEAD when there is one", () => {
  const origin = repo();
  git(origin, "checkout", "-q", "-b", "trunk");
  writeFileSync(join(origin, "f"), "1"); git(origin, "add", "f"); git(origin, "commit", "-qm", "one");
  const clone = join(tmp(), "clone");
  assert.equal(spawnSync("git", ["clone", "-q", origin, clone], { encoding: "utf8" }).status, 0);
  git(clone, "config", "user.email", "t@t"); git(clone, "config", "user.name", "t"); git(clone, "config", "commit.gpgsign", "false");
  assert.deepEqual(repoFacts(clone), { branch: "trunk", defaultBranch: "trunk", committed: false });
  git(clone, "checkout", "-q", "-b", "feat/y");
  writeFileSync(join(clone, "f"), "2"); git(clone, "commit", "-qam", "two");
  assert.deepEqual(repoFacts(clone), { branch: "feat/y", defaultBranch: "trunk", committed: true });
});

test("ghFacts reports itself unavailable when gh is missing", () => {
  const r = ghFacts(tmp(), "feat/x", { gh: "gh-definitely-not-installed" });
  assert.equal(r.available, false);
  assert.match(r.reason, /gh is not installed/);
});

test("ghFacts on a directory that is not there does not blame gh's installation", () => {
  const r = ghFacts(join(tmp(), "no-such-directory"), "feat/x", { gh: "gh-definitely-not-installed" });
  assert.equal(r.available, false);
  assert.doesNotMatch(r.reason, /not installed/);
});

// A stand-in gh: what it answers is chosen by FAKE_GH_MODE; its runs carry the head commit of the repository it is run in.
// Every call's arguments are appended to FAKE_GH_LOG, one JSON array a line.
const FAKE_GH = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const [cmd, sub] = args;
const mode = process.env.FAKE_GH_MODE;
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
const head = () => spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const flag = (name) => args[args.indexOf(name) + 1];
if (cmd === "pr" && sub === "list") {
  if (mode === "auth") { process.stderr.write("HTTP 401: Bad credentials\\nTry authenticating with:  gh auth login\\n"); process.exit(1); }
  if (mode === "garbage") { process.stdout.write("<html>\\n"); process.exit(0); }
  const state = mode === "merged" ? "MERGED" : mode === "closed" ? "CLOSED" : "OPEN";
  let prs = mode === "nopr" ? [] : [{ state, number: 7 }];
  if (mode === "history") prs = [{ state: "MERGED", number: 3 }, { state: "OPEN", number: 9 }, { state: "CLOSED", number: 5 }];
  if (mode === "history-closed") prs = [{ state: "MERGED", number: 3 }, { state: "CLOSED", number: 9 }];
  if (mode === "numeric") prs = flag("--head") === "123" ? [{ state: "OPEN", number: 4 }] : [];
  process.stdout.write(JSON.stringify(prs) + "\\n");
} else if (cmd === "run" && sub === "list") {
  if (mode === "runs-fail") process.exit(1);
  const h = head();
  const run = (workflowName, conclusion, createdAt, headSha = h) => ({ workflowName, conclusion, headSha, createdAt });
  let runs = [run("ci", "success", "2026-10-12T10:00:00Z"), run("lint", "", "2026-10-12T10:00:00Z"), run("old", "success", "2026-10-12T10:00:00Z", "0".repeat(40))];
  // gh lists the newest run first.
  if (mode === "rerun-passed") runs = [run("ci", "success", "2026-10-12T10:05:00Z"), run("ci", "failure", "2026-10-12T10:00:00Z"), run("lint", "success", "2026-10-12T10:01:00Z")];
  if (mode === "rerun-failed") runs = [run("ci", "failure", "2026-10-12T10:05:00Z"), run("ci", "success", "2026-10-12T10:00:00Z"), run("lint", "success", "2026-10-12T10:01:00Z")];
  if (mode === "rerun-unsorted") runs = [run("ci", "failure", "2026-10-12T10:00:00Z"), run("ci", "success", "2026-10-12T10:05:00Z")];
  if (mode === "skipped") runs = [run("ci", "success", "2026-10-12T10:00:00Z"), run("docs", "skipped", "2026-10-12T10:00:00Z"), run("lint", "neutral", "2026-10-12T10:00:00Z"), run("deploy", "cancelled", "2026-10-12T10:00:00Z")];
  process.stdout.write(JSON.stringify(runs) + "\\n");
} else process.exit(2);
`;

const standIn = (mode) => {
  const dir = tmp();
  const bin = join(dir, "fake-gh.cjs"); // ghFacts runs a .cjs stand-in with Node, on Windows too
  writeFileSync(bin, FAKE_GH);
  chmodSync(bin, 0o755);
  const root = repo();
  writeFileSync(join(root, "f"), "1"); git(root, "add", "f"); git(root, "commit", "-qm", "one");
  const answer = (m) => { process.env.FAKE_GH_MODE = m; };
  answer(mode);
  return { bin, root, answer };
};

test("ghFacts reads the pull request and the CI runs on the branch head", () => {
  const { bin, root, answer } = standIn("open");
  // lint is still going: not a success, and not a failure either.
  const ci = [{ workflow: "ci", success: true }, { workflow: "lint", success: false }];
  const open = ghFacts(root, "feat/x", { gh: bin });
  assert.match(open.head, /^[0-9a-f]{40}$/, "the head the runs were read on");
  assert.deepEqual(open, { available: true, prOpen: true, prMerged: false, ci, head: open.head });
  answer("merged");
  assert.deepEqual(ghFacts(root, "feat/x", { gh: bin }), { available: true, prOpen: false, prMerged: true, ci, head: open.head });
  answer("closed");
  const closed = ghFacts(root, "feat/x", { gh: bin });
  assert.equal(closed.prOpen, false); assert.equal(closed.prMerged, false);
});

test("ghFacts: no pull request is a fact, not an outage", () => {
  const { bin, root } = standIn("nopr");
  const r = ghFacts(root, "feat/x", { gh: bin });
  assert.equal(r.available, true);
  assert.equal(r.prOpen, false); assert.equal(r.prMerged, false);
});

test("ghFacts lists the pull requests whose head is the branch, so a branch named like a number is a branch", () => {
  const { bin, root, answer } = standIn("numeric");
  const log = join(tmp(), "gh.log");
  process.env.FAKE_GH_LOG = log;
  try {
    const r = ghFacts(root, "123", { gh: bin });
    assert.equal(r.available, true);
    assert.equal(r.prOpen, true, "123 is the branch, not pull request 123");
    assert.equal(ghFacts(root, "124", { gh: bin }).prOpen, false);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const asked = calls.find((c) => c[0] === "pr");
    assert.deepEqual(asked, ["pr", "list", "--head", "123", "--state", "all", "--json", "state,number"]);
    assert.ok(!calls.some((c) => c[1] === "view"), "pr view takes a number, a URL or a branch, and tells them apart by looking");
    assert.deepEqual(calls.find((c) => c[0] === "run").slice(0, 4), ["run", "list", "--branch", "123"]);
  } finally { delete process.env.FAKE_GH_LOG; }
});

test("ghFacts: the newest pull request of the branch is the one that counts, and any other is history", () => {
  const { bin, root, answer } = standIn("history");
  const open = ghFacts(root, "feat/x", { gh: bin });
  assert.equal(open.prOpen, true, "#9 is the newest and open; #3 was merged long ago");
  assert.equal(open.prMerged, false);
  answer("history-closed");
  const closed = ghFacts(root, "feat/x", { gh: bin });
  assert.equal(closed.prOpen, false);
  assert.equal(closed.prMerged, false, "#9 is the newest and closed unmerged; the merged #3 does not make the branch merged");
});

test("ghFacts: gh that is not logged in, or answers nonsense, is unavailable with a reason", () => {
  const { bin, root, answer } = standIn("auth");
  const auth = ghFacts(root, "feat/x", { gh: bin });
  assert.equal(auth.available, false);
  assert.match(auth.reason, /gh could not be queried/);
  assert.match(auth.reason, /Bad credentials/, "gh's own first line says why");
  answer("garbage");
  const junk = ghFacts(root, "feat/x", { gh: bin });
  assert.equal(junk.available, false);
  assert.match(junk.reason, /not a JSON list of pull requests/);
});

test("ghFacts: CI is the newest run of each workflow on the head, whatever order gh lists them in", () => {
  const { bin, root, answer } = standIn("rerun-passed");
  const ci = (mode) => { answer(mode); return ghFacts(root, "feat/x", { gh: bin }).ci; };
  assert.deepEqual(ci("rerun-passed"), [{ workflow: "ci", success: true }, { workflow: "lint", success: true }], "the re-run passed; the failure it replaced is history");
  assert.deepEqual(ci("rerun-failed"), [{ workflow: "ci", success: false, failed: true }, { workflow: "lint", success: true }], "a newer failure beats an older pass");
  assert.deepEqual(ci("rerun-unsorted"), [{ workflow: "ci", success: true }], "the newest by its time, not by its place in the list");
});

test("ghFacts: a skipped or neutral run is not a failure; a cancelled one is", () => {
  const { bin, root } = standIn("skipped");
  assert.deepEqual(ghFacts(root, "feat/x", { gh: bin }).ci, [
    { workflow: "ci", success: true }, { workflow: "docs", success: true }, { workflow: "lint", success: true }, { workflow: "deploy", success: false, failed: true },
  ]);
});

test("ghFacts: CI that cannot be listed is not established, and the pull request facts stand", () => {
  const { bin, root } = standIn("runs-fail");
  const r = ghFacts(root, "feat/x", { gh: bin });
  assert.equal(r.available, true); assert.equal(r.prOpen, true);
  assert.ok(!("ci" in r));
});

test("GEMFLOW_GH names the gh binary; an explicit option wins over it", () => {
  const { bin, root } = standIn("open");
  const saved = process.env.GEMFLOW_GH;
  try {
    process.env.GEMFLOW_GH = bin;
    assert.equal(ghFacts(root, "feat/x").available, true);
    process.env.GEMFLOW_GH = "gh-definitely-not-installed";
    assert.match(ghFacts(root, "feat/x").reason, /not installed/);
    assert.equal(ghFacts(root, "feat/x", { gh: bin }).available, true);
  } finally {
    if (saved === undefined) delete process.env.GEMFLOW_GH; else process.env.GEMFLOW_GH = saved;
    delete process.env.FAKE_GH_MODE;
  }
});

test("checkoutOf: the working tree's top, the common directory and the main working tree, from the main tree, a subdirectory and a worktree", () => {
  const d = repo();
  git(d, "commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(join(d, "sub", "deeper"), { recursive: true });
  const wt = join(d, ".claude", "worktrees", "w");
  git(d, "worktree", "add", "-q", "-b", "w", wt);
  const real = realpathSync.native(d);
  const main = { top: real, common: join(real, ".git"), main: real };
  assert.deepEqual(checkoutOf(d), main);
  assert.deepEqual(checkoutOf(join(d, "sub", "deeper")), main, "a subdirectory is in the same checkout");
  assert.deepEqual(checkoutOf(wt), { top: realpathSync.native(wt), common: join(real, ".git"), main: real });
  assert.equal(checkoutOf(tmp()), undefined, "no repository");
  assert.equal(checkoutOf(join(d, "missing")), undefined, "a directory that is not there");
});

test("journalBaseOf: the main working tree's copy of the project's directory, shared by every checkout; a project's own outside git", () => {
  const d = repo();
  git(d, "commit", "-q", "--allow-empty", "-m", "init");
  const wt = join(d, ".claude", "worktrees", "w");
  git(d, "worktree", "add", "-q", "-b", "w", wt);
  mkdirSync(join(wt, "app"), { recursive: true });
  mkdirSync(join(d, "app"), { recursive: true });
  const real = realpathSync.native(d);
  assert.equal(journalBaseOf(d), d, "the main working tree keeps its own, the root as given");
  assert.equal(journalBaseOf(join(d, "app")), join(d, "app"), "a project in a subdirectory of the main tree");
  assert.equal(journalBaseOf(wt), real, "a worktree's journals are the main tree's");
  assert.equal(journalBaseOf(join(wt, "app")), join(real, "app"), "a project in a subdirectory: the same subdirectory of the main tree");
  const plain = tmp();
  assert.equal(journalBaseOf(plain), plain, "no repository: the project's own");
  // A bare repository has no main working tree to share: each of its worktrees keeps its own.
  const bare = join(tmp(), "b.git");
  spawnSync("git", ["clone", "-q", "--bare", d, bare], { encoding: "utf8" });
  const other = join(tmp(), "wt2");
  git(bare, "worktree", "add", "-q", other, "main");
  assert.equal(checkoutOf(other)?.main, undefined);
  assert.equal(journalBaseOf(other), other);
});
