// The Node built-in stubs live with the parser package now (they are also
// served to browsers by `geml codemap serve` as /_dist/_node-stub.js); this
// file stays as the esbuild alias target and just forwards — one stub, three
// consumers (extension bundle, playground bundle, served pages).
export * from "../../../geml-parser/codemap/browser-stub.mjs";
export { default } from "../../../geml-parser/codemap/browser-stub.mjs";

// Nothing else is needed. Every shim that used to live here answered a
// CLI-side import that leaked in through geml.ts — fs writes, node:os,
// child_process, realpathSync. The CLI is cli.ts now, which no bundle
// reaches, so this file is back to being a plain forward.
