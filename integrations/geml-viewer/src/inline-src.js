// Render-time inlining of `src=` content (§6 tables; GEP-0005 data blocks).
// A `table` with `src="file.csv"` or a `data` block with `src="file.jsonl"`
// has no inline body; this rewrites the GEML source so each such block
// carries the fetched content inline. A normal parse then handles data,
// compute, summary, chart, verification and column-name checking — no
// special render path needed.
//
// Pure: URL resolution and fetching are injected, so this has no browser
// dependency and is unit-testable.

const BLOCK_OPEN = /^(=+)\s+(table|data|view)\b(.*)$/;

// A `view` (GEP-0012) may derive from a data FILE, but it takes NO body — so
// the inlining above cannot give it one. It gets a sibling instead: the fetched
// rows become a `table` of facts placed before it, and the view's `src=` is
// repointed at that table's id. Without this a `view {src=rows.csv}` rendered
// EMPTY in the browser: the parse has no filesystem, so it warned
// `unchecked-cross-document-reference` and published a relation with no columns,
// while the same document rendered fully through the CLI.
let factsSeq = 0;
function factsId(attrs) {
  const own = /\{[^}]*#([A-Za-z0-9_-]+)/.exec(attrs);
  return own ? `${own[1]}-src` : `view-src-${++factsSeq}`;
}

// A `src=` carrying a `#` names a BLOCK, not a file, and this module only
// knows how to fetch files. Handing one to fetch() drops the fragment at the
// HTTP layer, so `src=A.geml#fy` returned the whole of A.geml, looksTabular
// said yes to it (it is text, and starts with neither `<` nor `{`), and the
// entire document — meta block, headings and all — was inlined as that table's
// body. A same-document `src=#id` is the parser's own job; a cross-document one
// needs a resolver this module does not have, and the parser reports it
// unresolved. Either way: leave the block alone.
const namesABlock = (src) => src.includes("#");

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
      const src = m ? findSrc(m[3]) : null;
      return src != null && !namesABlock(src.value);
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
    if (!m || !src || namesABlock(src.value)) { out.push(lines[i]); continue; }

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
      // A `view` over a data file carries the same tabular text a `table` does,
      // so it is judged the same way; `parsesAsData` is the `data` block's test.
      && (type === "table" || type === "view" ? true : parsesAsData(text, fmt));

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
      const body = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
      if (type === "view") {
        // Facts first, then the view that derives from them. `header=1` and the
        // delimiter come from the same extension rule the parser applies, and
        // any `format=`/`delim=`/`header=` the author wrote on the view moves to
        // the table with the body it describes.
        const id = factsId(m[3]);
        const bodyAttrs = [...attrs.matchAll(/\s(?:format|delim|header)=(?:"[^"]*"|[^\s}]+)/g)].map((x) => x[0].trim());
        const declaredFormat = /\bformat=/.test(bodyAttrs.join(" "));
        const fromExt = /\.tsv$/i.test(src.value) ? "tsv" : "csv";
        const tableAttrs = [`#${id}`, ...(declaredFormat ? [] : [`format=${fromExt}`, "header=1"]), ...bodyAttrs].join(" ");
        out.push(`${fence} table {${tableAttrs}}`);
        out.push(body);
        out.push(fence);
        out.push("");
        // `src=` goes back where the author's was: inside the object, at the
        // end, so the id it declared stays first and the line still reads like
        // the one they wrote.
        const viewAttrs = attrs.replace(/\s(?:format|delim|header)=(?:"[^"]*"|[^\s}]+)/g, "").trim();
        out.push(/\}$/.test(viewAttrs)
          ? `${fence} view ${viewAttrs.replace(/\s*\}$/, ` src=#${id}}`)}`
          : `${fence} view {src=#${id}}`);
        out.push(fence);
        i = j;
        continue;
      }
      out.push(fence + " " + type + attrs);
      out.push(body);
      out.push(fence);
    } else {
      for (let k = i; k <= j && k < lines.length; k++) out.push(lines[k]); // keep original
    }
    i = j;
  }
  return out.join("\n");
}
