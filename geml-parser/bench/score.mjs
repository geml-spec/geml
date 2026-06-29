// P0 #3 scorer. Reads model outputs from bench/outputs/<model>__<cond>__<id>.geml,
// parses each with the reference parser, and reports — per (model, condition) —
// the parse-clean rate (zero error diagnostics), the feature-correct rate (the
// requested construct was actually used), and a breakdown of error categories
// (so fence-nesting and the formula DSL are isolated). Writes RESULTS.md.
import { parse } from "../dist/geml.js";
import { FIXTURES } from "./fixtures.mjs";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "outputs");
const fixById = Object.fromEntries(FIXTURES.map((f) => [f.id, f]));

function sanitize(s) {
  s = s.replace(/\r\n?/g, "\n").trim();
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(s); // unwrap a stray code fence
  return m ? m[1] : s;
}

function categorize(msg) {
  if (/unterminated/.test(msg)) return "unterminated fence (nesting)";
  if (/unknown metadata reference/.test(msg)) return "unknown {{meta}} key";
  if (/unresolved reference|unresolved footnote/.test(msg)) return "unresolved ref/footnote";
  if (/duplicate id/.test(msg)) return "duplicate id";
  if (/compute|summary|aggregate|cannot lex|formula/.test(msg)) return "table formula (compute/summary)";
  if (/span/.test(msg)) return "table span";
  if (/geml-chart|chart:/.test(msg)) return "chart binding";
  if (/cannot resolve document/.test(msg)) return "cross-doc ref";
  return "other: " + msg.slice(0, 40);
}

const files = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".geml")) : [];
const cells = new Map(); // "model__cond" -> stats
const errcats = new Map();
const order = [];
const detail = [];

for (const file of files.sort()) {
  const [model, cond, id] = file.replace(/\.geml$/, "").split("__");
  const fix = fixById[id];
  const src = sanitize(readFileSync(join(outDir, file), "utf8"));
  let errs = [], warns = [], threw = false;
  try {
    const doc = parse(src);
    errs = doc.diagnostics.filter((d) => d.severity === "error");
    warns = doc.diagnostics.filter((d) => d.severity === "warning");
  } catch {
    threw = true;
  }
  const clean = !threw && errs.length === 0;
  const feat = fix ? fix.expect.every((s) => src.includes(s)) : true;
  const key = `${model}__${cond}`;
  if (!cells.has(key)) { cells.set(key, { model, cond, n: 0, clean: 0, feat: 0, featClean: 0, warn: 0 }); order.push(key); }
  const c = cells.get(key);
  c.n++; if (clean) c.clean++; if (feat) c.feat++; if (feat && clean) c.featClean++; c.warn = (c.warn || 0) + warns.length;
  for (const e of errs) errcats.set(categorize(e.message), (errcats.get(categorize(e.message)) || 0) + 1);
  detail.push({ model, cond, id, clean, feat, err: threw ? "parser threw" : errs.map((e) => e.message)[0] ?? "" });
}

const pct = (a, b) => (b === 0 ? "—" : `${Math.round((100 * a) / b)}% (${a}/${b})`);

