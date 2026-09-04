// GEML reference parser — Milestone 2: inline content (§5).
//
// Parses the inline grammar of unfenced blocks (paragraphs, headings, list
// items): escapes, code spans, inline math, images, links, auto-references,
// footnote references, then emphasis/strong/strike — in the §5.3 priority order.
// Every internal/cross-document reference is reported to a `RefSink` so the
// document layer can resolve and validate it at build time (§8).

import { type Diagnostic } from "./diagnostics.js";
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
  // `value` and `base` are set only when the anchor is a GEP 0011 coordinate:
  // the projected text (which is what the reference SAYS) and the id that
  // holds it (which is where a link can go). A cell has no anchor of its own.
  | { type: "autoref"; anchor: string; doc?: string; value?: string; base?: string }
  // Inline projection: `![[doc.geml#id]]` renders the target block's body here.
  // `!` is the projection prefix — `![](src)` projects media, this projects
  // content — so the token means the same thing in every position.
  | { type: "project"; anchor: string; doc?: string; value?: string; base?: string }
  | { type: "footnote"; ref: string };

// A reference discovered during inline parsing, to be resolved by §8.
export interface Ref {
  // "internal": #anchor in this file; "cross": other.geml(#anchor)?;
  // "footnote": [^id]; "autoref": [[#id]] (internal) — all build-time checked.
  kind: "internal" | "cross" | "footnote" | "autoref";
  doc?: string;
  anchor?: string;
  line: number;
  // The inline node this reference came from, when there is one. A GEP 0011
  // coordinate is resolved by the same pass that checks it, and the answer has
  // to land somewhere a renderer can read: on the node.
  node?: Extract<Inline, { type: "autoref" | "project" }>;
}

