// GEML reference renderer — P0 runtime: a GEML document -> one self-contained,
// interactive HTML artifact.
//
// What an agent hands a person is the `.geml` file. This runtime turns it into a
// page a browser can open and *use*: prose and headings, callouts, code, math,
// diagrams, tables you can sort and filter, and charts drawn as inline SVG
// straight from their bound table (no second copy of the data).
//
// Self-containment: the CSS, the table interactivity, and every chart are inlined
// into the single HTML file. Math (KaTeX) and Mermaid diagrams are the one
// exception. They load from a CDN, and only when the document actually uses them,
// so a document of prose, tables and charts is fully self-contained with zero
// network. Bundling those two engines offline is the next step (roadmap P0 #6).

import { type Block, type Document, type EmbedPart, nameKey, projectableInlines, selectEmbed } from "./geml.js";
import { type Inline, isSafeUrl } from "./inline.js";
import { type Align, type TableCell, type TableModel } from "./table.js";
import { type ChartModel } from "./chart.js";
import { type Value } from "./attrs.js";
import { graphStyleFromDoc, defaultGraphStyle, type GraphStyle } from "./graph-style.js";
import { translateBlocks, HELD_BACK, type Translator } from "./translate.js";

const PALETTE = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#ea580c"];

export interface RenderOptions {
  title?: string;
  source?: string; // source file name, shown in the footer
  // Hooks for the geml-code-graph embed (GEP-0003): load a sibling document's
  // source by path relative to the rendered file, and parse it. Supplied by the
  // CLI; without them an embed degrades to a plain note.
  loadDoc?: (relPath: string) => string | null;
  parseDoc?: (source: string) => Document;
  // GEP 0010 — the language axis. An `embed` names a TARGET (`lang=`); WHERE the
  // translation comes from is the host's, exactly as `format=mermaid` names a
  // language and not an implementation of it. Absent, `lang=` records the intent
  // and nothing is translated: rendering the source language is the correct
  // degradation, never an error.
  //
  // Until this existed the projection ran on the Markdown export path ALONE, so
  // `--to html` and the viewer — the view a reader actually looks at — expanded
  // the embed and showed the source language. A translated document is supposed
  // to be a view; it was a Markdown feature.
  translator?: Translator;
  // How many rows a table shows OPEN before the whole thing renders inside a
  // collapsed <details> (default 500). It bounds LAYOUT, not content: every row
  // and every data line reaches the HTML whatever this is set to, and there is
  // deliberately no option that can drop one — rendering is a conversion, and a
  // conversion that loses data is not one. It used to slice the extra rows away
  // and point at the document source for them, which is no help to a reader
  // holding only the HTML.
  tableRows?: number;
  // URL prefix where the parser's ESM dist is reachable from the rendered page
  // (e.g. "/_dist/" under `geml codemap serve`). When set, code-graph pages get
  // a module script that attaches live loaders: clicks swap views in place by
  // fetching sibling .geml documents instead of navigating between pages. The
  // static bootstrap still draws first, so this is pure enhancement — if the
  // script never loads, the page behaves like the offline output.
  liveGraph?: string;
  // URL prefix returning a mount's graph payload as JSON ({data, truncated} or
  // {error}); the document path is appended URL-encoded (serve uses
  // "/_graph?doc="). When set, mounts carry data-graph-src instead of a
  // multi-MB inline data-graph attribute AND the page render skips the graph
  // build entirely — the runtime fetches the payload after first paint. Only
  // for served pages: file:// cannot fetch, so offline output keeps inlining.
  graphSidecar?: string;
  // Return only the document's rendered markup — what the full page puts
  // inside <main> — with no doctype/html/head/body shell, no CDN script tags,
  // and no inline CSS/JS. For embedding into an existing layout (Astro,
  // Next.js, any SSG): include `pageAssets.css` once per site and
  // `pageAssets.js` once per page (tables' sort/filter); math and mermaid
  // rendering are the host page's concern in this mode.
  fragment?: boolean;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

export function esc(s: string): string {
  // C0 controls other than tab/LF/CR are not valid in HTML text and, passed
  // through verbatim, can desynchronize a downstream sanitizer, proxy or log
  // pipeline. §0.4 only normalizes NUL; a document can still carry the rest, and a
  // transclusion of a `.geml`-named binary carries a lot of them.
  return s.replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "�")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

// Build a `class="…"` value from document-author-controlled tokens. Class names
// are dropped to the HTML token charset ([A-Za-z0-9_-]) so a crafted `.class`
// (e.g. `.x" onmouseover="alert(1)`) cannot break out of the attribute, then the
// joined result is escAttr'd as well (defense-in-depth). §4.
function classAttr(tokens: string[]): string {
  const safe = tokens
    .map((t) => t.replace(/[^A-Za-z0-9_-]/g, ""))
    .filter((t) => t !== "");
  return escAttr(safe.join(" "));
}

// Maximum block-nesting depth the renderer will descend before bailing out with
// a diagnostic instead of overflowing the call stack (block()↔list()↔typed() are
// mutually recursive). 256 is far past any legitimate document yet well under the
// few-thousand-frame native stack limit. Kept in step with the parser's cap.
const MAX_NESTING = 256;

// ---------------------------------------------------------------------------
// Render context
// ---------------------------------------------------------------------------

// S5: how deep transclusions may nest before the renderer stops expanding and
// degrades to the reference link instead.
const EMBED_DEPTH_CAP = 8;

// Depth and cycle detection bound the SHAPE of a transclusion graph, never its
// total. A diamond is not a cycle, and the cycle key is `path#fragment`, so eight
// sections each embedding the next N times is eight distinct keys and N^8
// expansions: 1.5KB of input reached 402MB of output, and one step further died on
// an uncaught RangeError from string concatenation. These are the global budgets
// that actually bound it, checked before every expansion.
const EMBED_TOTAL_CAP = 1000;              // expansions per render
const EMBED_BYTES_CAP = 8 * 1024 * 1024;   // expanded bytes per render
const EMBED_DOC_BYTES_CAP = 4 * 1024 * 1024; // a single loaded document

// §9.5 requires a class token to be REDUCED to the identifier charset, not escaped
// — escaping keeps whatever was there. Only literals reach these call sites today,
// so this is about not letting that invariant rest on the caller.
function classAttrToken(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "-");
}

