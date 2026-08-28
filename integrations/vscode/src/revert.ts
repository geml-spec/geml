// Revert one block to a past revision.
//
// This is the feature no Markdown editor can have, because it needs two things
// Markdown has not got: a stable address for a part of a document, and a history
// of that document keyed by it. `.gemlhistory` and `geml revert` supply both, so
// the editor's whole job here is to ask WHICH revision and show what is in it.
//
// It deliberately does NOT let the CLI write the file. `revert … -o -` prints the
// result instead, and that becomes one WorkspaceEdit: the change lands in the
// editor's own undo stack, which is where someone who has just reverted a block
// by accident will look for it.

import * as vscode from "vscode";
import * as path from "node:path";
import { isSafeId, listUnits, runCliOnFile, shellSafe, spawnCli, unitAt, wholeDocumentEdit, type Unit } from "./cli.js";

/** One row of `geml history get --json`. */
interface Revision {
  id: string;
  parent?: string;
  hash: string;
  offset: number;    // 0 = current, 1 = one back, …
  current?: boolean;
}

type Item = vscode.QuickPickItem & { rev: Revision };

/** Revision ids are timestamps plus a hex suffix; anything else is not one. */
const REV_ID = /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/;

/**
 * The filename is the one thing here that must go into argv — the directory
 * travels in cwd. Spaces and parentheses are handled; a name carrying shell
 * syntax is refused with a message rather than escaped.
 */
function shellSafeName(base: string): boolean {
  if (shellSafe(base)) return true;
  void vscode.window.showErrorMessage(
    `GEML: this file's name (${base}) contains characters that cannot be passed to the CLI safely. Rename the file, or use \`geml revert\` directly.`,
  );
  return false;
}

export async function revertBlock(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  if (!editor || !doc || doc.languageId !== "geml") return;

  if (doc.uri.scheme !== "file") {
    void vscode.window.showInformationMessage("GEML: a block's history lives beside the file on disk, so this needs a saved document.");
    return;
  }
  // `revert` reads the FILE and its sidecar, not the buffer. Applying its output
  // over a buffer with unsaved edits would silently drop those edits, so they
  // have to be resolved first — and saving is almost always what was meant.
  if (doc.isDirty) {
    const save = "Save and continue";
    const pick = await vscode.window.showWarningMessage(
      "GEML: reverting a block reads the file on disk, so unsaved changes would be lost.",
      { modal: true }, save,
    );
    if (pick !== save) return;
    if (!(await doc.save())) return;
  }

  const units = await listUnits(doc);
  if (units === null) {
    void vscode.window.showWarningMessage("GEML: could not read the document's blocks.");
    return;
  }
  const unit = unitAt(units, editor.selection.active.line);
  if (!unit) {
    void vscode.window.showInformationMessage("GEML: the cursor is not inside an addressable block.");
    return;
  }
  if (unit.id === undefined) {
    // `revert` addresses by id. A block without one has no name for its history
    // to be keyed by, and picking it out by position would revert whatever now
    // happens to sit there.
    void vscode.window.showInformationMessage(
      `GEML: \`${unit.address}\` has no id, and a revision is addressed by id. Give the block an {#id} to keep its history.`,
    );
    return;
  }
  if (!isSafeId(unit.id)) {
    void vscode.window.showInformationMessage(
      `GEML: \`#${unit.id}\` contains characters this command cannot pass to the CLI safely. Use \`geml revert\` directly.`,
    );
    return;
  }

  const base = path.basename(doc.uri.fsPath);
  if (!shellSafeName(base)) return;
  const history = await runCliOnFile(doc.uri, ["history", "get", base, "--json"]);
  if (history === null) return;
  if (history.code !== 0) {
    const why = history.stderr.trim().replace(/^error:\s*/, "");
    void vscode.window.showInformationMessage(
      `GEML: no history for this document${why ? ` — ${why}` : ""}. Run \`geml history save\` to start one.`,
    );
    return;
  }

  let revisions: Revision[];
  try {
    const parsed = JSON.parse(history.stdout);
    revisions = Array.isArray(parsed) ? parsed : [];
  } catch {
    void vscode.window.showWarningMessage("GEML: could not read the document's history.");
    return;
  }
  // The newest revision is the document as it stands; reverting to it is a no-op.
  const past = revisions.filter((r) => r.offset > 0 && REV_ID.test(r.id));
  if (past.length === 0) {
    void vscode.window.showInformationMessage("GEML: this document has only one saved revision, so there is nothing to revert to.");
    return;
  }

  const chosen = await pickRevision(doc, unit, base, past);
  if (!chosen) return;

  const out = await runCliOnFile(doc.uri, ["revert", base, `#${unit.id}`, "--rev", chosen.id, "-o", "-"]);
  if (out === null) return;
  if (out.code !== 0 || out.stdout.length === 0) {
    const why = out.stderr.trim().replace(/^error:\s*/, "") || "the CLI refused the revert";
    void vscode.window.showErrorMessage(`GEML: ${why}`);
    return;
  }

  const applied = await vscode.workspace.applyEdit(wholeDocumentEdit(doc, out.stdout));
  if (applied) {
    void vscode.window.setStatusBarMessage(`GEML: reverted #${unit.id} to ${chosen.id} — undo to put it back`, 5000);
  }
}

