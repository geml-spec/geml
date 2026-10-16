// Projects on disk for the tests that go through the bundled CLI.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLE = fileURLToPath(new URL("../../dist/gemflow.mjs", import.meta.url));

/** A git repository with one empty commit on main, checked out on `branch`. */
export function gitRepo(branch = "feat/x") {
  const root = mkdtempSync(join(tmpdir(), "gemflow-repo-"));
  const git = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("commit", "-q", "--allow-empty", "-m", "init");
  if (branch !== "main") git("checkout", "-qb", branch);
  return root;
}

/** Copy a workflow directory into the project and make it the active one. */
export function withWorkflow(root, dir, name) {
  mkdirSync(join(root, ".geml", "workflows"), { recursive: true });
  cpSync(dir, join(root, ".geml", "workflows", name), { recursive: true });
  writeFileSync(join(root, ".geml", "gemflow.geml"), `=== meta\nprofile = "geml-statechart/v1"\nflow-workflow = "${name}"\n===\n`);
}

// What host-git.ts asks gh: `pr list --head <branch> --state all --json state,number`
// and `run list --branch <branch> --limit 20 --json workflowName,conclusion,headSha,createdAt`.
const FAKE_GH = `#!/usr/bin/env node
// A stand-in for gh: answers \`pr list\` and \`run list\` from the JSON file FAKE_GH_STATE names.
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const s = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const [cmd, sub] = process.argv.slice(2);
if (cmd === "pr" && sub === "list") {
  process.stdout.write(JSON.stringify(s.pr ? [{ state: s.pr, number: 7 }] : []) + "\\n");
} else if (cmd === "run" && sub === "list") {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const runs = (s.runs || []).map((r) => ({ workflowName: r.name, conclusion: r.conclusion, headSha: head, createdAt: "2026-10-12T00:00:00Z" }));
  process.stdout.write(JSON.stringify(runs) + "\\n");
} else process.exit(1);
`;

/** A gh stand-in outside any repository; `set` rewrites what it answers. */
export function fakeGh() {
  const dir = mkdtempSync(join(tmpdir(), "gemflow-gh-"));
  const bin = join(dir, "fake-gh.cjs"); // a script ghFacts runs with Node, on Windows too
  const state = join(dir, "fake-gh.json");
  writeFileSync(bin, FAKE_GH);
  chmodSync(bin, 0o755);
  const set = (s) => writeFileSync(state, JSON.stringify(s));
  set({});
  return { env: { GEMFLOW_GH: bin, FAKE_GH_STATE: state }, set };
}

/** One bridge request through the bundled CLI: exactly one answer line, parsed. */
export function hook(root, req, env = {}) {
  const r = spawnSync(process.execPath, [BUNDLE, "hook"], {
    cwd: root, input: JSON.stringify({ v: 1, root, ...req }), encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000,
  });
  const lines = r.stdout.trim().split("\n");
  if (r.status !== 0 || lines.length !== 1) throw new Error(`hook exit ${r.status}: ${r.stdout}${r.stderr}`);
  return JSON.parse(lines[0]);
}