export interface RefSink {
  refs: Ref[];
  // Transclusion targets, kept apart from `refs` because they need a second,
  // recursive pass: a transclusion can pull in another document's
  // transclusions, so cycle detection has to walk the graph. Optional so a
  // caller that only wants ids (gatherIds) need not supply it.
  embeds?: { doc: string; anchor?: string; line: number }[];
  // A media embed (`![](…)`) whose target is a GEML document. Reported by the
  // caller, not here: this module carries no diagnostic policy. Such a target
  // projected nothing, validated nothing and warned about nothing — the one shape
  // where reference rot stayed silent once `=== embed` existed.
  mediaDocTargets?: { src: string; line: number }[];
  // Inline projections, for the pass that checks each target is inline content.
  projections?: { doc?: string; anchor: string; line: number }[];
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
export function schemeOf(url: string): string | null {
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
export function isSafeUrl(url: string, allowDataImage = false): boolean {
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

// Partner index of every `[`/`(` in a string, or -1 where there is none: one
// stack pass instead of a fresh depth count per construct tried.
//
// Counting depth forward from each opener was quadratic, and every position that
// FAILS to be a link pays it: `[[`, `![`, `[^` or `[a](` repeated is 160 KB of
// input that took ~40 s to parse, since each of those tries readBracket (twice,
// for the `[[…]]` form) and each try rescanned the whole tail. A denial of
// service against anything that parses an untrusted document — which is the
// parser's whole job. The partner an opener gets here is exactly the one the
// forward count produced: an opener is popped by the first close at which the
// balance since it returns to zero, which is what the count measured.
interface Pairs {
  br: Int32Array;   // partner of `[` at absolute index k, or -1
  pa: Int32Array;   // partner of `(` at absolute index k, or -1
  off: number;      // absolute index of the current window's first character
}

function pairsOf(s: string): Pairs {
  const br = new Int32Array(s.length).fill(-1);
  const pa = new Int32Array(s.length).fill(-1);
  const bs: number[] = [], ps: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "[") bs.push(i);
    else if (c === "]") { const j = bs.pop(); if (j !== undefined) br[j] = i; }
    else if (c === "(") ps.push(i);
    else if (c === ")") { const j = ps.pop(); if (j !== undefined) pa[j] = i; }
  }
  return { br, pa, off: 0 };
}

// A link label is a bracket-balanced span, so the map restricted to it IS the
// map of the substring — the maps are built ONCE for the whole inline and read
// through an offset by every nesting level, rather than rebuilt per level (which
// at the 100-deep cap would have multiplied a 1 MB line's map memory by 100).
// A partner falling outside the window means "unbalanced here", which is what
// the substring-local scan reported.
function pairEnd(m: Int32Array, p: Pairs, s: string, i: number): number {
  const j = m[p.off + i];
  if (j === undefined || j < 0) return -1;
  const end = j - p.off;
  return end < s.length ? end : -1;
}

// Read a balanced `(...)` starting at s[i]==='('. Returns content and index
// just past the closing ')', or null if unbalanced.
function readParen(s: string, i: number, p: Pairs): { content: string; end: number } | null {
  if (s[i] !== "(") return null;
  const j = pairEnd(p.pa, p, s, i);
  return j < 0 ? null : { content: s.slice(i + 1, j), end: j + 1 };
}

// Read a balanced `[...]` starting at s[i]==='['. Returns content and index
// just past the closing ']', or null if unbalanced.
function readBracket(s: string, i: number, p: Pairs): { content: string; end: number } | null {
  if (s[i] !== "[") return null;
  const j = pairEnd(p.br, p, s, i);
  return j < 0 ? null : { content: s.slice(i + 1, j), end: j + 1 };
}

// Optional `{…}` attribute object immediately following a construct.
function readAttrs(s: string, i: number): { attrs: ReturnType<typeof parseAttrs>; end: number } | null {
  if (s[i] !== "{") return null;
  const close = s.indexOf("}", i);
  if (close < 0) return null;
  return { attrs: parseAttrs(s.slice(i, close + 1)), end: close + 1 };
}

// A phase-A atom in the phase-B sequence, carrying the first and last
// characters of the source span it consumed. Flanking (§5.3) is defined on
// source characters, so a delimiter run that borders an atom is judged against
// the atom's edge — `*` before `[link](x)` sees `[`, after it sees `)`, and a
// hard break's consumed `\n` counts as the whitespace it is.
type AtomPart = { node: Inline; first: string; last: string };

// Phase A: pull out high-priority atoms (escapes, code, math, media, links,
// auto-refs, footnotes, hard breaks). Everything else is left as text runs for
// phase B (emphasis). Children of links are fully re-parsed.
function scanAtoms(s: string, line: number, sink: RefSink, depth: number, p: Pairs): (string | AtomPart)[] {
  const out: (string | AtomPart)[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(buf); buf = ""; } };
  // Emit `node` as the atom occupying source span [start, end).
  const atom = (node: Inline, start: number, end: number) => {
    flush();
    out.push({ node, first: s[start]!, last: s[end - 1]! });
  };
  let i = 0;

