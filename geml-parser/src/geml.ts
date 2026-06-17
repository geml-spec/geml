// GEML reference parser — Milestone 1: block scanner.
//
// Scope: typed-block fences (equal-length close + longer-fence nesting),
// the `meta` data block, ATX headings, lists and paragraphs, the attribute
// object with §4 value typing, and a document-model JSON serialization.
// Inline parsing (§5) and reference validation (§4/§8) arrive in M2.

import { readFileSync } from "node:fs";
import { commit, restore, verify } from "./history.js";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type Value = string | number | boolean;

export interface Attrs {
  id?: string;
  classes: string[];
  attrs: Record<string, Value>;
}

export type BodyMode = "raw" | "flow" | "data";

export type Block =
  | { kind: "heading"; level: number; text: string; id?: string; classes: string[]; attrs: Record<string, Value> }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | {
      kind: "block";
      type: string;
      mode: BodyMode;
      id?: string;
      classes: string[];
      attrs: Record<string, Value>;
      raw?: string[];
      children?: Block[];
      data?: Record<string, Value>;
    };

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  line: number; // 1-based
}

export interface Document {
  kind: "document";
  children: Block[];
  diagnostics: Diagnostic[];
}

// Type registry: which body mode each typed block uses. Unknown types are a
// warning and fall back to `raw` (forward compatibility, §3/§8).
const REGISTRY: Record<string, BodyMode> = {
  code: "raw",
  diagram: "raw",
  math: "raw",
  table: "raw", // structured table parsing lands in M3
  note: "flow",
  aside: "flow",
  meta: "data",
};

// ---------------------------------------------------------------------------
// Value typing (§4)
// ---------------------------------------------------------------------------

function coerce(raw: string): Value {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1); // quoted -> always string
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(t) && /[.eE]/.test(t)) return parseFloat(t);
  return t; // bare word -> string
}

// Split on whitespace while keeping double-quoted spans intact.
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const ch of s) {
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
    } else if (!inQuote && /\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ""; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Parse `{#id .class key=val key2="a b"}` (braces included).
function parseAttrs(src: string): Attrs {
  const inner = src.trim().replace(/^\{/, "").replace(/\}$/, "");
  const out: Attrs = { classes: [], attrs: {} };
  for (const tok of tokenize(inner)) {
    if (tok.startsWith("#")) {
      out.id = tok.slice(1);
    } else if (tok.startsWith(".")) {
      out.classes.push(tok.slice(1));
    } else {
      const eq = tok.indexOf("=");
      if (eq > 0) out.attrs[tok.slice(0, eq)] = coerce(tok.slice(eq + 1));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lexical helpers
// ---------------------------------------------------------------------------

const FENCE_OPEN = /^(={3,})[ \t]+([A-Za-z][A-Za-z0-9_-]*)[ \t]*(\{.*\})?[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*(\{[^}]*\})?[ \t]*$/;
const LIST_ITEM = /^[ \t]*(?:[-*]|\d+\.)[ \t]+(.*)$/;
const ORDERED_ITEM = /^[ \t]*\d+\.[ \t]+/;

function isCloseFence(line: string, openLen: number): boolean {
  const t = line.replace(/\s+$/, "");
  return /^=+$/.test(t) && t.length === openLen;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/`[^`]*`/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

// ---------------------------------------------------------------------------
// Block scanner
// ---------------------------------------------------------------------------

function scanBlocks(lines: string[], base: number, diags: Diagnostic[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") { i++; continue; }

    const open = FENCE_OPEN.exec(line);
    if (open) {
      const openLen = open[1]!.length;
      const type = open[2]!;
      const attrs = open[3] ? parseAttrs(open[3]) : { classes: [], attrs: {} };
      const openLineNo = base + i + 1;

      // Collect body until a bare fence of exactly the opening length.
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        if (isCloseFence(lines[j]!, openLen)) { closed = true; break; }
        body.push(lines[j]!);
      }
      if (!closed) {
        diags.push({ severity: "error", message: `unterminated \`${type}\` block (no matching ${"=".repeat(openLen)})`, line: openLineNo });
      }

      let mode = REGISTRY[type];
      if (mode === undefined) {
        diags.push({ severity: "warning", message: `unknown block type \`${type}\`; body kept as raw`, line: openLineNo });
        mode = "raw";
      }

      const block: Extract<Block, { kind: "block" }> = {
        kind: "block", type, mode, classes: attrs.classes, attrs: attrs.attrs,
      };
      if (attrs.id !== undefined) block.id = attrs.id;

      if (mode === "flow") {
        block.children = scanBlocks(body, base + i + 1, diags);
      } else if (mode === "data") {
        block.data = parseData(body);
      } else {
        block.raw = body;
      }

      blocks.push(block);
      i = closed ? j + 1 : j;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = h[2]!;
      const a = h[3] ? parseAttrs(h[3]) : { classes: [], attrs: {} };
      const block: Extract<Block, { kind: "heading" }> = {
        kind: "heading", level, text, id: a.id ?? slug(text), classes: a.classes, attrs: a.attrs,
      };
      blocks.push(block);
      i++;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const ordered = ORDERED_ITEM.test(line);
      const items: string[] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i]!)) {
        items.push(LIST_ITEM.exec(lines[i]!)![1]!);
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // Paragraph: consecutive non-blank lines that start no other construct.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !FENCE_OPEN.test(lines[i]!) &&
      !HEADING.test(lines[i]!) &&
      !LIST_ITEM.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    blocks.push({ kind: "paragraph", text: para.join("\n") });
  }

  return blocks;
}

