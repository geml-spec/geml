#!/usr/bin/env node
// Moved: the geml-code-graph toolkit ships inside the npm package now —
// geml-parser/codemap/, or `geml codemap verify` via the CLI. Shim for old
// command lines; same arguments, same behaviour.
import "../../geml-parser/codemap/verify.mjs";
