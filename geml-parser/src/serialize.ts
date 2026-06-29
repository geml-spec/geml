// GEML serializer (§ round-trip): document model -> GEML source.
//
// This is the inverse of `parse`: given a Document (or its Block[]), emit GEML
// text that parses back to the *same model*. It does not try to reproduce the
// original bytes — whitespace, attribute quoting, fence length, and footnote
// shorthand are normalized — so `serialize(parse(src))` is also a canonical
// formatter (`geml fmt`). The guarantee it is built to keep is model stability:
//
//     parse(serialize(parse(src)))  ≅  parse(src)
//
// verified over the conformance corpus by test/roundtrip.test.mjs.

import type { Block, Document, ListItem } from "./geml.js";
import { type Inline, parseInline } from "./inline.js";
import type { Value } from "./attrs.js";

type TypedBlock = Extract<Block, { kind: "block" }>;
type ListBlock = Extract<Block, { kind: "list" }>;

// ---------------------------------------------------------------------------
// Values & attributes (§4)
// ---------------------------------------------------------------------------

// True when a bare string would be re-read by `coerce` as a non-string (a
// boolean or a number) — in which case it must be quoted to stay a string.
function looksTyped(s: string): boolean {
  return (
    s === "true" ||
    s === "false" ||
    /^[+-]?\d+$/.test(s) ||
    (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(s) && /[.eE]/.test(s))
  );
}

// One `key=value` / `key` / `.class` / `#id` token of an attribute object.
function serAttrValue(v: Value): string {
  if (v === true) return "";            // caller emits the bare key (a flag)
  if (v === false) return "false";
  if (typeof v === "number") return String(v);
  return `"${v}"`;                       // always quote strings: parses back 1:1
}

interface AttrSource {
  id?: string;
  classes?: string[];
  attrs?: Record<string, Value>;
}

// `{#id .class key="val" flag}` — or "" when there is nothing to emit.
function serAttrs(a: AttrSource): string {
  const parts: string[] = [];
  if (a.id !== undefined) parts.push(`#${a.id}`);
  for (const c of a.classes ?? []) parts.push(`.${c}`);
  for (const [k, v] of Object.entries(a.attrs ?? {})) {
    parts.push(v === true ? k : `${k}=${serAttrValue(v)}`);
  }
  return parts.length ? `{${parts.join(" ")}}` : "";
}

// A `data`-mode (meta) value: a bare word unless quoting is needed to keep it a
// string. `coerce` takes the whole rest-of-line, so spaces need no quoting.
function serDataValue(v: Value): string {
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return String(v);
  return looksTyped(v) || v.trim() !== v ? `"${v}"` : v;
}

// ---------------------------------------------------------------------------
// Inline (§5)
// ---------------------------------------------------------------------------

