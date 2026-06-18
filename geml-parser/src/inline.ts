// GEML reference parser — Milestone 2: inline content (§5).
//
// Parses the inline grammar of flow blocks (paragraphs, headings, list items):
// escapes, code spans, inline math, images, links, auto-references, footnote
// references, then emphasis/strong/strike — in the §5.3 priority order. Every
// internal/cross-document reference is reported to a `RefSink` so the document
// layer can resolve and validate it at build time (§8).

import { type Value, parseAttrs } from "./attrs.js";

export type Inline =
  | { type: "text"; value: string }
  | { type: "emph"; children: Inline[] }
  | { type: "strong"; children: Inline[] }
  | { type: "strike"; children: Inline[] }
  | { type: "code"; value: string }
  | { type: "math"; value: string }
  | { type: "break" }
  | { type: "image"; alt: string; src: string; as?: string; attrs: Record<string, Value> }
  | {
      type: "link";
      children: Inline[];
      href?: string;        // external target (scheme://… or mailto:)
      doc?: string;         // cross-document target (other.geml)
      anchor?: string;      // block id within doc (or this file when doc absent)
      attrs: Record<string, Value>;
    }
  | { type: "autoref"; anchor: string; doc?: string }
  | { type: "footnote"; ref: string };

// A reference discovered during inline parsing, to be resolved by §8.
export interface Ref {
  // "internal": #anchor in this file; "cross": other.geml(#anchor)?;
  // "footnote": [^id]; "autoref": [[#id]] (internal) — all build-time checked.
  kind: "internal" | "cross" | "footnote" | "autoref";
  doc?: string;
  anchor?: string;
  line: number;
}

export interface RefSink {
  refs: Ref[];
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i; // http:, https:, mailto:, …

// §5.1: when `as` is omitted, infer the media kind from the source extension.
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv|mkv)(?:[?#].*)?$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus)(?:[?#].*)?$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?)(?:[?#].*)?$/i;
function inferAs(src: string): "image" | "audio" | "video" | undefined {
  if (VIDEO_EXT.test(src)) return "video";
  if (AUDIO_EXT.test(src)) return "audio";
  if (IMAGE_EXT.test(src)) return "image";
  return undefined;
}

// Classify a link/image destination into {href|doc, anchor}.
function classifyDest(dest: string): { href?: string; doc?: string; anchor?: string } {
  const d = dest.trim();
  if (SCHEME.test(d)) return { href: d };
  const hash = d.indexOf("#");
  if (hash === 0) return { anchor: d.slice(1) };
  if (hash > 0) return { doc: d.slice(0, hash), anchor: d.slice(hash + 1) };
  if (d) return { doc: d };
  return {};
}

// Read a balanced `(...)` starting at s[i]==='('. Returns content and index
// just past the closing ')', or null if unbalanced.
function readParen(s: string, i: number): { content: string; end: number } | null {
  if (s[i] !== "(") return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { content: s.slice(i + 1, j), end: j + 1 };
    }
  }
  return null;
}

// Read a balanced `[...]` starting at s[i]==='['. Returns content and index
// just past the closing ']', or null if unbalanced.
function readBracket(s: string, i: number): { content: string; end: number } | null {
  if (s[i] !== "[") return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return { content: s.slice(i + 1, j), end: j + 1 };
    }
  }
  return null;
}

// Optional `{…}` attribute object immediately following a construct.
function readAttrs(s: string, i: number): { attrs: ReturnType<typeof parseAttrs>; end: number } | null {
  if (s[i] !== "{") return null;
  const close = s.indexOf("}", i);
  if (close < 0) return null;
  return { attrs: parseAttrs(s.slice(i, close + 1)), end: close + 1 };
}

