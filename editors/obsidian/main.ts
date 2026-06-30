// Obsidian plugin: render GEML inside Obsidian, reusing the reference parser +
// the viewer's pure renderer (the same code path as the web playground). Two
// entry points:
//   1. a ```geml code-block processor — embed GEML in any note;
//   2. a file view for .geml files — open and read them rendered.
// Built with esbuild (see esbuild.config.mjs); "obsidian" is external.
import { Plugin, TextFileView, WorkspaceLeaf } from "obsidian";
import { parse } from "../../geml-parser/dist/geml.js";
import { renderDocument, viewerDiagnostics } from "../../geml-viewer/src/render.js";
import css from "../../geml-viewer/src/geml.css";

const VIEW_TYPE = "geml-view";

// Render GEML source into `el`: a diagnostics banner (broken references, etc.)
// followed by the rendered document.
function renderInto(el: HTMLElement, source: string): void {
  el.empty();
  const doc = parse(source);
  const diags = viewerDiagnostics(doc.diagnostics ?? []);
  if (diags.length) {
    const banner = el.createDiv({ cls: "geml-diags" });
    for (const d of diags) {
      banner.createDiv({
        cls: `geml-diag geml-diag-${d.severity}`,
        text: `${d.severity}: ${d.message} (line ${d.line})`,
      });
    }
  }
  el.appendChild(renderDocument(doc, el.ownerDocument));
}

class GemlView extends TextFileView {
  data = "";
  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.file?.basename ?? "GEML"; }
  getIcon(): string { return "file-code"; }
  getViewData(): string { return this.data; }
  setViewData(data: string, _clear: boolean): void { this.data = data; this.draw(); }
  clear(): void { this.data = ""; }
  draw(): void {
    this.contentEl.empty();
    this.contentEl.addClass("geml-doc");
    renderInto(this.contentEl, this.data);
  }
}

export default class GemlPlugin extends Plugin {
  private styleEl?: HTMLStyleElement;

  async onload(): Promise<void> {
    // Inject the viewer's document stylesheet (tables, geml-chart, notes, …).
    this.styleEl = document.createElement("style");
    this.styleEl.textContent = css;
    document.head.appendChild(this.styleEl);

    // 1. ```geml blocks inside notes.
    this.registerMarkdownCodeBlockProcessor("geml", (source, el) => {
      el.addClass("geml-doc");
      renderInto(el, source);
    });

    // 2. Opening a .geml file shows it rendered.
    this.registerView(VIEW_TYPE, (leaf) => new GemlView(leaf));
    try {
      this.registerExtensions(["geml"], VIEW_TYPE);
    } catch {
      // Another plugin already claims the .geml extension — the code-block
      // processor still works.
    }
  }

  onunload(): void {
    this.styleEl?.remove();
  }
}
