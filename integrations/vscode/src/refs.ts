// Finding the reference under the cursor.
//
// This is the one place the extension reads GEML syntax directly, and it is
// deliberately a LEXER, not a parser: it locates reference tokens on a single
// line and says what they point at. It never decides what a document means —
// what exists, what resolves, what is broken — all of which still comes from the
// CLI. The reason it exists at all is that no CLI verb answers "what token is at
// line 12, column 30", and the editor has to know that to offer navigation.
//
// §5.2 gives four reference forms, and §6 one more on a block head:
//
//   [[#id]]                  auto-ref, same document
//   [[other.geml#id]]        auto-ref, cross-document
//   [text](#id)              explicit text, same document
//   [text](other.geml#id)    explicit text, cross-document
//   ![[#id]]                 inline projection (same shape, leading `!`)
//   === embed {src=#id}      block transclusion, an attribute not an inline
//
// All six are navigable, so all six are matched.

import * as vscode from "vscode";

export interface RefToken {
  /** The whole token, for hover to highlight. */
  range: vscode.Range;
  /** Just the id text, without `#` — what rename pre-fills and replaces. */
  idRange?: vscode.Range;
  /** Document part of the target, verbatim as written, if the ref crosses documents. */
  path?: string;
  /** Block id without `#`. Absent for a bare cross-document link with no fragment. */
  id?: string;
}

// `[[target]]` and `![[target]]`. The target runs to the first `]`, so a nested
// link cannot confuse it — §5.3 forbids a ref inside a ref anyway.
const WIKI = /!?\[\[([^\]\n]+)\]\]/g;
// `](target)` — the tail of `[text](target)`. Only the target is captured; the
// label may contain anything, and matching from `](` avoids having to.
const INLINE = /\]\(([^)\n\s]+)\)/g;
// `src=#id` or `src="#id"` on a block head.
const SRC = /\bsrc\s*=\s*"?(#[^"\s}]+)"?/g;

/** Split a reference target into its document and fragment parts. */
function split(target: string): { path?: string; id?: string; idOffset: number } | undefined {
  // A URL is a link, not a block reference — its `#` is a page fragment and
  // there is nothing in this workspace to navigate to.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target) || target.startsWith("mailto:")) return undefined;

  const hash = target.indexOf("#");
  if (hash === 0) return { id: target.slice(1), idOffset: 1 };
  if (hash > 0) return { path: target.slice(0, hash), id: target.slice(hash + 1), idOffset: hash + 1 };
  // No fragment. A bare `[[other.geml]]` is still navigable as a document; a
  // bare `[text](notes.md)` likewise. Anything without a dot is neither — most
  // likely ordinary prose in brackets.
  return target.includes(".") ? { path: target, idOffset: -1 } : undefined;
}

/**
 * Where the `[` that opens a label sits, given the index of its closing `]`.
 * Returns -1 when there is no label — `](x)` appearing on its own.
 */
function labelStart(text: string, close: number): number {
  let depth = 0;
  for (let i = close - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "]") depth++;
    else if (c === "[") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** Every reference token on one line. */
export function refsOnLine(doc: vscode.TextDocument, line: number): RefToken[] {
  const text = doc.lineAt(line).text;
  const out: RefToken[] = [];

  const push = (start: number, end: number, target: string, targetStart: number): void => {
    const parts = split(target);
    if (!parts) return;
    const tok: RefToken = {
      range: new vscode.Range(line, start, line, end),
      path: parts.path,
      id: parts.id,
    };
    if (parts.id !== undefined && parts.idOffset >= 0) {
      tok.idRange = new vscode.Range(
        line, targetStart + parts.idOffset,
        line, targetStart + parts.idOffset + parts.id.length,
      );
    }
    out.push(tok);
  };

  for (const re of [WIKI, SRC]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const target = m[1]!;
      push(m.index, m.index + m[0].length, target, m.index + m[0].indexOf(target));
    }
  }

  // `[text](target)` is matched from its `](`, because a label may contain
  // anything at all. The token then has to be widened back over the label: that
  // is the part a reader's mouse lands on, and a hover that only answers over
  // the parenthesised half is a hover nobody finds.
  INLINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE.exec(text)) !== null) {
    const target = m[1]!;
    const open = labelStart(text, m.index);
    // `![alt](picture.png)` is an image, not a reference to a document.
    if (open > 0 && text[open - 1] === "!") continue;
    push(open >= 0 ? open : m.index, m.index + m[0].length, target, m.index + m[0].indexOf(target));
  }

  return out;
}

/** The reference token containing a position, if the cursor is on one. */
export function refAt(doc: vscode.TextDocument, pos: vscode.Position): RefToken | undefined {
  return refsOnLine(doc, pos.line).find((t) => t.range.contains(pos));
}

/**
 * Where an id is DECLARED on its own block head — `{#budget}`, or a heading's
 * trailing `{#sec}`. Used so rename can start from the definition and not only
 * from a reference. The id is already known (the CLI listed it); this only finds
 * where on the line it sits, so a wrong answer degrades to "cannot rename here",
 * never to a wrong edit.
 */
export function idRangeOnLine(doc: vscode.TextDocument, line: number, id: string): vscode.Range | undefined {
  const text = doc.lineAt(line).text;
  // Search for `#id` followed by a character that cannot continue an id, so
  // `#budget` is not found inside `#budget-2`.
  const re = new RegExp(`#${escapeRe(id)}(?![\\p{L}\\p{N}_\\-.:])`, "u");
  const m = re.exec(text);
  if (!m) return undefined;
  const start = m.index + 1; // past the '#'
  return new vscode.Range(line, start, line, start + id.length);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
