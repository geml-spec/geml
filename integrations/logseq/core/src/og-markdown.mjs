// A GEML vault page → the Markdown a FILE-VERSION (OG) Logseq graph is made of.
//
// This is not "GEML converted to Markdown" — that is `geml <file> --to md`, and
// it belongs to the parser, not here. What this writes is Logseq's own dialect,
// so the output directory opens as a graph in the file version of the app:
//
//   - one bullet per block, two spaces of indent per outline level
//   - `id:: <uuid>` under a block that has one, which is how OG stores identity
//   - block references as `((uuid))` — OG's spelling of what the DB version
//     exports as `[[uuid]]` and the vault carries as a checked `[[#uuid]]`
//   - page references `[[Some Page]]` untouched: both versions spell those the
//     same way
//
// It is DELIBERATELY lossy, and one-way. Typed properties, tags, tables and
// data blocks have no OG equivalent, so they do not survive; the `.geml` tree
// stays the one that round-trips, and `restore` never reads this. What the
// Markdown mirror buys is a graph you can open in the old app, hand to a tool
// that reads nothing else, or keep as a copy your future self can still read.

const REF_TO_OG = /\[\[([^\[\]]*?)#([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]\]/g;
const LEVEL_CLASS = /^level-(\d+)$/;

/** Depth from the block's class, as the vault writes it; 1 when absent. */
function levelOf(node) {
  for (const c of node.classes ?? []) {
    const m = LEVEL_CLASS.exec(c);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 1) return n;
    }
  }
  return typeof node.attrs?.["level"] === "number" ? node.attrs["level"] : 1;
}

/**
 * One vault document → one OG Markdown page.
 *
 * @param {string} gemlText A page document (pages/… or journals/…).
 * @param {object} lib { parse, addressedUnits, sliceUnit } from @geml/geml.
 * @returns {string} Markdown, LF-terminated. Empty when the document holds no
 *   blocks OG can represent — the caller writes no file for that.
 */
export function gemlToOgMarkdown(gemlText, lib) {
  const { parse, addressedUnits, sliceUnit } = lib;
  const nodes = parse(gemlText).children.filter((c) => c.kind === "block");
  const units = [...addressedUnits(gemlText)].map((a) => a.unit).filter((u) => u.kind === "block");

  const out = [];
  nodes.forEach((node, i) => {
    // Only the text blocks are the outline. The EDN ride-alongs (.page-meta,
    // .page-extra, .block-meta) carry what OG has no shape for — skipped here,
    // which is exactly the documented lossiness.
    if (node.type !== "text") return;
    const raw = sliceUnit(gemlText, units[i].span, "body");
    const body = (raw.endsWith("\n") ? raw.slice(0, -1) : raw).replace(REF_TO_OG, (_m, _p, uuid) => `((${uuid}))`);

    const indent = "  ".repeat(levelOf(node) - 1);
    const lines = body.split("\n");
    out.push(`${indent}- ${lines[0] ?? ""}`);
    // A block's own continuation lines sit under its bullet, indented with it,
    // so the next bullet is unambiguous.
    for (const line of lines.slice(1)) out.push(`${indent}  ${line}`);
    if (node.id) out.push(`${indent}  id:: ${node.id}`);
  });

  return out.length > 0 ? out.join("\n") + "\n" : "";
}
