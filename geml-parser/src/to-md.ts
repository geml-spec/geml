// GEML -> Markdown projection (the inverse direction of from-md.ts).
//
// This is a *lossy* export: Markdown has no typed-block primitive, so each GEML
// construct is projected to the nearest GFM shape — headings, fenced code,
// blockquotes (note), GFM tables (from the computed table model), `$$`
// math, mermaid fences, YAML frontmatter (meta), footnote definitions. Things
// GFM cannot express (geml-chart, `{hidden}` blocks, block ids/classes) are
// dropped or degraded, and each such loss is reported in `notes` so a caller
// (and an agent) knows the conversion was not faithful.

import type { Block, Document, ListItem } from "./geml.js";
import type { Inline } from "./inline.js";
import type { TableModel, TableCell, Align } from "./table.js";
import type { Value } from "./attrs.js";
import { docTitle, headingShift } from "./doc-title.js";

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

// Escape the characters that could start a Markdown inline construct, so a
// literal text run renders verbatim. Kept deliberately light — Markdown is
// forgiving, and over-escaping produces noisy output. `<` and `&` are among
// them: GEML has no raw HTML (§1(5)), so `<img onerror=…>` in its prose is text,
// and Markdown would hand it to the renderer as a live tag; an entity would
// decode where GEML shows it as written.
function escText(s: string): string {
  return s.replace(/[\\`*_\[\]<&]/g, (c) => "\\" + c);
}

// A code span's fence is one backtick longer than the longest run inside it,
// padded when the value starts or ends with a backtick or is wrapped in spaces
// (CommonMark §6.1). With a single backtick a value closed its own span, and
// what followed it — a tag included — was live Markdown.
function codeSpan(v: string): string {
  const longest = Math.max(0, ...(v.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = /^`|`$/.test(v) || (/^ .*\S.* $/s.test(v)) ? " " : "";
  return fence + pad + v + pad + fence;
}

// TeX between `$` is not HTML, but a renderer without math support reads it as
// Markdown, and `<` there opens a tag. `\lt` is the same glyph to KaTeX and MathJax.
const mathText = (v: string): string => v.replace(/</g, "\\lt ");

// A destination is written as GEML kept it, but Markdown ends one at a space and
// reads `<` as its bracketed form, so those are percent-encoded.
const mdDest = (d: string): string => d.replace(/[ <>]/g, (c) => encodeURIComponent(c));

function linkDest(n: Extract<Inline, { type: "link" }>): string {
  if (n.href !== undefined) return mdDest(n.href);
  if (n.doc !== undefined) return mdDest(n.anchor !== undefined ? `${n.doc}#${n.anchor}` : n.doc);
  if (n.anchor !== undefined) return mdDest(`#${n.anchor}`);
  return "";
}

function inline(n: Inline, ctx: MdCtx): string {
  switch (n.type) {
    case "text": return escText(n.value);
    case "emph": return `*${seq(n.children, ctx)}*`;
    case "strong": return `**${seq(n.children, ctx)}**`;
    case "strike": return `~~${seq(n.children, ctx)}~~`;
    case "code": return codeSpan(n.value);
    case "math": return `$${mathText(n.value)}$`;
    case "break": return "  \n";
    case "image": return `![${escText(n.alt)}](${mdDest(n.src)})`;
    case "link": return `[${seq(n.children, ctx)}](${linkDest(n)})`;
    // Markdown has no auto-reference; project to a plain link to the anchor.
    case "autoref": {
      // GEP 0011: a coordinate says its value and links to the block holding it.
      if (n.value !== undefined && n.base === undefined) return escText(n.value); // no block to link to
      const anchor = n.base ?? n.anchor;
      const target = n.doc !== undefined ? `${n.doc}#${anchor}` : `#${anchor}`;
      return `[${escText(n.value ?? target)}](${mdDest(target)})`;
    }
    // An inline projection is the inline sibling of `=== embed`, and gets the
    // same treatment: resolve it and let the CONTENT stand here, as `--to html`
    // does. Flattened to one line — it is standing inside a sentence.
    case "project": {
      // A resolved coordinate is its value, nothing to expand and nothing to link.
      if (n.value !== undefined) return escText(n.value);
      const src = n.doc !== undefined ? `${n.doc}#${n.anchor}` : `#${n.anchor}`;
      const got = ctx.resolveEmbed?.(src);
      if (got !== undefined && got.trim() !== "") {
        ctx.notes.add("inline projection expanded in place; the projection itself has no Markdown equivalent and is gone");
        return got.trim().replace(/\s*\n+\s*/g, " ");
      }
      ctx.notes.add("inline projection could not be resolved; emitted a link to the target instead");
      return `[${escText(src)}](${mdDest(src)})`;
    }
    case "footnote": return `[^${n.ref}]`;
  }
}

function seq(ns: Inline[], ctx: MdCtx): string {
  return ns.map((n) => inline(n, ctx)).join("");
}

// Escape a `|` so GFM keeps it inside the cell instead of splitting the row.
// GitHub's tables (cmark-gfm, and markdown-it with it) read ANY `|` right after
// a `\` as cell content and drop that one backslash before the inline parse —
// inside a code span too, where nothing else is unescaped. So the inverse is one
// backslash in front of every pipe, whatever stands before it. Doubling a
// backslash run first, as a reader that counts the run's parity would need (marked
// does), left an extra backslash in every code span holding `\|`. GEML's visual
// form reads a row the same way (§6(a)), so `--to md` and `--from md` invert.
function escPipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}

// Inline text for a table cell: render inlines, then neutralise the two bytes
// that would break a GFM cell.
function cellText(c: TableCell, ctx: MdCtx): string {
  return escPipe(seq(c.inlines, ctx)).replace(/\n/g, " ");
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function sep(a: Align | undefined): string {
  if (a === "center") return ":--:";
  if (a === "right") return "---:";
  if (a === "left") return ":---";
  return "---";
}

function tableToMd(t: TableModel, ctx: MdCtx): string {
  // A `src=` table IS inlined when the parser could read it — the rows are in
  // the model. The note used to fire on `src` alone and claim "emitted header
  // only" over a table that had every row, which is worse than saying nothing:
  // a reader told the data is missing goes and adds it back.
  if (t.src !== undefined && (t.rows ?? []).length === 0) {
    ctx.notes.add(`table from external source \`${t.src}\` could not be read; emitted header only`);
  }
  const cols = t.columns;
  const lines: string[] = [];
  if (t.caption) lines.push(`*${escText(t.caption)}*`, "");
  lines.push(`| ${cols.map((c) => escPipe(escText(c))).join(" | ")} |`);
  lines.push(`| ${cols.map((_, i) => sep(t.align[i])).join(" | ")} |`);
  const pad = (cells: string[]) => {
    while (cells.length < cols.length) cells.push("");
    return cells.slice(0, cols.length);
  };
  for (const row of t.rows) lines.push(`| ${pad(row.map((c) => cellText(c, ctx))).join(" | ")} |`);
  if (t.summary) lines.push(`| ${pad(t.summary.map((c) => cellText(c, ctx))).join(" | ")} |`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function listToMd(b: Extract<Block, { kind: "list" }>, indent: string, ctx: MdCtx): string {
  const out: string[] = [];
  const start = b.start ?? 1;
  b.items.forEach((item: ListItem, k: number) => {
    const marker = b.ordered ? `${start + k}. ` : "- ";
    const task = item.checked === undefined ? "" : item.checked ? "[x] " : "[ ] ";
    // A soft-wrapped item (§2.2) keeps its wrap: continuation lines indented to
    // the content column, which both GFM and a GEML re-parse read as the same
    // single item.
    const [head, ...cont] = seq(item.inlines, ctx).split("\n");
    out.push(indent + marker + task + head);
    const contIndent = indent + " ".repeat(marker.length + task.length);
    for (const l of cont) out.push(contIndent + l);
    for (const child of item.children ?? []) {
      out.push(child.kind === "list" ? listToMd(child, indent + "  ", ctx) : block(child, ctx));
    }
    if (b.loose && k < b.items.length - 1) out.push("");
  });
  return out.join("\n");
}

function fence(lang: string, body: string[]): string {
  // Use a longer fence than any backtick run in the body so it can't close early.
  let max = 2;
  for (const ln of body) { const m = /^(`+)/.exec(ln.trim()); if (m) max = Math.max(max, m[1]!.length); }
  const f = "`".repeat(Math.max(3, max + 1));
  // An info string may not hold a backtick, or the line is no fence at all.
  return [f + lang.replace(/[`\r\n]/g, ""), ...body, f].join("\n");
}

function attr(b: Extract<Block, { kind: "block" }>, key: string): string | undefined {
  const v = b.attrs[key];
  return typeof v === "string" ? v : v === undefined ? undefined : String(v);
}

// A typed block (raw / flow). meta is hoisted to frontmatter elsewhere.
function typedToMd(b: Extract<Block, { kind: "block" }>, ctx: MdCtx): string {
  if (b.hidden) { ctx.notes.add("`{hidden}` block(s) dropped (not part of the rendered output)"); return ""; }

  // A prose body (GEP-0013) projects like a flow one: its children are
  // paragraphs, and a prose block is prose, so it lands as plain paragraphs
  // rather than in the raw-fence path below.
  if (b.mode === "flow" || b.mode === "prose") {
    // A note the author marked `.footnote` projects to a Markdown footnote
    // definition. The parser no longer synthesizes this class — the `[^id]: text`
    // definition line was withdrawn from §5.2 — but an author still writes it,
    // and it is the only way this projection can be produced.
    if (b.type === "note" && b.classes.includes("footnote") && b.id) {
      const text = (b.children ?? []).map((c) => block(c, ctx)).join(" ").replace(/\n+/g, " ").trim();
      return `[^${b.id}]: ${text}`;
    }
    const inner = (b.children ?? []).map((c) => block(c, ctx)).filter(Boolean).join("\n\n");
    // `text` is an addressable prose container, not a callout: its children
    // project as plain paragraphs. Only `note` carries blockquote semantics.
    if (b.prose === true) return inner;
    return inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
  }

  // raw modes
  const raw = b.raw ?? [];
  if (b.type === "code") return fence(attr(b, "lang") ?? "", raw);
  // GEP-0005: a data block projects as a fenced code block in its format —
  // the nearest GFM shape (Markdown has no verified-data construct; that loss
  // is the usual --to md lossiness, not a defect of the projection).
  if (b.type === "data") {
    // A `src=` data block has no body — the parser put the loaded value in the
    // model instead. Emitting `raw` here produced an EMPTY fence and said
    // nothing about it, while `--to html` showed the value: content lost in
    // silence, which is the one outcome this projection may never have. Written
    // the way `--to geml` canonicalises it: json at two-space indent, jsonl one
    // compact value per line.
    const fmt = attr(b, "format") ?? "json";
    if (raw.length === 0 && b.value !== undefined) {
      const v = b.value;
      const body = fmt === "jsonl" && Array.isArray(v)
        ? v.map((x) => JSON.stringify(x))
        : JSON.stringify(v, null, 2).split("\n");
      ctx.notes.add(`data from external source \`${attr(b, "src") ?? "?"}\` inlined as its loaded value`);
      return fence(fmt, body);
    }
    return fence(fmt, raw);
  }
  if (b.type === "math") return ["$$", ...raw.map(mathText), "$$"].join("\n");
  // A `view` (GEP-0012) publishes a relation and nothing else, so it exports as
  // the grid it renders. Without this it fell through to the unknown-type path
  // and became an EMPTY ```view fence: `--to html` showed the rows and
  // `--to md` showed nothing, which is the exact shape of the three losses the
  // export-parity test was written for.
  if ((b.type === "table" || b.type === "view") && b.table) return tableToMd(b.table, ctx);
  // §3.3: a remote source, or a view over one, has no rows at build time.
  if (b.type === "table" || b.type === "view") return `*External data ${codeSpan(attr(b, "src") ?? "")} — loaded at render time.*`;
  if (b.type === "diagram") {
    const fmt = attr(b, "format") ?? "";
    if (fmt === "geml-chart") {
      // No Markdown chart primitive: degrade to a labelled descriptor.
      ctx.notes.add("`geml-chart` block(s) cannot render in Markdown; emitted a descriptor");
      const desc = ["type", "data", "x", "y", "series"].map((k) => { const v = attr(b, k); return v ? `${k}=${v}` : ""; }).filter(Boolean).join(" ");
      return fence("geml-chart", [desc]);
    }
    return fence(fmt, raw); // mermaid renders on GitHub; others stay as a code block
  }
  if (b.type === "embed") {
    // Markdown has no transclusion, so the projection is resolved and its
    // CONTENT stands here — the same thing `--to html` does. A reader of the
    // export came for the text; a link to `#src` sends them looking for it.
    //
    // What is lost is the machinery, not the content, and it is lost on
    // purpose. An export invites edits, and anything that let a return trip put
    // the `embed` back — a marker in an HTML comment, say — would re-evaluate
    // the projection over the top of those edits and lose them without a word.
    // A snapshot does not carry the machine that produced it.
    const target = typeof b.attrs["src"] === "string" ? (b.attrs["src"] as string).trim() : "";
    const inlined = target === "" ? undefined : ctx.resolveEmbed?.(target, b.attrs, { headingShift: ctx.shift });
    if (inlined !== undefined && inlined.trim() !== "") {
      ctx.notes.add("block transclusion expanded in place; the `embed` itself has no Markdown equivalent and is gone");
      return inlined.trimEnd();
    }
    // Unresolvable: no resolver, an unreachable document, a cycle. What cannot
    // be read cannot be inlined, and a link keeps the target findable.
    ctx.notes.add("block transclusion could not be resolved; emitted a link to the target instead");
    return target === "" ? "" : `[${escText(target)}](${mdDest(target)})`;
  }
  // Unknown raw type: preserve the body in a fenced block tagged with the type.
  ctx.notes.add(`unknown block type \`${b.type}\` emitted as a fenced code block`);
  return fence(b.type, raw);
}

function block(b: Block, ctx: MdCtx): string {
  switch (b.kind) {
    case "heading": {
      if (b.hidden) { ctx.notes.add("hidden heading dropped"); return ""; }
      if (b.id) ctx.notes.add("heading id/attributes dropped (Markdown has no attribute syntax)");
      const level = b.level + ctx.shift;
      if (level > 6) ctx.notes.add("heading deeper than level 6 after the title shift was clamped to level 6");
      return "#".repeat(Math.min(6, level)) + " " + seq(b.inlines, ctx);
    }
    case "paragraph": return seq(b.inlines, ctx);
    case "hidden": return ""; // `%%` line: never rendered
    case "list": return listToMd(b, "", ctx);
    case "block": return typedToMd(b, ctx);
  }
}

// ---------------------------------------------------------------------------
// Frontmatter (meta)
// ---------------------------------------------------------------------------

function yamlValue(v: Value): string {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return /^[\w .,/@-]+$/.test(v) && v.trim() === v && v !== "" ? v : JSON.stringify(v);
}

function frontmatter(metas: Record<string, Value>[]): string {
  const merged: Record<string, Value> = {};
  for (const m of metas) Object.assign(merged, m);
  const keys = Object.keys(merged);
  if (!keys.length) return "";
  return ["---", ...keys.map((k) => `${k}: ${yamlValue(merged[k]!)}`), "---"].join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// What the walkers carry: the loss log, plus the one thing this module cannot
// work out for itself. Resolving an `embed` means reading another document,
// which needs a path and a root — so the caller that owns those supplies a
// function and this module stays free of the filesystem. Returns the target's
// Markdown, or undefined when it cannot be reached.
// What a resolver learns about the host it expands into: how far the host has
// shifted its headings (doc-title.ts), so a borrowed section sits one level
// under the host's own sections rather than beside the host's title.
export interface EmbedHost {
  headingShift: number;
}
// GEP 0010 — the embed's own attributes travel with the target, so a resolver
// can honour `lang=`/`translator=` without re-parsing the block.
export type EmbedResolver = (src: string, attrs?: Record<string, Value>, host?: EmbedHost) => string | undefined;

interface MdCtx {
  notes: Set<string>;
  // Levels added to every heading: 1 when the document's `title` is written as
  // the `h1`, 0 otherwise (doc-title.ts). Borrowed content inherits the host's.
  shift: number;
  resolveEmbed?: EmbedResolver;
}

export interface MdOptions {
  resolveEmbed?: EmbedResolver;
  // Set by a resolver expanding a borrowed document INTO a host: it writes no
  // frontmatter and no title heading of its own — the host's meta governs the
  // page, and a borrowed document's title is metadata, not a heading of the host
  // (render.ts reads meta the same way) — and its headings start `headingShift`
  // levels down, where the host's sections sit.
  embedded?: boolean;
  headingShift?: number;
}

export function gemlToMd(doc: Document, opts: MdOptions = {}): { md: string; notes: string[] } {
  const notes = new Set<string>();
  // The title settles the heading levels before any heading is written: with
  // `title` in meta and no heading echoing it, the title becomes the `h1` and
  // the body's headings move down one level (doc-title.ts). Borrowed content
  // takes its host's shift instead of working one out from its own meta.
  const t = opts.embedded ? undefined : docTitle(doc);
  const shift = opts.headingShift ?? (t ? headingShift(t) : 0);
  const ctx: MdCtx = { notes, shift, ...(opts.resolveEmbed ? { resolveEmbed: opts.resolveEmbed } : {}) };
  const metas: Record<string, Value>[] = [];
  const parts: string[] = [];

  for (const b of doc.children) {
    // Hoist every `meta` block to a single YAML frontmatter at the top.
    if (b.kind === "block" && b.type === "meta" && b.mode === "data") {
      metas.push(b.data ?? {});
      continue;
    }
    const md = block(b, ctx);
    if (md !== "") parts.push(md);
  }

  // A borrowed document's meta is the host's business: its frontmatter would
  // land mid-page, and its title is metadata, not a heading of the host.
  const fm = opts.embedded ? "" : frontmatter(metas);
  const titleLine = t?.title !== undefined && !t.echo ? `# ${escText(t.title)}` : "";
  const body = [titleLine, ...parts].filter((s) => s !== "").join("\n\n");
  const md = (fm ? fm + "\n\n" : "") + body + "\n";
  return { md, notes: [...notes] };
}
