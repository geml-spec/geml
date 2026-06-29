// A SECOND, INDEPENDENT GEML implementation — clean-room, written only from the
// spec (GEML-spec.md §2.1 lists, §3.1 grammar, §5.3 emphasis). It imports NOTHING
// from the reference parser (../../dist). It builds the spec document model for
// the flow-block and inline subset the conformance suite exercises, so the shared
// projection (_project.mjs) can compare it, case for case, against the reference.
//
// Its agreement with the reference across the whole suite is the acceptance test
// for "the spec is precise enough that two implementations cannot diverge."

// ---------------------------------------------------------------------------
// Inline — §5.3
// ---------------------------------------------------------------------------

const PUNCT = /[!-\/:-@\[-`{-~]/;
const isPunct = (c) => c !== undefined && PUNCT.test(c);
const isSpace = (c) => c === undefined || /\s/.test(c);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function readBracket(s, i) {
  if (s[i] !== "[") return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "[") depth++;
    else if (s[j] === "]" && --depth === 0) return { content: s.slice(i + 1, j), end: j + 1 };
  }
  return null;
}
function readParen(s, i) {
  if (s[i] !== "(") return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")" && --depth === 0) return { content: s.slice(i + 1, j), end: j + 1 };
  }
  return null;
}
const skipAttrs = (s, i) => (s[i] === "{" ? (s.indexOf("}", i) < 0 ? i : s.indexOf("}", i) + 1) : i);

function classify(dest) {
  const d = dest.trim();
  if (SCHEME.test(d)) return { href: d };
  const h = d.indexOf("#");
  if (h === 0) return { anchor: d.slice(1) };
  if (h > 0) return { doc: d.slice(0, h), anchor: d.slice(h + 1) };
  if (d) return { doc: d };
  return {};
}

// Phase 1: pull out atoms (escapes, code, math, image, auto-ref, footnote, link);
// everything else is left as literal-text strings for phase 2.
function atoms(s) {
  const out = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(buf); buf = ""; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const nx = s[i + 1];
      if (nx === undefined || nx === "\n") { flush(); out.push({ type: "break" }); i += nx === undefined ? 1 : 2; continue; }
      if (PUNCT.test(nx)) { flush(); out.push({ type: "text", value: nx }); i += 2; continue; }
      buf += c; i++; continue;
    }
    if (c === "`") {
      let n = 0; while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const close = s.indexOf(fence, i + n);
      if (close >= 0) { flush(); out.push({ type: "code", value: s.slice(i + n, close) }); i = close + n; continue; }
      buf += fence; i += n; continue;
    }
    if (c === "$") {
      const close = s.indexOf("$", i + 1);
      if (close > i + 1) { flush(); out.push({ type: "math", value: s.slice(i + 1, close) }); i = close + 1; continue; }
      buf += c; i++; continue;
    }
    if (c === "!" && s[i + 1] === "[") {
      const lab = readBracket(s, i + 1);
      const par = lab ? readParen(s, lab.end) : null;
      if (lab && par) { flush(); out.push({ type: "image", src: par.content.trim() }); i = skipAttrs(s, par.end); continue; }
    }
    if (c === "[" && s[i + 1] === "[") {
      const inner = readBracket(s, i + 1);
      if (inner && s[inner.end] === "]") {
        const d = classify(inner.content.trim());
        if (d.anchor) { flush(); const node = { type: "autoref", anchor: d.anchor }; if (d.doc) node.doc = d.doc; out.push(node); i = inner.end + 1; continue; }
      }
    }
    if (c === "[" && s[i + 1] === "^") {
      const br = readBracket(s, i);
      if (br && br.content.startsWith("^")) { flush(); out.push({ type: "footnote", ref: br.content.slice(1).trim() }); i = br.end; continue; }
    }
    if (c === "[") {
      const lab = readBracket(s, i);
      const par = lab ? readParen(s, lab.end) : null;
      if (lab && par) {
        const d = classify(par.content);
        const node = { type: "link", children: inline(lab.content) };
        if (d.href) node.href = d.href;
        if (d.doc) node.doc = d.doc;
        if (d.anchor) node.anchor = d.anchor;
        flush(); out.push(node); i = skipAttrs(s, par.end); continue;
      }
    }
    buf += c; i++;
  }
  flush();
  return out;
}