// Parse `key = val` lines of a `data`-mode block (e.g. meta), §4 value typing.
function parseData(lines: string[]): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    out[raw.slice(0, eq).trim()] = coerce(raw.slice(eq + 1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parse(source: string): Document {
  const diagnostics: Diagnostic[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const children = scanBlocks(lines, 0, diagnostics);
  return { kind: "document", children, diagnostics };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function historyPathFor(geml: string): string {
  return geml.replace(/\.geml$/, "") + ".gemlhistory";
}

function parseStamp(s: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) throw new Error(`bad --at timestamp: ${s} (want YYYYMMDDTHHMMSSZ)`);
  const [, y, mo, d, h, mi, se] = m;
  return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +se!));
}

function runHistory(args: string[]): void {
  const sub = args[0];
  const file = args[1];
  if (!sub || !file) {
    console.error("usage: geml history <commit|verify|show|restore> <file.geml> [...]");
    process.exit(2);
  }
  const historyPath = flag(args, "--history") ?? historyPathFor(file);

  if (sub === "commit") {
    const at = flag(args, "--at");
    const r = commit({
      gemlPath: file,
      historyPath,
      summary: flag(args, "-m") ?? flag(args, "--message") ?? "",
      author: flag(args, "--author"),
      at: at ? parseStamp(at) : undefined,
    });
    console.log(`committed ${r.id}`);
  } else if (sub === "verify") {
    const res = verify(historyPath, file);
    for (const e of res.errors) console.error(`error: ${e}`);
    for (const w of res.warnings) console.error(`warning: ${w}`);
    console.log(`verify: ${res.ok ? "OK" : "FAILED"} (${res.checked} revisions reconstructed & hashed)`);
    if (!res.ok) process.exit(1);
  } else if (sub === "show") {
    const rev = args[2];
    if (!rev) { console.error("usage: geml history show <file.geml> <revision>"); process.exit(2); }
    process.stdout.write(restore({ historyPath, gemlPath: file, revision: rev }));
  } else if (sub === "restore") {
    const rev = args[2];
    if (!rev) { console.error("usage: geml history restore <file.geml> <revision> [--force]"); process.exit(2); }
    restore({ historyPath, gemlPath: file, revision: rev, write: true, force: args.includes("--force") });
    console.log(`restored ${file} to ${rev}`);
  } else {
    console.error(`unknown history subcommand: ${sub}`);
    process.exit(2);
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("geml.js") || entry.endsWith("geml.ts")) {
  const argv = process.argv.slice(2);
  if (argv[0] === "history") {
    runHistory(argv.slice(1));
  } else {
    const file = argv[0];
    if (!file) {
      console.error("usage: geml <file.geml> | geml history <commit|verify|show|restore> <file.geml> [...]");
      process.exit(2);
    }
    const doc = parse(readFileSync(file, "utf8"));
    console.log(JSON.stringify(doc, null, 2));
    if (doc.diagnostics.some((d) => d.severity === "error")) process.exit(1);
  }
}
