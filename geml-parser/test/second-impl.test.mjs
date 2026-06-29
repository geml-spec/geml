// Acceptance test for GEML-spec §8: a SECOND, INDEPENDENT implementation
// (conformance/impl2.mjs, written only from the spec, importing none of the
// reference parser) must reproduce every conformance case. If the two parsers
// agree across the whole suite, the spec is precise enough that conforming
// implementations cannot diverge on these rules. Run with `npm test`.
import { parse2 } from "./conformance/impl2.mjs";
import { project } from "./conformance/_project.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const files = ["inline.json", "precedence.json", "lists.json"];

let pass = 0;
let fail = 0;
for (const file of files) {
  const cases = JSON.parse(readFileSync(join(here, "conformance", file), "utf8"));
  for (const c of cases) {
    const got = project(parse2(c.geml));
    if (got === c.want) {
      pass++;
    } else {
      fail++;
      console.error(`DISAGREE [${file}] ${c.name}`);
      console.error(`  geml: ${JSON.stringify(c.geml)}`);
      console.error(`  ref:  ${c.want}`);
      console.error(`  2nd:  ${got}`);
    }
  }
}

console.log(`\nsecond implementation: ${pass} case(s) agree with the reference${fail ? `, ${fail} DISAGREE` : ""}.`);
if (fail) process.exit(1);
