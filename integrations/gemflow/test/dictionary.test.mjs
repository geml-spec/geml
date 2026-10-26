// The tool dictionary (spec §5.3): keys, patterns, the decision, fenced uses,
// learning, and the file it lives in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "@geml/geml";
import {
  bindingOf, decide, evidenceKeys, fencedRefusal, judgeKey, keyMatches, keysOf, learn, literalLength, normalizedCommand, preferred, usesOf, EMPTY_DICTIONARY,
} from "../dist/core/dictionary.js";
import { readDictionary, renderDictionary, renderToolsTable, withToolsTable } from "../dist/core/dictionary-file.js";
import { loadStatechart } from "../dist/core/statechart.js";
import { dict, dictDoc, flowDoc } from "./helpers/flow.mjs";

const RUN = ["Bash"];
const DICT = dict([
  { tool: "Read", allow: ["*"] },
  { tool: "Edit", for: "edit", default: true },
  { tool: "Write", for: "edit" },
  { tool: "Bash(npm test)", for: "test", default: true },
  { tool: "Bash(wrangler deploy)", for: "deploy-prod", default: true },
  { tool: "Bash(wrangler deploy*--env staging)", for: "deploy-staging", default: true },
  { tool: "Bash(wrangler deploy --dry-run)", allow: ["*"] },
  { tool: "WebFetch", allow: ["build"], deny: ["lock"] },
  { tool: "mcp__img__*", for: "image", params: { ratio: "9:16" } },
]);
const FENCES = { edit: ["build"], test: ["build"], "deploy-prod": ["release"], "deploy-staging": ["deploy"], image: ["assets"] };
const scope = (state, uses) => ({ state, uses, declaring: (use) => FENCES[use] ?? [], fenced: (use) => FENCES[use] !== undefined });
const BUILD = scope("build", ["edit", "test"]);
const LOCK = scope("lock", []);
const DEPLOY = scope("deploy", ["deploy-staging"]);

test("keysOf: a tool's name, or one Bash(<command>) per simple command of a run tool's line, quoting removed and blanks collapsed", () => {
  assert.deepEqual(keysOf("Read", { file_path: "x" }, RUN), ["Read"]);
  assert.deepEqual(keysOf("Bash", { command: "npm test" }, RUN), ["Bash(npm test)"]);
  assert.deepEqual(keysOf("Bash", { command: "cd x && npm  test -- 'a b'" }, RUN), ["Bash(cd x)", "Bash(npm test -- a b)"]);
  assert.deepEqual(keysOf("Bash", { command: "npm test | tee log" }, RUN), ["Bash(npm test | tee log)"], "a line that is not a plain && chain is one key");
  assert.deepEqual(keysOf("Monitor", { command: "npm test" }, RUN), ["Monitor"], "only a run tool is keyed by its command");
  assert.deepEqual(keysOf("Bash", {}, RUN), ["Bash"]);
  assert.equal(normalizedCommand('wran"gler"  deploy'), "wrangler deploy");
});

test("keysOf: a tool that writes files is keyed by the file it writes, its separators made /", () => {
  const WRITE = ["Edit", "Write", "NotebookEdit", "edit"];
  assert.deepEqual(keysOf("Edit", { file_path: "C:\\work\\app\\.geml\\matters\\a.geml" }, RUN, WRITE), ["Edit(C:/work/app/.geml/matters/a.geml)"]);
  assert.deepEqual(keysOf("Write", { file_path: "/work/app/src/a.ts" }, RUN, WRITE), ["Write(/work/app/src/a.ts)"]);
  assert.deepEqual(keysOf("NotebookEdit", { notebook_path: "nb/x.ipynb" }, RUN, WRITE), ["NotebookEdit(nb/x.ipynb)"]);
  assert.deepEqual(keysOf("edit", { path: "src/a.ts" }, RUN, WRITE), ["edit(src/a.ts)"], "pi's tools name the file path");
  assert.deepEqual(keysOf("Edit", {}, RUN, WRITE), ["Edit"], "no path: the name alone");
  assert.deepEqual(keysOf("Read", { file_path: "x" }, RUN, WRITE), ["Read"], "only a tool that writes is keyed by its path");
});

