// Document symbols and folding ranges — both read from one `geml list --json`.
//
// This is the half of an editor Markdown gets from
// microsoft/vscode-markdown-languageservice, where "symbol" can only mean
// "heading" because Markdown has nothing else to name. GEML names every block,
// so the outline shows the table, the chart, the data block — and Go to Symbol
// (Ctrl+Shift+O) jumps by the same `#id` an agent would address.

import * as vscode from "vscode";
import { listUnits, rangeOf, type Unit } from "./cli.js";

// What a block's kind looks like as a symbol. The icon matters more than it
// sounds: it is how someone scanning a 600-line document finds the table they
// remember. Exported because workspace symbols (Ctrl+T) must use the same
// mapping — the same block wearing two different icons in two lists would be
// worse than no icon at all.
export function kindToSymbol(kind: string): vscode.SymbolKind {
  switch (kind) {
    case "heading": return vscode.SymbolKind.String;
    // A `view` (GEP-0012) publishes a relation, so it wears the relation icon:
    // someone scanning for "the table I remember" is looking for either, and a
    // derived one is the more likely of the two to be what they want to reach.
    case "table": case "view": return vscode.SymbolKind.Struct;
    case "data": return vscode.SymbolKind.Object;
    case "code": return vscode.SymbolKind.Function;
    case "math": return vscode.SymbolKind.Operator;
    case "diagram": return vscode.SymbolKind.Event;
    case "meta": return vscode.SymbolKind.Namespace;
    case "note": case "text": return vscode.SymbolKind.Field;
    case "embed": return vscode.SymbolKind.Interface;
    default: return vscode.SymbolKind.Key;
  }
}

// The label. A heading shows its text (that is what the reader remembers); any
// other block shows its address, because `#budget` IS the name of a table that
// has no title of its own.
function label(u: Unit): string {
  if (u.kind === "heading") return u.text?.trim() || u.address;
  return u.address;
}

// A heading's span covers its whole section, so blocks inside it are its
// children. Everything is built from the line ranges the CLI already computed —
// no second reading of the document's structure.
function nest(doc: vscode.TextDocument, units: Unit[]): vscode.DocumentSymbol[] {
  const roots: vscode.DocumentSymbol[] = [];
  // Stack of open containers, each with the unit whose span they own.
  const open: { unit: Unit; sym: vscode.DocumentSymbol }[] = [];

  for (const u of units) {
    const range = rangeOf(doc, u);
    const detail = u.kind === "heading" ? u.address : u.kind;
    const sym = new vscode.DocumentSymbol(label(u), detail, kindToSymbol(u.kind), range, range);

    // Pop containers this unit is not inside.
    while (open.length > 0) {
      const top = open[open.length - 1]!;
      const inside = (u.lines?.[0] ?? 0) >= (top.unit.lines?.[0] ?? 0)
        && (u.lines?.[1] ?? 0) <= (top.unit.lines?.[1] ?? 0)
        && u !== top.unit;
      if (inside) break;
      open.pop();
    }

    if (open.length > 0) open[open.length - 1]!.sym.children.push(sym);
    else roots.push(sym);

    // Only a heading owns a section that later blocks can fall into. A table's
    // span is the table; nothing nests inside it.
    if (u.kind === "heading") open.push({ unit: u, sym });
  }
  return roots;
}

export class GemlOutline implements vscode.DocumentSymbolProvider, vscode.FoldingRangeProvider {
  async provideDocumentSymbols(
    doc: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentSymbol[]> {
    const units = await listUnits(doc);
    if (units === null || token.isCancellationRequested) return [];
    return nest(doc, units);
  }

  async provideFoldingRanges(
    doc: vscode.TextDocument,
    _ctx: vscode.FoldingContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.FoldingRange[]> {
    const units = await listUnits(doc);
    if (units === null || token.isCancellationRequested) return [];
    const out: vscode.FoldingRange[] = [];
    for (const u of units) {
      const start = (u.lines?.[0] ?? 1) - 1;
      let end = Math.min(doc.lineCount - 1, (u.lines?.[1] ?? 1) - 1);
      // A heading's span runs to just before the next one, which usually means
      // it ends on the blank line separating them. Folding that away pushes the
      // next heading flush against the collapsed one; giving the blank back
      // keeps a folded document readable.
      while (end > start && doc.lineAt(end).isEmptyOrWhitespace) end--;
      // A one-line block has nothing to fold; VS Code ignores start >= end
      // anyway, and filtering here keeps the gutter honest.
      if (end > start) out.push(new vscode.FoldingRange(start, end, vscode.FoldingRangeKind.Region));
    }
    return out;
  }
}
