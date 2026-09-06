// GEP 0010, the browser half. `Translator` and `LanguageDetector` are globals
// Chrome injects, so a test can supply them: everything here runs the real code
// path with a stub model, including the refusals — which is the half that decides
// whether a reader sees a note or a page that silently shows its source.
import { translateSlice, detectLanguage, translatorFor, whyNoTranslator } from "../src/translate-browser.js";
import { parse } from "../src/parse-entry.js";
import { strict as assert } from "node:assert";

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// A stub that upper-cases, so a translated string is unmistakable, and records
// what it was asked to translate — which is the assertion that matters: the
// policy decides what reaches the model at all.
function installTranslator({ availability = "available", asked = [], fail = null } = {}) {
  globalThis.Translator = {
    availability: async () => availability,
    create: async ({ monitor }) => {
      monitor?.({ addEventListener: (_e, cb) => cb({ loaded: 1 }) });
      return {
        translate: async (t) => { asked.push(t); if (fail) throw new Error(fail); return t.toUpperCase(); },
        destroy() {},
      };
    },
  };
  return asked;
}
const clear = () => { delete globalThis.Translator; delete globalThis.LanguageDetector; };

const DOC = `# Title {#t}

Run \`npm publish\` and read [the docs](https://example.com/a).

=== code {#c lang=sh}
npm publish
===
`;

test("prose is sent to the model; a code body and a link target never are", async () => {
  const asked = installTranslator({});
  globalThis.LanguageDetector = undefined;
  const r = await translateSlice(parse(DOC).children, "xx", { sourceLanguage: "en" });
  assert.equal(r.ok, true);

  assert.ok(asked.includes("Title"), "heading text");
  assert.ok(asked.some((s) => s.includes("Run ")), "paragraph text");
  assert.ok(!asked.includes("npm publish"), "a code body is the value, not a sentence about one");
  assert.ok(!asked.some((s) => s.includes("example.com")), "a link href names a target");

  const out = JSON.stringify(r.blocks);
  assert.match(out, /TITLE/);
  assert.match(out, /npm publish/, "the code body survives verbatim");
  clear();
});

// "no Translator" is the case a reader is most likely to hit and least able to
// diagnose, so the message names what was found rather than only what was missing.
test("no built-in Translator names the browser it found, not just the absence", async () => {
  const chrome = whyNoTranslator("Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36");
  assert.match(chrome, /Chrome \(131\)/, "the version it found");
  assert.match(chrome, /on-device-internals/, "and where to look");

  assert.match(whyNoTranslator("Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"), /^Edge 120/);
  assert.match(whyNoTranslator("Mozilla/5.0 Gecko/20100101 Firefox/130.0"), /not Chrome/);
  assert.match(whyNoTranslator(""), /no built-in Translator/, "a plain fallback when there is no UA at all");

  // And it reaches the reader: a slice asked to translate without the API says so.
  clear();
  const r = await translateSlice(parse("hello.\n").children, "xx", { sourceLanguage: "en" });
  assert.equal(r.ok, false);
  assert.ok(r.why.length > 0);
});

test("an unavailable language pair refuses, naming the pair", async () => {
  installTranslator({ availability: "unavailable" });
  const r = await translateSlice(parse("hello.\n").children, "zz", { sourceLanguage: "en" });
  assert.equal(r.ok, false);
  assert.match(r.why, /en → zz/);
  clear();
});

test("`downloadable` asks for a gesture rather than starting a download on load", async () => {
  installTranslator({ availability: "downloadable" });
  const r = await translateSlice(parse("hello.\n").children, "xx", { sourceLanguage: "en" });
  assert.equal(r.ok, false);
  assert.equal(r.needsGesture, true, "Chrome refuses create() outside a user activation");
  assert.match(r.why, /not on this machine yet/);
  clear();
});

test("with the gesture, `downloadable` downloads and translates, reporting progress", async () => {
  installTranslator({ availability: "downloadable" });
  let progress = 0;
  const r = await translateSlice(parse("hello.\n").children, "xx", {
    sourceLanguage: "en", allowDownload: true, onProgress: (n) => { progress = n; },
  });
  assert.equal(r.ok, true);
  assert.equal(progress, 1, "the reader is told, rather than the page freezing");
  clear();
});

test("a model that throws mid-way refuses; it does not return half a translation", async () => {
  installTranslator({ fail: "model died" });
  const r = await translateSlice(parse("hello.\n").children, "xx", { sourceLanguage: "en" });
  assert.equal(r.ok, false);
  assert.match(r.why, /translation failed/);
  clear();
});

