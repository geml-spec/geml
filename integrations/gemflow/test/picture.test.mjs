// The flow picture on a board (spec §8.2): the parser's renderer over the
// workflow's model, with the runtime laid over it — what the overlay says, and
// that the picture carries it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { flowOverlay, flowPicture } from "../dist/core/picture.js";
import { loadStatechart } from "../dist/core/statechart.js";

const FLOW = readFileSync(new URL("./fixtures/ws-dev/flow.geml", import.meta.url), "utf8");
const sc = loadStatechart(FLOW, "flow.geml").statechart;
const NOW = "2026-10-14T08:00:00.000Z";

/** A status as the board sees it: in #review, one way out judged by the machine and not holding, one a person's. */
const status = (over = {}) => ({
  workflow: { name: "dev", path: "flow.geml", title: "dev" },
  item: { kind: "item", id: "feat/x" },
  state: { id: "review", title: "评审", rev: 3, uses: [], final: false, since: NOW },
  vars: {}, sources: {}, refusals: 0, paused: false,
  next: [
    { name: "review→deploy", to: "deploy", judge: "machine", approval: false, guard: "pr-merged = true and ci-pass = true", reads: ["pr-merged", "ci-pass"], missing: ["ci-pass"], holds: false, note: "" },
    { name: "review→build", to: "build", judge: "human", approval: false, guard: "review 要求改动", reads: [], missing: [], holds: true, note: "" },
  ],
  ...over,
});

test("the overlay: the item's state, the machine-judged ways out with whether they hold, the items per state, a hold, and the transition last taken", () => {
  const items = [{ id: "feat/x", state: "review" }, { id: "feat/y", state: "build" }, { id: "feat/z", state: "build" }];
  const timeline = [
    { kind: "snapshot", rev: 1, at: NOW, state: "build", cause: "enter" },
    { kind: "snapshot", rev: 2, at: NOW, state: "review", cause: "transition", from: "build", signal: "review-ready" },
    { kind: "refused", n: 1, rev: 2, at: NOW, tool: "Bash", reason: "deploy-staging is fenced" },
    { kind: "snapshot", rev: 3, at: NOW, state: "review", cause: "patch" },
  ];
  assert.deepEqual(flowOverlay({ sc, status: status({ paused: true }), items, timeline }), {
    current: "review",
    holds: { "review→deploy": false },
    paused: true,
    counts: { review: 1, build: 2 },
    taken: ["build→review"],
  }, "held: nothing is pressable");
  assert.deepEqual(flowOverlay({ sc, status: status(), items: [], timeline: [] }).pressable, ["review→build"], "not held: the way out whose guard holds is pressable, as the flow list offers it");
  assert.deepEqual(flowOverlay({ sc, status: null, items: [], timeline: [] }), {}, "nothing known, nothing laid over");
  assert.deepEqual(flowOverlay({ sc, status: status({ item: { kind: "inactive", reason: "main · not tracked" }, state: undefined }), items, timeline: [] }), { counts: { review: 1, build: 2 } }, "no item: only the spread of the others");
});

test("the picture: the topology, the overlay, and the SVG of both, top to bottom", () => {
  const p = flowPicture({ sc, status: status(), items: [{ id: "feat/x", state: "review" }], timeline: [] });
  assert.deepEqual(p.flow.ranks, [["build"], ["review"], ["deploy"], ["release"], ["done"]], "the parser's ranks, for a host that draws with its own elements");
  assert.deepEqual(p.flow.edges.map((e) => [e.name, e.kind]), [["build→review", "forward"], ["review→build", "lane"], ["review→deploy", "forward"], ["deploy→release", "forward"], ["release→done", "forward"]]);
  assert.deepEqual(p.overlay, { current: "review", holds: { "review→deploy": false }, pressable: ["review→build"], counts: { review: 1 } }, "the overlay, as flowOverlay says it");
  const svg = p.svg;
  assert.ok(svg.startsWith('<svg class="geml-statechart"'));
  assert.ok(svg.includes('class="node cur" data-state="review"') && svg.includes("#review · current"));
  assert.ok(svg.includes('<g class="pill guard no">'), "the way out that does not hold is grey");
  assert.ok(svg.includes('class="tr lane can" data-transition="review→build" data-from="review" data-to="build"'), "the person's way back is pressable");
  const ys = ["build", "review", "deploy"].map((id) => Number(svg.match(new RegExp(`data-state="${id}">.*?<rect class="box" x="[^"]+" y="([^"]+)"`))[1]));
  assert.ok(ys[0] < ys[1] && ys[1] < ys[2], "top to bottom");
});