test("keyMatches: a tool's name takes it with any path; a path pattern takes the paths that end in a match of its glob", () => {
  assert.equal(keyMatches("Edit", "Edit(src/a.ts)"), true);
  assert.equal(keyMatches("Edit", "Edit"), true);
  assert.equal(keyMatches("Edit", "Editor(src/a.ts)"), false);
  assert.equal(keyMatches("Edit(.geml/matters/*)", "Edit(C:/work/app/.geml/matters/a.geml)"), true, "an absolute path ends in the match");
  assert.equal(keyMatches("Edit(.geml/matters/*)", "Edit(.geml/matters/a.geml)"), true);
  assert.equal(keyMatches("Edit(.geml/matters/*)", "Edit(/w/x.geml/matters/a.geml)"), false, "the match starts at a segment");
  assert.equal(keyMatches("Edit(.geml/matters/*)", "Edit(.geml/matters/sub/a.geml)"), false, "* stays in a segment");
  assert.equal(keyMatches("Edit(.geml/**/*.geml)", "Edit(/w/.geml/matters/sub/a.geml)"), true, "** crosses them");
  assert.equal(keyMatches("Edit(.geml/matters/*)", "Write(.geml/matters/a.geml)"), false, "the tool must match too");
  assert.equal(keyMatches("*(.geml/matters/*)", "Write(.geml/matters/a.geml)"), true, "a tool pattern with * takes several tools");
  assert.equal(keyMatches("Edit(.geml/matters/*)", "Edit"), false, "a path pattern never takes a call without a path");
  assert.equal(keyMatches("Edit(src/a.ts)", "Bash(src/a.ts)"), false, "a path key is never a command, nor the other way round");
  assert.ok(literalLength("Edit(.geml/matters/*)") > literalLength("Edit"), "the path row outranks the tool's own row");
});

test("judgeKey: a path row splits one tool between two uses — writing a matter is note, writing anything else is edit", () => {
  const d = dict([{ tool: "Edit", for: "edit", default: true }, { tool: "Edit(.geml/matters/*)", for: "note", default: true }]);
  const deciding = { state: "deciding", uses: ["note"], declaring: (u) => (u === "edit" ? ["doing"] : ["noted", "deciding", "doing"]), fenced: () => true };
  assert.deepEqual(judgeKey(d, deciding, "Edit(/w/app/.geml/matters/a.geml)"), { key: "Edit(/w/app/.geml/matters/a.geml)", kind: "allow", use: "note" });
  assert.deepEqual(judgeKey(d, deciding, "Edit(/w/app/src/a.ts)"), { key: "Edit(/w/app/src/a.ts)", kind: "refuse", reason: "Edit is edit, which is used only in #doing; the workflow is in #deciding" }, "the reason names the row that judged a path");
});

test("keyMatches: a name pattern matches whole with * as any text; a command pattern matches a prefix, * any run of text", () => {
  assert.equal(keyMatches("Read", "Read"), true);
  assert.equal(keyMatches("Read", "ReadFile"), false);
  assert.equal(keyMatches("mcp__img__*", "mcp__img__generate"), true);
  assert.equal(keyMatches("mcp__img__*", "mcp__imgx__generate"), false);
  assert.equal(keyMatches("Bash(npm test)", "Bash(npm test -- --watch=false)"), true);
  assert.equal(keyMatches("Bash(npm test)", "Bash(npm tests)"), false, "a prefix of whole words: `npm tests` is another command");
  assert.equal(keyMatches("Bash(wrangler deploy)", "Bash(wrangler deployments list)"), false);
  assert.equal(keyMatches("Bash(geml media todo*--check)", "Bash(geml media todo x --checkout)"), false, "`*` runs to a whole word too");
  assert.equal(keyMatches("Bash(npm test)", "Bash(npm run test)"), false);
  assert.equal(keyMatches("Bash(wrangler deploy*--env staging)", "Bash(wrangler deploy --minify --env staging)"), true);
  assert.equal(keyMatches("Bash(wrangler deploy*--env staging)", "Bash(wrangler deploy --env staging)"), true);
  assert.equal(keyMatches("Bash(wrangler deploy*--env staging)", "Bash(wrangler deploy --env production)"), false);
  assert.equal(keyMatches("Bash(npm test)", "npm test"), false, "a command pattern never takes a tool name, nor the other way round");
  assert.equal(keyMatches("Bash", "Bash(ls)"), false);
  assert.equal(keyMatches("Bash()", "Bash(ls)"), true, "Bash() is every command");
});

