// Render-time inlining of `src=` tables (§6). A table with `src="file.csv"` has
// no inline body; this rewrites the GEML source so each such block carries the
// fetched data inline. A normal parse then handles data, compute, summary,
// chart, and column-name checking — no special render path needed.
//
// Pure: URL resolution and fetching are injected, so this has no browser
// dependency and is unit-testable.

const TABLE_OPEN = /^(=+)\s+table\b(.*)$/;
// `src=` takes a quoted string OR a bare word — §4's attribute grammar makes
// both a string, and the parser reads `src=data.csv` and `src="data.csv"` into
// the identical model. Matching only the quoted form meant a document written
// the bare way never inlined its data in the browser while rendering fine
// through the CLI: the same document, two answers, decided by a quote mark.
// A bare word ends at whitespace or the closing `}` of the attribute object.
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|([^\s}"]+))/;
const srcValue = (m) => m[1] ?? m[2];

export function hasSrcTable(raw) {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .some((l) => {
      const m = TABLE_OPEN.exec(l);
      return m != null && SRC_ATTR.test(m[2]);
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
    const srcM = m ? SRC_ATTR.exec(m[2]) : null;
    if (!m || !srcM) { out.push(lines[i]); continue; }

    const fence = m[1];
    let j = i + 1; // find the matching close fence: an equal-length run of '='
    for (; j < lines.length; j++) {
      const t = lines[j].replace(/\s+$/, "");
      if (/^=+$/.test(t) && t.length === fence.length) break;
    }

    let csv = null;
    try { csv = await fetchText(resolveUrl(srcValue(srcM))); } catch { csv = null; }

    if (csv != null && csv.trim() !== "") {
      out.push(fence + " table" + m[2].replace(/\s*\bsrc\s*=\s*(?:"[^"]*"|[^\s}"]+)/, ""));
      out.push(csv.replace(/\r\n?/g, "\n").replace(/\n+$/, ""));
      out.push(fence);
    } else {
      for (let k = i; k <= j && k < lines.length; k++) out.push(lines[k]); // keep original
    }
    i = j;
  }
  return out.join("\n");
}
