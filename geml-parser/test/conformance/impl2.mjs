// A SECOND, INDEPENDENT GEML implementation — clean-room, written only from the
// spec (GEML-spec.md §2.1 lists, §3.1 grammar, §5.3 emphasis). It imports NOTHING
// from the reference parser (../../dist). It builds the spec document model for
// the unfenced-block and inline subset the conformance suite exercises, so the
// shared projection (_project.mjs) can compare it, case for case, against the
// reference.
//
// Its agreement with the reference across the whole suite is the acceptance test
// for "the spec is precise enough that two implementations cannot diverge."

// ---------------------------------------------------------------------------
// Inline — §5.3
// ---------------------------------------------------------------------------

// §5.1 escapes are ASCII-only; §5.3 flanking is Unicode-wide.
const ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;
const PUNCT = /[\p{P}\p{S}]/u;
const isPunct = (c) => c !== undefined && PUNCT.test(c);
const isSpace = (c) => c === undefined || /\s/.test(c);
// §9: only four URL schemes may become a live destination. Everything else —
// `javascript:`, `data:text/html`, `vbscript:`, `file:` — is dropped, so a
// document cannot make the processor emit an executable or file-reading link.
// Written from the spec, like the rest of this file: the point of the safety
// conformance cases is that an implementation reading only the prose arrives
// here too. Without this, this implementation passed every other case while
// carrying the exact XSS the reference has a regression test for.
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// The scheme is read AFTER stripping C0 controls and spaces, because a browser
// drops those before acting on a URL: `java<TAB>script:` would otherwise pass
// this check and still execute.
const schemeOf = (url) => {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(String(url).replace(/[\x00-\x20]/g, ""));
  return m ? m[1].toLowerCase() : null;
};
const isSafeDest = (d) => {
  const s = schemeOf(d);
  return s === null || SAFE_SCHEMES.has(s);   // no scheme = a relative path or #anchor
};
// Media may additionally be a `data:image/…` URI: it is inline, so it loads no
// resource and runs nothing.
const isSafeMedia = (d) => isSafeDest(d) || /^data:image\//i.test(String(d).replace(/[\x00-\x20]/g, ""));

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
  // Safety BEFORE shape. Checking the shape first is the trap: `java<TAB>script:`
  // does not match SCHEME (the tab breaks the run), so it would fall through to
  // the "no scheme, therefore a relative path" branch and carry the payload out
  // as a DOCUMENT reference instead. schemeOf strips the control characters a
  // browser would strip, so the scheme is recognised before it is judged.
  if (!isSafeDest(d)) return {};
  if (SCHEME.test(d)) return { href: d };
  const h = d.indexOf("#");
  if (h === 0) return { anchor: d.slice(1) };
  if (h > 0) return { doc: d.slice(0, h), anchor: d.slice(h + 1) };
  if (d) return { doc: d };
  return {};
}

