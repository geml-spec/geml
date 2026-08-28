// F2 on an id: rename it and every reference to it.
//
// `geml rename` already does this and does it better than a text search would —
// it is id-boundary safe (`#budget` is not touched inside `#budget-2`), it
// updates all four §5.2 reference forms plus `src=` on a block head, and it
// REFUSES rather than write a document that would stop parsing. So this provider
// does not compute edits; it asks the CLI for the renamed document and hands the
// result to VS Code as one edit.
//
// The buffer goes in on stdin, so an unsaved rename works. Note what that write
// guard means in an editor, because it is not obvious: for a `.geml` result the
// guard permits NO errors, pre-existing ones included. A document with one
// unresolvable cross-document reference therefore cannot have an unrelated id
// renamed until that is fixed. Nothing is written and the CLI says exactly why,
// so the failure is safe and legible — but it is a refusal the user has to be
// told about rather than left guessing at, hence showing its sentence verbatim.
// (Cross-document references DO resolve here: runCli runs in the document's own
// directory. `--root`, which would widen that to the workspace, is not passed
// yet — it would need the workspace path quoted into a shell command line.)

import * as vscode from "vscode";
import { isSafeId, listUnits, runCli, unitAt, wholeDocumentEdit } from "./cli.js";
import { idRangeOnLine, refAt } from "./refs.js";

/** What the cursor is sitting on: an id, and where its text is. */
interface Site { id: string; range: vscode.Range; }

async function siteAt(doc: vscode.TextDocument, pos: vscode.Position): Promise<Site | undefined> {
  // On a reference — the common case, and the one that needs no CLI call.
  const ref = refAt(doc, pos);
  if (ref?.id !== undefined && ref.idRange) return { id: ref.id, range: ref.idRange };

  // On the block's own head, where the id is declared. The id comes from the
  // CLI's index; refs.ts only locates it on the line.
  const units = await listUnits(doc);
  if (units === null) return undefined;
  const unit = unitAt(units, pos.line);
  if (!unit?.id || unit.lines[0] - 1 !== pos.line) return undefined;
  const range = idRangeOnLine(doc, pos.line, unit.id);
  // A heading with a DERIVED id has no `#id` text on the line to rename: the id
  // is a function of the heading's words (§4). Renaming it means editing the
  // heading, or giving it an explicit `{#id}` — not something to do behind the
  // user's back, so decline and say why.
  if (!range) {
    throw new Error(
      `\`#${unit.id}\` is derived from this heading's text, so there is no id here to rename. ` +
      `Edit the heading, or give it an explicit {#id} first.`,
    );
  }
  return { id: unit.id, range };
}

export class GemlRename implements vscode.RenameProvider {
  async prepareRename(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<{ range: vscode.Range; placeholder: string }> {
    const site = await siteAt(doc, pos);
    // The thrown message is what VS Code shows in the rename box, which is why
    // these read as sentences.
    if (!site) throw new Error("There is no GEML id here to rename.");
    if (!isSafeId(site.id)) {
      throw new Error(`\`#${site.id}\` contains characters this command cannot pass to the CLI safely. Rename it with \`geml rename\` directly.`);
    }
    return { range: site.range, placeholder: site.id };
  }

  async provideRenameEdits(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    newName: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.WorkspaceEdit | undefined> {
    const site = await siteAt(doc, pos);
    if (!site) return undefined;

    // A user can type anything into the rename box, so it is checked exactly as
    // strictly as the id read out of the document.
    const wanted = newName.trim().replace(/^#/, "");
    if (!isSafeId(wanted)) {
      void vscode.window.showErrorMessage(
        `GEML: \`${newName}\` is not a usable id here — letters, digits, \`-\`, \`_\`, \`.\` and \`:\` only.`,
      );
      return undefined;
    }
    if (wanted === site.id) return undefined;
    if (!isSafeId(site.id)) return undefined;   // prepareRename said so; belt for a direct call

    const r = await runCli(doc, ["rename", "-", `#${site.id}`, `#${wanted}`]);
    if (r === null || token.isCancellationRequested) return undefined;

    if (r.code !== 0 || r.stdout.length === 0) {
      // The CLI refuses any rename whose result would not be a clean document —
      // a duplicate id, a dangling reference, or an error that was already there.
      // Its sentence is the explanation, and it is better than anything this
      // extension could invent.
      const why = r.stderr.trim().replace(/^error:\s*/, "") || "the CLI refused the rename";
      const hint = /cannot resolve|unresolved/.test(why)
        ? " — fix the problems in this document first (see the Problems panel)"
        : "";
      void vscode.window.showErrorMessage(`GEML: ${why}${hint}`);
      return undefined;
    }

    // One edit over the whole document. The CLI returns the finished text and is
    // the only thing that knows every site; reconstructing minimal edits from it
    // would mean diffing its output against the buffer to arrive back at what it
    // already told us, with a chance of getting it wrong.
    return wholeDocumentEdit(doc, r.stdout);
  }
}
