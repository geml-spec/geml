#!/usr/bin/env node
// gemflow — offline verbs over workflows and journals, the project verbs a
// person uses beside an agent (init, use, status, mark, unmark, advance,
// rollback), and `run`, which is the one verb that reaches outside this
// package (it starts dsh).
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { exists, readText, realPath } from "./host-fs.js";
import { FLOW_FILE, GEML_DIR, WORKFLOWS_DIR } from "./core/layout.js";
import { run as runTask } from "./hosts/dsh/launch.js";
import { loadStatechart, hasErrors, type FlowDiagnostic } from "./core/statechart.js";
import { TOOLS_FILE } from "./core/dictionary.js";
import { readDictionary } from "./core/dictionary-file.js";
import { dictionaryPathOf, homeOf, installedWorkflows, migrateLayout } from "./project-home.js";
import { NO_TOOLS } from "./core/host-tools.js";
import { readJournal, renderJournalMarkdown, verifyJournal } from "./core/journal.js";
import { canonical } from "./core/snapshot.js";
import { addWorkflow, useWorkflow, type Added } from "./project.js";
import { handleRequest } from "./bridge.js";
import { runCodex } from "./codex.js";
import { installAntigravity, runAntigravity } from "./antigravity.js";
import { serveMcp } from "./mcp.js";
import { decodeRequest, type BridgeResponse } from "./hosts/claude-code/protocol.js";
import { docReader, openWorkspace, resolvePromptRef, resolveWorkflow, type Workspace } from "./workspace.js";

const USAGE = [
  "usage: gemflow <check|snapshot|verify|export|init|use|migrate|status|mark|unmark|advance|pause|resume|rollback|run|hook|mcp> ...",
  "  check <workflow.geml>                   static checks of the workflow and its tool dictionary (exit 1 on errors)",
  "  snapshot <journal.geml> [--json]        the last revision",
  "  verify <journal.geml> [--workflow f]    hash chain and consistency",
  "  export <journal.geml> --to md           revision table with per-step diffs",
  "  init [dir] [--template coding|dev|matter|refund|video] [--no-activate]  write a bundled workflow into .geml/workflows/",
  "  use <workflow>                          make a workflow the default for new work items",
  "  migrate                                 move the earlier layout (a workflow directory in the checkout) into the project's home",
  "  status [--json]                         the work item, the stage, its variables and next steps",
  "  mark <variable> | unmark <variable>     a person ticks or clears a variable whose source is a person",
  "  advance <state>                         a person moves the workflow",
  "  pause | resume                          a person holds the work item (evidence is recorded, nothing moves) or lets it go",
  "  rollback [<rev>|checkpoint]             a person restores an earlier revision's state and variables",
  "  run [--profile name] <task>             add the bundle to a dsh profile and run the task there",
  "  hook                                    the Claude Code bridge: one JSON request on stdin, one answer on stdout",
  "  codex                                   the Codex hook: one event on stdin, its answer on stdout (exit 0 always)",
  "  antigravity <Event> | install           the Antigravity editor's hook (one event on stdin), or put its hooks and MCP server in place",
  "  mcp [--host h] [--root dir]             the three model tools over stdio MCP (host default: mcp)",
].join("\n");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) fail(`${name} needs a value`, 2);
  return value;
}
const has = (args: string[], name: string) => args.includes(name);

function printDiagnostics(ds: readonly FlowDiagnostic[]): void {
  for (const d of ds) console.error(`${d.severity}: ${d.code}: ${d.message} (line ${d.line})`);
  const errs = ds.filter((d) => d.severity === "error").length;
  const warns = ds.filter((d) => d.severity === "warning").length;
  const infos = ds.length - errs - warns;
  if (errs || warns) console.error(`${errs} error(s), ${warns} warning(s)${infos ? `, ${infos} info` : ""}`);
  else console.error(infos ? `ok: no errors or warnings (${infos} info)` : "ok: no diagnostics");
}

function fail(msg: string, code: 1 | 2): never {
  console.error(msg);
  process.exit(code);
}

/** Read a file the user named, or exit 1 with one clean line instead of a stack trace. */
function readOrFail(path: string): string {
  try { return readText(path); }
  catch (e) {
    const err = e as NodeJS.ErrnoException;
    return fail(`gemflow: cannot read ${path}${err.code ? ` (${err.code})` : ""}`, 1);
  }
}

/**
 * The arguments that are neither a flag nor a flag's value. A flag the verb
 * does not know is a usage error: a misspelt `--jsno` must not run as if it
 * had not been typed.
 */
function positionals(verb: string, args: string[], flags: readonly string[], valued: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) { i++; continue; }
    if (flags.includes(a)) continue;
    if (a.startsWith("--")) fail(`gemflow ${verb}: unknown option ${a}`, 2);
    out.push(a);
  }
  return out;
}