/**
 * Pick a revision, showing the block AS IT WAS in whichever one is highlighted.
 *
 * The preview is fetched only for the highlighted row: it costs two CLI calls
 * (the revision's document, then the one block out of it), and doing that for
 * every revision up front would make opening the list slow in exactly the
 * documents that have the most history.
 */
async function pickRevision(
  doc: vscode.TextDocument,
  unit: Unit,
  base: string,
  past: Revision[],
): Promise<Revision | undefined> {
  const items: Item[] = past.map((r) => ({
    rev: r,
    label: `${r.offset} revision${r.offset === 1 ? "" : "s"} back`,
    description: r.id,
    detail: "…",
  }));

  const qp = vscode.window.createQuickPick<Item>();
  qp.title = `Revert ${unit.address} in ${base}`;
  qp.placeholder = "Pick the revision to restore this block to";
  qp.items = items;
  qp.matchOnDescription = true;

  // One in-flight preview at a time; arrowing past a row abandons its fetch.
  let generation = 0;
  const preview = async (item: Item): Promise<void> => {
    const mine = ++generation;
    const text = await blockAt(doc, unit, base, item.rev.id);
    if (mine !== generation) return;
    item.detail = text ?? "(could not read this revision)";
    // Reassigning is how a QuickPick is told to redraw, and it keeps the
    // highlighted row where it is.
    const active = qp.activeItems;
    qp.items = [...items];
    qp.activeItems = active;
  };

  return new Promise<Revision | undefined>((resolve) => {
    qp.onDidChangeActive((active) => { if (active[0]) void preview(active[0]); });
    qp.onDidAccept(() => { const sel = qp.selectedItems[0]; qp.hide(); resolve(sel?.rev); });
    qp.onDidHide(() => { qp.dispose(); resolve(undefined); });
    qp.show();
  });
}

/**
 * Append the file as a new revision.
 *
 * The companion to the above, and not optional: without a `.gemlhistory` there
 * is nothing to revert to, and telling someone to go to a terminal to create one
 * is a poor answer from an editor. Saving a revision by hand is also the point —
 * these are checkpoints someone decided to keep, not an autosave.
 */
export async function saveRevision(): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.languageId !== "geml") return;
  if (doc.uri.scheme !== "file") {
    void vscode.window.showInformationMessage("GEML: a revision is written beside the file on disk, so this needs a saved document.");
    return;
  }
  const base = path.basename(doc.uri.fsPath);
  if (!shellSafeName(base)) return;
  // `history save` reads the file, so an unsaved buffer would be checkpointed at
  // its old contents — the opposite of what pressing this means.
  if (doc.isDirty && !(await doc.save())) return;

  const message = await vscode.window.showInputBox({
    title: `Save a revision of ${base}`,
    prompt: "An optional note, recorded with the revision",
    placeHolder: "why this checkpoint (optional)",
  });
  if (message === undefined) return;   // dismissed, as opposed to left empty

  const note = message.trim();
  // The note goes into argv, so it lives under the same rule as everything else.
  if (note.length > 0 && !shellSafe(note)) {
    void vscode.window.showErrorMessage(
      'GEML: that note contains characters that cannot be passed to the CLI safely (one of " % & ^ | < > ` $).',
    );
    return;
  }

  const args = ["history", "save", base, ...(note ? ["-m", note] : [])];
  const r = await runCliOnFile(doc.uri, args);
  if (r === null) return;
  if (r.code !== 0) {
    void vscode.window.showErrorMessage(`GEML: ${r.stderr.trim().replace(/^error:\s*/, "") || "could not save a revision"}`);
    return;
  }
  // "saved <id>", or the no-op line when the file matches the tip already.
  void vscode.window.setStatusBarMessage(`GEML: ${r.stdout.trim() || "revision saved"}`, 4000);
}

/** The block's source as of one revision, as a single line for the picker. */
async function blockAt(
  doc: vscode.TextDocument,
  unit: Unit,
  base: string,
  revId: string,
): Promise<string | undefined> {
  // `<rev>` is a POSITIONAL for `history get` — `--rev` belongs to `revert` and
  // `history` rejects it as an unknown flag.
  const at = await runCliOnFile(doc.uri, ["history", "get", base, revId]);
  if (at === null || at.code !== 0 || at.stdout.length === 0) return undefined;

  // The revision's whole document, then one block out of it — on stdin, so the
  // revision text never becomes a temporary file or an argument.
  const block = await spawnCli(["get", "-", `#${unit.id}`], {
    cwd: path.dirname(doc.uri.fsPath),
    input: at.stdout,
  });
  if (block === null || block.code !== 0) return undefined;
  const text = block.stdout.trim();
  if (text.length === 0) return "(the block did not exist in this revision)";
  // A QuickPick detail is one line; newlines would be dropped silently.
  return text.replace(/\s*\n\s*/g, " ⏎ ").slice(0, 300);
}
