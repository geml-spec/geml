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
import { graphStyleFromLayers, resolveStyleLayers, type GraphStyle } from "./graph-style.js";
import { CODE_GRAPH_CHROME } from "./code-graph.js";
import { translateBlocks, resolveTarget, type Translator } from "./translate.js";

const PALETTE = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#ea580c"];

/**
 * A host-supplied renderer for one `diagram` format (§7).
 *
 * §7 already says a `format=` names a RENDERER and that an unknown one degrades
 * to a labelled source block — so the extension point is the specification's,
 * not an invention here. What was missing is that this renderer had the table
 * hard-coded: `geml-chart` and `mermaid` are the specification's own, and
 * `geml-code-graph` — which belongs to `geml-codemap/v1`, through GEP-0003 —
 * sat in the same `if` chain, so the core renderer knew one vocabulary by name.
 *
 * `used` is how a renderer says the page needs something: the page shell reads
 * the set to decide which assets to inline. Returning HTML is the whole of the
 * contract otherwise; a renderer that throws, or that is absent, leaves the
 * block to §7's labelled-source fallback.
 */
export interface DiagramCtx {
  /** The block's raw body, already the verbatim text §3 preserved. */
  raw: string;
  /** `id="…"` or the empty string, ready to interpolate. */
  idAttr: string;
  /** The rendered `<figcaption>` for this block, or the empty string. */
  cap: string;
  caption?: string;
  classes: readonly string[];
  /** `class="…"` for a figure, with the renderer's own chrome word added. */
  clsAttr(classes: readonly string[], own?: string): string;
  opts: RenderOptions;
  /** Declare that this page needs a named asset (the shell reads the set). */
  use(asset: string): void;
}
/** The block is always a TYPED block here — `diagram` is one. */
export type DiagramBlock = Extract<Block, { kind: "block" }>;
export type DiagramRenderer = (block: DiagramBlock, ctx: DiagramCtx) => string;

export interface RenderOptions {
  title?: string;
  source?: string; // source file name, shown in the footer
  /**
   * Renderers for `diagram` formats this build should draw rather than show as
   * source. Keyed by the `format=` value. The specification's own two
   * (`geml-chart`, `mermaid`) are built in; everything else — including
   * `geml-code-graph`, which is `geml-codemap/v1`'s — arrives through here, so
   * no vocabulary is named in the dispatch.
   */
  diagrams?: Record<string, DiagramRenderer>;
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

// The class names this renderer uses for its OWN chrome — the red diagnostic
// box, the transclusion frames, the diagram-source fallback — and the block-type
// words it puts first. An author's `{.render-error}` on a note used to be applied
// verbatim (the charset filter above only strips characters), so a plain note
// could wear the build-error styling and read as a system message. Content
// classes stay content classes; a token that names the chrome is dropped.
// The vocabulary chrome is composed in rather than spelled out: `code-graph`
// and `cg-*` belong to code-graph.ts, and listing them here was one more place
// the core renderer named a vocabulary.
const RENDERER_CLASS = new RegExp(
  "^(render-error|diagram-src|callout|text|geml-.*|transclusion(-.*)?|math|math-block|mermaid"
  + "|chart|computed|media|fn|task|task-list|table-.*|data-(src|more)|c-(axis|grid|legend|tick|title)"
  + CODE_GRAPH_CHROME.map((c) => "|" + c).join("")
  + ")$");
const authorClasses = (cs: readonly string[]): string[] => cs.filter((c) => !RENDERER_CLASS.test(c));

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
  /**
   * A block reached the unknown-type fallback below. The page-level notice about
   * a missing vocabulary is gated on this: without an unreadable block there is
   * nothing on the page for it to explain, and naming a vocabulary the reader
   * cannot see the effect of is disclosure with no purpose (§8.6.2 rule 3).
   */
  usedUnknownType = false;
  /**
   * Assets a host-registered diagram renderer asked for (`ctx.use`). The page
   * shell reads it; an empty set costs nothing. Kept beside `usedMath` and
   * `usedMermaid` rather than replacing them — those two are the
   * specification's own renderers and their assets are this build's business.
   */
  usedAssets = new Set<string>();
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

  // The HOST document's `meta`, for the keys that are declared once and inherited
  // by what the document borrows — GEP-0010's `translate-to` today. It is the
  // projecting document's meta and stays that as expansion descends: a borrowed
  // document's own meta says what IT defaults to for ITS readers, and letting it
  // reach in here would make a projection's language depend on the language of
  // the thing it is projecting. (The viewer's `state.docMeta` is the same rule.)
  private readonly docMeta: Record<string, Value>;

