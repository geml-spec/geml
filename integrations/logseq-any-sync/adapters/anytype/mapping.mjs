// One Anytype object (an AnyBlock v2 document) ⇄ one GEML document.
//
// Every Anytype block becomes one GEML block with an `#id`, so `geml get/set
// '#id'` addresses exactly the block Anytype edits. What GEML can say natively
// it says natively (paragraphs, lists, checkboxes, headings, code, maths,
// mermaid/graphviz diagrams, callouts, quotes, toggles); fields GEML has no
// slot for ride along on a `%% anytype:` comment line inside flow blocks, and
// a block with no GEML shape at all is kept verbatim as
// `=== data {#id .anyblock format=json}`. GEML blocks Anytype has no shape for
// travel the other way as a code block whose language is `geml`.
//
// Ids: Anytype decides the id of every block it holds. A block the vault
// named first keeps its GEML id in the vault; `ids` pairs that GEML id with
// the Anytype id, and the two are translated at this boundary. A block with
// no pairing is written under its Anytype id.
//
// Pure: no I/O. `ctx.assetPath(block)` (optional) names the local copy of a
// file block's bytes.

import { parseAttrs } from "@geml/geml/dist/attrs.js";

const FENCE = /^(={3,})[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*(?:(\{.*\})[ \t]*)?$/;
const LABELED_CLOSE = /^={3,}[ \t]*#(\S+)[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HEADING_ID = /^(.*?)[ \t]*\{([^{}]*)\}$/;
const ITEM = /^([ \t]*)([-*]|\d+\.)[ \t]+(.*)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;
const COMMENT = /^%%[ \t]?anytype:[ \t]*(\{.*\})[ \t]*$/;

const TEXT_TYPES = new Set(["paragraph", "bulleted_list_item", "numbered_list_item", "checkbox"]);
const HEADINGS = { heading_1: 2, heading_2: 3, heading_3: 4 };
const NOTES = { callout: "", quote: "quote", toggle: "toggle" };
const FILES = new Set(["file", "image", "video", "audio", "pdf"]);
const DIAGRAMS = new Set(["mermaid", "graphviz"]);

/** Fields a block's GEML shape states natively, by block type. */
function nativeFields(type) {
  if (TEXT_TYPES.has(type)) return ["id", "type", "indent", "text", ...(type === "checkbox" ? ["checked"] : [])];
  if (type in HEADINGS || type in NOTES) return ["id", "type", "indent", "text"];
  if (type === "code") return ["id", "type", "indent", "language", "text"];
  if (type === "embed") return ["id", "type", "indent", "processor", "text"];
  if (FILES.has(type)) return ["id", "indent"];
  return null;
}

function extrasOf(b) {
  const native = nativeFields(b.type) ?? [];
  const out = {};
  for (const [k, v] of Object.entries(b)) if (!native.includes(k)) out[k] = v;
  return out;
}

function fenceFor(body) {
  let longest = 0;
  for (const line of body.split("\n")) {
    const m = /^=+/.exec(line);
    if (m) longest = Math.max(longest, m[0].length);
  }
  return "=".repeat(Math.max(3, longest + 1));
}

function block(type, attrs, body) {
  const f = fenceFor(body);
  return `${f} ${type} {${attrs.trim()}}\n${body}${body ? "\n" : ""}${f}`;
}

const levelClass = (b) => (b.indent ? ` .level-${b.indent + 1}` : "");

/** Text that would read back as something else inside a GEML flow body. */
function unsafeText(t) {
  const first = t.split("\n")[0];
  return /^\s/.test(t) || /^(#{1,6}[ \t]|[-*][ \t]|\d+\.[ \t]|=|%%|\[[ xX]\][ \t]|```|>)/.test(first)
    || /\n\s*(=|%%|```|#{1,6}[ \t]|[-*][ \t]|\d+\.[ \t])/.test(t) || /\\(\n|$)/.test(t);
}

/** Anytype's in-block line break is GEML's hard break: a backslash at line end. */
const textToFlow = (t, indent = "") => t.split("\n").join(`\\\n${indent}`);

function comment(extras) {
  return Object.keys(extras).length ? `%% anytype: ${JSON.stringify(extras)}\n` : "";
}

/**
 * An AnyBlock v2 document → GEML text.
 * @param {object} doc the document, as `GET …/objects/{id}?ids=full` returns it
 * @param {{ assetPath?: (b: object) => string | undefined, ids?: Record<string, string> }} [ctx]
 *   `ids`: GEML id → Anytype id for blocks the vault named first.
 * @returns {{ text: string, ids: Record<string, string> }} the text, and the
 *   pairings it relied on or made (a `geml` code block unwrapped for the first time)
 */
export function anyToGeml(doc, ctx = {}) {
  const { blocks = [], ...envelope } = doc;
  const ids = { ...(ctx.ids ?? {}) };
  const toGeml = new Map(Object.entries(ids).map(([g, a]) => [a, g]));
  const out = [block("data", "#object .object format=json", JSON.stringify(envelope))];
  out.push(`# ${String(envelope.properties?.Name ?? envelope.name ?? "Untitled").replace(/\n/g, " ")}`);
  const numberAt = new Map(); // indent -> next number of a numbered run
  for (const b of blocks) {
    const indent = b.indent ?? 0;
    for (const k of [...numberAt.keys()]) if (k > indent) numberAt.delete(k);
    if (b.type !== "numbered_list_item") numberAt.delete(indent);
    out.push(blockToGeml(b, ctx, numberAt, ids, toGeml));
  }
  return { text: out.join("\n\n") + "\n", ids };
}

function dataBlock(b, gid) {
  const { id: _id, ...rest } = b;
  return block("data", `${gid ? `#${gid} ` : ""}.anyblock format=json`, JSON.stringify(rest));
}

function blockToGeml(b, ctx, numberAt, ids, toGeml) {
  const gid = b.id ? (toGeml.get(b.id) ?? b.id) : undefined;
  const id = gid ? `#${gid}` : "";
  const extras = extrasOf(b);
  const native = nativeFields(b.type);
  const text = typeof b.text === "string" ? b.text : "";
  if (native === null) return dataBlock(b, gid);

  if (TEXT_TYPES.has(b.type)) {
    if (text !== "" && unsafeText(text)) return dataBlock(b, gid);
    let line;
    if (b.type === "paragraph") line = textToFlow(text);
    else if (b.type === "bulleted_list_item") line = `- ${textToFlow(text, "  ")}`;
    else if (b.type === "checkbox") line = `- [${b.checked ? "x" : " "}] ${textToFlow(text, "  ")}`;
    else {
      const n = numberAt.get(b.indent ?? 0) ?? 1;
      numberAt.set(b.indent ?? 0, n + 1);
      line = `${n}. ${textToFlow(text, " ".repeat(String(n).length + 2))}`;
    }
    return block("text", `${id}${levelClass(b)}`, comment(extras) + line);
  }

  if (b.type in HEADINGS) {
    if (text === "" || unsafeText(text) || /[{}]/.test(text)) return dataBlock(b, gid);
    const hashes = "#".repeat(HEADINGS[b.type]);
    if (!Object.keys(extras).length && !b.indent) return `${hashes} ${text}${id ? ` {${id}}` : ""}`;
    return block("text", `${id}${levelClass(b)}`, comment(extras) + `${hashes} ${text}`);
  }

  if (b.type in NOTES) {
    if (text !== "" && unsafeText(text)) return dataBlock(b, gid);
    const cls = NOTES[b.type] ? ` .${NOTES[b.type]}` : "";
    return block("note", `${id}${cls}${levelClass(b)}`, comment(extras) + textToFlow(text));
  }

  if (b.type === "code") {
    if (Object.keys(extras).length) return dataBlock(b, gid);
    if (b.language === "geml" && b.id) {
      const src = unwrap(b, ids, toGeml);
      if (src !== undefined) return src;
    }
    return block("code", `${id}${b.language ? ` lang=${b.language}` : ""}${levelClass(b)}`, text);
  }

  if (b.type === "embed") {
    const p = b.processor ?? "latex";
    if (Object.keys(extras).length || (p !== "latex" && !DIAGRAMS.has(p))) return dataBlock(b, gid);
    if (p === "latex") return block("math", `${id}${levelClass(b)}`, text);
    return block("diagram", `${id} format=${p}${levelClass(b)}`, text);
  }

  // The file family: the bytes live in Anytype's file layer; the vault keeps a
  // local copy when the engine downloaded one.
  const name = String(b.name ?? b.type).replace(/[\[\]\n]/g, " ");
  const local = ctx.assetPath?.(b);
  const target = local ?? (b.object_id ? `anytype://object?objectId=${encodeURIComponent(b.object_id)}` : "");
  const body = b.type === "image" && local ? `![${name}](${local})` : `[${name}](${target})`;
  return block("text", `${id} .file${levelClass(b)}`, comment(extras) + body);
}

/** A `geml` code block is a GEML block that travelled to Anytype. It comes back
 *  as itself when its source is exactly one typed block with an id, and that id
 *  is paired with this Anytype id, or with nothing yet. */
function unwrap(b, ids, toGeml) {
  const src = b.text.replace(/\n$/, "");
  const lines = src.split("\n");
  const m = FENCE.exec(lines[0] ?? "");
  if (!m) return undefined;
  const inner = m[3] ? parseAttrs(m[3]).id : undefined;
  if (!inner) return undefined;
  const last = lines[lines.length - 1].trimEnd();
  if (!((/^=+$/.test(last) && last.length === m[1].length) || LABELED_CLOSE.exec(last)?.[1] === inner)) return undefined;
  const paired = toGeml.get(b.id);
  if (paired !== undefined && paired !== b.id && paired !== inner) return undefined;
  if (ids[inner] !== undefined && ids[inner] !== b.id) return undefined;
  if (inner !== b.id) { ids[inner] = b.id; toGeml.set(b.id, inner); }
  return src;
}

// ---------------------------------------------------------------------------
// GEML → AnyBlock
// ---------------------------------------------------------------------------

/** Split a GEML document into top-level units: typed blocks, single heading
 *  lines, flow runs (paragraphs, lists). Blank lines separate. */
export function splitUnits(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const units = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const fo = FENCE.exec(line);
    if (fo) {
      const a = fo[3] ? parseAttrs(fo[3]) : { classes: [], attrs: {} };
      const id = a.id || undefined;
      const start = i;
      i++;
      while (i < lines.length) {
        const t = lines[i].trimEnd();
        const close = (/^=+$/.test(t) && t.length === fo[1].length) || (id !== undefined && LABELED_CLOSE.exec(t)?.[1] === id);
        i++;
        if (close) break;
      }
      const src = lines.slice(start, i);
      units.push({ kind: "fenced", type: fo[2], id, classes: a.classes ?? [], attrs: a.attrs ?? {}, body: src.slice(1, -1).join("\n"), source: src.join("\n") });
      continue;
    }
    if (HEADING.test(line)) {
      units.push({ kind: "heading", line });
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i].trim() !== "" && !FENCE.test(lines[i]) && !HEADING.test(lines[i])) i++;
    units.push({ kind: "flow", lines: lines.slice(start, i) });
  }
  return units;
}

/** GEML soft wraps join with a space; a backslash at line end is a line break. */
function joinLines(lines) {
  let s = "";
  lines.forEach((l, i) => {
    const t = i === 0 ? l : l.replace(/^[ \t]+/, "");
    if (i === 0) s = t;
    else s = s.endsWith("\\") ? `${s.slice(0, -1)}\n${t}` : `${s} ${t}`;
  });
  return s;
}

/** Flow lines → text blocks: one per paragraph, one per list item. */
function flowBlocks(lines, baseIndent) {
  const out = [];
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    out.push({ type: "paragraph", indent: baseIndent, text: para });
    para = [];
  };
  const stack = []; // marker columns of the open list levels
  let item;
  for (const raw of lines) {
    if (/^%%/.test(raw.trim())) continue;
    if (raw.trim() === "") { flushPara(); item = undefined; continue; }
    const m = ITEM.exec(raw);
    if (m) {
      flushPara();
      const col = m[1].replace(/\t/g, "    ").length;
      while (stack.length && stack[stack.length - 1] > col) stack.pop();
      if (!stack.length || stack[stack.length - 1] < col) stack.push(col);
      const depth = stack.length - 1;
      const task = TASK.exec(m[3]);
      item = task
        ? { type: "checkbox", indent: baseIndent + depth, checked: task[1] !== " ", text: [task[2]] }
        : { type: /\d/.test(m[2]) ? "numbered_list_item" : "bulleted_list_item", indent: baseIndent + depth, text: [m[3]] };
      out.push(item);
    } else if (item && /^\s/.test(raw)) {
      item.text.push(raw);
    } else {
      item = undefined;
      stack.length = 0;
      para.push(raw);
    }
  }
  flushPara();
  for (const b of out) b.text = joinLines(b.text);
  return out;
}

const indentOf = (classes) => {
  for (const c of classes) { const m = /^level-(\d+)$/.exec(c); if (m) return Math.max(0, Number(m[1]) - 1); }
  return 0;
};

function bodyComment(body) {
  const lines = body.split("\n");
  const m = COMMENT.exec(lines[0] ?? "");
  if (!m) return { extras: {}, rest: body };
  try { return { extras: JSON.parse(m[1]), rest: lines.slice(1).join("\n") }; } catch { return { extras: {}, rest: body }; }
}

/** AnyBlock's canonical form omits a default: indent 0, an unchecked box. */
function clean(b) {
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || (k === "indent" && v === 0) || (k === "checked" && v === false)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * GEML text → AnyBlock blocks (plus the `#object` envelope and the title).
 * Each block carries a `gid` (its GEML id, when it has one) and an `id` (the
 * Anytype id it maps to: the paired one, else the GEML id itself).
 * @param {string} text
 * @param {{ ids?: Record<string, string> }} [ctx] GEML id → Anytype id
 * @returns {{ envelope: object | undefined, title: string | undefined, blocks: object[] }}
 */
export function gemlToAny(text, ctx = {}) {
  const ids = ctx.ids ?? {};
  let envelope;
  let title;
  const blocks = [];
  const push = (gid, b) => blocks.push(clean({ ...b, id: gid ? (ids[gid] ?? gid) : undefined, gid }));
  for (const u of splitUnits(text)) {
    if (u.kind === "heading") {
      const m = HEADING.exec(u.line);
      let t = m[2];
      let gid;
      const hid = HEADING_ID.exec(t);
      if (hid && hid[2].includes("#")) { gid = parseAttrs(`{${hid[2]}}`).id || undefined; t = hid[1]; }
      if (m[1].length === 1 && title === undefined && !gid) { title = t; continue; }
      push(gid, { type: `heading_${Math.min(Math.max(m[1].length, 2), 4) - 1}`, text: t });
      continue;
    }
    if (u.kind === "flow") {
      for (const b of flowBlocks(u.lines, 0)) push(undefined, b);
      continue;
    }
    const indent = indentOf(u.classes);
    if (u.type === "data" && u.classes.includes("object")) {
      try { envelope = JSON.parse(u.body); } catch { /* an unreadable envelope is left out */ }
      continue;
    }
    if (u.type === "data" && u.classes.includes("anyblock")) {
      let parsed;
      try { parsed = JSON.parse(u.body); } catch { parsed = undefined; }
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") push(u.id, parsed);
      else push(u.id, { type: "code", indent, language: "geml", text: u.source });
      continue;
    }
    if (u.type === "text") {
      const { extras, rest } = bodyComment(u.body);
      if (u.classes.includes("file")) { push(u.id, { indent, ...extras }); continue; }
      const h = rest.split("\n").length === 1 ? HEADING.exec(rest) : null;
      if (h) {
        push(u.id, { type: `heading_${Math.min(Math.max(h[1].length, 2), 4) - 1}`, indent, text: h[2], ...extras });
        continue;
      }
      const inner = flowBlocks(rest.split("\n"), indent);
      if (!inner.length) inner.push({ type: "paragraph", indent, text: "" });
      inner.forEach((b, k) => (k === 0 ? push(u.id, { ...b, ...extras }) : push(undefined, b)));
      continue;
    }
    if (u.type === "note") {
      const { extras, rest } = bodyComment(u.body);
      const type = u.classes.includes("quote") ? "quote" : u.classes.includes("toggle") ? "toggle" : "callout";
      push(u.id, { type, indent, text: joinLines(rest.split("\n").filter((l) => l.trim() !== "")), ...extras });
      continue;
    }
    if (u.type === "code" && !u.attrs.src) { push(u.id, { type: "code", indent, language: u.attrs.lang, text: u.body }); continue; }
    if (u.type === "math") { push(u.id, { type: "embed", indent, processor: "latex", text: u.body }); continue; }
    if (u.type === "diagram" && DIAGRAMS.has(u.attrs.format) && !u.attrs.data) {
      push(u.id, { type: "embed", indent, processor: u.attrs.format, text: u.body });
      continue;
    }
    // GEML that Anytype has no shape for travels as its own source.
    push(u.id, { type: "code", indent, language: "geml", text: u.source });
  }
  return { envelope, title, blocks };
}