const slashed = (p: string): string => p.split(sep).join("/");

/** How a path under the working directory is shown: relative to it, `/`-separated. */
const shown = (p: string): string => slashed(relative(process.cwd(), p) || ".");

/**
 * The project a workflow file belongs to: the home whose
 * `.geml/workflows/<name>.geml` it is — the checkout the shell stands in when
 * that is one of the home's — or where `.geml/workflows/<name>/` (the earlier
 * layout) says it is; a workflow file anywhere else is checked against the
 * working directory.
 */
function projectOf(flowPath: string): string {
  const workflowDir = dirname(flowPath);
  if (basename(flowPath).toLowerCase() !== FLOW_FILE && basename(workflowDir) === "workflows" && basename(dirname(workflowDir)) === GEML_DIR) {
    const home = dirname(dirname(workflowDir));
    return realPath(homeOf(process.cwd())) === realPath(home) ? process.cwd() : home;
  }
  const above = resolve(workflowDir, "..", "..", "..");
  return resolve(above, WORKFLOWS_DIR, basename(workflowDir)) === workflowDir ? above : process.cwd();
}

/**
 * Whether a state's `prompt` names a section or document that exists,
 * resolved as the workspace resolves it for Stagehand (`resolvePromptRef`); a
 * reference outside the project is an error, not a miss.
 */
function promptResolver(flowPath: string, root: string): (ref: string) => boolean {
  return (ref) => {
    const found = resolvePromptRef(ref, flowPath, root);
    if (found.kind === "outside") throw new Error("the path lies outside the project");
    return found.kind === "found";
  };
}

/**
 * Open the project's workspace and run `fn` on it. Opening can fail with a
 * reason, and opening or acting can throw (a journal that fails verification,
 * a verb that kept conflicting with another process): both are one line and
 * exit 1, never a stack trace.
 */
function withWorkspace(fn: (ws: Workspace) => number): number {
  try {
    const opened = openWorkspace({ root: process.cwd(), tools: NO_TOOLS });
    if (!opened.ok) return fail(`gemflow: ${opened.reason}`, 1);
    return fn(opened.ws);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return fail(message.startsWith("gemflow:") ? message : `gemflow: ${message}`, 1);
  }
}

const chain = (states: readonly string[]): string => states.map((s) => `#${s}`).join(" → ");

/** `gemflow hook`: one request in, one answer line out. The exit code is 0 whatever the answer says; handleRequest never throws. */
async function runHook(): Promise<number> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const req = decodeRequest(text);
  const res: BridgeResponse = "error" in req ? { v: 1, ok: false, error: req.error } : await handleRequest(req);
  process.stdout.write(`${JSON.stringify(res)}\n`);
  return 0;
}

/** `gemflow codex`: one Codex hook event in, its answer out. Exit 0 whatever happened: a hook that fails must not take the session with it; the reason goes to stderr. */
async function runCodexHook(): Promise<number> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    const r = await runCodex(text, process.env);
    process.stdout.write(r.stdout);
    return r.code;
  } catch (e) {
    process.stderr.write(`gemflow codex: ${e instanceof Error ? e.message : String(e)}\n`);
    return 0;
  }
}