  constructor(private doc: Document, readonly opts: RenderOptions = {}) {
    this.indexLabels(doc.children);
    const meta = doc.children.find((b) => b.kind === "block" && b.type === "meta" && b.data);
    this.docMeta = (meta?.kind === "block" ? meta.data : undefined) ?? {};
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
    if (written === "") return this.transclusionFallback("", idAttr, "invalid", "embed: missing `src=`", b.classes);

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
      return this.transclusionFallback(written, idAttr, "too-deep", `transclusion depth cap (${EMBED_DEPTH_CAP}) reached`, b.classes);
    }
    const spent = this.budgetExhausted();
    if (spent !== null) return this.transclusionFallback(written, idAttr, "too-large", spent, b.classes);

    let children: Block[];
    if (docPath !== "" && !/\.geml$/i.test(docPath)) {
      // Same constraint the parser reports: an embed stands for a GEML document.
      // Parsing whatever else the target happens to contain injected its bytes
      // into the page as prose.
      return this.transclusionFallback(written, idAttr, "invalid", `\`${docPath}\` is not a GEML document`, b.classes);
    }
    if (docPath === "") {
      children = this.currentDocChildren;
    } else {
      if (!loadDoc || !parseDoc) return this.transclusionFallback(written, idAttr, "unexpanded", "no document resolver", b.classes);
      // Parsed on its own, so S4 holds for free: `{{key}}` inside borrowed content
      // interpolates against the SOURCE document's meta, never the host's. Read
      // through the cache: the same target is otherwise re-read and re-parsed once
      // per expansion.
      const loaded = this.loadChildren(rel);
      if (loaded === null) return this.transclusionFallback(written, idAttr, "unresolved", `cannot resolve document \`${docPath}\`, or it is too large`, b.classes);
      children = loaded;
    }

    const asked = typeof b.attrs["part"] === "string" ? (b.attrs["part"] as string).trim() : "whole";
    const part: EmbedPart = asked === "head" || asked === "body" || asked === "intro" ? asked : "whole";
    const picked = selectEmbed(children, anchor, part);
    if (picked === null) {
      const what = docPath === "" ? `no \`${written}\` in this document` : `no \`#${anchor}\` in \`${docPath}\``;
      return this.transclusionFallback(written, idAttr, "unresolved", what, b.classes);
    }

    // GEP 0010: the language axis, applied to the blocks this embed borrowed.
    // The target is resolved by `resolveTarget` and by nothing else — its whole
    // purpose is that the three processors cannot disagree about which of three
    // things a document meant, and this path used to answer the question itself,
    // in the vocabulary GEP-0010 REFUSED: it read `lang=` (which on `code` names
    // a programming language) and `translator="none"` (a key reserved until
    // there is a second engine, so a document must not write it), and it never
    // consulted the document's default at all. A document that wrote the
    // specified `translate-to=` was silently not translated here, and one that
    // wrote `translate-to=none` was not held back.
    //
    // No host translator at all means the source language — a rendering, not a
    // failure.
    const want = resolveTarget(this.docMeta, b.attrs);
    const t = this.opts.translator;
    const shown = want !== null && t !== undefined ? translateBlocks(picked, want, t) : picked;

