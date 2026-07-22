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

const MAX_INLINE_NESTING = 100; // cap parseInline<->scanAtoms recursion (R2-7 DoS)

// §4: the source pattern of a `{{key}}` metadata reference. Owned here as the
// single definition of what a reference looks like — the parser substitutes it
// (geml.ts), the serializer escapes it on emit (serialize.ts), and the md
// converter escapes it on conversion (from-md.ts). Build flagged variants with
// `new RegExp(META_REF_SRC, flags)`.
export const META_REF_SRC = "\\{\\{\\s*([A-Za-z_][A-Za-z0-9_-]*)\\s*\\}\\}";

// §5: URL schemes that may be emitted as an href/src. A destination that names
// any other scheme (javascript:, vbscript:, data:text/html, file:, …) is a
// script-injection / local-read vector at the HTML sink, so it is neutralized
// here at the parse layer — every consumer of the model inherits the guard.
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

// The leading `scheme:` (RFC-3986 grammar), lowercased — or null when the
// destination has none (a relative path, `#anchor`, or cross-document ref).
function schemeOf(url: string): string | null {
  // Browsers strip leading/embedded C0 controls and spaces before acting on a
  // URL, so `java\tscript:` and `\x01javascript:` execute as javascript:. Strip
  // every [\x00-\x20] before detecting the scheme so the allowlist can't be
  // evaded that way (R2-2).
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.replace(/[\x00-\x20]/g, ""));
  return m ? m[1]!.toLowerCase() : null;
}

