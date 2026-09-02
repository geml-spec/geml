// Asking a language model to translate, reduced to the two pure halves: the
// prompt, and reading the answer.
//
// Why the extension does this at all: the preview renders in an Electron
// webview, which has no built-in `Translator` — that API is desktop Chrome's,
// and it is what the browser extension uses. GEP-0010 leaves the backend to the
// host, and the host here is an editor that already has a language model the
// user has paid for. So the page collects the strings (the parser's policy
// decides which), the extension asks the model, and the page substitutes.
//
// The model call itself lives in preview.ts, where `vscode.lm` is: it cannot be
// exercised without an extension host, and these two functions are the parts
// that can go wrong quietly — a prompt that invites commentary, an answer read
// too loosely — so they are separated to be tested.

/** What the model is asked. One request per batch; order is the contract. */
export function buildPrompt(texts: string[], targetLanguage: string): string {
  return [
    `Translate each string in the JSON array below into ${targetLanguage}.`,
    "",
    "Reply with ONLY a JSON array of strings: the translation of each input, in the same order, the same length. No prose, no code fence, no explanation.",
    "Translate the text and nothing else: keep inline markup exactly as written — `code spans`, *emphasis*, [label](url), $math$, {{placeholders}} — and keep proper nouns, product names and identifiers unchanged.",
    "If a string should not change in the target language, repeat it unchanged.",
    "",
    JSON.stringify(texts),
  ].join("\n");
}

/**
 * The model's reply as a text → translation map, or a refusal.
 *
 * Read strictly on purpose. A loose read is how a model's apology ("Sure! Here
 * are the translations:") ends up rendered as a paragraph of the document, and
 * how a reply one element short shifts every translation onto the wrong string —
 * which nobody would notice, because it would still look like a translation.
 */
export function parseTranslations(
  reply: string,
  texts: string[],
): Record<string, string> | { why: string } {
  const open = reply.indexOf("[");
  const close = reply.lastIndexOf("]");
  if (open < 0 || close <= open) return { why: "the model did not answer with a JSON array" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(open, close + 1));
  } catch {
    return { why: "the model's answer was not valid JSON" };
  }
  if (!Array.isArray(parsed)) return { why: "the model's answer was not a JSON array" };
  if (parsed.length !== texts.length) {
    return { why: `the model answered ${parsed.length} strings for ${texts.length} — dropping it rather than pairing them up wrong` };
  }
  if (!parsed.every((t) => typeof t === "string")) return { why: "the model's answer held something that is not a string" };

  const out: Record<string, string> = {};
  for (let i = 0; i < texts.length; i++) {
    const got = (parsed[i] as string);
    // A blank translation is not a translation; leaving it out keeps the source
    // text, which the page shows as-is.
    if (got.trim() !== "") out[texts[i]!] = got;
  }
  return out;
}

/** Cache key for one string in one target language. */
export function cacheKey(text: string, targetLanguage: string): string {
  return `${targetLanguage}\n${text}`;
}