    this.embedStack.push(key);
    this.embedDocs.push({ rel, children });
    try {
      return this.transclusionWrap(written, idAttr, shown, b.classes);
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
  // Author classes ride on a block's OUTERMOST element, beside its id — for
  // every typed block, not just the two that happened to carry them. `{.pane}`
  // on a `code` block is the hook a stylesheet wants; dropping it left `#id`
  // as the only handle, which is one CSS rule per block and no reuse at all.
  // Chrome names stay reserved (RENDERER_CLASS), so an author class still
  // cannot dress a block up as the renderer's own furniture. Emitted AFTER the
  // chrome tokens and only when non-empty, so a document that declares no
  // classes renders byte-for-byte as before.
  private clsAttr(classes: readonly string[], ...chrome: string[]): string {
    const tokens = [...chrome, ...authorClasses(classes)];
    return tokens.length === 0 ? "" : ` class="${classAttr(tokens)}"`;
  }

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

  private transclusionWrap(written: string, idAttr: string, picked: Block[], classes: readonly string[] = []): string {
    this.embedCount++;
    const inner = picked.map((x) => this.block(x)).filter((s) => s !== "").join("\n");
    this.embedBytes += inner.length;
    return `<section${this.clsAttr(classes, "transclusion")}${idAttr} data-src="${escAttr(written)}">${inner}</section>`;
  }

  private transclusionFallback(written: string, idAttr: string, why: string, note: string, classes: readonly string[] = []): string {
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
    return `<div${this.clsAttr(classes, "transclusion", `transclusion-${classAttrToken(why)}`)}${idAttr} data-src="${escAttr(written)}" title="${escAttr(note)}">`
      + `${link}<span class="transclusion-note">${esc(note)}</span></div>`;
  }

  private media(n: Extract<Inline, { type: "image" }>): string {
    const src = escAttr(relJoin(relDir(this.currentDocRel), n.src));
    // `{width=… height=…}` (§5.1): only a non-negative integer becomes an
    // attribute. The value is interpolated into markup here, so the gate is the
    // one that matters — a bare number cannot carry a quote out of the attribute,
    // and `50%` / `120px` / `100" onload="…` are dropped rather than escaped and
    // kept. `.media { max-width:100% }` still clamps an oversized width.
    const dim = (["width", "height"] as const)
      .map((k) => {
        const v = (n.attrs ?? {})[k];
        return typeof v === "number" && Number.isInteger(v) && v >= 0 ? ` ${k}="${v}"` : "";
      })
      .join("");
    if (n.as === "video") return `<video class="media" src="${src}"${dim} controls></video>`;
    if (n.as === "audio") return `<audio class="media" src="${src}" controls></audio>`;
    return `<img class="media" src="${src}" alt="${escAttr(n.alt)}"${dim}>`;
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
        return `<pre${idAttr}${this.clsAttr(b.classes)}><code${cls}>${esc(raw)}</code></pre>`;
      }
      case "embed": return this.transclude(b, idAttr);
      case "math":
        this.usedMath = true;
        return `<div${this.clsAttr(b.classes, "math-block")}${idAttr}>\\[${esc(raw)}\\]</div>`;
      case "note": {
        const inner = (b.children ?? []).map((c) => this.block(c)).filter((s) => s).join("\n");
        return `<aside${this.clsAttr(b.classes, "callout", b.type)}${idAttr}>\n${inner}\n</aside>`;
      }
      case "text":
        return this.proseBlock(b, idAttr);
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
            return `<figure${idAttr}${this.clsAttr(b.classes)}><p class="table-note">external data <code>${esc(src)}</code> — loaded at render time</p>${cap0}</figure>`;
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
        if (rest.length === 0) return `<figure${idAttr}${this.clsAttr(b.classes)}>${pre(shown)}${cap}</figure>`;
        // jsonl reads as an append-log, so its open end is the NEWEST lines and
        // the fold holds the earlier ones, above; json reads from the top.
        const more = `<details class="data-more"><summary>${rest.length} ${tail ? "earlier" : "more"} line${rest.length === 1 ? "" : "s"} of ${lines.length}</summary>${pre(rest)}</details>`;
        return `<figure${idAttr}${this.clsAttr(b.classes)}>${tail ? more + pre(shown) : pre(shown) + more}${cap}</figure>`;
      }
      case "table":
        return b.table ? this.table(b.table, b.id, caption, b.classes) : `<p class="render-error">table failed to parse</p>`;
      case "view":
        return b.table ? this.table(b.table, b.id, caption, b.classes) : `<p class="render-error">view failed to resolve</p>`;
      case "diagram":
        return this.diagram(b, raw, caption);
      default: {
        // A profile type declared `prose:` is prose in the same sense `text` is
        // (ProfileDef.prose) — same neutral container, not the fallback below.
        if (b.prose === true) return this.proseBlock(b, idAttr);
        // Unknown type: preserved as raw (spec §3). Show it, labelled.
        this.usedUnknownType = true;
        return `<figure${idAttr}${this.clsAttr(b.classes)}><pre class="diagram-src" data-type="${escAttr(b.type)}">${esc(raw)}</pre>` +
          `<figcaption>unknown block type <code>${esc(b.type)}</code>; shown as raw</figcaption></figure>`;
      }
    }
  }

  /**
   * Addressable prose (§3): flow children in a NEUTRAL container — the block
   * exists for its id/attrs, not for callout chrome (that is `note`). Shared by
   * core `text` and by any profile type declared `prose:`, so the two render
   * the same way rather than one of them landing in the unknown-type fallback.
   */
  private proseBlock(b: Extract<Block, { kind: "block" }>, idAttr: string): string {
    const inner = (b.children ?? []).map((c) => this.block(c)).filter((x) => x).join("\n");
    // (the type name is a chrome token, so an author's own `.text` is dropped.)
    return `<div${this.clsAttr(b.classes, b.type)}${idAttr}>\n${inner}\n</div>`;
  }

  private diagram(b: Extract<Block, { kind: "block" }>, raw: string, caption?: string): string {
    const idAttr = this.idAttr(b.id);
    const fmt = typeof b.attrs["format"] === "string" ? (b.attrs["format"] as string) : "";
    const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : "";

    if (fmt === "geml-chart") {
      if (b.chart) return `<figure class="chart"${idAttr}>${chartSvg(b.chart, caption)}${cap}</figure>`;
      return `<figure${idAttr}${this.clsAttr(b.classes)}><p class="render-error">chart could not be built (see diagnostics)</p>${cap}</figure>`;
    }
    if (fmt === "mermaid") {
      this.usedMermaid = true;
      return `<figure${idAttr}${this.clsAttr(b.classes)}><pre class="mermaid">${esc(raw)}</pre>${cap}</figure>`;
    }
    // A host-registered renderer for this format, if there is one. Looked up
    // BEFORE the fallback and AFTER the specification's own two, so a host can
    // add formats but cannot quietly redefine `geml-chart`.
    const custom = this.opts.diagrams?.[fmt];
    if (custom !== undefined) {
      return custom(b, {
        raw, idAttr, cap, caption, classes: b.classes,
        clsAttr: (cs, own) => (own === undefined ? this.clsAttr(cs) : this.clsAttr(cs, own)),
        opts: this.opts,
        use: (asset) => { this.usedAssets.add(asset); },
      });
    }
    // graphviz / d2 / plantuml / vega-lite / unknown: no bundled engine yet.
    return `<figure${idAttr}${this.clsAttr(b.classes)}><pre class="diagram-src" data-format="${escAttr(fmt)}">${esc(raw)}</pre>` +
      `<figcaption>${caption ? esc(caption) + " — " : ""}<code>${esc(fmt || "diagram")}</code> (no bundled renderer in this build)</figcaption></figure>`;
  }

  // geml-code-graph embed (GEP-0003): build the call-graph slice from the
  // codemap document `src` points at (roots/depth from ITS meta), embed the
  // data, and let the in-page runtime lay it out at draw time — that is what
  // makes click-to-re-root possible.

  private table(t: TableModel, id?: string, caption?: string, classes: readonly string[] = []): string {
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
    // `{.no-fold}` says this table is the page's CONTENT, however long: show it
    // all, never inside a collapsed <details>. It replaces a heuristic that
    // asked whether the DOCUMENT was a codemap and whether the table was called
    // `modules` — one vocabulary's table known by name inside the core
    // renderer's layout. A document says what it wants; the renderer does not
    // guess from whose document it is.
    const foldAbove = classes.includes("no-fold") ? Infinity : (this.opts.tableRows ?? 500);
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
      return `<figure${this.clsAttr(classes, "table-figure")}${idAttr}><details><summary>${summary}</summary>${tools}` +
        `<div class="table-scroll"><table class="geml-table">${thead}<tbody>\n${bodyRows}\n</tbody>${tfoot}</table></div></details>${cap}</figure>`;
    }
    return `<figure${this.clsAttr(classes, "table-figure")}${idAttr}>${tools}` +
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
.geml-missing-vocab { border:1px solid #d4a72c66; background:#fff8c5; color:#4d2d00; padding:.6rem .8rem; border-radius:6px; margin:0 0 1rem; font-size:.9em; }
.math-block { overflow-x:auto; padding:.4em 0; }
sup.fn a { font-size:.75em; }
.geml-footer { max-width:860px; margin:0 auto; padding:16px 24px 40px; color:var(--muted); font-size:.82em; }
.geml-footer code { font-size:.95em; }
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




// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

// `geml-code-graph` lives in code-graph.ts now (1683 lines, one vocabulary).
// Re-exported here for COMPATIBILITY, not because it belongs to the renderer:
// the viewer, the playground, `codemap/serve.mjs` and a runtime URL import
// inside generated HTML all take these from `render.js`. When those migrate,
// this line goes and the dependency with it.
export { buildCodeGraph, codeGraphRuntime, codeGraphWaves, CODE_GRAPH_JS, CODE_GRAPH_CSS, CG_MAX_NODES, type CGData, type CGNode } from "./code-graph.js";
