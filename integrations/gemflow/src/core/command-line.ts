// How a command line is read (spec §5.2): the simple commands of a plain `&&`
// chain for the command signals, every command position for the person-only
// rule and for whether git or gh ran, a plain copy of the line for a fenced use's pattern,
// whether a line only searches, and the directory each simple command runs in
// and the files it names, for the work item a call is attributed to. A small
// quote-aware scanner, not a shell parser. It imports nothing, so the Claude
// Code hooks module — which has no Node — reads a line with the very functions
// the signals module and the supervisor use.

/** The command line a tool call would run: its input's `command`, when that is a string, whatever the tool (Bash, Monitor, a host's own runner). */
export function commandOf(input: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const c = input?.["command"];
  return typeof c === "string" ? c : undefined;
}

/** The longest command line a command signal reads; the scanner is linear, but a signal pattern is the author's regular expression. */
export const MAX_SIGNAL_COMMAND_LENGTH = 65536;

/** The gemflow verbs only a person may run. */
const PERSON_VERBS: ReadonlySet<string> = new Set(["mark", "unmark", "advance", "pause", "resume"]);

/** A blank is a space or a tab: the only characters the shell splits words at (NBSP, VT, FF and the Unicode spaces are ordinary characters). */
const isBlank = (c: string): boolean => c === " " || c === "\t";

/** `NAME=` at the start of a word: the assignments a signal pattern skips; the looser form also takes `NAME+=` and `NAME[i]=`, which the shell reads as assignments too. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ASSIGNMENT_LIKE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
/** A redirection operator at the start of a word, with its optional file descriptor. */
const REDIRECTION = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:<<<|<<-?|<>|<&|>&|>>|>\||>|<)/;

/** Words that open, close or continue a shell compound command: a line whose command word is one is not a chain of simple commands. */
const COMPOUND_WORDS: ReadonlySet<string> = new Set([
  "[[", "]]", "{", "}", "function", "if", "then", "elif", "else", "fi", "while", "until", "do", "done", "for", "case", "esac", "select", "coproc", "repeat", "foreach",
]);
/** Builtins that can end the shell, or change what a later command word runs, so a chain holding one says nothing about the others. */
const SHELL_CHANGING_WORDS: ReadonlySet<string> = new Set(["exit", "exec", "trap", "return", "logout", "hash", "alias", "unalias", "function", "enable", "eval", "source", "."]);
/** Words that run the word after them: `builtin exit` is `exit`. */
const PREFIX_WORDS: ReadonlySet<string> = new Set(["builtin", "command", "time", "!", "noglob", "nocorrect"]);
/** The same, and the keywords that put a command right after them (`then gemflow mark x`, `{ gemflow mark x; }`). */
const COMMAND_INTRODUCERS: ReadonlySet<string> = new Set([...PREFIX_WORDS, "{", "if", "then", "elif", "else", "while", "until", "do"]);
/** A word that names the gemflow CLI: a command called gemflow (any path, any case, any `@version`) or the package's `cli` script. */
const GEMFLOW_WORD = /(?:^|\/)gemflow(?:@[^/]*)?(?:\.(?:[cm]?js|cmd|ps1))?$/i;
const GEMFLOW_CLI = /(?:^|\/)(?:gemflow\/(?:.*\/)?|(?:dist|src|bin)\/)cli\.[cm]?[jt]s$/i;
/** Commands that run a command named among their arguments: package runners, interpreters and the wrappers that exec the next command. */
const LAUNCHERS: ReadonlySet<string> = new Set([
  "npx", "bunx", "pnpx", "npm", "pnpm", "yarn", "bun", "corepack", "uvx", "node", "nodejs", "deno", "tsx", "ts-node",
  "env", "exec", "nohup", "sudo", "doas", "su", "runuser", "timeout", "gtimeout", "nice", "ionice", "xargs", "parallel", "setsid", "stdbuf",
  "command", "builtin", "time", "watch", "caffeinate", "chronic", "flock", "script", "busybox",
]);
/** Commands that run a string they are given as shell. PowerShell's strings are read with the POSIX rules too: a fail-safe, not its grammar. */
const SHELL_RUNNERS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "eval", "pwsh", "powershell"]);
/** PowerShell's -Command as it may be shortened (`-c`, `-com`, …), in any case: the rest of its arguments are the command. */
const PWSH_COMMAND = /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i;
/** A launcher's option whose value is a command line: npm exec's and npx's `-c` and `--call`, pnpm exec's, su's, script's and flock's `-c`, env's `-S`. */
const SHELL_OPTION = /^(?:-c|--call|--command|-S|--split-string)$/;
const SHELL_OPTION_JOINED = /^--(?:call|command|split-string)=/;

interface Word {
  /** The word as written, quotes and all. */
  raw: string;
  /** The word with quotes and backslashes removed. */
  text: string;
  /** Where the word starts in the command. */
  start: number;
  /** A `$` outside single quotes could turn the word into something else. */
  expands: boolean;
}

/** The words of one simple command, split at unquoted blanks. The scanner has already checked the quotes close. */
function words(command: string): Word[] {
  const out: Word[] = [];
  let start = -1, text = "", expands = false;
  let quote: string | null = null;
  const end = (at: number) => {
    if (start < 0) return;
    out.push({ raw: command.slice(start, at), text, start, expands });
    start = -1; text = ""; expands = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    if (start < 0) {
      if (isBlank(c)) continue;
      start = i;
    }
    if (quote === "'") {
      if (c === "'") quote = null; else text += c;
    } else if (quote === "$'") {
      if (c === "\\") i++; else if (c === "'") quote = null; else text += c;
    } else if (quote === '"') {
      if (c === "\\") {
        // As the shell reads double quotes: a backslash escapes only $ ` " \ and a newline (a line continuation), and stays itself before anything else.
        const next = command.charAt(i + 1);
        if (next === "\n") i++;
        else if (next === "$" || next === "`" || next === '"' || next === "\\") { text += next; i++; }
        else text += c;
      } else if (c === '"') quote = null;
      else { if (c === "$") expands = true; text += c; }
    } else if (isBlank(c)) end(i);
    else if (c === "'" || c === '"') quote = c;
    else if (c === "$" && command.charAt(i + 1) === "'") { quote = "$'"; expands = true; i++; }
    else if (c === "\\") text += command.charAt(++i);
    else { if (c === "$") expands = true; text += c; }
  }
  end(command.length);
  return out;
}

