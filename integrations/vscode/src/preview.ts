// The preview pane.
//
// The document is rendered INSIDE the webview, by the same renderer the browser
// extension and the playground use — so a keystroke costs one parse in the page,
// not a process spawn per keystroke, and the preview can never look different
// from what a reader sees. Diagnostics stay with the CLI (extension.ts, the
// Problems panel); this pane only draws.

import * as vscode from "vscode";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

const VIEW_TYPE = "geml.preview";

/** Per-panel bookkeeping: which document it shows, and whether it follows. */
interface Bound {
  panel: vscode.WebviewPanel;
  uri: vscode.Uri;
}

export class PreviewManager {
  // One panel per document. Asking twice reveals the one that exists rather
  // than stacking duplicates of the same document.
  private readonly bound = new Map<string, Bound>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** The directory the webview may load files from. */
  private get mediaRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.ctx.extensionUri, "media");
  }

  /**
   * Open (or reveal) the preview for a document. `beside` puts it in the column
   * next to the editor, the way Markdown's "Open Preview to the Side" does.
   */
  async show(doc: vscode.TextDocument, beside: boolean): Promise<void> {
    const key = doc.uri.toString();
    const existing = this.bound.get(key);
    if (existing) {
      existing.panel.reveal(beside ? vscode.ViewColumn.Beside : undefined, true);
      this.post(existing.panel, doc);
      return;
    }

    if (!(await this.bundleExists())) return;

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Preview ${path.basename(doc.uri.fsPath || doc.uri.path)}`,
      beside ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true } : vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // Nothing outside media/ is reachable, so a document can never talk the
        // pane into reading the workspace.
        localResourceRoots: [this.mediaRoot],
      },
    );
    this.adopt(panel, doc.uri);
    panel.webview.html = this.html(panel.webview);
  }

  /** Wire a panel (new, or restored after a window reload) to a document. */
  private adopt(panel: vscode.WebviewPanel, uri: vscode.Uri): void {
    const key = uri.toString();
    this.bound.set(key, { panel, uri });

    // Held per panel and released when it closes. Parking these in
    // ctx.subscriptions instead would keep every listener of every preview the
    // user ever opened alive until the window shuts.
    const owned: vscode.Disposable[] = [];

    owned.push(panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
      // The page asks for the buffer once it is ready; that is also the only
      // path a restored panel takes, so there is no separate first-load branch.
      if (msg?.type === "ready") {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
        if (doc) this.post(panel, doc);
      }
    }));

    owned.push(panel.onDidDispose(() => {
      this.bound.delete(key);
      const t = this.timers.get(key);
      if (t) { clearTimeout(t); this.timers.delete(key); }
      for (const d of owned) d.dispose();
    }));
  }

  /** Restore previews after a window reload. */
  register(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state: unknown) => {
        const raw = (state as { uri?: unknown } | undefined)?.uri;
        if (typeof raw !== "string") { panel.dispose(); return; }
        let uri: vscode.Uri;
        try { uri = vscode.Uri.parse(raw, true); } catch { panel.dispose(); return; }
        // A second panel for a document that already has one would be a
        // duplicate the user never asked for.
        if (this.bound.has(uri.toString())) { panel.dispose(); return; }
        // Same check a fresh panel gets: without the bundle the pane can only
        // sit there saying it is loading a renderer that will never arrive.
        if (!(await this.bundleExists())) { panel.dispose(); return; }
        panel.webview.options = { enableScripts: true, localResourceRoots: [this.mediaRoot] };
        this.adopt(panel, uri);
        panel.webview.html = this.html(panel.webview);
        // The document may not be open any more; opening it is what the user
        // meant by leaving the preview open across a reload.
        try { await vscode.workspace.openTextDocument(uri); } catch { /* gone; the page shows its saved copy */ }
      },
    });
  }

  /** An edit landed. Debounced, so a fast typist does not queue up renders. */
  changed(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const b = this.bound.get(key);
    if (!b) return;
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.post(b.panel, doc);
    }, 150));
  }

  private post(panel: vscode.WebviewPanel, doc: vscode.TextDocument): void {
    void panel.webview.postMessage({
      type: "render",
      text: doc.getText(),
      // The page keeps this in its saved state so a restored panel can say
      // which document it belongs to.
      uri: doc.uri.toString(),
    });
  }

  /**
   * The bundle is a build artifact, not a committed file — a fresh clone has to
   * build it once. Say so with the command to run instead of showing a pane
   * that waits forever for a renderer that will never arrive.
   */
  private async bundleExists(): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.mediaRoot, "geml-webview.js"));
      return true;
    } catch {
      void vscode.window.showErrorMessage(
        "GEML: the preview renderer has not been built. Run `npm --prefix integrations/geml-viewer run build:vscode`.",
      );
      return false;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, f));
    // Order matters: the published look, then KaTeX, then the theme bridge last
    // so it wins. 'unsafe-inline' for styles is Mermaid's requirement — it
    // injects its own <style> — and is not a hole a document can widen, since
    // script-src stays pinned to the nonce.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri("geml.css")}">
<link rel="stylesheet" href="${uri("katex.css")}">
<link rel="stylesheet" href="${uri("preview.css")}">
<title>GEML preview</title>
</head>
<body class="geml-body">
<p id="note" class="geml-preview-note" hidden></p>
<div id="doc" class="geml-doc"></div>
<script nonce="${nonce}" src="${uri("geml-webview.js")}"></script>
<script nonce="${nonce}" src="${uri("preview.js")}"></script>
</body>
</html>`;
  }
}

// A CSP nonce is the whole reason script-src can be this tight, so it comes from
// the CSPRNG rather than Math.random.
function makeNonce(): string {
  return randomBytes(16).toString("base64");
}
