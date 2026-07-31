// Security regressions for transclusion and inline projection.
//
// The functional suites (embed / inline-project / table-src) pin what the feature
// DOES. These pin what it must never do, and two of them need a bound — input size
// against output size, or wall clock — which no functional test would express.
//
// Every case here comes from a confirmed finding with a repro, not a hypothesis.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "geml.js");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const ws = () => mkdtempSync(join(tmpdir(), "geml-sec-embed-"));
const cli = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args],
  { cwd: dir, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });

// ---------------------------------------------------------------------------
// §9.5 — an unsafe scheme must not become a navigable target
// ---------------------------------------------------------------------------

for (const bad of [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(2)",
  "data:text/html,<script>alert(3)</script>",
  "vbscript:msgbox(4)",
]) {
  test(`an embed src of \`${bad.slice(0, 22)}…\` never reaches an href`, () => {
    const dir = ws();
    writeFileSync(join(dir, "host.geml"), `=== embed {src=${bad}}\n===\n`);
    const chk = cli(dir, "check", "host.geml");
    assert.equal(chk.status, 1, "§9.5 requires this refused when the model is built");
    const html = cli(dir, "host.geml", "--to", "html");
    assert.doesNotMatch(html.stdout, /href="\s*(javascript|data|vbscript)/i,
      "an unsafe scheme must not survive into the page");
  });
}

