// The one place this extension talks to the GEML CLI.
//
// Nothing here parses GEML. The CLI is the reference implementation and it
// already answers every question the editor needs to ask — `check --json` for
// diagnostics, `list --json` for the block index — so the editor's answers can
// never disagree with what `geml check` says in CI. An editor that shipped its
// own parser would be a second implementation of the one thing this format is
// about, and it would drift.

import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as path from "node:path";

let warnedMissing = false;

/** How the user has told us to invoke the CLI, split into argv. */
function invocation(): { bin: string; lead: string[] } {
  const cfg = vscode.workspace.getConfiguration("geml");
  const parts = (cfg.get<string>("check.path", "geml") || "geml").trim().split(/\s+/);
  return { bin: parts[0]!, lead: parts.slice(1) };
}

/**
 * The characters an id may contain for us to put it in argv.
 *
 * Stricter than shellSafe() below, and deliberately so: an id comes from the
 * DOCUMENT, which is untrusted, and a whitelist of what ids legitimately look
 * like is a tighter statement than a blacklist of what shells dislike.
 *
 * The set is exactly what §4's normative heading-derivation can produce —
 * Unicode letters, digits, `-`, `_` — plus `.` and `:`, which explicit ids
 * conventionally use for namespacing. An explicit `{#id}` carrying anything else
 * is legal GEML that this editor declines to rename; the CLI still can.
 */
const SAFE_ID = /^[\p{L}\p{N}_\-.:]+$/u;

export function isSafeId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && SAFE_ID.test(id);
}

const WIN = process.platform === "win32";

/**
 * Characters that cannot appear in an argument, because on Windows the argument
 * reaches a shell and these are syntax there — measured, not assumed:
 *
 *   `a&b.geml`  → cmd runs `b.geml` as a command       (injection)
 *   `a^b.geml`  → arrives as `ab.geml`                 (silent corruption)
 *   `a|b.geml`  → the command line breaks entirely
 *   `%PATH%`    → expands, even inside double quotes
 *
 * None of that is fixable by quoting: `%` expands inside quotes, and Node's own
 * argv quoter (which runs BEFORE cmd sees the line) only quotes for the CRT
 * parser, so `&` and `^` pass through bare.
 *
 * The answer is to keep such text out of argv at all. Every verb here is called
 * with the DIRECTORY in `cwd` — a spawn option, never parsed by a shell — and at
 * most a basename in argv. A basename with one of these characters is refused,
 * with a message, rather than escaped.
 */
const SHELL_HOSTILE = /["%&^|<>`$\r\n\t\0]/;

/** Whether an argument can go into a command line unchanged. */
export function shellSafe(arg: string): boolean {
  return !SHELL_HOSTILE.test(arg);
}

/**
 * Quote an argument that contains spaces, for the Windows shell only. On POSIX
 * there is no shell (spawn passes argv straight through), so a quote character
 * added here would arrive as part of the value.
 */
function forShell(arg: string): string {
  if (!WIN) return arg;
  return /[ \t]/.test(arg) ? `"${arg}"` : arg;
}

/** What a CLI run produced. */
export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI. `cwd` carries every directory; `args` must already have been
 * checked with shellSafe(). Pipes `input` on stdin when given — the verbs that
 * take `-` want the buffer, and the verbs that name a file must not be sent one.
 *
 * Resolves to null when the CLI could not be run at all: every caller has a
 * reasonable "then do nothing" behaviour, and a missing CLI must not turn into a
 * wall of error popups.
 */
export function spawnCli(
  args: string[],
  opts: { cwd?: string; input?: string; token?: vscode.CancellationToken },
): Promise<CliResult | null> {
  const { bin, lead } = invocation();

  const unsafe = args.find((a) => !shellSafe(a));
  if (unsafe !== undefined) {
    // A caller that reaches here has skipped its own check. Refusing beats
    // handing it to a shell, and it is a bug worth seeing in the log.
    console.error(`[geml] refusing to run: argument is not safe for a command line: ${JSON.stringify(unsafe)}`);
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    // Workspace symbols run this on every keystroke, so an abandoned search has
    // to actually stop rather than keep walking the tree until it finishes.
    const ac = new AbortController();
    const cancelled = opts.token?.onCancellationRequested(() => ac.abort());

    let proc;
    try {
      // shell:true on Windows so the `geml.cmd` shim resolves on PATH — there is
      // no .exe to spawn directly, and Node refuses a .cmd without a shell.
      proc = spawn(bin, [...lead, ...args.map(forShell)], { cwd: opts.cwd, shell: WIN, signal: ac.signal });
    } catch {
      cancelled?.dispose();
      resolve(null);
      return;
    }
    const done = (r: CliResult | null): void => { cancelled?.dispose(); resolve(r); };

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    // Kept because the write verbs report a refusal here ("id `x` already
    // exists; not written") and that sentence is the whole answer the user needs.
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", (e: NodeJS.ErrnoException) => {
      // An abort is this extension's own doing, not a broken installation.
      if (e.code === "ENOENT" && !ac.signal.aborted && !warnedMissing) {
        warnedMissing = true;
        void vscode.window.showWarningMessage(
          "GEML: the `geml` CLI was not found. Install it with `npm i -g @geml/geml`, " +
          "or set `geml.check.path` (for example `npx @geml/geml`).",
        );
      }
      done(null);
    });
    proc.on("close", (code) => done(ac.signal.aborted ? null : { code, stdout, stderr }));

    proc.stdin.on("error", () => { /* the process died first; `error`/`close` reports it */ });
    if (opts.input !== undefined) proc.stdin.end(opts.input);
    else proc.stdin.end();
  });
}

