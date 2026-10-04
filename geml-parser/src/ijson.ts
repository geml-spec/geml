// GEML reference parser — the value domain's limits (§3.2).
//
// A `data` block's value tree is JSON's value domain as I-JSON (RFC 7493)
// draws it. Plain JSON leaves three things to the reader, and two processors
// reading one body could build two trees from them:
//
//   · a member name that repeats in one object (JSON.parse keeps the last;
//     another reader keeps the first, or refuses);
//   · a string holding a lone surrogate (`"\ud800"` — a JS string carries it,
//     a UTF-8 string cannot);
//   · a number past binary64's range (`1e400` — JSON.parse makes it Infinity,
//     which JSON itself then writes as `null`).
//
// Each is a parse error here, so a body means one tree in every processor. A
// number inside the range is its nearest binary64 value, which is what every
// reader computes — so `1.0` and `1` are one value, and an integer past 2^53
// is rounded rather than refused.

import { DATA_DEPTH } from "./bounds.js";

// Under the `u` flag a paired surrogate is one astral code point, so only a
// lone one is in category Cs.
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * The offset of the bracket that opens level DATA_DEPTH + 1, or -1. Strings are skipped.
 * JSON.parse takes fifty thousand levels in a hundred kilobytes, and the first
 * recursive reader after it — a coordinate, the serializer — then overflows
 * the stack; the yaml and edn readings stop at the same depth.
 */
export function tooDeep(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') { i++; while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1; continue; }
    if (c === "{" || c === "[") { if (++depth > DATA_DEPTH) return i; continue; }
    if (c === "}" || c === "]") depth--;
  }
  return -1;
}

/** What a JSON text the JSON grammar accepts breaks of I-JSON, and where. */
export interface DomainFault { why: string; offset: number }

/**
 * Scan a text JSON.parse already ACCEPTED for what I-JSON forbids. It reads
 * tokens only — the grammar was checked by the parse — so it never decides
 * whether the text is JSON, only which valid JSON is outside the domain.
 */
export function iJsonFault(text: string): DomainFault | null {
  // One frame per open object, holding the names seen so far; `null` for an array.
  const stack: (Set<string> | null)[] = [];
  let expectKey = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "{") { stack.push(new Set()); expectKey = true; i++; continue; }
    if (c === "[") { stack.push(null); expectKey = false; i++; continue; }
    if (c === "}" || c === "]") { stack.pop(); expectKey = false; i++; continue; }
    if (c === ",") { expectKey = stack[stack.length - 1] instanceof Set; i++; continue; }
    if (c === ":") { expectKey = false; i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const s = JSON.parse(text.slice(i, j + 1)) as string;
      if (LONE_SURROGATE.test(s)) return { why: "a string holds a lone surrogate, which no Unicode text can carry", offset: i };
      const names = stack[stack.length - 1];
      if (expectKey && names instanceof Set) {
        if (names.has(s)) return { why: `the member name ${JSON.stringify(s)} occurs twice in one object`, offset: i };
        names.add(s);
      }
      i = j + 1;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i))!;
      if (!Number.isFinite(Number(m[0]))) return { why: `the number ${m[0]} is past the range of a binary64 value`, offset: i };
      i += m[0].length;
      continue;
    }
    i++; // whitespace, or a letter of true / false / null
  }
  return null;
}

/**
 * The same limits over a tree another engine built (yaml, edn), where there
 * is no JSON text to point into. A repeated key never reaches a tree — the
 * engine refuses it while building — so this checks the other two.
 */
export function valueFault(v: unknown): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? null : "a number has no finite value";
  if (typeof v === "string") return LONE_SURROGATE.test(v) ? "a string holds a lone surrogate, which no Unicode text can carry" : null;
  if (Array.isArray(v)) {
    for (const x of v) { const f = valueFault(x); if (f) return f; }
    return null;
  }
  if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (LONE_SURROGATE.test(k)) return "a key holds a lone surrogate, which no Unicode text can carry";
      const f = valueFault(x);
      if (f) return f;
    }
  }
  return null;
}
