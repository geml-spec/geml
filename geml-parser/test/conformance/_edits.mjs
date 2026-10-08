// The one loop every `edits` harness runs (spec §8.2(10), §8.4). It reads the
// `edits` list of manifest.json and, for each case, hands the implementation
// the input document and one operation, then compares what came back with
// `want`:
//
//   want.text          the rewritten document, byte for byte
//   want.output        what the operation printed (get, to)
//   want.projection    `to json`: the output, read as the document model, through
//                      _project.mjs's `project` — what a parse case's `want` holds;
//                      the model's JSON layout is each implementation's own
//   want.blocks        the same model's block tree (`blocksOf`), as a parse case's
//                      `blocks`
//   want.rows          what `list` reported, as JSON
//   want.hits          what `find` reported, as JSON
//   want.diagnostics   `check`: each diagnostic as `code:severity`, compared as a multiset
//   want.refused       the operation wrote nothing, and said why with this
//                      Appendix A.6 code; `want.diagnostics` beside it is the
//                      result's own diagnostics a `broken-result` carries
//   want.unchanged     `revert`: the unit already matches; nothing to write
//
// An implementation supplies `run(c)` returning the same shape it would be
// compared against — `{ text }`, `{ output }`, `{ rows }`, `{ hits }`,
// `{ diagnostics }`, `{ refused, diagnostics? }` or `{ unchanged: true }` —
// and `label`, and may supply `has`, the set of capabilities it declares: a
// file whose `requires` it does not meet — `edits-markdown.json` needs the
// optional `markdown` — is listed as skipped, as `_runner.mjs` lists the parse
// files. Without `has`, every capability is assumed. Like `_runner.mjs`, this
// file knows nothing about any parser;
// the reference's adapter is `_edits-impl.mjs`, and a second implementation
// reads the same manifest and case files with a harness of its own.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blocksOf, project } from "./_project.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));

const multiset = (xs) => JSON.stringify([...xs].sort());

/** Compare one outcome with its case's `want`; the list of [what, want, got] that differ. */
export function compareOutcome(want, got) {
  const wrong = [];
  const check = (what, w, g) => { if (w !== g) wrong.push([what, w, g]); };
  if (want.refused !== undefined) {
    check("refused", want.refused, got.refused ?? `(not refused: ${Object.keys(got).join(",")})`);
    if (want.diagnostics !== undefined) check("diagnostics", multiset(want.diagnostics), multiset(got.diagnostics ?? []));
    return wrong;
  }
  if (got.refused !== undefined) {
    wrong.push(["refused", "(a result)", `${got.refused}: ${got.message ?? ""}`]);
    return wrong;
  }
  if (want.unchanged !== undefined) check("unchanged", want.unchanged, got.unchanged ?? false);
  if (want.text !== undefined) check("text", want.text, got.text);
  if (want.output !== undefined) check("output", want.output, got.output);
  if (want.projection !== undefined || want.blocks !== undefined) {
    let model;
    try { model = JSON.parse(got.output); } catch { /* not JSON: reported below */ }
    if (!Array.isArray(model?.children)) wrong.push(["output", "(a document model, as JSON)", got.output]);
    else {
      if (want.projection !== undefined) check("projection", want.projection, project(model));
      if (want.blocks !== undefined) check("blocks", want.blocks, blocksOf(model));
    }
  }
  if (want.rows !== undefined) check("rows", JSON.stringify(want.rows), JSON.stringify(got.rows));
  if (want.hits !== undefined) check("hits", JSON.stringify(want.hits), JSON.stringify(got.hits));
  if (want.diagnostics !== undefined) check("diagnostics", multiset(want.diagnostics), multiset(got.diagnostics ?? []));
  return wrong;
}

export function runEdits(impl) {
  let pass = 0;
  let fail = 0;
  // An implementation that cannot run a case yet answers `{ unsupported }`:
  // counted and listed, never passed — as `_runner.mjs` lists the files an
  // implementation's capabilities do not reach.
  const skipped = [];
  const has = impl.has ?? new Set(Object.keys(manifest.capabilities));
  for (const { file, requires = [] } of manifest.edits) {
    const missing = requires.filter((r) => !has.has(r));
    if (missing.length) {
      skipped.push(`[${file}] — needs ${missing.join(", ")}`);
      continue;
    }
    const cases = JSON.parse(readFileSync(join(here, file), "utf8"));
    for (const c of cases) {
      let got;
      try { got = impl.run(c); }
      catch (e) { got = { refused: "(threw)", message: String(e?.stack ?? e) }; }
      if (got.unsupported !== undefined) { skipped.push(`[${file}] ${c.name} — ${got.unsupported}`); continue; }
      const wrong = compareOutcome(c.want, got);
      if (wrong.length === 0) { pass++; continue; }
      fail++;
      console.error(`FAIL [${file}] ${c.name}`);
      console.error(`  op: ${JSON.stringify(c.op)}`);
      for (const [what, want, got] of wrong) {
        console.error(`  ${what} want: ${JSON.stringify(want)}`);
        console.error(`  ${what} got:  ${JSON.stringify(got)}`);
      }
    }
  }
  console.log(`\n${impl.label}: ${pass} edit case(s) passed${fail ? `, ${fail} FAILED` : ""}${skipped.length ? `, ${skipped.length} skipped` : ""}.`);
  for (const s of skipped) console.log(`  skipped ${s}`);
  return fail === 0;
}
