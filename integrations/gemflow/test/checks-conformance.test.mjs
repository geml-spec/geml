// Replays spec/checks.json: the table of static
// checks (§4) is the source of truth, and this file only proves the loader
// and the dictionary reader agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadStatechart } from "../dist/core/statechart.js";
import { readDictionary } from "../dist/core/dictionary-file.js";

const table = JSON.parse(readFileSync(new URL("../spec/checks.json", import.meta.url), "utf8"));

for (const c of table.cases) {
  test(`checks.json: ${c.name}`, () => {
    const r = loadStatechart(c.doc, "case.geml");
    const diagnostics = [...r.diagnostics];
    if (c.tools !== undefined && r.statechart !== undefined) diagnostics.push(...readDictionary(c.tools, r.statechart).diagnostics);
    const got = diagnostics.map((d) => `${d.severity}:${d.code}`).sort();
    assert.deepEqual(got, [...c.codes].sort(), diagnostics.map((d) => d.message).join("\n"));
  });
}