// Compose a target that is relative to `base` — itself relative to the rendered
// host file — into a path relative to that host. Pure string work on purpose:
// render.ts is bundled for the browser (the playground), so no node:path here.
// A scheme-bearing, protocol-relative or root-relative target is already
// absolute and passes through untouched.
function relJoin(base: string, target: string): string {
  if (base === "" || target === "" || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
  const out: string[] = [];
  for (const s of (base + "/" + target).split("/")) {
    if (s === "" || s === ".") continue;
    if (s === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}

function relDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

// S2: which blocks a fragment selects. No fragment is the whole document body
// (meta is frontmatter, not content). A heading id selects its whole SECTION —
// the heading plus everything up to the next heading at the same or a higher

// id -> label: a heading's text, a block's caption, else the id itself. Free of
// the render context so a TARGET document can be indexed the same way, which is
// what a cross-document auto-reference needs for its link text (§5.2).
function indexLabelsInto(blocks: Block[], into: Map<string, string>): void {
  for (const b of blocks) {
    if (b.kind === "heading") into.set(b.id ?? "", b.text);
    else if (b.kind === "block") {
      if (b.id) {
        const cap = b.attrs["caption"];
        into.set(b.id, typeof cap === "string" ? cap : (b.table?.caption ?? b.id));
      }
      if (b.children) indexLabelsInto(b.children, into);
    }
  }
}

export class RenderCtx {
  usedMath = false;
  usedMermaid = false;
  usedCodeGraph = false;
  private renderDepth = 0;
  // S5: the (path#fragment) chain currently being expanded, for cycle
  // detection and the depth cap. `embedDocs` is the chain of documents being
  // expanded — each with its path relative to the host, so relative targets inside
  // borrowed content compose through it (S4) and a fragment-only reference
  // resolves against the document it was written in.
  private embedStack: string[] = [];
  private embedDocs: { rel: string; children: Block[]; labels?: Map<string, string> }[] = [];
  // The global budgets, and a memo so a document is read and parsed at most once
  // per render — without it a 1.1KB corpus produced 21,845 filesystem reads and
  // 21,845 full re-parses, because every expansion loaded its target again.
  private embedCount = 0;
  private embedBytes = 0;
  private embedCache = new Map<string, Block[] | null>();

  private budgetExhausted(): string | null {
    if (this.embedCount >= EMBED_TOTAL_CAP) return `transclusion budget spent (${EMBED_TOTAL_CAP} expansions)`;
    if (this.embedBytes >= EMBED_BYTES_CAP) return `transclusion budget spent (${EMBED_BYTES_CAP} bytes)`;
    return null;
  }

  // One read and one parse per document per render, and a size ceiling so a huge
  // target cannot be expanded (or re-expanded) at all.
  private loadChildren(rel: string): Block[] | null {
    const hit = this.embedCache.get(rel);
    if (hit !== undefined) return hit;
    const { loadDoc, parseDoc } = this.opts;
    let children: Block[] | null = null;
    const src = loadDoc && parseDoc ? loadDoc(rel) : null;
    if (src !== null && src !== undefined && src.length <= EMBED_DOC_BYTES_CAP) children = parseDoc!(src).children;
    this.embedCache.set(rel, children);
    return children;
  }
  labels = new Map<string, string>(); // id -> link label for [[#id]] auto-refs

  constructor(private doc: Document, readonly opts: RenderOptions = {}) {
    this.indexLabels(doc.children);
  }

  // Codemap documents (meta declares module= / container=) are machine data:
  // their oversized tables fold shut by default. Everywhere else a big table
  // is still the document's CONTENT — it truncates for the DOM's sake but
  // stays visible.
  get isCodemapDoc(): boolean {
    for (const b of this.doc.children) {
      if (b.kind === "block" && b.type === "meta" && b.data) {
        return b.data["module"] !== undefined || b.data["container"] !== undefined;
      }
    }
    return false;
  }

  // Build the id -> label map: a heading's text, or a block's caption, or its id.
  private indexLabels(blocks: Block[]): void {
    indexLabelsInto(blocks, this.labels);
  }

  docTitle(): string | undefined {
    for (const b of this.doc.children) {
      if (b.kind === "block" && b.type === "meta" && b.data && typeof b.data["title"] === "string") {
        return b.data["title"] as string;
      }
    }
    for (const b of this.doc.children) if (b.kind === "heading") return b.text;
    return undefined;
  }

  // ----- inline -----

  inlines(ns: Inline[]): string {
    return ns.map((n) => this.inline(n)).join("");
  }

  private inline(n: Inline): string {
    switch (n.type) {
      case "text": return esc(n.value);
      case "emph": return `<em>${this.inlines(n.children)}</em>`;
      case "strong": return `<strong>${this.inlines(n.children)}</strong>`;
      case "strike": return `<del>${this.inlines(n.children)}</del>`;
      case "code": return `<code>${esc(n.value)}</code>`;
      case "math": this.usedMath = true; return `<span class="math">\\(${esc(n.value)}\\)</span>`;
      case "break": return "<br>\n";
      case "image": return this.media(n);
      case "link": return this.link(n);
      case "autoref": {
        // GEP 0011: a coordinate reference SAYS the value and POINTS at the
        // block that holds it — a cell has no anchor of its own. The parser
        // resolved both while checking the reference; this renderer, and the
        // three others, only read them.
        if (n.value !== undefined && n.base === undefined) return esc(n.value); // no block to link to
        const anchor = n.base ?? n.anchor;
        const href = n.doc ? `${relJoin(relDir(this.currentDocRel), n.doc).replace(/\.geml$/, ".html")}#${anchor}` : this.fragmentHref(anchor);
        // §5.2: an auto-reference takes its text from the target's caption or
        // heading. Across documents that means reading the target — which the
        // build can do, since an embed pulls whole sections through the same hook.
        // Inside borrowed content a fragment-only reference means an id of the
        // BORROWED document, so its label has to come from there too. Taking it
        // from `this.labels` showed the host's caption on a link whose destination
        // is the source document's block — a text/target mismatch the host controls.
        const label = n.value ?? (n.doc
          ? (this.remoteLabel(n.doc, n.anchor) ?? n.anchor ?? n.doc)
          : (this.currentLabels().get(n.anchor) ?? n.anchor));
        return `<a href="${escAttr(href)}">${esc(label)}</a>`;
      }
      // A coordinate projection is already resolved: the value goes in as text,
      // with no link and no expansion pass, because there is no block body to
      // pull — it is one cell, one key, one scalar.
      case "project": return n.value !== undefined ? esc(n.value) : this.projectInline(n);
      // Through fragmentHref like every other fragment-only reference: borrowed
      // content owns no anchors, so a bare `#ref` here landed on a same-named
      // footnote of the HOST — letting the host author choose what a borrowed
      // sentence's citation says.
      case "footnote": return `<sup class="fn"><a href="${escAttr(this.fragmentHref(n.ref))}">${esc(n.ref)}</a></sup>`;
    }
  }

  // S2/S3/S5: expand a transclusion in place, wrapped in a container carrying its
  // provenance. Every path that cannot expand falls back to a link to the target
  // with the reason visible — never silently blank, never a broken image.
  private transclude(b: Extract<Block, { kind: "block" }>, idAttr: string): string {
    const written = typeof b.attrs["src"] === "string" ? (b.attrs["src"] as string).trim() : "";
    if (written === "") return this.transclusionFallback("", idAttr, "invalid", "embed: missing `src=`");

    const hash = written.indexOf("#");
    const docPath = hash < 0 ? written : written.slice(0, hash);
    const anchor = hash < 0 ? undefined : written.slice(hash + 1);
    const { loadDoc, parseDoc } = this.opts;

    // A same-document target (`src=#id`) selects from the document CURRENTLY being
    // expanded, which inside borrowed content is the borrowed document, not the
    // host. And it takes a cycle key like any other: the slice a heading id
    // selects contains the embed that selected it, which is the smallest cycle
    // there is. Skipping the key here is what let a 7-line document expand into
    // 256 copies of itself, stopped only by the generic block-nesting guard.
    const rel = docPath === "" ? this.currentDocRel : relJoin(relDir(this.currentDocRel), docPath);
    const key = anchor === undefined ? rel : `${rel}#${anchor}`;

    if (this.embedStack.includes(key)) {
      return `<div class="transclusion transclusion-error"${idAttr} data-src="${escAttr(written)}">transclusion cycle: ${esc([...this.embedStack, key].join(" → "))}</div>`;
    }
    if (this.embedStack.length >= EMBED_DEPTH_CAP) {
      return this.transclusionFallback(written, idAttr, "too-deep", `transclusion depth cap (${EMBED_DEPTH_CAP}) reached`);
    }
    const spent = this.budgetExhausted();
    if (spent !== null) return this.transclusionFallback(written, idAttr, "too-large", spent);

    let children: Block[];
    if (docPath !== "" && !/\.geml$/i.test(docPath)) {
      // Same constraint the parser reports: an embed stands for a GEML document.
      // Parsing whatever else the target happens to contain injected its bytes
      // into the page as prose.
      return this.transclusionFallback(written, idAttr, "invalid", `\`${docPath}\` is not a GEML document`);
    }
    if (docPath === "") {
      children = this.currentDocChildren;
    } else {
      if (!loadDoc || !parseDoc) return this.transclusionFallback(written, idAttr, "unexpanded", "no document resolver");
      // Parsed on its own, so S4 holds for free: `{{key}}` inside borrowed content
      // interpolates against the SOURCE document's meta, never the host's. Read
      // through the cache: the same target is otherwise re-read and re-parsed once
      // per expansion.
      const loaded = this.loadChildren(rel);
      if (loaded === null) return this.transclusionFallback(written, idAttr, "unresolved", `cannot resolve document \`${docPath}\`, or it is too large`);
      children = loaded;
    }

    const asked = typeof b.attrs["part"] === "string" ? (b.attrs["part"] as string).trim() : "whole";
    const part: EmbedPart = asked === "head" || asked === "body" || asked === "intro" ? asked : "whole";
    const picked = selectEmbed(children, anchor, part);
    if (picked === null) {
      const what = docPath === "" ? `no \`${written}\` in this document` : `no \`#${anchor}\` in \`${docPath}\``;
      return this.transclusionFallback(written, idAttr, "unresolved", what);
    }

    // GEP 0010: the language axis, applied to the blocks this embed borrowed.
    // `translator="none"` holds the whole embed back, and no host translator at
    // all means the source language — both are renderings, not failures.
    const lang = typeof b.attrs["lang"] === "string" ? (b.attrs["lang"] as string) : undefined;
    const held = b.attrs["translator"] === HELD_BACK;
    const t = this.opts.translator;
    const shown = lang !== undefined && !held && t !== undefined
      ? translateBlocks(picked, lang, t)
      : picked;

    this.embedStack.push(key);
    this.embedDocs.push({ rel, children });
    try {
      return this.transclusionWrap(written, idAttr, shown);
    } finally {
      this.embedDocs.pop();
      this.embedStack.pop();
    }
  }

  // An inline projection: the target block's body, rendered here. Deliberately the
  // same machinery as the block form — the cycle stack, the depth cap, and the
  // document chain that drives S4 rebasing and the fragment-only rewrite — rather
  // than a second path that would have to be kept in step with it. A projected
  // phrase carrying a link is the normal case, so that rewrite matters more here.
  private projectInline(n: Extract<Inline, { type: "project" }>): string {
    const written = n.doc === undefined ? `#${n.anchor}` : `${n.doc}#${n.anchor}`;
    const { loadDoc, parseDoc } = this.opts;

    const rel = n.doc === undefined ? this.currentDocRel : relJoin(relDir(this.currentDocRel), n.doc);
    const key = `${rel}#${n.anchor}`;
    if (this.embedStack.includes(key)) return this.projectFallback(written, "error", "transclusion cycle");
    if (this.embedStack.length >= EMBED_DEPTH_CAP) return this.projectFallback(written, "too-deep", `depth cap (${EMBED_DEPTH_CAP})`);
    const spentHere = this.budgetExhausted();
    if (spentHere !== null) return this.projectFallback(written, "too-large", spentHere);

    let children: Block[];
    if (n.doc === undefined) children = this.currentDocChildren;
    else {
      if (!loadDoc || !parseDoc) return this.projectFallback(written, "unexpanded", "no document resolver");
      const loaded = this.loadChildren(rel);
      if (loaded === null) return this.projectFallback(written, "unresolved", "unresolvable document, or too large");
      children = loaded;
    }

    const got = projectableInlines(children, n.anchor);
    if (got === null || got === "not-inline") return this.projectFallback(written, "unresolved", "not inline content");

    this.embedStack.push(key);
    this.embedDocs.push({ rel, children });
    try {
      this.embedCount++;
      const inner = this.inlines(got.inlines);
      this.embedBytes += inner.length;
      return `<span class="transclusion-inline" data-src="${escAttr(written)}">${inner}</span>`;
    } finally {
      this.embedDocs.pop();
      this.embedStack.pop();
    }
  }

  private projectFallback(written: string, why: string, note: string): string {
    const hash = written.indexOf("#");
    const docPath = written.slice(0, hash);
    const href = docPath === "" ? written : relJoin(relDir(this.currentDocRel), docPath).replace(/\.geml$/, ".html") + written.slice(hash);
    const safe = isSafeUrl(href) ? href : "#";
    return `<span class="transclusion-inline transclusion-${classAttrToken(why)}" data-src="${escAttr(written)}" title="${escAttr(note)}">`
      + `<a href="${escAttr(safe)}">${esc(written)}</a></span>`;
  }

  // The document a transclusion is currently selecting from — the host until an
  // expansion is in progress. `rel` is its path relative to the rendered host, so
  // everything relative inside it composes through `relDir(rel)` (S4), and any
  // fragment-only reference resolves against that document's own page.
  private get currentDocRel(): string {
    return this.embedDocs.length === 0 ? "" : this.embedDocs[this.embedDocs.length - 1]!.rel;
  }

  private get currentDocChildren(): Block[] {
    return this.embedDocs.length === 0 ? this.doc.children : this.embedDocs[this.embedDocs.length - 1]!.children;
  }

  // Labels of the document currently being expanded, built on first use per frame.
  private currentLabels(): Map<string, string> {
    if (this.embedDocs.length === 0) return this.labels;
    const frame = this.embedDocs[this.embedDocs.length - 1]!;
    if (frame.labels === undefined) {
      frame.labels = new Map<string, string>();
      indexLabelsInto(frame.children, frame.labels);
    }
    return frame.labels;
  }

  // S9: borrowed content contributes no anchors to the host page. Two ids named
  // the same is invalid HTML, and an in-page link to one of them would land on
  // whichever the browser picked. The host keeps its own ids; a borrowed copy has
  // none, and references into it resolve against its source document instead.
  private idAttr(id: string | undefined): string {
    return id === undefined || this.embedDocs.length > 0 ? "" : ` id="${escAttr(id)}"`;
  }

  // A fragment-only reference (`#id`, `[[#id]]`) inside borrowed content means an
  // id of the BORROWED document. On the host page that anchor does not exist — or,
  // worse, a same-named host block silently answers for it — so it points at the
  // source document's page.
  // The label a target document gives an id, for a cross-document auto-reference.
  // Memoized per document: one page can reference the same document many times.
  private remoteLabels = new Map<string, Map<string, string>>();

  private remoteLabel(doc: string, anchor: string): string | undefined {
    const { loadDoc, parseDoc } = this.opts;
    if (!loadDoc || !parseDoc) return undefined;
    const rel = relJoin(relDir(this.currentDocRel), doc);
    let labels = this.remoteLabels.get(rel);
    if (labels === undefined) {
      labels = new Map<string, string>();
      const src = loadDoc(rel);
      if (src !== null) indexLabelsInto(parseDoc(src).children, labels);
      this.remoteLabels.set(rel, labels);
    }
    return labels.get(anchor);
  }

  private fragmentHref(anchor: string): string {
    const rel = this.currentDocRel;
    return rel === "" ? `#${anchor}` : `${rel.replace(/\.geml$/, ".html")}#${anchor}`;
  }

  private transclusionWrap(written: string, idAttr: string, picked: Block[]): string {
    this.embedCount++;
    const inner = picked.map((x) => this.block(x)).filter((s) => s !== "").join("\n");
    this.embedBytes += inner.length;
    return `<section class="transclusion"${idAttr} data-src="${escAttr(written)}">${inner}</section>`;
  }

  private transclusionFallback(written: string, idAttr: string, why: string, note: string): string {
    const hash = written.indexOf("#");
    const docPath = hash < 0 ? written : written.slice(0, hash);
    const frag = hash < 0 ? "" : written.slice(hash);
    const href = docPath === "" ? frag : relJoin(relDir(this.currentDocRel), docPath).replace(/\.geml$/, ".html") + frag;
    // Defence in depth: the parse layer already blanks an unsafe scheme (§9.5), so
    // this should be unreachable. It is here because a fallback that composes an
    // href from document text is exactly where a missed filter upstream becomes a
    // live `javascript:` link — the shape of the one Critical finding in review.
    const safe = isSafeUrl(href) ? href : "#";
    const link = written === "" ? "" : `<a href="${escAttr(safe)}">${esc(written)}</a> `;
    return `<div class="transclusion transclusion-${classAttrToken(why)}"${idAttr} data-src="${escAttr(written)}" title="${escAttr(note)}">`
      + `${link}<span class="transclusion-note">${esc(note)}</span></div>`;
  }

  private media(n: Extract<Inline, { type: "image" }>): string {
    const src = escAttr(relJoin(relDir(this.currentDocRel), n.src));
    if (n.as === "video") return `<video class="media" src="${src}" controls></video>`;
    if (n.as === "audio") return `<audio class="media" src="${src}" controls></audio>`;
    return `<img class="media" src="${src}" alt="${escAttr(n.alt)}">`;
  }

  private link(n: Extract<Inline, { type: "link" }>): string {
    let href = "#";
    if (n.href) href = n.href;
    else if (n.doc) href = `${relJoin(relDir(this.currentDocRel), n.doc).replace(/\.geml$/, ".html")}${n.anchor ? "#" + n.anchor : ""}`;
    else if (n.anchor) href = this.fragmentHref(n.anchor);
    const rel = typeof n.attrs["rel"] === "string" ? ` rel="${escAttr(n.attrs["rel"] as string)}"` : "";
    const target = typeof n.attrs["target"] === "string" ? ` target="${escAttr(n.attrs["target"] as string)}"` : "";
    return `<a href="${escAttr(href)}"${rel}${target}>${this.inlines(n.children)}</a>`;
  }

  // ----- blocks -----

  block(b: Block): string {
    // Guard the block()↔list()↔typed() mutual recursion so a pathologically
    // nested document degrades to a diagnostic rather than a RangeError.
    if (this.renderDepth >= MAX_NESTING) {
      return `<div class="render-error">block nesting too deep (max ${MAX_NESTING})</div>`;
    }
    this.renderDepth++;
    try {
      return this.blockInner(b);
    } finally {
      this.renderDepth--;
    }
  }

  private blockInner(b: Block): string {
    switch (b.kind) {
      case "hidden": return "";
      case "heading": {
        if (b.hidden) return "";
        const id = this.idAttr(b.id);
        const lvl = Math.min(6, Math.max(1, b.level));
        return `<h${lvl}${id}>${this.inlines(b.inlines)}</h${lvl}>`;
      }
      case "paragraph": {
        const html = this.inlines(b.inlines).trim();
        return html === "" ? "" : `<p>${html}</p>`;
      }
      case "list": return this.list(b);
      case "block": return this.typed(b);
    }
  }

  private list(b: Extract<Block, { kind: "list" }>): string {
    const tag = b.ordered ? "ol" : "ul";
    const start = b.ordered && b.start !== undefined && b.start !== 1 ? ` start="${b.start}"` : "";
    const isTask = b.items.some((it) => it.checked !== undefined);
    const items = b.items.map((it) => {
      let inner = this.inlines(it.inlines);
      if (b.loose) inner = `<p>${inner}</p>`;
      const box = it.checked === undefined ? "" : `<input type="checkbox" disabled${it.checked ? " checked" : ""}> `;
      const kids = (it.children ?? []).map((c) => this.block(c)).filter((s) => s).join("\n");
      const cls = it.checked === undefined ? "" : ' class="task"';
      return `  <li${cls}>${box}${inner}${kids ? "\n" + kids : ""}</li>`;
    }).join("\n");
    return `<${tag}${isTask ? ' class="task-list"' : ""}${start}>\n${items}\n</${tag}>`;
  }

  private typed(b: Extract<Block, { kind: "block" }>): string {
    if (b.hidden) return ""; // {hidden}: in the model, never rendered
    const raw = (b.raw ?? []).join("\n");
    const caption = typeof b.attrs["caption"] === "string" ? (b.attrs["caption"] as string) : undefined;
    const idAttr = this.idAttr(b.id);

    switch (b.type) {
      case "meta": return ""; // header metadata, not body content
      case "code": {
        const lang = typeof b.attrs["lang"] === "string" ? (b.attrs["lang"] as string) : "";
        const cls = lang ? ` class="language-${escAttr(lang)}"` : "";
        return `<pre${idAttr}><code${cls}>${esc(raw)}</code></pre>`;
      }
      case "embed": return this.transclude(b, idAttr);
      case "math":
        this.usedMath = true;
        return `<div class="math-block"${idAttr}>\\[${esc(raw)}\\]</div>`;
      case "note": {
        const classes = classAttr(["callout", b.type, ...b.classes]);
        const inner = (b.children ?? []).map((c) => this.block(c)).filter((s) => s).join("\n");
        return `<aside class="${classes}"${idAttr}>\n${inner}\n</aside>`;
      }
      case "text": {
        // Addressable prose (§3): flow children in a NEUTRAL container — the
        // block exists for its id/attrs, not for callout chrome (that's note).
        const inner = (b.children ?? []).map((c) => this.block(c)).filter((s) => s).join("\n");
        const classes = classAttr(["text", ...b.classes]);
        return `<div class="${classes}"${idAttr}>\n${inner}\n</div>`;
      }
      case "data": {
        // GEP-0005: the page shows a PREVIEW under the same row discipline
        // tables use (opts.tableRows, default 500) — the MODEL always keeps
        // everything. Direction follows the format's reading order: jsonl is
        // an append-log, so the newest (last) lines are the preview; json is
        // one value and reads from the top.
        const limit = this.opts.tableRows ?? 500;
        const src = typeof b.attrs["src"] === "string" ? (b.attrs["src"] as string) : undefined;
        const fmt = typeof b.attrs["format"] === "string" ? (b.attrs["format"] as string)
          : src !== undefined && /\.jsonl$/i.test(src) ? "jsonl" : "json";
        let lines = b.raw ?? [];
        if (lines.every((l) => l.trim() === "")) {
          if (b.value !== undefined) {
            // src= content loaded at build time: preview the canonical form.
            lines = fmt === "jsonl" && Array.isArray(b.value)
              ? b.value.map((v) => JSON.stringify(v))
              : JSON.stringify(b.value, null, 2).split("\n");
          } else if (src !== undefined) {
            // §9.4: a render-time source (http, or no resolver at build).
            const cap0 = caption ? `<figcaption>${esc(caption)}</figcaption>` : "";
            return `<figure${idAttr}><p class="table-note">external data <code>${esc(src)}</code> — loaded at render time</p>${cap0}</figure>`;
          }
        }
        // Overflow FOLDS; it is never dropped. `--to html` is a CONVERSION, and
        // a conversion that loses data is not one — the old behaviour kept the
        // first 500 lines and said "the complete data is in the document
        // source", which is no help at all to someone holding only the HTML.
        // The bound belongs to what is OPEN, not to what is present: the rest
        // sits in a collapsed <details>, so the page is exactly as short as
        // before and the block is complete. There is no ceiling above which
        // lines vanish again, because a <pre> is a single text node — the cost
        // of keeping them is bytes on disk, which is what not losing data
        // costs.
        const tail = fmt === "jsonl" && lines.length > limit;
        const shown = tail ? lines.slice(-limit) : lines.slice(0, limit);
        const rest = tail ? lines.slice(0, lines.length - shown.length) : lines.slice(shown.length);
        const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : "";
        const pre = (ls: string[]) => `<pre class="data-src" data-format="${escAttr(fmt)}">${esc(ls.join("\n"))}</pre>`;
        if (rest.length === 0) return `<figure${idAttr}>${pre(shown)}${cap}</figure>`;
        // jsonl reads as an append-log, so its open end is the NEWEST lines and
        // the fold holds the earlier ones, above; json reads from the top.
        const more = `<details class="data-more"><summary>${rest.length} ${tail ? "earlier" : "more"} line${rest.length === 1 ? "" : "s"} of ${lines.length}</summary>${pre(rest)}</details>`;
        return `<figure${idAttr}>${tail ? more + pre(shown) : pre(shown) + more}${cap}</figure>`;
      }
      case "table":
        return b.table ? this.table(b.table, b.id, caption) : `<p class="render-error">table failed to parse</p>`;
      case "diagram":
        return this.diagram(b, raw, caption);
      default: {
        // Unknown type: preserved as raw (spec §3). Show it, labelled.
        return `<figure${idAttr}><pre class="diagram-src" data-type="${escAttr(b.type)}">${esc(raw)}</pre>` +
          `<figcaption>unknown block type <code>${esc(b.type)}</code>; shown as raw</figcaption></figure>`;
      }
    }
  }

  private diagram(b: Extract<Block, { kind: "block" }>, raw: string, caption?: string): string {
    const idAttr = this.idAttr(b.id);
    const fmt = typeof b.attrs["format"] === "string" ? (b.attrs["format"] as string) : "";
    const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : "";

    if (fmt === "geml-chart") {
      if (b.chart) return `<figure class="chart"${idAttr}>${chartSvg(b.chart, caption)}${cap}</figure>`;
      return `<figure${idAttr}><p class="render-error">chart could not be built (see diagnostics)</p>${cap}</figure>`;
    }
    if (fmt === "geml-code-graph") {
      const src = typeof b.attrs["src"] === "string" ? (b.attrs["src"] as string) : "";
      return this.codeGraphFigure(src, idAttr, cap);
    }
    if (fmt === "mermaid") {
      this.usedMermaid = true;
      return `<figure${idAttr}><pre class="mermaid">${esc(raw)}</pre>${cap}</figure>`;
    }
    // graphviz / d2 / plantuml / vega-lite / unknown: no bundled engine yet.
    return `<figure${idAttr}><pre class="diagram-src" data-format="${escAttr(fmt)}">${esc(raw)}</pre>` +
      `<figcaption>${caption ? esc(caption) + " — " : ""}<code>${esc(fmt || "diagram")}</code> (no bundled renderer in this build)</figcaption></figure>`;
  }

  // geml-code-graph embed (GEP-0003): build the call-graph slice from the
  // codemap document `src` points at (roots/depth from ITS meta), embed the
  // data, and let the in-page runtime lay it out at draw time — that is what
  // makes click-to-re-root possible.
  codeGraphFigure(src: string, idAttr: string, cap: string): string {
    if (!src) {
      return `<figure class="code-graph"${idAttr}><p class="render-error">geml-code-graph: missing <code>src=</code></p>${cap}</figure>`;
    }
    if (this.opts.graphSidecar) {
      // Sidecar mode (served pages): don't build the slice here at all — the
      // page ships without the payload and the runtime fetches it from the
      // sidecar route after first paint. Errors surface in the mount then.
      this.usedCodeGraph = true;
      return `<figure class="code-graph"${idAttr}><div class="cg-mount" data-start="${escAttr(src)}"` +
        ` data-graph-src="${escAttr(this.opts.graphSidecar + encodeURIComponent(src))}"></div>${cap}</figure>`;
    }
    const r = buildCodeGraph(src, this.opts);
    if (r.error !== undefined) {
      return `<figure class="code-graph"${idAttr}><p class="render-error">geml-code-graph: ${esc(r.error)}</p>${cap}</figure>`;
    }
    this.usedCodeGraph = true;
    const note = r.truncated ? `<p class="cg-note">graph data capped at ${CG_MAX_NODES} nodes for this embed — the codemap documents themselves are complete</p>` : "";
    // data-start carries the slice's own document path so a live module
    // script (opts.liveGraph) can hook the mount without re-parsing the
    // multi-MB payload attribute.
    return `<figure class="code-graph"${idAttr}><div class="cg-mount" data-start="${escAttr(r.data!.start)}" data-graph="${escAttr(JSON.stringify(r.data))}"></div>${note}${cap}</figure>`;
  }

  private table(t: TableModel, id?: string, caption?: string): string {
    const idAttr = id ? ` id="${escAttr(id)}"` : "";
    const alignStyle = (a?: Align) => (a ? ` style="text-align:${a}"` : "");

    // Laying out tens of thousands of <table> rows OPEN freezes the page for
    // seconds, so a long table renders folded shut — the codemap's edge tables
    // (#calls / #called-by) are the ones that get there. Its #modules table is
    // the page's content, the inventory people came to scan and filter, so that
    // one stays open at any size.
    //
    // EVERY row is rendered. `tableRows` bounds what is OPEN, never what is
    // present: past it the whole table goes inside a collapsed <details>, which
    // costs the reader one click and costs the document nothing. It used to
    // slice the rows away and say the complete table was in the source, which
    // made `--to html` a lossy conversion of a table the model holds in full.
    const foldAbove = this.isCodemapDoc && id === "modules" ? Infinity : (this.opts.tableRows ?? 500);
    const allRows = t.rows;
    const rows = allRows;

    const thead = t.header
      ? `<thead><tr>${t.columns.map((col, c) => `<th${alignStyle(t.align[c])}>${esc(col)}</th>`).join("")}</tr></thead>`
      : "";

    const bodyRows = rows.map((row, r) => {
      const cells = row.map((cell, c) => {
        const cls = cell.computed ? ' class="computed"' : "";
        const sortVal = typeof cell.value === "number" ? ` data-sort="${cell.value}"` : "";
        return `<td${alignStyle(cell.align ?? t.align[c])}${cls}${sortVal}>${this.inlines(cell.inlines)}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    }).join("\n");

    const tfoot = t.summary
      ? `<tfoot><tr>${t.summary.map((cell, c) => {
          const sortVal = typeof cell.value === "number" ? ` data-sort="${cell.value}"` : "";
          return `<td${alignStyle(cell.align ?? t.align[c])}${sortVal}>${this.inlines(cell.inlines)}</td>`;
        }).join("")}</tr></tfoot>`
      : "";

    const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : "";
    const tools = `<div class="table-tools"><input class="table-filter" type="search" placeholder="Filter rows…" aria-label="Filter table rows"></div>`;
    if (allRows.length > foldAbove) {
      const summary = `${esc(id ? "#" + id : "table")} · ${allRows.length} rows`;
      return `<figure class="table-figure"${idAttr}><details><summary>${summary}</summary>${tools}` +
        `<div class="table-scroll"><table class="geml-table">${thead}<tbody>\n${bodyRows}\n</tbody>${tfoot}</table></div></details>${cap}</figure>`;
    }
    return `<figure class="table-figure"${idAttr}>${tools}` +
      `<div class="table-scroll"><table class="geml-table">${thead}<tbody>\n${bodyRows}\n</tbody>${tfoot}</table></div>${cap}</figure>`;
  }
}

// ---------------------------------------------------------------------------
// Charts: a ChartModel -> inline SVG (fully self-contained, no dependency)
// ---------------------------------------------------------------------------

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * pow;
}

// ---------------------------------------------------------------------------
// geml-code-graph (GEP-0003) — slice builder. Traverses the codemap profile's
// #calls tables from the target document's meta `entry`, across documents,
// depth-limited; the layered LAYOUT happens in the page runtime (draw time).
// ---------------------------------------------------------------------------

// Hard payload ceiling only — the VIEW paces itself: the runtime draws the
// first 600 by BFS order and offers "+600"/"all" to walk deeper. The data in
// the codemap documents is always complete regardless.
const CG_MAX_NODES = 4000;

interface CGNode {
  n: string; doc?: string; src?: string; leaf?: boolean | number; test?: boolean; acc?: boolean; more?: boolean; entry?: boolean;
  grp?: string[]; // grouped module view: a tree GROUP — click descends to this path
  ext?: number;   // grouped module view: external-dependency stub (dimmed)
}
interface CGData {
  start: string;
  depth: number;
  roots: string[];
  nodes: Record<string, CGNode>;
  edges: [string, string, string, string, string?][]; // [from, to, kind, confidence|count, endpoint?]
  // "modules" = the index document's aggregated module graph (one node per
  // container, click navigates to <container>.html); default = method flow.
  mode?: "modules";
  module?: string;  // the container's display name (meta module=), for the breadcrumb
  dir?: "up";       // caller-direction view (GEP-0003): edges callee -> caller
  focus?: string;   // the method a callers view is anchored on
  partial?: number; // 1 = reversed in-slice edges only (static-payload fallback)
  // Grouped module navigation: the index payload ships the RAW rows; every
  // level of the grouping tree is derived in the runtime (no refetch).
  mods?: { p: string; doc: string; m?: number }[];
  medges?: [string, string, number][];
  /** 显示期旋钮，来自 `_index/style.geml`（计划 D）。运行时读它而不是字面量。 */
  style?: GraphStyle;
  entryDocs?: string[];
  gpath?: string[]; // a derived view's position in the grouping tree
}

// Tiny posix-path helpers (no node:path dependency in the renderer).
function cgDir(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
function cgJoin(dir: string, rel: string): string {
  const parts = (dir ? dir.split("/") : []).concat(rel.split("/"));
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop(); else out.push(seg);
  }
  return out.join("/");
}

function buildCodeGraph(startRel: string, opts: RenderOptions, view?: { dir?: "up" | "down"; node?: string }): { data?: CGData; error?: string; truncated?: boolean } {
  if (!opts.loadDoc || !opts.parseDoc) return { error: "no document loader in this build (render via the geml CLI)" };
  const cache = new Map<string, Document | null>();
  const loadParsed = (rel: string): Document | null => {
    if (!cache.has(rel)) {
      const s = opts.loadDoc!(rel);
      cache.set(rel, s === null ? null : opts.parseDoc!(s));
    }
    return cache.get(rel)!;
  };
  const metaOf = (d: Document): Record<string, Value> => {
    for (const b of d.children) if (b.kind === "block" && b.type === "meta" && b.data) return b.data;
    return {};
  };
  const start = cgJoin("", startRel);
  // 显示期旋钮（计划 D）：`_index/style.geml`，与 `_index/foldings.geml` 并列。
  // 只读，不播种 —— 播种是 `codemap build` 的事，而且这里走的是 loadDoc 钩子，
  // 因此和其他兄弟文档一样受 CLI 设定的限制约束，不直接碰文件系统。
  // 文件不在就是默认值，也就是渲染器一直以来的行为。
  // 走 loadParsed 的缓存，和其他兄弟文档一视同仁 —— 否则"定向重建完全走缓存"
  // 这条既有不变量就被一次额外 fetch 破坏了。
  const styleDoc = loadParsed(cgJoin(cgDir(start), "_index/style.geml"));
  const graphStyle = styleDoc === null ? defaultGraphStyle() : graphStyleFromDoc(styleDoc);
  const doc0 = loadParsed(start);
  if (!doc0) return { error: `cannot load \`${startRel}\`` };
  const meta0 = metaOf(doc0);
  const entries = String(meta0["entry"] ?? "").split(/\s+/).filter(Boolean);

  // A codemap INDEX (meta declares container=) renders the MODULE-level
  // aggregation. The payload carries the RAW module rows and module edges;
  // the runtime derives every view of the grouping tree from them (one tree
  // node's children per view, single-child chains tunnelled) — so drilling
  // through packages costs no refetch and old data needs no rebuild.
  if (meta0["container"] !== undefined && !(view && view.node)) {
    const findTable = (d: Document, id: string) => {
      for (const b of d.children) if (b.kind === "block" && b.type === "table" && b.id !== undefined && nameKey(b.id) === nameKey(id) && b.table) return b.table;
      return undefined;
    };
    const mods = findTable(doc0, "modules");
    if (mods) {
      const mi = mods.columns.indexOf("module"), di = mods.columns.indexOf("doc");
      const mc = mods.columns.indexOf("methods");
      if (mi < 0 || di < 0) return { error: "#modules table lacks module/doc columns" };
      const list: { p: string; doc: string; m: number }[] = [];
      for (const r of mods.rows) {
        const name = r[mi]?.text ?? "", doc = r[di]?.text ?? "";
        if (name && doc) list.push({ p: name, doc, m: mc >= 0 ? Number(r[mc]?.text ?? "") || 0 : 0 });
      }
      const em: [string, string, number][] = [];
      const medges = findTable(doc0, "module-edges");
      if (medges) {
        const fi = medges.columns.indexOf("from"), ti = medges.columns.indexOf("to"), ci = medges.columns.indexOf("calls");
        for (const r of medges.rows) {
          const f = r[fi]?.text ?? "", t = r[ti]?.text ?? "";
          if (f && t) em.push([f, t, ci >= 0 ? Number(r[ci]?.text ?? "") || 1 : 1]);
        }
      }
      // Containers holding app entries — every derived view marks the child
      // that contains one of these as a root.
      const entryDocs: string[] = [];
      for (const e of entries) {
        const h = e.indexOf("#");
        if (h > 0) {
          const d = cgJoin(cgDir(start), e.slice(0, h));
          if (!entryDocs.includes(d)) entryDocs.push(d);
        }
      }
      // …plus documents whose app entry is FILE-level (app-entry-docs meta:
      // top-level bootstrap code with no function symbol, e.g. a Nuxt app.vue).
      for (const t of String(meta0["app-entry-docs"] ?? "").split(/\s+/).filter(Boolean)) {
        const d = cgJoin(cgDir(start), t);
        if (!entryDocs.includes(d)) entryDocs.push(d);
      }
      return { data: { start, depth: 99, roots: [], nodes: {}, edges: [], mode: "modules", mods: list, medges: em, entryDocs, style: graphStyle } };
    }
  }

  if (!(view && view.node)) {
    // A container view roots at its meta `entry` PLUS its in-degree-zero
    // methods. `entry` = called from OUTSIDE the container; in-degree-zero =
    // NO static caller at all — a JVM/agent entry point (`premain`), an AOP
    // advice the instrumentation invokes, a reflective handler, or dead code.
    // Such framework hooks have no in-repo caller, so seeding only from
    // `entry` drops them (and everything they reach) from their OWN
    // container's view. Union keeps a container's methods visible in it —
    // symmetric with the module overview's entry ∪ in-degree-zero roots.
    const ids: string[] = [];
    const anchorOf: Record<string, string> = {};
    const leaf = new Set<string>();
    const called = new Set<string>();
    for (const b of doc0.children) {
      if (b.kind !== "block") continue;
      if (b.type === "code" && b.id) {
        ids.push(b.id);
        if (typeof b.attrs["anchor"] === "string") anchorOf[b.id] = b.attrs["anchor"] as string;
        if (b.classes.includes("leaf")) leaf.add(b.id);
      }
      if (b.type === "table" && b.table && (b.id === "calls" || b.id === "called-by")) {
        const ti = b.table.columns.indexOf("to");
        if (ti >= 0) for (const r of b.table.rows) {
          const t = r[ti]?.text ?? "";
          if (t.startsWith("#")) called.add(t.slice(1));
        }
      }
    }
    const have = new Set(entries.map((e) => e.replace(/^#/, "")));
    // Synthetic methods — constructors (`<init>`/`<clinit>`), lambdas
    // (`<lambda>`), and anonymous-class / unresolved-signature methods — are
    // implementation artifacts, never entry points. Their in-degree is zero
    // only because no static edge names them (fluent-API / reflective / lambda
    // callers go unresolved), so seeding roots from them floods the view. Keep
    // them out of the in-degree-zero roots; they still appear when a real root
    // reaches them.
    const synthetic = (id: string) => /<(?:init|clinit|lambda)>|<unresolvedSignature>/.test(anchorOf[id] || "");
    // `.leaf` = zero out-edges: an in-degree-zero leaf is an ISOLATED node (no
    // caller, nothing to expand) — a bean getter/setter, a constant, dead code.
    // As a root it is pure clutter, so it never seeds one; it still appears if a
    // real root reaches it. (An in-degree-zero method WITH out-edges — premain,
    // an AOP advice — is a genuine entry and does seed a root.)
    for (const id of ids) if (!called.has(id) && !have.has(id) && !synthetic(id) && !leaf.has(id)) entries.push(`#${id}`);
  }
  if (!(view && view.node) && !entries.length) return { error: `\`${startRel}\` declares no \`entry\` in its meta` };
  // 深度的三级优先：文档自己的 `graph-depth` > `_index/style.geml` 的 `depth` >
  // profile 记的渲染器默认 6。文档在最前是有意的 —— 一份 codemap 对自己的
  // 合适深度最有发言权，样式表是**整份图**的默认值，不该盖掉单文档的声明。
  const depth = Number(meta0["graph-depth"]) > 0 ? Number(meta0["graph-depth"]) : graphStyle.depth;

  const resolveRef = (fromDoc: string, ref: string): { doc: string; id: string } | null => {
    const h = ref.indexOf("#");
    if (h < 0) return null;
    const id = ref.slice(h + 1);
    return { doc: h === 0 ? fromDoc : cgJoin(cgDir(fromDoc), ref.slice(0, h)), id };
  };

  const nodes: Record<string, CGNode> = {};
  const edges: CGData["edges"] = [];
  const roots: string[] = [];
  let truncated = false;

  // Per-document indexes, built once on first touch. The BFS re-enters the
  // same documents for every node it expands — a linear scan of a 30k-row
  // #calls table per node turns the whole walk quadratic (seconds per page
  // on a large codemap).
  const blockIdxOf = (() => {
    const cache = new Map<string, Map<string, CGNode>>();
    return (docRel: string): Map<string, CGNode> => {
      let idx = cache.get(docRel);
      if (idx) return idx;
      idx = new Map();
      const d = loadParsed(docRel);
      if (d) for (const b of d.children) {
        if (b.kind !== "block" || !b.id || idx.has(b.id)) continue;
        // Label with the real display name when the block carries one — the
        // id is the sanitised form ("RenderCtx-block" for "RenderCtx.block").
        const node: CGNode = { n: typeof b.attrs["name"] === "string" ? (b.attrs["name"] as string) : b.id, doc: docRel };
        if (typeof b.attrs["src"] === "string") node.src = b.attrs["src"] as string;
        if (b.classes.includes("leaf")) node.leaf = true;
        if (b.classes.includes("test")) node.test = true;
        if (b.classes.includes("accessor")) node.acc = true;
        if (b.classes.includes("app-entry")) node.entry = true;
        idx.set(b.id, node);
      }
      cache.set(docRel, idx);
      return idx;
    };
  })();
  const blockInfo = (docRel: string, id: string): CGNode =>
    blockIdxOf(docRel).get(id) ?? { n: id, doc: docRel };
  type CallRow = { to: string; kind: string; conf: string; endpoint?: string };
  const callIdxOf = (() => {
    const cache = new Map<string, Map<string, CallRow[]>>();
    return (docRel: string): Map<string, CallRow[]> => {
      let idx = cache.get(docRel);
      if (idx) return idx;
      idx = new Map();
      const add = (from: string, rec: CallRow) => {
        if (!from.startsWith("#")) return;
        let list = idx!.get(from.slice(1));
        if (!list) { list = []; idx!.set(from.slice(1), list); }
        list.push(rec);
      };
      // Honor only the FIRST table of each id — a crafted second #calls/#api-calls
      // must not inject edges (pinned by render-html tests).
      let sawCalls = false, sawApi = false;
      const d = loadParsed(docRel);
      if (d) for (const b of d.children) {
        if (b.kind !== "block" || b.type !== "table" || !b.table) continue;
        const cols = b.table.columns;
        const fi = cols.indexOf("from"), ti = cols.indexOf("to");
        if (fi < 0 || ti < 0) continue;
        if (b.id === "calls" && !sawCalls) {
          sawCalls = true;
          const ki = cols.indexOf("kind"), ci = cols.indexOf("confidence");
          for (const r of b.table.rows) add(r[fi]?.text ?? "", { to: r[ti]?.text ?? "", kind: r[ki!]?.text || "call", conf: ci >= 0 ? (r[ci]?.text ?? "") : "" });
        } else if (b.id === "api-calls" && !sawApi) {
          sawApi = true;
          // cross-stack link: a frontend function → its backend handler,
          // labelled with the endpoint (METHOD path). Rendered as a distinct
          // `http` edge; the handler is a boundary node (not auto-expanded).
          const ei = cols.indexOf("endpoint");
          for (const r of b.table.rows) add(r[fi]?.text ?? "", { to: r[ti]?.text ?? "", kind: "http", conf: "", endpoint: ei >= 0 ? (r[ei]?.text ?? "") : "" });
        }
      }
      cache.set(docRel, idx);
      return idx;
    };
  })();
  const callRows = (docRel: string, id: string): CallRow[] =>
    callIdxOf(docRel).get(id) ?? [];

  // A caller-direction view (the runtime's ⊕ handle through a live loader):
  // BFS over #called-by tables from one node. Edges are emitted REVERSED
  // (callee -> caller), so roots=[focus] lets the standard layering flow from
  // the method out to its ultimate callers — cycles fall out as back edges.
  if (view && view.node && view.dir === "up") {
    const hi = view.node.lastIndexOf("#");
    if (hi <= 0) return { error: `bad view node \`${view.node}\`` };
    // Same once-per-document indexing as callRows — the upward BFS crosses
    // documents through their #called-by tables just as hot.
    type CalledByRow = { from: string; kind: string; endpoint?: string };
    const calledByIdxOf = (() => {
      const cache = new Map<string, Map<string, CalledByRow[]>>();
      return (docRel: string): Map<string, CalledByRow[]> => {
        let idx = cache.get(docRel);
        if (idx) return idx;
        idx = new Map();
        const add = (to: string, rec: CalledByRow) => {
          if (!to.startsWith("#")) return;
          let list = idx!.get(to.slice(1));
          if (!list) { list = []; idx!.set(to.slice(1), list); }
          list.push(rec);
        };
        let sawCb = false, sawApi = false; // first-of-each-id only (see callIdxOf)
        const d = loadParsed(docRel);
        if (d) for (const b of d.children) {
          if (b.kind !== "block" || b.type !== "table" || !b.table) continue;
          const cols = b.table.columns;
          const fi = cols.indexOf("from"), ti = cols.indexOf("to");
          if (fi < 0 || ti < 0) continue;
          if (b.id === "called-by" && !sawCb) {
            sawCb = true;
            const ki = cols.indexOf("kind");
            for (const r of b.table.rows) add(r[ti]?.text ?? "", { from: r[fi]?.text ?? "", kind: r[ki!]?.text || "call" });
          } else if (b.id === "api-served-by" && !sawApi) {
            sawApi = true;
            // cross-stack: a backend handler ← its frontend caller.
            const ei = cols.indexOf("endpoint");
            for (const r of b.table.rows) add(r[ti]?.text ?? "", { from: r[fi]?.text ?? "", kind: "http", endpoint: ei >= 0 ? (r[ei]?.text ?? "") : "" });
          }
        }
        cache.set(docRel, idx);
        return idx;
      };
    })();
    const calledByRows = (docRel: string, id: string): CalledByRow[] =>
      calledByIdxOf(docRel).get(id) ?? [];
    const focus = view.node;
    nodes[focus] = blockInfo(focus.slice(0, hi), focus.slice(hi + 1));
    roots.push(focus);
    let fr: { doc: string; id: string }[] = [{ doc: focus.slice(0, hi), id: focus.slice(hi + 1) }];
    const seenUp = new Set([focus]);
    // The caller chain is not depth-limited: its whole point is reaching the
    // app entry. The node cap (with its visible note) is the only guard.
    const upDepth = 99;
    for (let d = 0; d < upDepth && fr.length; d++) {
      const next: { doc: string; id: string }[] = [];
      for (const cur of fr) {
        const toKey = `${cur.doc}#${cur.id}`;
        for (const row of calledByRows(cur.doc, cur.id)) {
          const c = resolveRef(cur.doc, row.from);
          if (!c) continue;
          const callerKey = `${c.doc}#${c.id}`;
          if (!nodes[callerKey]) {
            if (Object.keys(nodes).length >= CG_MAX_NODES) { truncated = true; continue; }
            nodes[callerKey] = blockInfo(c.doc, c.id);
          }
          if (row.endpoint) edges.push([toKey, callerKey, row.kind, "", row.endpoint]);
          else edges.push([toKey, callerKey, row.kind, ""]);
          // Don't expand the frontend caller's subtree into a backend-rooted
          // callers view across the http boundary; it's a boundary node.
          if (row.kind !== "http" && !seenUp.has(callerKey)) { seenUp.add(callerKey); next.push(c); }
        }
      }
      fr = next;
    }
    return { data: { start, depth: upDepth, roots, nodes, edges, module: String(meta0["module"] ?? "") || undefined, dir: "up", focus, style: graphStyle }, truncated };
  }

  // BFS from the target document's entries, depth-limited (+1 ring of stubs so
  // the horizon is visible as "more" markers rather than silently missing).
  // A directed callee view (node-body click through a live loader) seeds from
  // that one node key instead of the meta entries.
  let frontier: { doc: string; id: string }[] = [];
  if (view && view.node) {
    const hi = view.node.lastIndexOf("#");
    if (hi <= 0) return { error: `bad view node \`${view.node}\`` };
    roots.push(view.node);
    frontier.push({ doc: view.node.slice(0, hi), id: view.node.slice(hi + 1) });
  } else {
    const seeds = entries.map((e) => resolveRef(start, e)).filter(Boolean) as { doc: string; id: string }[];
    // A `.leaf` root has no callees to expand, so it renders as an ISOLATED dot
    // — a getter/setter/constant called from another container, or dead code.
    // Seed roots only from non-leaf entries so the view is call chains, not a
    // field of dots; a leaf still appears when a real chain reaches it. Fall
    // back to all seeds if EVERY entry is a leaf (a pure data container — a DTO
    // of getters — must not come out blank).
    const nonLeaf = seeds.filter((r) => !blockInfo(r.doc, r.id).leaf);
    for (const r of (nonLeaf.length ? nonLeaf : seeds)) { roots.push(`${r.doc}#${r.id}`); frontier.push(r); }
  }
  const seen = new Set(roots);
  for (const r of frontier) nodes[`${r.doc}#${r.id}`] = blockInfo(r.doc, r.id);
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: { doc: string; id: string }[] = [];
    for (const cur of frontier) {
      const fromKey = `${cur.doc}#${cur.id}`;
      for (const row of callRows(cur.doc, cur.id)) {
        const t = resolveRef(cur.doc, row.to);
        if (!t) continue;
        const toKey = `${t.doc}#${t.id}`;
        if (!nodes[toKey]) {
          if (Object.keys(nodes).length >= CG_MAX_NODES) { truncated = true; continue; }
          nodes[toKey] = blockInfo(t.doc, t.id);
        }
        if (row.endpoint) edges.push([fromKey, toKey, row.kind, row.conf, row.endpoint]);
        else edges.push([fromKey, toKey, row.kind, row.conf]);
        // Cross-stack `http` links reach into the OTHER tree — pull the handler
        // in as a boundary node but don't expand its (backend) subtree into a
        // frontend view; the user clicks through to open it in its own flow.
        if (row.kind !== "http" && !seen.has(toKey)) {
          seen.add(toKey);
          next.push(t);
        }
      }
    }
    frontier = next;
  }
  // Horizon markers: anything still in the frontier that has further callees.
  for (const cur of frontier) {
    if (callRows(cur.doc, cur.id).length > 0) nodes[`${cur.doc}#${cur.id}`]!.more = true;
  }

  // Drop ISOLATED nodes: a seeded root that ends up with no edge at all (no
  // resolved callee to expand, no in-view caller) is a lone dot — a getter/
  // setter/constant called only from elsewhere, or a method whose only calls
  // were unresolved. They are clutter in a flow view. Keep them only if the
  // WHOLE view is isolated dots (a pure data container mustn't come out blank).
  const touched = new Set<string>();
  for (const e of edges) { touched.add(e[0]); touched.add(e[1]); }
  const connected = roots.filter((r) => touched.has(r));
  let finalRoots = roots;
  if (connected.length) {
    for (const r of roots) if (!touched.has(r)) delete nodes[r];
    finalRoots = connected;
  }

  return { data: { start, depth, roots: finalRoots, nodes, edges, module: String(meta0["module"] ?? "") || undefined, style: graphStyle }, truncated };
}

function chartSvg(m: ChartModel, title?: string): string {
  if (m.type === "pie") return pieSvg(m, title);
  if (m.type === "scatter") return scatterSvg(m, title);
  return cartesianSvg(m, title); // bar | line | area
}

function svgFrame(title: string | undefined, W: number, H: number, body: string): string {
  const t = title ? `<text x="${W / 2}" y="22" text-anchor="middle" class="c-title">${esc(title)}</text>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" class="geml-chart" role="img" aria-label="${escAttr(title ?? "chart")}">${t}${body}</svg>`;
}

function legend(names: string[], x: number, y: number): string {
  return names.map((n, i) => {
    const yy = y + i * 18;
    return `<rect x="${x}" y="${yy}" width="11" height="11" rx="2" fill="${PALETTE[i % PALETTE.length]}"></rect>` +
      `<text x="${x + 16}" y="${yy + 10}" class="c-legend">${esc(n)}</text>`;
  }).join("");
}

function cartesianSvg(m: ChartModel, title?: string): string {
  const W = 760, H = 380;
  const top = title ? 40 : 22, right = 20, bottom = 64, left = 56;
  const pw = W - left - right, ph = H - top - bottom;
  const cats = m.dataset.categories;
  const series = m.y;
  const vals = series.map((s) => m.dataset.numbers[s] ?? []);
  const flat = vals.flat();
  const dataMax = Math.max(0, ...flat);
  const dataMin = Math.min(0, ...flat);
  const yMax = niceMax(dataMax);
  const yMin = dataMin < 0 ? -niceMax(-dataMin) : 0;
  const range = yMax - yMin || 1;
  const yOf = (v: number) => top + ph * (1 - (v - yMin) / range);
  const n = Math.max(1, cats.length);
  const band = pw / n;
  const cx = (i: number) => left + band * (i + 0.5);

  // y grid + ticks
  const ticks = 5;
  let grid = "";
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + (range * i) / ticks;
    const y = yOf(v);
    grid += `<line x1="${left}" y1="${y}" x2="${left + pw}" y2="${y}" class="c-grid"></line>`;
    grid += `<text x="${left - 8}" y="${y + 4}" text-anchor="end" class="c-tick">${fmtNum(v)}</text>`;
  }
  // x labels
  let xlab = "";
  cats.forEach((c, i) => {
    xlab += `<text x="${cx(i)}" y="${top + ph + 18}" text-anchor="middle" class="c-tick">${esc(trunc(c, 12))}</text>`;
  });

  let marks = "";
  if (m.type === "bar") {
    const groupW = band * 0.8;
    const bw = groupW / series.length;
    series.forEach((s, si) => {
      (m.dataset.numbers[s] ?? []).forEach((v, i) => {
        const x = cx(i) - groupW / 2 + si * bw;
        const y0 = yOf(0), y1 = yOf(v);
        const y = Math.min(y0, y1), h = Math.abs(y1 - y0);
        marks += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.92).toFixed(1)}" height="${h.toFixed(1)}" fill="${PALETTE[si % PALETTE.length]}"><title>${esc(s)} · ${esc(cats[i] ?? "")}: ${fmtNum(v)}</title></rect>`;
      });
    });
  } else {
    // line / area
    series.forEach((s, si) => {
      const color = PALETTE[si % PALETTE.length];
      const pts = (m.dataset.numbers[s] ?? []).map((v, i) => `${cx(i).toFixed(1)},${yOf(v).toFixed(1)}`);
      if (pts.length === 0) return;
      if (m.type === "area") {
        const base = yOf(Math.max(yMin, 0));
        marks += `<polygon points="${cx(0).toFixed(1)},${base} ${pts.join(" ")} ${cx(cats.length - 1).toFixed(1)},${base}" fill="${color}" fill-opacity="0.18"></polygon>`;
      }
      marks += `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5"></polyline>`;
      (m.dataset.numbers[s] ?? []).forEach((v, i) => {
        marks += `<circle cx="${cx(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="3.5" fill="${color}"><title>${esc(s)} · ${esc(cats[i] ?? "")}: ${fmtNum(v)}</title></circle>`;
      });
    });
  }

  const axis = `<line x1="${left}" y1="${yOf(Math.max(yMin, 0))}" x2="${left + pw}" y2="${yOf(Math.max(yMin, 0))}" class="c-axis"></line>`;
  const leg = series.length > 1 ? legend(series, left + 8, top + 4) : "";
  return svgFrame(title, W, H, grid + axis + marks + xlab + leg);
}

function pieSvg(m: ChartModel, title?: string): string {
  const W = 760, H = 380, top = title ? 40 : 22;
  const cx = 250, cy = top + (H - top) / 2, r = Math.min(140, (H - top) / 2 - 16);
  const col = m.y[0]!;
  const data = m.dataset.numbers[col] ?? [];
  const total = data.reduce((a, b) => a + b, 0) || 1;
  let a0 = -Math.PI / 2;
  let slices = "";
  data.forEach((v, i) => {
    const a1 = a0 + (v / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    slices += `<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${PALETTE[i % PALETTE.length]}"><title>${esc(m.dataset.categories[i] ?? "")}: ${fmtNum(v)} (${((v / total) * 100).toFixed(1)}%)</title></path>`;
    a0 = a1;
  });
  const leg = legend(m.dataset.categories, 470, top + 16);
  return svgFrame(title, W, H, slices + leg);
}

function scatterSvg(m: ChartModel, title?: string): string {
  const W = 760, H = 380;
  const top = title ? 40 : 22, right = 20, bottom = 64, left = 56;
  const pw = W - left - right, ph = H - top - bottom;
  const yCol = m.y[0]!;
  const ys = m.dataset.numbers[yCol] ?? [];
  // x: parse the category text as a number; fall back to the row index.
  const xs = m.dataset.categories.map((c, i) => { const v = parseFloat(c); return Number.isFinite(v) ? v : i; });
  const sizes = m.size ? (m.dataset.numbers[m.size] ?? []) : [];
  const xMax = niceMax(Math.max(1, ...xs)), xMin = Math.min(0, ...xs);
  const yMax = niceMax(Math.max(1, ...ys)), yMin = Math.min(0, ...ys);
  const xr = xMax - xMin || 1, yr = yMax - yMin || 1;
  const xOf = (v: number) => left + pw * ((v - xMin) / xr);
  const yOf = (v: number) => top + ph * (1 - (v - yMin) / yr);
  const sMax = Math.max(1, ...sizes);
  const rOf = (i: number) => m.size ? 4 + 14 * Math.sqrt((sizes[i] ?? 0) / sMax) : 5;

  let grid = "";
  for (let i = 0; i <= 5; i++) {
    const v = yMin + (yr * i) / 5, y = yOf(v);
    grid += `<line x1="${left}" y1="${y}" x2="${left + pw}" y2="${y}" class="c-grid"></line>`;
    grid += `<text x="${left - 8}" y="${y + 4}" text-anchor="end" class="c-tick">${fmtNum(v)}</text>`;
  }
  let pts = "";
  ys.forEach((v, i) => {
    pts += `<circle cx="${xOf(xs[i] ?? 0).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="${rOf(i).toFixed(1)}" fill="${PALETTE[0]}" fill-opacity="0.7"><title>${esc(m.dataset.categories[i] ?? "")}: (${fmtNum(xs[i] ?? 0)}, ${fmtNum(v)})</title></circle>`;
  });
  const axis = `<line x1="${left}" y1="${top + ph}" x2="${left + pw}" y2="${top + ph}" class="c-axis"></line>`;
  return svgFrame(title, W, H, grid + axis + pts);
}

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString("en-US");
  return String(parseFloat(v.toPrecision(4)));
}
function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// Page shell, inline CSS, inline interactivity JS
// ---------------------------------------------------------------------------

export const CSS = `
:root { --fg:#1f2328; --muted:#656d76; --bd:#d0d7de; --bg:#fff; --accent:#2563eb; --code-bg:#f6f8fa; }
* { box-sizing: border-box; }
body { margin:0; color:var(--fg); background:#fafbfc; font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,"PingFang SC","Microsoft Yahei",sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 48px 24px 96px; background:var(--bg); }
h1,h2,h3,h4,h5,h6 { line-height:1.25; margin:1.6em 0 .6em; scroll-margin-top:16px; }
h1 { font-size:2em; border-bottom:1px solid var(--bd); padding-bottom:.3em; }
h2 { font-size:1.5em; border-bottom:1px solid var(--bd); padding-bottom:.3em; }
h3 { font-size:1.25em; } h4 { font-size:1em; }
p { margin:.7em 0; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
code { background:var(--code-bg); padding:.15em .35em; border-radius:6px; font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
pre { background:var(--code-bg); padding:14px 16px; border-radius:8px; overflow:auto; }
pre code { background:none; padding:0; font-size:.85em; }
pre.output { background:#0d1117; color:#e6edf3; }
pre.output code { color:inherit; }
ul,ol { padding-left:1.6em; } li { margin:.2em 0; }
ul.task-list { list-style:none; padding-left:.2em; }
li.task input[type=checkbox] { appearance:none; -webkit-appearance:none; width:1.1em; height:1.1em; margin:0 .5em 0 0; vertical-align:-.2em; border:1.5px solid #c8ccd0; border-radius:4px; background:#fff; position:relative; opacity:1; cursor:default; box-sizing:border-box; }
li.task input[type=checkbox]:checked { background-color:#1f883d; border-color:#1f883d; }
li.task input[type=checkbox]:checked::after { content:"✓"; position:absolute; top:0; right:0; bottom:0; left:0; display:flex; align-items:center; justify-content:center; color:#fff; font-size:.8em; line-height:1; font-weight:700; }
aside.callout { border-left:4px solid var(--accent); background:#f0f6ff; padding:.4em 16px; border-radius:0 8px 8px 0; margin:1em 0; }
aside.aside { border-left-color:#8b949e; background:#f6f8fa; }
aside.warning { border-left-color:#d97706; background:#fff8f0; }
aside.callout > :first-child { margin-top:0; } aside.callout > :last-child { margin-bottom:0; }
figure { margin:1.2em 0; }
figcaption { color:var(--muted); font-size:.86em; text-align:center; margin-top:.5em; }
table.geml-table { border-collapse:collapse; width:100%; font-size:.92em; }
table.geml-table th, table.geml-table td { border:1px solid var(--bd); padding:6px 12px; }
table.geml-table thead th { background:var(--code-bg); cursor:pointer; user-select:none; white-space:nowrap; }
table.geml-table thead th::after { content:" \\2195"; color:var(--muted); font-size:.8em; }
table.geml-table thead th.asc::after { content:" \\2191"; color:var(--accent); }
table.geml-table thead th.desc::after { content:" \\2193"; color:var(--accent); }
table.geml-table tbody tr:nth-child(2n) { background:#fafbfc; }
table.geml-table td.computed { color:#0a7c52; }
table.geml-table tfoot td { background:var(--code-bg); font-weight:600; border-top:2px solid var(--bd); }
.table-tools { margin-bottom:6px; } .table-filter { width:240px; max-width:100%; padding:5px 9px; border:1px solid var(--bd); border-radius:7px; font-size:.85em; }
/* A table wider than the column scrolls INSIDE its own box — the page itself
   must never scroll sideways. Only the table is in here: the filter box above
   and the caption below stay put instead of sliding out of view with it. */
.table-scroll { overflow-x:auto; max-width:100%; }
.table-figure details > summary { cursor:pointer; color:var(--muted); font-size:.86em; padding:4px 0; }
.table-note { color:var(--muted); font-size:.82em; margin:6px 0 0; }
.geml-chart { width:100%; height:auto; background:var(--bg); border:1px solid var(--bd); border-radius:8px; }
.c-title { font-size:15px; font-weight:600; fill:var(--fg); }
.c-grid { stroke:#eaecef; } .c-axis { stroke:#aab1b8; } .c-tick { font-size:11px; fill:var(--muted); } .c-legend { font-size:12px; fill:var(--fg); }
.media { max-width:100%; border-radius:8px; }
.diagram-src { color:var(--muted); } .render-error { color:#cf222e; }
.math-block { overflow-x:auto; padding:.4em 0; }
sup.fn a { font-size:.75em; }
.geml-footer { max-width:860px; margin:0 auto; padding:16px 24px 40px; color:var(--muted); font-size:.82em; }
.geml-footer code { font-size:.95em; }
.code-graph { margin:1.4em 0; }
/* The graph is the widest artifact on the page: let it break out of main's
   860px reading column and take the viewport, centred, leaving the prose
   around it untouched. Negative inline margins, NOT transform — a transform
   would become the containing block for the fullscreen overlay below. */
@media (min-width:900px) { .code-graph { margin-inline: calc((100% - min(96vw, 1600px)) / 2); } }
.cg-mount { border:1px solid var(--bd); border-radius:8px; padding:10px 12px; background:var(--bg); }
.cg-scroll { overflow:auto; min-height:60vh; max-height:84vh; }
.cg-svg { display:block; }
/* Fullscreen: one class drives the layout, whether the native Fullscreen API
   took (mount is in the top layer) or we fell back to a fixed overlay. The
   :fullscreen pseudo-class is deliberately NOT in these selectors — a browser
   that doesn't know it would drop the whole rule; the runtime keeps the class
   in sync with fullscreenchange instead. Toolbar/legend keep their height,
   the stage eats the rest. */
.cg-mount.cg-full { position:fixed; inset:0; z-index:9999; margin:0; border:0; border-radius:0; padding:10px 14px; background:var(--bg); display:flex; flex-direction:column; }
.cg-mount.cg-full > .cg-bar, .cg-mount.cg-full > .cg-legend, .cg-mount.cg-full > .cg-groups { flex:0 0 auto; }
.cg-mount.cg-full .cg-stage { flex:1 1 auto; min-height:0; }
.cg-mount.cg-full .cg-scroll { min-height:0; max-height:none; height:100%; }
.cg-mount.cg-full .cg-src-body { max-height:none; }
.cg-mount.cg-full .cg-frame { flex:1 1 auto; height:auto; }
.cg-search-wrap { position:relative; display:inline-block; }
.cg-search { font:12px/1.4 inherit; padding:2px 7px; border:1px solid var(--bd); border-radius:4px; background:var(--bg); color:var(--fg); min-width:13ch; }
.cg-search-menu { position:absolute; z-index:30; top:calc(100% + 2px); left:0; min-width:24ch; max-width:52ch; max-height:52vh; overflow:auto; background:var(--bg); border:1px solid var(--bd); border-radius:6px; box-shadow:0 6px 20px rgba(0,0,0,.18); }
.cg-search-row { display:block; width:100%; text-align:left; padding:4px 9px 4px 18px; border:0; background:none; color:var(--fg); cursor:pointer; font:12px/1.4 inherit; }
.cg-search-row:hover { background:var(--bd); }
.cg-search-count { position:sticky; top:0; padding:4px 9px; font-size:11px; opacity:.65; background:var(--bg); border-bottom:1px solid var(--bd); }
.cg-search-grp { padding:6px 9px 2px; font-size:11px; font-weight:600; opacity:.7; border-top:1px solid var(--bd); }
.cg-search-grp:first-of-type { border-top:0; }
.cg-stage { display:flex; gap:10px; align-items:flex-start; }
.cg-stage .cg-scroll { flex:1 1 auto; min-width:0; }
.cg-src { flex:0 0 42%; max-width:46%; display:flex; flex-direction:column; border:1px solid var(--bd); border-radius:6px; overflow:hidden; background:var(--bg); }
.cg-src-hd { display:flex; gap:8px; align-items:center; justify-content:space-between; padding:4px 8px; border-bottom:1px solid var(--bd); color:var(--muted); font:.76em ui-monospace,Consolas,monospace; word-break:break-all; }
.cg-src-hd button { font:inherit; border:1px solid var(--bd); border-radius:5px; background:transparent; color:var(--muted); cursor:pointer; padding:0 6px; }
.cg-src-body { margin:0; padding:8px 10px; overflow:auto; max-height:84vh; color:var(--fg); font:12px/1.5 ui-monospace,Consolas,monospace; white-space:pre; }
.cg-src-note { color:var(--muted); font-style:italic; white-space:pre-wrap; }
.cg-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:.82em; color:var(--muted); margin-bottom:6px; }
.cg-bar button { font:inherit; padding:1px 8px; border:1px solid var(--bd); border-radius:5px; background:transparent; cursor:pointer; }
.cg-crumb .cg-seg { border:0; border-radius:0; padding:0; background:none; color:var(--accent); cursor:pointer; font:inherit; }
.cg-crumb .cg-seg:hover { text-decoration:underline; }
.cg-frame { display:block; width:100%; height:84vh; border:0; background:var(--bg); }
.cg-flash { color:#b42318; }
.cg-legend { display:flex; gap:14px; align-items:center; justify-content:space-between; flex-wrap:wrap; font-size:.75em; color:var(--muted); margin-top:6px; }
.cg-upbtn { cursor:pointer; }
.cg-upbtn circle { fill:#fff; stroke:#94a3b8; }
.cg-upbtn text { font-size:11px; fill:#57606a; }
.cg-upbtn:hover circle { stroke:var(--accent); stroke-width:1.6; }
.cg-upbtn:hover text { fill:var(--accent); }
.cg-uplink { fill:none; stroke:#94a3b8; stroke-dasharray:3 2.5; pointer-events:none; }
.cg-groups { display:flex; flex-wrap:wrap; gap:4px 12px; margin-top:6px; font-size:.75em; color:var(--muted); }
.cg-chip { display:inline-flex; align-items:center; gap:4px; }
.cg-chip i { width:10px; height:10px; border-radius:2px; border:1px solid #94a3b8; display:inline-block; }
.cg-note { font-size:.8em; color:#9a6700; }
.cg-n rect { fill:#eef2f7; stroke:#94a3b8; }
.cg-n text { font-size:12px; fill:var(--fg); font-family:ui-monospace,Consolas,monospace; }
.cg-n { cursor:pointer; }
.cg-n.root rect { fill:#dbeafe; stroke:#2563eb; stroke-width:2; }
.cg-n.leaf { opacity:.45; }
.cg-n.test rect { stroke-dasharray:3 2; }
.cg-n.grp rect { stroke-width:1.8; }
.cg-e { fill:none; stroke:#94a3b8; stroke-width:.9; }
.cg-e.cand { stroke-dasharray:2 3; }
.cg-e.back { stroke:#dc2626; stroke-dasharray:5 3; }
.cg-e.http { stroke:#0891b2; stroke-width:1.5; stroke-dasharray:5 2; } /* cross-stack API link */
.cg-e.soft { opacity:.55; }
.cg-svg.hl .cg-n { opacity:.22; }
.cg-svg.hl .cg-e { opacity:.1; }
.cg-svg.hl .cg-n.hl { opacity:1; }
.cg-svg.hl .cg-e.hl { opacity:1; stroke-width:1.6; }
`;

export const JS = `
(function () {
  function cmp(a, b) {
    var na = a.dataset.sort, nb = b.dataset.sort;
    if (na !== undefined && nb !== undefined) return parseFloat(na) - parseFloat(nb);
    return (a.textContent || "").localeCompare(b.textContent || "");
  }
  document.querySelectorAll("table.geml-table").forEach(function (table) {
    var tbody = table.tBodies[0];
    if (!tbody) return;
    // Sort on header click.
    var ths = table.tHead ? table.tHead.rows[0].cells : [];
    Array.prototype.forEach.call(ths, function (th, col) {
      th.addEventListener("click", function () {
        var dir = th.classList.contains("asc") ? "desc" : "asc";
        Array.prototype.forEach.call(ths, function (h) { h.classList.remove("asc", "desc"); });
        th.classList.add(dir);
        var rows = Array.prototype.slice.call(tbody.rows);
        rows.sort(function (r1, r2) {
          var c = cmp(r1.cells[col], r2.cells[col]);
          return dir === "asc" ? c : -c;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
      });
    });
    // Filter rows.
    var fig = table.closest(".table-figure");
    var input = fig ? fig.querySelector(".table-filter") : null;
    if (input) input.addEventListener("input", function () {
      var q = input.value.toLowerCase();
      Array.prototype.forEach.call(tbody.rows, function (r) {
        r.style.display = (r.textContent || "").toLowerCase().indexOf(q) >= 0 ? "" : "none";
      });
    });
  });
})();
`;

// geml-code-graph runtime: layered layout AT DRAW TIME (GEP-0003 / v2-D8) so
// clicking a node re-roots the view inside the embedded slice. Algorithm as
// specified: BFS slice from roots -> DFS back-edge marking -> longest-path
// layering over forward edges -> stable in-layer order. O(V+E) per redraw.
//
// ONE implementation, two consumers: the CLI inlines `codeGraphRuntime`
// verbatim (Function.prototype.toString) into the self-contained HTML; the
// browser extension / playground import it and call it after their async
// upgrade step has attached data-graph payloads. Browser-only code — it must
// stay self-contained (no captured module-scope identifiers).
export function codeGraphRuntime(root: { querySelectorAll(sel: string): ArrayLike<Element> }): void {
  // 显示期旋钮（计划 D）：随 data-graph 一起送来，来源是 `_index/style.geml`。
  // 每个回退值逐一等于反转之前写死在这里的那个，所以**没有 style.geml 的旧页面
  // 行为不变** —— 这是不替换渲染器、只反转控制权的全部要点。
  var CG_PALETTE_FALLBACK = ["#e3f2fd", "#e8f5e9", "#fff3e0", "#f3e5f5", "#e0f7fa", "#fce4ec",
                             "#f1f8e9", "#ede7f6", "#fff8e1", "#e0f2f1", "#efebe9", "#f9fbe7"];
  var cgStyleCur: any = {};
  function cgStyle(d: any): any { if (d && d.style) cgStyleCur = d.style; return cgStyleCur || {}; }
  function cgFold(): number { return (cgStyleCur && cgStyleCur.fold) || 1; }
  function cgPalette(d: any): any { return cgStyle(d).palette || CG_PALETTE_FALLBACK; }
  function h(tag: string, attrs: Record<string, string | number>) {
    var el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) el.setAttribute(k, String(attrs[k]));
    return el;
  }
  // Same-origin confinement for every URL the runtime fetches or loads.
  // navBase is derived from the mount's document-controlled `data-src`, so a
  // crafted codemap doc could otherwise aim a fetch / HEAD probe / <script src>
  // at a third-party host (silent beacon, SSRF, or remote-code load) or read an
  // out-of-directory local file. Resolve the candidate against the page and
  // require the SAME origin (and, on file://, the same directory). With no
  // location context (unit tests / non-browser) there is nothing to confine to,
  // so allow — the browser/CLI callers always have one.
  function cgSameOrigin(u: any): boolean {
    try {
      var here = (typeof location !== "undefined" && location.href) ? location.href : "";
      if (!here) return true;
      var abs = new URL(String(u), here), cur = new URL(here);
      if (abs.protocol !== cur.protocol) return false;
      if (cur.protocol === "file:") return abs.pathname.indexOf(cur.pathname.replace(/[^\/]*$/, "")) === 0;
      return abs.origin === cur.origin;
    } catch (e) { return false; }
  }
  // Arrow-marker ids must be unique per drawn svg — several mounts share one
  // document, and duplicate ids would make every graph point at the first.
  var arrowSeq = 0;
  function boot(mount: Element, data0: any, gpath?: any): void {
    // 先把旋钮吃进来：deriveView 里的 first() 要用 fold，而它跑在
    // hideAcc / PALETTE 之前，不在这里播种就会读到空配置退回默认值。
    cgStyle(data0);
    var data: any, out: any;
    function setData(d: any) {
      data = d;
      out = {};
      data.edges.forEach(function (e: any) { (out[e[0]] = out[e[0]] || []).push(e); });
    }
    // Grouped module navigation (GEP-0003 §4): a SHALLOW two-tier model.
    // Tier 1 (gpath = []) is one node per top path segment — the module-ish
    // roots. Tier 2 (gpath = [seg]) is that segment's containers FLAT, labelled
    // by their intra-module path; clicking a container opens its methods. At
    // most ONE grouping level, so a method is always two clicks from the top —
    // a deep package chain (core/service/impl) reads as a flat label, never a
    // click-through. Calls leaving the subtree aggregate into dimmed external
    // stubs so no dependency is hidden.
    function deriveView(gpath: any): any {
      // 折叠到前 FOLD 段，FOLD 来自 `_index/style.geml`（计划 D）。
      // 缺省 1 时与反转之前的 `indexOf("/")` 实现逐字符等价。
      function first(p: any) {
        var parts = String(p).split("/");
        return parts.length <= cgFold() ? String(p) : parts.slice(0, cgFold()).join("/");
      }
      var pByDoc: any = {}, docByP: any = {};
      data0.mods.forEach(function (m: any) { pByDoc[m.doc] = m.p; docByP[m.p] = m.doc; });
      // A single top segment (one-module repo) is ceremony: land straight on
      // its containers, with the breadcrumb still at root — a lone top node is
      // never worth a click. `reported` keeps the crumb showing `modules`.
      var reported = gpath;
      if (!gpath.length) {
        var tops: any = {};
        data0.mods.forEach(function (m: any) { var s = first(m.p); tops[s] = (tops[s] || 0) + 1; });
        var tk = Object.keys(tops);
        if (tk.length === 1) {
          var whole = false;
          data0.mods.forEach(function (m: any) { if (m.p === tk[0]) whole = true; });
          if (!(tops[tk[0]!] === 1 && whole)) gpath = [tk[0]!]; // descend past the sole group
        }
      }
      var nodes: any = {}, keyOf: any;
      if (!gpath.length) {
        // Tier 1: one node per top segment. A segment that is a single whole
        // container (its path IS the segment) is a leaf — one click to methods.
        var segCount: any = {}, segWhole: any = {};
        data0.mods.forEach(function (m: any) {
          var s = first(m.p); segCount[s] = (segCount[s] || 0) + 1;
          if (m.p === s) segWhole[s] = m.doc;
        });
        Object.keys(segCount).sort().forEach(function (s) {
          if (segCount[s] === 1 && segWhole[s]) nodes[segWhole[s]] = { n: s, doc: segWhole[s] };
          else nodes["g:" + s] = { n: s, grp: [s] };
        });
        keyOf = function (p: any) { var s = first(p); return (segCount[s] === 1 && segWhole[s]) ? segWhole[s] : "g:" + s; };
      } else {
        // Tier 2: every container under this segment, FLAT.
        var mod = gpath.join("/"), pre = mod + "/";
        data0.mods.forEach(function (m: any) {
          if (m.p !== mod && m.p.indexOf(pre) !== 0) return;
          var label = m.p === mod ? (mod.indexOf("/") < 0 ? mod : mod.slice(mod.lastIndexOf("/") + 1)) : m.p.slice(pre.length);
          nodes[m.doc] = { n: label, doc: m.doc };
        });
        keyOf = function (p: any) {
          if (p === mod || p.indexOf(pre) === 0) return docByP[p] || null;
          return "x:" + first(p);
        };
      }
      var agg: any = {};
      data0.medges.forEach(function (e: any) {
        var a = keyOf(e[0]), b = keyOf(e[1]);
        if (!a || !b || a === b) return;
        if (a.indexOf("x:") === 0 && b.indexOf("x:") === 0) return;
        [a, b].forEach(function (kk: any) { if (kk.indexOf("x:") === 0 && !nodes[kk]) nodes[kk] = { n: "↗ " + kk.slice(2), ext: 1, leaf: 1 }; });
        agg[a + ">" + b] = (agg[a + ">" + b] || 0) + (Number(e[2]) || 1);
      });
      var edges: any = [];
      for (var ek in agg) { var i2 = ek.indexOf(">"); edges.push([ek.slice(0, i2), ek.slice(i2 + 1), "call", String(agg[ek])]); }
      // roots: nodes holding app entries, plus in-degree-zero nodes
      var roots: any = [];
      (data0.entryDocs || []).forEach(function (d: any) {
        var p = pByDoc[d]; if (!p) return;
        var kk = keyOf(p);
        if (kk && kk.indexOf("x:") !== 0) {
          if (roots.indexOf(kk) < 0) roots.push(kk);
          // Badge the module (or the group holding it): this is where the
          // program starts — the ▶ the label renderer prepends.
          if (nodes[kk]) nodes[kk].appEntry = 1;
        }
      });
      var hasIn: any = {};
      edges.forEach(function (e: any) { hasIn[e[1]] = 1; });
      for (var nk in nodes) if (!hasIn[nk] && !nodes[nk].ext && roots.indexOf(nk) < 0) roots.push(nk);
      if (!roots.length) for (var nk2 in nodes) roots.push(nk2);
      return { start: data0.start, depth: 99, mode: "modules", gpath: reported, roots: roots, nodes: nodes, edges: edges };
    }
    function homeData(): any {
      return data0.mode === "modules" && data0.mods ? deriveView([]) : data0;
    }
    setData(data0.mode === "modules" && data0.mods && gpath && gpath.length ? deriveView(gpath) : homeData());
    // scale null = fit-to-width on first draw. Left-right is the default —
    // call flow reads with the text; the toggle persists per reader.
    // autoScale mirrors the last scale the VIEW picked for itself. While
    // state.scale still equals it the zoom is ours to re-derive (entering
    // fullscreen re-fits); once the user works the zoom buttons the two
    // diverge and their choice is left alone.
    var state: any = { roots: data.roots.slice(), trail: [], scale: null, autoScale: null, dir: "LR", frame: null, cap: 600, showAcc: false };
    // Direction survives module -> container navigation (each page is a fresh
    // document); best-effort only — file:// or the DOM stub may lack storage.
    try { var sd = window.localStorage.getItem("geml-cg-dir"); if (sd === "TB" || sd === "LR") state.dir = sd; } catch (e) { /* no storage */ }

    // Fullscreen — the graph takes the viewport instead of its 84vh slot in the
    // reading column. Native Fullscreen API when the browser grants it (browser
    // chrome goes away, Esc is handled for us); a fixed overlay when it does not
    // — a sandboxed iframe or a denied permission still gets the space. Both
    // paths flip the SAME .cg-full class, so the stylesheet and the pane
    // measurement never have to ask which one is in force.
    var fullBtnEl: any = null;
    function isFull() { return !!(mount.classList && mount.classList.contains("cg-full")); }
    // The canvas was scaled for the old pane; after the class flips it must be
    // refitted to the new one. draw() publishes the hook (drawFrame's iframe
    // needs none and clears it), and layout has to settle before the pane can
    // be measured — hence the frame delay.
    function refit() { var f = (mount as any)._cgRefit; if (typeof f === "function") f(); }
    function scheduleRefit() { if (typeof requestAnimationFrame === "function") requestAnimationFrame(refit); else refit(); }
    function syncFullBtn() {
      if (!fullBtnEl) return;
      fullBtnEl.textContent = isFull() ? "⛶ exit fullscreen" : "⛶ fullscreen";
      fullBtnEl.title = isFull() ? "leave fullscreen (Esc)" : "fill the viewport with the graph";
    }
    function setFull(on: boolean) {
      if (mount.classList && mount.classList.toggle) mount.classList.toggle("cg-full", !!on);
      syncFullBtn();
      scheduleRefit();
    }
    function nativeFullEl(): any {
      try { return document.fullscreenElement || (document as any).webkitFullscreenElement || null; } catch (e) { return null; }
    }
    function toggleFull() {
      if (isFull()) {
        if (nativeFullEl() === mount) {
          var exit = document.exitFullscreen || (document as any).webkitExitFullscreen;
          // The class follows in the fullscreenchange handler.
          if (exit) { try { exit.call(document); return; } catch (e) { /* fall through to the overlay */ } }
        }
        setFull(false);
        return;
      }
      var req = mount.requestFullscreen || (mount as any).webkitRequestFullscreen;
      if (req) {
        try {
          var p = req.call(mount);
          // A rejected promise means permission denied (sandboxed frame,
          // permissions policy): take the overlay rather than nothing.
          if (p && typeof p.catch === "function") p.catch(function () { setFull(true); });
          setFull(true);
          return;
        } catch (e) { /* no native fullscreen — overlay below */ }
      }
      setFull(true);
    }
    // Esc leaves the OVERLAY fallback; native fullscreen handles its own Esc and
    // reports through fullscreenchange. The listeners are document-wide because
    // focus may sit on a node, the search box, or nothing at all.
    try {
      document.addEventListener("keydown", function (ev: any) { if (ev.key === "Escape" && isFull() && !nativeFullEl()) setFull(false); });
      var syncFull = function () {
        var el = nativeFullEl();
        if (!el && isFull()) setFull(false);                // left via Esc / F11 / browser UI
        else if (el === mount && !isFull()) setFull(true);
        else if (el === mount) scheduleRefit();             // class truthful, geometry still changed
      };
      document.addEventListener("fullscreenchange", syncFull);
      document.addEventListener("webkitfullscreenchange", syncFull);
    } catch (e) { /* no document listeners (fake-DOM runtime test) */ }
    // Built into whichever toolbar is drawing — the graph view and the nested
    // iframe view both get one.
    function fullBtn(bar: any) {
      var b: any = document.createElement("button");
      b.onclick = toggleFull;
      fullBtnEl = b;
      syncFullBtn();
      bar.appendChild(b);
    }

    function slice(roots: any) {
      var keep: any = {}, layer: any = {}, q: any = [], qi = 0, order: any = [];
      // Accessor noise (bean get/set/is leaves, .accessor) is hidden unless
      // toggled on; the walk COUNTS what it hides so the toolbar can say so.
      var hideAcc = data.mode !== "modules" && !state.showAcc && cgStyle(data).hideAccessors !== false;
      var accSeen: any = {}, accHidden = 0;
      roots.forEach(function (r: any) { if (data.nodes[r] && !(r in keep)) { keep[r] = 1; layer[r] = 0; q.push([r, 0]); order.push(r); } });
      while (qi < q.length) {
        var cur = q[qi][0], d = q[qi][1]; qi++;
        if (d >= data.depth) continue;
        (out[cur] || []).forEach(function (e: any) {
          var t = e[1];
          if (!data.nodes[t] || (t in keep) || accSeen[t]) return;
          if (hideAcc && data.nodes[t].acc) { accSeen[t] = 1; accHidden++; return; }
          keep[t] = 1; layer[t] = d + 1; q.push([t, d + 1]); order.push(t);
        });
      }
      // The VIEW paces itself: draw the first `cap` in BFS order, tell the
      // reader how much is beyond, let +400/all walk deeper. Data is complete.
      var total = order.length, capped = 0;
      if (data.mode !== "modules" && total > state.cap) {
        for (var oi = state.cap; oi < total; oi++) delete keep[order[oi]];
        capped = total - state.cap;
      }
      // Module overview: every module stays visible — the ones unreachable
      // from the roots (vendored deps etc.) park on one extra bottom layer.
      if (data.mode === "modules") {
        var park = 0;
        for (var kk in keep) if (layer[kk] > park) park = layer[kk];
        for (var nk in data.nodes) if (!(nk in keep)) { keep[nk] = 1; layer[nk] = park + 1; }
      }
      var color: any = {}, back: any = {};
      function dfs(u: any) {
        color[u] = 1;
        (out[u] || []).forEach(function (e: any) {
          var v = e[1]; if (!keep[v]) return;
          if (color[v] === 1) back[e[0] + ">" + e[1]] = 1;
          else if (!color[v]) dfs(v);
        });
        color[u] = 2;
      }
      roots.forEach(function (r: any) { if (keep[r] && !color[r]) dfs(r); });
      var changed = true, guard = 0;
      while (changed && guard++ < 80) {
        changed = false;
        data.edges.forEach(function (e: any) {
          if (!keep[e[0]] || !keep[e[1]] || back[e[0] + ">" + e[1]]) return;
          if (layer[e[0]] + 1 > layer[e[1]]) { layer[e[1]] = layer[e[0]] + 1; changed = true; }
        });
      }
      return { keep: keep, layer: layer, back: back, accHidden: accHidden, total: total, capped: capped };
    }

    // Nested-browser view (static pages): the clicked document's pre-rendered
    // sibling .html shown INSIDE the graph area — an in-mount iframe, never a
    // whole-page navigation. "back" restores the graph exactly as it was.
    function drawFrame() {
      mount.replaceChildren();
      var bar = document.createElement("div");
      bar.className = "cg-bar";
      var crumb = document.createElement("span");
      crumb.className = "cg-crumb";
      var backBtn: any = document.createElement("button");
      backBtn.className = "cg-seg";
      backBtn.textContent = "◂ back";
      backBtn.onclick = function () { state.frame = null; draw(); };
      crumb.appendChild(backBtn);
      var sp = document.createElement("span");
      sp.textContent = " / " + String(state.frame.rel).replace(/\.geml$/, "");
      crumb.appendChild(sp);
      bar.appendChild(crumb);
      var open = document.createElement("a");
      open.href = state.frame.html;
      open.textContent = "open standalone ↗";
      bar.appendChild(open);
      // The iframe is height:auto/flex in fullscreen, so it needs no refit —
      // drop the previous view's hook rather than leave a stale canvas one.
      (mount as any)._cgRefit = null;
      fullBtn(bar);
      mount.appendChild(bar);
      var fr: any = document.createElement("iframe");
      fr.className = "cg-frame";
      fr.setAttribute("src", state.frame.html);
      fr.setAttribute("title", state.frame.rel);
      mount.appendChild(fr);
    }

    function draw() {
      if (state.frame) { drawFrame(); return; }
      var s = slice(state.roots);
      // The callers view reads in TRUE call order — app entry first, the
      // focused method at the far end. Its slice is built from the focus
      // outward (edges callee -> caller), so flip the layers and swap edge
      // endpoints at draw time: call direction stays left->right (top->down)
      // in every view.
      var isUp = data.dir === "up";
      if (isUp) {
        var maxL = 0, fk: any;
        for (fk in s.layer) if (s.layer[fk] > maxL) maxL = s.layer[fk];
        for (fk in s.layer) s.layer[fk] = maxL - s.layer[fk];
      }
      // Group tint: front-end and back-end (and any other top-level module)
      // stopped being distinguishable once merged into one map — colour by
      // top path segment (module overview) / owning document (method view).
      var PALETTE = cgPalette(data);
      function groupOf(k: any) {
        return (data.mode === "modules"
          ? (data.nodes[k].tg || String(data.nodes[k].n).split("/")[0])
          : String(k).split("#")[0]) || "";
      }
      var gnames: any = [];
      Object.keys(s.keep).forEach(function (k) { var gn = groupOf(k); if (gnames.indexOf(gn) < 0) gnames.push(gn); });
      gnames.sort();
      var rows: any = [];
      Object.keys(s.keep).forEach(function (k) {
        (rows[s.layer[k]] = rows[s.layer[k]] || []).push(k);
      });
      rows = rows.filter(function (r: any) { return r && r.length; });
      // In-layer order: group first (same-tint nodes sit together), name
      // second — and the layout leaves a small extra gap where the group
      // changes, so the colour runs read as blocks.
      rows.forEach(function (r: any) {
        r.sort(function (a: any, b: any) {
          var ga = groupOf(a), gb = groupOf(b);
          if (ga !== gb) return ga < gb ? -1 : 1;
          return data.nodes[a].n < data.nodes[b].n ? -1 : 1;
        });
      });
      var NH = 26, GY = 44, GX = 14, GYL = 12, GXL = 70, GG = 22, pos: any = {}, W = 320, H = 0;
      var LR = state.dir === "LR";
      var isMethod = data.mode !== "modules";
      // Box width follows the DISPLAYED label, and the label is truncated to
      // fit the box — long dir-path module names used to overflow their 220px
      // cap and stack onto their neighbours. Modules keep the TAIL (the
      // informative end of a path), methods keep the head. The ⊕ direction
      // handle is now its OWN node beside the box (drawn below), so the box
      // width no longer reserves room for it.
      function label(k: any) {
        var n = data.nodes[k];
        // ▶ = this module (or group) holds an app entry — where the program
        // starts, from index meta entry= / app-entry-docs.
        var full = (n.appEntry || n.entry ? "▶ " : "") + n.n + (n.more ? " ›" : "");
        if (full.length <= 32) return full;
        return data.mode === "modules" ? "…" + full.slice(full.length - 31) : full.slice(0, 31) + "…";
      }
      // The ⊕ callers handle sits only on the current view's ROOTS: a
      // mid-graph node's callers are already drawn as its in-edges — the
      // entry is the one place the upstream is invisible. In the callers
      // view the focused method (far end) carries the mirrored handle that
      // flips back to its callee chain.
      function hasUp(k: any) { return isMethod && !isUp && state.roots.indexOf(k) >= 0; }
      function hasDown(k: any) { return isUp && k === data.focus; }
      function bw(k: any) { return Math.max(56, label(k).length * 7.2 + 18); }
      if (!LR) {
        rows.forEach(function (r: any, ri: any) {
          var x = 0;
          r.forEach(function (k: any, i: any) {
            if (i > 0 && groupOf(r[i - 1]) !== groupOf(k)) x += GG;
            var w = bw(k);
            pos[k] = { x: x, y: ri * (NH + GY), w: w };
            x += w + GX;
          });
          W = Math.max(W, x - GX);
        });
        rows.forEach(function (r: any) {
          var rw = pos[r[r.length - 1]].x + pos[r[r.length - 1]].w;
          var off = (W - rw) / 2;
          r.forEach(function (k: any) { pos[k].x += off; });
        });
        H = rows.length * (NH + GY) - GY;
      } else {
        // Left-to-right: layers become columns, flow reads with the text.
        var cx = 0, colHs: any = [];
        rows.forEach(function (r: any, ci: any) {
          var cw = 0, y = 0;
          r.forEach(function (k: any, i: any) {
            if (i > 0 && groupOf(r[i - 1]) !== groupOf(k)) y += GG;
            var w = bw(k);
            pos[k] = { x: cx, y: y, w: w };
            y += NH + GYL;
            if (w > cw) cw = w;
          });
          colHs[ci] = y - GYL;
          if (colHs[ci] > H) H = colHs[ci];
          cx += cw + GXL;
        });
        W = Math.max(320, cx - GXL);
        rows.forEach(function (r: any, ci: any) {
          var off = (H - colHs[ci]) / 2;
          r.forEach(function (k: any) { pos[k].y += off; });
        });
      }
      // The standalone ⊕ node sits just OUTSIDE the box on the direction it
      // points — reserve a margin so it never clips the canvas edge or a
      // neighbour. It rides the caller side of a callee-view entry (left in
      // LR, top in TB) and the callee side of the callers-view focus (right /
      // bottom). Only one side is ever active in a given view.
      var UBOFF = 17, UBPAD = 24;
      var anyUp = false, anyDown = false;
      Object.keys(s.keep).forEach(function (k) { if (hasUp(k)) anyUp = true; else if (hasDown(k)) anyDown = true; });
      var padL = anyUp && LR ? UBPAD : 0, padT = anyUp && !LR ? UBPAD : 0;
      var padR = anyDown && LR ? UBPAD : 0, padB = anyDown && !LR ? UBPAD : 0;
      if (padL || padT) for (var pk in pos) { pos[pk].x += padL; pos[pk].y += padT; }
      W += padL + padR; H += padT + padB;
      var svg = h("svg", { viewBox: "0 0 " + W + " " + (H + 8), class: "cg-svg", role: "img" });
      // Small arrowheads, always pointing at the CALLEE — two fixed markers
      // (normal grey, back-edge red) rather than context-stroke, which not
      // every engine paints yet.
      var arrId = "cg-arr-" + arrowSeq++;
      var defs = h("defs", {});
      [["", "#94a3b8"], ["-b", "#dc2626"]].forEach(function (mdef: any) {
        var mk = h("marker", { id: arrId + mdef[0], viewBox: "0 0 10 10", refX: 8.5, refY: 5, markerWidth: 5.5, markerHeight: 5.5, orient: "auto" });
        mk.appendChild(h("path", { d: "M0 1.2 L8.5 5 L0 8.8 z", fill: mdef[1] }));
        defs.appendChild(mk);
      });
      svg.appendChild(defs);
      // Hover: light up the CALLER CONE of the node under the pointer —
      // every upstream node and edge in the current view — and dim the rest.
      // upAdj maps each node to its callers within the drawn slice (in the
      // callers view the data edges already point callee -> caller).
      var upAdj: any = {};
      var nodeEls: any = {}, nodeBase: any = {};
      var edgeEls: any = {}, edgeBase: any = {};
      data.edges.forEach(function (e: any) {
        var a = pos[isUp ? e[1] : e[0]], b = pos[isUp ? e[0] : e[1]];
        if (!a || !b) return;
        var isBack = s.back[e[0] + ">" + e[1]] || (e[0] === e[1]);
        var cls = "cg-e" + (e[2] === "candidate" ? " cand" : "") + (e[2] === "http" ? " http" : "") + (isBack ? " back" : "") + (e[3] === "medium" || e[3] === "low" ? " soft" : "");
        var p;
        if (e[0] === e[1]) {
          p = LR
            ? "M" + (a.x + 8) + " " + (a.y + NH) + " c 0 16 16 16 16 0"
            : "M" + (a.x + a.w) + " " + (a.y + 8) + " c 18 0 18 " + (NH - 16) + " 0 " + (NH - 16);
        } else if (isBack) {
          if (LR) {
            var yb = Math.max(a.y, b.y) + NH + 24;
            p = "M" + (a.x + a.w / 2) + " " + (a.y + NH) + " C " + (a.x + a.w / 2) + " " + yb + " " + (b.x + b.w / 2) + " " + yb + " " + (b.x + b.w / 2) + " " + (b.y + NH);
          } else {
            var xr = Math.max(a.x + a.w, b.x + b.w) + 22;
            p = "M" + (a.x + a.w) + " " + (a.y + NH / 2) + " C " + xr + " " + (a.y + NH / 2) + " " + xr + " " + (b.y + NH / 2) + " " + (b.x + b.w) + " " + (b.y + NH / 2);
          }
        } else if (LR) {
          var lx1 = a.x + a.w, ly1 = a.y + NH / 2, lx2 = b.x, ly2 = b.y + NH / 2;
          p = "M" + lx1 + " " + ly1 + " C " + (lx1 + GXL / 2) + " " + ly1 + " " + (lx2 - GXL / 2) + " " + ly2 + " " + lx2 + " " + ly2;
        } else {
          var x1 = a.x + a.w / 2, y1 = a.y + NH, x2 = b.x + b.w / 2, y2 = b.y;
          p = "M" + x1 + " " + y1 + " C " + x1 + " " + (y1 + GY / 2) + " " + x2 + " " + (y2 - GY / 2) + " " + x2 + " " + y2;
        }
        var pathEl = h("path", { d: p, class: cls, "marker-end": "url(#" + arrId + (isBack ? "-b" : "") + ")" });
        if (e[2] === "http" && e[4]) { var tt = h("title", {}); tt.textContent = e[4]; pathEl.appendChild(tt); } // endpoint on hover
        var ek = e[0] + ">" + e[1];
        edgeEls[ek] = pathEl;
        edgeBase[ek] = cls;
        var callee = isUp ? e[0] : e[1], caller = isUp ? e[1] : e[0];
        (upAdj[callee] = upAdj[callee] || []).push({ n: caller, k: ek });
        if (data.mode === "modules" && e[3]) {
          var et = h("title", {});
          et.textContent = e[3] + " call(s)";
          pathEl.appendChild(et);
        }
        svg.appendChild(pathEl);
      });
      Object.keys(s.keep).forEach(function (k) {
        var n = data.nodes[k], a = pos[k];
        var ncls = "cg-n" + (n.leaf ? " leaf" : "") + (n.test ? " test" : "") + (n.grp ? " grp" : "") + (state.roots.indexOf(k) >= 0 ? " root" : "");
        var g = h("g", { class: ncls, "data-k": k, transform: "translate(" + a.x + "," + a.y + ")" });
        nodeEls[k] = g;
        nodeBase[k] = ncls;
        g.appendChild(h("rect", { width: a.w, height: NH, rx: 6, style: "fill:" + PALETTE[gnames.indexOf(groupOf(k)) % PALETTE.length] }));
        var t = h("text", { x: hasUp(k) ? a.w / 2 + 8 : hasDown(k) ? a.w / 2 - 8 : a.w / 2, y: NH / 2 + 4, "text-anchor": "middle" });
        t.textContent = label(k);
        g.appendChild(t);
        var tip = h("title", {});
        tip.textContent = data.mode === "modules"
          ? (n.grp ? (n.grp.join("/") + "\nclick: open this group")
            : n.ext ? ("external dependency: " + n.n.replace(/^↗ /, ""))
            : n.n + "\nclick: open this module")
          : k + (n.src ? "\n" + n.src : "") + "\nclick = view source";
        g.appendChild(tip);
        svg.appendChild(g);
        if (hasUp(k) || hasDown(k)) {
          // The ⊕ handle (GEP-0003 caller direction) is now its OWN node
          // beside the box — no longer a child glued inside the box edge.
          // Same data-k / data-act / click: it focuses this node and TOGGLES
          // direction. It sits on the LEFT of a callee-view entry (expand
          // callers) and mirrors to the RIGHT of the callers-view focus (flip
          // back down); in top-down those become above / below. The reserved
          // margin above keeps it clear of the canvas edge and neighbours.
          var up = hasUp(k), ubx, uby;
          if (up) { if (LR) { ubx = a.x - UBOFF; uby = a.y + NH / 2; } else { ubx = a.x + a.w / 2; uby = a.y - UBOFF; } }
          else { if (LR) { ubx = a.x + a.w + UBOFF; uby = a.y + NH / 2; } else { ubx = a.x + a.w / 2; uby = a.y + NH + UBOFF; } }
          // Dashed connector ties the handle to its node and shows which way
          // the hidden chain flows: callers flow INTO the node (⊕ -> box),
          // callees flow OUT of it (box -> ⊕). Same grey + arrowhead as real
          // edges; dashed = "not expanded yet"; never a click target.
          var R = 6.5, TIP = 1.5, lx1, ly1, lx2, ly2;
          if (up) {
            if (LR) { lx1 = ubx + R; ly1 = uby; lx2 = a.x - TIP; ly2 = uby; }
            else { lx1 = ubx; ly1 = uby + R; lx2 = ubx; ly2 = a.y - TIP; }
          } else if (LR) { lx1 = a.x + a.w + TIP; ly1 = uby; lx2 = ubx - R - TIP; ly2 = uby; }
          else { lx1 = ubx; ly1 = a.y + NH + TIP; lx2 = ubx; ly2 = uby - R - TIP; }
          svg.appendChild(h("path", { class: "cg-uplink", d: "M" + lx1 + " " + ly1 + " L" + lx2 + " " + ly2, "marker-end": "url(#" + arrId + ")" }));
          var ub = h("g", { class: "cg-upbtn", "data-k": k, "data-act": up ? "up" : "down", transform: "translate(" + ubx + "," + uby + ")" });
          ub.appendChild(h("circle", { r: 6.5 }));
          var ut = h("text", { x: 0, y: 3.5, "text-anchor": "middle" });
          ut.textContent = "+";
          ub.appendChild(ut);
          var utip = h("title", {});
          utip.textContent = up ? "⊕ expand the full caller chain" : "⊕ back to its callee chain";
          ub.appendChild(utip);
          svg.appendChild(ub);
        }
      });
      // Natural pixel size; only the inner .cg-scroll pane scrolls, so the
      // toolbar (crumb/zoom/back) and the footer stay visible however big the
      // canvas gets. Squeezing a 16,000px canvas into the column made 1px
      // text — never again.
      svg.setAttribute("width", String(W));
      svg.setAttribute("height", String(H + 8));
      // Rendered pages sit next to their codemap documents: a live mount
      // (viewer/playground) carries data-src, a CLI embed carries the src
      // path in data.start — either directory anchors doc-relative links.
      // navBase prefixes EVERY url this view reaches for — the breadcrumb's
      // `location.href`, the search-index `<script src>`, a hit's jump target.
      // Both of its inputs are page data (a DOM attribute, the embedded graph
      // JSON), so a document that carried `data-src="javascript:…"` would turn
      // a breadcrumb click into script execution, and a `//host/` or
      // `https://host/` value would pull the search index off another origin.
      // A base is a doc-relative DIRECTORY and nothing else: anything bearing a
      // scheme or a network-path prefix is refused outright and links resolve
      // against the current page instead.
      // Everything this view navigates to or loads is built from page data, so
      // every such string is filtered here first: keep it if it is a
      // document-RELATIVE path, drop it to "" if it carries a scheme
      // (`javascript:`, `data:`) or a `//host` network-path prefix.
      //
      // DECIDE ON THE STRING THE BROWSER WILL SEE, NOT THE ONE WE WERE HANDED.
      // Before navigating, a browser strips leading and trailing C0 controls and
      // spaces and ignores TAB/CR/LF anywhere inside the scheme. Testing the raw
      // bytes let the whole classic bypass family through — ` javascript:…`,
      // `\tjavascript:…`, `java<TAB>script:…`, `\x01javascript:…`,
      // ` data:text/html,…`, ` //evil.host/` — each of which fails the scheme
      // test as written and then executes once the browser normalises it.
      // Normalise first, judge second, and return the NORMALISED value: handing
      // the sink the raw string would give it bytes that were never checked.
      function relOnly(u: any): string {
        var raw = String(u == null ? "" : u).replace(/[\t\n\r]/g, "");
        // Trim C0-and-space by scan, not by /^[\x00-\x20]+|[\x00-\x20]+$/ — an
        // end-anchored run is the very quadratic shape this file's fence
        // scanners were just cured of.
        var a = 0, b = raw.length;
        while (a < b && raw.charCodeAt(a) <= 0x20) a++;
        while (b > a && raw.charCodeAt(b - 1) <= 0x20) b--;
        var s = raw.slice(a, b);
        if (!s) return "";
        return /^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(s) || s.slice(0, 2) === "//" ? "" : s;
      }
      var navBase = relOnly(String(mount.getAttribute("data-src") || data.start || "").replace(/[^\/]*$/, ""));
      // A live mount (viewer/playground/served page) navigates IN PLACE over
      // the geml documents through this loader; only truly static pages fall
      // back to their pre-rendered sibling .html pages. Read LAZILY on every
      // use: a served page attaches the hook from an async module script that
      // loads after the first draw, and late binding must still take effect
      // on the very next interaction — no redraw, no lost state.
      var live = function (): any { return (mount as any)._cgView; };
      mount.replaceChildren();
      var bar = document.createElement("div");
      bar.className = "cg-bar";
      // Breadcrumb: modules / <container> / <state> — the hierarchy is
      // entry -> module -> method view, and both upper levels are clickable.
      var crumb = document.createElement("span");
      crumb.className = "cg-crumb";
      function seg(txt: string, fn: any) {
        var el: any = document.createElement(fn ? "button" : "span");
        if (fn) { el.className = "cg-seg"; el.onclick = fn; }
        el.textContent = txt;
        crumb.appendChild(el);
      }
      function sepEl() { var sp = document.createElement("span"); sp.textContent = " / "; crumb.appendChild(sp); }
      // A transient in-bar error — the "don't jump, say why" half of the
      // contract: an unloadable target reports here and the view stays put.
      function flash(msg: string) {
        var f = document.createElement("span");
        f.className = "cg-flash";
        f.textContent = msg;
        bar.appendChild(f);
        try { setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 5000); } catch (e) { /* stub */ }
      }
      function openDoc(rel0: string, gpath?: any) {
        // The target can come from a node's own data (a `data-k` key), not just
        // from a breadcrumb we built — so it goes through the same relative-path
        // filter as navBase. An absolute or scheme-bearing target says why it
        // was refused rather than navigating.
        var rel = relOnly(rel0);
        if (!rel) { flash("refusing to open " + String(rel0) + " — not a document-relative path"); return; }
        var lv = live();
        if (lv) {
          Promise.resolve(lv({ doc: rel })).then(
            function (nd: any) {
              if (!nd) { flash("cannot load " + rel); return; }
              // A module index ships RAW rows — its nodes come from deriveView,
              // which is bound to a document's own data0. Re-boot on the loaded
              // payload so its grouping tree derives; pushView alone would draw
              // the empty raw payload (nodes come out {}).
              if (nd.mode === "modules" && nd.mods) boot(mount, nd, gpath);
              else pushView(nd);
            },
            function () { flash("cannot load " + rel); },
          );
          return;
        }
        var html = rel.replace(/\.geml$/, ".html");
        // Inside the nested frame the frame IS the browser — navigate it
        // plainly instead of stacking frame-in-frame.
        var framed = false;
        try { framed = window.self !== window.top; } catch (e) { /* no window: top */ }
        if (framed) { window.location.href = html; return; }
        function embed() { state.frame = { rel: rel, html: html }; draw(); }
        // Served over http(s): probe first, so a missing page reports in
        // place and nothing navigates. file:// cannot probe (fetch is
        // blocked) — embed directly; the frame contains any error itself.
        try {
          if (/^https?:$/.test(window.location.protocol)) {
            if (!cgSameOrigin(html)) { flash("cannot reach " + html + " (cross-origin blocked)"); return; }
            fetch(html, { method: "HEAD", credentials: "omit" }).then(function (r: any) {
              if (r.ok) embed(); else flash("page missing: " + html + " — re-run the codemap render");
            }).catch(function () { flash("cannot reach " + html); });
            return;
          }
        } catch (e) { /* no fetch/location — treat like file:// */ }
        embed();
      }
      if (data.mode === "modules") {
        // Breadcrumb over the grouping tree. Tunnelled runs (levels with a
        // single child — Java package ceremony) merge into ONE hop, labelled
        // first/…/last, so the crumb shows only the steps a reader chose.
        var gp: any = data.gpath || [];
        seg("modules", gp.length ? function () { pushView(deriveView([])); } : null);
        var hops: any = [];
        var cur: any = [];
        for (var hi = 0; hi < gp.length; hi++) {
          var hpre = hi === 0 ? "" : gp.slice(0, hi).join("/") + "/";
          var seen: any = {}, branches = 0;
          data0.mods.forEach(function (m: any) {
            if (hpre && m.p.indexOf(hpre) !== 0) return;
            var rest = m.p.slice(hpre.length);
            var c = rest.indexOf("/");
            var s2 = c < 0 ? rest : rest.slice(0, c);
            if (!seen[s2]) { seen[s2] = 1; branches++; }
          });
          if (branches > 1 || hi === 0) { if (cur.length) hops.push(cur); cur = [hi]; }
          else cur.push(hi);
        }
        if (cur.length) hops.push(cur);
        hops.forEach(function (hop: any, oi: any) {
          sepEl();
          var lbl = hop.length === 1 ? gp[hop[0]]
            : hop.length === 2 ? gp[hop[0]] + "/" + gp[hop[hop.length - 1]]
            : gp[hop[0]] + "/…/" + gp[hop[hop.length - 1]];
          var endIdx = hop[hop.length - 1];
          seg(lbl, oi < hops.length - 1 ? function () { pushView(deriveView(gp.slice(0, endIdx + 1))); } : null);
        });
      } else {
        seg("modules", function () { openDoc(navBase + "index.geml"); });
        sepEl();
        var modName = String(data.module || String(data.start || "").replace(/^.*\//, "").replace(/\.geml$/, "") || "container");
        // The middle crumb reads as the OVERVIEW level ("modules / <module>"),
        // so clicking it goes THERE — the module tier listing this container's
        // siblings — not a reload of the page you are already on.
        seg(modName, function () {
          if (live()) openDoc(navBase + "index.geml", [modName.split("/")[0]]);
          else { state.trail = []; setData(homeData()); state.roots = data.roots.slice(); draw(); }
        });
        sepEl();
        seg(
          data.dir === "up"
            ? "callers of " + (data.nodes[data.focus] ? data.nodes[data.focus].n : "") + (data.partial ? " (in-slice)" : "") + (Object.keys(data.nodes).length <= 1 ? " — none recorded" : "")
            : state.trail.length && state.roots.length === 1 ? "root: " + (data.nodes[state.roots[0]] || {}).n
            // Many roots = this IS the module's own view (its whole entry
            // list) — the methods are already on the graph; naming them all
            // here just makes a paragraph-long crumb.
            : state.trail.length ? "roots: entry"
            : "roots: entry",
          null,
        );
      }
      bar.appendChild(crumb);
      var scroller = document.createElement("div");
      scroller.className = "cg-scroll";
      scroller.appendChild(svg);
      // The graph and the source panel sit side by side in a flex stage; the
      // panel is empty (hidden) until a method node is clicked, so the graph
      // uses the full width until then.
      var srcPanel = document.createElement("div");
      srcPanel.className = "cg-src";
      srcPanel.style.display = "none";
      var stage = document.createElement("div");
      stage.className = "cg-stage";
      stage.appendChild(scroller);
      stage.appendChild(srcPanel);
      // The scroll pane is capped at 84vh by CSS (keep the 0.84 here in step with
      // it); before first layout its clientHeight is the unconstrained content
      // height, so derive the cap from the viewport. In fullscreen the pane is a
      // flex child with a real measured height, so trust clientHeight there and
      // fall back to nearly the whole viewport. Guards keep a collapsed pane
      // (mid-layout measure) from producing a negative or zero scale — invalid
      // CSS would silently keep the previous size.
      function paneSize() {
        var mw = scroller.clientWidth || mount.clientWidth || 0;
        var mh = 0;
        try {
          mh = isFull()
            ? Math.max(120, scroller.clientHeight || Math.floor(window.innerHeight * 0.92))
            : Math.floor(window.innerHeight * 0.84);
        } catch (e) { /* no window (stub) */ }
        return { w: mw, h: mh };
      }
      // The fit BUTTON: whole-graph preview, both axes visible, no floor.
      function fitScale() {
        var p = paneSize(), s = 1;
        if (p.w > 60 && W) s = Math.min(s, (p.w - 26) / W);
        if (p.h > 60 && H) s = Math.min(s, (p.h - 10) / (H + 8));
        return Math.max(s, 0.05);
      }
      // The INITIAL view fits the CROSS axis only — height in left-right,
      // width in top-down; the reading axis is meant to scroll — clamped to
      // [2/3, 1] so text never drops below ~8px. Small and medium graphs
      // land on exactly 1:1; the overview stays one "fit" click away.
      function initialScale() {
        var p = paneSize(), s = 1;
        if (LR) { if (p.h > 60 && H) s = (p.h - 10) / (H + 8); }
        else if (p.w > 60 && W) s = (p.w - 26) / W;
        return Math.min(1, Math.max(2 / 3, s));
      }
      function applyScale() {
        svg.style.width = Math.round(W * state.scale) + "px";
        svg.style.height = Math.round((H + 8) * state.scale) + "px";
        svg.style.maxWidth = "none";
      }
      function zoomBtn(label: string, fn: any) {
        var b = document.createElement("button");
        b.textContent = label;
        b.onclick = function () { fn(); applyScale(); };
        bar.appendChild(b);
      }
      zoomBtn("−", function () { state.scale = Math.max(0.1, state.scale * 0.75); });
      zoomBtn("+", function () { state.scale = Math.min(4, state.scale / 0.75); });
      zoomBtn("fit", function () { state.scale = fitScale(); });
      zoomBtn("1:1", function () { state.scale = 1; });
      // Entering or leaving fullscreen resizes the pane under a canvas that was
      // scaled for the old one. Re-derive the SAME kind of scale the view opens
      // with (cross-axis fit, floored at 2/3 so text stays readable) — not
      // "fit", which would shrink a tall graph to a stamp exactly when the user
      // asked for more room. A hand-picked zoom is never overridden.
      // applyScale/initialScale are per-draw closures over THIS canvas, so
      // republish the hook on every draw.
      (mount as any)._cgRefit = function () {
        if (state.scale !== state.autoScale) return;
        state.autoScale = state.scale = initialScale();
        applyScale();
      };
      fullBtn(bar);
      var dirBtn = document.createElement("button");
      dirBtn.textContent = LR ? "top-down" : "left-right";
      dirBtn.onclick = function () {
        state.dir = LR ? "TB" : "LR";
        try { window.localStorage.setItem("geml-cg-dir", state.dir); } catch (e) { /* no storage */ }
        draw();
      };
      bar.appendChild(dirBtn);
      // Accessor noise: hidden by default, one honest button to bring it back.
      if (s.accHidden > 0 || state.showAcc) {
        var accBtn = document.createElement("button");
        accBtn.textContent = state.showAcc ? "hide accessors" : s.accHidden + " accessors hidden";
        accBtn.onclick = function () { state.showAcc = !state.showAcc; draw(); };
        bar.appendChild(accBtn);
      }
      // View pacing: the slice beyond the cap is one click away, never lost.
      if (s.capped > 0) {
        var capInfo = document.createElement("span");
        capInfo.className = "cg-note";
        capInfo.textContent = "showing " + (s.total - s.capped) + " of " + s.total + " reachable";
        bar.appendChild(capInfo);
        var moreBtn = document.createElement("button");
        moreBtn.textContent = "+600";
        moreBtn.onclick = function () { state.cap += 600; draw(); };
        bar.appendChild(moreBtn);
        var allBtn = document.createElement("button");
        allBtn.textContent = "all";
        allBtn.onclick = function () { state.cap = 1e9; draw(); };
        bar.appendChild(allBtn);
      }
      if (state.trail.length) {
        var backBtn = document.createElement("button");
        backBtn.textContent = "back";
        backBtn.onclick = function () { var tr = state.trail.pop(); setData(tr.data); state.roots = tr.roots; draw(); };
        bar.appendChild(backBtn);
        var resetBtn = document.createElement("button");
        resetBtn.textContent = "reset";
        resetBtn.onclick = function () { state.trail = []; setData(homeData()); state.roots = data.roots.slice(); draw(); };
        bar.appendChild(resetBtn);
      }
      // Find a method by name -> jump to its node. Data source: a served page
      // (http) queries the /_search endpoint (top matches only — a huge index
      // never ships); a static page (file://) lazy-loads the compact
      // _index/search-index.js via <script> (fetch is CORS-blocked on file://,
      // a script tag is not). Picking a hit opens its FOCUSED call graph (B)
      // in place on a served page; on a static page (no live loader) it
      // navigates to the node's document (A). Alt-click always just locates.
      if (typeof location !== "undefined") { // browser only — skipped in the fake-DOM runtime test
      var searchWrap = document.createElement("span");
      searchWrap.className = "cg-search-wrap";
      var searchBox = document.createElement("input");
      searchBox.type = "search"; searchBox.className = "cg-search";
      searchBox.placeholder = "find a method…";
      searchBox.setAttribute("aria-label", "Find a method by name");
      var searchMenu = document.createElement("div");
      searchMenu.className = "cg-search-menu"; searchMenu.hidden = true;
      searchWrap.appendChild(searchBox); searchWrap.appendChild(searchMenu);
      bar.appendChild(searchWrap);
      var srvSearch = /^https?:$/.test(location.protocol);
      function withIndex(cb: any) {
        if ((window as any).__gemlSearch) return cb((window as any).__gemlSearch);
        if (!cgSameOrigin(navBase + "_index/search-index.js")) { cb([]); return; }
        var s = document.createElement("script");
        s.src = navBase + "_index/search-index.js";
        s.onload = function () { cb((window as any).__gemlSearch || []); };
        s.onerror = function () { cb([]); };
        document.head.appendChild(s);
      }
      // Rank exactly like serve's /_search (exact > prefix > qualified-tail
      // prefix > substring), so both data paths order hits the same way.
      function hitScore(n: string, q: string) {
        if (n === q) return 0;
        if (n.indexOf(q) === 0) return 1;
        var c2 = n.lastIndexOf("::"), d = n.lastIndexOf(".");
        var cut = Math.max(c2 >= 0 ? c2 + 2 : 0, d >= 0 ? d + 1 : 0);
        if (cut > 0 && n.slice(cut).indexOf(q) === 0) return 2;
        return n.indexOf(q) >= 0 ? 3 : -1;
      }
      function candidates(q: string, cb: any) {
        q = q.trim().toLowerCase();
        if (q.length < 2) return cb({ total: 0, hits: [] });
        if (srvSearch) {
          fetch("/_search?q=" + encodeURIComponent(q))
            .then(function (r) { return r.ok ? r.json() : { total: 0, hits: [] }; })
            .then(function (a) { cb(a && a.hits ? a : { total: 0, hits: [] }); })
            .catch(function () { cb({ total: 0, hits: [] }); });
        } else {
          withIndex(function (rows: any) {
            var ranked = [];
            for (var i = 0; i < rows.length; i++) {
              var s = hitScore(String(rows[i][0]).toLowerCase(), q);
              if (s >= 0) ranked.push({ s: s, name: rows[i][0], doc: rows[i][1], id: rows[i][2] });
            }
            ranked.sort(function (a: any, b: any) { return a.s - b.s || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
            // The lookup aliases bare member names to the same node — dedupe
            // on doc#id, keeping the best-ranked row.
            var seen: any = {}, hits = [];
            for (var j = 0; j < ranked.length; j++) {
              var rj: any = ranked[j];
              var k = rj.doc + "#" + rj.id;
              if (seen[k]) continue;
              seen[k] = 1;
              hits.push(rj);
            }
            cb({ total: hits.length, hits: hits.slice(0, 100) });
          });
        }
      }
      function gotoHit(doc0: string, id: string, locate: boolean) {
        searchMenu.hidden = true;
        // `doc` is a row from the loaded search index — page data, same as any
        // other target, so it gets the same relative-path filter.
        var doc = relOnly(doc0);
        if (!doc) { flash("refusing to open " + String(doc0) + " — not a document-relative path"); return; }
        if (live() && !locate) { showCallees(doc + "#" + id); return; }
        location.href = navBase + doc.replace(/\.geml$/, ".html") + "#" + encodeURIComponent(id);
      }
      var searchSeq = 0, searchTop: any = null; // best-ranked hit — Enter opens it
      searchBox.addEventListener("input", function () {
        var my = ++searchSeq, qv = searchBox.value;
        candidates(qv, function (res: any) {
          if (my !== searchSeq) return; // a newer keystroke already fired
          searchMenu.replaceChildren();
          var hits = res.hits || [];
          searchTop = hits.length ? hits[0] : null;
          if (!hits.length) { searchMenu.hidden = true; return; }
          // Honest count first — a capped list must say so.
          var count = document.createElement("div");
          count.className = "cg-search-count";
          count.textContent = (res.total > hits.length ? "showing " + hits.length + " of " + res.total + " matches" : res.total + (res.total === 1 ? " match" : " matches")) + " · Enter opens the first";
          searchMenu.appendChild(count);
          // Group by module (document), groups in best-hit order — hits arrive
          // globally ranked, so first appearance = the group's best rank.
          var order: any = [], byDoc: any = {};
          hits.forEach(function (c: any) {
            if (!byDoc[c.doc]) { byDoc[c.doc] = []; order.push(c.doc); }
            byDoc[c.doc].push(c);
          });
          order.forEach(function (doc: any) {
            var hd = document.createElement("div");
            hd.className = "cg-search-grp";
            hd.textContent = String(doc).replace(/\.geml$/, "").replace(/--/g, "/");
            searchMenu.appendChild(hd);
            byDoc[doc].forEach(function (c: any) {
              var row = document.createElement("button");
              row.className = "cg-search-row"; row.type = "button";
              var nm = document.createElement("b"); nm.textContent = c.name;
              row.appendChild(nm);
              row.onclick = function (ev: any) { gotoHit(c.doc, c.id, !!ev.altKey); };
              searchMenu.appendChild(row);
            });
          });
          searchMenu.hidden = false;
        });
      });
      searchBox.addEventListener("keydown", function (ev: any) {
        if (ev.key === "Escape") { searchMenu.hidden = true; searchBox.blur(); }
        else if (ev.key === "Enter" && searchTop) { ev.preventDefault(); gotoHit(searchTop.doc, searchTop.id, !!ev.altKey); }
      });
      document.addEventListener("click", function (ev: any) { if (!searchWrap.contains(ev.target)) searchMenu.hidden = true; });
      } // end browser-only search box
      mount.appendChild(bar);
      mount.appendChild(stage);
      if (state.scale === null) state.autoScale = state.scale = initialScale();
      applyScale();
      if (isUp) {
        // The focused method sits at the FAR end of the callers chain —
        // scroll it into view instead of opening on the app-entry end.
        if (LR) scroller.scrollLeft = 1e6; else scroller.scrollTop = 1e6;
      }
      // Centre the CROSS axis (the fit-to-pane one): the tree fans out around
      // its midline, so a big graph clamped to the 2/3 scale floor would
      // otherwise open on an empty top/left corner with every node off-screen.
      // Reading the scroll extent forces the post-applyScale reflow; when the
      // cross axis already fits, the delta is ≤0 and this is a no-op. The
      // reading axis is untouched (root start, or far-end for callers above).
      // If the view holds an app entry (▶), aim the midline at the FIRST one
      // (roots first, then any node) instead of the geometric centre — the
      // reader lands where the program starts.
      var entryK: any = null;
      state.roots.concat(Object.keys(data.nodes)).some(function (ek: any) {
        var en = data.nodes[ek];
        if (en && (en.appEntry || en.entry) && pos[ek]) { entryK = ek; return true; }
        return false;
      });
      var aim = function (full: number, pane: number, at: number) { return Math.max(0, Math.min(full - pane, at - pane / 2)); };
      if (LR) scroller.scrollTop = entryK
        ? aim(scroller.scrollHeight, scroller.clientHeight, (pos[entryK].y + NH / 2) * state.scale)
        : Math.max(0, (scroller.scrollHeight - scroller.clientHeight) / 2);
      else scroller.scrollLeft = entryK
        ? aim(scroller.scrollWidth, scroller.clientWidth, (pos[entryK].x + pos[entryK].w / 2) * state.scale)
        : Math.max(0, (scroller.scrollWidth - scroller.clientWidth) / 2);
      // Footer: live facts, not a static cheat-sheet (navigation lives in
      // the breadcrumb above).
      var footer = document.createElement("div");
      footer.className = "cg-legend";
      var info = document.createElement("span");
      info.textContent = data.mode === "modules"
        ? Object.keys(s.keep).length + " modules · " + data.edges.length + " edges · click a module to open it"
        : isUp && Object.keys(data.nodes).length <= 1
          ? "no recorded callers — framework/reflective entry points and dead code have none · ⊕ at the end = back to callees"
          : Object.keys(s.keep).length + "/" + Object.keys(data.nodes).length + " methods in view · click = view source · " + (isUp ? "⊕ at the end = back to callees" : "⊕ on an entry = full caller chain");
      footer.appendChild(info);
      mount.appendChild(footer);
      // Colour key — one chip per group (skip when it would be noise).
      if (gnames.length > 1 && gnames.length <= 14) {
        var chips = document.createElement("div");
        chips.className = "cg-groups";
        gnames.forEach(function (gn: any) {
          var chip = document.createElement("span");
          chip.className = "cg-chip";
          var sw = document.createElement("i");
          sw.style.background = PALETTE[gnames.indexOf(gn) % PALETTE.length] || "";
          chip.appendChild(sw);
          var lbl = document.createElement("span");
          lbl.textContent = gn || "(root)";
          chip.appendChild(lbl);
          chips.appendChild(chip);
        });
        mount.appendChild(chips);
      }
      function pushView(nd: any) {
        state.trail.push({ data: data, roots: state.roots });
        setData(nd);
        state.roots = nd.roots.slice();
        draw();
      }
      // Caller direction (GEP-0003): a live mount rebuilds through its
      // document loader (mount._cgView, attached by the upgrade step); a
      // static CLI page reverses its in-slice edges — partial but honest,
      // and labelled as such in the crumb.
      // No recorded callers (an app/framework entry, or dead code): "up" from
      // a METHOD is its CONTAINER — one level, never the whole-repo overview
      // two levels up. From a focused/derived view that means the method's own
      // container page (the view its module node opens); already sitting on
      // that default view, say why and stay put — the "don't jump, say why"
      // contract.
      function noCallers(k: any) {
        var docRel = k.slice(0, k.lastIndexOf("#"));
        if (docRel !== data0.start) { openDoc(navBase + docRel); return; }
        if (state.trail.length) { state.trail = []; setData(homeData()); state.roots = data.roots.slice(); draw(); return; }
        flash("no recorded callers — an app/framework entry point");
      }
      function showCallers(k: any) {
        var lv = live();
        if (lv) {
          Promise.resolve(lv({ dir: "up", node: k })).then(function (nd: any) {
            if (nd && Object.keys(nd.nodes).length > 1) pushView(nd);
            else noCallers(k);
          });
          return;
        }
        var rin: any = {};
        data0.edges.forEach(function (e: any) { (rin[e[1]] = rin[e[1]] || []).push(e[0]); });
        var keep: any = {}; keep[k] = 1; var q: any = [k], qi = 0;
        while (qi < q.length) {
          var c = q[qi++];
          (rin[c] || []).forEach(function (p: any) { if (!keep[p]) { keep[p] = 1; q.push(p); } });
        }
        if (Object.keys(keep).length <= 1) { noCallers(k); return; }
        var nodes: any = {}, edges: any = [];
        for (var nk in keep) nodes[nk] = data0.nodes[nk];
        data0.edges.forEach(function (e: any) { if (keep[e[0]] && keep[e[1]]) edges.push([e[1], e[0], e[2], e[3]]); });
        pushView({ start: data0.start, depth: 99, roots: [k], nodes: nodes, edges: edges, dir: "up", focus: k, partial: 1 });
      }
      function showCallees(k: any) {
        var lv = live();
        if (lv) {
          Promise.resolve(lv({ dir: "down", node: k })).then(function (nd: any) { if (nd) pushView(nd); });
          return;
        }
        pushView({ start: data0.start, depth: data0.depth, roots: [k], nodes: data0.nodes, edges: data0.edges });
      }
      // A method node's `src` is a route (like a table's `src` / a chart's
      // `data`): "<path>#L<start>-<end>". Resolve it relative to navBase
      // (overridable via the mount's data-src-base), fetch the file, slice the
      // line range, and show it in the side panel — the graph stays live, so
      // clicking another node updates the panel. Unreachable (offline, a
      // static embed, or a server scoped away from the sources) DEGRADES to
      // the path, never throws.
      function showSource(k: any) {
        var n = data.nodes[k] || {};
        var ref = n.src ? String(n.src) : "";
        srcPanel.replaceChildren();
        srcPanel.style.display = "";
        var hd = document.createElement("div");
        hd.className = "cg-src-hd";
        var ttl = document.createElement("span");
        ttl.textContent = ref || (n.n || k);
        hd.appendChild(ttl);
        var cls = document.createElement("button");
        cls.textContent = "✕";
        cls.onclick = function () { srcPanel.style.display = "none"; srcPanel.replaceChildren(); };
        hd.appendChild(cls);
        srcPanel.appendChild(hd);
        var body = document.createElement("pre");
        body.className = "cg-src-body";
        srcPanel.appendChild(body);
        if (!ref) { body.textContent = "no source location recorded for this node"; return; }
        var hp = ref.indexOf("#");
        var path = hp < 0 ? ref : ref.slice(0, hp);
        var rng = /L(\d+)(?:-L?(\d+))?/.exec(hp < 0 ? "" : ref.slice(hp + 1));
        var a0 = rng ? parseInt(rng[1]!, 10) : 0;
        var b0 = rng && rng[2] ? parseInt(rng[2], 10) : a0;
        body.textContent = "loading " + path + " …";
        var base = mount.getAttribute("data-src-base");
        if (base === null || base === undefined) base = navBase;
        var degrade = function () {
          body.textContent = "";
          var note = document.createElement("div");
          note.className = "cg-src-note";
          note.textContent = ref + "\nsource not reachable here";
          body.appendChild(note);
        };
        var render = function (text: any) {
          var lines = String(text).split(/\r?\n/);
          var out = (a0 >= 1 && a0 <= lines.length) ? lines.slice(a0 - 1, b0 >= a0 ? b0 : a0) : lines;
          body.textContent = out.join("\n");
        };
        var fetchFn: any = (typeof fetch === "function") ? fetch : null;
        if (!fetchFn) { degrade(); return; }
        // `path` is the node's document-controlled `src=` route and `base` may
        // be empty (@self / bare-filename mounts), so an absolute or //-relative
        // src would fetch a third-party host (beacon / SSRF). Confine to the
        // page's origin and never send credentials.
        if (!cgSameOrigin(base + path)) { degrade(); return; }
        try {
          Promise.resolve(fetchFn(base + path, { credentials: "omit" })).then(function (r: any) {
            if (!r || r.ok === false) { degrade(); return null; }
            return Promise.resolve(r.text ? r.text() : r).then(render);
          }).catch(degrade);
        } catch (e) { degrade(); }
      }
      svg.addEventListener("click", function (ev) {
        var tgt: any = ev.target;
        var ub = tgt && tgt.closest ? tgt.closest(".cg-upbtn") : null;
        if (ub) {
          if (ub.getAttribute("data-act") === "down") {
            // "Back to its callee chain" must LAND on the callee chain: pop
            // the trail only when the view underneath IS this method's own
            // focused view (the search/chain path that opened these callers).
            // Arriving from anywhere wider — the module page — popping would
            // land there instead, so build the method's chain fresh.
            var k0 = ub.getAttribute("data-k");
            var top0 = state.trail[state.trail.length - 1];
            var ownChain = top0 && top0.data && top0.data.dir !== "up" && top0.roots && top0.roots.length === 1 && top0.roots[0] === k0;
            if (ownChain) { var tr0 = state.trail.pop(); setData(tr0.data); state.roots = tr0.roots; draw(); }
            else showCallees(k0);
          } else showCallers(ub.getAttribute("data-k"));
          return;
        }
        var g = tgt && tgt.closest ? tgt.closest(".cg-n") : null;
        if (!g) return;
        var k = g.getAttribute("data-k");
        if (data.mode === "modules") {
          var nd = data.nodes[k];
          if (nd && nd.grp) { pushView(deriveView(nd.grp)); return; }
          if (nd && nd.ext) return; // external stub: informational
          if (nd && nd.doc) openDoc(navBase + String(nd.doc));
          return;
        }
        // Method mode: the node body now VIEWS the method's source. All chain
        // navigation (callers / flip back) lives on the standalone ⊕ node.
        showSource(k);
      });
      // Hover highlight: BFS the caller cone over upAdj, mark nodes/edges
      // with .hl and flag the svg so everything else dims. Class strings are
      // rebuilt from the recorded bases — no classList dependency.
      function clearHl() {
        svg.setAttribute("class", "cg-svg");
        for (var nk in nodeEls) nodeEls[nk].setAttribute("class", nodeBase[nk]);
        for (var ekk in edgeEls) edgeEls[ekk].setAttribute("class", edgeBase[ekk]);
      }
      svg.addEventListener("mouseover", function (ev) {
        var tgt: any = ev.target;
        var g = tgt && tgt.closest ? tgt.closest(".cg-n") : null;
        if (!g) return;
        var k = g.getAttribute("data-k");
        var seen: any = {}; seen[k] = 1;
        var hlE: any = {};
        var q: any = [k], qi = 0;
        while (qi < q.length) {
          var cur = q[qi++];
          (upAdj[cur] || []).forEach(function (p: any) {
            hlE[p.k] = 1;
            if (!seen[p.n]) { seen[p.n] = 1; q.push(p.n); }
          });
        }
        svg.setAttribute("class", "cg-svg hl");
        for (var nk in nodeEls) nodeEls[nk].setAttribute("class", nodeBase[nk] + (seen[nk] ? " hl" : ""));
        for (var ekk in edgeEls) edgeEls[ekk].setAttribute("class", edgeBase[ekk] + (hlE[ekk] ? " hl" : ""));
      });
      svg.addEventListener("mouseout", function (ev) {
        var tgt: any = ev.target;
        if (tgt && tgt.closest && !tgt.closest(".cg-n")) return;
        clearHl();
      });
    }
    draw();
  }
  Array.prototype.forEach.call(root.querySelectorAll(".cg-mount"), function (mount: Element) {
    var payload = mount.getAttribute("data-graph");
    if (payload) { boot(mount, JSON.parse(payload)); return; }
    var side = mount.getAttribute("data-graph-src");
    if (!side) return; // not (yet) upgraded, or its build failed
    // Sidecar payload (served pages): the page shipped without the multi-MB
    // inline attribute — fetch it after first paint, then boot normally.
    fetch(side).then(function (r: any) { return r.json(); }).then(function (j: any) {
      if (!j || j.error !== undefined) {
        mount.textContent = "geml-code-graph: " + ((j && j.error) || "cannot load graph data");
        return;
      }
      if (j.truncated && (mount as any).parentNode) {
        var note = document.createElement("p");
        note.className = "cg-note";
        note.textContent = "slice truncated — narrow the entry set or lower graph-depth";
        (mount as any).parentNode.insertBefore(note, (mount as any).nextSibling);
      }
      boot(mount, j.data);
    }).catch(function () { mount.textContent = "geml-code-graph: cannot load graph data"; });
  });
}

// CLI inlining: the compiled runtime function, verbatim, run against document.
export const CODE_GRAPH_JS = `(${codeGraphRuntime.toString()})(document);`;

// Browser-side wave builder: the slice builder is synchronous with a
// synchronous loader, but a browser fetches documents asynchronously — so
// run the build in WAVES: every pass records the documents it needed but did
// not have, those are fetched, and the build re-runs (builds are
// milliseconds; the wave count is bounded by graph-depth). ONE
// implementation, two consumers: the viewer's upgrade step and the live
// module script injected into served pages.
export function codeGraphWaves(
  fetchDoc: (rel: string) => Promise<string | null>,
  parseFn: (s: string) => Document,
): {
  build: (src: string, view?: { dir?: "up" | "down"; node?: string }) => Promise<{ data?: CGData; error?: string; truncated?: boolean }>;
  seed: (name: string, text: string | null) => void;
} {
  const cache = new Map<string, string | null>();
  const failed = new Set<string>();
  return {
    seed: (name, text) => { cache.set(name, text); },
    build: async (src, view) => {
      let result;
      for (;;) {
        const pending: string[] = [];
        result = buildCodeGraph(src, {
          loadDoc: (p) => {
            if (cache.has(p)) return cache.get(p)!;
            if (!failed.has(p)) pending.push(p);
            return null;
          },
          parseDoc: parseFn,
        }, view);
        if (!pending.length) break;
        await Promise.all(pending.map(async (p) => {
          try {
            const text = await fetchDoc(p);
            cache.set(p, text);
            if (text === null) failed.add(p);
          } catch {
            cache.set(p, null);
            failed.add(p);
          }
        }));
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export { buildCodeGraph };
