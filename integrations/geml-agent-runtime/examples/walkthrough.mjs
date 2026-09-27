// The whole thing, end to end, in one command:
//
//   node examples/walkthrough.mjs
//
// It builds a throwaway project with a failing test, starts a REAL pi agent
// session with this package's supervisor loaded the way `pi install` would load
// it, and drives it through the coding workflow in examples/coding/agent.geml.
// The model is scripted (examples/scripted-model.js) so the run needs no API
// key and says the same thing every time; everything else is real — pi agent's
// loop, its tool pipeline (the `bash` calls really run), its session store.
//
// What it prints is the evidence, not a summary: which tools the model was
// offered at each step, what the gates refused, and the ledger that came out.
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
const project = mkdtempSync(join(tmpdir(), "geml-agent-walkthrough-"));
writeFileSync(join(project, "sum.mjs"), "export const sum = (a, b) => 0;\n");
writeFileSync(join(project, "test.mjs"), [
  'import { sum } from "./sum.mjs";',
  'if (sum(2, 3) !== 5) { console.error(`sum(2,3) was ${sum(2, 3)}, expected 5`); process.exit(1); }',
  'console.log("ok");',
  "",
].join("\n"));
mkdirSync(join(project, ".geml"), { recursive: true });
const statechart = join(project, ".geml", "agent.geml");
writeFileSync(statechart, readFileSync(join(here, "coding/agent.geml"), "utf8"));

const ledgers = join(project, "ledgers");
const trace = join(project, "trace.json");

console.log(`project   ${project}`);
console.log(`statechart ${statechart}\n`);

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
const env = {
  ...process.env,
  GEML_AGENT_STATECHART: statechart,
  GEML_AGENT_LEDGER_DIR: ledgers,
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

// --- what the model could see, step by step --------------------------------
const steps = JSON.parse(readFileSync(trace, "utf8"));
console.log("turn  the model was offered                         it tried");
console.log("----  --------------------------------------------  ------------------------------");
for (const s of steps) {
  const offered = s.toolsOffered.filter((n) => !n.startsWith("agent_")).join(" ") || "(nothing global)";
  console.log(`${String(s.turn).padStart(4)}  ${offered.padEnd(44)}  ${s.does.slice(0, 60)}`);
}

// --- what the run left behind ----------------------------------------------
const ledgerFile = join(ledgers, readdirSync(ledgers)[0]);
const cli = resolve(pkg, "dist/cli.js");
const run = (...a) =>
  execFileSync(process.execPath, [cli, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

console.log(`\nledger    ${ledgerFile}`);
console.log(run("export", ledgerFile, "--to", "md").trim());
// `verify` keeps stdout for its report and says "ok" on stderr, so the verdict
// is the exit code rather than the text.
let verdict;
try {
  run("verify", ledgerFile, "--statechart", statechart);
  verdict = "the chain verifies against the statechart (exit 0)";
} catch (error) {
  verdict = `FAILED — ${String(error.stdout ?? "")}${String(error.stderr ?? "")}`.trim();
}
console.log(`\nverify:   ${verdict}`);
console.log(`the file: ${readFileSync(join(project, "sum.mjs"), "utf8").trim()}`);
console.log(`the test: ${execFileSync(process.execPath, ["test.mjs"], { cwd: project, encoding: "utf8" }).trim()}`);

// Nothing on stdout is the correct ending here, not a missing answer: the last
// transition entered #review, a `pause` state, so the verb returned
// `terminate` and the turn stopped before the model got another word in. That
// is the human gate doing its job.
const said = piOut.split("\n").map((line) => line.trim()).filter(Boolean).pop();
console.log(`the agent: ${said ?? "(stopped at #review — a pause state ends the turn and waits for a person)"}`);

if (keep) console.log(`\nkept: ${project}`);
else rmSync(project, { recursive: true, force: true });
