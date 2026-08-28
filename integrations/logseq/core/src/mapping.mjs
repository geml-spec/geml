// EDN ⇄ GEML for Logseq DB graphs.
//
// Input is what `logseq export-edn` (@logseq/cli) produces — sqlite.build EDN:
//
//   {:pages-and-blocks [{:page {...} :blocks [{:block/title ".." :build/children [..]} ..]} ..]
//    :properties {..}    ; ontology: property definitions
//    :classes    {..}}   ; ontology: class/tag definitions
//
// The mapping keeps two promises, in this order:
//
//   1. LOSSLESS. The round-trip test is EDN → GEML → EDN structural equality
//      (EDN map/set semantics: entry order does not count). Anything this
//      version does not give a GEML shape of its own rides along VERBATIM as
//      EDN inside `code {lang=edn}` blocks — carried, not dropped.
//   2. ADDRESSABLE where it pays. A block's title becomes the body of a
//      `=== text` block; a block that has a uuid keeps it as `{#uuid}`, so
//      `geml get/set` address exactly the blocks Logseq itself considers
//      addressable (uuids are only exported for referenced blocks).
//
// Structure choice: the outline tree is a FLAT sequence of blocks in
// depth-first order, each carrying `level=N` — a complete encoding of the tree
// (it is how outlines print), without nesting GEML fences to the outline's
// depth.
//
// Everything runs on edn-data's TYPED representation (keywords as {key}, sets
// as {set}, maps as {map: [[k,v]..]}, vectors as arrays), so nothing is coerced
// through JSON and nothing un-EDN-able is invented.

import { parseEDNString, toEDNString } from "edn-data";

// --- typed-EDN helpers -------------------------------------------------------

const kw = (name) => ({ key: name });
const isKw = (v, name) => v !== null && typeof v === "object" && v.key === name;
const mapEntries = (m) => (m !== null && typeof m === "object" && Array.isArray(m.map) ? m.map : []);
const mapGet = (m, name) => {
  for (const [k, v] of mapEntries(m)) if (isKw(k, name)) return v;
  return undefined;
};
const mapWithout = (m, names) => ({ map: mapEntries(m).filter(([k]) => !names.some((n) => isKw(k, n))) });
const mapSize = (m) => mapEntries(m).length;
const edn = (v) => toEDNString(v);

// edn-data renders `#uuid "..."` as a tagged value; accept both spellings.
const uuidOf = (v) => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    if (typeof v.uuid === "string") return v.uuid;
    if (v.tag === "uuid" && typeof v.val === "string") return v.val;
  }
  return undefined;
};

// --- GEML text helpers -------------------------------------------------------

// A fence must be longer than any `=` run opening a line of the body (§3).
function fenceFor(body) {
  let longest = 2;
  for (const m of body.matchAll(/^=+/gm)) longest = Math.max(longest, m[0].length + 1);
  return "=".repeat(Math.max(3, longest));
}

function gemlBlock(type, attrs, body) {
  const f = fenceFor(body);
  const a = attrs ? ` {${attrs}}` : "";
  return `${f} ${type}${a}\n${body}\n${f}\n`;
}

// --- export: EDN → GEML files ------------------------------------------------

