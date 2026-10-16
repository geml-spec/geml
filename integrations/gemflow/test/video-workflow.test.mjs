import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStatechart } from "../dist/core/statechart.js";
import { commandSignals } from "../dist/core/signals.js";
import { fencedRefusal } from "../dist/core/dictionary.js";
import { readDictionary } from "../dist/core/dictionary-file.js";
import { scopeIn } from "../dist/core/policy.js";
import { blockText } from "../dist/core/blocks.js";
import { BUNDLE, hook } from "./helpers/repo.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FLOW = fileURLToPath(new URL("../workflows/video/flow.geml", import.meta.url));
const GUIDE = readFileSync(new URL("../workflows/video/guide.geml", import.meta.url), "utf8");
const sc = () => loadStatechart(readFileSync(FLOW, "utf8"), "flow.geml").statechart;
const dict = () => readDictionary(readFileSync(new URL("../workflows/video/tools.geml", import.meta.url), "utf8"), sc());

test("the video workflow and its dictionary check with no diagnostics, and every prompt resolves to a guide block", () => {
  const r = spawnSync(process.execPath, [CLI, "check", FLOW], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^ok: no diagnostics$/m);
  const resolveRef = (ref) => ref.startsWith("./guide.geml#") && blockText(GUIDE, ref.slice("./guide.geml#".length)) !== undefined;
  assert.deepEqual(loadStatechart(readFileSync(FLOW, "utf8"), "flow.geml", { resolveRef }).diagnostics, []);
  assert.deepEqual(dict().diagnostics, []);
});

test("seven states on an episode-file unit; the uses, the variables with their sources, and the transitions with what they reset", () => {
  const s = sc();
  assert.deepEqual(s.unit, { kind: "file", glob: "episodes/*.geml" });
  assert.deepEqual([...s.states.values()].map((x) => [x.id, x.prompt, x.uses]), [
    ["script", "./guide.geml#script", []],
    ["assets", "./guide.geml#assets", ["image", "video", "voice", "import", "log", "todo-check"]],
    ["cut", "./guide.geml#cut", ["lay", "stale-check"]],
    ["render", "./guide.geml#render", ["render"]],
    ["review", "./guide.geml#review", []],
    ["publish", "./guide.geml#publish", []],
    ["done", undefined, []],
  ]);
  assert.deepEqual([...s.vars.values()].map((v) => [v.name, v.source]), [
    ["script-final", { kind: "human" }], ["assets-done", { kind: "tool", use: "todo-check" }], ["no-stale", { kind: "tool", use: "stale-check" }],
    ["rendered", { kind: "tool", use: "render" }], ["approved", { kind: "human" }], ["published", { kind: "human" }],
  ]);
  assert.deepEqual(s.transitions.map((t) => [t.name, t.judge, t.approval, t.resets]), [
    ["script→assets", "machine", false, []],
    ["assets→cut", "machine", false, []],
    ["cut→render", "machine", false, []],
    ["render→review", "machine", false, []],
    ["render→cut", "model", false, ["no-stale"]],
    ["review→assets", "model", false, ["assets-done", "no-stale", "rendered"]],
    ["review→cut", "model", false, ["no-stale", "rendered"]],
    ["review→publish", "machine", false, []],
    ["publish→done", "machine", false, []],
  ]);
});

