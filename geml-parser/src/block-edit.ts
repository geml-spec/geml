// Structural id-rewriting for `geml set`. `set #id` names the block to edit,
// so the content spliced in must ADOPT that id — whatever id it declared (or
// none). This module performs that rewrite parse-aware (per head form) rather
// than by blind byte replacement, touching ONLY the id: type, classes,
// attributes, body and the fence pairing all ride along unchanged.
//
// Deliberately self-contained — it imports only the shared attribute parser,
// never geml.ts: geml.ts's module body runs the CLI on import, so a back-import
// would fire the whole command line just by loading this helper.
import { parseAttrs } from "./attrs.js";

// The two head forms, spelled to MIRROR geml.ts's FENCE_OPEN / HEADING (same
// language) but with the id-bearing brace tail split out so the id can be
// rewritten while every other byte is copied verbatim:
//   FENCE_HEAD  g1 = `=== type`   g2 = ws   g3 = `{…}`?   g4 = trailing ws
//   HEAD_HEAD   g1 = `## text`    g2 = ws   g3 = `{…}`?   g4 = trailing ws
const FENCE_HEAD = /^(={3,}[ \t]+[A-Za-z][A-Za-z0-9_-]*)([ \t]*)(\{.*\})?([ \t]*)$/;
const HEAD_HEAD = /^(#{1,6}[ \t]+.*?)([ \t]*)(\{[^}]*\})?([ \t]*)$/;

// Split into physical lines while keeping each line's terminator, so join("")
// is byte-exact — the same boundaries geml.ts's splitLines() uses. A line ends
// at `\n`, `\r\n`, or a lone `\r`.
function splitLines(source: string): string[] {
  return source.split(/(?<=\n|\r(?!\n))/);
}

// Strip a single trailing terminator from one physical line.
function stripEnding(line: string): string {
  return line.replace(/(\r\n|\r|\n)$/, "");
}

// Rewrite the id inside a `{…}` attribute block to `#newId`, keeping the braces
// and every other class/attr byte. If no id is present, insert `#newId` as the
// first token. The id token sits at a token boundary (`{` or whitespace) and
// never inside a quoted value, so the anchored match can't disturb a value like
// `caption="#x"`.
function rewriteBraces(braces: string, newId: string): string {
  if (parseAttrs(braces).id !== undefined) {
    return braces.replace(/([{\s])#[^\s}]+/, `$1#${newId}`);
  }
  const inner = braces.slice(1, -1).replace(/^[ \t]*/, "");
  return `{#${newId}${inner.length ? " " + inner : ""}}`;
}

// Rewrite a HEAD line's id declaration to `#newId`. Handles both head forms and
// all id states: existing brace id, brace attrs without an id, and no braces at
// all (append `{#newId}`). A line that is neither form is returned unchanged.
function rewriteHead(head: string, newId: string): string {
  const rebuild = (m: RegExpExecArray): string => {
    const lead = m[1]!, ws = m[2] ?? "", braces = m[3], trail = m[4] ?? "";
    if (braces) return lead + ws + rewriteBraces(braces, newId) + trail;
    return `${lead} {#${newId}}${ws}${trail}`;
  };
  const f = FENCE_HEAD.exec(head);
  if (f) return rebuild(f);
  const h = HEAD_HEAD.exec(head);
  if (h) return rebuild(h);
  return head;
}

// Locate the block's HEAD: the first non-blank, non-`%%` line that opens a fence
// or a heading. Returns its line index, or -1 when the content has no head
// (pure prose, or a structural line that is not a head) — the caller decides
// what that means.
function findHead(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const t = stripEnding(lines[i]!);
    if (t.trim() === "" || /^[ \t]*%%/.test(t)) continue;
    if (FENCE_HEAD.test(t) || HEAD_HEAD.test(t)) return i;
    return -1; // the first structural line isn't a head: no addressable block
  }
  return -1;
}

// Rewrite the HEAD id of the first block in `blockSrc` to `newId`, across every
// head form:
//   • fence attrs `{#x …}`  -> `{#newId …}` (other classes/attrs kept)
//   • fence with attrs but no id, or no braces -> gains `{#newId}`
//   • labeled close `=== #x` -> `=== #newId` (renamed to match the open)
//   • heading `## T {#x}`    -> `## T {#newId}`
//   • heading auto-slug (no braces) -> `## T {#newId}` appended
// Only the id changes; type / classes / attrs / body / fence length are byte-
// preserved, as are line terminators. Content with no head is returned as-is.
export function normalizeBlockId(blockSrc: string, newId: string): string {
  const lines = splitLines(blockSrc);
  const hi = findHead(lines);
  if (hi < 0) return blockSrc;

  const headText = stripEnding(lines[hi]!);
  const headTerm = lines[hi]!.slice(headText.length);
  lines[hi] = rewriteHead(headText, newId) + headTerm;

  // For a fence carrying an id, a labeled close `=== #oldId` names that id and
  // must be renamed too — otherwise the open declares #newId while the close
  // still labels #oldId and the block no longer parses. The FIRST close wins
  // (plain equal-length OR labeled), matching geml.ts's fenceClose scan; a
  // plain close needs no rewrite.
  const f = FENCE_HEAD.exec(headText);
  const oldId = f && f[3] ? parseAttrs(f[3]).id : undefined;
  if (f && oldId !== undefined) {
    const openLen = /^=+/.exec(f[1]!)![0].length;
    for (let j = hi + 1; j < lines.length; j++) {
      const ct = stripEnding(lines[j]!);
      const trimmed = ct.replace(/[ \t]+$/, "");
      if (/^=+$/.test(trimmed) && trimmed.length === openLen) break; // plain close: done
      const cm = /^(={3,}[ \t]+#)([^\s}]+)([ \t]*)$/.exec(ct);
      if (cm && cm[2] === oldId) {
        lines[j] = cm[1]! + newId + cm[3]! + lines[j]!.slice(ct.length);
        break;
      }
    }
  }
  return lines.join("");
}
