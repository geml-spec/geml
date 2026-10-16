// What each host calls the tools Gemflow reads specially: the ones that run a
// command line (their calls are keyed per simple command, `Bash(<command>)`,
// and their exit status is `tool` evidence) and the ones that write files
// (their calls re-read the `file` variables). Everything else is keyed by its
// own name. Pure: no host is imported here.
export interface HostTools {
  run: readonly string[];
  write: readonly string[];
}

export const CLAUDE_CODE_TOOLS: HostTools = Object.freeze({ run: Object.freeze(["Bash"]), write: Object.freeze(["Edit", "Write", "NotebookEdit"]) });
export const PI_TOOLS: HostTools = Object.freeze({ run: Object.freeze(["bash"]), write: Object.freeze(["edit", "write"]) });
export const DSH_TOOLS: HostTools = Object.freeze({ run: Object.freeze(["bash", "pwsh"]), write: Object.freeze(["write", "edit", "str_replace_editor"]) });
/** Codex, through its hooks (src/codex.ts): the shell tool is `Bash`; `apply_patch` writes files and carries the patch, not a command line, in `command` — the adapter hands the gate the paths instead. */
export const CODEX_TOOLS: HostTools = Object.freeze({ run: Object.freeze(["Bash"]), write: Object.freeze(["apply_patch"]) });
/** For callers that never see tool calls (the CLI). */
export const NO_TOOLS: HostTools = Object.freeze({ run: Object.freeze([]), write: Object.freeze([]) });

/** Each host's tools by the name workflows and journals spell it with. */
export const HOST_TOOLS: Readonly<Record<string, HostTools>> = Object.freeze({ claude: CLAUDE_CODE_TOOLS, pi: PI_TOOLS, dsh: DSH_TOOLS, codex: CODEX_TOOLS });
