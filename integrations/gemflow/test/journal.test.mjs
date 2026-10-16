import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "@geml/geml";
import { loadStatechart } from "../dist/core/statechart.js";
import { initialSnapshot, applyPatch, applyTransition, applyRollback, applySignal, applyHold, hashSnapshot } from "../dist/core/snapshot.js";
import { renderJournalHead, renderSnapshotBlock, renderRefusedBlock, renderWroteBlock, renderJournalMarkdown, readJournal, verifyJournal } from "../dist/core/journal.js";
import { twoStates } from "./helpers/flow.mjs";

const sc = loadStatechart(readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8"), "refund.geml").statechart;
const T0 = "2026-09-14T12:00:00Z";
const meta = { item: "session-1", workflow: "refund.geml", workflowHash: sc.hash, created: T0 };

function run() {
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyPatch(sc, s0, { order: "A-17", amount: 120 }, { at: T0, call: "call_01" }).next;
  const refused = applyTransition(sc, s0, "done", { at: T0, call: "call_02" }).refusal;
  const s2 = applyTransition(sc, s1, "review", { at: T0, call: "call_03" }).next;
  const s3 = applyRollback(sc, [s0, s1, s2], 1, { at: T0, call: "call_04" }).next;
  const text = renderJournalHead(meta) + renderSnapshotBlock(s0) + renderSnapshotBlock(s1)
    + renderRefusedBlock({ n: 1, rev: 1, at: T0, tool: refused.tool, call: "call_02", reason: refused.reason, diagnostics: refused.diagnostics })
    + renderSnapshotBlock(s2) + renderSnapshotBlock(s3);
  return { text, snapshots: [s0, s1, s2, s3] };
}

test("a rendered journal is a clean GEML document of core data blocks", () => {
  const { text } = run();
  const doc = parse(text);
  assert.deepEqual(doc.diagnostics, []);
  assert.deepEqual(doc.ids, ["journal", "rev-0", "rev-1", "refused-1", "rev-2", "rev-3"]);
  assert.match(text, /^=== data \{#journal format=json\}\n\{"created":"[^"]+","item":"session-1","workflow":"refund\.geml","workflow-hash":"sha256:/m);
  assert.match(text, /^=== data \{#rev-0 format=json\}\n\{"at":/m, "a revision is one canonical JSON line");
  assert.ok(!text.includes("\r"), "LF only");
});

test("readJournal round-trips the head, the revisions and the refusals", () => {
  const { text, snapshots } = run();
  const journal = readJournal(text);
  assert.deepEqual(journal.diagnostics, []);
  assert.deepEqual(journal.meta, meta);
  assert.deepEqual(journal.snapshots, snapshots);
  assert.deepEqual(journal.refusals, [{ n: 1, rev: 1, at: T0, tool: "move", call: "call_02", reason: "no transition intake→done", diagnostics: [] }]);
  assert.deepEqual(verifyJournal(journal, sc), []);
});

test("a written file is a #wrote-N block: read back in order, listed in the Markdown export, and outside the hash chain", () => {
  const { text } = run();
  const more = text + renderWroteBlock({ n: 1, rev: 1, at: T0, tool: "Edit", call: "c9", path: "src/a.ts" }) + renderWroteBlock({ n: 2, rev: 1, at: T0, tool: "Write", path: "docs/b.md" });
  const journal = readJournal(more);
  assert.deepEqual(journal.diagnostics, []);
  assert.deepEqual(journal.writes, [{ n: 1, rev: 1, at: T0, tool: "Edit", call: "c9", path: "src/a.ts" }, { n: 2, rev: 1, at: T0, tool: "Write", path: "docs/b.md" }]);
  assert.deepEqual(verifyJournal(journal, sc), []);
  assert.match(renderJournalMarkdown(journal), /## Written\n\n- rev 1 · Edit \(c9\): src\/a\.ts\n- rev 1 · Write: docs\/b\.md/);
  assert.deepEqual(readJournal(text).writes, []);
});

test("verifyJournal: a tampered value, a broken parent, a transition the workflow does not have, a rollback of a later revision", () => {
  const { text } = run();
  assert.match(verifyJournal(readJournal(text.replace('"amount":120', '"amount":999'))).join("\n"), /#rev-1: hash does not match/);
  const j = readJournal(text);
  const broken = { ...j, snapshots: j.snapshots.map((s) => (s.rev === 2 ? { ...s, parent: "sha256:0" } : s)) };
  assert.match(verifyJournal(broken).join("\n"), /#rev-2: parent does not equal the previous hash/);
  const other = loadStatechart(twoStates(), "t").statechart;
  assert.match(verifyJournal(j, other).join("\n"), /#rev-0: state intake is not in the statechart/);
  const s = j.snapshots[2];
  const teleport = { ...s, from: "pay" };
  const forged = { ...j, snapshots: [j.snapshots[0], j.snapshots[1], { ...teleport, hash: hashSnapshot(teleport) }] };
  assert.match(verifyJournal(forged, sc).join("\n"), /#rev-2: no transition pay→review in the statechart/);
  assert.match(verifyJournal({ ...j, snapshots: [] }).join("\n"), /holds no revision/);
});

test("evidence revisions: by=signal needs the variable's name, and the name must be a variable with a source", () => {
  const ev = loadStatechart(twoStates({ b: { tools: ["test"] }, vars: { t: { default: false, source: { tool: "test" } } } }), "ev").statechart;
  const s0 = initialSnapshot(ev, T0);
  const s1 = applySignal(ev, s0, "t", true, { at: T0 }, "tree-1").next;
  const j = readJournal(renderJournalHead({ ...meta, workflowHash: ev.hash }) + renderSnapshotBlock(s0) + renderSnapshotBlock(s1));
  assert.deepEqual(j.snapshots[1], s1);
  assert.equal(j.snapshots[1].tree, "tree-1");
  assert.deepEqual(verifyJournal(j, ev), []);
  const nameless = { ...s1, signal: undefined };
  delete nameless.signal;
  assert.match(verifyJournal({ ...j, snapshots: [s0, { ...nameless, hash: hashSnapshot(nameless) }] }).join("\n"), /by=signal needs signal/);
  const wrong = { ...s1, signal: "nope" };
  assert.match(verifyJournal({ ...j, snapshots: [s0, { ...wrong, hash: hashSnapshot(wrong) }] }, ev).join("\n"), /signal nope is not a variable with a source/);
});

test("a malformed block is a diagnostic, not a crash; unrelated data blocks are ignored", () => {
  const { text } = run();
  const j = readJournal(text + '=== data {#rev-4 format=json}\n{"rev":4}\n===\n\n=== data {#notes format=json}\n{"x":1}\n===\n\n=== data {#refused-2 format=json}\n[1]\n===\n');
  assert.deepEqual(j.diagnostics, ["#rev-4: missing or malformed fields", "#refused-2: not a JSON object"]);
  assert.equal(j.snapshots.length, 4);
});

test("verifyJournal: a pause or resume is by=human, keeps the state and the variables, and holds a free item or releases a held one", () => {
  const { text, snapshots } = run();
  const last = snapshots.at(-1);
  const held = applyHold(sc, snapshots, true, { at: T0 }).next;
  const released = applyHold(sc, [...snapshots, held], false, { at: T0 }).next;
  const clean = text + renderSnapshotBlock(held) + renderSnapshotBlock(released);
  assert.deepEqual(verifyJournal(readJournal(clean), sc), []);
  const forged = (over) => {
    const s = { ...held, ...over };
    return readJournal(text + renderSnapshotBlock({ ...s, hash: hashSnapshot(s) }));
  };
  assert.deepEqual(verifyJournal(forged({ by: "model" }), sc), ["#rev-4: cause pause needs by=human"]);
  assert.deepEqual(verifyJournal(forged({ vars: { ...last.vars, amount: 999 } }), sc), ["#rev-4: cause pause keeps the state and the variables"]);
  assert.deepEqual(verifyJournal(forged({ cause: "resume" }), sc), ["#rev-4: resume while the work item is not paused"]);
  const again = applyHold(sc, [...snapshots, held, released], true, { at: T0 }).next;
  const double = { ...again, rev: 7, parent: again.hash };
  const doubled = readJournal(clean + renderSnapshotBlock(again) + renderSnapshotBlock({ ...double, hash: hashSnapshot(double) }));
  assert.deepEqual(verifyJournal(doubled, sc), ["#rev-7: pause while the work item is already paused"]);
});