/** The index of a simple command's command word — past assignments, redirections and the prefixes that run the next word — or -1 if it has none. */
function commandWordIndex(ws: readonly Word[], through: ReadonlySet<string> = PREFIX_WORDS): number {
  let prefixed = false;
  for (let i = 0; i < ws.length; ) {
    const w = ws[i];
    if (w === undefined) break;
    const redirect = w.raw.match(REDIRECTION);
    if (ASSIGNMENT_LIKE.test(w.raw)) i++;
    else if (redirect) i += redirect[0].length === w.raw.length ? 2 : 1; // `> file` takes the next word; `>file` does not
    else if (prefixed && w.text.startsWith("-")) i++; // an option of command or time
    else if (!w.expands && through.has(w.text)) { prefixed = true; i++; }
    else return i;
  }
  return -1;
}

/** Whether a simple command's exit status is the whole story of the command it names: not a shell keyword, not a builtin that ends the shell or rewrites what runs, not a word built by expansion. */
function speaksForItself(command: string): boolean {
  const ws = words(command);
  const at = commandWordIndex(ws);
  const w = at < 0 ? undefined : ws[at];
  return w === undefined || (!w.expands && !COMPOUND_WORDS.has(w.text) && !SHELL_CHANGING_WORDS.has(w.text));
}

function trimBlanks(s: string): string {
  let a = 0, b = s.length;
  while (a < b && isBlank(s.charAt(a))) a++;
  while (b > a && isBlank(s.charAt(b - 1))) b--;
  return s.slice(a, b);
}

/**
 * The simple commands of a command line that is nothing but simple commands
 * joined by `&&` — the only shape whose exit status speaks for each command in
 * it — or null for any other line. A small quote-aware scanner, not a shell
 * parser. Single quotes hide everything; `$'…'` hides everything but a
 * backslash escape; double quotes hide operators from the split (the shell
 * still runs `$(…)` and backticks inside them, which cannot change the status
 * of the command they sit in) but not `${`, and in them a backslash escapes
 * only `$`, a backtick, `"`, `\` and a newline; a backslash outside quotes
 * escapes the next character (a backslash-newline is a line continuation). Blanks are
 * the space and the tab only. Outside quotes `;`, `||`, a pipe, a background
 * `&` (`&>` included), a newline, `$(`, `${`, `$[`, a backtick, `(` and a `#`
 * that starts a word (a comment) make the line null; a `&` inside a redirection
 * (`2>&1`, `>&log`) is not a background `&`. So does a simple command whose
 * command word is a shell keyword (`[[`, `{`, `function`, `if`, …), a builtin
 * that can end the shell or rewrite what runs (`exit`, `exec`, `trap`, `eval`,
 * `alias`, …, looking through `builtin` and `command`), or a word built by
 * expansion. A blank line has no commands; an empty command (`a &&`) or an
 * unterminated quote is not a command line at all.
 */
export function simpleCommands(line: string): string[] | null {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null; // ', " or $'
  let prev = ""; // the last character outside quotes, "" after a quote or an escape
  let wordStart = true; // the next character starts a word
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    const next = line.charAt(i + 1);
    if (quote !== null) {
      if (quote === '"' && c === "$" && next === "{") return null;
      cur += c;
      if (c === "\\" && quote !== "'" && i + 1 < line.length) cur += line.charAt(++i);
      else if (c === quote.slice(-1)) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c; cur += c; prev = ""; wordStart = false;
    } else if (c === "$" && next === "'") {
      quote = "$'"; cur += "$'"; i++; prev = ""; wordStart = false;
    } else if (c === "$" && (next === "(" || next === "{" || next === "[")) {
      return null;
    } else if (c === "\\") {
      if (next === "\n") { i++; continue; }
      cur += c + next; i++; prev = ""; wordStart = false;
    } else if (c === "&") {
      if (next === "&") { parts.push(cur); cur = ""; i++; prev = ""; wordStart = true; continue; }
      if (next === ">" || (prev !== ">" && prev !== "<")) return null;
      cur += c; prev = c; wordStart = true;
    } else if (c === "#" && wordStart) {
      return null;
    } else if (c === ";" || c === "|" || c === "\n" || c === "`" || c === "(") {
      return null;
    } else {
      cur += c; prev = c; wordStart = isBlank(c) || c === "<" || c === ">";
    }
  }
  if (quote !== null) return null;
  parts.push(cur);
  const commands = parts.map(trimBlanks);
  if (commands.length === 1 && commands[0] === "") return [];
  return commands.every((c) => c !== "" && speaksForItself(c)) ? commands : null;
}

/** A simple command without its leading `NAME=value` assignments. */
function withoutAssignments(command: string): string {
  const first = words(command).find((w) => !ASSIGNMENT_WORD.test(w.raw));
  return first === undefined ? "" : command.slice(first.start);
}

/** What a command signal's start-anchored pattern is tested against: each simple command of a plain `&&` chain, without its leading assignments; null when the line speaks for no command signal (too long, or not such a chain). */
export function signalHeads(line: string): string[] | null {
  if (line.length > MAX_SIGNAL_COMMAND_LENGTH) return null;
  const commands = simpleCommands(line);
  return commands === null ? null : commands.map(withoutAssignments);
}

