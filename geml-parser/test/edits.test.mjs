// The `edits` conformance cases (spec §8.2(10), §8.4) against the reference
// verbs: every case's rewritten document, output or refusal code must be
// exactly what the case pins. The cases were generated FROM this
// implementation and reviewed; this suite keeps them and it from drifting
// apart, and `geml-parser-rs` runs the same cases through a harness of its own.
import { runEdits } from "./conformance/_edits.mjs";
import { impl } from "./conformance/_edits-impl.mjs";

process.exit(runEdits(impl) ? 0 : 1);
