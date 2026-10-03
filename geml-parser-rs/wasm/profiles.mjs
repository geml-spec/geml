// The vocabularies through the WebAssembly build: each profile conformance
// file's cases in both readings (spec/profiles/*/conformance.json), the
// specification's history sidecar, and one call of each profile function.
//
//   wasm-pack build --target nodejs --out-dir wasm/pkg --release -- --features wasm
//   node wasm/profiles.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { strict as assert } from "node:assert";

const require = createRequire(import.meta.url);
const wasm = require("./pkg/geml.js");
const spec = new URL("../../spec/", import.meta.url);

const undeclared = (src) => src.split("\n").filter((l) => !l.trimStart().startsWith("profile")).join("\n") + "\n";
const reading = (src) => {
  const d = JSON.parse(wasm.parse(src));
  return { addresses: d.addresses, diagnostics: d.diagnostics.map((x) => `${x.code}:${x.severity}`).sort() };
};

let cases = 0;
let fails = 0;
for (const dir of readdirSync(new URL("profiles/", spec)).sort()) {
  const file = new URL(`profiles/${dir}/conformance.json`, spec);
  if (!existsSync(file)) continue;
  const f = JSON.parse(readFileSync(file, "utf8"));
  for (const c of f.cases) {
    const got = { declared: reading(c.geml), undeclared: reading(undeclared(c.geml)) };
    for (const r of ["declared", "undeclared"]) {
      for (const k of ["addresses", "diagnostics"]) {
        const want = k === "diagnostics" ? [...c[k][r]].sort() : c[k][r];
        try {
          assert.deepEqual(got[r][k], want);
        } catch {
          fails++;
          console.error(`[${f.profile}] ${c.name}: ${k}, ${r}: want ${JSON.stringify(want)} got ${JSON.stringify(got[r][k])}`);
        }
      }
    }
    cases++;
  }
}

// The view-model cases (`views`): the case's file tree through a host
// confined to it, the whole view model compared exactly and in order, the
// diagnostics as a multiset.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
let views = 0;
for (const dir of readdirSync(new URL("profiles/", spec)).sort()) {
  const file = new URL(`profiles/${dir}/conformance.json`, spec);
  if (!existsSync(file)) continue;
  for (const c of JSON.parse(readFileSync(file, "utf8")).views ?? []) {
    const vm = JSON.parse(wasm.styleCheck(JSON.stringify({ files: c.files, complete: true }), c.sheet, JSON.stringify(c.corpus), ""));
    try {
      for (const k of ["states", "screens", "frames", "bindings"]) assert.deepEqual(canon(vm[k]), canon(c[k]), k);
      assert.deepEqual(vm.diagnostics.map((d) => `${d.code}:${d.severity}`).sort(), [...c.diagnostics].sort());
    } catch (e) {
      fails++;
      console.error(`[views] ${c.name}: ${e.message.split("\n")[0]}`);
    }
    views++;
  }
}

const sidecar = readFileSync(new URL("in_geml_format/GEML-spec.gemlhistory", spec), "utf8");
const v = JSON.parse(wasm.historyVerify(sidecar, undefined));
assert.deepEqual(v.errors, []);

// One call of each: a cross-document check, a style solve, a codemap verify.
const host = JSON.stringify({
  files: {
    "lib.geml": "=== text {#p}\nOne phrase.\n===\n",
    "site.style.geml": '=== meta\nprofile = "geml-style/v1"\n===\n\n=== style-rule {match=heading color=red}\n===\n',
    "doc.geml": "# Title {#t}\n\nSee ![[lib.geml#p]].\n",
    "map.geml": '=== meta\nprofile = "geml-codemap/v1"\n===\n\n=== table {#calls format=csv}\nfrom, to\n#t, lib.geml#nope\n===\n',
  },
});
const doc = JSON.parse(wasm.parseIn("doc.geml", "See ![[lib.geml#p]] and [[lib.geml#q]].\n", host));
assert.deepEqual(doc.diagnostics.map((d) => d.code), ["unresolved-cross-document-reference"]);
const vm = JSON.parse(wasm.styleCheck(host, "site.style.geml", '["doc.geml"]', ""));
assert.deepEqual(vm.bindings.map((b) => `${b.doc}${b.block} ${b.box.color}`), ["doc.geml#t red"]);
const cm = JSON.parse(wasm.codemapVerify("map.geml", host));
assert.deepEqual(cm.dangling.map((d) => d.reference), ["#t", "lib.geml#nope"]);
assert.throws(() => wasm.parseIn("doc.geml", "x", "{"), /the host is not JSON/);
// The files a document names: a drifted code route, a data route's value.
const files = JSON.stringify({ files: { "a.rs": "fn a() {}\n", "n.json": '{"k": 7}' } });
const routed = JSON.parse(wasm.parseIn("doc.geml", "=== code {src=a.rs#L1-2}\n===\n\n=== data {#n src=n.json}\n===\n\n[[#n[\"k\"]]]\n", files));
assert.deepEqual(routed.diagnostics.map((d) => d.code), ["bad-source-range"]);

console.log(`geml ${wasm.version()} (Rust, WebAssembly): ${cases} profile case(s), ${views} view-model case(s), ${fails} failing; ${v.verified} history revision(s) verified`);
process.exit(fails ? 1 : 0);
