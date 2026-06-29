// GEML -> Markdown projection (the inverse direction of from-md.ts).
//
// This is a *lossy* export: Markdown has no typed-block primitive, so each GEML
// construct is projected to the nearest GFM shape — headings, fenced code,
// blockquotes (note/aside), GFM tables (from the computed table model), `$$`
// math, mermaid fences, YAML frontmatter (meta), footnote definitions. Things
// GFM cannot express (geml-chart, `{hidden}` blocks, block ids/classes) are
// dropped or degraded, and each such loss is reported in `notes` so a caller
// (and an agent) knows the conversion was not faithful.

import type { Block, Document, ListItem } from "./geml.js";
import type { Inline } from "./inline.js";
import type { TableModel, TableCell, Align } from "./table.js";
import type { Value } from "./attrs.js";

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

// Escape the characters that could start a Markdown inline construct, so a
// literal text run renders verbatim. Kept deliberately light — Markdown is
// forgiving, and over-escaping produces noisy output.
function escText(s: string): string {
  return s.replace(/[\\`*_\[\]]/g, (c) => "\\" + c);
}

function linkDest(n: Extract<Inline, { type: "link" }>): string {
  if (n.href !== undefined) return n.href;
  if (n.doc !== undefined) return n.anchor !== undefined ? `${n.doc}#${n.anchor}` : n.doc;
  if (n.anchor !== undefined) return `#${n.anchor}`;
  return "";
}

function inline(n: Inline): string {
  switch (n.type) {
    case "text": return escText(n.value);
    case "emph": return `*${seq(n.children)}*`;
    case "strong": return `**${seq(n.children)}**`;
    case "strike": return `~~${seq(n.children)}~~`;
    case "code": return "`" + n.value + "`";
    case "math": return `$${n.value}$`;
    case "break": return "  \n";
    case "image": return `![${n.alt}](${n.src})`;
    case "link": return `[${seq(n.children)}](${linkDest(n)})`;
    // Markdown has no auto-reference; project to a plain link to the anchor.
    case "autoref": return n.doc !== undefined ? `[${n.doc}#${n.anchor}](${n.doc}#${n.anchor})` : `[#${n.anchor}](#${n.anchor})`;
    case "footnote": return `[^${n.ref}]`;
  }
}

function seq(ns: Inline[]): string {
  return ns.map(inline).join("");
}

// Inline text for a table cell: render inlines, then neutralise the two bytes
// that would break a GFM cell.
function cellText(c: TableCell): string {
  return seq(c.inlines).replace(/\|/g, "\\|").replace(/\n/g, " ");
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

function tableToMd(t: TableModel, notes: Set<string>): string {
  if (t.src !== undefined) notes.add(`table from external source \`${t.src}\` is not inlined; emitted header only`);
  const cols = t.columns;
  const lines: string[] = [];
  if (t.caption) lines.push(`*${t.caption}*`, "");
  lines.push(`| ${cols.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`);
  lines.push(`| ${cols.map((_, i) => sep(t.align[i])).join(" | ")} |`);
  const pad = (cells: string[]) => {
    while (cells.length < cols.length) cells.push("");
    return cells.slice(0, cols.length);
  };
  for (const row of t.rows) lines.push(`| ${pad(row.map(cellText)).join(" | ")} |`);
  if (t.summary) lines.push(`| ${pad(t.summary.map(cellText)).join(" | ")} |`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function listToMd(b: Extract<Block, { kind: "list" }>, indent: string, notes: Set<string>): string {
  const out: string[] = [];
  const start = b.start ?? 1;
  b.items.forEach((item: ListItem, k: number) => {
    const marker = b.ordered ? `${start + k}. ` : "- ";
    const task = item.checked === undefined ? "" : item.checked ? "[x] " : "[ ] ";
    out.push(indent + marker + task + seq(item.inlines));
    for (const child of item.children ?? []) {
      out.push(child.kind === "list" ? listToMd(child, indent + "  ", notes) : block(child, notes));
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
  return [f + lang, ...body, f].join("\n");
}

function attr(b: Extract<Block, { kind: "block" }>, key: string): string | undefined {
  const v = b.attrs[key];
  return typeof v === "string" ? v : v === undefined ? undefined : String(v);
}

// A typed block (raw / flow). meta is hoisted to frontmatter elsewhere.
function typedToMd(b: Extract<Block, { kind: "block" }>, notes: Set<string>): string {
  if (b.hidden) { notes.add("`{hidden}` block(s) dropped (not part of the rendered output)"); return ""; }

  if (b.mode === "flow") {
    // Footnote definition: a `note.footnote` carrying its ref as the id.
    if (b.type === "note" && b.classes.includes("footnote") && b.id) {
      const text = (b.children ?? []).map((c) => block(c, notes)).join(" ").replace(/\n+/g, " ").trim();
      return `[^${b.id}]: ${text}`;
    }
    if (b.type === "aside") notes.add("`aside` block(s) projected to blockquote (Markdown has no aside)");
    const inner = (b.children ?? []).map((c) => block(c, notes)).filter(Boolean).join("\n\n");
    return inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
  }

  // raw modes
  const raw = b.raw ?? [];
  if (b.type === "code") return fence(attr(b, "lang") ?? "", raw);
  if (b.type === "math") return ["$$", ...raw, "$$"].join("\n");
  if (b.type === "output") return fence("", raw);
  if (b.type === "table" && b.table) return tableToMd(b.table, notes);
  if (b.type === "diagram") {
    const fmt = attr(b, "format") ?? "";
    if (fmt === "geml-chart") {
      // No Markdown chart primitive: degrade to a labelled descriptor.
      notes.add("`geml-chart` block(s) cannot render in Markdown; emitted a descriptor");
      const desc = ["type", "data", "x", "y", "series"].map((k) => { const v = attr(b, k); return v ? `${k}=${v}` : ""; }).filter(Boolean).join(" ");
      return fence("geml-chart", [desc]);
    }
    return fence(fmt, raw); // mermaid renders on GitHub; others stay as a code block
  }
  // Unknown raw type: preserve the body in a fenced block tagged with the type.
  notes.add(`unknown block type \`${b.type}\` emitted as a fenced code block`);
  return fence(b.type, raw);
}

function block(b: Block, notes: Set<string>): string {
  switch (b.kind) {
    case "heading": {
      if (b.hidden) { notes.add("hidden heading dropped"); return ""; }
      if (b.id) notes.add("heading id/attributes dropped (Markdown has no attribute syntax)");
      return "#".repeat(b.level) + " " + seq(b.inlines);
    }
    case "paragraph": return seq(b.inlines);
    case "hidden": return ""; // `%%` line: never rendered
    case "list": return listToMd(b, "", notes);
    case "block": return typedToMd(b, notes);
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

export function gemlToMd(doc: Document): { md: string; notes: string[] } {
  const notes = new Set<string>();
  const metas: Record<string, Value>[] = [];
  const parts: string[] = [];

  for (const b of doc.children) {
    // Hoist every `meta` block to a single YAML frontmatter at the top.
    if (b.kind === "block" && b.type === "meta" && b.mode === "data") {
      metas.push(b.data ?? {});
      continue;
    }
    const md = block(b, notes);
    if (md !== "") parts.push(md);
  }

  const fm = frontmatter(metas);
  const body = parts.join("\n\n");
  const md = (fm ? fm + "\n\n" : "") + body + "\n";
  return { md, notes: [...notes] };
}
