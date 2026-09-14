// GEML -> Typst projection.
//
// Converts a GEML Document AST to standard, publication-grade Typst source code.
// Handles typed blocks, headings with label targets (<id>), auto-references (@id),
// tables, equations, code with syntax highlighting, and styled callout boxes.

import type { Block, Document, ListItem } from "./geml.js";
import type { Inline } from "./inline.js";
import type { TableModel, TableCell, Align } from "./table.js";
import type { Value } from "./attrs.js";

// ---------------------------------------------------------------------------
// Inline Escaping & Rendering
// ---------------------------------------------------------------------------

// Escape characters that have syntactic meaning in Typst markup mode.
export function escText(s: string): string {
  return s.replace(/[\\*_\`\$#\[\]@<>]/g, (c) => "\\" + c);
}

// Escape strings that appear inside Typst string literals ("...").
export function escString(s: string): string {
  return s.replace(/["\\]/g, (c) => "\\" + c);
}

// Clean and validate an id to ensure it's a valid Typst label.
export function sanitizeLabel(id: string): string {
  // Typst labels allow ASCII letters, numbers, hyphens, and underscores.
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function linkDest(n: Extract<Inline, { type: "link" }>): { isInternal: boolean; dest: string } {
  if (n.href !== undefined) return { isInternal: false, dest: n.href };
  if (n.doc !== undefined) return { isInternal: false, dest: n.anchor !== undefined ? `${n.doc}#${n.anchor}` : n.doc };
  if (n.anchor !== undefined) return { isInternal: true, dest: sanitizeLabel(n.anchor) };
  return { isInternal: false, dest: "" };
}

function inline(n: Inline, ctx: TypstCtx): string {
  switch (n.type) {
    case "text":
      return escText(n.value);
    case "emph":
      return `_${seq(n.children, ctx)}_`;
    case "strong":
      return `*${seq(n.children, ctx)}*`;
    case "strike":
      return `#strike[${seq(n.children, ctx)}]`;
    case "code":
      return "`" + n.value + "`";
    case "math":
      return `$${n.value}$`;
    case "break":
      return "\\ \n";
    case "image":
      if (n.alt) {
        return `#figure(image("${escString(n.src)}"), caption: [${escText(n.alt)}])`;
      }
      return `#image("${escString(n.src)}")`;
    case "link": {
      const { isInternal, dest } = linkDest(n);
      const text = seq(n.children, ctx);
      if (isInternal) {
        return dest ? `#link(<${dest}>)[${text}]` : text;
      }
      return dest ? `#link("${escString(dest)}")[${text}]` : text;
    }
    case "autoref": {
      const anchor = n.base ?? n.anchor;
      if (n.doc !== undefined) {
        const dest = `${n.doc}#${anchor}`;
        return `#link("${escString(dest)}")[${escText(n.value ?? dest)}]`;
      }
      if (anchor === undefined) return n.value ?? "";
      const label = sanitizeLabel(anchor);
      if (n.value !== undefined && n.value !== `#${anchor}` && n.value !== anchor) {
        return `#link(<${label}>)[${escText(n.value)}]`;
      }
      return `@${label}`;
    }
    case "project": {
      if (n.value !== undefined) return escText(n.value);
      const src = n.doc !== undefined ? `${n.doc}#${n.anchor}` : `#${n.anchor}`;
      const got = ctx.resolveEmbed?.(src);
      if (got !== undefined && got.trim() !== "") {
        return got.trim().replace(/\s*\n+\s*/g, " ");
      }
      return `#link("${escString(src)}")[${escText(src)}]`;
    }
    case "footnote": {
      const ref = sanitizeLabel(n.ref);
      return `#footnote[#link(<${ref}>)[#${escText(n.ref)}]]`;
    }
  }
}

function seq(ns: Inline[], ctx: TypstCtx): string {
  return ns.map((n) => inline(n, ctx)).join("");
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function alignToTypst(a: Align | undefined): string {
  if (a === "center") return "center";
  if (a === "right") return "right";
  if (a === "left") return "left";
  return "auto";
}

function cellText(c: TableCell, ctx: TypstCtx): string {
  return seq(c.inlines, ctx).replace(/\n/g, " ");
}

function tableToTypst(t: TableModel, ctx: TypstCtx, id?: string): string {
  const cols = t.columns;
  if (cols.length === 0) return "";

  const aligns = cols.map((_, i) => alignToTypst(t.align[i]));
  const colFmt = `(${cols.map(() => "auto").join(", ")})`;
  const alignFmt = `(${aligns.join(", ")})`;

  const lines: string[] = [];
  lines.push(`table(`);
  lines.push(`  columns: ${colFmt},`);
  lines.push(`  align: ${alignFmt},`);
  lines.push(`  table.header(${cols.map((c) => `[${escText(c)}]`).join(", ")}),`);

  const pad = (cells: string[]) => {
    while (cells.length < cols.length) cells.push("");
    return cells.slice(0, cols.length);
  };

  for (const row of t.rows) {
    const rendered = pad(row.map((c) => cellText(c, ctx)));
    lines.push(`  ${rendered.map((c) => `[${c}]`).join(", ")},`);
  }

  if (t.summary && t.summary.length > 0) {
    lines.push(`  table.hline(),`);
    const rendered = pad(t.summary.map((c) => cellText(c, ctx)));
    lines.push(`  ${rendered.map((c) => `[${c}]`).join(", ")},`);
  }

  lines.push(`)`);
  const tableContent = lines.join("\n");

  const labelStr = id ? ` <${sanitizeLabel(id)}>` : "";
  if (t.caption) {
    return `#figure(\n${tableContent},\n  caption: [${escText(t.caption)}]\n)${labelStr}`;
  }
  if (id) {
    return `#figure(\n${tableContent}\n)${labelStr}`;
  }
  return `#${tableContent}`;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function listToTypst(b: Extract<Block, { kind: "list" }>, indent: string, ctx: TypstCtx): string {
  const out: string[] = [];
  b.items.forEach((item: ListItem, k: number) => {
    const marker = b.ordered ? `+ ` : `- `;
    const task = item.checked === undefined ? "" : item.checked ? "[x] " : "[ ] ";
    const [head, ...cont] = seq(item.inlines, ctx).split("\n");
    out.push(indent + marker + task + head);
    const contIndent = indent + "  ";
    for (const l of cont) out.push(contIndent + l);
    for (const child of item.children ?? []) {
      out.push(child.kind === "list" ? listToTypst(child, indent + "  ", ctx) : block(child, ctx));
    }
    if (b.loose && k < b.items.length - 1) out.push("");
  });
  return out.join("\n");
}

function codeFence(lang: string, body: string[]): string {
  let max = 2;
  for (const ln of body) {
    const m = /^(`+)/.exec(ln.trim());
    if (m) max = Math.max(max, m[1]!.length);
  }
  const f = "`".repeat(Math.max(3, max + 1));
  return [f + lang, ...body, f].join("\n");
}

function attr(b: Extract<Block, { kind: "block" }>, key: string): string | undefined {
  const v = b.attrs[key];
  return typeof v === "string" ? v : v === undefined ? undefined : String(v);
}

function noteColors(classes: string[]): { stroke: string; fill: string; title: string } {
  if (classes.includes("warning")) return { stroke: `rgb("f59e0b")`, fill: `rgb("fffbeb")`, title: "Warning" };
  if (classes.includes("error") || classes.includes("danger")) return { stroke: `rgb("ef4444")`, fill: `rgb("fef2f2")`, title: "Danger" };
  if (classes.includes("tip") || classes.includes("success")) return { stroke: `rgb("10b981")`, fill: `rgb("f0fdf4")`, title: "Tip" };
  if (classes.includes("important")) return { stroke: `rgb("8b5cf6")`, fill: `rgb("f5f3ff")`, title: "Important" };
  return { stroke: `rgb("3b82f6")`, fill: `rgb("eff6ff")`, title: "Note" };
}

function typedToTypst(b: Extract<Block, { kind: "block" }>, ctx: TypstCtx): string {
  if (b.hidden) {
    ctx.notes.add("`{hidden}` block(s) dropped");
    return "";
  }

  const id = b.id ? sanitizeLabel(b.id) : undefined;
  const label = id ? ` <${id}>` : "";

  if (b.mode === "flow") {
    const inner = (b.children ?? []).map((c) => block(c, ctx)).filter(Boolean).join("\n\n");
    if (b.type === "text") {
      // Addressable prose container
      return inner + label;
    }
    // Callout note
    const colors = noteColors(b.classes);
    const titleAttr = attr(b, "title") ?? colors.title;
    return `#callout(title: [${escText(titleAttr)}], stroke: ${colors.stroke}, fill: ${colors.fill})[\n${inner}\n]${label}`;
  }

  // raw modes
  const raw = b.raw ?? [];

  if (b.type === "code") {
    const lang = attr(b, "lang") ?? "";
    const content = codeFence(lang, raw);
    if (id || attr(b, "caption")) {
      const cap = attr(b, "caption");
      const capArg = cap ? `caption: [${escText(cap)}], ` : "";
      return `#figure(\n${content},\n  ${capArg}\n)${label}`;
    }
    return content;
  }

  if (b.type === "math") {
    const mathBody = raw.join("\n").trim();
    return `$ ${mathBody} $${label}`;
  }

  if ((b.type === "table" || b.type === "view") && b.table) {
    return tableToTypst(b.table, ctx, b.id);
  }

  if (b.type === "data") {
    const fmt = attr(b, "format") ?? "json";
    if (raw.length === 0 && b.value !== undefined) {
      const v = b.value;
      const body = fmt === "jsonl" && Array.isArray(v)
        ? v.map((x) => JSON.stringify(x))
        : JSON.stringify(v, null, 2).split("\n");
      return codeFence(fmt, body) + label;
    }
    return codeFence(fmt, raw) + label;
  }

  if (b.type === "diagram") {
    const fmt = attr(b, "format") ?? "";
    return codeFence(fmt, raw) + label;
  }

  if (b.type === "embed") {
    const target = typeof b.attrs["src"] === "string" ? (b.attrs["src"] as string).trim() : "";
    const inlined = target === "" ? undefined : ctx.resolveEmbed?.(target, b.attrs);
    if (inlined !== undefined && inlined.trim() !== "") {
      return inlined.trimEnd();
    }
    return target === "" ? "" : `#link("${escString(target)}")[${escText(target)}]`;
  }

  // Fallback for unknown raw type
  return codeFence(b.type, raw) + label;
}

function block(b: Block, ctx: TypstCtx): string {
  switch (b.kind) {
    case "heading": {
      if (b.hidden) return "";
      const prefix = "=".repeat(Math.min(b.level, 6));
      const label = b.id ? ` <${sanitizeLabel(b.id)}>` : "";
      return `${prefix} ${seq(b.inlines, ctx)}${label}`;
    }
    case "paragraph":
      return seq(b.inlines, ctx);
    case "hidden":
      return "";
    case "list":
      return listToTypst(b, "", ctx);
    case "block":
      return typedToTypst(b, ctx);
  }
}

// ---------------------------------------------------------------------------
// Document Setup & Preamble
// ---------------------------------------------------------------------------

function documentPreamble(metas: Record<string, Value>[]): string {
  const merged: Record<string, Value> = {};
  for (const m of metas) Object.assign(merged, m);

  const lines: string[] = [];
  lines.push("// Generated by @geml/geml --to typst");

  // Document metadata
  const title = typeof merged["title"] === "string" ? merged["title"] : undefined;
  const author = typeof merged["author"] === "string" ? merged["author"] : undefined;
  if (title || author) {
    const docArgs: string[] = [];
    if (title) docArgs.push(`title: "${escString(title)}"`);
    if (author) docArgs.push(`author: ("${escString(author)}",)`);
    lines.push(`#set document(${docArgs.join(", ")})`);
  }

  // Page setup
  const paper = typeof merged["paper"] === "string" ? merged["paper"] : "a4";
  lines.push(`#set page(paper: "${escString(paper)}", numbering: "1")`);

  // Language setup
  const lang = typeof merged["lang"] === "string" ? merged["lang"] : undefined;
  if (lang) {
    lines.push(`#set text(lang: "${escString(lang)}")`);
  }

  // Numbering configuration
  const noHeadingNum = merged["numbering"] === false || merged["numbering"] === "none" || merged["heading-numbering"] === false;
  if (!noHeadingNum) {
    lines.push(`#set heading(numbering: "1.1")`);
  }
  lines.push(`#set math.equation(numbering: "(1)")`);

  // Callout helper definition
  lines.push(`
#let callout(body, title: none, stroke: luma(180), fill: luma(250)) = block(
  fill: fill,
  stroke: (left: 3pt + stroke),
  inset: (x: 10pt, y: 8pt),
  radius: (right: 3pt),
  width: 100%,
  breakable: true,
)[
  #if title != none [*#title* \\ ]
  #body
]`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TypstCtx {
  notes: Set<string>;
  resolveEmbed?: (src: string, attrs?: Record<string, Value>) => string | undefined;
}

export interface TypstOptions {
  resolveEmbed?: (src: string, attrs?: Record<string, Value>) => string | undefined;
}

export function gemlToTypst(doc: Document, opts: TypstOptions = {}): { typst: string; notes: string[] } {
  const notes = new Set<string>();
  const ctx: TypstCtx = opts.resolveEmbed ? { notes, resolveEmbed: opts.resolveEmbed } : { notes };
  const metas: Record<string, Value>[] = [];
  const parts: string[] = [];

  for (const b of doc.children) {
    if (b.kind === "block" && b.type === "meta" && b.mode === "data") {
      metas.push(b.data ?? {});
      continue;
    }
    const t = block(b, ctx);
    if (t !== "") parts.push(t);
  }

  const preamble = documentPreamble(metas);
  const body = parts.join("\n\n");
  const typst = preamble + "\n\n" + body + "\n";
  return { typst, notes: [...notes] };
}
