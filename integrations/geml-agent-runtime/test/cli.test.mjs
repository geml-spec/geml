import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStatechart } from "../dist/core/statechart.js";
import { initialSnapshot, applyPatch, applyTransition } from "../dist/core/snapshot.js";
import { renderLedgerHead, renderSnapshotBlock } from "../dist/core/ledger.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FIX = fileURLToPath(new URL("./fixtures/refund.geml", import.meta.url));
function run(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const ws = () => mkdtempSync(join(tmpdir(), "geml-agent-"));

test("no verb prints usage and exits 2", () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: geml-agent <check\|snapshot\|verify\|export\|init\|run>/);
});

test("check: clean statechart exits 0 and says so", () => {
  const r = run(["check", FIX]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /ok: no diagnostics/);
});

test("check: errors exit 1 with code-tagged lines; --tools adds unknown-tool warnings", () => {
  const dir = ws();
  writeFileSync(join(dir, "bad.geml"), '=== meta\nprofile = "geml-agent/v1"\n===\n=== agent-state {#a final}\nx\n===\n');
  const r = run(["check", "bad.geml"], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /^error: agent-no-initial: no state carries `initial` \(line 1\)$/m);
  assert.match(r.err, /1 error\(s\), 0 warning\(s\)/);
  const w = run(["check", FIX, "--tools", "read_file,grep"]);
  assert.equal(w.code, 0);
  assert.match(w.err, /warning: agent-unknown-tool: state #pay: tool "pay_refund" is not registered/);
  rmSync(dir, { recursive: true, force: true });
});

function ledgerIn(dir) {
  const sc = loadStatechart(readFileSync(FIX, "utf8"), "refund.geml").statechart;
  const T0 = "2026-09-14T12:00:00Z";
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyPatch(sc, s0, { order: "A-17", amount: 120 }, { at: T0, call: "call_01" }).next;
  const s2 = applyTransition(sc, s1, "review", { at: T0, call: "call_02" }).next;
  const text = renderLedgerHead({ session: "s1", statechart: FIX, statechartHash: sc.hash, created: T0 })
    + renderSnapshotBlock(s0) + renderSnapshotBlock(s1) + renderSnapshotBlock(s2);
  writeFileSync(join(dir, "ledger.geml"), text);
  return { s2 };
}

test("snapshot prints the last revision, --json gives the object", () => {
  const dir = ws();
  const { s2 } = ledgerIn(dir);
  const r = run(["snapshot", "ledger.geml"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^rev 2 · state #review · cause transition · from #intake/m);
  const j = run(["snapshot", "ledger.geml", "--json"], dir);
  assert.deepEqual(JSON.parse(j.out), s2);
  rmSync(dir, { recursive: true, force: true });
});

test("verify: clean chain exits 0; a tampered one exits 1 listing the errors", () => {
  const dir = ws();
  ledgerIn(dir);
  assert.equal(run(["verify", "ledger.geml", "--statechart", FIX], dir).code, 0);
  const p = join(dir, "ledger.geml");
  writeFileSync(p, readFileSync(p, "utf8").replace('"amount":120', '"amount":1'));
  const r = run(["verify", "ledger.geml"], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /#rev-1: hash does not match its content/);
  rmSync(dir, { recursive: true, force: true });
});

test("a flag with no value is a usage error, not a silently weaker run", () => {
  const dir = ws();
  ledgerIn(dir);
  const v = run(["verify", "ledger.geml", "--statechart"], dir);
  assert.equal(v.code, 2);
  assert.match(v.err, /--statechart needs a value/);
  const t = run(["check", FIX, "--tools"]);
  assert.equal(t.code, 2);
  assert.match(t.err, /--tools needs a value/);
  rmSync(dir, { recursive: true, force: true });
});

test("export --to md renders a revision table with per-step diffs", () => {
  const dir = ws();
  ledgerIn(dir);
  const r = run(["export", "ledger.geml", "--to", "md"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\| rev \| at \| cause \| state \| call \| changes \|$/m);
  assert.match(r.out, /\| 1 \| 2026-09-14T12:00:00Z \| patch \| #intake \| call_01 \| amount: 0 → 120; order: ∅ → "A-17" \|/);
  assert.match(r.out, /\| 2 \| .* \| transition \| #review \| call_02 \| — \|/);
  rmSync(dir, { recursive: true, force: true });
});

test("init writes the coding workflow into .geml/ and refuses to overwrite", () => {
  const dir = ws();
  const r = run(["init"], dir);
  assert.equal(r.code, 0, r.err);
  // Under .geml/, not at the repo root: a project root is contested space.
  assert.equal(existsSync(join(dir, "agent.geml")), false, "nothing lands at the root");
  const written = readFileSync(join(dir, ".geml", "agent.geml"), "utf8");
  const shipped = fileURLToPath(new URL("../examples/coding/agent.geml", import.meta.url));
  assert.equal(written, readFileSync(shipped, "utf8").replace(/\r\n/g, "\n"));
  // What a repository gets: the four claims the workflow is there to make.
  assert.match(written, /#explore/);
  assert.match(written, /#implement/);
  assert.equal(run(["check", ".geml/agent.geml"], dir).code, 0);
  const again = run(["init"], dir);
  assert.equal(again.code, 1);
  assert.match(again.err, /already exists/);
  rmSync(dir, { recursive: true, force: true });
});

test("init --template refund writes the other one, and an unknown template is a usage error", () => {
  const dir = ws();
  assert.equal(run(["init", "--template", "refund"], dir).code, 0);
  const shipped = fileURLToPath(new URL("../examples/refund/agent.geml", import.meta.url));
  assert.equal(readFileSync(join(dir, ".geml", "agent.geml"), "utf8"), readFileSync(shipped, "utf8").replace(/\r\n/g, "\n"));

  const bad = run(["init", "--template", "nonsense"], ws());
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown template "nonsense"/);
  rmSync(dir, { recursive: true, force: true });
});

test("a missing file is one clean line and exit 1, not a stack trace", () => {
  for (const verb of ["check", "snapshot", "verify"]) {
    const r = run([verb, "no-such-file.geml"]);
    assert.equal(r.code, 1, `${verb}: exit code`);
    assert.match(r.err, /^geml-agent: cannot read .*no-such-file\.geml \(ENOENT\)$/m, `${verb}: message`);
    assert.doesNotMatch(r.err, /\n\s+at /, `${verb}: no stack trace`);
  }
  const e = run(["export", "no-such-file.geml", "--to", "md"]);
  assert.equal(e.code, 1);
  assert.match(e.err, /cannot read .*no-such-file\.geml \(ENOENT\)/);
});

test("run without a task is a usage error, and the verb is listed", () => {
  const r = run(["run"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: geml-agent <check\|snapshot\|verify\|export\|init\|run>/);
  assert.match(r.err, /run \[--profile name\] <task>/);
});
