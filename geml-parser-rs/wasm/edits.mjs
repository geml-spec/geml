// The `edits` cases (spec §8.2(10)) run against the WebAssembly build, through
// the suite's own loop (_edits.mjs): each case goes into the module as JSON and
// its outcome comes back as JSON, compared by the suite's code, not this
// crate's. A case the module reports `unsupported` is counted as skipped.
//
//   wasm-pack build --target nodejs --out-dir wasm/pkg --release -- --features wasm
//   node wasm/edits.mjs
import { createRequire } from "node:module";
import { manifest, runEdits } from "../../geml-parser/test/conformance/_edits.mjs";

const require = createRequire(import.meta.url);
const wasm = require("./pkg/geml.js");

const ok = runEdits({
  label: `geml ${wasm.version()} (Rust, WebAssembly)`,
  // Every capability the manifest names, `markdown` included.
  has: new Set(Object.keys(manifest.capabilities)),
  run: (c) => JSON.parse(wasm.edit(JSON.stringify(c))),
});
process.exit(ok ? 0 : 1);
