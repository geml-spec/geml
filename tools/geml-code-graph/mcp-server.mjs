#!/usr/bin/env node
// Moved: the geml-code-graph toolkit ships inside the npm package now —
// geml-parser/codemap/, or `geml codemap mcp` via the CLI. Shim for old
// command lines; same arguments, same behaviour (GEML_GRAPH_DIR included).
import "../../geml-parser/codemap/mcp-server.mjs";
