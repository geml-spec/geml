// Public surface of @geml/gemflow: the host-agnostic library.
//
// The hosts are reached by subpath, not from here:
//
//   @geml/gemflow/dsh   the Cordis plugin (name / inject / Config / apply)
//   @geml/gemflow/pi    the Pi extension (default export)
//
// Deliberately: each adapter statically imports its own host's packages, and
// those are OPTIONAL peers. A root that re-exported both would make importing
// the library fail for anyone who installed only one harness.
import { readFileSync } from "node:fs";

export const RUNTIME_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export * from "./core/schema.js";
export * from "./core/dictionary.js";
export * from "./core/dictionary-file.js";
export * from "./core/host-tools.js";
export * from "./core/signals.js";
export * from "./core/statechart.js";
export * from "./core/snapshot.js";
export * from "./core/journal.js";
export * from "./core/prompt.js";
export * from "./core/run.js";
export * from "./core/tools.js";
export * from "./core/supervisor.js";
export * from "./core/layout.js";
export * from "./core/stagehand.js";
export * from "./core/unit.js";
export * from "./core/backlog.js";
export * from "./core/blocks.js";
export * from "./core/policy.js";
export * from "./core/verb-specs.js";
