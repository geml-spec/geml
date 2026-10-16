// The whole thing, end to end, in one command:
//
//   node examples/walkthrough.mjs
//
// It builds a throwaway project with a failing test, starts a REAL pi agent
// session with this package's supervisor loaded the way `pi install` would load
// it, and drives it through the coding workflow in workflows/coding/flow.geml.
// The model is scripted (examples/scripted-model.js) so the run needs no API
// key and says the same thing every time; everything else is real — pi agent's
// loop, its tool pipeline (the `bash` calls really run), its session store,
// and the exit status that writes `tests-pass`.
//
// What it prints is the evidence, not a summary: what the model tried at each
// step and what came back, what came of the calls the workflow refuses, and
// the journal that came out. It also checks that evidence, so a workflow that
// stops enforcing what its text claims makes this exit 1 rather than print a
// story.
//
// To do the same thing with a real model, drop `--model stub/script` and the
// scripted-model extension, and pass your own `--model` instead.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const pkg = resolve(here, "..");
const keep = process.argv.includes("--keep");

const piCli = resolve(pkg, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
if (!existsSync(piCli)) {
  console.error("pi agent is not installed here. Run `npm install` in this package first.");
  process.exit(1);
}
if (!existsSync(resolve(pkg, "dist/hosts/pi/extension.js"))) {
  console.error("the supervisor is not built. Run `npm run build` first.");
  process.exit(1);
}

// --- a throwaway project with a failing test -------------------------------
const project = mkdtempSync(join(tmpdir(), "gemflow-walkthrough-"));
writeFileSync(join(project, "sum.mjs"), "export const sum = (a, b) => 0;\n");
writeFileSync(join(project, "test.mjs"), [
  'import { sum } from "./sum.mjs";',
  'if (sum(2, 3) !== 5) { console.error(`sum(2,3) was ${sum(2, 3)}, expected 5`); process.exit(1); }',
  'console.log("ok");',
  "",
].join("\n"));
// The way `gemflow init` lays a workflow out; the extension finds it from the
// directory pi is started in, with no environment variable to say where.
const workflowDir = join(project, ".geml", "workflows", "coding");
mkdirSync(workflowDir, { recursive: true });
const workflow = join(workflowDir, "flow.geml");
writeFileSync(workflow, readFileSync(join(pkg, "workflows/coding/flow.geml"), "utf8"));
// The dictionary, in pi agent's tool names: the bundled one is written in
// Claude Code's (Edit, Write, Bash(npm test)). `write` and `edit` are the use
// edit, which only #implement declares; this project's test command is the
// use test, which only #verify declares; the read-only tools are allowed in
// every state. Without these rows the first call to each would be a question
// for a person, and in print mode there is nobody to ask.
writeFileSync(join(workflowDir, "tools.geml"), [
  "=== meta",
  'title   = "Walkthrough tool dictionary"',
  'profile = "geml-statechart/v1"',
  "===",
  "",
  "=== table {#tools}",
  "| tool                | for  | allow | deny | default | params |",
  "|---------------------|------|-------|------|---------|--------|",
  "| read                |      | *     |      |         |        |",
  "| grep                |      | *     |      |         |        |",
  "| find                |      | *     |      |         |        |",
  "| ls                  |      | *     |      |         |        |",
  "| write               | edit |       |      | yes     |        |",
  "| edit                | edit |       |      |         |        |",
  "| Bash(node test.mjs) | test |       |      | yes     |        |",
  "===",
  "",
].join("\n"));

const journals = join(project, "journals");
const trace = join(project, "trace.json");

console.log(`project   ${project}`);
console.log(`workflow  ${workflow}\n`);

// --- the run ---------------------------------------------------------------
// -ne / -ns / -nc keep the walkthrough from picking up whatever else is
// installed on this machine: the only extensions are the two named here.
const args = [
  piCli,
  "-p", "make the test pass",
  "--offline", "--no-extensions", "--no-skills", "--no-context-files",
  "-e", resolve(pkg, "dist/hosts/pi/extension.js"),
  "-e", resolve(here, "scripted-model.js"),
  "--model", "stub/script",
  "--session-dir", join(project, "sessions"),
];
// A GEMFLOW_STATECHART in the caller's shell would choose the workflow for us.
const { GEMFLOW_STATECHART: _chosen, ...inherited } = process.env;
const env = {
  ...inherited,
  GEMFLOW_JOURNAL_DIR: journals,
  GEML_DEMO_SCRIPT: join(here, "coding/script.json"),
  GEML_DEMO_TRACE: trace,
};

let piOut = "";
try {
  piOut = execFileSync(process.execPath, args, { cwd: project, env, encoding: "utf8" });
} catch (error) {
  console.error("pi exited non-zero:\n", error.stdout ?? "", error.stderr ?? "");
  process.exit(1);
}

// --- what came of each call ------------------------------------------------
// pi's session store keeps every tool result; the trace keeps what the model
// tried. Side by side, they are the run.
const results = new Map();
for (const file of readdirSync(join(project, "sessions"), { recursive: true })) {
  if (!String(file).endsWith(".jsonl")) continue;
  for (const line of readFileSync(join(project, "sessions", String(file)), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const message = JSON.parse(line).message;
    if (message?.role === "toolResult") results.set(message.toolCallId, message);
  }
}
const firstLine = (result) => String(result?.content?.[0]?.text ?? "(no result)").split("\n")[0];
const steps = JSON.parse(readFileSync(trace, "utf8"));
console.log("turn  it tried                                                  it came back");
console.log("----  --------------------------------------------------------  ------------------------------");
for (const s of steps) {
  const result = results.get(`call_${s.turn}`);
  const back = s.does === "text" ? "" : `${result?.isError === true ? "error: " : ""}${firstLine(result).slice(0, 70)}`;
  console.log(`${String(s.turn).padStart(4)}  ${s.does.slice(0, 56).padEnd(56)}  ${back}`);
}

// --- what came of the calls the workflow forbids ---------------------------
// A script step marked `refused` is a call a gate turns away: a tool bound to
// a use this state does not declare, a verb the workflow refuses. Each must
// come back as an error from pi's own session store, with the reason.
const script = JSON.parse(readFileSync(join(here, "coding/script.json"), "utf8"));
const failures = [];
console.log("\nthe calls the workflow refuses:");
script.forEach((step, turn) => {
  if (step.expect !== "refused") return;
  const [tool] = step.call;
  const result = results.get(`call_${turn}`);
  console.log(`  turn ${turn}  ${tool}: ${firstLine(result)}`);
  if (result?.isError !== true) failures.push(`turn ${turn}: ${tool} was supposed to be refused, but it ran`);
});

// --- what the run left behind ----------------------------------------------
const journalFile = join(journals, readdirSync(journals).find((f) => f.endsWith(".geml")));
const cli = resolve(pkg, "dist/cli.js");
const run = (...a) =>
  execFileSync(process.execPath, [cli, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

console.log(`\njournal    ${journalFile}`);
console.log(run("export", journalFile, "--to", "md").trim());
// `verify` keeps stdout for its report and says "ok" on stderr, so the verdict
// is the exit code rather than the text.
let verdict;
try {
  run("verify", journalFile, "--workflow", workflow);
  verdict = "the chain verifies against the workflow (exit 0)";
} catch (error) {
  verdict = `FAILED — ${String(error.stdout ?? "")}${String(error.stderr ?? "")}`.trim();
}
console.log(`\nverify:   ${verdict}`);
console.log(`the file: ${readFileSync(join(project, "sum.mjs"), "utf8").trim()}`);
console.log(`the test: ${execFileSync(process.execPath, ["test.mjs"], { cwd: project, encoding: "utf8" }).trim()}`);
const said = piOut.split("\n").map((line) => line.trim()).filter(Boolean).pop();
console.log(`the agent: ${said ?? "(said nothing)"}`);

// The journal must end in #review, entered on the machine's own judgement
// after the green run — not by a move of the model's, which the workflow
// refuses for that transition.
const last = JSON.parse(run("snapshot", journalFile, "--json"));
if (last.state !== "review") failures.push(`the run ended in #${last.state}, not #review`);

if (keep) console.log(`\nkept: ${project}`);
else rmSync(project, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\nthe walkthrough did not hold:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
