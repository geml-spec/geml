// GEML VS Code extension. One rule throughout: nothing here parses GEML.
//
//   • TextMate highlighting  — declarative, see syntaxes/
//   • diagnostics            — `geml check --json`, into the Problems panel
//   • outline + folding      — `geml list --json`, see outline.ts
//   • preview pane           — the viewer's renderer, see preview.ts
//   • hover + go-to-def      — `geml list --json`, see navigate.ts
//   • rename an id (F2)      — `geml rename`, see rename.ts
//   • revert one block       — `geml revert`, see revert.ts
//   • save a revision        — `geml history save`, same file
//   • workspace symbols      — `geml find --json`, see symbols.ts
//   • copy a block's address — the index again, see below
//
// The CLI is the single source of truth, so the editor can never disagree with
// `geml check` in CI, and the pane can never disagree with what a reader sees.
// The single exception is refs.ts, which lexes a reference token to know what is
// under the cursor — a question no CLI verb answers.
import * as vscode from "vscode";
import { GemlOutline } from "./outline.js";
import { PreviewManager } from "./preview.js";
import { GemlNavigation } from "./navigate.js";
import { GemlRename } from "./rename.js";
import { GemlWorkspaceSymbols } from "./symbols.js";
import { revertBlock, saveRevision } from "./revert.js";
import { forgetUnits, listUnits, runCli, unitAt } from "./cli.js";

let diagnostics: vscode.DiagnosticCollection;

const GEML: vscode.DocumentSelector = { language: "geml" };

export function activate(context: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection("geml");
  context.subscriptions.push(diagnostics);

  const outline = new GemlOutline();
  const preview = new PreviewManager(context);

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const schedule = (doc: vscode.TextDocument): void => {
    if (doc.languageId !== "geml") return;
    const key = doc.uri.toString();
    const prev = timers.get(key);
    if (prev) clearTimeout(prev);
    timers.set(key, setTimeout(() => { timers.delete(key); void check(doc); }, 250));
  };

  const activeGeml = (): vscode.TextDocument | undefined => {
    const doc = vscode.window.activeTextEditor?.document;
    return doc?.languageId === "geml" ? doc : undefined;
  };

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(GEML, outline),
    vscode.languages.registerFoldingRangeProvider(GEML, outline),
    vscode.languages.registerHoverProvider(GEML, new GemlNavigation()),
    vscode.languages.registerDefinitionProvider(GEML, new GemlNavigation()),
    vscode.languages.registerRenameProvider(GEML, new GemlRename()),
    // Not language-scoped: Ctrl+T asks every provider, and this one answers with
    // blocks from every .geml in the workspace regardless of what is open.
    vscode.languages.registerWorkspaceSymbolProvider(new GemlWorkspaceSymbols()),
    preview.register(),

    vscode.commands.registerCommand("geml.showPreview", () => {
      const doc = activeGeml();
      if (doc) void preview.show(doc, false);
    }),
    vscode.commands.registerCommand("geml.showPreviewToSide", () => {
      const doc = activeGeml();
      if (doc) void preview.show(doc, true);
    }),
    vscode.commands.registerCommand("geml.copyBlockAddress", () => copyAddress("address")),
    vscode.commands.registerCommand("geml.copyBlockReference", () => copyAddress("reference")),
    vscode.commands.registerCommand("geml.revertBlock", () => revertBlock()),
    vscode.commands.registerCommand("geml.saveRevision", () => saveRevision()),

    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidChangeTextDocument((e) => {
      schedule(e.document);
      if (e.document.languageId === "geml") preview.changed(e.document);
    }),
    vscode.workspace.onDidSaveTextDocument(schedule),
    vscode.workspace.onDidCloseTextDocument((d) => { diagnostics.delete(d.uri); forgetUnits(d); }),
  );
  vscode.workspace.textDocuments.forEach(schedule);
}

/**
 * Copy the address of the block the cursor is in — either the address itself
 * (`#budget`, `## Heading`, `=== table`), which is what `geml get` and an agent
 * take, or a reference to it (`[[#budget]]`) to paste elsewhere in the document.
 *
 * This is the smallest possible feature and the one most worth having: the
 * address IS the interface to the format, and the alternative is scrolling up to
 * read an id off a block head and retyping it.
 */
async function copyAddress(as: "address" | "reference"): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "geml") return;

  const units = await listUnits(editor.document);
  if (units === null) {
    void vscode.window.showWarningMessage("GEML: could not read the document's blocks.");
    return;
  }
  const unit = unitAt(units, editor.selection.active.line);
  if (!unit) {
    void vscode.window.showInformationMessage("GEML: the cursor is not inside an addressable block.");
    return;
  }

  // A reference needs an id. A block addressed by type or position (`=== table`,
  // the second one) has no id to point at, and inventing one by writing to the
  // document is not what "copy" means.
  if (as === "reference" && unit.id === undefined) {
    void vscode.window.showInformationMessage(
      `GEML: \`${unit.address}\` has no id, so there is nothing to reference. Give the block an {#id} first.`,
    );
    return;
  }

  const text = as === "reference" ? `[[#${unit.id}]]` : unit.address;
  await vscode.env.clipboard.writeText(text);
  void vscode.window.setStatusBarMessage(`GEML: copied ${text}`, 3000);
}

export function deactivate(): void {
  diagnostics?.clear();
  diagnostics?.dispose();
}

async function check(doc: vscode.TextDocument): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("geml");
  if (!cfg.get<boolean>("check.enabled", true)) { diagnostics.delete(doc.uri); return; }

  // Through the shared layer, like everything else: one spawn path means one
  // place where the CLI is located, one "not installed" warning, and one set of
  // rules about what may reach a command line.
  const r = await runCli(doc, ["check", "--json", "-"]);
  if (r === null) return;

  let parsed: unknown;
  try { parsed = JSON.parse(r.stdout); } catch { return; }
  if (!Array.isArray(parsed)) return; // an error envelope ({error,code}), not diagnostics
  diagnostics.set(doc.uri, parsed.map((d) => toDiagnostic(doc, d as RawDiag)));
}

interface RawDiag { severity?: string; message?: string; line?: number; }

function toDiagnostic(doc: vscode.TextDocument, d: RawDiag): vscode.Diagnostic {
  const lineNo = Math.min(doc.lineCount - 1, Math.max(0, (typeof d.line === "number" ? d.line : 1) - 1));
  const range = doc.lineAt(lineNo).range;
  const severity = d.severity === "error" ? vscode.DiagnosticSeverity.Error
    : d.severity === "warning" ? vscode.DiagnosticSeverity.Warning
    : vscode.DiagnosticSeverity.Information;
  const diag = new vscode.Diagnostic(range, d.message ?? "GEML diagnostic", severity);
  diag.source = "geml";
  return diag;
}