// Phase 1: pull out atoms (escapes, code, math, image, auto-ref, footnote, link);
// everything else is left as literal-text strings for phase 2. Each atom records
// the first/last characters of its consumed source span: §5.3 flanking is
// defined on source characters, so a delimiter run bordering an atom is judged
// against the atom's edge (`[` opens a link, `)` closes it, a hard break ends in
// the `\n` it consumed).
function atoms(s) {
  const out = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(buf); buf = ""; } };
  const atom = (node, start, end) => { flush(); out.push({ node, first: s[start], last: s[end - 1] }); };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const nx = s[i + 1];
      if (nx === undefined || nx === "\n") { const end = i + (nx === undefined ? 1 : 2); atom({ type: "break" }, i, end); i = end; continue; }
      if (ASCII_PUNCT.test(nx)) { atom({ type: "text", value: nx }, i, i + 2); i += 2; continue; }
      buf += c; i++; continue;
    }
    if (c === "`") {
      let n = 0; while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const close = s.indexOf(fence, i + n);
      if (close >= 0) { atom({ type: "code", value: s.slice(i + n, close) }, i, close + n); i = close + n; continue; }
      buf += fence; i += n; continue;
    }
    if (c === "$") {
      const close = s.indexOf("$", i + 1);
      if (close > i + 1) { atom({ type: "math", value: s.slice(i + 1, close) }, i, close + 1); i = close + 1; continue; }
      buf += c; i++; continue;
    }
    // §5.3: inline projection is tried before the image atom, so `![[#x]]` is a
    // projection and a `(…)` run after it stays literal text.
    if (c === "!" && s[i + 1] === "[" && s[i + 2] === "[") {
      const inner = readBracket(s, i + 2);
      if (inner && s[inner.end] === "]") {
        const d = classify(inner.content.trim());
        if (d.anchor) {
          const node = { type: "project", anchor: d.anchor };
          if (d.doc) node.doc = d.doc;
          atom(node, i, inner.end + 1);
          i = inner.end + 1;
          continue;
        }
      }
    }
    if (c === "!" && s[i + 1] === "[") {
      const lab = readBracket(s, i + 1);
      const par = lab ? readParen(s, lab.end) : null;
      if (lab && par) {
        // §9: an unsafe media scheme loses the src, keeping the alt — the same
        // rule links follow, with data:image additionally allowed (inline, no
        // network, nothing executable).
        const raw = par.content.trim();
        const end = skipAttrs(s, par.end);
        atom({ type: "image", src: isSafeMedia(raw) ? raw : "" }, i, end);
        i = end; continue;
      }
    }
    if (c === "[" && s[i + 1] === "[") {
      const inner = readBracket(s, i + 1);
      if (inner && s[inner.end] === "]") {
        const d = classify(inner.content.trim());
        if (d.anchor) { const node = { type: "autoref", anchor: d.anchor }; if (d.doc) node.doc = d.doc; atom(node, i, inner.end + 1); i = inner.end + 1; continue; }
      }
    }
    if (c === "[" && s[i + 1] === "^") {
      const br = readBracket(s, i);
      if (br && br.content.startsWith("^")) { atom({ type: "footnote", ref: br.content.slice(1).trim() }, i, br.end); i = br.end; continue; }
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
        const end = skipAttrs(s, par.end);
        atom(node, i, end); i = end; continue;
      }
    }
    buf += c; i++;
  }
  flush();
  return out;
}

// Phase 2: emphasis / strong / strikethrough over the WHOLE inline sequence, by
// delimiter-run flanking with the rule of three (§5.3). Atoms are opaque single
// units a pair may wrap; a run at a text edge flanks against the neighboring
// part's edge character (an atom's recorded source edge). Linked-list of nodes.
function emphasis(parts) {
  const list = [];
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (typeof part !== "string") { list.push({ k: "a", node: part.node }); continue; }
    const text = part;
    // a text part's neighbors are always atoms (or the sequence edge): atoms()
    // flushes buffered text exactly when it emits an atom
    const before0 = k > 0 ? parts[k - 1].last : undefined;
    const after0 = k + 1 < parts.length ? parts[k + 1].first : undefined;
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "*" || c === "~") {
        let j = i; while (text[j] === c) j++;
        const n = j - i;
        if (c === "~" && n < 2) { list.push({ k: "t", v: "~".repeat(n) }); i = j; continue; }
        const before = i > 0 ? text[i - 1] : before0, after = j < text.length ? text[j] : after0;
        const bws = isSpace(before), aws = isSpace(after), bp = isPunct(before), ap = isPunct(after);
        list.push({ k: "d", ch: c, n, open: !aws && (!ap || bws || bp), close: !bws && (!bp || aws || ap) });
        i = j;
      } else {
        let j = i; while (j < text.length && text[j] !== "*" && text[j] !== "~") j++;
        list.push({ k: "t", v: text.slice(i, j) });
        i = j;
      }
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
    // A `~` run spent down to one character is no longer a delimiter (a lone `~`
    // never was), on both sides: skipping it keeps `use = 2` from taking more
    // than a side has left, which otherwise re-paired forever (`~~~a~~~`) or
    // drove `n` to -1 (`~~~~a~~~`, a `"~".repeat(-1)` throw). §5.3.
    if (!closer.close || (closer.ch === "~" && closer.n < 2)) { closer = nextD(closer.next); continue; }
    const key = `${closer.ch}${closer.open ? 1 : 0}${closer.n % 3}`;
    const stop = bottom.has(key) ? bottom.get(key) : null;
    let opener = prevD(closer.prev), found = null;
    while (opener && opener !== stop) {
      if (opener.k === "d" && opener.open && opener.ch === closer.ch && (closer.ch !== "~" || opener.n >= 2) && rule3(opener, closer)) { found = opener; break; }
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
    else if (n.k === "a") { if (n.node.type === "text") text(n.node.value); else out.push(n.node); }
    else out.push({ type: n.kind, children: build(n.kids) });
  }
  return out;
}

