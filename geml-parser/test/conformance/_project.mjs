// Conformance projection: a compact, deterministic, human-readable normalization
// of the document model. The conformance suite stores each case as
// `{ geml, want }` where `want` is the projection of `parse(geml)`. Two GEML
// implementations conform if they produce the same projection for every case.
//
// Grammar of the projection:
//   text          -> a JSON-quoted string,            e.g. "abc"
//   emphasis      -> em( … )
//   strong        -> strong( … )
//   strikethrough -> s( … )
//   code span     -> code("…")
//   inline math   -> math("…")
//   hard break    -> br
//   image         -> img("src")
//   link          -> link("target" children…)        target = href | #anchor | doc#anchor
//   auto-ref      -> ref("target") | ref("target" -> "value")   value: a resolved coordinate's text
//   projection    -> project("target") | project("target" -> "value")
//   footnote ref  -> fn("id")
//   paragraph     -> the children, space-separated
//   heading       -> h<level>( children… )
//   list          -> ul[…] | ol[…]   ( "*" = loose, "@N" = ordered start N )
//   list item     -> li(…) | li[ ](…) | li[x](…)      with nested lists appended
//   embed         -> embed("src")
//   data          -> data(<value as JSON>)            a body no engine accepted: block:data
//   table / view  -> table(<columns> <row>… [summary <row>])   each a JSON array of cell texts
//   other block   -> block:<type>                      a `%%` line: hidden
//   document      -> its content blocks in document order, space-joined
//
// Every JSON above is as JSON.stringify writes it: strings JSON-escaped,
// numbers as ECMAScript's Number-to-String, map keys sorted by UTF-16 code
// unit (the order §6.1 compares text in) — a map's key order is not part of
// the value tree (§3.2).
//
// Adjacent text nodes print as one string, and an empty one prints as
// nothing: how an implementation splits text into nodes is not part of the
// document model, so `a`, `*`, `b` and `a*b` are the same paragraph.

export function inl(ns) {
  const merged = [];
  for (const n of ns) {
    if (n.type === "text") {
      if (n.value === "") continue;
      const last = merged[merged.length - 1];
      if (last?.type === "text") { merged[merged.length - 1] = { type: "text", value: last.value + n.value }; continue; }
    }
    merged.push(n);
  }
  return merged.map(node).join(" ");
}

// JSON with every map's keys sorted, so two implementations that build the same
// tree print the same text whatever order their maps keep. Written out rather
// than rebuilt as an object: a JS object enumerates integer-like keys in
// numeric order whatever order they were inserted in, so `{"10":…,"9":…}`
// cannot be made to print "10" first.
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function node(n) {
  switch (n.type) {
    case "text": return JSON.stringify(n.value);
    case "emph": return `em(${inl(n.children)})`;
    case "strong": return `strong(${inl(n.children)})`;
    case "strike": return `s(${inl(n.children)})`;
    case "code": return `code(${JSON.stringify(n.value)})`;
    case "math": return `math(${JSON.stringify(n.value)})`;
    case "break": return "br";
    case "image": return `img(${JSON.stringify(n.src)})`;
    case "link": {
      const target = n.href ?? `${n.doc ?? ""}${n.anchor ? "#" + n.anchor : ""}`;
      return `link(${JSON.stringify(target)} ${inl(n.children)})`;
    }
    // A GEP 0011 coordinate is RESOLVED by the parser, so its value is part of
    // the model a second implementation has to reproduce; printed only when
    // there is one, so every pre-coordinate case projects unchanged.
    case "autoref": {
      const t = JSON.stringify(`${n.doc ?? ""}#${n.anchor}`);
      return n.value === undefined ? `ref(${t})` : `ref(${t} -> ${JSON.stringify(n.value)})`;
    }
    // Inline projection. Projected by target: the `default` below would print the
    // bare word "project" and two different targets would look identical.
    case "project": {
      const t = JSON.stringify(`${n.doc ?? ""}#${n.anchor}`);
      return n.value === undefined ? `project(${t})` : `project(${t} -> ${JSON.stringify(n.value)})`;
    }
    case "footnote": return `fn(${JSON.stringify(n.ref)})`;
    default: return n.type;
  }
}

