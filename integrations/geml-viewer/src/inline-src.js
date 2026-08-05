// Render-time inlining of `src=` content (§6 tables; GEP-0005 data blocks).
// A `table` with `src="file.csv"` or a `data` block with `src="file.jsonl"`
// has no inline body; this rewrites the GEML source so each such block
// carries the fetched content inline. A normal parse then handles data,
// compute, summary, chart, verification and column-name checking — no
// special render path needed.
//
// Pure: URL resolution and fetching are injected, so this has no browser
// dependency and is unit-testable.

const BLOCK_OPEN = /^(=+)\s+(table|data)\b(.*)$/;

// The one real `src=` attribute in an open line's attribute text, or null.
// `src=` takes a quoted string OR a bare word — §4's attribute grammar makes
// both a string, so `src=data.csv` and `src="data.csv"` are the same model.
// Two guards a bare \bsrc= regex lacks: the token must start at an attribute
// boundary (start of text, whitespace, or `{`), and it must sit OUTSIDE any
// quoted value — `caption="see src=x"` is prose, not an attribute (§4 strings
// are "-delimited and cannot contain a `"`, so quote parity decides).
export function findSrc(attrs) {
  const re = /(^|[\s{])(src\s*=\s*(?:"([^"]*)"|([^\s}"]+)))/g;
  for (let m; (m = re.exec(attrs)); ) {
    const start = m.index + m[1].length;
    if (((attrs.slice(0, start).match(/"/g) ?? []).length & 1) === 0) {
      return { value: m[3] ?? m[4], start, end: start + m[2].length };
    }
  }
  return null;
}

// The declared format= (same boundary + quote-parity discipline), or null.
function findFormat(attrs) {
  const re = /(^|[\s{])format\s*=\s*(?:"([^"]*)"|([^\s}"]+))/g;
  for (let m; (m = re.exec(attrs)); ) {
    const start = m.index + m[1].length;
    if (((attrs.slice(0, start).match(/"/g) ?? []).length & 1) === 0) return m[2] ?? m[3];
  }
  return null;
}

export function hasSrcTable(raw) {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .some((l) => {
      const m = BLOCK_OPEN.exec(l);
      return m != null && findSrc(m[3]) != null;
    });
}

// Cheap guard for `src` responses that obviously aren't tabular data — an HTML
// error page or a JSON error body. A fetched body that fails this is treated as
// "not loaded" (placeholder) instead of being parsed into a garbage table.
// Plain-text errors can't be told apart from CSV and are intentionally not caught.
export function looksTabular(text) {
  const t = (text || "").replace(/^﻿/, "").trimStart();
  if (t === "") return false;
  if (t[0] === "<") return false; // HTML / XML
  if (t[0] === "{" || t[0] === "[") {
    try { JSON.parse(t); return false; } catch { /* not JSON — may be CSV */ }
  }
  return true;
}

// The data-block twin of looksTabular: only inline what the declared format
// actually accepts, so an HTML error page never lands inside a data body.
function parsesAsData(text, fmt) {
  const body = (text || "").replace(/^﻿/, "");
  if (fmt === "json") { try { JSON.parse(body); return true; } catch { return false; } }
  if (fmt === "jsonl") {
    const lines = body.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return false;
    try { for (const l of lines) JSON.parse(l); return true; } catch { return false; }
  }
  return false; // engine-less formats stay external — the parser would not verify them anyway
}

// resolveUrl(src) -> absolute URL string. fetchText(url) -> Promise<string|null>
// (null = could not load; the block is then left external for the renderer to
// show a placeholder).
export async function inlineSrcTables(raw, resolveUrl, fetchText) {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = BLOCK_OPEN.exec(lines[i]);
    const src = m ? findSrc(m[3]) : null;
    if (!m || !src) { out.push(lines[i]); continue; }

    const fence = m[1];
    const type = m[2];
    let j = i + 1; // find the matching close fence: an equal-length run of '='
    for (; j < lines.length; j++) {
      const t = lines[j].replace(/\s+$/, "");
      if (/^=+$/.test(t) && t.length === fence.length) break;
    }

    let text = null;
    try { text = await fetchText(resolveUrl(src.value)); } catch { text = null; }

    // Which engine will read the inlined body: an explicit format= wins,
    // else the source extension names it (mirroring the parser's rule).
    const declared = findFormat(m[3]);
    const fmt = declared ?? (type === "data" ? (/\.jsonl$/i.test(src.value) ? "jsonl" : "json") : null);
    const usable = text != null && text.trim() !== ""
      && (type === "table" ? true : parsesAsData(text, fmt));

    if (usable) {
      // Strip exactly the matched attribute (and the whitespace run before it)
      // by index — a second regex pass could hit a `src=` lookalike elsewhere.
      let s = src.start;
      while (s > 0 && /\s/.test(m[3][s - 1])) s--;
      let attrs = m[3].slice(0, s) + m[3].slice(src.end);
      // A jsonl body inlined WITHOUT its format= would be read as json and
      // fail verification — inject the format the extension implied.
      if (type === "data" && declared === null && fmt !== "json") {
        attrs = /\}\s*$/.test(attrs)
          ? attrs.replace(/\}\s*$/, (t) => ` format=${fmt}` + t).replace(/\{\s+format=/, "{format=")
          : `${attrs} {format=${fmt}}`;
      }
      out.push(fence + " " + type + attrs);
      out.push(text.replace(/\r\n?/g, "\n").replace(/\n+$/, ""));
      out.push(fence);
    } else {
      for (let k = i; k <= j && k < lines.length; k++) out.push(lines[k]); // keep original
    }
    i = j;
  }
  return out.join("\n");
}
