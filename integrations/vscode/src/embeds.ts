// The other documents a document names in its block attributes — `=== embed
// {src=other.geml#id}`, and a table's `src="rows.csv"`.
//
// Why the extension cares: the preview renders INSIDE the webview, whose bundle
// aliases node:fs to a stub, so nothing there can read a second file. Left to
// itself the renderer prints "cannot resolve document …" over a file sitting
// right next to the one being edited. The extension can read it, so it does, and
// hands the text to the webview with the document.
//
// Scanned, not parsed, for the same reason refs.ts lexes references by hand: this
// package has no runtime dependency on the parser — the preview's copy of it is
// inside the webview bundle, unreachable from the extension host.

/** A fence-open line with a braced attribute object, captured whole. */
const FENCE_WITH_ATTRS = /^={3,}[ \t]+[A-Za-z][A-Za-z0-9_-]*[ \t]*\{(.*)\}[ \t]*$/;

/** `src=value`, quoted or bare, inside an attribute object. */
const SRC_ATTR = /\bsrc=("([^"]*)"|[^\s}]+)/g;

/**
 * Is this a path this extension may read on the document's behalf?
 *
 * Relative only. A URL belongs to whoever serves it, and an absolute path is a
 * request to read somewhere the document's own folder cannot vouch for — both
 * keep the renderer's existing note instead. A backslash is not a GEML path
 * separator, so a Windows-style path is rejected rather than guessed at.
 */
export function isLocalDocPath(path: string): boolean {
  if (path === "") return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false; // http:, file:, mailto:, c: …
  if (path.startsWith("/") || path.startsWith("\\") || path.includes("\\")) return false;
  if (path.split("/").includes("..")) return false; // no climbing out of the document's folder
  return path.includes("."); // a document has an extension; bare words are prose
}

/**
 * Every distinct local path the text's block attributes point at, in the order
 * they appear, capped so a generated document cannot ask the extension to read
 * a thousand files on every keystroke.
 *
 * A `\`-folded fence head is not scanned: the attribute object then spans lines
 * and this is a line scanner. Folding an embed is rare, and the cost of missing
 * one is the note that was there before.
 */
export function embedDocPaths(text: string, max = 16): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const fence = FENCE_WITH_ATTRS.exec(line);
    if (!fence) continue;
    for (const m of fence[1]!.matchAll(SRC_ATTR)) {
      const raw = (m[2] ?? m[1] ?? "").trim();
      const path = raw.split("#")[0]!.trim();
      if (!isLocalDocPath(path) || seen.has(path)) continue;
      seen.add(path);
      found.push(path);
      if (found.length >= max) return found;
    }
  }
  return found;
}
