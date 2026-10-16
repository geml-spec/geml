// One block's text out of a GEML or Markdown document, as `geml get <file>
// '#<id>'` prints it: the parser's addressing walk (`unitSpans`) finds the
// unit, `sliceUnit` cuts it out whole — a heading's whole section, a typed
// block fence to fence. In process, so a bundled CLI needs no parser on disk.
// Pure: the host reads the file and says whether it is Markdown.
import { nameKey, sliceUnit, unitSpans } from "@geml/geml";

/**
 * The text of the block `blockId` (without its `#`), or undefined when the
 * document has none. `markdown` reads the source as Markdown, the way `geml`
 * reads a `.md` file (a repeated heading's id gets GitHub's `-1` suffix);
 * hosts set it from `isMarkdownPath`. Ids compare as the parser compares them,
 * the first block with the id answers, line ends come back as LF and trailing
 * newlines are dropped.
 */
export function blockText(source: string, blockId: string, o: { markdown?: boolean } = {}): string | undefined {
  const walk = { markdown: o.markdown === true };
  const want = nameKey(blockId);
  const unit = unitSpans(source, walk).find((u) => u.id !== undefined && nameKey(u.id) === want);
  if (unit === undefined) return undefined;
  return sliceUnit(source, unit.span, "whole", walk).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}
