#!/usr/bin/env node
// geml-agent — offline verbs over statecharts and ledgers, plus `run`, which
// is the one verb that reaches outside this package (it starts dsh).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, readText, writeNew } from "./host-fs.js";
import { DEFAULT_STATECHART } from "./core/layout.js";
import { run as runTask } from "./hosts/dsh/launch.js";
import { loadStatechart, hasErrors, type AgentDiagnostic } from "./core/statechart.js";
import { readLedger, verifyLedger } from "./core/ledger.js";
import { canonical } from "./core/snapshot.js";
import type { JsonValue } from "./core/schema.js";

const USAGE = [
  "usage: geml-agent <check|snapshot|verify|export|init|run> ...",
  "  check <flow.geml> [--tools a,b]        static checks (exit 1 on errors)",
  "  snapshot <ledger.geml> [--json]        the last revision",
  "  verify <ledger.geml> [--statechart f]  hash chain and consistency",
  "  export <ledger.geml> --to md           revision table with per-step diffs",
  "  init [dir] [--template coding|refund]  write a starting agent.geml (default: coding)",
  "  run [--profile name] <task>            add the bundle to a dsh profile and run the task there",
].join("\n");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) fail(`${name} needs a value`, 2);
  return value;
}
const has = (args: string[], name: string) => args.includes(name);

function printDiagnostics(ds: readonly AgentDiagnostic[]): void {
  for (const d of ds) console.error(`${d.severity}: ${d.code}: ${d.message} (line ${d.line})`);
  const errs = ds.filter((d) => d.severity === "error").length, warns = ds.length - errs;
  console.error(errs || warns ? `${errs} error(s), ${warns} warning(s)` : "ok: no diagnostics");
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
    return fail(`geml-agent: cannot read ${path}${err.code ? ` (${err.code})` : ""}`, 1);
  }
}

function main(argv: string[]): number {
  const [verb, ...rest] = argv;
  if (!verb) fail(USAGE, 2);
  switch (verb) {
    case "check": {
      const file = rest[0]; if (!file || file.startsWith("--")) fail(USAGE, 2);
      const tools = flag(rest, "--tools");
      const r = loadStatechart(readOrFail(resolve(file)), file, tools ? { knownTools: tools.split(",").map((s) => s.trim()).filter(Boolean) } : {});
      printDiagnostics(r.diagnostics);
      return hasErrors(r.diagnostics) ? 1 : 0;
    }
    case "snapshot": {
      const file = rest[0]; if (!file || file.startsWith("--")) fail(USAGE, 2);
      const ledger = readLedger(readOrFail(resolve(file)));
      const last = ledger.snapshots[ledger.snapshots.length - 1];
      if (!last) fail(`${file}: no agent-snapshot block`, 1);
      if (has(rest, "--json")) { console.log(JSON.stringify(last)); return 0; }
      const from = last.from !== undefined ? ` · from #${last.from}` : "";
      const restores = last.restores !== undefined ? ` · restores ${last.restores}` : "";
      console.log(`rev ${last.rev} · state #${last.state} · cause ${last.cause}${from}${restores}\nvars: ${canonical(last.vars)}\nhash: ${last.hash}\nat: ${last.at}`);
      return 0;
    }
    case "verify": {
      const file = rest[0]; if (!file || file.startsWith("--")) fail(USAGE, 2);
      const scPath = flag(rest, "--statechart");
      let sc;
      if (scPath) {
        const r = loadStatechart(readOrFail(resolve(scPath)), scPath);
        if (!r.statechart) { printDiagnostics(r.diagnostics); return 1; }
        sc = r.statechart;
      }
      const errors = verifyLedger(readLedger(readOrFail(resolve(file))), sc);
      for (const e of errors) console.error(e);
      console.error(errors.length ? `${errors.length} error(s)` : "ok: chain verified");
      return errors.length ? 1 : 0;
    }
    case "export": {
      const file = rest[0]; if (!file || file.startsWith("--")) fail(USAGE, 2);
      if (flag(rest, "--to") !== "md") fail("export: only --to md is supported", 2);
      const ledger = readLedger(readOrFail(resolve(file)));
      const lines = [`# geml-agent ledger — ${ledger.meta.session}`, "", `statechart: \`${ledger.meta.statechart}\` (${ledger.meta.statechartHash})`, "", "| rev | at | cause | state | call | changes |", "|---|---|---|---|---|---|"];
      let prev: Record<string, JsonValue> = {};
      for (const s of ledger.snapshots) {
        const changes: string[] = [];
        for (const k of [...new Set([...Object.keys(prev), ...Object.keys(s.vars)])].sort()) {
          const a = prev[k], b = s.vars[k];
          if (canonical(a ?? null) !== canonical(b ?? null) || (a === undefined) !== (b === undefined)) {
            changes.push(`${k}: ${a === undefined ? "∅" : canonical(a)} → ${b === undefined ? "∅" : canonical(b)}`);
          }
        }
        lines.push(`| ${s.rev} | ${s.at} | ${s.cause} | #${s.state} | ${s.call ?? ""} | ${changes.length ? changes.join("; ") : "—"} |`);
        prev = s.vars;
      }
      if (ledger.refusals.length) {
        lines.push("", "## Refused", "");
        for (const r of ledger.refusals) lines.push(`- rev ${r.rev} · ${r.tool}${r.call ? ` (${r.call})` : ""}: ${r.reason}${r.diagnostics.length ? " — " + r.diagnostics.join("; ") : ""}`);
      }
      console.log(lines.join("\n"));
      return 0;
    }
    case "init": {
      // `coding` is the default because that is what a repository is for: the
      // states are explore / plan / implement / verify / review, and the point
      // of them is that a file cannot be edited before a plan is recorded and
      // nothing reaches "done" without a recorded test result.
      const template = flag(rest, "--template") ?? "coding";
      if (template !== "coding" && template !== "refund") {
        fail(`unknown template "${template}"; expected coding or refund`, 2);
      }
      const dir = resolve(rest.filter((a) => a !== "--template" && a !== template)[0] ?? ".");
      const target = resolve(dir, DEFAULT_STATECHART);
      const example = readText(fileURLToPath(new URL(`../examples/${template}/agent.geml`, import.meta.url))).replace(/\r\n/g, "\n");
      try { writeNew(target, example); }
      catch (e) { fail((e as NodeJS.ErrnoException).code === "EEXIST" ? `${target} already exists; not overwriting` : String(e), 1); }
      console.log(`wrote ${target}`);
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
      if (!exists(resolve(".", DEFAULT_STATECHART))) {
        console.error(`geml-agent: no ${DEFAULT_STATECHART} here — the agent will run unsupervised ("geml-agent init" writes one)`);
      }
      return runTask({ profile, task });
    }
    default:
      fail(USAGE, 2);
  }
}

process.exit(main(process.argv.slice(2)));
