/**
 * The files a shell command hands to `git commit` as its message: a draft
 * written for the commit, not for the person, so never one of the work
 * item's artifacts. `-F <file>`, `-F<file>`, `--file <file>` and
 * `--file=<file>` each name one; `-F -` (the message on stdin) names none. A
 * variable the same command assigns (`S=/tmp/x && git commit -F $S/msg.txt`)
 * is expanded; one it does not assign is left as written.
 */

/** A command segment's words as the shell reads them: quotes anywhere in a word keep its spaces and go. */
function wordsOf(segment: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: string | null = null;
  for (const c of segment) {
    if (quote !== null) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/** `$NAME` and `${NAME}` replaced by what the command assigned them. */
function expand(word: string, vars: ReadonlyMap<string, string>): string {
  return word.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, a: string | undefined, b: string | undefined) => vars.get(a ?? b ?? "") ?? whole);
}

/** The message files of every `git commit` in `command`, in order, variables expanded. */
export function commitMessageFiles(command: string): string[] {
  const vars = new Map<string, string>();
  const files: string[] = [];
  for (const segment of command.split(/&&|\|\|?|;|\r?\n/)) {
    const words = wordsOf(segment);
    let i = words[0] === "export" ? 1 : 0;
    for (; i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string); i++) {
      const w = words[i] as string;
      const eq = w.indexOf("=");
      vars.set(w.slice(0, eq), expand(w.slice(eq + 1), vars));
    }
    const git = words.indexOf("git", i);
    if (git < 0) continue;
    // The subcommand: the first word after git that is not one of git's own options (-C <dir>, -c <name=value>, --git-dir=…).
    let k = git + 1;
    while (k < words.length && (words[k] as string).startsWith("-")) k += words[k] === "-C" || words[k] === "-c" ? 2 : 1;
    if (words[k] !== "commit") continue;
    for (let j = k + 1; j < words.length; j++) {
      const w = words[j] as string;
      const file = w === "-F" || w === "--file" ? words[j + 1] : w.startsWith("--file=") ? w.slice("--file=".length) : /^-F./.test(w) ? w.slice(2) : undefined;
      if (file === undefined || file === "" || file === "-") continue;
      files.push(expand(file, vars));
    }
  }
  return files;
}
