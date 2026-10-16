// `pwsh` runs commands on DeepSeek Harness, and its command is PowerShell, not
// sh. The scanners in core/command-line.ts read POSIX sh: where a word ends,
// what a quote hides, what separates two commands. PowerShell differs (a
// backtick is its escape character, `$(` and `;` mean other things in other
// places), so a `pwsh` call is never handed to them. `tool` evidence is not
// written for `pwsh`: an exit status is only credited to a command the sh
// scanner could split, and it cannot split this one.
//
// What is applied are the two rules that do not need to understand the line,
// each searched for anywhere in the command text, once as written and once
// with PowerShell's escapes and quotes taken out:
//
//   - person-only: the word gemflow and one of mark, unmark or advance as a
//     word, in any order and any case;
//   - a fenced use: a dictionary command pattern bound to a use this state
//     does not declare (core/dictionary.ts's fencedRefusal).
//
// Both are fail-safe searches, not a parse: they may turn away a command that
// only mentions the text, and they see only the text of the line (a variable,
// an `Invoke-Expression` or a script the model wrote gets past them).
import { personOnlyReason } from "../../core/command-line.js";

/** The dsh tools whose command line is PowerShell. */
export const POWERSHELL_TOOLS: ReadonlySet<string> = new Set(["pwsh"]);

/** The line with PowerShell's escapes removed: a backtick-newline is a line continuation, a backtick before anything else escapes that character. */
function withoutEscapes(command: string): string {
  return command.replace(/`\r?\n/g, "").replace(/`/g, "");
}

/** A person's verb in a line that holds the word gemflow, or undefined. */
function personVerbIn(text: string): string | undefined {
  return /\bgemflow\b/i.test(text) ? text.match(/\b(mark|unmark|advance|pause|resume)\b/i)?.[1]?.toLowerCase() : undefined;
}

/** Why a `pwsh` command is for a person — it holds gemflow and mark, unmark or advance as words — or undefined. */
export function powershellPersonOnlyRefusal(command: string): string | undefined {
  const verb = personVerbIn(command) ?? personVerbIn(withoutEscapes(command).replace(/['"]/g, ""));
  return verb === undefined ? undefined : personOnlyReason(verb);
}

/** Why a `pwsh` command may not run in this state because a fenced use is in it, or undefined; `fenced` is the supervisor's own search (Supervisor.fencedRefusal). */
export function powershellFencedRefusal(fenced: (command: string) => string | undefined, command: string): string | undefined {
  return fenced(command) ?? fenced(withoutEscapes(command));
}
