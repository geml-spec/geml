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
//      EDN inside `data {format=edn}` blocks — carried, not dropped.
//   2. ADDRESSABLE where it pays. A block's title becomes the body of a
//      `=== text` block; a block that has a uuid keeps it as `{#uuid}`, so
//      `geml get/set` address exactly the blocks Logseq itself considers
//      addressable (uuids are only exported for referenced blocks).
//
//      Those carrier blocks are `data`, not `code`, and that is the difference
//      between carrying and addressing: a `code` body is raw, so a block's
//      properties had no address at all — only the blob's content hash, which
//      changes the moment you edit one. As `data {format=edn}` the map is a
//      value tree, `#meta-<uuid>` names it, and one property is a coordinate
//      away: `geml set '#meta-<uuid>[":build/properties"][":a/b"]'`.
//
//      A vault written before this carries `code {lang=edn}`; the import reads
//      both, because it reads the body TEXT rather than the parser's value
//      tree — which also keeps this module's EDN reading its own, independent
//      of the (deliberately unspecified) one `geml`'s `edn` engine uses.
//
// Structure choice: the outline tree is a FLAT sequence of blocks in
// depth-first order, each carrying `.level-N` — a complete encoding of the tree
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
/**
 * EDN, laid out to be read. `toEDNString` emits one line, and a block with
 * seven properties came out as a 330-character wall — technically fine, and the
 * reason a reader of these files reported that round-tripping "doesn't count"
 * if you never actually open them.
 *
 * Only the WHITESPACE BETWEEN entries is ours: every key and every leaf value
 * still goes through `toEDNString`, so nothing here can mis-quote a string or
 * lose a tagged literal. EDN treats inter-entry whitespace as insignificant, so
 * this changes how the file reads and not what it means.
 *
 * Maps break one entry per line and nest; vectors and sets stay inline, because
 * in this data they are short (a `#{"infra" "logseq"}` reads worse split up).
 */
