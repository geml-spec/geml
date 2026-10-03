// translateSlice's contract, backed by a translator the CALLER supplies.
//
// The browser half (translate-browser.js) uses Chrome's built-in on-device
// `Translator`, which exists in exactly one place: desktop Chrome. A VS Code
// preview runs in an Electron webview that has no such API and no filesystem
// either, so the only party that can translate for it is its host — the
// extension, which can ask the editor's own language model. GEP-0010 already
// puts this decision here: "whatever translator the host has is the host's
// business".
//
// What stays shared is the POLICY: `translateBlocks` (the parser's, §GEP-0010)
// decides which text may be translated and which `translator=none` holds back,
// so a host-translated document and a Chrome-translated one differ in who did
// the work, never in what was allowed to change.
import { translateBlocks } from "./parse-entry.js";

/**
 * Every distinct non-blank string this target would translate.
 *
 * The collector returns its input, so this walk is a read-only use of exactly
 * the policy the substitution pass will apply — the same two-pass shape
 * translate-browser.js uses, for the same reason.
 */
export function collectTranslatable(blocks, targetLanguage, opts = {}) {
  const wanted = new Set();
  translateBlocks(blocks, targetLanguage, (text) => {
    if (text.trim() !== "") wanted.add(text);
    return text;
  }, opts);
  return [...wanted];
}

/**
 * @param translate `(texts: string[], targetLanguage: string)` answering a Map
 *   or plain object of text → translation, or `{ why }` when it cannot.
 * @returns the same shapes translateSlice returns: `{ ok: true, blocks }`, or
 *   `{ ok: false, why }`. Never a silent passthrough — a projection that quietly
 *   shows its source reads as a translation that happens to look like English.
 */
export async function translateSliceWith(translate, blocks, targetLanguage, opts = {}) {
  const wanted = collectTranslatable(blocks, targetLanguage, opts);
  if (wanted.length === 0) return { ok: true, blocks };

  let answer;
  try {
    answer = await translate(wanted, targetLanguage);
  } catch (e) {
    return { ok: false, why: `translation failed: ${e?.message ?? e}` };
  }
  // `retryable` says asking again could plausibly answer differently — a
  // timeout can, "this browser has no Translator" cannot. It decides whether
  // the reader is offered a button or only told.
  if (!answer || answer.why) {
    return { ok: false, why: answer?.why ?? "no translator", retryable: answer?.retryable === true };
  }

  const map = answer instanceof Map ? answer : new Map(Object.entries(answer));
  const usable = (v) => typeof v === "string" && v.trim() !== "";
  // A translator that answered with nothing usable must not read as a
  // translation: better the note than a page that looks translated and is not.
  if (![...map.values()].some(usable)) return { ok: false, why: "the translator returned nothing" };

  // Pass two: substitute. A string the translator skipped keeps its source —
  // partial is honest, and the note above only fires when NOTHING came back.
  const blocksOut = translateBlocks(blocks, targetLanguage, (t) => {
    const got = map.get(t);
    return usable(got) ? got : t;
  }, opts);
  return { ok: true, blocks: blocksOut };
}