// Phase 2: emphasis / strong / strikethrough over a literal text run, by
// delimiter-run flanking with the rule of three (§5.3). Linked-list of nodes.
function emphasis(text) {
  const list = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "*" || c === "~") {
      let j = i; while (text[j] === c) j++;
      const n = j - i;
      if (c === "~" && n < 2) { list.push({ k: "t", v: "~".repeat(n) }); i = j; continue; }
      const before = i > 0 ? text[i - 1] : undefined, after = j < text.length ? text[j] : undefined;
      const bws = isSpace(before), aws = isSpace(after), bp = isPunct(before), ap = isPunct(after);
      list.push({ k: "d", ch: c, n, open: !aws && (!ap || bws || bp), close: !bws && (!bp || aws || ap) });
      i = j;
    } else {
      let j = i; while (j < text.length && text[j] !== "*" && text[j] !== "~") j++;
      list.push({ k: "t", v: text.slice(i, j) });
      i = j;
    }
  }
  for (let z = 0; z < list.length; z++) { list[z].prev = list[z - 1] ?? null; list[z].next = list[z + 1] ?? null; }
  let head = list[0] ?? null;

  const nextD = (node) => { for (let p = node; p; p = p.next) if (p.k === "d") return p; return null; };
  const prevD = (node) => { for (let p = node; p; p = p.prev) if (p.k === "d") return p; return null; };
  const rule3 = (o, c) => (o.close || c.open ? (o.n + c.n) % 3 !== 0 || (o.n % 3 === 0 && c.n % 3 === 0) : true);
  const drop = (node) => { if (node.prev) node.prev.next = node.next; else head = node.next; if (node.next) node.next.prev = node.prev; };

  const bottom = new Map();
  let closer = nextD(head);
  while (closer) {
    if (!closer.close) { closer = nextD(closer.next); continue; }
    const key = `${closer.ch}${closer.open ? 1 : 0}${closer.n % 3}`;
    const stop = bottom.has(key) ? bottom.get(key) : null;
    let opener = prevD(closer.prev), found = null;
    while (opener && opener !== stop) {
      if (opener.k === "d" && opener.open && opener.ch === closer.ch && rule3(opener, closer)) { found = opener; break; }
      opener = prevD(opener.prev);
    }
    if (found) {
      const use = closer.ch === "~" ? 2 : found.n >= 2 && closer.n >= 2 ? 2 : 1;
      const kind = closer.ch === "~" ? "strike" : use === 2 ? "strong" : "emph";
      let kHead = null, kTail = null;
      for (let p = found.next; p && p !== closer;) {
        const q = p.next; p.prev = kTail; p.next = null;
        if (kTail) kTail.next = p; else kHead = p; kTail = p; p = q;
      }
      const wrap = { k: "w", kind, kids: kHead, prev: found, next: closer };
      found.next = wrap; closer.prev = wrap;
      found.n -= use; closer.n -= use;
      if (found.n === 0) drop(found);
      if (closer.n === 0) { const after = closer.next; drop(closer); closer = nextD(after); }
    } else {
      bottom.set(key, closer.prev);
      closer = nextD(closer.next);
    }
  }
  return build(head);
}

function build(head) {
  const out = [];
  const text = (v) => { const last = out[out.length - 1]; if (last && last.type === "text") last.value += v; else if (v) out.push({ type: "text", value: v }); };
  for (let n = head; n; n = n.next) {
    if (n.k === "t") text(n.v);
    else if (n.k === "d") text(n.ch.repeat(n.n));
    else out.push({ type: n.kind, children: build(n.kids) });
  }
  return out;
}

function inline(s) {
  const out = [];
  for (const p of atoms(s)) {
    if (typeof p === "string") out.push(...emphasis(p));
    else out.push(p);
  }
  const merged = [];
  for (const n of out) {
    const last = merged[merged.length - 1];
    if (n.type === "text" && last && last.type === "text") last.value += n.value;
    else merged.push(n);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Blocks — §2 / §2.1
// ---------------------------------------------------------------------------

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*(?:\{[^}]*\})?[ \t]*$/;
const FENCE = /^(={3,})[ \t]+([A-Za-z][A-Za-z0-9_-]*)/;

function marker(line) {
  const m = /^([ \t]*)(?:([-*])|(\d+)\.)[ \t]+(.*)$/.exec(line);
  if (!m) return null;
  return { indent: m[1].length, ordered: m[3] !== undefined, start: m[3] !== undefined ? parseInt(m[3], 10) : undefined, rest: m[4] };
}

function makeItem(m) {
  let text = m.rest;
  const task = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(text);
  const item = { text, inlines: [] };
  if (task) { item.checked = task[1] !== " "; text = task[2] ?? ""; item.text = text; }
  item.inlines = inline(text);
  return item;
}

// Recursive-by-indent list reader (a different shape from the reference's stack,
// same indentation rule).
function readList(lines, i, indent) {
  const first = marker(lines[i]);
  const list = { kind: "list", ordered: first.ordered, items: [] };
  if (first.ordered) list.start = first.start;
  let prevBlank = false;
  while (i < lines.length) {
    if (lines[i].trim() === "") { prevBlank = true; i++; continue; }
    const m = marker(lines[i]);
    if (!m || m.indent < indent) break;
    if (m.indent > indent) {
      const parent = list.items[list.items.length - 1];
      if (!parent) break;
      const sub = readList(lines, i, m.indent);
      (parent.children ??= []).push(sub.block);
      i = sub.next;
      prevBlank = false;
      continue;
    }
    if (prevBlank && list.items.length > 0) list.loose = true;
    prevBlank = false;
    list.items.push(makeItem(m));
    i++;
  }
  return { block: list, next: i };
}

function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const h = HEADING.exec(line);
    if (h) { out.push({ kind: "heading", level: h[1].length, text: h[2], inlines: inline(h[2]) }); i++; continue; }
    const f = FENCE.exec(line);
    if (f) {
      const len = f[1].length;
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^={${len}}[ \\t]*$`).test(lines[j])) j++;
      out.push({ kind: "block", type: f[2] });
      i = j < lines.length ? j + 1 : j;
      continue;
    }
    if (marker(line)) { const r = readList(lines, i, marker(line).indent); out.push(r.block); i = r.next; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !HEADING.test(lines[i]) && !FENCE.test(lines[i]) && !marker(lines[i])) {
      para.push(lines[i]); i++;
    }
    const text = para.join("\n");
    out.push({ kind: "paragraph", text, inlines: inline(text) });
  }
  return out;
}

export function parse2(src) {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  return { kind: "document", children: blocks(lines) };
}