test("bindingOf picks the matching row with the longest literal; preferred is the use's default row", () => {
  assert.equal(bindingOf(DICT, "Bash(wrangler deploy --env staging)").for, "deploy-staging");
  assert.equal(bindingOf(DICT, "Bash(wrangler deploy --env production)").for, "deploy-prod");
  assert.equal(bindingOf(DICT, "Bash(wrangler deploy --dry-run)").for, undefined, "the longer, unbound row wins");
  assert.equal(bindingOf(DICT, "Bash(ls)"), undefined);
  assert.equal(literalLength("Bash(wrangler deploy*--env staging)"), "wrangler deploy--env staging".length);
  assert.equal(preferred(DICT, "edit").tool, "Edit");
  assert.equal(preferred(dict([{ tool: "A", for: "x" }, { tool: "B", for: "x" }]), "x").tool, "A", "no default: the first row bound to the use");
  assert.equal(preferred(DICT, "nothing"), undefined);
});

test("judgeKey: a use the state declares allows, one it does not refuses with where it is used; else a written allow or deny, else unknown", () => {
  assert.deepEqual(judgeKey(DICT, BUILD, "Edit"), { key: "Edit", kind: "allow", use: "edit" });
  assert.deepEqual(judgeKey(DICT, LOCK, "Edit"), { key: "Edit", kind: "refuse", reason: "Edit is edit, which is used only in #build; the workflow is in #lock" });
  assert.deepEqual(judgeKey(DICT, BUILD, "Bash(wrangler deploy --env production)"), { key: "Bash(wrangler deploy --env production)", kind: "refuse", reason: "Bash(wrangler deploy --env production) is deploy-prod, which is used only in #release; the workflow is in #build" });
  assert.deepEqual(judgeKey(DICT, BUILD, "Read"), { key: "Read", kind: "allow" });
  assert.deepEqual(judgeKey(DICT, BUILD, "WebFetch"), { key: "WebFetch", kind: "allow" });
  assert.deepEqual(judgeKey(DICT, LOCK, "WebFetch"), { key: "WebFetch", kind: "refuse", reason: "you denied WebFetch in #lock" });
  assert.deepEqual(judgeKey(DICT, DEPLOY, "WebFetch"), { key: "WebFetch", kind: "unknown" });
  assert.deepEqual(judgeKey(DICT, BUILD, "Bash(ls)"), { key: "Bash(ls)", kind: "unknown" });
  assert.deepEqual(judgeKey(dict([{ tool: "X", deny: ["*"] }]), BUILD, "X").reason, "you denied X in every state");
});

test("decide: any refused key refuses the call; otherwise it is allowed, the keys no row takes named as unknown and never asked about", () => {
  assert.deepEqual(decide(DICT, BUILD, ["Bash(cd x)", "Bash(npm test)"]), { kind: "allow", uses: ["test"], unknown: ["Bash(cd x)"] });
  assert.deepEqual(decide(DICT, BUILD, ["Bash(npm test)", "Bash(wrangler deploy)"]), { kind: "refuse", reasons: ["Bash(wrangler deploy) is deploy-prod, which is used only in #release; the workflow is in #build"], keys: ["Bash(wrangler deploy)"] });
  assert.deepEqual(decide(DICT, BUILD, ["Read", "Bash(npm test)"]), { kind: "allow", uses: ["test"], unknown: [] });
  assert.deepEqual(decide(DICT, BUILD, ["Edit"]), { kind: "allow", uses: ["edit"], unknown: [] });
  assert.deepEqual(decide(EMPTY_DICTIONARY, LOCK, ["Read"]), { kind: "allow", uses: [], unknown: ["Read"] });
});

test("usesOf: the uses a call's keys are bound to, in the state", () => {
  assert.deepEqual(usesOf(DICT, BUILD, ["Bash(cd x)", "Bash(npm test)", "Edit"]), ["test", "edit"]);
  assert.deepEqual(usesOf(DICT, LOCK, ["Bash(npm test)"]), [], "a use the state does not declare is not evidence here");
});

