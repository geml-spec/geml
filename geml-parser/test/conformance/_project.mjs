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
//   auto-ref      -> ref("target")
//   footnote ref  -> fn("id")
//   paragraph     -> the children, space-separated
//   heading       -> h<level>( children… )
//   list          -> ul[…] | ol[…]   ( "*" = loose, "@N" = ordered start N )
//   list item     -> li(…) | li[ ](…) | li[x](…)      with nested lists appended
//   document      -> its content blocks in document order, space-joined

export function inl(ns) {
  return ns.map(node).join(" ");
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
    case "autoref": return `ref(${JSON.stringify(`${n.doc ?? ""}#${n.anchor}`)})`;
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
  if (b.kind === "block") return `block:${b.type}`;
  return b.kind;
}
