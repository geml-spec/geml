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


/**
 * What a projection may pin instead of asking the engine: source term -> the
 * settled translation. See `glossaryFrom`.
 */
export interface TranslateOptions {
  /** `null` as well as absent: `glossaryFrom` answers null for a document that
   *  names no glossary, and passing that straight through must be legal. */
  glossary?: ReadonlyMap<string, string> | null;
}

// A placeholder is a private-use codepoint, a number, and a private-use
// codepoint. Private use because it must be inert in every target language: an
// engine has no rule for it, so it carries it along rather than translating it.
// `OPEN n CLOSE` stands for one thing; `OPEN /n CLOSE` closes a wrapper.
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
const ph = (n: number): string => OPEN + n + CLOSE;
const phEnd = (n: number): string => OPEN + "/" + n + CLOSE;
const PH_RE = new RegExp(OPEN + "(/?)([0-9]+)" + CLOSE, "g");

/** The four inline types that wrap children: the sentence flows THROUGH them. */
type Wrap = Extract<Inline, { type: "emph" | "strong" | "strike" | "link" }>;

type Slot =
  | { kind: "atom"; node: Inline }
  | { kind: "wrap"; node: Wrap }
  | { kind: "term"; text: string };

/** Glossary terms out of one run of text, longest first so `a b` beats `a`. */
function maskTerms(value: string, glossary: ReadonlyMap<string, string> | null | undefined, slots: Slot[]): string {
  if (glossary === undefined || glossary === null || glossary.size === 0) return value;
  let out = value;
  for (const term of [...glossary.keys()].sort((a, b) => b.length - a.length)) {
    if (term === "") continue;
    let at = out.indexOf(term);
    while (at !== -1) {
      out = out.slice(0, at) + ph(slots.length) + out.slice(at + term.length);
      slots.push({ kind: "term", text: glossary.get(term) as string });
      at = out.indexOf(term, at + 1);
    }
  }
  return out;
}

/**
 * One block's inline content as ONE string the engine can read as a sentence,
 * with everything it must not touch replaced by a placeholder it must carry.
 *
 * This is the half of GEP-0010's amendment that stops the engine seeing `" / "`
 * and `"), and a standard set of verbs ("`: emphasis and links become paired
 * placeholders rather than cutting the sentence into pieces, so word order and
 * punctuation are the engine's to get right.
 */
function mask(inlines: Inline[], opts: TranslateOptions, slots: Slot[]): string {
  let out = "";
  for (const n of inlines) {
    switch (n.type) {
      case "text":
        out += maskTerms(n.value, opts.glossary, slots);
        break;
      case "emph":
      case "strong":
      case "strike":
      case "link": {
        const at = slots.length;
        slots.push({ kind: "wrap", node: n });
        out += ph(at) + mask(n.children, opts, slots) + phEnd(at);
        break;
      }
      default:
        // code, math, image, break, autoref, project: verbatim atoms, or nodes
        // whose text is resolved elsewhere. An image's `alt` IS prose, but it is
        // a caption rather than part of this sentence, so it is translated on
        // its own below.
        out += ph(slots.length);
        slots.push({ kind: "atom", node: n });
        break;
    }
  }
  return out;
}

/**
 * The engine's answer back into inlines, or `null` when the answer cannot be
 * trusted: a placeholder dropped, duplicated, unknown or crossed. `null` is the
 * caller's signal to keep the source, which is the partial-output rule the
 * proposal already states — a sentence with a hole where its code span was is
 * worse than an untranslated one.
 */
function rebuild(text: string, slots: Slot[]): Inline[] | null {
  const seen = new Array<number>(slots.length).fill(0);
  const stack: Inline[][] = [[]];
  const open: number[] = [];
  let last = 0;
  const push = (s: string): void => { if (s !== "") (stack[stack.length - 1] as Inline[]).push({ type: "text", value: s }); };
  PH_RE.lastIndex = 0;
  for (let m = PH_RE.exec(text); m !== null; m = PH_RE.exec(text)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const n = Number(m[2]);
    const slot = slots[n];
    if (slot === undefined) return null;
    if (m[1] === "/") {
      if (open.pop() !== n) return null;              // crossed or unopened
      const kids = stack.pop() as Inline[];
      if (slot.kind !== "wrap") return null;
      (stack[stack.length - 1] as Inline[]).push({ ...slot.node, children: kids });
      continue;
    }
    if (++(seen[n] as number) > 1) return null;       // duplicated
    if (slot.kind === "wrap") { open.push(n); stack.push([]); continue; }
    if (slot.kind === "term") push(slot.text);
    else (stack[stack.length - 1] as Inline[]).push(slot.node);
  }
  push(text.slice(last));
  if (open.length !== 0 || stack.length !== 1) return null;   // unclosed
  for (let n = 0; n < slots.length; n++) if (seen[n] !== 1) return null;  // dropped
  return stack[0] as Inline[];
}

