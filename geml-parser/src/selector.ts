// Block selectors — the one syntax `get`, `set` and `history get` all address
// blocks with (design: docs/design/specs/2026-08-04-geml-get-set-selector-design-change.md).
//
// §2's rule: a selector is a FILTER over blocks, `{…}` holds keys, and the same
// abbreviation rule applies twice — `#id` is `{#id}` short, `@<hex>` is
// `{@<hex>}` short. Both are keys; they differ only in selectivity.
//
// This module is PURE: it parses selector text and matches it against a unit
// index the caller supplies. It deliberately imports nothing from geml.ts —
// that module runs the CLI dispatch on import, so depending on it here would
// turn `import { parseSelector }` into "run the CLI". The scan that produces
// `Unit[]` therefore stays in geml.ts (one walk, several sinks) and the
// selector logic stays here, where it can be unit-tested on plain data.

import { createHash } from "node:crypto";

// Structurally identical to geml.ts's Span; declared here so this module stays
// import-free of geml.ts (see the header note).
export interface Span { start: number; end: number }

// One addressable unit of a document, in document order. `type` is present for
// fenced blocks, `level`/`text` for headings. `id` is OPTIONAL — that a block
// may carry no id is the whole reason `@<hex>` exists (§1).
export interface Unit {
  span: Span;
  kind: "block" | "heading" | "footnote";
  type?: string;
  id?: string;
  level?: number;
  text?: string;
}

export type Selector =
  // No selector: the empty filter, which LISTS (§6).
  | { form: "list" }
  // `#id` / `id` / `## Heading` — resolved to an id by the caller, which is the
  // only layer that can parse the document to match heading text (§2).
  | { form: "id"; raw: string }
  // `=== type` — type filter, 0..N matches (§2).
  | { form: "type"; type: string }
  // `=== type@<hex>[~n]` or `@<hex>[~n]` — content key, ≤1 match. `type`
  // undefined means the short form, which carries no type check (§3.3).
  | { form: "content"; type?: string; hex: string; nth: number }
  // `L<n>` or `L<n>-<m>` — position, ≤1 match: the SMALLEST unit that fully
  // contains the range. Not a key like the others; it exists because the
  // listing already PRINTS `L27-58` and §6.2 says every address it prints
  // pastes straight back. It is also the bridge every foreign tool needs —
  // editors, linters, `git diff` hunks and stack traces speak line numbers and
  // nothing else. `#L27` is still an id, so a block actually named `L27` stays
  // reachable.
  | { form: "line"; from: number; to: number }
  // `=== type {k=v}` with a key other than `#id` — DECLARED by §2, not
  // implemented this round; the caller reports it as a usage error (§7).
  | { form: "attr"; type: string; key: string };

// The content address's hash. Same spelling as the `.gemlhistory` unit key
// (history.ts:112) because both answer the same question — how to address a
// unit that carries no id. The VALUES are deliberately not promised to match:
// history hashes a tile (trailing blank lines included), this hashes a block's
// span (§3.3). Do not port an address from one layer to the other.
export function sha8(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex").slice(0, 8);
}

