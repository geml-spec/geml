// GEML reference parser — where a document's title lives, for the projections.
//
// The spec keeps the title in `=== meta` (`title = "…"`, the §4 style note) so
// that every heading denotes a genuine section — a document may open with six
// level-1 sections and none of them is "the title". Markdown and HTML readers
// expect the opposite shape: the title is the first `h1`, sections start at
// `h2`. A projection reconciles the two by emitting `title` as a level-1
// heading of its own and shifting every body heading down one level.
//
// The one exception is an author who already wrote the title as the first
// heading — `# {{title}}`, or the same words spelled out. That heading IS the
// title: nothing is added and nothing moves, or the page would say its name
// twice. Both spellings project to the same Markdown, which is the point.
//
// Nothing here counts headings. Whether a document has one level-1 heading or
// six says nothing about which of them, if any, is its title.
import type { Document } from "./geml.js";

export interface DocTitle {
  /** The merged meta `title`, when it is a string (§4: the first definition wins). */
  title?: string;
  /** The first visible heading is a level-1 heading reading exactly `title`. */
  echo: boolean;
}

export function docTitle(doc: Pick<Document, "children">): DocTitle {
  let title: string | undefined;
  for (const b of doc.children) {
    if (b.kind === "block" && b.type === "meta" && b.data && "title" in b.data) {
      const v = b.data["title"];
      title = typeof v === "string" ? v.trim() : undefined;
      break;
    }
  }
  if (title === undefined || title === "") return { echo: false };
  const first = doc.children.find((b) => b.kind === "heading" && !b.hidden);
  const echo = first?.kind === "heading" && first.level === 1 && first.text.trim() === title;
  return { title, echo };
}

/** Levels a projection adds to every body heading: one when the title is emitted as a heading of its own. */
export function headingShift(t: DocTitle): number {
  return t.title !== undefined && !t.echo ? 1 : 0;
}
