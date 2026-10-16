// How often each tool ran (the tools tab, 工具): the hooks module notes every
// call under its day, by the key the dictionary would give it, and keeps a
// week of days in the plugin's store. Pure and Node-free.

/** What a tool is, as the tools tab groups it. */
export type ToolGroup = "cli" | "file" | "mcp" | "skill" | "web" | "model" | "other";

/** Day (`YYYY-MM-DD`, local) → key → how many calls. */
export type UsageBook = Record<string, Record<string, number>>;

/** The tools that read or write files. */
const FILE_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "apply_patch", "MultiEdit"]);
const WEB_TOOLS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch"]);
const MODEL_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
/** The shells: a call's key is the command it runs. */
const SHELLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

/** Words that run the next one, not a tool of their own. */
const WRAPPERS: ReadonlySet<string> = new Set(["rtk", "sudo", "env", "time", "nohup", "command", "exec", "builtin", "do", "then", "else", "elif", "if", "while", "until", "!"]);
/** Commands that are no tool worth counting, and the shells' own words. */
const NOT_TOOLS: ReadonlySet<string> = new Set([
  "cd", "echo", "export", "set", "true", "false", "sleep", "printf", "pwd", "source",
  "for", "done", "fi", "case", "esac", "select", "function", "in", "return", "break", "continue", "exit", "foreach",
]);
/** Options that take the next word as their value, before a subcommand. */
const VALUED: ReadonlySet<string> = new Set(["-c", "-C", "--git-dir", "--work-tree", "--prefix", "-w", "--workspace", "--cwd", "--dir", "-R", "--repo"]);
/** Programs whose first word is a subcommand; the ones with two levels name both. */
const SUBCOMMANDS: ReadonlySet<string> = new Set(["git", "npm", "pnpm", "yarn", "bun", "deno", "cargo", "go", "docker", "kubectl", "npx", "uv", "pip", "dotnet", "mvn", "gradle", "make", "wrangler", "claude"]);
const TWO_LEVELS: ReadonlySet<string> = new Set(["gh"]);
/** A package runner's `run`: the script it runs names the command too. */
const RUNS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);

/** A command line's commands, as the dictionary keys them: `Bash(node --test)`, `Bash(git commit)`, `Bash(npm run build)`; one per simple command. */
export function commandHeads(command: string): string[] {
  const out: string[] = [];
  // Here-document bodies and quoted strings are data: what is left is the commands.
  const bare = command
    .replace(/\r\n?/g, "\n")
    .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, "")
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  // Each pipeline's first command: what comes after a pipe reads its output, it is no tool of its own.
  const commands = bare.split(/\n|&&|\|\||;|(?<![<>])&(?!>)/).map((part) => part.split("|")[0] ?? "");
  for (const segment of commands) {
    const words = segment.trim().split(/\s+/).filter((w) => w !== "");
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string) || WRAPPERS.has(words[i] as string))) i++;
    if (words[i] === "timeout") i += 2;
    const program = (words[i] ?? "").replace(/^.*[\\/]/, "").replace(/\.(exe|cmd)$/i, "");
    if (program === "" || NOT_TOOLS.has(program) || !/^[A-Za-z][A-Za-z0-9_.@:+-]*$/.test(program)) continue;
    const rest = words.slice(i + 1).filter((w) => !/^\d*[<>]/.test(w) && w !== '""');
    // The subcommand: the first plain word, past the options and the values of those that take one.
    let next: string | undefined;
    for (let j = 0; j < rest.length; j++) {
      const w = rest[j] as string;
      if (VALUED.has(w)) { j++; continue; }
      if (w.startsWith("-")) continue;
      if (/^[A-Za-z][\w:.-]*$/.test(w)) next = w;
      break;
    }
    let head = program;
    if (program === "node" || program === "python" || program === "python3") head = rest[0]?.startsWith("--") ? `${program} ${rest[0]}` : program;
    else if (SUBCOMMANDS.has(program) && next !== undefined) {
      head = `${program} ${next}`;
      if (RUNS.has(program) && next === "run") {
        const script = rest.slice(rest.indexOf("run") + 1).find((w) => /^[A-Za-z][\w:.-]*$/.test(w));
        if (script !== undefined) head = `${head} ${script}`;
      }
    } else if (TWO_LEVELS.has(program)) {
      const words2 = rest.filter((w) => /^[A-Za-z][\w:.-]*$/.test(w)).slice(0, 2);
      head = [program, ...words2].join(" ");
    }
    out.push(head);
  }
  return out;
}