const isMap = (v) => v !== null && typeof v === "object" && Array.isArray(v.map);
const edn = (v, indent = "") => {
  if (!isMap(v)) return toEDNString(v);
  const entries = mapEntries(v);
  if (entries.length === 0) return "{}";
  const pad = indent + " ";
  const lines = entries.map(([k, val]) => {
    const key = toEDNString(k);
    return pad + key + " " + edn(val, pad + " ".repeat(key.length + 1));
  });
  return "{" + lines.join("\n").slice(pad.length) + "}";
};

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
// The `#id` of an addressed block IS its Logseq uuid (see the export), so the
// import reads it back from there rather than from a repeated copy.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// A Logseq block reference, as the DB export writes it: `[[<uuid>]]` inside a
// block's title. A PAGE reference looks identical apart from its target
// (`[[Some Page]]`), so the uuid shape is the whole discriminator — matching
// anything looser would rewrite people's page links.
const REF_BARE =/\[\[([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]\]/g;
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

// Outline depth rides on a CLASS (`.level-3`), not an attribute. It has to ride
// somewhere: Logseq's blocks are a tree (`:build/children`), a GEML document's
// top level is a flat sequence, and the depth is the whole encoding of the tree
// — the import below rebuilds `:build/children` from it. As an attribute it was
// `level=3`, which drew `unknown attribute 'level' for block type 'text'` from
// `geml check` on EVERY block: a wall of warnings on a vault the README tells
// people to check, and noise is how a check loses its authority. Classes are
// free-form by design, so `.level-3` says the same thing silently.
//
// Vaults written before this carry `level=N`; the reader below accepts both, so
// an older vault still imports. The first sync after upgrading rewrites every
// block's head line — one real diff, once.
const LEVEL_CLASS = /^level-(\d+)$/;
function levelOf(classes, attrs) {
  for (const c of classes ?? []) {
    const m = LEVEL_CLASS.exec(c);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 1) return n;
    }
  }
  // Pre-class vaults, and anything that lost its depth: treat as a root block.
  return typeof attrs?.["level"] === "number" ? attrs["level"] : 1;
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
  if (properties !== undefined) onto += gemlBlock("data", "#properties format=edn", edn(properties));
  if (classes !== undefined) onto += gemlBlock("data", "#classes format=edn", edn(classes));
  if (mapSize(rest) > 0) onto += gemlBlock("data", "#graph-extra format=edn", edn(rest));
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
    let out = gemlBlock("data", "#page-meta .page-meta format=edn", edn(page));
    if (mapSize(entryRest) > 0) out += gemlBlock("data", "#page-extra .page-extra format=edn", edn(entryRest));
    if (typeof title === "string") out += `\n# ${title}\n\n`;

    const walk = (bs, level) => {
      for (const b of bs) {
        const btitle = mapGet(b, "block/title");
        const children = mapGet(b, "build/children") ?? [];
        const u = uuidOf(mapGet(b, "block/uuid"));
        // The uuid is NOT repeated inside the meta EDN. It used to be, so that
        // losslessness never depended on the id attribute — but that made every
        // addressed block say its uuid twice, once as `{#uuid}` and once in a
        // blob directly beneath it, and a reader of these files is entitled to
        // ask which one is real. `{#uuid}` is the address, and the import below
        // reconstructs `:block/uuid` from it.
        //
        // Dropping it only where `u` exists matters: a block without a uuid gets
        // no `#id`, so there would be nothing to reconstruct from.
        const meta = mapWithout(b, u ? ["block/title", "build/children", "block/uuid"]
          : ["block/title", "build/children"]);
        if (u) uuidPath.set(u.toLowerCase(), path);
        const id = u ? `#${u} ` : "";
        out += gemlBlock("text", `${id}.level-${level}`, typeof btitle === "string" ? btitle : edn(btitle ?? null));
        // `data {format=edn}`, not `code {lang=edn}`. A `code` body is RAW: no
        // value tree, so no coordinate reaches inside it, so this block's
        // properties had no address at all — only the blob's content hash,
        // which changes the moment you edit one. As a `data` block the whole
        // map is one addressable value, and `#meta-<uuid>` names it, so
        // `geml set '#meta-<uuid>[":build/properties"][":user.property/status"]'`
        // writes ONE property and leaves the rest of the file alone.
        //
        // The id is derived from the block's own uuid rather than being a
        // counter: it has to survive a re-export that reorders nothing but the
        // file, and it has to be findable from the block you are looking at.
        // A block with no uuid gets no id here either — same rule as its text
        // block, and the same reason (Logseq only exports uuids for blocks it
        // considers addressable).
        if (mapSize(meta) > 0) {
          out += gemlBlock("data", `${u ? `#meta-${u} ` : ""}.block-meta format=edn`, edn(meta));
        }
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
      // The meta blocks are `data {format=edn}` now; a vault written before
      // that carries `code {lang=edn}`, and both read the same way here —
      // the body is EDN text either way, and this reads the TEXT rather than
      // the parser value tree, so the reading stays the plugin’s own.
      const isMeta = (cls) => (type === "data" || type === "code") && classes.includes(cls);
      if (isMeta("page-meta")) { page = parseEDNString(b.body()); continue; }
      if (isMeta("page-extra")) { entryRest = parseEDNString(b.body()); continue; }
      if (isMeta("block-meta")) {
        // Meta re-attaches to the block it followed. Splicing the entries into
        // the node keeps one map, as the export wrote it.
        //
        // Nothing filters `:block/uuid` out of the blob here, and that is a
        // choice: the export gives the uuid exactly one home, `{#id}`, so a
        // blob carrying one too would be a bug in the export — and splicing it
        // in produces an EDN map with a duplicate key, which Logseq's own
        // `validate` refuses. Silently dropping the second copy would hide
        // that. The invariant is ours to hold, not to paper over.
        if (last) last.map.push(...mapEntries(parseEDNString(b.body())));
        continue;
      }
      if (type !== "text") continue;

      const level = levelOf(classes, attrs);
      const node = { map: [[kw("block/title"), b.body()]] };
      // `{#uuid}` is where the uuid lives now, so read it back from there. The
      // id has to LOOK like a uuid: a hand-written GEML block may carry any id,
      // and inventing `:block/uuid "intro"` would hand Logseq a malformed graph.
      // Ordering matches what the export wrote (title, then uuid), which keeps
      // the emitted EDN diff-friendly as well as structurally equal.
      // The id is `node.id`, not an entry in `attrs` — the parser lifts `#id`
      // out of the attribute object, which is why `grab()` above matches on it.
      const uuid = b.node.id ?? "";
      if (UUID_RE.test(uuid)) node.map.push([kw("block/uuid"), { tag: "uuid", val: uuid }]);
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