test("an unsafe scheme is refused even when it arrives through borrowed content", () => {
  // The host's own check used to pass: a nested embed inside borrowed content was
  // only ever gathered for cycle detection, never validated. A CI gate that checks
  // the entry document would have shipped the payload.
  const dir = ws();
  writeFileSync(join(dir, "lib.geml"),
    "# Shared {#shared}\n\nTrusted-looking prose.\n\n=== embed {src=javascript:alert(1)}\n===\n");
  writeFileSync(join(dir, "host.geml"), "=== embed {src=lib.geml#shared}\n===\n");
  const html = cli(dir, "host.geml", "--to", "html");
  assert.doesNotMatch(html.stdout, /href="javascript:/i, "the page is the boundary that matters");
});

test("an unsafe scheme in an inline projection never reaches an href", () => {
  const dir = ws();
  writeFileSync(join(dir, "host.geml"), "see ![[javascript:alert(1)#x]] here\n");
  const html = cli(dir, "host.geml", "--to", "html");
  assert.doesNotMatch(html.stdout, /href="javascript:/i);
});

// ---------------------------------------------------------------------------
// Amplification — cycles and depth bound the SHAPE, not the total
// ---------------------------------------------------------------------------

// One document, eight sections, each holding N embeds of the next. No cycle, and
// depth is 8 — so neither the cycle stack nor EMBED_DEPTH_CAP applies. Before the
// budget, N=4 turned 866 bytes into 4.3MB and N=11 crashed the process with an
// uncaught RangeError.
function fanOut(n, levels = 8) {
  const out = ["=== embed {src=#s1}", "===", ""];
  for (let k = 1; k <= levels; k++) {
    out.push(`## S${k} {#s${k}}`, "");
    if (k < levels) for (let j = 0; j < n; j++) out.push(`=== embed {src=#s${k + 1}}`, "===", "");
    else out.push("leaf", "");
  }
  return out.join("\n");
}

test("a fan-out that is not a cycle cannot amplify without bound", () => {
  const dir = ws();
  const src = fanOut(4);
  writeFileSync(join(dir, "host.geml"), src);
  const r = cli(dir, "host.geml", "--to", "html");
  assert.notEqual(r.status, null, "the renderer must not be killed by its own output");
  // A bound, not an exact size: the point is that output stays proportional to
  // input rather than exponential in the fan-out.
  const ratio = r.stdout.length / src.length;
  // A ratio, not a clock: it is machine-independent, and it is the actual property
  // — output proportional to input rather than exponential in the fan-out.
  assert.ok(ratio < 200, `output/input ratio ${Math.round(ratio)}x — the budget is not holding`);
  assert.match(r.stdout, /transclusion/, "what did expand is still there");
});

test("an exhausted budget is reported, not silently truncated", () => {
  const dir = ws();
  writeFileSync(join(dir, "host.geml"), fanOut(6));
  const r = cli(dir, "host.geml", "--to", "html");
  assert.match(r.stdout, /too-large|budget|too many/i, "a reader has to be able to tell output was cut");
});

test("an inline projection fan-out is bounded too", () => {
  const dir = ws();
  const lines = ["=== text {#p1}", "x " + "![[#p2]] ".repeat(6), "==="];
  for (let k = 2; k <= 8; k++) {
    lines.push(`=== text {#p${k}}`, k < 8 ? "y " + `![[#p${k + 1}]] `.repeat(6) : "leaf", "===");
  }
  lines.push("", "start ![[#p1]] end");
  const src = lines.join("\n");
  writeFileSync(join(dir, "host.geml"), src);
  const r = cli(dir, "host.geml", "--to", "html");
  assert.notEqual(r.status, null);
  assert.ok(r.stdout.length / src.length < 200, "projection shares the block form's budget");
});

// ---------------------------------------------------------------------------
// `check` must stay cheap — it is the CI gate and the MCP write validator
// ---------------------------------------------------------------------------

test("cycle detection is linear in the graph, not in its paths", () => {
  // A chain where each document embeds the next three times: 21 files, ~2KB, and
  // the path-enumerating walk took over two minutes. It has to explore edges once.
  //
  // Measured against a BASELINE rather than a clock: the same corpus with a single
  // edge per hop is unambiguously linear, so the ratio between them is the property
  // under test and it does not depend on how fast or how loaded the machine is. An
  // absolute threshold here would fail on a slow CI runner for reasons that have
  // nothing to do with the traversal.
  const build = (dir, fanout) => {
    const files = 21;
    for (let k = 0; k < files; k++) {
      const body = k < files - 1
        ? Array.from({ length: fanout }, () => `=== embed {src=d${k + 1}.geml#d${k + 1}}\n===\n`).join("\n")
        : "leaf\n";
      writeFileSync(join(dir, `d${k}.geml`), `## D${k} {#d${k}}\n\n${body}`);
    }
    writeFileSync(join(dir, "host.geml"), "=== embed {src=d0.geml#d0}\n===\n");
  };
  const timeCheck = (fanout) => {
    const dir = ws();
    build(dir, fanout);
    const started = process.hrtime.bigint();
    const r = cli(dir, "check", "host.geml");
    assert.notEqual(r.status, null, "check must terminate");
    return Number(process.hrtime.bigint() - started) / 1e6; // ms
  };
  const linear = timeCheck(1);
  const fanned = timeCheck(3);
  // Process startup dominates at this size, so allow generous slack; what this
  // rules out is the 3^20 blow-up, which is orders of magnitude, not a factor.
  assert.ok(fanned < linear * 8 + 2000,
    `fan-out 3 took ${fanned.toFixed(0)}ms against ${linear.toFixed(0)}ms for a linear chain`);
});

// ---------------------------------------------------------------------------
// Borrowed content must not capture the host's anchors
// ---------------------------------------------------------------------------

test("a footnote reference in borrowed content does not land on the host's footnote", () => {
  const dir = ws();
  writeFileSync(join(dir, "src.geml"),
    "=== text {#borrowed}\nBorrowed prose[^n1]\n===\n\n[^n1]: BORROWED definition.\n");
  writeFileSync(join(dir, "host.geml"),
    "=== embed {src=src.geml#borrowed}\n===\n\n[^n1]: HOST definition.\n");
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  const inside = /class="transclusion"[\s\S]*?<\/section>/.exec(r.stdout)?.[0] ?? "";
  assert.doesNotMatch(inside, /href="#n1"/,
    "a bare fragment lets the host choose what a borrowed citation says");
  assert.match(inside, /src\.html#n1/, "it points at the document the phrase came from");
});

// ---------------------------------------------------------------------------
// A loaded document is not unbounded
// ---------------------------------------------------------------------------

test("an oversized target is refused rather than expanded", () => {
  const dir = ws();
  // The cap is 4MB, so 5MB proves it without writing 12MB on every CI run.
  writeFileSync(join(dir, "big.geml"), "=== text {#b}\n" + "x".repeat(5 * 1024 * 1024) + "\n===\n");
  writeFileSync(join(dir, "host.geml"), "=== embed {src=big.geml#b}\n===\n");
  const r = cli(dir, "host.geml", "--to", "html");
  assert.ok(r.stdout.length < 4 * 1024 * 1024, `emitted ${r.stdout.length} bytes`);
  assert.match(r.stdout + r.stderr, /too large|size/i, "the refusal has to say why");
});

test("control characters from a target never reach the page raw", () => {
  // NUL is already normalised to U+FFFD by §0.4; these are the ones that are not.
  const c0 = String.fromCharCode(11) + String.fromCharCode(27) + String.fromCharCode(12);
  const dir = ws();
  writeFileSync(join(dir, "ctrl.geml"), `=== text {#c}
before${c0}after
===
`);
  writeFileSync(join(dir, "host.geml"), "=== embed {src=ctrl.geml#c}\n===\n");
  const r = cli(dir, "host.geml", "--to", "html");
  const raw = new RegExp("[" + c0 + "]");
  assert.doesNotMatch(r.stdout, raw, "raw C0 bytes desynchronize a downstream sanitizer or proxy");
});

console.log(`${passed} test(s) passed.`);
