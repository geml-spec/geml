// Text-level helpers shared by the history layer (history.ts) and the reader of
// the earlier sidecar format (history-legacy.ts): bytes and newlines, hashing,
// the sidecar's own top-level block locator, its attribute reader, and the
// document tiling every history operation addresses.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseAttrs } from "./attrs.js";

// ---------------------------------------------------------------------------
// Bytes, newlines, hashing
// ---------------------------------------------------------------------------

export interface Loaded { lf: string; nl: string; }

export function loadBytes(path: string): Loaded {
  const raw = readFileSync(path);
  const nl = raw.includes(13) /* \r */ && raw.includes(10) ? "\r\n" : "\n";
  return { lf: raw.toString("utf8").replace(/\r\n/g, "\n"), nl };
}

export function textOf(raw: string): Loaded {
  const nl = raw.includes("\r\n") ? "\r\n" : "\n";
  return { lf: raw.replace(/\r\n/g, "\n"), nl };
}

export function bytesOf(lf: string, nl: string): Buffer {
  return Buffer.from(lf.replace(/\n/g, nl), "utf8");
}

export function writeBytes(path: string, lf: string, nl: string): void {
  writeFileSync(path, bytesOf(lf, nl));
}

export function fullHash(lf: string, nl: string): string {
  return "sha256:" + createHash("sha256").update(bytesOf(lf, nl)).digest("hex");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

export const nlNamed = (nl: string): "lf" | "crlf" => (nl === "\r\n" ? "crlf" : "lf");
export const nlOf = (name?: string): string | undefined =>
  name === "crlf" ? "\r\n" : name === "lf" ? "\n" : undefined;

/**
 * The key means "the GEML LANGUAGE version this history conforms to" — the
 * profile spec's own words — and the language is at 1.0. Not the parser
 * version: that one moves on its own schedule and is read at runtime.
 */
export const GEML_LANGUAGE_VERSION = "1.0";

/** UTC basic ISO-8601, e.g. 20260617T103012Z. */
export function stampUTC(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

// ---------------------------------------------------------------------------
// Top-level fenced-block locator (for the history file's own structure)
// ---------------------------------------------------------------------------

// Trailing whitespace nested inside the optional attrs group — the flat form
// let two runs split the same tabs every possible way (quadratic; see the note
// on geml.ts's FENCE_OPEN, which this mirrors). Same language, verified over
// 150k random strings.
export const FENCE_OPEN = /^(={3,})[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*(?:(\{.*\})[ \t]*)?$/;

export interface Located { type: string; id?: string; attrLine: string; fenceLen: number; start: number; end: number; }

export function locate(lines: string[]): Located[] {
  const out: Located[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = FENCE_OPEN.exec(lines[i]!);
    if (m) {
      const fenceLen = m[1]!.length;
      const attrLine = m[3] ?? "";
      const idm = /#([A-Za-z][A-Za-z0-9_-]*)/.exec(attrLine);
      let j = i + 1;
      while (j < lines.length) {
        const t = lines[j]!.trimEnd();
        if (/^=+$/.test(t) && t.length === fenceLen) break;
        j++;
      }
      out.push({ type: m[2]!, id: idm?.[1], attrLine, fenceLen, start: i, end: Math.min(j, lines.length - 1) });
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

// The attribute object of a sidecar block, read as a SEQUENCE of `key=value`
// pairs rather than searched by regex. Searched, `hash=(…)` matched wherever it
// first appeared — so a summary of `x" hash="sha256:0…` planted a second `hash=`
// the search found before the real one. Values follow §4: a quoted value escapes
// only `"` and `\`, a bare value ends at whitespace or `}`. Read in order, a
// `hash=` inside a summary's quotes is part of the summary and of nothing else.
export function attrs(attrLine: string): Map<string, string> {
  const out = new Map<string, string>();
  const s = attrLine;
  const brace = s.indexOf("{");
  let i = brace < 0 ? 0 : brace + 1;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length || s[i] === "}") break;
    let k = "";
    while (i < s.length && /[^\s={}"]/.test(s[i]!)) k += s[i++];
    if (k === "") { i++; continue; }          // a stray character: step over it
    if (s[i] !== "=") continue;               // a bare flag carries no value
    i++;
    if (s[i] === '"') {
      i++;
      let v = "";
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "\\")) { v += s[i + 1]; i += 2; continue; }
        v += s[i++];
      }
      i++;                                    // the closing quote
      out.set(k, v);
    } else {
      let v = "";
      while (i < s.length && !/[\s}]/.test(s[i]!)) v += s[i++];
      out.set(k, v);
    }
  }
  return out;
}

// The inverse: a value written so that `attrs` reads it back whole. §4 escapes
// exactly `"` and `\`; a newline has no escape and is refused upstream (save).
export const quoteAttr = (v: string): string => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function fenceFor(contentLf: string): string {
  let longest = 0;
  for (const line of contentLf.split("\n")) {
    const m = /^=+/.exec(line);
    if (m) longest = Math.max(longest, m[0].length);
  }
  return "=".repeat(Math.max(longest + 1, 3));
}

// ---------------------------------------------------------------------------
// Document units
// ---------------------------------------------------------------------------

// Profile §4: a block runs to the line that closes it as GEML §3 says — an
// equal-length bare run, or, when it has an id, its labeled fence `=== #id`.
export const LABELED_CLOSE = /^={3,}[ \t]*#(\S+)[ \t]*$/u;
// A heading line with a trailing attribute object: `## Title {#id}`. Its explicit
// id keys the flow segment it opens; its derived id does not.
const HEADING_ATTRS = /^#{1,6}[ \t]+\S.*\{([^{}]*)\}[ \t]*$/u;

// A UNIT covers a maximal run: a fenced block OR a flow segment (heading /
// paragraph / list), plus the blank lines that follow it. Units tile every
// line, so joining them reproduces the document byte-for-byte — and because
// prose segments are units too, positions amid prose are anchorable.
export interface Unit { start: number; bodyEnd: number; endExcl: number; id?: string; fenced: boolean }

export function tile(lines: string[]): Unit[] {
  const units: Unit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const start = i;
    if (lines[i]!.trim() === "") { // leading / standalone blank run
      while (i < n && lines[i]!.trim() === "") i++;
      units.push({ start, bodyEnd: i, endExcl: i, fenced: false });
      continue;
    }
    const fo = FENCE_OPEN.exec(lines[i]!);
    let id: string | undefined;
    if (fo) {
      const fenceLen = fo[1]!.length;
      // `|| undefined`: the empty id is none (GEML §4).
      id = (fo[3] === undefined ? undefined : parseAttrs(fo[3]).id) || undefined;
      i++;
      while (i < n) {
        const t = lines[i]!.trimEnd();
        const close = (/^=+$/.test(t) && t.length === fenceLen) || (id !== undefined && LABELED_CLOSE.exec(t)?.[1] === id);
        i++;
        if (close) break;
      }
    } else { // flow segment: consecutive non-blank, non-fence lines
      const h = HEADING_ATTRS.exec(lines[i]!);
      if (h) id = parseAttrs(`{${h[1]!}}`).id || undefined;
      i++;
      while (i < n && lines[i]!.trim() !== "" && !FENCE_OPEN.test(lines[i]!)) i++;
    }
    const bodyEnd = i;
    while (i < n && lines[i]!.trim() === "") i++; // own trailing blanks
    units.push({ start, bodyEnd, endExcl: i, id, fenced: !!fo });
  }
  return units;
}
