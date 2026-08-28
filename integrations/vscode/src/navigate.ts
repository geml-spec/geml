// Hover and go-to-definition for references.
//
// A reference is the one thing in a GEML document you cannot read: `[[#budget]]`
// tells you a block exists somewhere and nothing about what is in it. Hover
// shows it; F12 goes to it; Ctrl+click does the same because a definition
// provider is what Ctrl+click asks.
//
// Cross-document targets are opened as TextDocuments and indexed with the same
// `geml list -` every other feature uses. That is not only cache reuse: it keeps
// a path written inside a document out of argv, where `shell: true` on Windows
// would parse it.

import * as vscode from "vscode";
import * as path from "node:path";
import { listUnits, rangeOf, unitAt, unitById, type Unit } from "./cli.js";
import { refAt, type RefToken } from "./refs.js";

/** How much of a target block a hover will show before it stops being a hint. */
const MAX_LINES = 24;
const MAX_CHARS = 2000;

/** A reference's target: the document it lives in, and the block, if both exist. */
interface Target {
  doc: vscode.TextDocument;
  unit?: Unit;
  /** Set when the reference named a document that could not be opened. */
  missingPath?: string;
}

async function resolve(from: vscode.TextDocument, ref: RefToken): Promise<Target | undefined> {
  let doc = from;

  if (ref.path !== undefined) {
    // Relative to the referring document's directory — the same base the CLI
    // uses when no --root widens it, so the editor and `geml check` agree about
    // what resolves.
    if (from.uri.scheme !== "file") return undefined;
    const target = vscode.Uri.file(path.resolve(path.dirname(from.uri.fsPath), ref.path));
    try {
      doc = await vscode.workspace.openTextDocument(target);
    } catch {
      return { doc: from, missingPath: ref.path };
    }
  }

  if (ref.id === undefined) return { doc };

  const units = await listUnits(doc);
  if (units === null) return { doc };
  return { doc, unit: unitById(units, ref.id) };
}

/** The target block's source, trimmed to something that fits in a hover. */
function excerpt(doc: vscode.TextDocument, unit: Unit): { text: string; truncated: boolean } {
  const range = rangeOf(doc, unit);
  let text = doc.getText(range);
  let truncated = false;

  const lines = text.split("\n");
  if (lines.length > MAX_LINES) { text = lines.slice(0, MAX_LINES).join("\n"); truncated = true; }
  if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); truncated = true; }
  return { text, truncated };
}

export class GemlNavigation implements vscode.HoverProvider, vscode.DefinitionProvider {
  async provideHover(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const ref = refAt(doc, pos);
    if (ref) return this.hoverRef(doc, ref, token);
    return this.hoverBlock(doc, pos, token);
  }

  /** Hovering a reference: show what it points at. */
  private async hoverRef(
    doc: vscode.TextDocument,
    ref: RefToken,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const target = await resolve(doc, ref);
    if (token.isCancellationRequested) return undefined;

    const md = new vscode.MarkdownString();
    md.isTrusted = false;

    if (target?.missingPath !== undefined) {
      md.appendMarkdown(`Document \`${target.missingPath}\` not found, relative to this file.`);
      return new vscode.Hover(md, ref.range);
    }
    if (!target) return undefined;

    const where = target.doc.uri.toString() === doc.uri.toString()
      ? ""
      : ` in \`${path.basename(target.doc.uri.fsPath)}\``;

    if (!target.unit) {
      if (ref.id === undefined) {
        md.appendMarkdown(`Document \`${path.basename(target.doc.uri.fsPath)}\`.`);
        return new vscode.Hover(md, ref.range);
      }
      // The CLI's diagnostics pass already flagged this in the Problems panel;
      // saying it here too is what the reader wants at the moment they look.
      md.appendMarkdown(`No block \`#${ref.id}\`${where}.`);
      return new vscode.Hover(md, ref.range);
    }

    const { text, truncated } = excerpt(target.doc, target.unit);
    md.appendMarkdown(`\`${target.unit.address}\` — ${target.unit.kind}${where}\n\n`);
    md.appendCodeblock(text, "geml");
    if (truncated) md.appendMarkdown(`\n_…truncated; ${target.unit.lines[1] - target.unit.lines[0] + 1} lines in all._`);
    return new vscode.Hover(md, ref.range);
  }

  /**
   * Hovering anywhere else: say how to address the block the cursor is in. The
   * address is the point of the format and the thing a reader most often wants
   * to copy, so it is worth surfacing without a command.
   */
  private async hoverBlock(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const units = await listUnits(doc);
    if (units === null || token.isCancellationRequested) return undefined;
    const unit = unitAt(units, pos.line);
    if (!unit) return undefined;
    // Only on the block's own head line. Everywhere else this would pop up over
    // ordinary prose on every pause of the mouse.
    if (unit.lines[0] - 1 !== pos.line) return undefined;

    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.appendMarkdown(`**${unit.address}** — ${unit.kind}, ${unit.lines[0]}–${unit.lines[1]}\n\n`);
    md.appendCodeblock(`geml get ${path.basename(doc.uri.fsPath)} '${unit.address}'`, "sh");
    return new vscode.Hover(md, rangeOf(doc, { ...unit, lines: [unit.lines[0], unit.lines[0]] }));
  }

  async provideDefinition(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location | undefined> {
    const ref = refAt(doc, pos);
    if (!ref) return undefined;
    const target = await resolve(doc, ref);
    if (!target || target.missingPath !== undefined || token.isCancellationRequested) return undefined;

    // A reference to a document with no fragment lands at its top.
    if (!target.unit) {
      if (ref.id !== undefined) return undefined;  // named a block that isn't there
      return new vscode.Location(target.doc.uri, new vscode.Position(0, 0));
    }
    // The head line, not the whole span: jumping to a heading should put the
    // cursor on the heading, not select its entire section.
    const head = target.unit.lines[0] - 1;
    return new vscode.Location(target.doc.uri, new vscode.Position(Math.max(0, head), 0));
  }
}
