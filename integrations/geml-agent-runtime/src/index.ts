// Public surface of @geml/agent-runtime: the host-agnostic library.
//
// The hosts are reached by subpath, not from here:
//
//   @geml/agent-runtime/dsh   the Cordis plugin (name / inject / Config / apply)
//   @geml/agent-runtime/pi    the Pi extension (default export)
//
// Deliberately: each adapter statically imports its own host's packages, and
// those are OPTIONAL peers. A root that re-exported both would make importing
// the library fail for anyone who installed only one harness.
import { readFileSync } from "node:fs";

export const RUNTIME_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export * from "./core/schema.js";
export * from "./core/statechart.js";
export * from "./core/snapshot.js";
export * from "./core/ledger.js";
export * from "./core/prompt.js";
export * from "./core/run.js";
export * from "./core/tools.js";
export * from "./core/supervisor.js";