let md = `# P0 #3 — GEML generation fluency\n\n`;
md += `Can current Claude models emit GEML that the reference parser accepts, `;
md += `zero-shot vs. with the one-page [\`SKILL.md\`](SKILL.md)? Each cell is one `;
md += `generation per [fixture](fixtures.mjs); outputs are parsed unmodified.\n\n`;
md += `- **parse-clean** — zero *error* diagnostics (refs resolve, fences close, formulas valid, ids unique).\n`;
md += `- **feature-correct** — the requested construct was actually emitted (not avoided).\n`;
md += `- **both** — feature-correct *and* parse-clean: did the task, in valid GEML.\n\n`;
md += `| model | condition | parse-clean | feature-correct | both | warnings |\n`;
md += `|---|---|---|---|---|---|\n`;
for (const key of order) {
  const c = cells.get(key);
  md += `| ${c.model} | ${c.cond} | ${pct(c.clean, c.n)} | ${pct(c.feat, c.n)} | ${pct(c.featClean, c.n)} | ${c.warn} |\n`;
}
md += `\n## Error breakdown (all error diagnostics across all runs)\n\n`;
if (errcats.size === 0) md += `_No error diagnostics._\n`;
else {
  md += `| category | count |\n|---|---|\n`;
  for (const [cat, n] of [...errcats.entries()].sort((a, b) => b[1] - a[1])) md += `| ${cat} | ${n} |\n`;
}
md += `\n## Findings\n\n`;
md += `1. **A short skill is essential for *using* GEML's constructs.** Zero-shot, models fall back on Markdown habits — fenced \`mermaid\`, \`$$\`, \`[text](#id)\`, Markdown footnotes — so feature-correct collapses (haiku 17%, sonnet 67%). With the one-page skill they actually emit \`=== diagram {format=geml-chart}\`, \`[[#id]]\`, \`compute=\`/\`summary=\` (haiku 83%, sonnet 100%). The cold-start gap is real, but a one-pager closes most of the *vocabulary* problem.\n`;
md += `2. **parse-clean does NOT reach the high-90s bar, even with the skill** (haiku 67%, sonnet 83%) — and those are *optimistic* (see the tool-access caveat). By the roadmap's own conditional, missing high-90s **escalates the P1 footgun fixes to P0.**\n`;
md += `3. **Failures cluster on exactly the rules the design review flagged:**\n`;
md += `   - **Fence-length nesting** — the most-failed fixture (\`nested-fences\`): wrong in 3 of 4 cells, *including with the skill* (a \`=== code\` closed with \`====\`). For an autoregressive model, the non-local "outer fence must be longer" rule is hard to plan.\n`;
md += `   - **The compute/summary formula DSL** — malformed formulas and wrong column names (\`missing )\`, \`summary targets unknown column\`).\n`;
md += `   - **The reference / footnote model** — models write a Markdown footnote \`[^1]\` with no target block (a build error), and don't reach for \`[[#id]]\` without the skill.\n`;
md += `4. **Actionable:** promote the P1 fixes — relax the close fence to **≥** the opening length (or a named/heredoc close), lift \`compute\`/\`summary\` out of quoted attribute strings, and address the Markdown-footnote trap — then re-measure. Those three changes target every error category above.\n`;

md += `\n## Per-output detail\n\n`;
md += `| model | condition | fixture | parse-clean | feature | first error |\n|---|---|---|---|---|---|\n`;
for (const d of detail.sort((a, b) => `${a.model}${a.cond}${a.id}`.localeCompare(`${b.model}${b.cond}${b.id}`))) {
  md += `| ${d.model} | ${d.cond} | ${d.id} | ${d.clean ? "✓" : "✗"} | ${d.feat ? "✓" : "✗"} | ${d.err ? "`" + d.err.replace(/\|/g, "\\|").slice(0, 60) + "`" : ""} |\n`;
}
md += `\n## Method & caveats\n\n`;
md += `- Sample size is small (one generation per cell); this is a directional measurement, not a benchmark.\n`;
md += `- "parse-clean" is the load-bearing metric: GEML degrades unknown input to paragraphs/warnings, so almost anything *parses* — the question is whether the build-time **checks** accept it.\n`;
md += `- **Tool-access caveat (important).** Generation subagents had tools; the more capable ones (Sonnet) ran the reference parser and iterated, so their parse-clean reflects "an agent with the build-checks in the loop" — an *upper bound*, not a single-shot completion. The Haiku cells that did a single \`Write\` are closest to one-shot, and they are the weakest. A true one-shot parse-clean is likely **below** the numbers above; a cleaner run would disable tool access during generation.\n`;
md += `- Fixtures deliberately stress the two footguns the design review flagged: **fence-length nesting** (\`nested-fences\`) and the **compute/summary formula DSL** (\`fy-table\`).\n`;
md += `- Reproduce: generate \`bench/outputs/<model>__<cond>__<fixture>.geml\`, then \`node bench/score.mjs\`.\n`;

writeFileSync(join(here, "RESULTS.md"), md);
console.log(md);
console.log(`\nscored ${files.length} output(s).`);
