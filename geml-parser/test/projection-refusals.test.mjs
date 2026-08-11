// What inline projection does when it CANNOT expand — §S7: never a silent gap.
//
// `inline-project.test.mjs` covers the expansions that work. These are the
// refusals, which were the renderer's largest untested cluster: an unreadable
// target, a target that is not inline content, a chain past the depth cap, a
// projection that would blow the byte budget, and a link inside a projected
// phrase carrying a dangerous scheme. Each has to leave a MARKED spot, because
// a reader cannot tell a missing quote from a quote of nothing.
//
// Driven through the CLI, as the sibling suite is: only the CLI supplies the
// document loader the renderer projects with.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "geml.js");
let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function ws(files) {
  const dir = mkdtempSync(join(tmpdir(), "geml-refuse-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const toHtml = (dir, file) => {
  const r = spawnSync(process.execPath, [CLI, file, "--to", "html"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
};

test("a target that cannot be read leaves a marked spot, not a gap", () => {
  const dir = ws({ "a.geml": "# A {#a}\n\nbefore ![[gone.geml#x]] after\n" });
  const r = toHtml(dir, "a.geml");
  assert.doesNotMatch(r.out, /before\s*after/, "the two halves did not close over an empty middle");
  assert.match(r.out, /gone\.geml/, "the target the author named is still visible");
  rmSync(dir, { recursive: true, force: true });
});

test("a target that is not inline content is refused as such", () => {
  // A table is a block, not a phrase; projecting one INLINE has no meaning, and
  // the refusal has to say that rather than emit half a table mid-sentence.
  const dir = ws({
    "src.geml": "# S {#s}\n\n=== table {#tbl}\n| a | b |\n| :- | :- |\n| 1 | 2 |\n===\n",
    "a.geml": "# A {#a}\n\nsee ![[src.geml#tbl]] inline\n",
  });
  const r = toHtml(dir, "a.geml");
  assert.doesNotMatch(r.out, /<table/, "a table did not appear inside a sentence");
  assert.match(r.out, /tbl|inline|transclusion/i);
  rmSync(dir, { recursive: true, force: true });
});

test("a chain past the depth cap stops, and the document says where", () => {
  const files = {};
  for (let i = 0; i < 12; i++) {
    files[`d${i}.geml`] = `# D${i} {#d${i}}\n\nlink ![[d${i + 1}.geml#d${i + 1}]]\n`;
  }
  files["d12.geml"] = "# D12 {#d12}\n\nthe end\n";
  const dir = ws(files);
  const r = toHtml(dir, "d0.geml");
  assert.ok(r.out.length < 200_000, "it terminated");
  assert.match(r.out, /depth|deep|transclusion/i, "and the stop is stated");
  rmSync(dir, { recursive: true, force: true });
});

test("a projection big enough to blow the byte budget is cut off, and says so", () => {
  const big = "x".repeat(120_000);
  const files = { "big.geml": `# B {#b}\n\n=== text {#huge}\n${big}\n===\n` };
  let a = "# A {#a}\n\n";
  for (let i = 0; i < 8; i++) a += `![[big.geml#huge]]\n\n`;
  files["a.geml"] = a;
  const dir = ws(files);
  const r = toHtml(dir, "a.geml");
  assert.match(r.out, /budget|transclusion/i, "the cut-off is visible in the document");
  rmSync(dir, { recursive: true, force: true });
});

test("a dangerous scheme inside a projected phrase is defused, and the phrase survives", () => {
  // The link comes from ANOTHER document, so it is content this document's
  // author never saw. It must arrive inert.
  const dir = ws({
    "src.geml": "# S {#s}\n\n=== text {#p}\nsee [click](javascript:alert(1)) now\n===\n",
    "a.geml": "# A {#a}\n\nquote: ![[src.geml#p]]\n",
  });
  const r = toHtml(dir, "a.geml");
  assert.doesNotMatch(r.out, /href="javascript:/i, "the scheme never reaches an href");
  assert.ok(!r.out.includes("alert(1)"), "and the payload is gone with it");
  rmSync(dir, { recursive: true, force: true });
});

test("a caption is rendered for a table and for a diagram", () => {
  const dir = ws({
    "a.geml": "# A {#a}\n\n=== table {#t caption=\"Quarterly totals\"}\n| a | b |\n| :- | :- |\n| 1 | 2 |\n===\n\n"
      + "=== diagram {#d format=mermaid caption=\"How it flows\"}\ngraph TD; A-->B;\n===\n",
  });
  const r = toHtml(dir, "a.geml");
  assert.match(r.out, /<figcaption>Quarterly totals<\/figcaption>/);
  assert.match(r.out, /<figcaption>How it flows<\/figcaption>/);
  rmSync(dir, { recursive: true, force: true });
});

console.log(`projection-refusals: ${passed} passed`);