test("translating into the language it is already in is a no-op", async () => {
  installTranslator({});
  const r = await translateSlice(parse("hello.\n").children, "en", { sourceLanguage: "en" });
  assert.equal(r.ok, true);
  assert.equal(r.same, true);
  clear();
});

test("a slice with nothing translatable never reaches the model", async () => {
  const asked = installTranslator({});
  const r = await translateSlice(parse("=== code {#c lang=sh}\nnpm publish\n===\n").children, "xx", { sourceLanguage: "en" });
  assert.equal(r.ok, true);
  assert.deepEqual(asked, [], "a code-only slice asks nothing of the model");
  clear();
});

test("language detection falls back rather than throwing", async () => {
  clear();
  assert.equal(await detectLanguage("some text"), "en", "no detector at all");

  globalThis.LanguageDetector = {
    availability: async () => "available",
    create: async () => ({ detect: async () => [{ detectedLanguage: "fr" }], destroy() {} }),
  };
  assert.equal(await detectLanguage("bonjour"), "fr");

  globalThis.LanguageDetector = { availability: async () => { throw new Error("nope"); } };
  assert.equal(await detectLanguage("x", "de"), "de", "a throwing detector uses the fallback");
  clear();
});

test("translatorFor surfaces a create() failure instead of throwing", async () => {
  globalThis.Translator = { availability: async () => "available", create: async () => { throw new Error("boom"); } };
  const r = await translatorFor("en", "xx");
  assert.equal(r.ok, false);
  assert.match(r.why, /could not start en → xx/);
  clear();
});

// The failure that is worse than a refusal. Chrome's built-in AI can return a
// promise that never settles where the model service is not provisioned; because
// expansion is sequential, one such call used to strand every embed behind it at
// "translating…" forever — including blocks with nothing to translate. Each test
// below hangs a DIFFERENT call, because a deadline on only the first one just
// moves the hang one step down.
const never = () => new Promise(() => {});

test("an availability() that never settles is a refusal, not a hang", async () => {
  globalThis.Translator = { availability: never, create: async () => { throw new Error("unreachable"); } };
  const r = await translatorFor("en", "xx", undefined, false, 30);
  assert.equal(r.ok, false);
  assert.match(r.why, /did not answer within 30 ms/);
  clear();
});

test("a create() that never settles is a refusal too", async () => {
  globalThis.Translator = { availability: async () => "available", create: never };
  const r = await translatorFor("en", "xx", undefined, false, 30);
  assert.equal(r.ok, false);
  assert.match(r.why, /could not start en → xx/);
  assert.match(r.why, /did not answer within 30 ms/);
  clear();
});

test("a detector that never settles costs a guess, not the queue", async () => {
  const asked = installTranslator({});
  globalThis.LanguageDetector = { availability: never };
  const r = await translateSlice(parse(DOC).children, "xx", { timeoutMs: 30 });
  assert.equal(r.ok, true, "detection falls back to en and the translation proceeds");
  assert.ok(asked.includes("Title"));
  clear();
});

test("a translate() that never settles is retryable, not a hang", async () => {
  globalThis.Translator = {
    availability: async () => "available",
    create: async () => ({ translate: never, destroy() {} }),
  };
  const r = await translateSlice(parse(DOC).children, "xx", { sourceLanguage: "en", timeoutMs: 30 });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
  assert.match(r.why, /did not answer within 30 ms/);
  clear();
});

// A download the reader agreed to is NOT raced: it is tens of megabytes and its
// progress is already on screen. Racing it would turn a working download into a
// refusal at the eight-second mark.
test("a downloading create() is not raced", async () => {
  let started = false;
  globalThis.Translator = {
    availability: async () => "downloadable",
    create: async ({ monitor }) => {
      started = true;
      monitor?.({ addEventListener: (_e, cb) => cb({ loaded: 1 }) });
      await new Promise((r) => setTimeout(r, 60));   // longer than the deadline below
      return { translate: async (t) => t, destroy() {} };
    },
  };
  const r = await translatorFor("en", "xx", undefined, true, 30);
  assert.equal(started, true);
  assert.equal(r.ok, true, "the download outlives the deadline that guards a local handoff");
  clear();
});

const run = async () => {
  for (const [name, fn] of tests) { await fn(); passed++; console.log("ok", name); }
  console.log(`\n${passed} translate-browser tests passed.`);
};
await run();