// Phase A: pull out high-priority atoms (escapes, code, math, media, links,
// auto-refs, footnotes, hard breaks). Everything else is left as text runs for
// phase B (emphasis). Children of links are fully re-parsed.
function scanAtoms(s: string, line: number, sink: RefSink): (string | Inline)[] {
  const out: (string | Inline)[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(buf); buf = ""; } };
  let i = 0;

  while (i < s.length) {
    const c = s[i]!;

    // §5.3(1): backslash escape / hard break.
    if (c === "\\") {
      const next = s[i + 1];
      if (next === undefined || next === "\n") { // line-final backslash
        flush();
        out.push({ type: "break" });
        i += next === undefined ? 1 : 2;
        continue;
      }
      if (/[!-/:-@[-`{-~]/.test(next)) { // ASCII punctuation -> literal
        buf += next;
        i += 2;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    // §5.3(1): code span — matched by run length, content kept raw.
    if (c === "`") {
      let n = 0;
      while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const close = s.indexOf(fence, i + n);
      if (close >= 0) {
        flush();
        out.push({ type: "code", value: s.slice(i + n, close) });
        i = close + n;
        continue;
      }
      buf += fence;
      i += n;
      continue;
    }

    // §5.3(1): inline math $…$ (raw).
    if (c === "$") {
      const close = s.indexOf("$", i + 1);
      if (close > i + 1) {
        flush();
        out.push({ type: "math", value: s.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    // §5.3(2): image ![alt](src){…}.
    if (c === "!" && s[i + 1] === "[") {
      const label = readBracket(s, i + 1);
      const paren = label ? readParen(s, label.end) : null;
      if (label && paren) {
        const a = readAttrs(s, paren.end);
        const attrObj = a ? a.attrs : { classes: [], attrs: {} };
        const node: Extract<Inline, { type: "image" }> = {
          type: "image", alt: label.content, src: paren.content.trim(), attrs: attrObj.attrs,
        };
        const as = attrObj.attrs["as"];
        if (typeof as === "string") node.as = as;
        else { const inf = inferAs(node.src); if (inf) node.as = inf; }
        flush();
        out.push(node);
        i = a ? a.end : paren.end;
        continue;
      }
    }

    // §5.3(2): auto-reference [[#id]].
    if (c === "[" && s[i + 1] === "[") {
      const inner = readBracket(s, i + 1); // inner [...] after the first [
      if (inner && s[inner.end] === "]") {
        const target = inner.content.trim();
        const { doc, anchor } = classifyDest(target);
        if (anchor) {
          flush();
          const node: Extract<Inline, { type: "autoref" }> = { type: "autoref", anchor };
          if (doc) node.doc = doc;
          out.push(node);
          sink.refs.push({ kind: doc ? "cross" : "autoref", doc, anchor, line });
          i = inner.end + 1;
          continue;
        }
      }
    }

    // §5.3(2): footnote reference [^id].
    if (c === "[" && s[i + 1] === "^") {
      const br = readBracket(s, i);
      if (br && br.content.startsWith("^")) {
        const ref = br.content.slice(1).trim();
        flush();
        out.push({ type: "footnote", ref });
        sink.refs.push({ kind: "footnote", anchor: ref, line });
        i = br.end;
        continue;
      }
    }

    // §5.3(2): link [text](dest){…}.
    if (c === "[") {
      const label = readBracket(s, i);
      const paren = label ? readParen(s, label.end) : null;
      if (label && paren) {
        const a = readAttrs(s, paren.end);
        const attrObj = a ? a.attrs : { classes: [], attrs: {} };
        const dest = classifyDest(paren.content);
        const node: Extract<Inline, { type: "link" }> = {
          type: "link",
          children: parseInline(label.content, line, sink),
          attrs: attrObj.attrs,
        };
        if (dest.href) node.href = dest.href;
        if (dest.doc) node.doc = dest.doc;
        if (dest.anchor) node.anchor = dest.anchor;
        if (dest.anchor || dest.doc) {
          sink.refs.push({ kind: dest.doc ? "cross" : "internal", doc: dest.doc, anchor: dest.anchor, line });
        }
        flush();
        out.push(node);
        i = a ? a.end : paren.end;
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

// Phase B: emphasis / strong / strike on a plain text run (§5.3(3)). Strong and
// strike bind before emphasis; delimiters must hug non-space characters.
const EMPH_PATTERNS: { re: RegExp; type: "strong" | "strike" | "emph" }[] = [
  { re: /\*\*(\S(?:[\s\S]*?\S)?)\*\*/, type: "strong" },
  { re: /~~(\S(?:[\s\S]*?\S)?)~~/, type: "strike" },
  { re: /\*(\S(?:[\s\S]*?\S)?)\*/, type: "emph" },
];

function emphasize(text: string, line: number, sink: RefSink): Inline[] {
  let best: { idx: number; m: RegExpExecArray; type: "strong" | "strike" | "emph" } | null = null;
  for (const p of EMPH_PATTERNS) {
    const m = p.re.exec(text);
    if (m && (best === null || m.index < best.idx)) best = { idx: m.index, m, type: p.type };
  }
  if (!best) return text ? [{ type: "text", value: text }] : [];

  const { m, type } = best;
  const left = text.slice(0, m.index);
  const right = text.slice(m.index + m[0].length);
  const out: Inline[] = [];
  if (left) out.push({ type: "text", value: left });
  out.push({ type, children: emphasize(m[1]!, line, sink) } as Inline);
  out.push(...emphasize(right, line, sink));
  return out;
}

export function parseInline(s: string, line: number, sink: RefSink): Inline[] {
  const atoms = scanAtoms(s, line, sink);
  const out: Inline[] = [];
  for (const a of atoms) {
    if (typeof a === "string") out.push(...emphasize(a, line, sink));
    else out.push(a);
  }
  return out;
}
