// Public surface of @geml/agent-runtime. Phase A exports the core library;
// Phase B adds the DSH plugin entry (name / inject / Config / apply) here.
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

export * from "./approval.js";

export * as plugin from "./plugin.js";