test("fencedRefusal searches the whole line and its unquoted copy; the longest literal speaks", () => {
  const prod = /is deploy-prod, which is used only in #release; the workflow is in #build/;
  for (const c of [
    "wrangler deploy", "cd x && wrangler deploy", "npm test; wrangler deploy", "npm test || wrangler deploy", "wrangler deploy &",
    "bash -c \"wrangler deploy\"", "echo $(wrangler deploy)", "CI=1 wrangler deploy", "echo done | wrangler deploy", "x\nwrangler deploy",
    "npx wrangler deploy --env production", 'wran"gler"  deploy --env production', "wrangler\tdeploy", "w\\rangler deploy", "cd x && wrangler \\\n deploy",
    "wrangler deploy --env=production", "wrangler deploy " + "x".repeat(70000),
  ]) assert.match(fencedRefusal(DICT, BUILD, c) ?? "", prod, JSON.stringify(c));
  assert.equal(fencedRefusal(DICT, scope("release", ["deploy-prod"]), "cd x && wrangler deploy"), undefined);
  assert.equal(fencedRefusal(DICT, BUILD, "npm test"), undefined, "a use the state declares");
  assert.equal(fencedRefusal(DICT, BUILD, "wrangler deplo y"), undefined);
  assert.equal(fencedRefusal(DICT, BUILD, "wrangler deploy"), undefined, "a no-break space is not a blank");
  assert.equal(fencedRefusal(DICT, DEPLOY, "wrangler deploy --env staging"), undefined, "the staging row's literal is longer than production's");
  assert.match(fencedRefusal(DICT, DEPLOY, "wrangler deploy --env production") ?? "", /is deploy-prod/);
  assert.equal(fencedRefusal(DICT, BUILD, "wrangler deploy --dry-run"), undefined, "an unbound longer row is a carve-out");
  assert.equal(fencedRefusal(EMPTY_DICTIONARY, LOCK, "wrangler deploy"), undefined);
});

test("the fenced refusal quotes at most 200 characters of the command and never cuts a surrogate pair", () => {
  const long = fencedRefusal(DICT, BUILD, "wrangler deploy " + "x".repeat(500)) ?? "";
  assert.ok(long.startsWith(`"wrangler deploy ${"x".repeat(184)}…" is deploy-prod`), long.slice(0, 60));
  const emoji = fencedRefusal(DICT, BUILD, "wrangler deploy x" + "😀".repeat(300)) ?? "";
  assert.doesNotMatch(emoji, /[\ud800-\udbff]…/);
});

test("evidenceKeys: the keys of a plain && chain, chosen by index; null for any other line", () => {
  assert.deepEqual(evidenceKeys("cd x && npm test"), ["Bash(cd x)", "Bash(npm test)"]);
  assert.deepEqual(evidenceKeys("cd x && npm test", [1]), ["Bash(npm test)"]);
  assert.deepEqual(evidenceKeys("CI=1 npm test"), ["Bash(npm test)"], "leading assignments are skipped");
  assert.equal(evidenceKeys("npm test | tee log"), null);
  assert.equal(evidenceKeys("npm test; true"), null);
  assert.equal(evidenceKeys("exit 0 && npm test"), null);
});

test("learn: allow and deny on a state or *, use and default, params; an existing row of the key is changed, else one is added", () => {
  let d = EMPTY_DICTIONARY;
  d = learn(d, { kind: "allow", key: "Bash(ls)", where: "build" });
  assert.deepEqual(d.rows, [{ tool: "Bash(ls)", allow: ["build"], deny: [], default: false, row: 1 }]);
  d = learn(d, { kind: "deny", key: "Bash(ls)", where: "build" });
  assert.deepEqual([d.rows[0].allow, d.rows[0].deny], [[], ["build"]], "a deny on a state takes its allow away");
  d = learn(d, { kind: "allow", key: "Bash(ls)", where: "*" });
  assert.deepEqual([d.rows[0].allow, d.rows[0].deny], [["*"], ["build"]]);
  d = learn(d, { kind: "use", key: "Bash(cargo test)", use: "test" });
  assert.deepEqual(d.rows[1], { tool: "Bash(cargo test)", for: "test", allow: [], deny: [], default: true, row: 2 }, "the first tool of a use is its preferred one");
  d = learn(d, { kind: "use", key: "Bash(npm test)", use: "test" });
  assert.equal(d.rows[2].default, false);
  d = learn(d, { kind: "default", key: "Bash(npm test)", use: "test" });
  assert.deepEqual(d.rows.filter((r) => r.for === "test").map((r) => [r.tool, r.default]), [["Bash(cargo test)", false], ["Bash(npm test)", true]]);
  d = learn(d, { kind: "params", key: "mcp__img__generate", params: { ratio: "9:16" } });
  assert.deepEqual(d.rows.at(-1).params, { ratio: "9:16" });
  assert.equal(EMPTY_DICTIONARY.rows.length, 0, "learning never changes the dictionary it was given");
});