/** The line with line continuations, quotes and backslashes removed and every run of blanks made one space: roughly the text the shell will read as words. */
export function withoutQuoting(command: string): string {
  return command.replace(/\\\n/g, "").replace(/['"\\]/g, "").replace(/[ \t]+/g, " ");
}

/** How many substitutions deep the person-only scan reads; a deeper line is judged loosely. */
const MAX_NESTING = 8;

/** A here-document's opener: its delimiter, whether `<<-` strips the tabs before it, whether the body is literal (any part of the word quoted), and where the opener ends. */
interface HereDoc { delim: string; strip: boolean; literal: boolean; end: number }

/** The here-document opened at `at` (`<<WORD`, `<<-WORD`, the word quoted or not), or undefined: `<<<` is a here-string, and an opener with no word opens nothing. */
function hereDocAt(line: string, at: number): HereDoc | undefined {
  if (line.charAt(at) !== "<" || line.charAt(at + 1) !== "<" || line.charAt(at + 2) === "<") return undefined;
  let j = at + 2;
  const strip = line.charAt(j) === "-";
  if (strip) j++;
  while (line.charAt(j) === " " || line.charAt(j) === "\t") j++;
  let delim = "";
  let literal = false;
  while (j < line.length) {
    const c = line.charAt(j);
    if (c === "'" || c === '"') {
      const close = line.indexOf(c, j + 1);
      if (close < 0) return undefined;
      delim += line.slice(j + 1, close); literal = true; j = close + 1;
    } else if (c === "\\") {
      delim += line.charAt(j + 1); literal = true; j += 2;
    } else if (/[\s;&|()<>]/.test(c)) break;
    else { delim += c; j++; }
  }
  return delim === "" ? undefined : { delim, strip, literal, end: j };
}

/**
 * An arithmetic context — `((…))`, `$((…))`, `$[…]` — where `<<` is a
 * shift, not a here-document. An opener with one before it is not scanned:
 * skipping the lines after it as a body could hide a command, so the caller
 * reads the line loosely instead. Only shell text counts: a body already
 * skipped is data, and code in it (`xs.map((x) => x)`) opens no arithmetic.
 */
const ARITHMETIC = /\(\(|\$\[/;

/** The line's text from `from` up to `upto` without the here-document bodies skipped so far (start and end, in order): what an arithmetic context before an opener could stand in. */
function shellTextBefore(line: string, from: number, upto: number, skipped: readonly (readonly [number, number])[]): string {
  let out = "";
  let at = from;
  for (const [start, end] of skipped) {
    if (start >= upto) break;
    if (start > at) out += line.slice(at, start);
    at = Math.max(at, end);
  }
  return upto > at ? out + line.slice(at, upto) : out;
}

/** The body of a here-document whose opener's line ends at the newline `nl`, and the index of the newline that ends its terminator line (the line's length when no line ends it: the rest is body). */
function hereDocBody(line: string, nl: number, doc: HereDoc): { body: string; end: number } {
  let start = nl + 1;
  while (start <= line.length) {
    const found = line.indexOf("\n", start);
    const stop = found < 0 ? line.length : found;
    const text = line.slice(start, stop).replace(/\r$/, "");
    if ((doc.strip ? text.replace(/^\t+/, "") : text) === doc.delim) return { body: line.slice(nl + 1, start), end: stop };
    start = stop + 1;
  }
  return { body: line.slice(nl + 1), end: line.length };
}

/** The index of the `)` that closes a `$(` whose body starts at `from`, or -1. Quotes, nested substitutions and here-document bodies are skipped. */
function substitutionEnd(line: string, from: number, depth = 0): number {
  if (depth > MAX_NESTING) return -1;
  let open = 1;
  const docs: HereDoc[] = [];
  const skipped: [number, number][] = [];
  for (let i = from; i < line.length; i++) {
    const c = line.charAt(i);
    const doc = c === "<" ? hereDocAt(line, i) : undefined;
    if (doc !== undefined && ARITHMETIC.test(shellTextBefore(line, from, i, skipped))) return -1;
    if (doc !== undefined) { docs.push(doc); i = doc.end - 1; }
    else if (c === "\n" && docs.length > 0) {
      for (const d of docs.splice(0)) { const end = hereDocBody(line, i, d).end; skipped.push([i + 1, end]); i = end; }
    }
    else if (c === "\\") i++;
    else if (c === "'") { i = line.indexOf("'", i + 1); if (i < 0) return -1; }
    else if (c === '"') {
      for (i++; i < line.length && line.charAt(i) !== '"'; i++) {
        if (line.charAt(i) === "\\") i++;
        else if (line.charAt(i) === "$" && line.charAt(i + 1) === "(") { i = substitutionEnd(line, i + 2, depth + 1); if (i < 0) return -1; }
      }
      if (i >= line.length) return -1;
    } else if (c === "(") open++;
    else if (c === ")" && --open === 0) return i;
  }
  return -1;
}

/** The index of the backtick that closes a backtick substitution whose body starts at `from`, or -1. */
function backtickEnd(line: string, from: number): number {
  for (let i = from; i < line.length; i++) {
    if (line.charAt(i) === "\\") i++;
    else if (line.charAt(i) === "`") return i;
  }
  return -1;
}

/**
 * Every place a command could start in a line: its text split at `;`, `&`,
 * `|`, a newline, `(`, `)` and a backtick outside quotes, plus the commands
 * inside a `$(…)` or backtick substitution within double quotes. Quoting is
 * the scanner's (single quotes, `$'…'`, double quotes, backslashes); unlike
 * `simpleCommands` it asks for no particular shape. A `&` in a redirection
 * (`2>&1`, `&>log`) does not split. A here-document's body is no command —
 * a commit message with "gemflow" and "mark" in it runs neither — but the
 * substitutions an unquoted one expands are. Null when a quote or
 * substitution does not close.
 */
function commandSegments(line: string, depth = 0): string[] | null {
  if (depth > MAX_NESTING) return null;
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let prev = "";
  const flush = () => {
    const text = trimBlanks(cur);
    if (text !== "") out.push(text);
    cur = "";
  };
  const nested = (body: string): boolean => {
    const inner = commandSegments(body, depth + 1);
    if (inner === null) return false;
    out.push(...inner);
    return true;
  };
  /** An unquoted here-document's substitutions: the commands its expansion runs. */
  const expanded = (body: string): boolean => {
    for (let j = 0; j < body.length; j++) {
      const c = body.charAt(j);
      if (c === "\\") j++;
      else if (c === "$" && body.charAt(j + 1) === "(") {
        const end = substitutionEnd(body, j + 2, depth);
        if (end < 0 || !nested(body.slice(j + 2, end))) return false;
        j = end;
      } else if (c === "`") {
        const end = backtickEnd(body, j + 1);
        if (end < 0 || !nested(body.slice(j + 1, end))) return false;
        j = end;
      }
    }
    return true;
  };
  const docs: HereDoc[] = [];
  const skipped: [number, number][] = [];
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    const next = line.charAt(i + 1);
    const doc = quote === null && c === "<" ? hereDocAt(line, i) : undefined;
    if (doc !== undefined && ARITHMETIC.test(shellTextBefore(line, 0, i, skipped))) return null;
    if (doc !== undefined) {
      docs.push(doc); cur += line.slice(i, doc.end); i = doc.end - 1; prev = "";
    } else if (quote === null && c === "\n" && docs.length > 0) {
      flush(); prev = "";
      for (const d of docs.splice(0)) {
        const { body, end } = hereDocBody(line, i, d);
        if (!d.literal && !expanded(body)) return null;
        skipped.push([i + 1, end]);
        i = end;
      }
    } else if (quote === "'") {
      cur += c;
      if (c === "'") quote = null;
    } else if (quote === '"' && c === "$" && next === "(") {
      const end = substitutionEnd(line, i + 2, depth);
      if (end < 0 || !nested(line.slice(i + 2, end))) return null;
      cur += line.slice(i, end + 1); i = end;
    } else if (quote === '"' && c === "`") {
      const end = backtickEnd(line, i + 1);
      if (end < 0 || !nested(line.slice(i + 1, end))) return null;
      cur += line.slice(i, end + 1); i = end;
    } else if (quote !== null) {
      cur += c;
      if (c === "\\" && quote !== "'" && i + 1 < line.length) cur += line.charAt(++i);
      else if (c === quote.slice(-1)) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c; cur += c; prev = "";
    } else if (c === "$" && next === "'") {
      quote = "$'"; cur += "$'"; i++; prev = "";
    } else if (c === "\\") {
      if (next === "\n") { i++; continue; }
      cur += c + next; i++; prev = "";
    } else if (c === "&" && next !== "&" && (prev === ">" || prev === "<" || next === ">")) {
      cur += c; prev = c;
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "`" || c === "(" || c === ")") {
      flush(); prev = "";
    } else {
      cur += c; prev = c;
    }
  }
  if (quote !== null) return null;
  flush();
  return out;
}

/** The arguments of a command that run gemflow: the first word after `at` that is neither an option, a redirection nor another way of naming gemflow. */
function personVerbAfter(ws: readonly Word[], at: number): string | undefined {
  for (let i = at + 1; i < ws.length; i++) {
    const w = ws[i];
    if (w === undefined) break;
    const redirect = w.raw.match(REDIRECTION);
    if (redirect) { if (redirect[0].length === w.raw.length) i++; continue; }
    if (w.text.startsWith("-") || namesGemflow(w.text)) continue;
    if (w.expands) return "mark|unmark|advance|pause|resume"; // the verb is built by expansion: it could be any of them
    const verb = w.text.toLowerCase();
    return PERSON_VERBS.has(verb) ? verb : undefined;
  }
  return undefined;
}

function namesGemflow(text: string): boolean {
  return GEMFLOW_WORD.test(text) || GEMFLOW_CLI.test(text);
}

/** When quoting or expansion hides the command word: a gemflow word and a verb word anywhere in the line, order aside. */
function personVerbLoosely(line: string): string | undefined {
  const plain = withoutQuoting(line);
  return /\bgemflow\b/i.test(plain) ? plain.match(/\b(mark|unmark|advance|pause|resume)\b/i)?.[1]?.toLowerCase() : undefined;
}

/** How deep a shell string inside a shell string is read before the line is judged loosely. */
const MAX_SHELL_DEPTH = 3;

/** The person-only verb a command line runs, or undefined. */
function personVerb(line: string, depth = 0): string | undefined {
  const segments = depth > MAX_SHELL_DEPTH ? null : commandSegments(line);
  if (segments === null) return personVerbLoosely(line);
  let looseRead = false; // every expanded command word asks the same question of the whole line: read it once
  for (const segment of segments) {
    const ws = words(segment);
    const at = commandWordIndex(ws, COMMAND_INTRODUCERS);
    const head = at < 0 ? undefined : ws[at];
    if (head === undefined) continue;
    if (head.expands) {
      if (looseRead) continue;
      looseRead = true;
      const verb = personVerbLoosely(line);
      if (verb !== undefined) return verb;
      continue;
    }
    if (namesGemflow(head.text)) {
      const verb = personVerbAfter(ws, at);
      if (verb !== undefined) return verb;
      continue;
    }
    if (LAUNCHERS.has(programName(head.text).toLowerCase())) {
      for (let i = at + 1; i < ws.length; i++) {
        const w = ws[i];
        const verb = w !== undefined && namesGemflow(w.text) ? personVerbAfter(ws, i) : undefined;
        if (verb !== undefined) return verb;
      }
    }
    for (const inner of shellStrings(ws, at)) {
      const verb = personVerb(inner.text, depth + 1) ?? (inner.powershell ? personVerbLoosely(inner.text) : undefined);
      if (verb !== undefined) return verb;
    }
  }
  return undefined;
}

/** A string a command hands to a shell; PowerShell's is read with the POSIX rules and also searched for words, as a fail-safe. */
interface ShellString { text: string; powershell: boolean }

/** The strings a shell runner runs: its arguments; eval's joined; PowerShell's each, and those after -Command (or all of them, without it) joined. */
function runnerStrings(name: string, args: readonly string[]): ShellString[] {
  if (name === "eval") return [{ text: args.join(" "), powershell: false }];
  if (name !== "pwsh" && name !== "powershell") return args.map((text) => ({ text, powershell: false }));
  const flag = args.findIndex((a) => PWSH_COMMAND.test(a));
  return [...args, (flag < 0 ? args : args.slice(flag + 1)).join(" ")].map((text) => ({ text, powershell: true }));
}

/**
 * The strings the command at `at` hands to a shell: a shell runner's (bash -c
 * "…", pwsh -c "…"), and for a launcher, those of a shell runner among its
 * arguments (`sudo sh -c "…"`, `timeout 5 bash -c "…"`) and the value of its
 * shell option (`npx -c "…"`, `npm exec --call="…"`, `env -S "…"`).
 */
function shellStrings(ws: readonly Word[], at: number): ShellString[] {
  const head = ws[at];
  if (head === undefined) return [];
  const name = programName(head.text).toLowerCase();
  if (SHELL_RUNNERS.has(name)) return runnerStrings(name, ws.slice(at + 1).map((w) => w.text));
  if (!LAUNCHERS.has(name)) return [];
  const out: ShellString[] = [];
  for (let i = at + 1; i < ws.length; i++) {
    const text = (ws[i] as Word).text;
    const inner = programName(text).toLowerCase();
    if (SHELL_RUNNERS.has(inner)) {
      out.push(...runnerStrings(inner, ws.slice(i + 1).map((w) => w.text)));
      break;
    }
    const next = ws[i + 1];
    if (SHELL_OPTION.test(text) && next !== undefined) out.push({ text: next.text, powershell: false });
    else if (SHELL_OPTION_JOINED.test(text)) out.push({ text: text.slice(text.indexOf("=") + 1), powershell: false });
  }
  return out;
}

/** The person-only refusal's words for one verb: what the model reads, whichever scan found the verb. */
export function personOnlyReason(verb: string): string {
  return `\`gemflow ${verb}\` is for a person, not the model: manual signals and a person's transitions are never taken by the agent`;
}

/** Commands that run what a here-document feeds them, besides the shells and launchers: interpreters, and ssh (the far end's shell). */
const STDIN_RUNNERS: ReadonlySet<string> = new Set(["python", "python3", "py", "perl", "ruby", "php", "lua", "osascript", "rscript", "tclsh", "ssh", "docker", "podman", "kubectl"]);

/**
 * The line without the bodies of the here-documents it writes as text: a body
 * fed to a command that runs no code from it (`cat <<EOF > notes.md`, `tee`)
 * is data. One fed to a shell, a launcher, an interpreter or ssh, or whose
 * command pipes on (`cat <<EOF | bash`), runs, and stays. Quotes and
 * backslashes as the other scanners read them. Null when the line cannot be
 * read this way — a quote that does not close, `<<` after an arithmetic
 * context, a word that hides its command — and the caller reads it whole.
 */
export function withoutDataHereDocs(line: string, depth = 0): string | null {
  if (depth > MAX_NESTING) return null;
  // What comes out in place of a stretch of the line: nothing for a body that is data, a substitution's own reading.
  const cuts: [number, number, string][] = [];
  const docs: { doc: HereDoc; runs: boolean }[] = [];
  let quote: string | null = null;
  let start = 0; // where the current command began: after the last separator outside quotes
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    // An arithmetic expansion, where `<<` is a shift: the line is read whole.
    if ((quote === null || quote === '"') && c === "$" && line.charAt(i + 1) === "(" && line.charAt(i + 2) === "(") return null;
    // A command substitution, in double quotes or none: its commands read the same way.
    if ((quote === null || quote === '"') && c === "$" && line.charAt(i + 1) === "(") {
      const end = substitutionEnd(line, i + 2, depth);
      if (end < 0) return null;
      const inner = withoutDataHereDocs(line.slice(i + 2, end), depth + 1);
      if (inner === null) return null;
      cuts.push([i + 2, end, inner]);
      i = end;
      continue;
    }
    if (quote !== null) {
      if (c === "\\" && quote !== "'") i++;
      else if (c === quote.slice(-1)) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "$" && line.charAt(i + 1) === "'") { quote = "$'"; i++; continue; }
    if (c === "\\") { i++; continue; }
    const doc = c === "<" ? hereDocAt(line, i) : undefined;
    if (doc !== undefined) {
      if (ARITHMETIC.test(shellTextBefore(line, 0, i, cuts.map(([a, b]) => [a, b] as const)))) return null;
      const ws = words(line.slice(start, i));
      const at = commandWordIndex(ws, COMMAND_INTRODUCERS);
      const head = at < 0 ? undefined : ws[at];
      if (head?.expands === true) return null;
      const name = head === undefined ? "" : programName(head.text).toLowerCase();
      const eol = line.indexOf("\n", doc.end);
      const pipes = /(^|[^|])\|(?!\|)/.test(line.slice(doc.end, eol < 0 ? line.length : eol));
      docs.push({ doc, runs: head === undefined || SHELL_RUNNERS.has(name) || LAUNCHERS.has(name) || STDIN_RUNNERS.has(name) || pipes });
      i = doc.end - 1;
      continue;
    }
    if (c === "\n" && docs.length > 0) {
      for (const { doc: d, runs } of docs.splice(0)) {
        const { end } = hereDocBody(line, i, d);
        // An unquoted body still runs the substitutions it expands: it is no plain text either.
        if (!runs && d.literal) cuts.push([i + 1, end, ""]);
        i = end;
      }
      start = i + 1;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")" || c === "`") start = i + 1;
  }
  if (quote !== null) return null;
  let out = "";
  let at = 0;
  for (const [a, b, text] of cuts) { out += line.slice(at, a) + text; at = b; }
  return out + line.slice(at);
}

/** A program name at the end of a path (either separator), without a Windows `.exe`. */
function programName(word: string): string {
  return word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1).replace(/\.exe$/i, "");
}

/** git or gh as a word of their own, for a line that does not tokenise. */
const GIT_WORD = /(?:^|[\s;&|(`/\\])(?:git|gh)(?:\.exe)?(?=[\s;&|)`]|$)/i;

function isGitOrGh(word: string): boolean {
  const name = programName(word);
  return name === "git" || name === "gh";
}

/**
 * Whether a command line runs git or gh: a command at any command position
 * (after `;`, `&&`, `|`, a newline, a subshell, a substitution, assignments, a
 * redirection or a prefix such as `command`) whose name is git or gh, at any
 * path; either among the arguments of a launcher (`sudo git switch main`,
 * `timeout 30 git pull`); or either in a string a shell is handed (`bash -c
 * "git checkout -b x"`, `sudo sh -c "…"`). Naming either as an argument of
 * another command (`echo git push`) is not running it. A line that does not
 * tokenise, or nests shells deeper than the scan reads, counts when it holds
 * either as a word: the answer decides whether git's facts are read again, so
 * the safe side is yes.
 */
export function runsGitOrGh(line: string): boolean {
  return gitIn(line, 0);
}

function gitIn(line: string, depth: number): boolean {
  const segments = depth > MAX_SHELL_DEPTH ? null : commandSegments(line);
  if (segments === null) return GIT_WORD.test(line);
  return segments.some((segment) => {
    const ws = words(segment);
    const at = commandWordIndex(ws, COMMAND_INTRODUCERS);
    const head = at < 0 ? undefined : ws[at];
    if (head === undefined || head.expands) return false;
    if (isGitOrGh(head.text)) return true;
    if (LAUNCHERS.has(programName(head.text).toLowerCase()) && ws.slice(at + 1).some((w) => isGitOrGh(w.text))) return true;
    return shellStrings(ws, at).some((inner) => gitIn(inner.text, depth + 1) || (inner.powershell && GIT_WORD.test(inner.text)));
  });
}

/**
 * Why the model may not run this command — a manual signal or a person's
 * transition — or undefined. A command line is refused when one of its commands
 * (found at command position: after `;`, `&&`, `|`, a newline, a subshell, a
 * substitution, a prefix such as `env` or `command`, or a shell string such as
 * `bash -c "…"`, `pwsh -c "…"`, `sudo sh -c "…"` or `npx -c "…"`) runs gemflow —
 * a command called gemflow at any path, or one of the package runners and
 * interpreters given `@geml/gemflow` or its `cli` script — and the first
 * argument that is not an option is mark, unmark, advance, pause or resume, in any case (or
 * is built by expansion, so could be). Merely naming them (`echo gemflow
 * mark`, a commit message) is not a call. When the command word is built by
 * expansion, or the line does not tokenise, the line is refused if it holds
 * gemflow and one of the verbs as words.
 */
export function personOnlyRefusal(command: string): string | undefined {
  const verb = personVerb(command);
  return verb === undefined ? undefined : personOnlyReason(verb);
}

/** The read-only search commands: what a state that admits search may run through the shell where the host's search tools are the shell's. */
const SEARCH_COMMANDS: ReadonlySet<string> = new Set(["rg", "grep", "egrep", "fgrep", "ls", "find", "fd", "tree", "wc", "head", "tail"]);
/** find's actions that run a command, delete, or write a file. */
const FIND_ACTIONS: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** Whether one argument makes a search command run another program or write a file. */
function runsOrWrites(command: string, arg: string): boolean {
  switch (command) {
    case "find": return FIND_ACTIONS.has(arg);
    case "fd": return arg.startsWith("--exec") || /^-[^-]*[xX]/.test(arg); // -x, -X, --exec, --exec-batch, and a cluster holding either (-Hx)
    case "rg": return arg === "--pre" || arg.startsWith("--pre="); // a preprocessor runs for every file searched
    case "tree": return /^-[^-]*o/.test(arg); // -o writes the listing to a file
    default: return false;
  }
}

/** A redirection that writes no file: a descriptor copied or closed (`2>&1`, `>&-`), or `/dev/null`; matched at a `>`. */
const QUIET_REDIRECT = />(?:&(?:\d+|-)|[ \t]*\/dev\/null)(?=[ \t|&;)]|$)/y;

/**
 * The stages of a pipeline: the line split at each `|` outside quotes (`||` and
 * `|&` are left in place for simpleCommands to refuse). Null when a stage could
 * write a file — a `>` outside quotes that is not QUIET_REDIRECT — or runs a
 * substitution inside double quotes, which simpleCommands lets through (it
 * cannot change the status of the command it sits in, but it runs).
 */
function pipelineStages(line: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null; // ', " or $'
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    const next = line.charAt(i + 1);
    if (quote !== null) {
      if (quote === '"' && (c === "`" || (c === "$" && next === "("))) return null;
      cur += c;
      if (c === "\\" && quote !== "'" && i + 1 < line.length) cur += line.charAt(++i);
      else if (c === quote.slice(-1)) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c; cur += c;
    } else if (c === "$" && next === "'") {
      quote = "$'"; cur += "$'"; i++;
    } else if (c === "\\") {
      cur += c + next; i++;
    } else if (c === "|" && next !== "|" && next !== "&" && line.charAt(i - 1) !== "|" && line.charAt(i - 1) !== ">") {
      out.push(cur); cur = "";
    } else if (c === ">") {
      const prev = line.charAt(i - 1);
      QUIET_REDIRECT.lastIndex = i;
      const quiet = prev === "&" || prev === "<" || prev === ">" ? null : QUIET_REDIRECT.exec(line);
      if (quiet === null) return null;
      cur += quiet[0]; i += quiet[0].length - 1;
    } else {
      cur += c;
    }
  }
  if (quote !== null) return null;
  out.push(cur);
  return out;
}

/** One simple command that only searches: its first word a search command as written (no path, prefix, assignment or expansion), no word built by expansion, no argument that runs or writes. */
function searchesOnly(command: string): boolean {
  const ws = words(command);
  const head = ws[0];
  if (head === undefined || !SEARCH_COMMANDS.has(head.text) || ws.some((w) => w.expands)) return false;
  return ws.slice(1).every((w) => !runsOrWrites(head.text, w.text));
}

/**
 * Whether a command line does nothing but search: one or more stages joined by
 * `|`, each a plain `&&` chain (simpleCommands), every command in them one of
 * rg, grep, egrep, fgrep, ls, find, fd, tree, wc, head and tail, written as the
 * bare name, with no word built by expansion; no redirection that writes a
 * file (`2>&1` and `/dev/null` write none); find without -exec, -execdir,
 * -ok, -okdir, -delete, -fprint, -fprint0, -fprintf or -fls; fd without -x,
 * -X, --exec or --exec-batch; rg without --pre; tree without -o. Claude Code's
 * native builds have no Grep or Glob, so where a state admits search and not
 * run, such a line through Bash is the search it admits.
 */
export function isSearchOnlyCommand(line: string): boolean {
  if (line.length > MAX_SIGNAL_COMMAND_LENGTH) return false;
  const stages = pipelineStages(line);
  if (stages === null) return false;
  return stages.every((stage) => {
    const commands = simpleCommands(stage);
    return commands !== null && commands.length > 0 && commands.every(searchesOnly);
  });
}

/** The builtins that move the shell to another directory. */
const DIRECTORY_CHANGERS: ReadonlySet<string> = new Set(["cd", "pushd", "popd", "chdir"]);

/** A directory change spelled as a word of its own, for a line that does not tokenise. */
const CHANGER_WORD = /(?:^|[\s;&|(`])(?:cd|pushd|popd|chdir)(?=[\s;&|)`]|$)/;

/** The arguments of the command whose command word is at `at`: every word after it but a redirection and the file a separate one names. */
function argumentsOf(ws: readonly Word[], at: number): Word[] {
  const out: Word[] = [];
  for (let i = at + 1; i < ws.length; i++) {
    const w = ws[i];
    if (w === undefined) break;
    const redirect = w.raw.match(REDIRECTION);
    if (redirect) { if (redirect[0].length === w.raw.length) i++; continue; }
    out.push(w);
  }
  return out;
}

/** How a Windows drive path starts: a letter, a colon and a separator (a drive-relative `C:x` is not one). */
const DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * An absolute path with its `.` and `..` segments folded and no trailing
 * separator, in one of two forms: POSIX (`/a/b`), or a Windows drive path
 * written with `/` (`C:/a/b`, and `C:/` for the drive's root), which Node's
 * path module reads on Windows. Undefined for any other path: a relative one,
 * a drive-relative one (`C:x`), a POSIX path holding a backslash.
 */
function absoluteNormal(path: string): string | undefined {
  const windows = DRIVE.test(path);
  if (!windows && (!path.startsWith("/") || path.includes("\\"))) return undefined;
  const prefix = windows ? `${path.charAt(0).toUpperCase()}:/` : "/";
  const out: string[] = [];
  for (const seg of path.slice(prefix.length).split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `${prefix}${out.join("/")}`;
}

/**
 * Where `cd <arg>` (or `pushd`, `chdir`) takes the shell from `from`: the
 * argument joined to `from` and folded the way the shell's logical `cd` folds
 * it (absoluteNormal). Undefined when the line does not say: `from` is no
 * absolute path, or the argument is built by expansion (`$`, a backtick), is
 * or begins with `~`, is `-` or another option, names a place on the
 * directory stack (`+1`), holds a glob character, or is drive-relative
 * (`C:x`, which depends on that drive's own current directory). From a drive
 * path, a POSIX argument is read as Git Bash reads it — `/c/x` is `C:/x` —
 * and any other (`/tmp`) is a place the line does not say.
 */
function cdTarget(from: string, arg: Word): string | undefined {
  const t = arg.text;
  if (arg.expands || arg.raw.includes("`") || t === "" || /^[~+-]/.test(t) || /[*?[]/.test(t)) return undefined;
  const here = absoluteNormal(from);
  if (here === undefined) return undefined;
  if (DRIVE.test(t)) return absoluteNormal(t);
  if (/^[A-Za-z]:/.test(t)) return undefined;
  if (t.startsWith("/")) {
    if (here.startsWith("/")) return absoluteNormal(t);
    const m = t.match(/^\/([A-Za-z])(?:\/(.*))?$/);
    return m ? absoluteNormal(`${m[1]!.toUpperCase()}:/${m[2] ?? ""}`) : undefined;
  }
  return absoluteNormal(`${here}/${t}`);
}

/** How one simple command moves the shell: undefined when it is no directory change; else where it goes from a directory, undefined where the line does not say (`popd`, no argument or several). */
function directoryMove(command: string): ((from: string) => string | undefined) | undefined {
  const ws = words(command);
  const at = commandWordIndex(ws);
  const head = at < 0 ? undefined : ws[at];
  if (head === undefined || head.expands || !DIRECTORY_CHANGERS.has(head.text)) return undefined;
  const args = argumentsOf(ws, at);
  const arg = args[0];
  if (head.text === "popd" || args.length !== 1 || arg === undefined) return () => undefined;
  return (from) => cdTarget(from, arg);
}

/** Whether one simple command is a directory change: cd, pushd, popd or chdir as its command word (past assignments and prefixes such as `builtin`). */
export function isDirectoryChange(command: string): boolean {
  return directoryMove(command) !== undefined;
}

/**
 * The directory each simple command of a plain `&&` chain (simpleCommands)
 * runs in: `startDir`, moved by every cd, pushd or chdir before it — a change
 * itself runs where the shell stood. From a change whose target the line does
 * not say (see cdTarget, and popd) on, the directory is undefined. Null for a
 * line that is no such chain. Paths are absolute, POSIX or a Windows drive
 * path, the latter in the `/` form absoluteNormal gives (`C:/a/b`); a start
 * directory in another form (a relative one) stands as given for the commands
 * before the first change, and every directory after one is unknown.
 */
export function commandDirs(line: string, startDir: string): (string | undefined)[] | null {
  const commands = simpleCommands(line);
  if (commands === null) return null;
  let dir: string | undefined = absoluteNormal(startDir) ?? startDir;
  return commands.map((command) => {
    const here = dir;
    const move = directoryMove(command);
    if (move !== undefined) dir = here === undefined ? undefined : move(here);
    return here;
  });
}

/**
 * Whether a command line moves its shell to another directory anywhere: cd,
 * pushd, popd or chdir as a command at any command position (after `;`, `&&`,
 * `|`, a newline, a subshell, a substitution, assignments or a prefix such as
 * `builtin`). A line that does not tokenise counts when it holds one as a word.
 */
export function changesDirectory(line: string): boolean {
  const segments = commandSegments(line);
  if (segments === null) return CHANGER_WORD.test(line);
  return segments.some((segment) => {
    const ws = words(segment);
    const at = commandWordIndex(ws, COMMAND_INTRODUCERS);
    const head = at < 0 ? undefined : ws[at];
    return head !== undefined && !head.expands && DIRECTORY_CHANGERS.has(head.text);
  });
}

/** A word that may name a file, and whether it holds a glob character: the shell, or the program, may read it as several files. */
export interface PathWord { text: string; glob: boolean }

/**
 * The words of one simple command after its command word that may name a
 * file: each argument, and the value of a `--name=value` option. Other
 * options, redirections and words built by expansion are left out.
 */
export function pathWords(command: string): PathWord[] {
  const ws = words(command);
  const at = commandWordIndex(ws);
  if (at < 0) return [];
  const out: PathWord[] = [];
  for (const w of argumentsOf(ws, at)) {
    if (w.expands || w.raw.includes("`")) continue;
    const option = w.text.startsWith("-");
    const eq = option ? w.text.indexOf("=") : -1;
    if (option && eq < 0) continue;
    const text = eq < 0 ? w.text : w.text.slice(eq + 1);
    if (text !== "") out.push({ text, glob: /[*?[]/.test(text) });
  }
  return out;
}

/** A word that is no option: what a branch, a start point or a path is written as here. */
const isOperand = (w: Word | undefined): w is Word => w !== undefined && w.text !== "" && !w.text.startsWith("-");

/** `git switch …` that only switches: `<branch>`, or `-c|-C|--create|--force-create <branch> [<start>]`. */
function switchOnly(args: readonly Word[]): boolean {
  const [a, b, c, ...more] = args;
  if (more.length > 0 || a === undefined) return false;
  if (["-c", "-C", "--create", "--force-create"].includes(a.text)) return isOperand(b) && (c === undefined || isOperand(c));
  return isOperand(a) && b === undefined;
}

/** `git checkout …` that only switches: `-b|-B <branch> [<start>]`, or `<branch>` when `isBranch` says it is an existing local branch. */
function checkoutOnly(args: readonly Word[], isBranch?: (name: string) => boolean): boolean {
  const [a, b, c, ...more] = args;
  if (more.length > 0 || a === undefined) return false;
  if (a.text === "-b" || a.text === "-B") return isOperand(b) && (c === undefined || isOperand(c));
  return isOperand(a) && b === undefined && isBranch !== undefined && isBranch(a.text);
}

/** `git worktree add [-b|-B <branch>] [--detach] <path> [<start>]`: the options before the operands, each at most once. */
function worktreeAddOnly(args: readonly Word[]): boolean {
  let branch = false, detach = false, i = 0;
  for (; i < args.length && args[i]!.text.startsWith("-"); i++) {
    const t = args[i]!.text;
    if ((t === "-b" || t === "-B") && !branch && isOperand(args[i + 1])) { branch = true; i++; }
    else if (t === "--detach" && !detach) detach = true;
    else return false;
  }
  const operands = args.slice(i);
  return (operands.length === 1 || operands.length === 2) && operands.every(isOperand);
}

/** One simple command that only switches the work item, its command word written bare (no path, prefix, assignment, redirection or expansion). */
function switchesOnly(command: string, isBranch?: (name: string) => boolean): boolean {
  const ws = words(command);
  if (ws.some((w) => w.expands || w.raw.includes("`") || REDIRECTION.test(w.raw))) return false;
  const [head, sub, ...rest] = ws;
  if (head?.text === "cd") return isOperand(sub) && rest.length === 0;
  if (head?.text !== "git" || sub === undefined) return false;
  if (sub.text === "switch") return switchOnly(rest);
  if (sub.text === "checkout") return checkoutOnly(rest, isBranch);
  if (sub.text === "worktree") return rest[0]?.text === "add" && worktreeAddOnly(rest.slice(1));
  return false;
}

/**
 * Whether a command line does nothing but switch the work item — the way out
 * of any state: a plain `&&` chain (simpleCommands)
 * every command of which is `git switch <branch>`, `git switch
 * -c|-C|--create|--force-create <branch> [<start>]`, `git checkout -b|-B
 * <branch> [<start>]`, `git checkout <branch>` when `isBranch` says the
 * branch is an existing local one (without `isBranch`, never), `git worktree
 * add [-b|-B <branch>] [--detach] <path> [<start>]` or `cd <path>`, written
 * as the bare words. Any other option (`-f`, `--force`, `--discard-changes`,
 * `--merge`, `--`, `git -C`) or operand, a redirection or an expansion makes
 * it no switch.
 */
export function switchesWorkItemOnly(line: string, isBranch?: (name: string) => boolean): boolean {
  if (line.length > MAX_SIGNAL_COMMAND_LENGTH) return false;
  const commands = simpleCommands(line);
  return commands !== null && commands.length > 0 && commands.every((c) => switchesOnly(c, isBranch));
}
