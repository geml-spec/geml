import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadStatechart, outgoing, effectiveTools, allowedVars, hashText, hasErrors } from "../dist/core/statechart.js";

const refund = readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8");
const codes = (r) => r.diagnostics.map((d) => `${d.severity}:${d.code}`);
const HEAD = '=== meta\nprofile = "geml-agent/v1"\n===\n\n';

test("the refund statechart loads clean and keeps bodies byte for byte", () => {
  const r = loadStatechart(refund, "refund.geml");
  assert.deepEqual(r.diagnostics, []);
  const sc = r.statechart;
  assert.equal(sc.initial, "intake");
  assert.deepEqual([...sc.states.keys()], ["intake", "review", "pay", "wait-human", "done"]);
  assert.equal(sc.states.get("review").body, "Check the order against the refund policy in [[#policy]]. Set `approved`, then move on.");
  assert.equal(sc.states.get("pay").rollbackOnError, true);
  assert.deepEqual(sc.states.get("pay").tools, ["pay_refund"]);
  assert.deepEqual(sc.states.get("pay").vars, []);
  assert.equal(sc.states.get("wait-human").pause, true);
  assert.equal(sc.states.get("done").final, true);
  assert.deepEqual(sc.defaultTools, ["read_file", "grep"]);
  assert.equal(sc.transitions.length, 5);
  const toPay = sc.transitions.find((t) => t.id === "to-pay");
  assert.equal(toPay.approval, true);
  assert.equal(toPay.requiresId, "is-approved");
  assert.deepEqual(toPay.requires, { type: "object", required: ["approved"], properties: { approved: { const: true } } });
  assert.equal(sc.hash, hashText(refund));
  assert.match(sc.hash, /^sha256:[0-9a-f]{64}$/);
});

test("effectiveTools / allowedVars / outgoing", () => {
  const sc = loadStatechart(refund, "refund.geml").statechart;
  assert.deepEqual(effectiveTools(sc, sc.states.get("intake")), ["read_file", "grep"], "inherits meta tools");
  assert.deepEqual(effectiveTools(sc, sc.states.get("pay")), ["pay_refund"]);
  assert.deepEqual(allowedVars(sc, sc.states.get("intake")), ["order", "amount"]);
  assert.deepEqual(allowedVars(sc, sc.states.get("wait-human")), ["order", "amount", "approved"], "absent vars= means all");
  assert.deepEqual(allowedVars(sc, sc.states.get("pay")), []);
  assert.deepEqual(outgoing(sc, "review").map((t) => t.to), ["pay", "wait-human"]);
  assert.deepEqual(outgoing(sc, "done"), []);
});

test("no meta tools and no tools= means unrestricted", () => {
  const r = loadStatechart(HEAD + "=== agent-state {#a initial final}\nx\n===\n", "t.geml");
  assert.equal(effectiveTools(r.statechart, r.statechart.states.get("a")), undefined);
});

test("tools=none is the empty list", () => {
  const r = loadStatechart(HEAD + "=== agent-state {#a initial final tools=none}\nx\n===\n", "t.geml");
  assert.deepEqual(effectiveTools(r.statechart, r.statechart.states.get("a")), []);
});

test("a core geml error refuses the document and is passed through", () => {
  const r = loadStatechart(HEAD + "=== agent-state {#a initial final}\nSee [[#nowhere]].\n===\n", "t.geml");
  assert.equal(r.statechart, undefined);
  assert.ok(codes(r).some((c) => c.startsWith("error:unresolved")), codes(r).join());
});

test("agent-no-initial / agent-many-initial", () => {
  assert.deepEqual(codes(loadStatechart(HEAD + "=== agent-state {#a final}\nx\n===\n", "t")), ["error:agent-no-initial"]);
  assert.deepEqual(codes(loadStatechart(HEAD + "=== agent-state {#a initial final}\nx\n===\n=== agent-state {#b initial final}\nx\n===\n", "t")), ["error:agent-many-initial"]);
});

test("agent-bad-ref: wrong form, missing target, wrong type", () => {
  const base = HEAD + "=== agent-state {#a initial}\nx\n===\n=== agent-state {#b final}\nx\n===\n";
  assert.deepEqual(codes(loadStatechart(base + "=== agent-transition {#t from=a to=#b}\nx\n===\n", "t")), ["error:agent-bad-ref"]);
  assert.deepEqual(codes(loadStatechart(base + "=== agent-transition {#t from=#a to=#zz}\nx\n===\n", "t")), ["error:agent-bad-ref"]);
  assert.deepEqual(codes(loadStatechart(base + "=== agent-transition {#t from=#a to=#b requires=#a}\nx\n===\n", "t")), ["error:agent-bad-ref"]);
});

test("agent-final-outgoing and agent-dup-edge", () => {
  const base = HEAD + "=== agent-state {#a initial}\nx\n===\n=== agent-state {#b final}\nx\n===\n=== agent-transition {#t from=#a to=#b}\nx\n===\n";
  assert.deepEqual(codes(loadStatechart(base + "=== agent-transition {#u from=#b to=#a}\nx\n===\n", "t")), ["error:agent-final-outgoing"]);
  assert.deepEqual(codes(loadStatechart(base + "=== agent-transition {#u from=#a to=#b}\nx\n===\n", "t")), ["error:agent-dup-edge"]);
});