test("learn: a key with a line break is not learned, since no table cell can hold it; the table stays whole", () => {
  const multi = 'Bash(node -e "const a=1;\nconsole.log(a)")';
  const d = learn(learn(EMPTY_DICTIONARY, { kind: "allow", key: "Bash(ls)", where: "*" }), { kind: "allow", key: multi, where: "*" });
  assert.deepEqual(d.rows.map((r) => r.tool), ["Bash(ls)"]);
  assert.deepEqual(learn(EMPTY_DICTIONARY, { kind: "use", key: "Bash(a\r\nb)", use: "test" }).rows, []);
  assert.deepEqual(readDictionary(renderDictionary(d.rows)).rows.map((r) => r.tool), ["Bash(ls)"]);
});

test("readDictionary: the #tools table, checked against the workflow; renderDictionary round-trips it", () => {
  const sc = loadStatechart(flowDoc({ initial: "a", states: { a: { tools: ["edit"] }, b: {} }, transitions: [{ from: "a", to: "b" }] }), "t").statechart;
  const rows = [
    { tool: "Read", allow: ["*"] }, { tool: "Edit", for: "edit", default: true }, { tool: "Bash(npm test)", for: "test" },
    { tool: "X", allow: ["a"], deny: ["b"], params: { n: 1 } },
  ];
  const text = dictDoc(rows);
  assert.deepEqual(parse(text).diagnostics, []);
  const d = readDictionary(text, sc);
  assert.deepEqual(d.diagnostics.map((x) => `${x.severity}:${x.code}`), ["warning:flow-source"], "test is declared by no state");
  assert.deepEqual(d.rows.map((r) => [r.tool, r.for, r.allow, r.deny, r.default, r.params]), [
    ["Read", undefined, ["*"], [], false, undefined],
    ["Edit", "edit", [], [], true, undefined],
    ["Bash(npm test)", "test", [], [], false, undefined],
    ["X", undefined, ["a"], ["b"], false, { n: 1 }],
  ]);
  assert.equal(renderDictionary(d.rows), text);
  const again = readDictionary(renderDictionary(d.rows));
  assert.deepEqual(again.rows, d.rows);
});

test("flow-tools: a missing table, a wrong header, an unknown state, a bad default, two defaults, params that are not an object", () => {
  const sc = loadStatechart(flowDoc({ initial: "a", states: { a: {}, b: {} }, transitions: [{ from: "a", to: "b" }] }), "t").statechart;
  const errs = (text) => readDictionary(text, sc).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
  assert.deepEqual(errs("=== meta\ntitle = \"x\"\n===\n"), ["no `table {#tools}` block"]);
  assert.deepEqual(errs("=== table {#tools}\n| tool | for |\n|---|---|\n| X | |\n===\n"), ["#tools: missing column(s) allow, deny, default, params"]);
  assert.deepEqual(errs("=== table {#tools}\n| tool | for | allow | deny | default | params | extra |\n|---|---|---|---|---|---|---|\n| X | | | | | | |\n===\n"), ["#tools: unknown column(s) extra (the columns are tool, for, allow, deny, default, params)"]);
  assert.deepEqual(errs(dictDoc([{ tool: "X", allow: ["zz"] }])), ["#tools row 1: allow names zz, which is not a state of the workflow"]);
  assert.deepEqual(errs("=== table {#tools}\n| tool | for | allow | deny | default | params |\n|---|---|---|---|---|---|\n| X | | | | maybe | |\n===\n"), ['#tools row 1: default = "maybe" is not yes (or empty)']);
  assert.deepEqual(errs(dictDoc([{ tool: "X", default: true }])), ["#tools row 1: default without a use (for)"]);
  assert.deepEqual(errs(dictDoc([{ tool: "X", for: "u", default: true }, { tool: "Y", for: "u", default: true }])), ["#tools row 2: a second default for the use u (row 1)"]);
  assert.deepEqual(errs("=== table {#tools}\n| tool | for | allow | deny | default | params |\n|---|---|---|---|---|---|\n| X | | | | | `[1]` |\n===\n"), ["#tools row 1: params is not a JSON object"]);
  assert.deepEqual(errs("=== table {#tools}\n| tool | for | allow | deny | default | params |\n|---|---|---|---|---|---|\n| X | | | | | `{` |\n===\n"), ["#tools row 1: params is not JSON"]);
  assert.deepEqual(errs("=== table {#tools}\n| tool | for | allow | deny | default | params |\n|---|---|---|---|---|---|\n| X | a b | | | | |\n===\n"), ['#tools row 1: for = "a b" is not a name']);
});