// Each optional part carries its OWN trailing whitespace. Written flat —
// `…[ \t]*(@…)?[ \t]*(\{.*\})?[ \t]*$` — three runs competed for the same tabs
// and the engine tried every way to divide them: `=== note` plus 8k tabs and
// one stray byte took 84 SECONDS. Nested, each absent part leaves exactly one
// run and the match is immediate. Same language: 150k random strings, identical
// groups. (Mirrors geml.ts's FENCE_OPEN, which had the same shape.)
const FENCE_SEL = /^={3,}[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*(?:(@[0-9a-fA-F]{1,}(?:~\d+)?)[ \t]*)?(?:(\{.*\})[ \t]*)?$/;
const BARE_AT = /^@([0-9a-fA-F]+)(?:~(\d+))?$/;
const BARE_LINE = /^[Ll](\d+)(?:-(\d+))?$/;

// Parse selector TEXT. Never touches a document: every form is decided by
// lexis alone, which is also what keeps the two selector namespaces on
// `history get <file> <rev> <selector>` from overlapping (history design §10.2).
// `attrsIdOf` lets the caller reuse its own `{…}` parser (parseAttrs) rather
// than this module growing a second one.
export function parseSelector(raw: string | undefined, attrsIdOf: (braces: string) => string | undefined): Selector {
  if (raw === undefined || raw.trim() === "") return { form: "list" };
  const s = raw.trim();

  const bare = BARE_AT.exec(s);
  if (bare) return { form: "content", hex: bare[1]!.toLowerCase(), nth: bare[2] ? Number(bare[2]) : 0 };

  const fence = FENCE_SEL.exec(s);
  if (fence) {
    const type = fence[1]!;
    const at = fence[2];
    const braces = fence[3];
    if (braces !== undefined) {
      // `=== type {#id}` is the id key written out in full — redundant but
      // legal (§2). Any OTHER key is the declared-not-implemented form.
      const id = attrsIdOf(braces);
      if (id !== undefined) return { form: "id", raw: `#${id}` };
      return { form: "attr", type, key: firstKey(braces) };
    }
    if (at !== undefined) {
      const m = BARE_AT.exec(at)!;
      return { form: "content", type, hex: m[1]!.toLowerCase(), nth: m[2] ? Number(m[2]) : 0 };
    }
    return { form: "type", type };
  }

  // Checked before the id fallthrough, so a bare `L27` is a position. An id
  // that really is spelled `L27` keeps its explicit key form, `#L27` — the
  // same "short form for the common case, key form always available" rule
  // `@<hex>` already relies on.
  const line = s.match(BARE_LINE);
  if (line) {
    const from = Number(line[1]);
    const to = line[2] !== undefined ? Number(line[2]) : from;
    // Reject rather than clamp: `L0` and `L10-5` are typos, and a selector that
    // silently means something else is worse than one that refuses.
    if (from >= 1 && to >= from) return { form: "line", from, to };
  }

  // Anything else is an id or a pasted heading line; the caller resolves it.
  return { form: "id", raw: s };
}

// The first key inside `{…}`, for the §7 error message. Best-effort: it only
// has to name what the caller typed, and a class (`.warn`) is reported as
// written so the message does not claim a key that is not there.
function firstKey(braces: string): string {
  const inner = braces.replace(/^\{/, "").replace(/\}$/, "").trim();
  const m = /^([.#]?[A-Za-z_][A-Za-z0-9_-]*)/.exec(inner);
  return m ? m[1]! : inner.split(/[\s=]/)[0] ?? "";
}

// A unit decorated with its content address. `nth` is the occurrence index
// among byte-identical units: document order first is 0 (printed without a
// suffix), then `~1`, `~2`… A serial number is safe HERE, unlike `=== note[2]`
// (§3.1), because colliding units are byte-identical — picking the wrong one
// changes position, never content.
export interface Addressed { unit: Unit; hex: string; nth: number }

export function addressUnits(units: Unit[], textOf: (u: Unit) => string): Addressed[] {
  const seen = new Map<string, number>();
  return units.map((unit) => {
    // LF-normalized so a CRLF checkout and an LF one address the same block.
    const hex = sha8(textOf(unit).replace(/\r\n?/g, "\n"));
    const nth = seen.get(hex) ?? 0;
    seen.set(hex, nth + 1);
    return { unit, hex, nth };
  });
}

// §6.1 — the SHORTEST address that identifies this unit uniquely, which is what
// the listing prints. `#id` when it has one; else the bare type when the
// document holds exactly one block of it; else the content address. The three
// cases are one rule ("shortest unique"), not three rules.
export function shortestAddress(a: Addressed, all: Addressed[]): string {
  const u = a.unit;
  if (u.id !== undefined) return `#${u.id}`;
  if (u.type === undefined) return `@${a.hex}${a.nth ? `~${a.nth}` : ""}`;
  const sameType = all.filter((x) => x.unit.type === u.type).length;
  if (sameType === 1) return `=== ${u.type}`;
  return `=== ${u.type}@${a.hex}${a.nth ? `~${a.nth}` : ""}`;
}

// Match a content selector. Returns the unit, or a reason it did not match —
// the two failures are told apart because they mean different things: a stale
// address is the optimistic-concurrency signal (§3.2), while a type mismatch
// means the caller's own prefix disagrees with what it found (§3.3), and
// silently ignoring the prefix would make it a decoration that can be wrong.
export type ContentHit =
  | { ok: true; unit: Unit }
  | { ok: false; why: "no-match" }
  | { ok: false; why: "wrong-type"; found: string };

export function matchContent(sel: Extract<Selector, { form: "content" }>, all: Addressed[]): ContentHit {
  const hit = all.find((a) => a.hex === sel.hex && a.nth === sel.nth);
  if (!hit) return { ok: false, why: "no-match" };
  if (sel.type !== undefined && hit.unit.type !== sel.type) {
    return { ok: false, why: "wrong-type", found: hit.unit.type ?? hit.unit.kind };
  }
  return { ok: true, unit: hit.unit };
}

// Where to send a caller whose selector found nothing: the listing IS the
// discovery command, and every address it prints pastes straight back (§6.2).
// One place, so `get`, `set` and `history get` all point at the same next step.
export function discoveryHint(where: string): string {
  return ` — run \`geml get ${where}\` to list every addressable block`;
}

// Match a position selector: the SMALLEST unit that fully contains the range.
// "Smallest" is what makes this ≤1 match instead of N. Spans nest — a heading's
// span covers its whole section, so line 30 of the comparison doc sits inside
// both `#capability-matrix` (L25-65) and `#caps` (L27-58) — and returning both
// would emit the inner block twice, once alone and once inside its section.
// The innermost is also the answer the question actually wants: a line number
// arrived from grep or a stack trace, and the caller means "the thing I have to
// edit", which is never the enclosing chapter.
export function matchLine(sel: Extract<Selector, { form: "line" }>, all: Addressed[]): Unit | undefined {
  let best: Unit | undefined;
  for (const a of all) {
    const start = a.unit.span.start + 1; // spans are 0-based; selectors are 1-based, as the listing prints them
    const end = a.unit.span.end;
    if (start > sel.from || end < sel.to) continue; // must FULLY contain the range
    if (best === undefined || end - start < best.span.end - (best.span.start + 1)) best = a.unit;
  }
  return best;
}

// Match a type filter: every block of that type in document order. Blocks that
// carry an id are INCLUDED — the selector says nothing about ids, so filtering
// by whether one is present would be a rule nobody wrote down (§2).
export function matchType(type: string, all: Addressed[]): Unit[] {
  return all.filter((a) => a.unit.type === type).map((a) => a.unit);
}
