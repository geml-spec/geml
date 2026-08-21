#!/usr/bin/env node
// SessionStart hook — the few lines that make the skill reachable.
//
// The skill itself is loaded by description match, which only fires when the
// task already sounds like GEML. That is the wrong condition: the case worth
// catching is a long README in a project that has never heard of the format.
// These lines are unconditional, so they are kept to the smallest thing that
// changes a decision — what exists, when to reach for it, and when NOT to.
//
// They point at the MCP tools, not the CLI: this plugin registers the server,
// so those tools are always there, while `geml` on PATH is not something a
// plugin install guarantees.
//
// Contract, same as any hook: drain stdin, ALWAYS exit 0, emit
// hookSpecificOutput on stdout. A hook that fails must not take the session
// with it.
try { for await (const chunk of process.stdin) { void chunk; } } catch { /* ignore */ }

const context = [
  "GEML's document tools are available in this session. For a LONG Markdown or",
  "documentation file, address it by block instead of reading it whole:",
  "`geml_list` maps every block to an address, `geml_find` says which block holds",
  "a phrase — as an address, not a line number, so it survives the next edit —",
  "and `geml_get` reads just that block. They read Markdown directly: nothing is",
  "converted and nothing is written.",
  "",
  "Skip all of this when the file is short enough to read anyway, or when the",
  "exact string to replace is already known, and edit with the ordinary editing",
  "tool. The `geml` skill carries the detail.",
].join("\n");

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
}));
process.exit(0);
