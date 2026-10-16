// Stagehand (spec §5.4): the stage text, and the context document it goes into.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "@geml/geml";
import { loadStatechart } from "../dist/core/statechart.js";
import { initialSnapshot, applySignal } from "../dist/core/snapshot.js";
import { buildStageContext, nextLines, readContextDoc, renderContextDoc, toolLines } from "../dist/core/stagehand.js";
import { dict, flowDoc } from "./helpers/flow.mjs";

const sc = loadStatechart(flowDoc({
  initial: "build",
  states: {
    build: { title: "构建", description: "写代码和测试。", prompt: "./guide.geml#build", skills: ["tdd"], tools: ["edit", "test"] },
    review: { description: "Review.", tools: ["test"] },
    deploy: { description: "Deploy." },
    done: {},
  },
  vars: { t: { default: false, source: { tool: "test" } }, p: { default: false, source: "pr-open" }, h: { default: false, source: "human" }, goal: { default: "" } },
  transitions: [
    { from: "build", to: "review", guard: { properties: { t: { const: true }, p: { const: true } } }, note: "tests green and a PR" },
    { from: "review", to: "build", guard: "review asks for changes" },
    { from: "review", to: "deploy", guard: { properties: { h: { const: true } } }, approval: true },
    { from: "deploy", to: "done" },
  ],
}), "s.geml").statechart;
const D = dict([{ tool: "Edit", for: "edit", default: true }, { tool: "Bash(npm test)", for: "test", default: true, params: { watch: false } }]);
const T0 = "2026-10-12T00:00:00Z";
const GUIDE = { "./guide.geml#build": "# 构建 {#build}\n\nRun npm test before you push." };

test("the stage text: the state, its skills, uses with their tools, the variables, and each way out with who takes it; then the prompt", () => {
  const snap = initialSnapshot(sc, T0);
  const ctx = buildStageContext(sc, snap, (ref) => GUIDE[ref], D);
  assert.deepEqual([ctx.state, ctx.rev, ctx.included, ctx.truncated], ["build", 0, ["./guide.geml#build"], []]);
  const lines = ctx.text.split("\n");
  assert.equal(lines[0], "[gemflow] stage build · rev 0");
  assert.equal(lines[1], "构建 — 写代码和测试。");
  assert.ok(lines.includes("Skills: tdd"));
  assert.ok(lines.includes("Tools here:"));
  assert.ok(lines.includes("  edit: Edit"));
  assert.ok(lines.includes('  test: Bash(npm test) with {"watch":false}'));
  assert.ok(lines.includes("Variables: t=false · p=false · h=false · goal=\"\" (yours to set)"), lines.join("|"));
  assert.ok(lines.includes("  → review: on its own when t = true and p = true — still missing: p, t — tests green and a PR"), lines.join("|"));
  assert.match(ctx.text, /--- \.\/guide\.geml#build ---\n# 构建 \{#build\}\n\nRun npm test before you push\.$/);
});

test("nextLines and toolLines: a model-judged guard gives its sentence, an approval names the person's ways, a missing binding says so", () => {
  const review = applySignal(sc, { ...initialSnapshot(sc, T0), state: "review" }, "t", true, { at: T0 }).next;
  assert.deepEqual(nextLines(sc, review), [
    "→ build: your call, with move, when review asks for changes",
    "→ deploy: a person approves it once h = true (board, or gemflow advance deploy)",
  ]);
  assert.deepEqual(nextLines(sc, { ...review, state: "deploy" }), ["→ done: your call, with move"]);
  assert.deepEqual(toolLines(sc, "build", undefined), ["edit: no tool bound yet (the first one you use is asked about)", "test: no tool bound yet (the first one you use is asked about)"]);
  const holds = applySignal(sc, applySignal(sc, initialSnapshot(sc, T0), "t", true, { at: T0 }).next, "p", true, { at: T0 }).next;
  assert.match(nextLines(sc, holds)[0], /\(holds now\)/);
});

test("a state with no uses and no prompt says so; the final stage has no way out; a prompt that cannot be read says not found", () => {
  const snap = { ...initialSnapshot(sc, T0), state: "deploy" };
  const ctx = buildStageContext(sc, snap, () => undefined, D);
  assert.ok(ctx.text.includes("Tools here: none declared; what you use is asked about"));
  assert.deepEqual(ctx.included, []);
  const done = buildStageContext(sc, { ...snap, state: "done" }, () => undefined);
  assert.ok(done.text.includes("  nothing — this is the final stage"));
  const missing = buildStageContext(sc, initialSnapshot(sc, T0), () => undefined, D);
  assert.match(missing.text, /--- \.\/guide\.geml#build ---\n\(not found\)/);
});

test("the prompt gets the bytes the budget leaves; when it does not fit, the text says where to read it", () => {
  const small = { ...sc, contextBudget: 400 };
  const ctx = buildStageContext(small, initialSnapshot(small, T0), () => "x".repeat(2000), D);
  assert.deepEqual([ctx.included, ctx.truncated], [[], ["./guide.geml#build"]]);
  assert.match(ctx.text, /the prompt \.\/guide\.geml#build was left out to stay within 400 bytes — read it with geml get/);
  assert.ok(Buffer.byteLength(ctx.text) < 800);
});

test("renderContextDoc writes text {#current}, data {#stage} and data {#vars}; readContextDoc reads them back; the fence is wider than any =-run in the text", () => {
  const snap = initialSnapshot(sc, T0);
  const ctx = buildStageContext(sc, snap, () => "=== not a fence\n==== nor this", D);
  const doc = renderContextDoc(ctx, { at: T0, item: "feat/x", vars: snap.vars });
  const parsed = parse(doc);
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.ids, ["current", "stage", "vars"]);
  assert.match(doc, /^===== text \{#current\}\n/m, "five =, wider than the four in the text");
  const back = readContextDoc(doc);
  assert.deepEqual(back, { state: "build", rev: 0, at: T0, item: "feat/x", text: ctx.text, vars: snap.vars });
  assert.equal(readContextDoc("=== meta\ntitle = \"x\"\n===\n"), undefined);
});