/** `gemflow antigravity <Event>`: one Antigravity hook event in, its answer out; exit 0 whatever happened. `install` puts the hooks and the MCP server in place. */
async function runAntigravityHook(event: string | undefined): Promise<number> {
  if (event === "install") {
    for (const f of installAntigravity(resolve(process.argv[1] ?? "gemflow.mjs"))) process.stdout.write(`${f}\n`);
    return 0;
  }
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    process.stdout.write(runAntigravity(event ?? "", text).stdout);
  } catch (e) {
    process.stderr.write(`gemflow antigravity: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  return 0;
}

function main(argv: string[]): number {
  const [verb, ...rest] = argv;
  if (!verb) fail(USAGE, 2);
  switch (verb) {
    case "check": {
      const pos = positionals("check", rest, [], []);
      const file = pos[0];
      if (file === undefined || pos.length !== 1) fail(USAGE, 2);
      const path = resolve(file);
      const root = projectOf(path);
      const r = loadStatechart(readOrFail(path), file, { resolveRef: promptResolver(path, root), readDoc: docReader(dirname(path), root) });
      const ds = [...r.diagnostics];
      // The workflow's dictionary is checked against it — the project's one against all its workflows: its states must be theirs, its uses declared.
      const dict = dictionaryPathOf(path);
      if (r.statechart !== undefined && exists(dict)) {
        const own = dict === join(dirname(path), TOOLS_FILE);
        const others = own ? [] : installedWorkflows(root).filter((w) => realPath(w.path) !== realPath(path))
          .flatMap((w) => { try { return [loadStatechart(readText(w.path), w.path).statechart].filter((c) => c !== undefined); } catch { return []; } });
        for (const d of readDictionary(readOrFail(dict), [r.statechart, ...others]).diagnostics) ds.push({ ...d, message: `${TOOLS_FILE}: ${d.message}` });
      }
      printDiagnostics(ds);
      return hasErrors(ds) ? 1 : 0;
    }
    case "snapshot": {
      const file = rest[0]; if (!file || file.startsWith("--")) fail(USAGE, 2);
      const journal = readJournal(readOrFail(resolve(file)));
      const last = journal.snapshots[journal.snapshots.length - 1];
      if (!last) fail(`${file}: no revision`, 1);
      if (has(rest, "--json")) { console.log(JSON.stringify(last)); return 0; }
      const from = last.from !== undefined ? ` · from #${last.from}` : "";
      const restores = last.restores !== undefined ? ` · restores ${last.restores}` : "";
      console.log(`rev ${last.rev} · state #${last.state} · cause ${last.cause}${from}${restores}\nvars: ${canonical(last.vars)}\nhash: ${last.hash}\nat: ${last.at}`);
      return 0;
    }
    case "verify": {
      const file = rest[0]; if (!file || file.startsWith("--")) fail(USAGE, 2);
      const scPath = flag(rest, "--workflow");
      let sc;
      if (scPath) {
        const path = resolve(scPath);
        const r = loadStatechart(readOrFail(path), scPath, { readDoc: docReader(dirname(path), projectOf(path)) });
        if (!r.statechart) { printDiagnostics(r.diagnostics); return 1; }
        sc = r.statechart;
      }
      const errors = verifyJournal(readJournal(readOrFail(resolve(file))), sc);
      for (const e of errors) console.error(e);
      console.error(errors.length ? `${errors.length} error(s)` : "ok: chain verified");
      return errors.length ? 1 : 0;
    }
    case "export": {
      const file = rest[0]; if (!file || file.startsWith("--")) fail(USAGE, 2);
      if (flag(rest, "--to") !== "md") fail("export: only --to md is supported", 2);
      console.log(renderJournalMarkdown(readJournal(readOrFail(resolve(file)))));
      return 0;
    }
    case "init": {
      // `coding` is the default because that is what a repository is for: the
      // states are explore / plan / implement / verify / review, and the point
      // of them is that a file cannot be edited before a plan is recorded and
      // nothing reaches "done" without a recorded test result.
      const template = flag(rest, "--template") ?? "coding";
      const pos = positionals("init", rest, ["--no-activate"], ["--template"]);
      if (pos.length > 1) fail(USAGE, 2);
      let r: Added;
      try { r = addWorkflow(resolve(pos[0] ?? "."), template, { activate: !has(rest, "--no-activate") }); }
      catch (e) { return fail(String(e), 1); }
      if (!r.ok) return fail(r.code === 1 ? `${shown(r.target)} already exists; not overwriting` : r.reason, r.code);
      console.log(`wrote ${shown(r.target)}${r.activated ? " (active)" : ""}`);
      return 0;
    }
    case "use": {
      const pos = positionals("use", rest, [], []);
      if (pos.length !== 1) fail(USAGE, 2);
      const name = pos[0]!;
      const r = useWorkflow(process.cwd(), name);
      if (!r.ok) return fail(`gemflow: ${r.reason}`, 1);
      console.log(`default workflow: ${name} (a work item with a journal keeps its own)`);
      return 0;
    }
    case "status": {
      if (positionals("status", rest, ["--json"], []).length > 0) fail(USAGE, 2);
      return withWorkspace((ws) => {
        const s = ws.status();
        if (has(rest, "--json")) { console.log(JSON.stringify(s)); return 0; }
        if (s.item.kind !== "item") { console.log(s.item.reason); return 0; }
        const under = s.workflow.default !== undefined ? ` · workflow ${s.workflow.name} (default ${s.workflow.default})` : "";
        console.log(`${s.item.id} · ${s.state ? `#${s.state.id}` : "(no stage)"}${under}${s.paused ? " · paused" : ""}`);
        for (const [name, value] of Object.entries(s.vars)) {
          const source = s.sources[name];
          console.log(`  ${name} = ${JSON.stringify(value)}${source !== undefined ? `  (${source})` : ""}`);
        }
        for (const n of s.next) {
          const how = n.approval ? "a person approves" : n.judge === "machine" ? "on its own" : "by move";
          const guard = n.guard !== undefined ? `  when ${n.guard}${n.judge === "machine" ? (n.holds ? " (holds)" : ` (missing ${n.missing.join(", ")})`) : ""}` : "";
          console.log(`  → #${n.to}  ${how}${guard}`);
        }
        if (s.gh !== undefined && !s.gh.available) console.log(`  git evidence unavailable: ${s.gh.reason}`);
        return 0;
      });
    }
    case "mark":
    case "unmark": {
      const pos = positionals(verb, rest, [], []);
      if (pos.length !== 1) fail(USAGE, 2);
      const name = pos[0]!;
      return withWorkspace((ws) => {
        const r = ws.mark(name, verb === "mark");
        if (!r.ok) return fail(`gemflow: ${r.reason}`, 1);
        console.log(`${verb}ed ${name}${r.entered.length ? ` · entered ${chain(r.entered)}` : ""}`);
        return 0;
      });
    }
    case "advance": {
      const pos = positionals("advance", rest, [], []);
      if (pos.length !== 1) fail(USAGE, 2);
      const to = pos[0]!;
      return withWorkspace((ws) => {
        const r = ws.advance(to);
        if (!r.ok) return fail(`gemflow: ${r.reason}`, 1);
        console.log(`entered ${chain(r.entered)}`);
        return 0;
      });
    }
    case "pause":
    case "resume": {
      if (positionals(verb, rest, [], []).length !== 0) fail(USAGE, 2);
      return withWorkspace((ws) => {
        if (verb === "pause") {
          const r = ws.pause();
          if (!r.ok) return fail(`gemflow: ${r.reason}`, 1);
          console.log("paused");
          return 0;
        }
        const r = ws.resume();
        if (!r.ok) return fail(`gemflow: ${r.reason}`, 1);
        console.log(`resumed${r.entered.length ? ` · entered ${chain(r.entered)}` : ""}`);
        return 0;
      });
    }
    case "rollback": {
      const pos = positionals("rollback", rest, [], []);
      if (pos.length > 1) fail(USAGE, 2);
      const arg = pos[0] ?? "checkpoint";
      const target = arg === "checkpoint" ? "checkpoint" : Number(arg);
      if (target !== "checkpoint" && (!Number.isInteger(target) || target < 0)) fail("gemflow rollback: expected a revision number or checkpoint", 2);
      return withWorkspace((ws) => {
        const r = ws.rollback(target);
        if (!r.ok) return fail(`gemflow: ${r.reason}`, 1);
        console.log(`rev ${r.rev} restores rev ${r.restores} · state #${r.state}${r.entered.length ? ` · entered ${chain(r.entered)}` : ""}`);
        return 0;
      });
    }
    case "migrate": {
      if (positionals("migrate", rest, [], []).length > 0) fail(USAGE, 2);
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
      const moved = migrateLayout(process.cwd(), join(homedir(), ".gemflow", "trash", `${stamp}-layout`));
      if (moved.length === 0) { console.log("nothing to move: no workflow directory or .geml/gemflow.geml here"); return 0; }
      for (const m of moved) console.log(`${shown(m.from)} → ${shown(m.to)}${m.kept ? " (git tracks it: left where it is; remove it with git rm)" : ` (moved to ${m.trashed})`}`);
      return 0;
    }
    case "run": {
      const profile = has(rest, "--profile") ? (flag(rest, "--profile") as string) : "headless";
      // Everything that is not the flag or its value is the task. Joined rather
      // than taking one argument, so an unquoted task still reads sensibly.
      const skip = new Set<number>();
      const at = rest.indexOf("--profile");
      if (at >= 0) { skip.add(at); skip.add(at + 1); }
      const task = rest.filter((_, i) => !skip.has(i)).join(" ").trim();
      if (task.length === 0) fail(USAGE, 2);
      let workflow: ReturnType<typeof resolveWorkflow>;
      try { workflow = resolveWorkflow(process.cwd()); }
      catch (e) { workflow = { error: e instanceof Error ? e.message : String(e), kind: "invalid" }; }
      if ("error" in workflow) console.error(`gemflow: ${workflow.error} — the agent will run unsupervised`);
      return runTask({ profile, task });
    }
    default:
      fail(USAGE, 2);
  }
}

const argv = process.argv.slice(2);
// The async verbs end by letting the process drain: process.exit right after a
// write to a pipe can cut the answer short on macOS.
if (argv[0] === "hook") void runHook().then((code) => { process.exitCode = code; });
else if (argv[0] === "codex") void runCodexHook().then((code) => { process.exitCode = code; });
else if (argv[0] === "antigravity") void runAntigravityHook(argv[1]).then((code) => { process.exitCode = code; });
else if (argv[0] === "mcp") {
  const rest = argv.slice(1);
  if (positionals("mcp", rest, [], ["--host", "--root"]).length > 0) fail(USAGE, 2);
  void serveMcp({ root: resolve(flag(rest, "--root") ?? "."), host: flag(rest, "--host") ?? "mcp" });
} else process.exit(main(argv));
