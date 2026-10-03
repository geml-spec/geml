// The one loop every conformance harness runs. It reads manifest.json, runs
// each case file whose `requires` the implementation has, and checks a case's
// `want` and each optional field the implementation can observe:
//
//   want          project(doc) — always
//   ids           the document's block ids, declared and derived, in order
//   addresses     the `#…` addresses a listing of the document gives, in order
//   blocks        blocksOf(doc) — the block tree (_project.mjs)
//   diagnostics   the `code:severity` of each catalogued diagnostic, a multiset
//
// A case of a file that needs `host` gives `files` (root-relative path ->
// content) and `main` instead of `geml`; the implementation parses `main`
// through a host over that tree (README, "host").
//
// A case whose input is `geml_base64` (bytes, for §0.1's decoding) runs only
// where the implementation has `bytes`. An implementation in another language
// reads the same manifest and case files with a harness of its own; this file
// is the reference for what that harness checks.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { project, blocksOf } from "./_project.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));

/**
 * @param impl {
 *   label: string,                 // what the summary line calls this implementation
 *   has: Set<string>,              // its capabilities (manifest.capabilities)
 *   parse(text): Document,         // the document model _project.mjs reads
 *   parseIn?(files, main): Document, // `host`: `main` read through a host over `files`
 *   decode?(bytes): string,        // `bytes`: its own UTF-8 reading of a file
 *   ids?(doc): string[],           // `ids`
 *   addresses?(text): string[],    // `addresses`
 *   diagnostics?(doc): string[],   // `diagnostics`: "code:severity" each
 * }
 */
export function runConformance(impl) {
  const can = (field) => impl.has.has(manifest.fields[field]);
  let pass = 0;
  let fail = 0;
  const skipped = [];
  for (const { file, requires } of manifest.files) {
    const missing = requires.filter((r) => !impl.has.has(r));
    if (missing.length) { skipped.push(`${file} (needs ${missing.join(", ")})`); continue; }
    const cases = JSON.parse(readFileSync(join(here, file), "utf8"));
    let skippedHere = 0;
    for (const c of cases) {
      if (c.geml_base64 !== undefined && !can("geml_base64")) { skippedHere++; continue; }
      const text = c.files !== undefined ? c.files[c.main] : c.geml_base64 !== undefined ? impl.decode(Buffer.from(c.geml_base64, "base64")) : c.geml;
      const doc = c.files !== undefined ? impl.parseIn(c.files, c.main) : impl.parse(text);
      const wrong = [];
      const check = (what, want, got) => { if (want !== got) wrong.push([what, want, got]); };
      check("want", c.want, project(doc));
      if (c.ids !== undefined && can("ids")) check("ids", JSON.stringify(c.ids), JSON.stringify(impl.ids(doc)));
      if (c.addresses !== undefined && can("addresses")) check("addresses", JSON.stringify(c.addresses), JSON.stringify(impl.addresses(text)));
      if (c.blocks !== undefined && can("blocks")) check("blocks", c.blocks, blocksOf(doc));
      if (c.diagnostics !== undefined && can("diagnostics")) {
        check("diagnostics", JSON.stringify([...c.diagnostics].sort()), JSON.stringify([...impl.diagnostics(doc)].sort()));
      }
      if (wrong.length === 0) { pass++; continue; }
      fail++;
      console.error(`FAIL [${file}] ${c.name}`);
      console.error(`  geml: ${JSON.stringify(text)}`);
      for (const [what, want, got] of wrong) {
        console.error(`  ${what} want: ${want}`);
        console.error(`  ${what} got:  ${got}`);
      }
    }
    if (skippedHere) skipped.push(`${skippedHere} case(s) of ${file} (needs ${manifest.fields.geml_base64})`);
  }
  console.log(`\n${impl.label}: ${pass} case(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
  if (skipped.length) console.log(`  skipped: ${skipped.join("; ")}`);
  return fail === 0;
}
