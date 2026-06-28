// Conformance suite: input GEML -> a normalized projection of the document model
// (see conformance/_project.mjs for the projection grammar). The case files are
// the normative reference — a second, independent GEML implementation conforms
// when it reproduces every `want`. Run with `npm test` (after `tsc`).
import { parse } from "../dist/geml.js";
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
    const got = project(parse(c.geml));
    if (got === c.want) {
      pass++;
    } else {
      fail++;
      console.error(`FAIL [${file}] ${c.name}`);
      console.error(`  geml: ${JSON.stringify(c.geml)}`);
      console.error(`  want: ${c.want}`);
      console.error(`  got:  ${got}`);
    }
  }
}

console.log(`\nconformance: ${pass} case(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
if (fail) process.exit(1);
