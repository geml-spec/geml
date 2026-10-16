// Where a project's GEML files live, as one convention rather than literals
// repeated across adapters. Everything goes under one dotted directory, the
// way `.pi/` and `.claude/` do.
//
// Paths are written with `/`, relative to the project root; node's path
// functions take that on Windows too.
export const GEML_DIR = ".geml";
export const WORKFLOWS_DIR = `${GEML_DIR}/workflows`;
/** A workflow is a directory: this file plus the documents its states' `context=` names with `./`. */
export const FLOW_FILE = "flow.geml";
export const JOURNALS_DIR = `${GEML_DIR}/journals`;
export const CONTEXT_DOC = `${GEML_DIR}/context.geml`;
export const BACKLOG_DOC = `${GEML_DIR}/backlog.geml`;
/** Where the board's exports go (spec §8.2): journals, workflow copies, share texts. */
export const EXPORTS_DIR = `${GEML_DIR}/exports`;
/** Project configuration: meta `flow-workflow` names the active workflow's directory. */
export const CONFIG_DOC = `${GEML_DIR}/gemflow.geml`;
/** Where `geml codemap build` writes this project's code graph. */
export const DEFAULT_CODEMAP_DIR = `${GEML_DIR}/codemap`;