  while (i < s.length) {
    const c = s[i]!;

    // §5.3(1): backslash escape / hard break.
    if (c === "\\") {
      const next = s[i + 1];
      if (next === undefined || next === "\n") { // line-final backslash
        const end = i + (next === undefined ? 1 : 2);
        atom({ type: "break" }, i, end);
        i = end;
        continue;
      }
      if (/[!-/:-@[-`{-~]/.test(next)) {
        // ASCII punctuation -> literal, emitted as its own text atom so phase B
        // (emphasis) cannot mistake an escaped `*`/`~` for a delimiter (§5.3(1)).
        atom({ type: "text", value: next }, i, i + 2);
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
        atom({ type: "code", value: s.slice(i + n, close) }, i, close + n);
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
        atom({ type: "math", value: s.slice(i + 1, close) }, i, close + 1);
        i = close + 1;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    // §5.3(2): image ![alt](src){…}.
    // §5.3 precedence: inline projection `![[…]]` is tried BEFORE the image atom.
    // Otherwise `![[#x]]` reads as an image whose label happens to be `[#x]`, and
    // `![[#x]](y)` would be claimed whole — the parenthesis run has to stay
    // literal text, which is what this ordering pins.
    if (c === "!" && s[i + 1] === "[" && s[i + 2] === "[") {
      const inner = readBracket(s, i + 2, p); // the inner [...] after `![`
      if (inner && s[inner.end] === "]") {
        const { doc, anchor } = classifyDest(inner.content.trim());
        if (anchor) {
          const node: Extract<Inline, { type: "project" }> = { type: "project", anchor };
          if (doc) node.doc = doc;
          atom(node, i, inner.end + 1);
          // Validated by the same §8 resolver as any reference; the target's TYPE
          // is checked separately, since only inline content can be projected.
          sink.refs.push({ kind: doc ? "cross" : "autoref", doc, anchor, line, node });
          (sink.projections ??= []).push(doc === undefined ? { anchor, line } : { doc, anchor, line });
          i = inner.end + 1;
          continue;
        }
      }
    }

    if (c === "!" && s[i + 1] === "[") {
      const label = readBracket(s, i + 1, p);
      const paren = label ? readParen(s, label.end, p) : null;
      if (label && paren) {
        const a = readAttrs(s, paren.end);
        const attrObj = a ? a.attrs : { classes: [], attrs: {} };
        // Media src bypasses classifyDest, so guard the scheme here: a disallowed
        // scheme (javascript:, data:text/html, …) is neutralized to an empty src
        // so the HTML sink cannot load/execute it. Relative paths, http(s), and
        // image/* data URIs pass through.
        const rawSrc = paren.content.trim();
        const src = isSafeUrl(rawSrc, true) ? rawSrc : "";
        // A GEML target here means the author wanted a transclusion, which is a
        // block: `=== embed`. Recorded for the caller to report.
        if (/\.geml(#|$)/i.test(src)) (sink.mediaDocTargets ??= []).push({ src, line });
        const node: Extract<Inline, { type: "image" }> = {
          type: "image", alt: label.content, src, attrs: attrObj.attrs,
        };
        const as = attrObj.attrs["as"];
        if (typeof as === "string") node.as = as;
        else { const inf = inferAs(node.src); if (inf) node.as = inf; }
        atom(node, i, a ? a.end : paren.end);
        i = a ? a.end : paren.end;
        continue;
      }
    }

    // §5.3(2): auto-reference [[#id]].
    if (c === "[" && s[i + 1] === "[") {
      const inner = readBracket(s, i + 1, p); // inner [...] after the first [
      if (inner && s[inner.end] === "]") {
        const target = inner.content.trim();
        const { doc, anchor } = classifyDest(target);
        if (anchor) {
          const node: Extract<Inline, { type: "autoref" }> = { type: "autoref", anchor };
          if (doc) node.doc = doc;
          atom(node, i, inner.end + 1);
          sink.refs.push({ kind: doc ? "cross" : "autoref", doc, anchor, line, node });
          i = inner.end + 1;
          continue;
        }
      }
    }

    // §5.3(2): footnote reference [^id].
    if (c === "[" && s[i + 1] === "^") {
      const br = readBracket(s, i, p);
      if (br && br.content.startsWith("^")) {
        const ref = br.content.slice(1).trim();
        atom({ type: "footnote", ref }, i, br.end);
        sink.refs.push({ kind: "footnote", anchor: ref, line });
        i = br.end;
        continue;
      }
    }

    // §5.3(2): link [text](dest){…}.
    if (c === "[") {
      const label = readBracket(s, i, p);
      const paren = label ? readParen(s, label.end, p) : null;
      if (label && paren) {
        const a = readAttrs(s, paren.end);
        const attrObj = a ? a.attrs : { classes: [], attrs: {} };
        const dest = classifyDest(paren.content);
        const node: Extract<Inline, { type: "link" }> = {
          type: "link",
          // The label window starts one character past this `[`, so the shared
          // maps are read at that offset instead of being rebuilt for it.
          children: parseInline(label.content, line, sink, depth + 1, { br: p.br, pa: p.pa, off: p.off + i + 1 }),
          attrs: attrObj.attrs,
        };
        if (dest.href) node.href = dest.href;
        if (dest.doc) node.doc = dest.doc;
        if (dest.anchor) node.anchor = dest.anchor;
        if (dest.anchor || dest.doc) {
          sink.refs.push({ kind: dest.doc ? "cross" : "internal", doc: dest.doc, anchor: dest.anchor, line });
        }
        atom(node, i, a ? a.end : paren.end);
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

// Phase B: emphasis / strong / strikethrough over the whole inline sequence
// (§5.3, GEP-0007).
//
// A maximal run of `*` in literal text is an emphasis delimiter (one `*` ->
// emphasis, two -> strong, longer runs pair greedily); a maximal run of two or
// more `~` is a strikethrough delimiter (a lone `~` is literal). Whether a run
// may *open* and/or *close* is fixed by flanking: it must hug a non-space
// character, and on the side facing a punctuation character it must also have
// whitespace or punctuation on the far side (the CommonMark left/right-flanking
// rule). Runs are then paired by a single left-to-right stack scan with the
// rule of three, so nested and adjacent delimiters resolve to exactly one tree
// — no leftmost-regex guesswork. Delimiters pair across phase-A atoms — a pair
// may wrap a code span, math, a link or image — but the atoms themselves are
// opaque: characters inside one are never delimiters, and at an atom boundary
// the flanking test reads the atom's edge source characters (AtomPart). A
// delimiter run never pairs across a block boundary, and any run left unpaired
// is literal text.

// Unicode punctuation, not just ASCII (§5.3). With an ASCII-only test, `“` and
// `，` count as ordinary letters, and a run hugged by CJK punctuation on the
// outside and ASCII punctuation on the inside stops flanking: `“*(foo)*”` loses
// its emphasis. CommonMark's rule is Unicode-wide, and the algorithm here is
// meant to be that rule restricted to `*` and `~~` — not a narrower one.
const PUNCT = /[\p{P}\p{S}]/u;
const isPunct = (c: string | undefined): boolean => c !== undefined && PUNCT.test(c);
const isWS = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

// A delimiter run. Beyond its place in the main list, a delimiter carries a
// SECOND pair of links (`dprev`/`dnext`) threading the delimiters to each other
// and a monotone position `idx`. Both exist for processEmphasis's opener search:
// it must step delimiter-to-delimiter in O(1) rather than walking the text /
// atom / wrap nodes lying between them, and its `bottom` cut-off must be
// comparable even after the delimiter it named has been consumed. Without the
// two, the search degrades to O(n^2) over the delimiter count.
interface DNode {
  t: "delim"; ch: "*" | "~"; n: number; open: boolean; close: boolean;
  idx: number; dprev: DNode | null; dnext: DNode | null;
  prev: ENode | null; next: ENode | null;
}
type ENode =
  | { t: "text"; v: string; prev: ENode | null; next: ENode | null }
  | DNode
  | { t: "atom"; node: Inline; prev: ENode | null; next: ENode | null }
  | { t: "wrap"; kind: "emph" | "strong" | "strike"; kids: ENode | null; prev: ENode | null; next: ENode | null };

// Left/right-flanking for a delimiter run, given the chars on either side.
function flank(before: string | undefined, after: string | undefined): { open: boolean; close: boolean } {
  const bWS = isWS(before), aWS = isWS(after), bP = isPunct(before), aP = isPunct(after);
  return { open: !aWS && (!aP || bWS || bP), close: !bWS && (!bP || aWS || aP) };
}

// Split the mixed phase-A sequence into a doubly-linked list of text,
// delimiter-run, and atom nodes. A delimiter run at the edge of a text part
// flanks against the neighboring part's edge character — an atom's recorded
// source edge, or the adjacent char of a neighboring text part — and against
// nothing (whitespace) at the ends of the sequence.
function tokenizeRuns(parts: (string | AtomPart)[]): { head: ENode | null; first: DNode | null } {
  let head: ENode | null = null, tail: ENode | null = null;
  const push = (node: ENode) => { node.prev = tail; if (tail) tail.next = node; else head = node; tail = node; };
  // …and thread every delimiter onto the delimiter-only chain as it is pushed.
  let dhead: DNode | null = null, dtail: DNode | null = null, dn = 0;
  const pushDelim = (d: DNode) => {
    d.idx = dn++;
    d.dprev = dtail;
    if (dtail) dtail.dnext = d; else dhead = d;
    dtail = d;
    push(d);
  };
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k]!;
    if (typeof part !== "string") {
      push({ t: "atom", node: part.node, prev: null, next: null });
      continue;
    }
    const s = part;
    // A text part's neighbors are always atoms (or the sequence edge):
    // scanAtoms flushes buffered text exactly when it emits an atom, so two
    // text parts are never adjacent.
    const before0 = k > 0 ? (parts[k - 1] as AtomPart).last : undefined;
    const after0 = k + 1 < parts.length ? (parts[k + 1] as AtomPart).first : undefined;
    let i = 0;
    while (i < s.length) {
      const c = s[i]!;
      if (c === "*" || c === "~") {
        let j = i; while (s[j] === c) j++;
        const n = j - i;
        if (c === "~" && n < 2) push({ t: "text", v: "~", prev: null, next: null });
        else {
          const f = flank(i > 0 ? s[i - 1] : before0, j < s.length ? s[j] : after0);
          pushDelim({ t: "delim", ch: c, n, open: f.open, close: f.close, idx: 0, dprev: null, dnext: null, prev: null, next: null });
        }
        i = j;
      } else {
        let j = i; while (j < s.length && s[j] !== "*" && s[j] !== "~") j++;
        push({ t: "text", v: s.slice(i, j), prev: null, next: null });
        i = j;
      }
    }
  }
  return { head, first: dhead };
}

// Rule of three: when either side can also play the other role, a combined
// length that is a multiple of three is only allowed if both lengths are.
function rule3(o: Extract<ENode, { t: "delim" }>, c: Extract<ENode, { t: "delim" }>): boolean {
  if (o.close || c.open) return (o.n + c.n) % 3 !== 0 || (o.n % 3 === 0 && c.n % 3 === 0);
  return true;
}

// Drop a delimiter from the delimiter-only chain. Called for a spent delimiter
// and for every delimiter that a new wrap swallows: the chain must hold exactly
// the delimiters still pairable AT THIS LEVEL, or an opener search would reach
// inside a finished span and splice its own list.
function unlinkDelim(d: DNode): void {
  if (d.dprev) d.dprev.dnext = d.dnext;
  if (d.dnext) d.dnext.dprev = d.dprev;
  d.dprev = null; d.dnext = null;
}

function unlink(node: ENode, head: ENode): ENode {
  if (node.prev) node.prev.next = node.next; else head = node.next!;
  if (node.next) node.next.prev = node.prev;
  if (node.t === "delim") unlinkDelim(node);
  return head;
}

// The CommonMark emphasis algorithm over the delimiter list: scan closers left
// to right, pair each with the nearest eligible opener, wrap the span, and bound
// future searches with `bottom` so the scan stays linear and deterministic.
function processEmphasis(head: ENode, first: DNode | null): ENode {
  // The cut-off is a delimiter POSITION, not a node: the delimiter it names can
  // be consumed and unlinked later on, and a stale node reference would then
  // never be reached — the search would run to the head of the list every time,
  // which is the O(n^2) blowup this map exists to prevent. -1 means "no bound
  // yet" (the whole prefix is searchable), matching an unset entry.
  const bottom = new Map<string, number>();
  let closer = first;
  while (closer) {
    // A `~` run pairs TWO characters at a time, so one leftover character is no
    // longer a delimiter — exactly as a lone `~` was never one (tokenizeRuns).
    // Skipping it here is what keeps `n` from going negative: pairing a spent run
    // again drove `n` past 0, and since the loop only advances on `n === 0` the
    // same closer was re-paired forever, allocating a wrap each time (a hang on
    // `~~~a~~~`) or reaching finalize with n = -1 (`"~".repeat(-1)` threw a
    // RangeError on `~~~~a~~~`).
    if (!closer.close || (closer.ch === "~" && closer.n < 2)) { closer = closer.dnext; continue; }
    const ch = closer.ch;
    const key = `${ch}${closer.open ? 1 : 0}${closer.n % 3}`;
    const stop = bottom.get(key) ?? -1;

    let opener = closer.dprev;
    let found: DNode | null = null;
    while (opener && opener.idx > stop) {
      // …and the same for the opener side: a `~` run down to one character can
      // no longer open, so `use = 2` never takes more than a side has left.
      if (opener.open && opener.ch === ch && (ch !== "~" || opener.n >= 2) && rule3(opener, closer)) { found = opener; break; }
      opener = opener.dprev;
    }

    if (found) {
      const use = ch === "~" ? 2 : (found.n >= 2 && closer.n >= 2 ? 2 : 1);
      const kind = ch === "~" ? "strike" : use === 2 ? "strong" : "emph";
      // Gather and detach the nodes strictly between opener and closer. Any
      // delimiter among them is now inside the new span — unpaired and literal —
      // so it leaves the delimiter chain with them.
      let kidsHead: ENode | null = null, kidsTail: ENode | null = null;
      for (let p = found.next; p && p !== closer; ) {
        const q = p.next;
        if (p.t === "delim") unlinkDelim(p);
        p.prev = kidsTail; p.next = null;
        if (kidsTail) kidsTail.next = p; else kidsHead = p;
        kidsTail = p; p = q;
      }
      const wrap: ENode = { t: "wrap", kind, kids: kidsHead, prev: found, next: closer };
      found.next = wrap; closer.prev = wrap;
      found.n -= use; closer.n -= use;
      if (found.n === 0) head = unlink(found, head);
      if (closer.n === 0) { const after = closer.dnext; head = unlink(closer, head); closer = after; }
      // else: keep the same closer (it still has delimiter characters left).
    } else {
      // Nothing before this closer can open for this key, so no later closer
      // with the same key need look past the delimiter just before it either.
      bottom.set(key, closer.dprev ? closer.dprev.idx : -1);
      closer = closer.dnext;
    }
  }
  return head;
}

// Linked list of (possibly nested) nodes -> Inline[]; unpaired delimiters and
// empty text vanish into literal text, with adjacent text runs merged. An
// escaped-punctuation atom is a text Inline, so it folds into its neighbors —
// the emitted sequence is canonical with no adjacent text nodes at any level.
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
    else if (n.t === "atom") { if (n.node.type === "text") pushText(n.node.value); else out.push(n.node); }
    else out.push({ type: n.kind, children: finalize(n.kids) } as Inline);
  }
  return out;
}

function emphasize(parts: (string | AtomPart)[]): Inline[] {
  const { head, first } = tokenizeRuns(parts);
  return head ? finalize(processEmphasis(head, first)) : [];
}

// `pairs` is internal: the bracket/paren partner maps of the WHOLE inline, with
// the offset of this call's window into them. Only the recursive link-label call
// supplies it; every external caller omits it and gets the maps built here.
export function parseInline(s: string, line: number, sink: RefSink, depth = 0, pairs?: Pairs): Inline[] {
  if (depth > MAX_INLINE_NESTING) {
    // Pathological nesting (thousands of nested link labels) would overflow the
    // call stack (R2-7). Degrade the over-deep content to text — emphasis only,
    // no further link recursion — and flag it; never throw RangeError.
    const diags = (sink as unknown as { diags?: Diagnostic[] }).diags;
    if (Array.isArray(diags) && !diags.some((d) => d.code === "inline-nesting-too-deep"))
      diags.push({ severity: "error", code: "inline-nesting-too-deep", message: `inline nesting too deep (max ${MAX_INLINE_NESTING})`, line });
    return emphasize([s]);
  }
  return emphasize(scanAtoms(s, line, sink, depth, pairs ?? pairsOf(s)));
}