/**
 * Run the CLI over a document's CURRENT buffer (unsaved edits included). `-` in
 * the args means stdin: the buffer as it is NOW, not the file as last saved. An
 * editor that linted the saved copy would report problems the author has already
 * fixed.
 */
export function runCli(doc: vscode.TextDocument, args: string[]): Promise<CliResult | null> {
  // The document's directory, so relative cross-document references resolve the
  // same way they do for `geml check` on the command line.
  const cwd = doc.uri.scheme === "file" ? path.dirname(doc.uri.fsPath) : undefined;
  return spawnCli(args, { cwd, input: doc.getText() });
}

/**
 * Run a verb that operates on a FILE ON DISK rather than the buffer — `revert`
 * reads its own history sidecar, `find` walks a directory. The directory goes in
 * cwd and only the basename in argv, which is what keeps a path like
 * `C:\work\a&b\notes.geml` from reaching a shell.
 */
export function runCliOnFile(uri: vscode.Uri, args: string[]): Promise<CliResult | null> {
  return spawnCli(args, { cwd: path.dirname(uri.fsPath) });
}

/**
 * Make a replacement text use the document's own line endings.
 *
 * The CLI edits source in place and leaves CRLF alone — measured, not assumed.
 * This guard means a future version that reserialised with LF would still not
 * silently convert a CRLF file's every line, which is the kind of whole-file diff
 * nobody wants to find in a rename commit.
 */
export function matchEol(doc: vscode.TextDocument, text: string): string {
  if (doc.eol !== vscode.EndOfLine.CRLF || text.includes("\r\n")) return text;
  return text.replace(/\n/g, "\r\n");
}

/** Replace a whole document with new text, as one undoable edit. */
export function wholeDocumentEdit(doc: vscode.TextDocument, text: string): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), matchEol(doc, text));
  return edit;
}

/** One row of `geml list --json`: a block and the address that reaches it. */
export interface Unit {
  address: string;          // pastes straight back into `geml get`
  kind: string;             // heading | note | table | view | code | data | meta | …
  lines: [number, number];  // 1-based, inclusive start .. exclusive-ish end
  id?: string;
  level?: number;           // headings only
  text?: string;            // headings only
  anon?: boolean;           // no id: addressed by type or content
}

// One CLI call per document version, shared by everything that needs the block
// index. Symbols and folding are asked for together and asked for often — VS
// Code re-requests both after every edit — and spawning two processes for one
// unchanged answer is the difference between smooth and visibly laggy on a long
// document. Keyed by version, so it can never serve a stale index.
const listCache = new Map<string, { version: number; units: Promise<Unit[] | null> }>();

/** The document's block index, or null when the CLI could not produce one. */
export function listUnits(doc: vscode.TextDocument): Promise<Unit[] | null> {
  const key = doc.uri.toString();
  const hit = listCache.get(key);
  if (hit && hit.version === doc.version) return hit.units;

  const units = runCli(doc, ["list", "-", "--json"]).then((r) => {
    if (r === null) return null;
    try {
      const parsed = JSON.parse(r.stdout);
      return Array.isArray(parsed) ? (parsed as Unit[]) : null;
    } catch {
      return null;   // an error envelope, or a broken document mid-keystroke
    }
  });
  // Cache the promise, not the result: two providers asking at the same moment
  // then share the one in-flight call instead of racing to start a second.
  listCache.set(key, { version: doc.version, units });
  return units;
}

/** Forget a document's cached index — called when it closes. */
export function forgetUnits(doc: vscode.TextDocument): void {
  listCache.delete(doc.uri.toString());
}

/**
 * The block that holds a line: the SMALLEST unit whose span contains it, which
 * is the rule `geml get <file> 'L27'` documents. Headings span their whole
 * section, so without "smallest" every line in a document would answer with its
 * top-level heading.
 */
export function unitAt(units: Unit[], line: number): Unit | undefined {
  const oneBased = line + 1;
  let best: Unit | undefined;
  for (const u of units) {
    const [a, b] = [u.lines?.[0] ?? 0, u.lines?.[1] ?? 0];
    if (oneBased < a || oneBased > b) continue;
    if (best === undefined || b - a < (best.lines[1] - best.lines[0])) best = u;
  }
  return best;
}

/** The unit bearing an id, if the document has one. */
export function unitById(units: Unit[], id: string): Unit | undefined {
  return units.find((u) => u.id === id);
}

/** Clamp a 1-based CLI line pair onto a range the editor will accept. */
export function rangeOf(doc: vscode.TextDocument, unit: Unit): vscode.Range {
  const last = Math.max(0, doc.lineCount - 1);
  const start = Math.min(last, Math.max(0, (unit.lines?.[0] ?? 1) - 1));
  const end = Math.min(last, Math.max(start, (unit.lines?.[1] ?? unit.lines?.[0] ?? 1) - 1));
  return new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
}
