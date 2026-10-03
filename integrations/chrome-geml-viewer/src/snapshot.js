// The rendered document, as Markdown — "freeze what I am looking at".
//
// A projection is a view: its content lives in the documents it embeds, and the
// language it is read in comes from a translator the host supplies. Neither is
// in the file, so `geml --to md` on the projection cannot produce what a reader
// sees — it has no translator and says so. The surface that DOES have one is
// this one, so this is where a translated snapshot can honestly be taken.
//
// It reads the block slices `transclude.js` recorded on each wrapper as it
// painted, which is why it follows the reader: a section swapped back to its
// source is snapshotted as its source.
import { gemlToMd } from "./parse-entry.js";

/** The top-level wrappers, in document order — nested ones ride inside their host. */
function topLevel(container) {
  return [...container.querySelectorAll(".geml-transclusion")]
    .filter((el) => !el.parentElement || !el.parentElement.closest(".geml-transclusion"));
}

/**
 * @returns `{ md, untranslated }` — the Markdown, and the embeds that are showing
 *   their source language. Never a bare string: a half-translated snapshot that
 *   does not say which halves is the failure this whole feature is meant to
 *   avoid, and the caller must be made to look at it.
 */
export function snapshot(model, container) {
  const wrappers = topLevel(container);
  let at = 0;
  const out = [];
  const untranslated = [];
  for (const b of model.children || []) {
    if (b.hidden === true || b.kind === "hidden") continue;
    if (b.kind === "block" && b.type === "meta") continue;
    if (!(b.kind === "block" && b.type === "embed")) { out.push(b); continue; }
    const el = wrappers[at++];
    const slice = el && el.gemlSlice;
    if (!slice) { out.push(b); continue; }       // refused before it ever painted
    // `data-translation-note` is set only when a translator was asked and could
    // not answer, so it is exactly "this is showing the source".
    if (el.hasAttribute("data-translation-note")) {
      untranslated.push({ src: el.getAttribute("data-src") || "", why: el.getAttribute("data-translation-note") });
    }
    out.push(...slice);
  }
  return { md: gemlToMd({ ...model, children: out }).md, untranslated };
}