/** The keys a tool call counts under: a shell's commands, an MCP server, a skill by name, else the tool's own name. */
export function usageKeys(tool: string, input: Record<string, unknown>): string[] {
  if (SHELLS.has(tool)) {
    const command = typeof input["command"] === "string" ? input["command"] : "";
    return commandHeads(command).map((h) => `${tool}(${h})`);
  }
  const mcp = tool.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
  if (mcp !== null) return [`mcp__${mcp[1]}__*`];
  if (tool === "Skill" && typeof input["skill"] === "string") return [`Skill(${input["skill"]})`];
  return [tool];
}

/** Which group a key belongs to. */
export function groupOf(key: string): ToolGroup {
  const tool = key.replace(/\(.*$/s, "");
  if (SHELLS.has(tool)) return "cli";
  if (key.startsWith("mcp__")) return "mcp";
  if (tool === "Skill") return "skill";
  if (FILE_TOOLS.has(tool)) return "file";
  if (WEB_TOOLS.has(tool)) return "web";
  if (MODEL_TOOLS.has(tool)) return "model";
  return "other";
}

/** A key as the tab shows it: a command as the command, an MCP server by its name, a skill by its name. */
export function keyWords(key: string): string {
  const call = key.match(/^([A-Za-z]+)\((.*)\)$/s);
  if (call !== null) return call[1] === "PowerShell" ? `${call[2]} · PowerShell` : (call[2] as string);
  const mcp = key.match(/^mcp__(.+?)__/);
  if (mcp !== null) return mcp[1] as string;
  return key;
}

/** A local day as the book keys it. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The book with one call noted under its day. */
export function noteUse(book: UsageBook, day: string, keys: readonly string[]): UsageBook {
  if (keys.length === 0) return book;
  const today = { ...(book[day] ?? {}) };
  for (const k of keys) today[k] = (today[k] ?? 0) + 1;
  return { ...book, [day]: today };
}

/** Two books as one: each day's counts added. */
export function mergeBooks(a: UsageBook, b: UsageBook): UsageBook {
  const out: UsageBook = { ...a };
  for (const [day, counts] of Object.entries(b)) {
    const merged = { ...(out[day] ?? {}) };
    for (const [k, n] of Object.entries(counts)) merged[k] = (merged[k] ?? 0) + n;
    out[day] = merged;
  }
  return out;
}

/** The book keeping only its last `days` days. */
export function pruneBook(book: UsageBook, days: number): UsageBook {
  const keep = Object.keys(book).sort().slice(-days);
  return Object.fromEntries(keep.map((d) => [d, book[d] as Record<string, number>]));
}

/** How many times each key ran in the last `days` days up to `now`. */
export function usesSince(book: UsageBook, nowIso: string, days: number): Record<string, number> {
  const now = new Date(nowIso);
  const wanted = new Set(Array.from({ length: days }, (_, i) => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i).toISOString())));
  const out: Record<string, number> = {};
  for (const [day, counts] of Object.entries(book)) {
    if (!wanted.has(day)) continue;
    for (const [k, n] of Object.entries(counts)) out[k] = (out[k] ?? 0) + n;
  }
  return out;
}

/** Commands that run tests: unclassified, they look like the flow's test or check use. */
const TEST_LIKE = /^(Bash|PowerShell)\((node --test|npx (vitest|jest|mocha|playwright test)|vitest|jest|mocha|pytest|python -m pytest|go test|cargo test|deno test|bun test|dotnet test|mvn test|gradle test|(npm|pnpm|yarn|bun) run test(:[\w-]+)?)\)$/;

/** The use an unclassified key looks like, among the flow's uses: a test runner as `test`, else `check`; nothing for anything else. */
export function guessUse(key: string, uses: readonly string[]): string | undefined {
  if (!TEST_LIKE.test(key)) return undefined;
  return uses.includes("test") ? "test" : uses.includes("check") ? "check" : undefined;
}