// Escape every character that could open an inline construct, so a literal text
// run re-parses verbatim. An escaped punctuation byte parses back to that same
// literal byte (§5.3(1)). Used only on escalation (see serInlines).
function escText(s: string): string {
  return s.replace(/[\\`*~$\[\]]/g, (c) => "\\" + c);
}

function longestRun(s: string, ch: string): number {
  let max = 0;
  let run = 0;
  for (const c of s) {
    if (c === ch) { run++; if (run > max) max = run; }
    else run = 0;
  }
  return max;
}

function linkDest(n: Extract<Inline, { type: "link" }>): string {
  if (n.href !== undefined) return n.href;
  if (n.doc !== undefined) return n.anchor !== undefined ? `${n.doc}#${n.anchor}` : n.doc;
  if (n.anchor !== undefined) return `#${n.anchor}`;
  return "";
}

// `esc` controls whether literal text runs are backslash-escaped. The default
// pass emits them verbatim — the parser re-literalizes most stray delimiters on
// its own (an unpaired `*`, a lone `~`), and escaping them would split the run
// and break a surrounding emphasis span. serInlines escalates to esc=true only
// when the verbatim form does not round-trip.
function serInline(n: Inline, esc: boolean): string {
  switch (n.type) {
    case "text": return esc ? escText(n.value) : n.value;
    case "emph": return `*${serSeq(n.children, esc)}*`;
    case "strong": return `**${serSeq(n.children, esc)}**`;
    case "strike": return `~~${serSeq(n.children, esc)}~~`;
    case "code": { const f = "`".repeat(longestRun(n.value, "`") + 1); return f + n.value + f; }
    case "math": return `$${n.value}$`;
    case "break": return "\\\n";
    case "image": return `![${n.alt}](${n.src})${serAttrs({ attrs: n.attrs })}`;
    case "link": return `[${serSeq(n.children, esc)}](${linkDest(n)})${serAttrs({ attrs: n.attrs })}`;
    case "autoref": return `[[${n.doc !== undefined ? `${n.doc}#${n.anchor}` : `#${n.anchor}`}]]`;
    case "footnote": return `[^${n.ref}]`;
  }
}

function serSeq(ns: Inline[], esc: boolean): string {
  return ns.map((n) => serInline(n, esc)).join("");
}

// Serialize an inline sequence so it re-parses to the same tree. Emit verbatim
// first; if re-parsing that disagrees with the model (a stray delimiter that
// would spuriously pair, e.g. text `*lit*`), fall back to escaping. The check is
// what makes this exact rather than heuristic.
function serInlines(ns: Inline[]): string {
  const lazy = serSeq(ns, false);
  if (JSON.stringify(parseInline(lazy, 0, { refs: [] })) === JSON.stringify(ns)) return lazy;
  return serSeq(ns, true);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function serList(list: ListBlock, indent: string): string {
  const out: string[] = [];
  const start = list.start ?? 1;
  list.items.forEach((item: ListItem, k: number) => {
    const marker = list.ordered ? `${start + k}. ` : "- ";
    const task = item.checked === undefined ? "" : item.checked ? "[x] " : "[ ] ";
    out.push(indent + marker + task + serInlines(item.inlines));
    for (const child of item.children ?? []) {
      out.push(child.kind === "list" ? serList(child, indent + "  ") : serBlock(child));
    }
    if (list.loose && k < list.items.length - 1) out.push(""); // blank => loose
  });
  return out.join("\n");
}

function serTypedBlock(b: TypedBlock): string {
  let body: string[];
  if (b.mode === "flow") {
    body = (b.children ?? []).map(serBlock).join("\n\n").split("\n");
  } else if (b.mode === "data") {
    body = Object.entries(b.data ?? {}).map(([k, v]) => `${k} = ${serDataValue(v)}`);
  } else {
    body = b.raw ?? [];
  }
  // Pick a fence longer than any bare `=` run in the body, so a body line (or a
  // nested block's close) can never close this block early (§3 longer-fence
  // nesting). The close is the same length, the convention the parser expects.
  let maxEq = 2;
  for (const ln of body) {
    const m = /^(=+)[ \t]*$/.exec(ln);
    if (m) maxEq = Math.max(maxEq, m[1]!.length);
  }
  const fence = "=".repeat(Math.max(3, maxEq + 1));
  const attrs = serAttrs({ id: b.id, classes: b.classes, attrs: b.attrs });
  const open = fence + " " + b.type + (attrs ? " " + attrs : "");
  return [open, ...body, fence].join("\n");
}

function serBlock(b: Block): string {
  switch (b.kind) {
    case "heading": {
      // The id is always emitted explicitly: it pins the heading's anchor
      // regardless of how the rendered text slugs, and it shields any `{...}`
      // inside the heading text from being read as a trailing attribute object.
      const attrs = serAttrs({ id: b.id, classes: b.classes, attrs: b.attrs });
      return "#".repeat(b.level) + " " + serInlines(b.inlines) + (attrs ? " " + attrs : "");
    }
    case "paragraph": return serInlines(b.inlines);
    case "hidden": return "%%" + (b.text ? " " + b.text : "");
    case "list": return serList(b, "");
    case "block": return serTypedBlock(b);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function serialize(doc: Document | Block[]): string {
  const blocks = Array.isArray(doc) ? doc : doc.children;
  return blocks.map(serBlock).join("\n\n") + "\n";
}