function list(b) {
  const tag = b.ordered ? "ol" : "ul";
  const items = b.items.map((it) => {
    const head = it.checked === undefined ? "li" : it.checked ? "li[x]" : "li[ ]";
    const kids = (it.children ?? []).map(list);
    const body = [inl(it.inlines), ...kids].filter((s) => s !== "").join(" ");
    return `${head}(${body})`;
  });
  const flags = `${b.loose ? "*" : ""}${b.start && b.start !== 1 ? "@" + b.start : ""}`;
  return `${tag}${flags}[${items.join(" ")}]`;
}

// Project every content block (skipping a leading `=== meta`), space-joined. A
// single-block document reads exactly as before; adjacent blocks — e.g. two
// lists split by a marker-type change (§5.3) — each project, in document order.
export function project(doc) {
  return doc.children
    .filter((x) => !(x.kind === "block" && x.type === "meta"))
    .map(projectBlock)
    .join(" ");
}

function projectBlock(b) {
  if (b.kind === "paragraph") return inl(b.inlines);
  if (b.kind === "heading") return `h${b.level}(${inl(b.inlines)})`;
  if (b.kind === "list") return list(b);
  // An embed's whole meaning is its target, so the bare `block:embed` would make
  // two different transclusions look identical in an expectation.
  if (b.kind === "block" && b.type === "embed") {
    const src = typeof b.attrs?.src === "string" ? b.attrs.src.trim() : "";
    return `embed(${JSON.stringify(src)})`;
  }
  // A data block's whole meaning is its parsed value (GEP-0005): project it,
  // so a conforming implementation must actually run the format engine. A body
  // no engine accepted (reserved/unknown format, or a parse failure) has no
  // value and projects as the bare block — the degradation is itself pinned.
  if (b.kind === "block" && b.type === "data" && b.value !== undefined) {
    return `data(${canonicalJson(b.value)})`;
  }
  // A table's or a view's meaning is the relation it publishes (§6, GEP-0012):
  // its columns, then each row's cell texts, then the summary row if it has
  // one. A view whose source never resolved has no relation and projects bare.
  if (b.kind === "block" && (b.type === "table" || b.type === "view") && b.table !== undefined) {
    const t = b.table;
    const rows = [t.columns, ...t.rows.map((r) => r.map((c) => c.text))].map((r) => JSON.stringify(r));
    if (t.summary) rows.push(`summary ${JSON.stringify(t.summary.map((c) => c.text))}`);
    return `${b.type}(${rows.join(" ")})`;
  }
  if (b.kind === "block") return `block:${b.type}`;
  return b.kind;
}

// The block tree, for a case's optional `blocks` field: every item of the
// document, a typed block with its type, id, classes, attributes and body, the
// body's own items in turn. Where `project` stops at `block:note`, this is what
// the note holds — §3's nesting and §4's attribute typing made visible.
//
//   paragraph   p( inlines )                heading   h<level>#<id>( inlines )
//   list        as in `project`             %% line   hidden
//   typed block <type>[#<id>][.<class>…][<attributes as JSON>]<body>
//   body        [ items… ]                  a flow or prose body
//               ( "<raw text>" )            a raw body, its lines joined by \n
//               ( <JSON> )                  a `meta` block: the keys it defines
export function blocksOf(doc) {
  return doc.children.map(treeItem).join(" ");
}

function treeItem(b) {
  if (b.kind === "paragraph") return `p(${inl(b.inlines)})`;
  if (b.kind === "heading") return `h${b.level}#${b.id ?? ""}(${inl(b.inlines)})`;
  if (b.kind === "list") return list(b);
  if (b.kind === "hidden") return "hidden";
  const head = `${b.type}${b.id !== undefined ? `#${b.id}` : ""}${b.classes.map((c) => `.${c}`).join("")}`
    + (Object.keys(b.attrs).length ? canonicalJson(b.attrs) : "");
  if (b.mode === "data") return `${head}(${canonicalJson(b.data ?? {})})`;
  if (b.raw !== undefined) return `${head}(${JSON.stringify(b.raw.join("\n"))})`;
  return `${head}[${(b.children ?? []).map(treeItem).join(" ")}]`;
}