function inline(s) {
  return emphasis(atoms(s));
}

// ---------------------------------------------------------------------------
// Metadata interpolation — §4
// ---------------------------------------------------------------------------

// §3: the body modes that are FLOW — the only bodies a nested block may live
// in. A raw or data body is opaque, which is what makes a `=== meta` shown as
// an EXAMPLE inside a longer-fenced `==== code` content rather than a
// definition. A flat scan for `=== meta` reads those examples as real metadata.
const FLOW_TYPES = new Set(["note", "text"]);

// Pre-scan every `=== meta` block and merge its `key = val` lines (a later
// block may satisfy an earlier `{{key}}`). Quoted values lose their quotes;
// everything is kept as a string for substitution. The walk descends into flow
// bodies only, so an example inside a raw body never defines anything.
function collectMeta(lines) {
  const meta = new Map();
  const walk = (ls, depth) => {
    for (let i = 0; i < ls.length; i++) {
      const f = FENCE.exec(ls[i]);
      if (!f) continue;
      const len = f[1].length;
      const close = new RegExp(`^={${len}}[ \\t]*$`);
      let j = i + 1;
      while (j < ls.length && !close.test(ls[j])) j++;
      if (f[2] === "meta") {
        for (let k = i + 1; k < j; k++) {
          const eq = ls[k].indexOf("=");
          if (eq <= 0) continue;
          const v = ls[k].slice(eq + 1).trim();
          const q = /^"(.*)"$/.exec(v);
          const key = ls[k].slice(0, eq).trim();
          // §4: across meta blocks the FIRST definition of a key wins.
          if (!meta.has(key)) meta.set(key, q ? q[1] : v);
        }
      } else if (FLOW_TYPES.has(f[2]) && depth < 256) {
        walk(ls.slice(i + 1, j), depth + 1);
      }
      i = j;
    }
  };
  walk(lines, 0);
  return meta;
}

// §4: replace `{{key}}` with its meta value in flow source text. The scan
// honors the §5.3(1) verbatim atoms — a reference inside a code span or
// inline math is untouched, and an escaped `\{{key}}` stays literal. An
// unknown key is kept as literal text (diagnostics are out of scope here).
function interp(s, meta) {
  if (!s.includes("{{")) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { out += s.slice(i, i + 2); i += 2; continue; }
    if (c === "`") {
      let n = 0;
      while (s[i + n] === "`") n++;
      const close = s.indexOf("`".repeat(n), i + n);
      if (close >= 0) { out += s.slice(i, close + n); i = close + n; continue; }
      out += s.slice(i, i + n); i += n; continue;
    }
    if (c === "$") {
      const close = s.indexOf("$", i + 1);
      if (close > i + 1) { out += s.slice(i, close + 1); i = close + 1; continue; }
      out += c; i++; continue;
    }
    if (c === "{" && s[i + 1] === "{") {
      const m = /^\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/.exec(s.slice(i));
      if (m && meta.has(m[1])) { out += meta.get(m[1]); i += m[0].length; continue; }
    }
    out += c; i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blocks — §2 / §2.1
// ---------------------------------------------------------------------------

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*(?:\{[^}]*\})?[ \t]*$/;
// The FULL open-fence production (§3): attributes braced or absent, end
// anchored. A fence-like line with bare attributes (`=== embed src=#a`) is
// NOT a fence — it degrades to paragraph text, and both implementations must
// agree on that degradation (the reference parser additionally warns;
// diagnostics are not part of the projection).
const FENCE = /^(={3,})[ \t]+([A-Za-z][A-Za-z0-9_-]*)[ \t]*(\{.*\})?[ \t]*$/;

function marker(line) {
  const m = /^([ \t]*)(?:([-*])|(\d+)\.)[ \t]+(.*)$/.exec(line);
  if (!m) return null;
  return { indent: m[1].length, ordered: m[3] !== undefined, start: m[3] !== undefined ? parseInt(m[3], 10) : undefined, rest: m[4] };
}

function makeItem(m, meta) {
  let text = interp(m.rest, meta);
  // The task marker lives on the item's FIRST line; a `[x]` on a §2.2
  // continuation line is content.
  const nl = text.indexOf("\n");
  const first = nl === -1 ? text : text.slice(0, nl);
  const task = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(first);
  const item = { text, inlines: [] };
  if (task) { item.checked = task[1] !== " "; text = (task[2] ?? "") + (nl === -1 ? "" : text.slice(nl)); item.text = text; }
  item.inlines = inline(text);
  return item;
}

