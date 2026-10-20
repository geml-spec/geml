// Where a project's GEML files live, as one convention rather than literals
// repeated across adapters. Everything goes under one dotted directory, the
// way `.pi/` and `.claude/` do.
//
// Paths are written with `/`, relative to the project root; node's path
// functions take that on Windows too. The workflows, the tool dictionary, the
// project document, the journals and the session records are the project's
// home's (the main working tree's copy of the project, which every checkout
// shares); a checkout keeps only its generated stage document.
export const GEML_DIR = ".geml";
/** A workflow is one file here, `<name>.geml`: its statechart and its stages' texts. */
export const WORKFLOWS_DIR = `${GEML_DIR}/workflows`;
/** The earlier layout, still read: a workflow directory holding this file, with its guide and dictionary beside it. */
export const FLOW_FILE = "flow.geml";
export const JOURNALS_DIR = `${GEML_DIR}/journals`;
export const CONTEXT_DOC = `${GEML_DIR}/context.geml`;
export const BACKLOG_DOC = `${GEML_DIR}/backlog.geml`;
/** Where the board's exports go (spec §8.2): journals, workflow copies, share texts. */
export const EXPORTS_DIR = `${GEML_DIR}/exports`;
/** The project document: meta `flow-workflow` names the default workflow. */
export const PROJECT_DOC = `${GEML_DIR}/project.geml`;
/** The project document's earlier name, still read. */
export const LEGACY_CONFIG_DOC = `${GEML_DIR}/gemflow.geml`;
/** What each work item made (core/artifacts.ts): the `#artifacts` table. */
export const ARTIFACTS_DOC = `${GEML_DIR}/artifacts.geml`;
/** The copies of the files git does not keep, by content hash; a table row's `where` is relative to GEML_DIR. */
export const ARTIFACTS_DIR = `${GEML_DIR}/artifacts`;
/** The project's tool dictionary: one for all its workflows. */
export const TOOLS_DOC = `${GEML_DIR}/tools.geml`;
/** Where `geml codemap build` writes this project's code graph. */
export const DEFAULT_CODEMAP_DIR = `${GEML_DIR}/codemap`;
