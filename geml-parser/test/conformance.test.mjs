// Conformance suite, run against the reference parser. The case files and
// manifest.json are the normative reference — a second, independent GEML
// implementation conforms when it reproduces every case its capabilities
// reach. The loop is conformance/_runner.mjs; this file supplies the reference
// parser's answers for each capability. Run with `npm test` (after `tsc`).
import { parse, addressedUnits, CATALOGUE_EXEMPT } from "../dist/geml.js";
import { shortestAddress } from "../dist/selector.js";
import { runConformance, manifest } from "./conformance/_runner.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// The README's file table and the manifest list one set of files: a case file
// the table leaves out is undocumented, and one the manifest leaves out never runs.
const readme = readFileSync(join(here, "conformance", "README.md"), "utf8");
const documented = [...readme.matchAll(/^\| `([a-z]+\.json)` \|/gm)].map((m) => m[1]).sort();
const listed = manifest.files.map((f) => f.file).sort();
if (JSON.stringify(documented) !== JSON.stringify(listed)) {
  console.error(`README table lists ${JSON.stringify(documented)}\nmanifest lists     ${JSON.stringify(listed)}`);
  process.exit(1);
}

const catalogued = (d) => !CATALOGUE_EXEMPT.some((p) => d.code.startsWith(p));

// `host` (README): the tree's root is the resolution root, a path resolves
// against the naming document's directory and then the root (§3.3), and a path
// that leaves the tree reads nothing (§9.4). `resolveDoc` takes paths relative to
// the parsed document's directory, as the CLI's resolver does.
const treePath = (p) => {
  const out = [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") { if (out.length === 0) return null; out.pop(); } else out.push(s);
  }
  return out.join("/");
};
function parseIn(files, main) {
  const cut = main.lastIndexOf("/");
  const dir = cut < 0 ? "" : main.slice(0, cut);
  const read = (p) => (p !== null && Object.hasOwn(files, p) ? files[p] : null);
  const resolveDoc = (d) => read(treePath(dir === "" ? d : `${dir}/${d}`)) ?? read(treePath(d));
  return parse(files[main], { self: main.slice(cut + 1), resolveDoc, docExists: (d) => resolveDoc(d) !== null });
}

const ok = runConformance({
  label: "conformance",
  has: new Set(Object.keys(manifest.capabilities)),
  parse,
  parseIn,
  // What `readFileSync(file, "utf8")` does, which is how the CLI reads a document.
  decode: (bytes) => Buffer.from(bytes).toString("utf8"),
  ids: (doc) => doc.ids,
  // What `geml list` prints, less the CLI's own content addresses (`@…`,
  // `=== type…`), which no specification defines.
  addresses: (text) => {
    const all = addressedUnits(text);
    return all.map((a) => shortestAddress(a, all)).filter((s) => s.startsWith("#"));
  },
  diagnostics: (doc) => doc.diagnostics.filter(catalogued).map((d) => `${d.code}:${d.severity}`),
});
if (!ok) process.exit(1);