// A destination is safe to emit when it has no scheme (relative / anchor /
// cross-doc), or names an allowlisted scheme. `data:` is permitted only for
// media and only for `image/*` payloads (never `data:text/html`, which scripts).
function isSafeUrl(url: string, allowDataImage = false): boolean {
  const scheme = schemeOf(url);
  if (scheme === null) return true;
  if (SAFE_SCHEMES.has(scheme)) return true;
  if (allowDataImage && scheme === "data") return /^\s*data:image\//i.test(url);
  return false;
}

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
  if (schemeOf(d) !== null) {
    // Scheme-bearing destination: emit as an href only if the scheme is
    // allowlisted; otherwise drop it entirely so the link renders inert
    // (render() defaults a hrefless link to `#`, keeping the visible text).
    return isSafeUrl(d) ? { href: d } : {};
  }
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
function scanAtoms(s: string, line: number, sink: RefSink, depth = 0): (string | Inline)[] {
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
      if (/[!-/:-@[-`{-~]/.test(next)) {
        // ASCII punctuation -> literal, emitted as its own text atom so phase B
        // (emphasis) cannot mistake an escaped `*`/`~` for a delimiter (§5.3(1)).
        flush();
        out.push({ type: "text", value: next });
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
        // Media src bypasses classifyDest, so guard the scheme here: a disallowed
        // scheme (javascript:, data:text/html, …) is neutralized to an empty src
        // so the HTML sink cannot load/execute it. Relative paths, http(s), and
        // image/* data URIs pass through.
        const rawSrc = paren.content.trim();
        const src = isSafeUrl(rawSrc, true) ? rawSrc : "";
        const node: Extract<Inline, { type: "image" }> = {
          type: "image", alt: label.content, src, attrs: attrObj.attrs,
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
          children: parseInline(label.content, line, sink, depth + 1),
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

// Phase B: emphasis / strong / strikethrough on a plain text run (§5.3).
//
// A maximal run of `*` is an emphasis delimiter (one `*` -> emphasis, two ->
// strong, longer runs pair greedily); a maximal run of two or more `~` is a
// strikethrough delimiter (a lone `~` is literal). Whether a run may *open*
// and/or *close* is fixed by flanking: it must hug a non-space character, and on
// the side facing a punctuation character it must also have whitespace or
// punctuation on the far side (the CommonMark left/right-flanking rule). Runs are
// then paired by a single left-to-right stack scan with the rule of three, so
// nested and adjacent delimiters resolve to exactly one tree — no leftmost-regex
// guesswork. Delimiters pair only *within* one text run: they never reach across
// a code span, inline math, a link or image (atoms from phase A), or a block
// boundary. Any delimiter left unpaired is literal text.

const ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;
const isPunct = (c: string | undefined): boolean => c !== undefined && ASCII_PUNCT.test(c);
const isWS = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

type ENode =
  | { t: "text"; v: string; prev: ENode | null; next: ENode | null }
  | { t: "delim"; ch: "*" | "~"; n: number; open: boolean; close: boolean; prev: ENode | null; next: ENode | null }
  | { t: "wrap"; kind: "emph" | "strong" | "strike"; kids: ENode | null; prev: ENode | null; next: ENode | null };

// Left/right-flanking for a delimiter run, given the chars on either side.
function flank(before: string | undefined, after: string | undefined): { open: boolean; close: boolean } {
  const bWS = isWS(before), aWS = isWS(after), bP = isPunct(before), aP = isPunct(after);
  return { open: !aWS && (!aP || bWS || bP), close: !bWS && (!bP || aWS || aP) };
}

// Split a text run into a doubly-linked list of text and delimiter-run nodes.
function tokenizeRuns(s: string): ENode | null {
  let head: ENode | null = null, tail: ENode | null = null;
  const push = (node: ENode) => { node.prev = tail; if (tail) tail.next = node; else head = node; tail = node; };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "*" || c === "~") {
      let j = i; while (s[j] === c) j++;
      const n = j - i;
      if (c === "~" && n < 2) push({ t: "text", v: "~", prev: null, next: null });
      else {
        const f = flank(i > 0 ? s[i - 1] : undefined, j < s.length ? s[j] : undefined);
        push({ t: "delim", ch: c, n, open: f.open, close: f.close, prev: null, next: null });
      }
      i = j;
    } else {
      let j = i; while (j < s.length && s[j] !== "*" && s[j] !== "~") j++;
      push({ t: "text", v: s.slice(i, j), prev: null, next: null });
      i = j;
    }
  }
  return head;
}

const nextDelim = (n: ENode | null): ENode | null => { for (; n; n = n.next) if (n.t === "delim") return n; return null; };
const prevDelim = (n: ENode | null): ENode | null => { for (; n; n = n.prev) if (n.t === "delim") return n; return null; };

// Rule of three: when either side can also play the other role, a combined
// length that is a multiple of three is only allowed if both lengths are.
function rule3(o: Extract<ENode, { t: "delim" }>, c: Extract<ENode, { t: "delim" }>): boolean {
  if (o.close || c.open) return (o.n + c.n) % 3 !== 0 || (o.n % 3 === 0 && c.n % 3 === 0);
  return true;
}

function unlink(node: ENode, head: ENode): ENode {
  if (node.prev) node.prev.next = node.next; else head = node.next!;
  if (node.next) node.next.prev = node.prev;
  return head;
}

// The CommonMark emphasis algorithm over the delimiter list: scan closers left
// to right, pair each with the nearest eligible opener, wrap the span, and bound
// future searches with `bottom` so the scan stays linear and deterministic.
function processEmphasis(head: ENode): ENode {
  const bottom = new Map<string, ENode | null>();
  let closer = nextDelim(head);
  while (closer) {
    if (closer.t !== "delim" || !closer.close) { closer = nextDelim(closer.next); continue; }
    const ch = closer.ch;
    const key = `${ch}${closer.open ? 1 : 0}${closer.n % 3}`;
    const stop = bottom.has(key) ? bottom.get(key)! : null;

    let opener = prevDelim(closer.prev);
    let found: Extract<ENode, { t: "delim" }> | null = null;
    while (opener && opener !== stop) {
      if (opener.t === "delim" && opener.open && opener.ch === ch && rule3(opener, closer)) { found = opener; break; }
      opener = prevDelim(opener.prev);
    }

    if (found) {
      const use = ch === "~" ? 2 : (found.n >= 2 && closer.n >= 2 ? 2 : 1);
      const kind = ch === "~" ? "strike" : use === 2 ? "strong" : "emph";
      // Gather and detach the nodes strictly between opener and closer.
      let kidsHead: ENode | null = null, kidsTail: ENode | null = null;
      for (let p = found.next; p && p !== closer; ) {
        const q = p.next;
        p.prev = kidsTail; p.next = null;
        if (kidsTail) kidsTail.next = p; else kidsHead = p;
        kidsTail = p; p = q;
      }
      const wrap: ENode = { t: "wrap", kind, kids: kidsHead, prev: found, next: closer };
      found.next = wrap; closer.prev = wrap;
      found.n -= use; closer.n -= use;
      if (found.n === 0) head = unlink(found, head);
      if (closer.n === 0) { const after = closer.next; head = unlink(closer, head); closer = nextDelim(after); }
      // else: keep the same closer (it still has delimiter characters left).
    } else {
      bottom.set(key, closer.prev);
      closer = nextDelim(closer.next);
    }
  }
  return head;
}

// Linked list of (possibly nested) nodes -> Inline[]; unpaired delimiters and
// empty text vanish into literal text, with adjacent text runs merged.
function finalize(head: ENode | null): Inline[] {
  const out: Inline[] = [];
  const pushText = (v: string) => {
    const last = out[out.length - 1];
    if (last && last.type === "text") last.value += v;
    else if (v) out.push({ type: "text", value: v });
  };
  for (let n = head; n; n = n.next) {
    if (n.t === "text") pushText(n.v);
    else if (n.t === "delim") pushText(n.ch.repeat(n.n));
    else out.push({ type: n.kind, children: finalize(n.kids) } as Inline);
  }
  return out;
}

function emphasize(text: string): Inline[] {
  const head = tokenizeRuns(text);
  return head ? finalize(processEmphasis(head)) : [];
}

// Coalesce adjacent literal text nodes (e.g. an escaped `*` atom sitting between
// two text runs) so the inline sequence is canonical.
function mergeText(ns: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of ns) {
    const last = out[out.length - 1];
    if (n.type === "text" && last && last.type === "text") last.value += n.value;
    else out.push(n);
  }
  return out;
}

export function parseInline(s: string, line: number, sink: RefSink, depth = 0): Inline[] {
  if (depth > MAX_INLINE_NESTING) {
    // Pathological nesting (thousands of nested link labels) would overflow the
    // call stack (R2-7). Degrade the over-deep content to text — emphasis only,
    // no further link recursion — and flag it; never throw RangeError.
    const diags = (sink as unknown as { diags?: { severity: string; message: string; line: number }[] }).diags;
    if (Array.isArray(diags) && !diags.some((d) => d.message.startsWith("inline nesting too deep")))
      diags.push({ severity: "error", message: `inline nesting too deep (max ${MAX_INLINE_NESTING})`, line });
    return mergeText(emphasize(s));
  }
  const atoms = scanAtoms(s, line, sink, depth);
  const out: Inline[] = [];
  for (const a of atoms) {
    if (typeof a === "string") out.push(...emphasize(a));
    else out.push(a);
  }
  return mergeText(out);
}
