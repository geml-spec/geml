// GEP 0010, the browser half: WHO translates.
//
// The parser decides WHAT may be translated (translateBlocks — heading and
// paragraph text, list items, table cells, `caption=`; never a code or math or
// data body, never an id, never a link target). This file supplies the other
// half from what Chrome ships: the built-in `Translator`, which runs on-device,
// so a projection is translated without the document's text leaving the machine.
//
// Two passes, because `Translator.translate()` is async and translateBlocks takes
// a synchronous function. Pass one walks with a collector that records every
// string and returns it unchanged; the strings are translated in one batch; pass
// two walks again substituting from the map. The policy is therefore applied by
// the same code both times — there is no second, drifting copy of "what counts as
// translatable" living in the browser.
import { translateBlocks } from "./parse-entry.js";

// Availability is per language PAIR and has four states. `downloadable` means the
// model is not on the machine yet — and Chrome will only fetch one under a user
// activation, so that case comes back as `needsGesture` for the caller to offer
// rather than being forced here. With the gesture (`allowDownload`), the download
// runs and its progress is reported instead of the page freezing.
// "no Translator" has several causes and a reader can act on the difference, so
// the message names what was actually detected instead of stopping at the symptom.
// The minimum Chrome version is deliberately NOT quoted: it moves, and a wrong
// number in a message a reader trusts is worse than no number. What IS quoted is
// the browser and version found, plus the page that shows on-device model state.
export function whyNoTranslator(ua = typeof navigator === "undefined" ? "" : navigator.userAgent || "") {
  const edge = /\bEdg\/(\d+)/.exec(ua);
  const chrome = /\bChrome\/(\d+)/.exec(ua);
  if (edge) return `Edge ${edge[1]} does not expose the built-in Translator; it ships in recent desktop Chrome`;
  if (chrome) {
    return `this Chrome (${chrome[1]}) does not expose the built-in Translator — it needs a newer desktop Chrome; ` +
      "chrome://on-device-internals shows whether the models are available";
  }
  if (/Firefox|Safari/.test(ua) && !/Chrom/.test(ua)) {
    return "the built-in Translator is a Chrome feature and this is not Chrome";
  }
  return "this browser has no built-in Translator";
}

export async function translatorFor(sourceLanguage, targetLanguage, onProgress, allowDownload = false) {
  if (typeof Translator === "undefined") {
    return { ok: false, why: whyNoTranslator() };
  }
  let state;
  try {
    state = await Translator.availability({ sourceLanguage, targetLanguage });
  } catch (e) {
    return { ok: false, why: `Translator.availability failed: ${e?.message ?? e}` };
  }
  if (state === "unavailable" || state === undefined) {
    return { ok: false, why: `no on-device model for ${sourceLanguage} → ${targetLanguage}` };
  }
  // Chrome refuses to START a model download except under a user activation:
  // "Requires a user gesture when availability is downloading or downloadable".
  // That is the right constraint — a model is tens of megabytes — so this does
  // not fight it by trying anyway. The caller shows the source and an affordance;
  // the click is the gesture, and it comes back through `allowDownload`.
  if ((state === "downloadable" || state === "downloading") && !allowDownload) {
    return { ok: false, needsGesture: true, state, why: `the ${sourceLanguage} → ${targetLanguage} model is not on this machine yet` };
  }
  try {
    const t = await Translator.create({
      sourceLanguage,
      targetLanguage,
      monitor: (m) => m.addEventListener("downloadprogress", (e) => onProgress?.(e.loaded)),
    });
    return { ok: true, translator: t, downloaded: state === "downloadable" };
  } catch (e) {
    return { ok: false, why: `could not start ${sourceLanguage} → ${targetLanguage}: ${e?.message ?? e}` };
  }
}

// Guess the source language from the text itself when the document does not say.
// A projection names its TARGET (`lang=`); the source is whatever the borrowed
// document is written in, and the borrowed document is often someone else's.
export async function detectLanguage(sample, fallback = "en") {
  if (typeof LanguageDetector === "undefined" || sample.trim() === "") return fallback;
  try {
    if (await LanguageDetector.availability() === "unavailable") return fallback;
    const d = await LanguageDetector.create();
    const [best] = await d.detect(sample.slice(0, 400));
    d.destroy?.();
    return best?.detectedLanguage ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Translated blocks, or `{ ok: false, why }` — never a silent passthrough, because
 * a projection that quietly shows its source reads as a translation that happens
 * to look like English.
 */
export async function translateSlice(blocks, targetLanguage, opts = {}) {
  // Pass one: collect. The collector returns its input, so this walk is a
  // read-only use of exactly the policy pass two will apply.
  const wanted = new Set();
  translateBlocks(blocks, targetLanguage, (text) => { if (text.trim() !== "") wanted.add(text); return text; }, opts);
  if (wanted.size === 0) return { ok: true, blocks };

  const source = opts.sourceLanguage ?? await detectLanguage([...wanted].join("\n"));
  if (source === targetLanguage) return { ok: true, blocks, same: true };

  const got = await translatorFor(source, targetLanguage, opts.onProgress, opts.allowDownload === true);
  if (!got.ok) return got;

  const map = new Map();
  try {
    for (const text of wanted) {
      // Sequential on purpose: the on-device model serialises anyway, and a burst
      // of parallel calls on a freshly downloaded model is where it throws.
      map.set(text, await got.translator.translate(text));
    }
  } catch (e) {
    return { ok: false, why: `translation failed: ${e?.message ?? e}`, retryable: true };
  } finally {
    got.translator.destroy?.();
  }

  // Pass two: substitute.
  return { ok: true, blocks: translateBlocks(blocks, targetLanguage, (t) => map.get(t) ?? t, opts), source };
}

// How many expansions a caller may run against this backend at once. ONE, and
// the reason sits inside the loop above: the on-device model serialises anyway,
// and a burst of parallel calls on a freshly downloaded model is where it throws.
// A remote backend may declare more once someone has MEASURED it — the number
// belongs to whoever answers, not to the loop that asks.
translateSlice.concurrency = 1;
