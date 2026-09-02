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
import { embedDocPaths } from "./embeds";
import { buildPrompt, parseTranslations, cacheKey } from "./translate-host";

const VIEW_TYPE = "geml.preview";

/**
 * Extensions that register chat models. Named only to WAKE them: a provider is
 * lazily activated, so the first preview can ask before it has registered
 * anything, and `selectChatModels()` then answers [] on a machine that has one
 * installed. Any other provider still arrives through onDidChangeChatModels
 * below — this list is a nudge, not a whitelist.
 */
const PROVIDERS = ["github.copilot-chat", "github.copilot"];

/**
 * Cheap, fast and widely enabled first — translation is a small task asked many
 * times, and the expensive reasoning models are both wasted on it and the ones
 * an account is least likely to be entitled to. A family this list does not
 * name still gets tried, after these.
 */
const FAMILY_ORDER = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o", "gpt-4.1"];

/** How many models to try before giving up. One 400 is not "no translator". */
const MAX_ATTEMPTS = 4;

function byPreference(models: readonly vscode.LanguageModelChat[]): vscode.LanguageModelChat[] {
  const rank = (m: vscode.LanguageModelChat): number => {
    const i = FAMILY_ORDER.indexOf(m.family);
    return i < 0 ? FAMILY_ORDER.length : i;
  };
  return [...models].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_ATTEMPTS);
}

/**
 * The editor's chat models, waiting out that lazy activation: ask, wake what is
 * installed and ask again, then give a late registration a moment to land.
 */
async function chatModels(): Promise<vscode.LanguageModelChat[]> {
  let models = await vscode.lm.selectChatModels();
  if (models.length > 0) return models;

  for (const id of PROVIDERS) {
    const ext = vscode.extensions.getExtension(id);
    if (!ext || ext.isActive) continue;
    try { await ext.activate(); } catch { /* why it would not start is its business */ }
  }
  models = await vscode.lm.selectChatModels();
  if (models.length > 0) return models;

  return await new Promise((resolve) => {
    const finish = (m: vscode.LanguageModelChat[]): void => {
      clearTimeout(timer);
      sub.dispose();
      resolve(m);
    };
    const sub = vscode.lm.onDidChangeChatModels(() => {
      void vscode.lm.selectChatModels().then((m) => { if (m.length > 0) finish(m); });
    });
    // Three seconds is a provider starting up, not a provider that is absent.
    const timer = setTimeout(() => finish([]), 3000);
  });
}

/** What the page asks for when a projection needs translating. */
interface TranslateRequest {
  type: "translate";
  id: number;
  target: string;
  texts: string[];
}

/** Per-panel bookkeeping: which document it shows, and whether it follows. */
interface Bound {
  panel: vscode.WebviewPanel;
  uri: vscode.Uri;
  /**
   * Absolute paths of the neighbouring files this panel last read for the page.
   * An edit to one of them has to repaint this panel: the webview has no
   * filesystem, so what it shows of a neighbour is only what we last handed it.
   */
  deps?: Set<string>;
}

