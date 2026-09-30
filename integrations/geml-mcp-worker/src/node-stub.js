// The parser's dist/ mentions node:fs, node:path, node:url, node:os,
// node:child_process and node:readline on paths a Worker never runs (the CLI
// hand-off, PARSER_VERSION's package.json lookup, the disk host). wrangler.jsonc
// aliases those imports here, and this forwards to the stub the parser already
// ships for its browser bundles — one stub, one more consumer.
export * from "../../../geml-parser/codemap/browser-stub.mjs";
export { default } from "../../../geml-parser/codemap/browser-stub.mjs";
