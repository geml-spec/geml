// Ctrl+T across the workspace: find a block in any document, by address.
//
// `geml find <pattern> <dir> --json` already answers this, and it answers it in
// the currency that matters — `file#address`, something you can paste into
// `geml get` — rather than a line number. So the provider is a thin mapping onto
// SymbolInformation.
//
// The directory is passed as `.` with the workspace folder in cwd. That is not a
// style choice: a folder path like `C:\work\a&b` in argv reaches a shell on
// Windows, where `&` runs a command.
//
// One thing to be clear about, because it differs from a code language's Ctrl+T:
// `geml find` matches block CONTENT, not just names. For prose that is the more
// useful of the two — block ids are rarely what you remember, sentences are — so
// results whose ADDRESS matches the query are ranked first and the rest follow.

import * as vscode from "vscode";
import { shellSafe, spawnCli } from "./cli.js";
import { kindToSymbol } from "./outline.js";

/** One row of `geml find --json`. */
interface Hit {
  file: string;             // relative to the searched directory
  address: string;
  kind: string;
  lines: [number, number];
}

// Below this, a query matches most of a document and the list is noise. VS Code
// calls the provider on every keystroke from the first character.
const MIN_QUERY = 2;
// A guard on the reply, not on the search: a one-word query in a big repo can
// match thousands of blocks, and every one of them becomes a row in the picker.
const MAX_HITS = 500;

export class GemlWorkspaceSymbols implements vscode.WorkspaceSymbolProvider {
  async provideWorkspaceSymbols(
    query: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.SymbolInformation[]> {
    const q = query.trim();
    if (q.length < MIN_QUERY) return [];
    // A query is typed by the user, so it is not untrusted in the way a document
    // is — but it still has to go into argv, and `&` there is a command on
    // Windows. Refusing quietly is right: Ctrl+T is a live search, and a popup
    // per keystroke would be its own bug.
    if (!shellSafe(q)) return [];

    const folders = vscode.workspace.workspaceFolders ?? [];
    const perFolder = await Promise.all(folders.map((f) => this.search(f, q, token)));
    if (token.isCancellationRequested) return [];

    const all = perFolder.flat();
    // Address matches first — someone typing `budget` who means `#budget` should
    // not have to scroll past every paragraph that mentions the word.
    const needle = q.toLowerCase();
    all.sort((a, b) => rank(a, needle) - rank(b, needle));
    return all.slice(0, MAX_HITS);
  }

  private async search(
    folder: vscode.WorkspaceFolder,
    q: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.SymbolInformation[]> {
    if (folder.uri.scheme !== "file") return [];
    // `.` — the folder itself travels in cwd. `find` walks *.geml under it.
    // The token is passed on so that the search VS Code has already abandoned
    // (because another key was pressed) stops walking the tree.
    const r = await spawnCli(["find", q, ".", "--json"], { cwd: folder.uri.fsPath, token });
    // Exit 1 is "nothing matched", which is not an error.
    if (r === null || token.isCancellationRequested || r.stdout.length === 0) return [];

    let hits: Hit[];
    try {
      const parsed = JSON.parse(r.stdout);
      hits = Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }

    return hits.map((h) => {
      const uri = vscode.Uri.joinPath(folder.uri, ...h.file.split(/[\\/]/));
      const line = Math.max(0, (h.lines?.[0] ?? 1) - 1);
      return new vscode.SymbolInformation(
        h.address,
        kindToSymbol(h.kind),
        // The container is what VS Code shows to the right of the name; the file
        // is the useful thing to see when the same address exists in several.
        h.file,
        new vscode.Location(uri, new vscode.Position(line, 0)),
      );
    });
  }
}

/** Lower sorts earlier. */
function rank(sym: vscode.SymbolInformation, needle: string): number {
  const name = sym.name.toLowerCase();
  if (name === `#${needle}`) return 0;
  if (name.includes(needle)) return 1;
  return 2;
}
