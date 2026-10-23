import { test } from "node:test";
import assert from "node:assert/strict";
import { isVisualTool, visualFileName, visualPage } from "../dist/hosts/claude-code/visual.js";

test("an inline visual: the visualize tool's widget, whatever the connector is called", () => {
  assert.equal(isVisualTool("mcp__visualize__show_widget"), true);
  assert.equal(isVisualTool("mcp__6f616b42__show_widget"), true);
  assert.equal(isVisualTool("mcp__visualize__read_me"), false);
  assert.equal(isVisualTool("Artifact"), false);
});

test("its page: named by its title, safe for any file system; the widget whole, with the look it was drawn for", () => {
  assert.equal(visualFileName("gemflow_coach_flow_page_per_statechart_v3"), "gemflow_coach_flow_page_per_statechart_v3.html");
  assert.equal(visualFileName(" a/b: c?d "), "a-b-c-d.html");
  assert.equal(visualFileName(""), "visual.html");
  const page = visualPage("flow <v3>", '<div class="row">x</div><svg><g class="c-purple"><rect/></g></svg>');
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<title>flow &lt;v3&gt;<\/title>/);
  assert.ok(page.includes('<div class="row">x</div><svg><g class="c-purple"><rect/></g></svg>'), "the widget as drawn");
  assert.match(page, /--text-primary:#1f1e1d/, "the colour variables it reads");
  assert.match(page, /svg \.c-purple rect[^{]*\{fill:#EEEDFE;stroke:#534AB7\}/, "the ramps its SVG classes name");
  assert.match(page, /tabler-icons/, "its icon font");
});
