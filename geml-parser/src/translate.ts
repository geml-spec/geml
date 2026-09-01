// GEP 0010 — projecting a document along the LANGUAGE axis.
//
// A translated document is not a copy but a projection: `=== embed` blocks that
// name the source and carry `lang=`, so the text lives in exactly one place and
// the view is derived. This module is the half that decides WHAT gets translated,
// and it is deliberately separate from where translations come from — the
// `Translator` below is a function the caller supplies.
//
// The policy is per TYPE, not per body mode, because body mode almost draws the
// line and then fails on one pair: `table` and `data` are both raw, and a table of
// prose wants translating while a `data` body IS the value the model carries, so
// translating it is data corruption.
//
// Translated: heading text, paragraph text, list items, flow bodies, `caption=`.
// Never: `code`, `math`, `diagram`, `data` and `embed` bodies; every id; every
// attribute key; and every value that NAMES a thing rather than saying something.
//
// The inline type makes that second rule fall out rather than needing a list:
// `text` and an image's `alt` say something, so they are translated; `code`,
// `math`, a link's `href`/`doc`/`anchor` and an image's `src` name things, so they
// are not — while `emph`/`strong`/`strike`/`link` children are just structure to
// walk through, which is what keeps a translated sentence's emphasis and links.
import type { Block, ListItem, Value } from "./geml.js";
import type { TableCell, TableModel } from "./table.js";
import type { Inline } from "./inline.js";

/** Supplied by the caller: source text and target language in, translation out. */
export type Translator = (text: string, lang: string) => string;

/** `translate-to="none"` holds one embed back from translation (GEP 0010). */
export const HELD_BACK = "none";

/**
 * The language axis of a projection, resolved for one embed. ONE definition,
 * because the browser and the Markdown export must not disagree about which of
 * three things a document meant.
 *
 * A target language on `=== meta` is the document's default, the same key on an
 * `embed` overrides it, and `none` there holds that embed back.
 *
 * There is deliberately no companion key naming WHO translates. There is one
 * engine — the browser's built-in Translator — so a key selecting between engines
 * would parse, do nothing, and read as supported. `translator=` is reserved for
 * when there is a second one, and until then a document should not write it.
 *
 * Returns the target language, or null when this embed is not to be translated.
 */
export function resolveTarget(
  docMeta: Record<string, unknown> | undefined,
  embedAttrs: Record<string, unknown> | undefined,
): string | null {
  const own = embedAttrs?.["translate-to"];
  if (typeof own === "string") return own.trim() === HELD_BACK ? null : own.trim();
  const fallback = docMeta?.["translate-to"];
  if (typeof fallback !== "string" || fallback.trim() === "" || fallback.trim() === HELD_BACK) return null;
  return fallback.trim();
}


export function translateInlines(inlines: Inline[], lang: string, t: Translator): Inline[] {
  return inlines.map((n): Inline => {
    switch (n.type) {
      case "text":
        return { type: "text", value: t(n.value, lang) };
      case "emph":
      case "strong":
      case "strike":
        return { ...n, children: translateInlines(n.children, lang, t) };
      case "link":
        // Children only: `href`, `doc` and `anchor` name a target.
        return { ...n, children: translateInlines(n.children, lang, t) };
      case "image":
        // `alt` is prose a reader hears; `src` is a path.
        return { ...n, alt: t(n.alt, lang) };
      default:
        // code, math, break — a verbatim atom or no text at all.
        return n;
    }
  });
}

// `text` is the FLAT form of `inlines`, and translating it directly would send
// the raw source — code spans, link targets and all — to the translator, which is
// exactly what the policy forbids. Every renderer draws the body from `inlines`;
// `text` is what an auto-reference (`[[#id]]`) shows as a label. So it is derived
// from the translated inlines instead, and a code span comes through verbatim.
function flatten(inlines: Inline[]): string {
  let out = "";
  for (const n of inlines) {
    switch (n.type) {
      case "text": out += n.value; break;
      case "code":
      case "math": out += n.value; break;
      case "image": out += n.alt; break;
      case "break": out += " "; break;
      case "emph":
      case "strong":
      case "strike":
      case "link": out += flatten(n.children); break;
      // `autoref` and `project` carry no text of their own — each shows the
      // target's, resolved at render time — so they add nothing to the flat form.
      default: break;
    }
  }
  return out;
}

function translateItems(items: ListItem[], lang: string, t: Translator): ListItem[] {
  return items.map((it) => ({
    ...it,
    ...(({ inlines }) => ({ inlines, text: flatten(inlines) }))({ inlines: translateInlines(it.inlines, lang, t) }),
    ...(it.children !== undefined ? { children: translateBlocks(it.children, lang, t) } : {}),
  }));
}

// `caption=` is the one attribute VALUE that says something rather than naming
// something, and §4 makes it valid on every typed block.
function translateAttrs(attrs: Record<string, Value>, lang: string, t: Translator): Record<string, Value> {
  if (typeof attrs["caption"] !== "string") return attrs;
  return { ...attrs, caption: t(attrs["caption"] as string, lang) };
}

// A table of prose is the case body mode gets wrong — `table` and `data` are both
// raw, and only one of them holds sentences. Column headers and body cells are
// prose; a cell that carries a NUMBER is left alone, because `value` is what the
// model computes over and a translated digit is data corruption.
function translateTable(t0: TableModel, lang: string, t: Translator): TableModel {
  const cell = (c: TableCell): TableCell =>
    c.value !== undefined || c.computed === true
      ? c
      : { ...c, text: t(c.text, lang), inlines: translateInlines(c.inlines, lang, t) };
  return {
    ...t0,
    ...(t0.caption !== undefined ? { caption: t(t0.caption, lang) } : {}),
    columns: t0.columns.map((c) => t(c, lang)),
    rows: t0.rows.map((r) => r.map(cell)),
    ...(t0.summary !== undefined ? { summary: t0.summary.map(cell) } : {}),
  };
}

/**
 * A translated COPY of `blocks`. Never mutates: the caller's blocks come out of a
 * parse cache that other expansions read, and translating in place would poison
 * every later reader of the same document.
 */
export function translateBlocks(blocks: Block[], lang: string, t: Translator): Block[] {
  return blocks.map((b): Block => {
    switch (b.kind) {
      case "heading":
      case "paragraph": {
        const inlines = translateInlines(b.inlines, lang, t);
        return { ...b, inlines, text: flatten(inlines) };
      }
      case "list":
        return { ...b, items: translateItems(b.items, lang, t) };
      case "hidden":
        return b; // a `%%` line never reaches a reader
      case "block": {
        // A flow body is prose and recurses. A raw or data body is opaque by §3,
        // and the types that carry one — code, math, diagram, data, embed — are
        // exactly the ones this must not touch.
        const attrs = translateAttrs(b.attrs, lang, t);
        if (b.mode === "flow" && b.children !== undefined) {
          return { ...b, attrs, children: translateBlocks(b.children, lang, t) };
        }
        // The one raw body that IS prose. `data` shares the mode and must not
        // follow it here — its body is the value, not a sentence about one.
        if (b.type === "table" && b.table !== undefined) {
          return { ...b, attrs, table: translateTable(b.table, lang, t) };
        }
        return attrs === b.attrs ? b : { ...b, attrs };
      }
    }
  });
}
