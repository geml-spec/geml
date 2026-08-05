#!/usr/bin/env node
// SessionStart hook — inject .claude/instructions.geml as session context.
//
// The .geml file (not a CLAUDE.md) is the source of truth for project
// instructions: addressable (`geml set <file> '#id'`), with git as its
// history — config docs carry NO .gemlhistory sidecar.
//
// Contract: drain stdin, ALWAYS exit 0, emit hookSpecificOutput JSON on
// stdout; silent no-op if the file is missing or unreadable.
import { readFileSync } from "node:fs";
import { join } from "node:path";

try { for await (const chunk of process.stdin) { void chunk; } } catch { /* ignore */ }

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
let text;
try {
  text = readFileSync(join(root, ".claude", "skills", "geml", "instructions.geml"), "utf8");
} catch {
  process.exit(0);
}

const header =
  "Project instructions (source of truth: .claude/skills/geml/instructions.geml — a GEML doc; " +
  "edit ONE section with `geml set .claude/skills/geml/instructions.geml '#id' --in -`; " +
  "git is this file's history):\n\n";

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: header + text,
  },
}));
process.exit(0);
