import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "@geml/geml";
import { loadStatechart } from "../dist/core/statechart.js";
import { initialSnapshot, applyPatch, applyTransition, applyRollback } from "../dist/core/snapshot.js";
import { renderLedgerHead, renderSnapshotBlock, renderRefusedBlock, readLedger, verifyLedger } from "../dist/core/ledger.js";

const sc = loadStatechart(readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8"), "refund.geml").statechart;
const T0 = "2026-09-14T12:00:00Z";
const meta = { session: "session-1", statechart: "refund.geml", statechartHash: sc.hash, created: T0 };

function run() {
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyPatch(sc, s0, { order: "A-17", amount: 120 }, { at: T0, call: "call_01" }).next;
  const refused = applyTransition(sc, s0, "review", { at: T0, call: "call_02" }).refusal;
  const s2 = applyTransition(sc, s1, "review", { at: T0, call: "call_03" }).next;
  const s3 = applyRollback(sc, [s0, s1, s2], 1, { at: T0, call: "call_04" }).next;
  const text = renderLedgerHead(meta) + renderSnapshotBlock(s0) + renderSnapshotBlock(s1)
    + renderRefusedBlock({ n: 1, rev: 1, at: T0, tool: refused.tool, call: "call_02", reason: refused.reason, diagnostics: refused.diagnostics })
    + renderSnapshotBlock(s2) + renderSnapshotBlock(s3);
  return { text, snapshots: [s0, s1, s2, s3] };
}

test("a rendered ledger is a clean geml-agent/v1 document", () => {
  const { text } = run();
  const doc = parse(text);
  assert.deepEqual(doc.diagnostics, []);
  assert.deepEqual(doc.ids.filter((id) => id.startsWith("rev-")), ["rev-0", "rev-1", "rev-2", "rev-3"]);
  assert.ok(doc.ids.includes("refused-1"));
  assert.ok(text.includes("state=#intake cause=enter hash=\"sha256:"), "attributes in the documented spelling");
  assert.ok(!text.includes("\r"), "LF only");
});

test("readLedger round-trips snapshots and refusals", () => {
  const { text, snapshots } = run();
  const ledger = readLedger(text);
  assert.deepEqual(ledger.diagnostics, []);
  assert.deepEqual(ledger.meta, meta);
  assert.deepEqual(ledger.snapshots, snapshots);
  assert.equal(ledger.refusals.length, 1);
  assert.equal(ledger.refusals[0].tool, "agent_transition");
  assert.deepEqual(ledger.refusals[0].diagnostics, ['$: missing required property "order"']);
  assert.equal(ledger.refusals[0].rev, 1);
});

test("verifyLedger passes a genuine chain, with and without the statechart", () => {
  const ledger = readLedger(run().text);
  assert.deepEqual(verifyLedger(ledger), []);
  assert.deepEqual(verifyLedger(ledger, sc), []);
});

test("verifyLedger catches: edited vars, broken parent, missing revision, reordered blocks, unknown state, undeclared edge", () => {
  const { text } = run();
  const tamper = (fn) => verifyLedger(readLedger(fn(text)), sc);
  assert.deepEqual(tamper((t) => t.replace('"amount":120', '"amount":999')), ["#rev-1: hash does not match its content"]);
  assert.deepEqual(tamper((t) => t.replace(/parent="sha256:[0-9a-f]{64}"/, 'parent="sha256:' + "0".repeat(64) + '"')),
    ["#rev-1: parent does not equal the previous hash", "#rev-1: hash does not match its content"]);
  const blocks = text.split("\n\n");
  const dropped = blocks.filter((b) => !b.startsWith("=== agent-snapshot {#rev-2")).join("\n\n");
  assert.deepEqual(tamper(() => dropped), ["#rev-3: rev is not contiguous (expected 2)", "#rev-3: parent does not equal the previous hash"]);
  const swapped = text.replace("{#rev-2 rev=2", "{#rev-X rev=2").replace("{#rev-3 rev=3", "{#rev-2 rev=2").replace("{#rev-X rev=2", "{#rev-3 rev=3");
  assert.ok(tamper(() => swapped).length > 0, "reordering breaks the chain");
  assert.deepEqual(tamper((t) => t.replace("state=#review cause=transition", "state=#nowhere cause=transition")),
    ["#rev-2: hash does not match its content", "#rev-2: state #nowhere is not in the statechart", "#rev-2: no transition #intake → #nowhere in the statechart"]);
});

test("verifyLedger checks cause / from / restores consistency", () => {
  const { text } = run();
  const noFrom = text.replace(/ from=#intake/, "");
  const errs = verifyLedger(readLedger(noFrom), sc);
  assert.ok(errs.includes("#rev-2: hash does not match its content") === false, "from is not hashed");
  assert.ok(errs.includes("#rev-2: cause transition needs from="));
  const badRestore = text.replace("restores=1", "restores=7");
  assert.ok(verifyLedger(readLedger(badRestore)).includes("#rev-3: restores must name an earlier revision"));
});

test("readLedger reports a malformed body without throwing", () => {
  const { text } = run();
  const broken = text.replace('{"amount":0,"approved":false}', "{not json");
  const ledger = readLedger(broken);
  assert.deepEqual(ledger.diagnostics, ["#rev-0: body is not JSON"]);
  assert.equal(ledger.snapshots.length, 3);
});

test("readLedger never throws: a JSON body that is not an object is reported and skipped", () => {
  const s0 = initialSnapshot(sc, T0);
  const head = renderLedgerHead(meta) + renderSnapshotBlock(s0);
  const refusedNull = head + '=== agent-refused {#refused-1 rev=0 at="2026-09-14T12:00:00Z" tool=agent_set}\nnull\n===\n\n';
  const a = readLedger(refusedNull);
  assert.deepEqual(a.diagnostics, ["#refused-1: body is not a JSON object"]);
  assert.equal(a.refusals.length, 0);
  assert.equal(a.snapshots.length, 1);
  const snapshotArray = head + '=== agent-snapshot {#rev-1 rev=1 state=#intake cause=patch parent="' + s0.hash + '" hash="sha256:00" at="2026-09-14T12:00:00Z"}\n[1,2]\n===\n\n';
  const b = readLedger(snapshotArray);
  assert.deepEqual(b.diagnostics, ["#rev-1: body is not a JSON object"]);
  assert.equal(b.snapshots.length, 1);
});

test("readLedger: meta keeps its defaults when a key is absent, and flags the wrong profile", () => {
  const bareMeta = '=== meta\ntitle = "geml-agent ledger"\nprofile = "other-profile"\n===\n\n';
  const l = readLedger(bareMeta);
  assert.deepEqual(l.meta, { session: "", statechart: "", statechartHash: "", created: "" });
  assert.deepEqual(l.diagnostics, ["meta: profile is not geml-agent/v1"]);
  assert.deepEqual(l.snapshots, []);
});

test("readLedger skips a stray paragraph and a foreign block type without complaint", () => {
  const { text: base } = run();
  // a loose paragraph between blocks is not `kind: \"block\"` at all
  const withProse = base.replace(renderLedgerHead(meta), renderLedgerHead(meta) + "just some prose here\n\n");
  const l1 = readLedger(withProse);
  assert.deepEqual(l1.diagnostics, []);
  assert.equal(l1.snapshots.length, 4);
  // a typed block that is neither agent-snapshot nor agent-refused, and has no #id
  const withForeign = base.replace(renderLedgerHead(meta), renderLedgerHead(meta) + "=== note\nhello\n===\n\n");
  const l2 = readLedger(withForeign);
  assert.deepEqual(l2.diagnostics, []);
  assert.equal(l2.snapshots.length, 4);
});

test("readLedger reports missing or malformed agent-snapshot attributes", () => {
  const head = renderLedgerHead(meta);
  const missingRev = head + '=== agent-snapshot {#rev-0 state=#intake cause=enter hash="sha256:00" at="2026-09-14T12:00:00Z"}\n{}\n===\n\n';
  assert.deepEqual(readLedger(missingRev).diagnostics, ["#rev-0: missing or malformed attributes"]);
  const badCause = head + '=== agent-snapshot {#rev-0 rev=0 state=#intake cause=bogus hash="sha256:00" at="2026-09-14T12:00:00Z"}\n{}\n===\n\n';
  assert.deepEqual(readLedger(badCause).diagnostics, ["#rev-0: missing or malformed attributes"]);
  const bareState = head + '=== agent-snapshot {#rev-0 rev=0 state=intake cause=enter hash="sha256:00" at="2026-09-14T12:00:00Z"}\n{}\n===\n\n';
  assert.deepEqual(readLedger(bareState).diagnostics, ["#rev-0: missing or malformed attributes"]);
});

test("readLedger fills in agent-refused defaults when attributes and id are absent", () => {
  const head = renderLedgerHead(meta);
  const bare = head + "=== agent-refused {}\n{}\n===\n\n";
  const l = readLedger(bare);
  assert.deepEqual(l.diagnostics, []);
  assert.deepEqual(l.refusals, [{ n: 0, rev: -1, at: "", tool: "", reason: "", diagnostics: [] }]);
});

test("verifyLedger flags a first revision that already carries a parent", () => {
  const head = renderLedgerHead(meta);
  const tampered = head + '=== agent-snapshot {#rev-0 rev=0 state=#intake cause=enter parent="sha256:'
    + "0".repeat(64) + '" hash="sha256:00" at="2026-09-14T12:00:00Z"}\n{}\n===\n\n';
  const errs = verifyLedger(readLedger(tampered));
  assert.ok(errs.includes("#rev-0: the first revision has no parent"));
});

test("verifyLedger refuses a ledger with no revision at all", () => {
  const errs = verifyLedger(readLedger(renderLedgerHead(meta)));
  assert.deepEqual(errs, ["the ledger holds no revision"]);
});