test("a tool's name is its address: a second row for it is left out with a warning, the first counts; names differing only in case are two tools", () => {
  const d = readDictionary(dictDoc([{ tool: "Edit", for: "edit" }, { tool: "edit", for: "edit" }, { tool: "Edit", for: "note", default: true }]));
  assert.deepEqual(d.rows.map((r) => [r.tool, r.for]), [["Edit", "edit"], ["edit", "edit"]], "Claude Code's Edit and pi's edit both stay");
  assert.deepEqual(d.diagnostics.map((x) => [x.severity, x.message]), [["warning", "#tools row 3: Edit has a row already (row 1); that one counts and this one is left out"]]);
});

test("withToolsTable rewrites only the #tools block; prose around it stays; a document without one gets it appended; none at all is made whole", () => {
  const rows = [{ tool: "Read", allow: ["*"], deny: [], default: false, row: 1 }];
  const source = "=== meta\ntitle = \"mine\"\n===\n\n%% my note\n\n" + renderToolsTable([]) + "\n\n## After {#after}\n\nKept.\n";
  const out = withToolsTable(source, rows);
  assert.ok(out.startsWith("=== meta\ntitle = \"mine\"\n===\n\n%% my note\n\n=== table {#tools}\n"), out.slice(0, 80));
  assert.ok(out.endsWith("===\n\n## After {#after}\n\nKept.\n"), out.slice(-40));
  assert.deepEqual(readDictionary(out).rows, rows);
  const appended = withToolsTable("=== meta\ntitle = \"x\"\n===\n", rows);
  assert.deepEqual(readDictionary(appended).rows, rows);
  assert.equal(withToolsTable(null, rows), renderDictionary(rows));
});

test("a forget lesson takes the row of exactly that key out, and numbers the rest again", () => {
  const dict = { rows: [{ tool: "Read", allow: ["*"], deny: [], default: false, row: 1 }, { tool: "Bash(npm test)", for: "test", allow: [], deny: [], default: true, row: 2 }, { tool: "Edit", for: "edit", allow: [], deny: [], default: true, row: 3 }], diagnostics: [] };
  const out = learn(dict, { kind: "forget", key: "Bash(npm test)" });
  assert.deepEqual(out.rows.map((r) => [r.tool, r.row]), [["Read", 1], ["Edit", 2]]);
  assert.equal(learn(dict, { kind: "forget", key: "Bash(nothing)" }).rows.length, 3, "a key with no row: nothing changes");
});

test("rules: only a use a state declares as a rule is kept to the states that declare it; a use declared only in `tools` runs anywhere, with no use named outside its states", async () => {
  const { readFileSync } = await import("node:fs");
  const { scopeIn } = await import("../dist/core/policy.js");
  const flow = (name) => loadStatechart(readFileSync(new URL(`../workflows/${name}/flow.geml`, import.meta.url), "utf8"), `${name}.geml`).statechart;
  const dev = flow("dev");
  assert.deepEqual([...dev.rules].sort(), ["deploy-prod", "deploy-staging"], "发布: the two deploys are rules");
  assert.deepEqual(judgeKey(DICT, scopeIn(dev, "deploy"), "Edit"), { key: "Edit", kind: "allow" }, "edit is no rule: it runs in #deploy, no use named");
  assert.deepEqual(judgeKey(DICT, scopeIn(dev, "build"), "Edit"), { key: "Edit", kind: "allow", use: "edit" }, "in a state declaring it, the use is named (its evidence counts)");
  const prod = ["Bash(wrangler", "deploy)"].join(" ");
  assert.match(judgeKey(DICT, scopeIn(dev, "build"), prod).reason, /is deploy-prod, which is used only in #release; the workflow is in #build/);
  assert.match(fencedRefusal(DICT, scopeIn(dev, "deploy"), ["npx wrangler", "deploy"].join(" ")), /is deploy-prod, which is used only in #release/);
  const coding = flow("coding");
  assert.deepEqual([...coding.rules].sort(), ["edit", "test"], "coding: the strict flow");
  assert.match(judgeKey(DICT, scopeIn(coding, "plan"), "Edit").reason, /is edit, which is used only in #implement; the workflow is in #plan/);
  const bad = loadStatechart(flowDoc({ initial: "a", states: { a: { rules: ["no good"] }, done: { final: true } }, transitions: [{ from: "a", to: "done" }] }), "bad.geml");
  assert.ok(bad.diagnostics.some((d) => d.code === "flow-attr" && /`rules` is not an array of use names/.test(d.message)));
});