export function translateInlines(
  inlines: Inline[],
  lang: string,
  t: Translator,
  opts: TranslateOptions = {},
): Inline[] {
  const slots: Slot[] = [];
  const masked = mask(inlines, opts, slots);
  // Nothing but placeholders is nothing to translate — an engine handed a bare
  // marker has no sentence to work with and every answer it invents is noise.
  const prose = masked.replace(PH_RE, "");
  const answer = prose.trim() === "" ? masked : t(masked, lang);
  const out = rebuild(answer, slots);
  const kids = out ?? inlines;
  // An image's alt is prose of its own, whether or not the sentence around it
  // came back intact.
  return kids.map((n): Inline => (n.type === "image" ? { ...n, alt: n.alt === "" ? n.alt : t(n.alt, lang) } : n));
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

function translateItems(items: ListItem[], lang: string, t: Translator, opts: TranslateOptions): ListItem[] {
  return items.map((it) => ({
    ...it,
    ...(({ inlines }) => ({ inlines, text: flatten(inlines) }))({ inlines: translateInlines(it.inlines, lang, t, opts) }),
    ...(it.children !== undefined ? { children: translateBlocks(it.children, lang, t, opts) } : {}),
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
function translateTable(t0: TableModel, lang: string, t: Translator, opts: TranslateOptions): TableModel {
  const cell = (c: TableCell): TableCell =>
    c.value !== undefined || c.computed === true
      ? c
      : (({ inlines }) => ({ ...c, inlines, text: flatten(inlines) }))({ inlines: translateInlines(c.inlines, lang, t, opts) });
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
export function translateBlocks(
  blocks: Block[],
  lang: string,
  t: Translator,
  opts: TranslateOptions = {},
): Block[] {
  return blocks.map((b): Block => {
    switch (b.kind) {
      case "heading":
      case "paragraph": {
        const inlines = translateInlines(b.inlines, lang, t, opts);
        return { ...b, inlines, text: flatten(inlines) };
      }
      case "list":
        return { ...b, items: translateItems(b.items, lang, t, opts) };
      case "hidden":
        return b; // a `%%` line never reaches a reader
      case "block": {
        // A flow body is prose and recurses. A raw or data body is opaque by §3,
        // and the types that carry one — code, math, diagram, data, embed — are
        // exactly the ones this must not touch.
        const attrs = translateAttrs(b.attrs, lang, t);
        if (b.mode === "flow" && b.children !== undefined) {
          return { ...b, attrs, children: translateBlocks(b.children, lang, t, opts) };
        }
        // The one raw body that IS prose. `data` shares the mode and must not
        // follow it here — its body is the value, not a sentence about one.
        if (b.type === "table" && b.table !== undefined) {
          return { ...b, attrs, table: translateTable(b.table, lang, t, opts) };
        }
        return attrs === b.attrs ? b : { ...b, attrs };
      }
    }
  });
}

/**
 * The glossary a projection's `=== meta` points at, or `null` when it names
 * none.
 *
 * `glossary=` is a REFERENCE: `#id` names a table in this document — the shape a
 * projection normally uses, since a settled translation is a property of the
 * translation and not of the source — and a cross-document form is resolved by
 * the caller, which is the half that knows how to load a document.
 *
 * The table is read as two columns: the source term, and the term to use. A row
 * missing either side is skipped rather than half-applied.
 */
export function glossaryFrom(blocks: Block[], meta: Record<string, unknown> | undefined): Map<string, string> | null {
  const named = meta?.["glossary"];
  if (typeof named !== "string" || named.trim() === "") return null;
  const id = named.trim().startsWith("#") ? named.trim().slice(1) : null;
  if (id === null) return null;                       // cross-document: the caller's to resolve
  const found = blocks.find((b) => b.kind === "block" && b.id === id && b.table !== undefined);
  const table = (found as { table?: TableModel } | undefined)?.table;
  if (table === undefined) return null;
  const out = new Map<string, string>();
  for (const row of table.rows) {
    const term = row[0]?.text?.trim();
    const to = row[1]?.text?.trim();
    if (term !== undefined && to !== undefined && term !== "" && to !== "") out.set(term, to);
  }
  return out.size === 0 ? null : out;
}