test("the dictionary reads the spellings people type: launchers, the flag anywhere after the verb; a line that is not a plain && chain writes nothing", () => {
  const s = sc(), d = dict();
  const read = (state, command, exitCode = 0) => Object.fromEntries(commandSignals(s, d, state, { command, exitCode }).map((x) => [x.id, x.value]));
  assert.deepEqual(read("assets", "geml media todo episodes/ep01.geml --root . --check"), { "assets-done": true });
  assert.deepEqual(read("assets", "geml media todo --check episodes/ep01.geml", 1), { "assets-done": false });
  assert.deepEqual(read("assets", "npx -y @geml/geml media todo episodes/ep01.geml --json --check"), { "assets-done": true });
  assert.deepEqual(read("assets", "pnpm dlx @geml/geml media todo episodes/ep01.geml --check"), { "assets-done": true });
  assert.deepEqual(read("assets", "cd show && geml media todo episodes/ep01.geml --check"), { "assets-done": true });
  assert.deepEqual(read("assets", "geml media todo episodes/ep01.geml"), {}, "without --check the exit status says nothing");
  assert.deepEqual(read("assets", "geml media todo episodes/ep01.geml --checkout"), {});
  assert.deepEqual(read("assets", "geml media todo episodes/ep01.geml --check | tee todo.txt"), {}, "a pipe: not a plain && chain");
  assert.deepEqual(read("cut", "geml media todo episodes/ep01.geml --check"), {}, "evidence belongs to the state that declares the use");
  assert.deepEqual(read("cut", "geml check episodes/ep01.geml --root . --severity media-stale-clip=error"), { "no-stale": true });
  assert.deepEqual(read("cut", "geml check episodes/ep01.geml --severity media-stale-clip=warning"), {});
  assert.deepEqual(read("cut", "geml check episodes/ep01.geml"), {});
  assert.deepEqual(read("render", "npx @geml/geml media build episodes/ep01.geml --out renders/ep01.mp4"), { rendered: true });
  assert.deepEqual(read("render", "geml media build episodes/ep01.geml -o renders/ep01.mp4"), { rendered: true });
  assert.deepEqual(read("render", "geml media build episodes/ep01.geml --out renders/ep01.mp4 && geml --help"), { rendered: true });
  assert.deepEqual(read("render", "geml media export episodes/ep01.geml --to player -o play.html"), {});
  assert.deepEqual(read("render", "geml media build episodes/ep01.geml"), {}, "no --out: build refuses to run, and the key says so");
  const fenced = (state, command) => fencedRefusal(d, scopeIn(s, state), command);
  for (const command of [
    "geml media build episodes/ep01.geml --out renders/ep01.mp4",
    "geml media build episodes/ep01.geml -o renders/ep01.mp4",
    "cd show && npx @geml/geml media build episodes/ep01.geml --out x.mp4",
    'bash -c "geml media build episodes/ep01.geml --out x.mp4"',
    'geml "media" build episodes/ep01.geml "--out" x.mp4',
    "geml media build episodes/ep01.geml --out x.mp4 && geml --help",
  ]) {
    assert.match(fenced("cut", command), /is render, which is used only in #render; the workflow is in #cut/, command);
    assert.equal(fenced("render", command), undefined, command);
  }
  for (const command of ["geml media build --help", "geml media export episodes/ep01.geml --to player", "geml check episodes/ep01.geml --severity media-stale-clip=error"]) {
    assert.equal(fenced("cut", command), undefined, command);
  }
  assert.match(fenced("cut", "geml media todo episodes/ep01.geml --check"), /is todo-check, which is used only in #assets; the workflow is in #cut/, "a use is usable only where it is declared");
  assert.match(fenced("script", "geml media todo episodes/ep01.geml --check"), /is todo-check, which is used only in #assets/);
});

// End to end through the bundled bridge, in a project with no git: the parser's own
// todo, import, log and check run for real against episodes/ep01.geml; the render,
// which needs ffmpeg, is reported to the bridge by its exit status, as the hooks
// module reports every Bash call.
const GEML = fileURLToPath(import.meta.resolve("@geml/geml/dist/cli.js"));
const EPISODE = [
  "=== meta", 'title   = "第 1 集"', 'profile = "geml-media/v1"', "===", "",
  "=== media-text {#s01 .prompt shot=1}", "清晨的码头，雾很浓。", "===", "",
  "=== data {#gen-log .gen-log format=jsonl}", "===", "",
].join("\n");
const TIMELINE = ["", '==== media {#cut tracks="v:video"}', "", "=== media-clip {#c1 track=v src=#s01-take1 duration=2}", "===", "", "====", ""].join("\n");
const TODO = "geml media todo episodes/ep01.geml --root . --check";
const FRESH = "geml check episodes/ep01.geml --root . --severity media-stale-clip=error";
const BUILD = "geml media build episodes/ep01.geml --root . --out renders/ep01.mp4";

/** A project with the video workflow active, episodes/ep01.geml (one shot to generate) and the shot's picture on disk. */
function episodeProject() {
  const root = mkdtempSync(join(tmpdir(), "gemflow-video-"));
  const init = spawnSync(process.execPath, [BUNDLE, "init", "--template", "video"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /^wrote \.geml\/workflows\/video\/ \(active\)$/m);
  mkdirSync(join(root, "episodes"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "episodes", "ep01.geml"), EPISODE);
  writeFileSync(join(root, "assets", "s01-take1.png"), "PNGBYTES");
  return root;
}

/** The parser's CLI in the project; PATH emptied so no ffprobe answers and every run reads the same. */
const geml = (root, command) => spawnSync(process.execPath, [GEML, ...command.split(" ").slice(1)], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: "" } });

/** A Bash call's outcome, as the hooks module reports it to the bridge. */
const report = (root, callId, command, exitCode) =>
  hook(root, { op: "after", tool: "Bash", callId, input: { command }, isError: exitCode !== 0, exitCode, gitOperation: false });

/** Run a geml command for real and report its exit status. */
function ran(root, callId, command) {
  const r = geml(root, command);
  return { status: r.status, answer: report(root, callId, command, r.status) };
}

const before = (root, callId, command) => hook(root, { op: "before", tool: "Bash", callId, input: { command } });
const mark = (root, variable) => hook(root, { op: "mark", variable, checked: true });

test("end to end: the parser's own todo and check move an episode to #render; the render's exit status moves it to #review; a person approves and publishes", () => {
  const root = episodeProject();
  const opened = hook(root, { op: "status", lastFile: "episodes/ep01.geml" });
  assert.deepEqual([opened.shell.status.item, opened.shell.status.state.id], [{ kind: "item", id: "episodes/ep01" }, "script"]);
  assert.match(before(root, "b0", BUILD).refusal, /is render, which is used only in #render; the workflow is in #script/);

  const assets = mark(root, "script-final");
  assert.deepEqual(assets.entered, ["assets"]);
  assert.match(assets.context, /--- \.\/guide\.geml#assets ---\n# 素材 \{#assets\}/, "the guide's block, read in process by the bundle");

  const pending = ran(root, "t1", TODO);
  assert.deepEqual([pending.status, pending.answer.entered, pending.answer.shell.status.vars["assets-done"]], [1, [], false]);
  assert.equal(geml(root, "geml media import assets/s01-take1.png --into episodes/ep01.geml --root .").status, 0);
  assert.equal(geml(root, "geml media log episodes/ep01.geml --root . --output #s01-take1 --model m --mode t2i --prompt #s01").status, 0);
  const cut = ran(root, "t2", TODO);
  assert.deepEqual([cut.status, cut.answer.entered], [0, ["cut"]]);

  appendFileSync(join(root, "episodes", "ep01.geml"), TIMELINE);
  const render = ran(root, "f1", FRESH);
  assert.deepEqual([render.status, render.answer.entered], [0, ["render"]]);
  assert.equal(before(root, "b1", BUILD).refusal, undefined);
  assert.deepEqual(report(root, "b1", BUILD, 0).entered, ["review"]);

  assert.match(before(root, "p1", "gemflow mark approved").refusal, /for a person/);
  assert.deepEqual(mark(root, "approved").entered, ["publish"]);
  const done = mark(root, "published");
  assert.deepEqual([done.entered, done.shell.status.next], [["done"], []]);
});

/** An episode driven to #review by the exit statuses alone. */
function atReview() {
  const root = episodeProject();
  hook(root, { op: "status", lastFile: "episodes/ep01.geml" });
  mark(root, "script-final");
  report(root, "t1", TODO, 0);
  report(root, "f1", FRESH, 0);
  assert.equal(report(root, "b1", BUILD, 0).shell.status.state.id, "review");
  return root;
}

test("rework over review→cut and review→assets clears the last pass's evidence, so the stale check, the render and a person's approval come round again", () => {
  const root = atReview();
  const recut = hook(root, { op: "verb", name: "move", args: { to: "cut" }, callId: "v1" });
  assert.deepEqual([JSON.parse(recut.text).entered, recut.shell.status.state.id], [[], "cut"], "no machine-judged transition carries it on: no-stale was cleared");
  assert.deepEqual(recut.shell.status.vars, { "script-final": true, "assets-done": true, "no-stale": false, rendered: false, approved: false, published: false });
  assert.match(recut.context, /--- \.\/guide\.geml#cut ---/);
  assert.match(before(root, "b2", BUILD).refusal, /is render, which is used only in #render/);
  assert.deepEqual(report(root, "f2", FRESH, 0).entered, ["render"]);
  assert.deepEqual(report(root, "b3", BUILD, 0).entered, ["review"], "rendered was cleared, so a clean build writes it again");

  const reshoot = hook(root, { op: "advance", to: "assets" });
  assert.deepEqual([reshoot.entered, reshoot.shell.status.state.id], [["assets"], "assets"], "a person's move on the board");
  const vars = reshoot.shell.status.vars;
  assert.deepEqual([vars["assets-done"], vars["no-stale"], vars.rendered], [false, false, false]);
  assert.deepEqual(report(root, "t3", TODO, 0).entered, ["cut"]);
  assert.deepEqual(report(root, "f3", FRESH, 0).entered, ["render"]);
  assert.deepEqual(report(root, "b4", BUILD, 0).entered, ["review"]);
  assert.equal(hook(root, { op: "status" }).shell.status.vars.approved, false, "the new film waits for a person");
});

test("a failed render goes back to #cut over render→cut, which clears the stale check", () => {
  const root = episodeProject();
  hook(root, { op: "status", lastFile: "episodes/ep01.geml" });
  mark(root, "script-final");
  report(root, "t1", TODO, 0);
  assert.equal(report(root, "f1", FRESH, 0).shell.status.state.id, "render");
  const failed = report(root, "b1", BUILD, 1);
  assert.deepEqual([failed.entered, failed.shell.status.state.id, failed.shell.status.vars.rendered], [[], "render", false]);
  const back = hook(root, { op: "verb", name: "move", args: { to: "cut" }, callId: "v1" });
  assert.deepEqual([back.shell.status.state.id, back.shell.status.vars["no-stale"]], ["cut", false]);
  assert.deepEqual(report(root, "f2", FRESH, 0).entered, ["render"]);
  assert.deepEqual(report(root, "b2", BUILD, 0).entered, ["review"]);
});