export class PreviewManager {
  // One panel per document. Asking twice reveals the one that exists rather
  // than stacking duplicates of the same document.
  private readonly bound = new Map<string, Bound>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Session cache of model answers, keyed by `cacheKey(text, target)`. */
  private readonly translations = new Map<string, string>();
  /** In-flight snapshot requests, by id. */
  private readonly snapshots = new Map<number, (a: SnapshotAnswer) => void>();
  private nextSnapshot = 1;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /**
   * Freeze what the pane is showing, as Markdown beside the document.
   *
   * This is the only surface that can take a translated snapshot: `geml --to md`
   * expands the embeds but has no translator, so it exports the source language
   * and says so. Here the translation has already happened and — because the
   * page records what it PAINTED — the file matches the pane, including any
   * section the reader swapped back to its source.
   *
   * A section that never got translated is named rather than quietly frozen as
   * the source language: half a translation that does not say which half is
   * exactly the artifact this is meant to stop being made by accident.
   */
  async exportSnapshot(doc: vscode.TextDocument): Promise<void> {
    const b = this.bound.get(doc.uri.toString());
    if (!b) { void vscode.window.showWarningMessage("Open the GEML preview first — the snapshot is what that pane is showing."); return; }
    const id = this.nextSnapshot++;
    const answer = await new Promise<SnapshotAnswer | null>((resolve) => {
      this.snapshots.set(id, resolve);
      void b.panel.webview.postMessage({ type: "snapshot", id });
      setTimeout(() => { if (this.snapshots.delete(id)) resolve(null); }, 10000);
    });
    if (!answer) { void vscode.window.showErrorMessage("The preview did not answer."); return; }
    if (answer.why) { void vscode.window.showErrorMessage(`Nothing to export: ${answer.why}`); return; }

    const target = vscode.Uri.file(doc.uri.fsPath.replace(/\.geml$/i, "") + ".md");
    await vscode.workspace.fs.writeFile(target, Buffer.from(answer.md, "utf8"));
    const missed = answer.untranslated.length;
    const where = vscode.workspace.asRelativePath(target);
    if (missed === 0) { void vscode.window.showInformationMessage(`Wrote ${where}.`); return; }
    // Not a toast that scrolls away: a partial translation is a fact about the
    // file that was just written, and the reader has to be able to act on it.
    const list = answer.untranslated.map((u) => `  ${u.src || "(this document)"} — ${u.why}`).join("\n");
    void vscode.window.showWarningMessage(
      `Wrote ${where}, but ${missed} section(s) are still in the source language.`,
      { modal: true, detail: list },
    );
  }

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
      void this.post(existing.panel, doc);
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
        if (doc) void this.post(panel, doc);
        return;
      }
      // The page collected the strings a projection wants translated — the
      // parser's policy decided which — and this side has the only translator
      // available: the editor's own language model.
      if (msg?.type === "translate") {
        void this.translate(panel, msg as TranslateRequest);
        return;
      }
      // The pane answering "here is what I am showing" (see exportSnapshot).
      if (msg?.type === "snapshot-result") {
        const pendingSnap = this.snapshots.get(Number((msg as { id: number }).id));
        if (pendingSnap) { this.snapshots.delete(Number((msg as { id: number }).id)); pendingSnap((msg as { snap: SnapshotAnswer }).snap); }
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
    if (b) { this.schedule(key, b.panel, doc); return; }
    // Not a previewed document — but possibly one that a previewed document
    // embeds, and a pane showing yesterday's copy of the neighbour is worse
    // than one that says it cannot read it.
    for (const [hostKey, bound] of this.bound) {
      if (!bound.deps?.has(doc.uri.fsPath)) continue;
      const host = vscode.workspace.textDocuments.find((d) => d.uri.toString() === hostKey);
      if (host) this.schedule(hostKey, bound.panel, host);
    }
  }

  private schedule(key: string, panel: vscode.WebviewPanel, doc: vscode.TextDocument): void {
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.post(panel, doc);
    }, 150));
  }

  private async post(panel: vscode.WebviewPanel, doc: vscode.TextDocument): Promise<void> {
    const b = this.bound.get(doc.uri.toString());
    const embedded = await this.readEmbedded(doc, b);
    void panel.webview.postMessage({
      type: "render",
      text: doc.getText(),
      // The page keeps this in its saved state so a restored panel can say
      // which document it belongs to.
      uri: doc.uri.toString(),
      // The neighbours the page cannot read for itself — its bundle has no
      // filesystem — keyed by the path the document wrote, which is what the
      // renderer resolves against `geml-preview:/doc`.
      docs: embedded.docs,
      // What we would not read, and why, so the pane can say so instead of
      // letting the renderer imply the file is missing when it is merely big.
      skipped: embedded.skipped,
    });
  }

  /**
   * Translate for the page, through the editor's language model.
   *
   * The webview cannot do this itself: Chrome's built-in `Translator` is what
   * the browser extension uses and Electron has no such API, so without this the
   * preview shows a projection's source text under a note. GEP-0010 puts the
   * choice of backend with the host, and this host has a model the user already
   * has — no API key, no bundled weights.
   *
   * Answers are cached for the session, keyed by string and target: the preview
   * re-renders on a 150 ms debounce, and asking a model again for a sentence
   * that has not changed would be slow, costly and pointless. Persisting those
   * answers is a different question — one that belongs to the format, not to
   * this editor — and is deliberately not attempted here.
   */
  private async translate(panel: vscode.WebviewPanel, req: TranslateRequest): Promise<void> {
    const answer = async (result: Record<string, string> | { why: string }): Promise<void> => {
      void panel.webview.postMessage({ type: "translations", id: req.id, result });
    };
    const texts = Array.isArray(req.texts) ? req.texts.filter((t) => typeof t === "string") : [];
    const target = typeof req.target === "string" ? req.target : "";
    if (texts.length === 0 || target === "") { await answer({}); return; }

    // `engines` requires 1.90, where this API arrived, so the marketplace will
    // not offer the extension to an editor without it. The check stays for the
    // installs that bypass the marketplace — a sideloaded vsix, "Load unpacked"
    // — where the alternative is a TypeError inside a message handler.
    if (typeof vscode.lm?.selectChatModels !== "function") {
      await answer({ why: "this VS Code has no language model API (it arrived in 1.90)" });
      return;
    }

    const out: Record<string, string> = {};
    const missing: string[] = [];
    for (const t of texts) {
      const hit = this.translations.get(cacheKey(t, target));
      if (hit === undefined) missing.push(t);
      else out[t] = hit;
    }
    if (missing.length === 0) { await answer(out); return; }

    let models: vscode.LanguageModelChat[];
    try {
      models = await chatModels();
    } catch (e) {
      await answer({ why: `no language model available: ${String(e)}` });
      return;
    }
    if (models.length === 0) {
      // Distinguish the two, because the reader's next move differs: install a
      // provider, or sign in to the one already sitting there.
      const installed = PROVIDERS.some((id) => vscode.extensions.getExtension(id) !== undefined);
      // Each reason ends in the one page that fixes it, because the note the
      // reader sees renders a trailing https URL as a link they can click.
      await answer({
        why: installed
          ? "Copilot Chat is installed but offers no model — sign in from the Accounts icon in the Activity Bar, or check that your account has Copilot: https://github.com/settings/copilot"
          : "no language model provider is installed — install GitHub Copilot Chat, then reopen this preview: https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat",
      });
      return;
    }

    // One model saying no is not "no translator": the list holds models this
    // account may not use for this kind of request (a 400 model_not_supported),
    // so walk it in preference order and report only when all of them refuse.
    const prompt = buildPrompt(missing, target);
    const tried: string[] = [];
    let firstRefusal: string | null = null;
    let parsed: Record<string, string> | { why: string } = { why: "no model was asked" };

    for (const candidate of byPreference(models)) {
      tried.push(candidate.family || candidate.id);
      const cts = new vscode.CancellationTokenSource();
      let reply = "";
      try {
        const res = await candidate.sendRequest(
          [vscode.LanguageModelChatMessage.User(prompt)],
          { justification: "Translating a GEML projection for the preview pane." },
          cts.token,
        );
        for await (const part of res.text) reply += part;
      } catch (e) {
        // Consent declined, quota, offline, or this model not being available to
        // this token — try the next one, and keep the first reason to report.
        firstRefusal ??= (e as Error)?.message ?? String(e);
        continue;
      } finally {
        cts.dispose();
      }
      parsed = parseTranslations(reply, missing);
      if (!("why" in parsed)) break;      // a usable answer
      firstRefusal ??= parsed.why;         // answered, but unusably
    }

    if ("why" in parsed) {
      const detail = firstRefusal ?? parsed.why;
      await answer({ why: `the language model refused: ${detail} (tried ${tried.join(", ") || "nothing"})` });
      return;
    }
    for (const [text, translation] of Object.entries(parsed)) {
      this.translations.set(cacheKey(text, target), translation);
      out[text] = translation;
    }
    await answer(out);
  }

  /** A neighbour may be this big, and all of them together this big. */
  private static readonly PER_FILE_BYTES = 256 * 1024;
  private static readonly TOTAL_BYTES = 1024 * 1024;

  /**
   * Read the documents this one embeds, on its behalf.
   *
   * An OPEN buffer wins over the file on disk: while you edit two documents side
   * by side, the preview should show the edit next door, not its last save. The
   * caps exist because this runs on a 150 ms debounce — a generated document
   * must not turn every keystroke into a megabyte of reads.
   */
  private async readEmbedded(
    doc: vscode.TextDocument,
    bound: Bound | undefined,
  ): Promise<{ docs: Record<string, string>; skipped: string[] }> {
    const dir = path.dirname(doc.uri.fsPath);
    const docs: Record<string, string> = {};
    const skipped: string[] = [];
    const deps = new Set<string>();
    let total = 0;

    for (const rel of embedDocPaths(doc.getText())) {
      const target = path.resolve(dir, rel);
      // embedDocPaths already refuses absolute paths, schemes and `..`; this is
      // the second lock on the same door, where the resolved path is known.
      if (!target.startsWith(dir + path.sep)) { skipped.push(`${rel} (outside the document's folder)`); continue; }
      deps.add(target);

      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === target);
      let text: string;
      if (open) {
        text = open.getText();
      } else {
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target));
          if (bytes.byteLength > PreviewManager.PER_FILE_BYTES) { skipped.push(`${rel} (too large for the preview)`); continue; }
          text = new TextDecoder("utf-8").decode(bytes);
        } catch {
          skipped.push(`${rel} (not found)`);
          continue;
        }
      }

      const size = Buffer.byteLength(text, "utf8");
      if (size > PreviewManager.PER_FILE_BYTES) { skipped.push(`${rel} (too large for the preview)`); continue; }
      if (total + size > PreviewManager.TOTAL_BYTES) { skipped.push(`${rel} (over the preview's budget)`); continue; }
      total += size;
      docs[rel] = text;
    }

    if (bound) bound.deps = deps;
    return { docs, skipped };
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

export interface SnapshotAnswer {
  md: string;
  untranslated: { src: string; why: string }[];
  why: string | null;
}
