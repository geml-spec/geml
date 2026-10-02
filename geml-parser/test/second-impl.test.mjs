// Acceptance test for GEML-spec §8: a SECOND, INDEPENDENT implementation
// (conformance/impl2.mjs, written only from the spec, importing none of the
// reference parser) must reproduce every conformance case its capabilities
// reach. If the two parsers agree across the suite, the spec is precise enough
// that conforming implementations cannot diverge on these rules. impl2 builds
// the document model's projection and nothing else, so it declares no
// capability: manifest.json skips the files that need one. Run with `npm test`.
import { parse2 } from "./conformance/impl2.mjs";
import { runConformance } from "./conformance/_runner.mjs";

const ok = runConformance({ label: "second implementation", has: new Set(), parse: parse2 });
if (!ok) process.exit(1);