test("agent-vars-schema: two blocks, non-object root, unsupported keyword", () => {
  const states = "=== agent-state {#a initial final}\nx\n===\n";
  assert.deepEqual(codes(loadStatechart(HEAD + states + '=== agent-vars {#v}\n{"type":"object"}\n===\n=== agent-vars {#w}\n{"type":"object"}\n===\n', "t")), ["error:agent-vars-schema"]);
  assert.deepEqual(codes(loadStatechart(HEAD + states + '=== agent-vars {#v}\n{"type":"string"}\n===\n', "t")), ["error:agent-vars-schema"]);
  const r = loadStatechart(HEAD + states + '=== agent-vars {#v}\n{"type":"object","properties":{"n":{"type":"number","minimum":1}}}\n===\n', "t");
  assert.deepEqual(codes(r), ["error:agent-vars-schema"]);
  assert.match(r.diagnostics[0].message, /unsupported keyword "minimum"/);
});

test("agent-requires-schema and agent-unknown-var", () => {
  const base = HEAD + '=== agent-vars {#v}\n{"type":"object","properties":{"ok":{"type":"boolean"}}}\n===\n'
    + "=== agent-state {#a initial}\nx\n===\n=== agent-state {#b final}\nx\n===\n";
  assert.deepEqual(codes(loadStatechart(base + '=== data {#g format=json}\n{"type":"object","properties":{"ok":{"minimum":1}}}\n===\n=== agent-transition {#t from=#a to=#b requires=#g}\nx\n===\n', "t")), ["error:agent-requires-schema"]);
  assert.deepEqual(codes(loadStatechart(base.replace("{#a initial}", '{#a initial vars="ok nope"}') + "=== agent-transition {#t from=#a to=#b}\nx\n===\n", "t")), ["error:agent-unknown-var"]);
});

test("warnings: unreachable, dead-end, unknown tool (only with knownTools)", () => {
  const src = HEAD + "=== agent-state {#a initial tools=\"bash\"}\nx\n===\n=== agent-state {#b final}\nx\n===\n=== agent-state {#c}\nx\n===\n=== agent-transition {#t from=#a to=#b}\nx\n===\n";
  const r = loadStatechart(src, "t");
  assert.ok(r.statechart, "warnings do not refuse");
  assert.deepEqual(codes(r).sort(), ["warning:agent-dead-end", "warning:agent-unreachable"]);
  const withTools = loadStatechart(src, "t", { knownTools: ["read_file"] });
  assert.ok(codes(withTools).includes("warning:agent-unknown-tool"));
  assert.equal(hasErrors(withTools.diagnostics), false);
});

test("agent-vars: invalid JSON (not a SchemaError) and a block with no id both fall back cleanly", () => {
  const states = "=== agent-state {#a initial final}\nx\n===\n";
  const r = loadStatechart(HEAD + states + "=== agent-vars\n{not json\n===\n", "t");
  assert.deepEqual(codes(r), ["error:agent-vars-schema"]);
  assert.match(r.diagnostics[0].message, /^agent-vars #\?: /, "no id falls back to #?, and the JSON.parse SyntaxError's own .message is used");
});

test("agent-vars: a second block without an id is still named in the duplicate-block error", () => {
  const states = "=== agent-state {#a initial final}\nx\n===\n";
  const r = loadStatechart(HEAD + states + '=== agent-vars {#v}\n{"type":"object"}\n===\n=== agent-vars\n{"type":"object"}\n===\n', "t");
  assert.deepEqual(codes(r), ["error:agent-vars-schema"]);
  assert.match(r.diagnostics[0].message, /more than one agent-vars block \(#v, #\?\)/);
});

test("agent-state without an id is refused and never enters the state map", () => {
  const r = loadStatechart(HEAD + "=== agent-state {initial final}\nx\n===\n", "t");
  assert.equal(r.statechart, undefined);
  assert.deepEqual(codes(r), ["error:agent-bad-ref", "error:agent-no-initial"]);
  assert.equal(r.diagnostics[0].message, "agent-state without an id");
});

test("agent-transition without an id gets a synthetic transition@<line> id and still resolves", () => {
  const base = HEAD + "=== agent-state {#a initial}\nx\n===\n=== agent-state {#b final}\nx\n===\n";
  const r = loadStatechart(base + "=== agent-transition {from=#a to=#b}\nx\n===\n", "t");
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.statechart.transitions.length, 1);
  assert.match(r.statechart.transitions[0].id, /^transition@\d+$/);
});

test("a CRLF checkout yields the same body bytes and the same hash as an LF one", () => {
  const lf = "=== meta\nprofile = \"geml-agent/v1\"\n===\n\n=== agent-state {#a initial final}\nline one\nline two\n===\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  const a = loadStatechart(lf, "t.geml").statechart;
  const b = loadStatechart(crlf, "t.geml").statechart;
  assert.equal(a.states.get("a").body, "line one\nline two");
  assert.equal(b.states.get("a").body, a.states.get("a").body, "body must not carry CR");
  assert.equal(b.hash, a.hash);
});

test("agent-transition: a malformed to= (missing #) and a malformed requires= (missing #) are both agent-bad-ref", () => {
  const base = HEAD + "=== agent-state {#a initial}\nx\n===\n=== agent-state {#b final}\nx\n===\n";
  const badTo = loadStatechart(base + "=== agent-transition {#t from=#a to=b}\nx\n===\n", "t");
  assert.deepEqual(codes(badTo), ["error:agent-bad-ref"]);
  assert.match(badTo.diagnostics[0].message, /to= must be #id of an agent-state/);
  const badRequires = loadStatechart(base + "=== agent-transition {#t from=#a to=#b requires=nope}\nx\n===\n", "t");
  assert.deepEqual(codes(badRequires), ["error:agent-bad-ref"]);
  assert.match(badRequires.diagnostics[0].message, /requires= must be #id of a data block/);
});