// Recursive-by-indent list reader (a different shape from the reference's stack,
// same indentation rule).
function readList(lines, i, indent, meta) {
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
      const sub = readList(lines, i, m.indent, meta);
      (parent.children ??= []).push(sub.block);
      i = sub.next;
      prevBlank = false;
      continue;
    }
    // A marker-type change (bullet ↔ ordered) at the same level ends the list;
    // blocks() then opens a fresh one at this marker (CommonMark §5.3).
    if (m.ordered !== list.ordered) break;
    if (prevBlank && list.items.length > 0) list.loose = true;
    prevBlank = false;
    // §2.2 continuation lines: non-blank, not an item line, not a
    // `%%` comment, indented past this item's marker — joined as a soft wrap.
    let j = i + 1;
    while (j < lines.length) {
      const cand = lines[j];
      const body = cand.trim();
      const ind = /^[ \t]*/.exec(cand)[0].length;
      if (body === "" || body.startsWith("%%") || marker(cand) !== null || ind <= m.indent) break;
      m.rest += "\n" + body;
      j++;
    }
    list.items.push(makeItem(m, meta));
    i = j;
  }
  return { block: list, next: i };
}

function blocks(lines, meta) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const h = HEADING.exec(line);
    if (h) { const t = interp(h[2], meta); out.push({ kind: "heading", level: h[1].length, text: t, inlines: inline(t) }); i++; continue; }
    const f = FENCE.exec(line);
    if (f) {
      const len = f[1].length;
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^={${len}}[ \\t]*$`).test(lines[j])) j++;
      // §4: a block may carry an attribute object. Only `src` is read here —
      // it is the whole meaning of a transclusion, so the conformance projection
      // shows it, and a block whose target were dropped would compare equal to
      // one pointing somewhere else.
      const attrs = {};
      // The end-anchored FENCE consumes the whole line, so the attribute
      // object now arrives as its own capture group instead of a tail slice.
      const obj = f[3] ? /\{([^}]*)\}/.exec(f[3]) : null;
      if (obj) {
        const src = /(?:^|\s)src\s*=\s*("([^"]*)"|'([^']*)'|([^\s}]+))/.exec(obj[1]);
        if (src) {
          // §9: a transclusion target names a document to READ, so an unsafe
          // scheme is blanked here rather than at the sink — the attribute must
          // not carry it into the model at all.
          const raw = src[2] ?? src[3] ?? src[4];
          attrs.src = isSafeDest(raw) ? raw : "";
        }
      }
      const blk = { kind: "block", type: f[2], attrs };
      // GEP-0005: a `data` block's meaning is its parsed value — the projection
      // shows it, so this implementation must run the format engine too. Only
      // the two core formats exist; anything else (yaml/toml/unknown) keeps the
      // body unparsed, and a body the engine rejects simply carries no value
      // (diagnostics are not part of the projection).
      if (f[2] === "data") {
        const body = lines.slice(i + 1, j < lines.length ? j : lines.length);
        const fm = obj ? /(?:^|\s)format\s*=\s*("([^"]*)"|([^\s}]+))/.exec(obj[1]) : null;
        const format = fm ? (fm[2] ?? fm[3]) : "json";
        try {
          if (format === "json") blk.value = JSON.parse(body.join("\n"));
          else if (format === "jsonl") blk.value = body.filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
        } catch { /* no value */ }
      }
      out.push(blk);
      i = j < lines.length ? j + 1 : j;
      continue;
    }
    // §4 comment-line = indent , "%%" , [ SP , text ] — leading indentation is
    // part of the grammar, so an indented `%%` is still a comment, not prose.
    if (line.trimStart().startsWith("%%")) {
      out.push({ kind: "hidden", text: line.trimStart().slice(2).replace(/^ /, "") });
      i++;
      continue;
    }
    if (marker(line)) { const r = readList(lines, i, marker(line).indent, meta); out.push(r.block); i = r.next; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !HEADING.test(lines[i]) && !FENCE.test(lines[i]) && !marker(lines[i])
           && !lines[i].trimStart().startsWith("%%")) {
      para.push(lines[i]); i++;
    }
    const text = interp(para.join("\n"), meta);
    out.push({ kind: "paragraph", text, inlines: inline(text) });
  }
  return out;
}

export function parse2(src) {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  return { kind: "document", children: blocks(lines, collectMeta(lines)) };
}
