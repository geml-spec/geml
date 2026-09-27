// Where this project's GEML files live, as one convention rather than a
// literal repeated in three adapters.
//
// Everything goes under one dotted directory, the way `.pi/` and `.claude/`
// do: a repository's root is the most contested namespace it has, and a
// statechart is configuration, not a document someone wants to trip over.
export const GEML_DIR = ".geml";

/** The statechart a harness looks for when nothing names another one. */
export const DEFAULT_STATECHART = `${GEML_DIR}/agent.geml`;

/** Where `geml codemap build` writes this project's code graph. */
export const DEFAULT_CODEMAP_DIR = `${GEML_DIR}/codemap`;
