// Render-time inlining of `src=` tables (§6). A table with `src="file.csv"` has
// no inline body; this rewrites the GEML source so each such block carries the
// fetched data inline. A normal parse then handles data, compute, summary,
// chart, and column-name checking — no special render path needed.
//
// Pure: URL resolution and fetching are injected, so this has no browser
// dependency and is unit-testable.

const TABLE_OPEN = /^(=+)\s+table\b(.*)$/;

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

export function hasSrcTable(raw) {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .some((l) => {
      const m = TABLE_OPEN.exec(l);
      return m != null && findSrc(m[2]) != null;
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

// resolveUrl(src) -> absolute URL string. fetchText(url) -> Promise<string|null>
// (null = could not load; the block is then left external for the renderer to
// show a placeholder).
export async function inlineSrcTables(raw, resolveUrl, fetchText) {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TABLE_OPEN.exec(lines[i]);
    const src = m ? findSrc(m[2]) : null;
    if (!m || !src) { out.push(lines[i]); continue; }

    const fence = m[1];
    let j = i + 1; // find the matching close fence: an equal-length run of '='
    for (; j < lines.length; j++) {
      const t = lines[j].replace(/\s+$/, "");
      if (/^=+$/.test(t) && t.length === fence.length) break;
    }

    let csv = null;
    try { csv = await fetchText(resolveUrl(src.value)); } catch { csv = null; }

    if (csv != null && csv.trim() !== "") {
      // Strip exactly the matched attribute (and the whitespace run before it)
      // by index — a second regex pass could hit a `src=` lookalike elsewhere.
      let s = src.start;
      while (s > 0 && /\s/.test(m[2][s - 1])) s--;
      out.push(fence + " table" + m[2].slice(0, s) + m[2].slice(src.end));
      out.push(csv.replace(/\r\n?/g, "\n").replace(/\n+$/, ""));
      out.push(fence);
    } else {
      for (let k = i; k <= j && k < lines.length; k++) out.push(lines[k]); // keep original
    }
    i = j;
  }
  return out.join("\n");
}