// Returns Map<relativePath, gemlText>. Page order is preserved by a numeric
// filename prefix: :pages-and-blocks is a vector, and order is content.
// A Logseq block reference, as the DB export writes it: `[[<uuid>]]` inside a
// block's title. A PAGE reference looks identical apart from its target
// (`[[Some Page]]`), so the uuid shape is the whole discriminator — matching
// anything looser would rewrite people's page links.
const REF_BARE = /\[\[([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]\]/g;
// The GEML form, on the way back: `[[#uuid]]` or `[[path/to/doc.geml#uuid]]`.
const REF_GEML = /\[\[([^\[\]]*?)#([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]\]/g;

/** POSIX-relative path from one vault file to another, as GEML resolves it. */
function relFromTo(fromPath, toPath) {
  const from = fromPath.split("/").slice(0, -1);
  const to = toPath.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => ".."), ...to.slice(i)].join("/");
}

/**
 * Turn Logseq's unchecked `[[uuid]]` into GEML's checked reference — the whole
 * point of the exercise: `geml check` then reports a reference that goes
 * nowhere instead of shrugging at it.
 *
 * A target in the same file becomes `[[#uuid]]`, one in another file
 * `[[<relative path>#uuid]]`. A uuid the export never wrote also becomes
 * `[[#uuid]]`, which `check` calls unresolved — because within this vault it
 * IS: `@logseq/cli` 0.4.3 does not export journal pages, so a ref into one
 * genuinely leads nowhere here, and saying so is the promise being kept, not
 * broken. Translation is exactly reversible, which is what keeps the round
 * trip an identity.
 */
export function translateRefsOut(files, uuidPath) {
  for (const [path, text] of files) {
    const next = text.replace(REF_BARE, (_m, uuid) => {
      const target = uuidPath.get(uuid.toLowerCase());
      if (!target || target === path) return `[[#${uuid}]]`;
      return `[[${relFromTo(path, target)}#${uuid}]]`;
    });
    if (next !== text) files.set(path, next);
  }
  return files;
}

/** The inverse: any `[[…#uuid]]` back to the `[[uuid]]` Logseq stores. */
export function translateRefsIn(text) {
  return text.replace(REF_GEML, (_m, _prefix, uuid) => `[[${uuid}]]`);
}

export function ednToGemlFiles(ednText) {
  const top = parseEDNString(ednText);
  const files = new Map();

  const pages = mapGet(top, "pages-and-blocks") ?? [];
  const properties = mapGet(top, "properties");
  const classes = mapGet(top, "classes");
  const rest = mapWithout(top, ["pages-and-blocks", "properties", "classes"]);

  // Ontology and any top-level keys this version does not model: verbatim.
  let onto = '=== meta\ntitle = "Logseq graph ontology"\n===\n\n';
  if (properties !== undefined) onto += gemlBlock("code", "#properties lang=edn", edn(properties));
  if (classes !== undefined) onto += gemlBlock("code", "#classes lang=edn", edn(classes));
  if (mapSize(rest) > 0) onto += gemlBlock("code", "#graph-extra lang=edn", edn(rest));
  files.set("ontology.geml", onto);

  const order = [];
  // uuid → the file that will hold that block, filled during the walk and used
  // once every file exists: a reference can point at a page written later.
  const uuidPath = new Map();
  pages.forEach((entry) => {
    const page = mapGet(entry, "page") ?? { map: [] };
    const blocksVal = mapGet(entry, "blocks");
    const blocks = blocksVal ?? [];
    const entryRest = mapWithout(entry, ["page", "blocks"]);
    // A present-but-empty :blocks is not the same EDN as an absent one, and
    // real exports write `:blocks []` on block-less pages. An empty vector has
    // no text blocks to speak for it, so it rides along with the rest.
    if (Array.isArray(blocksVal) && blocksVal.length === 0) entryRest.map.push([kw("blocks"), []]);

    const title = mapGet(page, "block/title");
    const journal = mapGet(page, "build/journal");
    // The tree is laid out the way an OG vault is: journals under `journals/`
    // with the OG date filename (20250220 → 2025_02_20.geml), everything else
    // under `pages/` named by the page itself. No numeric prefixes — page
    // ORDER is content, but it belongs in the graph.geml index, not in
    // filenames a person has to look at.
    let path;
    if (typeof journal === "number") {
      const j = String(journal);
      path = `journals/${j.slice(0, 4)}_${j.slice(4, 6)}_${j.slice(6, 8)}.geml`;
    } else {
      const nameSeed = typeof title === "string" ? title : "page";
      const slug = nameSeed.toLowerCase().replace(/[^a-z0-9一-鿿]+/gu, "-").replace(/^-+|-+$/g, "") || "page";
      path = `pages/${slug}.geml`;
    }
    // Two titles may slug identically; the index carries order and identity,
    // so filenames only need to be unique.
    for (let n = 2; files.has(path); n++) path = path.replace(/\.geml$/, "") .replace(/-\d+$/, "") + `-${n}.geml`;
    order.push(path);

    // The page's identity, verbatim — reconstruction reads THIS; the heading
    // below is presentation, not data.
    let out = gemlBlock("code", ".page-meta lang=edn", edn(page));
    if (mapSize(entryRest) > 0) out += gemlBlock("code", ".page-extra lang=edn", edn(entryRest));
    if (typeof title === "string") out += `\n# ${title}\n\n`;

    const walk = (bs, level) => {
      for (const b of bs) {
        const btitle = mapGet(b, "block/title");
        const children = mapGet(b, "build/children") ?? [];
        const meta = mapWithout(b, ["block/title", "build/children"]);
        // The uuid stays inside the meta EDN too — losslessness never depends
        // on the id attribute; `{#uuid}` is the ADDRESS.
        const u = uuidOf(mapGet(b, "block/uuid"));
        if (u) uuidPath.set(u.toLowerCase(), path);
        const id = u ? `#${u} ` : "";
        out += gemlBlock("text", `${id}level=${level}`, typeof btitle === "string" ? btitle : edn(btitle ?? null));
        if (mapSize(meta) > 0) out += gemlBlock("code", ".block-meta lang=edn", edn(meta));
        walk(children, level + 1);
      }
    };
    walk(blocks, 1);
    files.set(path, out);
  });

  // Page order is content (:pages-and-blocks is a vector), but it lives in the
  // index rather than in filename prefixes: the tree stays human-shaped, and
  // one addressable block carries what the machine needs.
  files.set("graph.geml",
    '=== meta\ntitle = "Logseq graph index"\n===\n\n' +
    gemlBlock("data", "#page-order", JSON.stringify(order, null, 1)));

  // Last, because a reference needs to know where every block ended up.
  return translateRefsOut(files, uuidPath);
}

// --- import: GEML files → EDN ------------------------------------------------

// The parser library is injected ({parse, addressedUnits, sliceUnit} from
// @geml/geml), so this module stays dependency-light and the caller decides
// which parser build to trust.
//
// Why two reads per document: `parse` gives structure (types, classes, attrs),
// but a `text` block is FLOW content — its node carries parsed inlines, not
// raw bytes. The bytes come from `sliceUnit` over the block's span, exactly the
// route `geml get` takes. Blocks arrive in document order from both, so the
// two sequences zip.
export function gemlFilesToEdn(filesIn, lib) {
  const { parse, addressedUnits, sliceUnit } = lib;
  // Checked references go back to the `[[uuid]]` Logseq stores, before any
  // parsing: the graph is the other side of the translation, not a party to it.
  // Vaults written before the translation existed hold bare uuids already, and
  // this leaves those alone — the same import handles both.
  const files = new Map([...filesIn].map(([path, text]) => [path, translateRefsIn(text)]));
  const blocksOf = (text) => {
    const nodes = parse(text).children.filter((c) => c.kind === "block");
    const units = [...addressedUnits(text)].map((a) => a.unit).filter((u) => u.kind === "block");
    return nodes.map((node, i) => ({
      node,
      body: () => {
        const s = sliceUnit(text, units[i].span, "body");
        return s.endsWith("\n") ? s.slice(0, -1) : s;
      },
    }));
  };

  const onto = blocksOf(files.get("ontology.geml") ?? "");
  const grab = (blocks, id) => {
    const b = blocks.find((x) => x.node.id === id);
    return b ? parseEDNString(b.body()) : undefined;
  };
  const properties = grab(onto, "properties");
  const classes = grab(onto, "classes");
  const graphExtra = grab(onto, "graph-extra");

  // Page order comes from the graph.geml index; a tree without one (hand-built,
  // or index deleted) falls back to path order, which at least is deterministic.
  const indexBlocks = files.has("graph.geml") ? blocksOf(files.get("graph.geml")) : [];
  const orderBlock = indexBlocks.find((b) => b.node.id === "page-order");
  const pagePaths = (orderBlock && Array.isArray(orderBlock.node.value)
    ? orderBlock.node.value
    : [...files.keys()].filter((p) => p.startsWith("pages/") || p.startsWith("journals/")).sort()
  ).filter((p) => files.has(p));
  const pages = pagePaths.map((p) => {
    let page = { map: [] };
    let entryRest = { map: [] };

    // Flat level-tagged sequence → tree. Each frame owns the children vector
    // its node's `:build/children` will become; the vector is written into the
    // node only if anything landed in it.
    const roots = [];
    const stack = [{ level: 0, node: null, children: roots }];
    const close = (frame) => {
      if (frame.node && frame.children.length > 0) frame.node.map.push([kw("build/children"), frame.children]);
    };

    let last = null;
    for (const b of blocksOf(files.get(p))) {
      const { type, classes, attrs } = b.node;
      if (type === "code" && classes.includes("page-meta")) { page = parseEDNString(b.body()); continue; }
      if (type === "code" && classes.includes("page-extra")) { entryRest = parseEDNString(b.body()); continue; }
      if (type === "code" && classes.includes("block-meta")) {
        // Meta re-attaches to the block it followed. Splicing the entries into
        // the node keeps one map, as the export wrote it.
        if (last) last.map.push(...mapEntries(parseEDNString(b.body())));
        continue;
      }
      if (type !== "text") continue;

      const level = typeof attrs["level"] === "number" ? attrs["level"] : 1;
      const node = { map: [[kw("block/title"), b.body()]] };
      while (stack[stack.length - 1].level >= level) close(stack.pop());
      stack[stack.length - 1].children.push(node);
      stack.push({ level, node, children: [] });
      last = node;
    }
    while (stack.length > 1) close(stack.pop());

    const entry = { map: [[kw("page"), page]] };
    if (roots.length > 0) entry.map.push([kw("blocks"), roots]);
    entry.map.push(...mapEntries(entryRest));
    return entry;
  });

  const out = { map: [[kw("pages-and-blocks"), pages]] };
  if (properties !== undefined) out.map.push([kw("properties"), properties]);
  if (classes !== undefined) out.map.push([kw("classes"), classes]);
  if (graphExtra !== undefined) out.map.push(...mapEntries(graphExtra));
  return toEDNString(out);
}
