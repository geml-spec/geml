// The conformance suite run against the WebAssembly build, through the suite's
// own harness (_runner.mjs) and projection (_project.mjs): what this checks is
// the model the wasm module returns, read by the reference projection, not by
// any code of this crate. Every capability the manifest names is declared.
//
//   wasm-pack build --target nodejs --out-dir wasm/pkg --release -- --features wasm
//   node wasm/conformance.mjs
import { createRequire } from "node:module";
import { runConformance, manifest } from "../../geml-parser/test/conformance/_runner.mjs";

const require = createRequire(import.meta.url);
const wasm = require("./pkg/geml.js");

const ok = runConformance({
  label: `geml ${wasm.version()} (Rust, WebAssembly)`,
  has: new Set(Object.keys(manifest.capabilities)),
  parse: (text) => JSON.parse(wasm.parse(text)),
  // `host`: the case's tree, complete, so a path it lacks is missing.
  parseIn: (files, main) => JSON.parse(wasm.parseIn(main, files[main], JSON.stringify({ files, complete: true }))),
  decode: (bytes) => wasm.decode(bytes),
  ids: (doc) => doc.ids,
  addresses: (text) => JSON.parse(wasm.addresses(text)),
  diagnostics: (doc) => doc.diagnostics.map((d) => `${d.code}:${d.severity}`),
});
process.exit(ok ? 0 : 1);
