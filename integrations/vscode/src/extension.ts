// GEML VS Code extension: TextMate highlighting (declarative, see syntaxes/) +
// live diagnostics. Diagnostics are not a reimplementation of the parser — we
// shell out to `geml check --json` (the published reference CLI) and map its
// output into the Problems panel. The CLI is the single source of truth, so the
// editor can never disagree with `geml check` in CI.
import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as path from "node:path";

let diagnostics: vscode.DiagnosticCollection;
let warnedMissing = false;

export function activate(context: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection("geml");
  context.subscriptions.push(diagnostics);

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const schedule = (doc: vscode.TextDocument): void => {
    if (doc.languageId !== "geml") return;
    const key = doc.uri.toString();
    const prev = timers.get(key);
    if (prev) clearTimeout(prev);
    timers.set(key, setTimeout(() => { timers.delete(key); check(doc); }, 250));
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidSaveTextDocument(schedule),
    vscode.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri)),
  );
  vscode.workspace.textDocuments.forEach(schedule);
}

export function deactivate(): void {
  diagnostics?.clear();
  diagnostics?.dispose();
}

function check(doc: vscode.TextDocument): void {
  const cfg = vscode.workspace.getConfiguration("geml");
  if (!cfg.get<boolean>("check.enabled", true)) { diagnostics.delete(doc.uri); return; }

  const invocation = (cfg.get<string>("check.path", "geml") || "geml").trim().split(/\s+/);
  const bin = invocation[0]!;
  const args = [...invocation.slice(1), "check", "--json", "-"];
  // Run in the document's directory so cross-document references resolve.
  const cwd = doc.uri.scheme === "file" ? path.dirname(doc.uri.fsPath) : undefined;

  let proc;
  try {
    // shell:true on Windows so the `geml.cmd` shim resolves on PATH.
    proc = spawn(bin, args, { cwd, shell: process.platform === "win32" });
  } catch {
    return;
  }

  let out = "";
  proc.stdout.on("data", (d) => { out += d; });
  proc.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT" && !warnedMissing) {
      warnedMissing = true;
      void vscode.window.showWarningMessage(
        "GEML: the `geml` CLI was not found. Install it with `npm i -g @geml/geml`, " +
        "or set `geml.check.path` (for example `npx @geml/geml`).",
      );
    }
  });
  proc.on("close", () => {
    let parsed: unknown;
    try { parsed = JSON.parse(out); } catch { return; }
    if (!Array.isArray(parsed)) return; // an error envelope ({error,code}), not diagnostics
    diagnostics.set(doc.uri, parsed.map((d) => toDiagnostic(doc, d as RawDiag)));
  });
  proc.stdin.end(doc.getText());
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
