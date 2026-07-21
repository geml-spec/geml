// Security regression tests for the GEML viewer. Asserts the SECURE behavior of
// the audit fixes that landed in src/render.js and src/content.js:
//   H1  URL-scheme allowlist for link/autoref/media (no javascript: etc.)
//   M1  src= table fetch is credentials-less and same-origin (no cross-origin /
//       local-file exfiltration)
//   L1  remote media does not auto-load (click-to-load link instead)
//   L2  every target=_blank link carries rel="noopener noreferrer"
//   L3  only paths ending in .geml/.gemlhistory are rendered
//
// H1/L1/L2 live in the pure renderer, so they run exactly like render.test.mjs
// (parse → renderDocument → assert DOM). M1/L3 live inside content.js main();
// content.js can't be imported bare in Node (top-level main() + CSS imports and
// no exported guards), so those two are driven END-TO-END through the real
// content.js with a .css loader hook + mocked globals — the actual guard code
// executes; nothing is faked.
import { parse } from "../../../geml-parser/dist/geml.js";
import { renderDocument } from "../src/render.js";
import { parseHTML } from "linkedom";
import { register } from "node:module";
import { strict as assert } from "node:assert";

// KaTeX (pulled in transitively when content.js is imported) logs a one-time
// "doesn't work in quirks mode" notice under linkedom; drop just that line so
// the suite output stays clean. Everything else still prints.
const _warn = console.warn;
console.warn = (...a) => { if (typeof a[0] === "string" && /quirks mode/i.test(a[0])) return; _warn(...a); };

// Stub `*.css` imports so the real content.js is importable in Node (M1/L3).
register("./css-stub-hooks.mjs", import.meta.url);

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok", name); }

// --- pure renderer helpers (H1/L1/L2) -------------------------------------
function render(src) {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  return renderDocument(parse(src), document);
}
const hrefOf = (a) => a.getAttribute("href");
// No element in the subtree carries an unsafe scheme in a URL-bearing attribute
// (href/src). Plain visible text like "[[javascript:…]]" is harmless and ignored.
function noUnsafeUrlAttr(root) {
  for (const e of root.querySelectorAll("*")) {
    for (const attr of ["href", "src"]) {
      const v = e.getAttribute(attr);
      if (v && /^\s*(javascript|vbscript|data:text\/html)/i.test(v)) return false;
    }
  }
  return true;
}

// ==========================================================================
// H1 — URL scheme allowlist
// ==========================================================================

await test("H1 link: javascript: (any case) and other unsafe schemes are inert; safe schemes keep href", () => {
  const root = render(
    "a [j](javascript:alert(1)) b [m](JaVaScRiPt:alert(2)) c [d](data:text/html,<script>x</script>) " +
    "d [v](vbscript:msgbox(1)) e [f](file:///etc/passwd).\n",
  );
  const anchors = [...root.querySelectorAll("a")];
  assert.equal(anchors.length, 5, "five link anchors emitted");
  // Every unsafe-scheme link is neutralized: no href attribute reaches the DOM.
  for (const a of anchors) {
    assert.equal(a.hasAttribute("href"), false, "unsafe-scheme link has no href");
  }
  // And no javascript: URL anywhere in the rendered subtree.
  assert.doesNotMatch(root.innerHTML, /javascript:/i, "no javascript: URL in DOM");

  const ok = render(
    "a [h](https://example.com/p) b [r](sub/page.geml) c [n](#sec) d [e](mailto:a@b.com) f [t](tel:+1).\n\n" +
    "=== note {#sec}\nhi\n===\n",
  );
  assert.equal(hrefOf(ok.querySelector("a:nth-of-type(1)")), "https://example.com/p");
  const hrefs = [...ok.querySelectorAll("a")].map(hrefOf);
  assert.ok(hrefs.includes("https://example.com/p"), "https kept");
  assert.ok(hrefs.includes("sub/page.geml"), "relative kept");
  assert.ok(hrefs.includes("#sec"), "#anchor kept");
  assert.ok(hrefs.includes("mailto:a@b.com"), "mailto kept");
  assert.ok(hrefs.includes("tel:+1"), "tel kept");
});

await test("H1 media: javascript: src is blocked (inert span, no media element/src); data:image + relative load inline", () => {
  const blocked = render("![diagram](javascript:alert(1))\n");
  const span = blocked.querySelector("span.geml-media-blocked");
  assert.ok(span, "javascript: media → geml-media-blocked span");
  assert.equal(span.textContent, "diagram", "alt text preserved as fallback label");
  assert.equal(blocked.querySelector("img,audio,video"), null, "no media element created");
  assert.doesNotMatch(blocked.innerHTML, /javascript:/i, "no javascript: src in DOM");
  // no-alt variant still produces the inert placeholder
  assert.ok(render("![](javascript:alert(1))\n").querySelector("span.geml-media-blocked"));

  const dataImg = render("![i](data:image/png;base64,iVBORw0KGgo=)\n").querySelector("img");
  assert.ok(dataImg && dataImg.getAttribute("src").startsWith("data:image/"), "data:image loads inline");

  const relImg = render("![i](pics/a.png)\n").querySelector("img");
  assert.ok(relImg && relImg.getAttribute("src") === "pics/a.png", "relative image loads inline");
  const relAudio = render("![a](sounds/a.mp3)\n").querySelector("audio");
  assert.ok(relAudio && relAudio.getAttribute("src") === "sounds/a.mp3", "relative audio loads inline");
});

await test("H1 autoref: an unsafe-scheme autoref never becomes a javascript link; legit autorefs keep href", () => {
  // A javascript:/vbscript:/data: autoref does not parse as an autoref at all —
  // it stays literal text, so no anchor (and no href) is produced.
  for (const bad of ["[[javascript:alert(1)]]", "[[javascript:alert#x]]", "[[vbscript:msgbox#y]]", "[[data:text/html,x#y]]"]) {
    const root = render("see " + bad + " here.\n");
    assert.equal(root.querySelector("a.geml-autoref"), null, `no autoref anchor for ${bad}`);
    assert.equal(root.querySelector("a[href]"), null, `no href emitted for ${bad}`);
    assert.ok(noUnsafeUrlAttr(root), `no unsafe scheme in any href/src for ${bad}`);
  }
  // Legit autorefs still resolve to a working href.
  const anchor = render("see [[#sec]].\n\n=== note {#sec}\nhi\n===\n").querySelector("a.geml-autoref");
  assert.ok(anchor && hrefOf(anchor) === "#sec", "same-doc autoref keeps #anchor href");
  const docref = render("see [[report.geml#sec]].\n").querySelector("a.geml-autoref");
  assert.ok(docref && hrefOf(docref) === "report.geml#sec", "cross-doc autoref keeps its href");
});

// ==========================================================================
// L1 — remote media must not auto-load
// ==========================================================================

await test("L1: remote media (//host and absolute http(s)) becomes a click-to-load link, not auto-loading media", () => {
  for (const [src, kindWord] of [["//evil/beacon", "image"], ["https://evil.example/x.png", "image"], ["https://evil.example/clip.mp4", "video"]]) {
    const root = render(`![grab](${src})\n`);
    const a = root.querySelector("a.geml-remote-media");
    assert.ok(a, `remote media ${src} → geml-remote-media link`);
    assert.equal(a.getAttribute("target"), "_blank", "opens in a new context");
    const rel = a.getAttribute("rel") || "";
    assert.match(rel, /noopener/, "rel has noopener");
    assert.match(rel, /noreferrer/, "rel has noreferrer");
    assert.equal(hrefOf(a), src, "link points at the remote URL (opt-in), not auto-loaded");
    assert.match(a.textContent, new RegExp(`Load ${kindWord}`), "click-to-load label names the media kind");
    // The important part: NO element auto-connects to the remote host on open.
    assert.equal(root.querySelector("img,audio,video"), null, "no auto-loading media element");
  }
  // Local/relative and data: media still load inline (no click-to-load gate).
  assert.equal(render("![i](pics/a.png)\n").querySelector("a.geml-remote-media"), null, "relative image not gated");
  assert.ok(render("![i](pics/a.png)\n").querySelector("img"), "relative image inline");
  assert.ok(render("![i](data:image/png;base64,iVBORw0KGgo=)\n").querySelector("img"), "data:image inline");
});

// ==========================================================================
// L2 — target=_blank must carry rel=noopener (+noreferrer)
// ==========================================================================

await test("L2: every target=_blank link the viewer emits carries rel noopener + noreferrer", () => {
  // Explicit link target (both {target=_blank} and {target=\"_blank\"} spellings),
  // plus the L1 remote-media link, which also opens _blank.
  const root = render(
    'a [x](https://e.com){target=_blank} b [y](https://e2.com){target="_blank"} c ![m](https://evil.example/x.png).\n',
  );
  const blanks = [...root.querySelectorAll('a[target="_blank"]')];
  assert.ok(blanks.length >= 3, "at least three _blank anchors (two links + remote media)");
  for (const a of blanks) {
    const rel = a.getAttribute("rel") || "";
    assert.match(rel, /noopener/, "target=_blank has rel noopener");
    assert.match(rel, /noreferrer/, "target=_blank has rel noreferrer");
  }
  // A link without target=_blank is not forced to _blank.
  const plain = render("a [x](https://e.com).\n").querySelector("a");
  assert.notEqual(plain.getAttribute("target"), "_blank", "non-_blank link left alone");
});

// ==========================================================================
// M1 / L3 — driven end-to-end through the real content.js main()
// ==========================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTENT = "../src/content.js";
let caseN = 0;

function makeResp(text, url, { ok = true, ct = "text/csv" } = {}) {
  return { ok, url, headers: { get: (h) => (h.toLowerCase() === "content-type" ? ct : null) }, text: async () => text };
}

// Install fresh globals for one main() run and return {document, calls}.
function install({ href, pathname, protocol, docRaw, bodyHtml, routes = {} }) {
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${bodyHtml || ""}</body></html>`);
  globalThis.document = document;
  globalThis.location = { href, pathname, protocol };
  globalThis.chrome = {
    runtime: { getURL: (p) => "chrome-extension://test/" + p, sendMessage: async () => ({ ok: false }) },
  };
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    // The document's own body (http(s) readSource() path).
    if (protocol !== "file:" && String(url) === href) return makeResp(docRaw, href, { ct: "text/plain" });
    if (Object.prototype.hasOwnProperty.call(routes, String(url))) return makeResp(routes[String(url)], String(url));
    return makeResp("", String(url), { ok: false });
  };
  return { document, calls };
}

// Import (a fresh copy of) content.js so its top-level main() runs against the
// globals just installed; wait until it finishes (body class set) for render cases.
async function runMain(opts) {
  const ctx = install(opts);
  await import(`${CONTENT}?case=${caseN++}`);
  if (opts.expectRender === false) {
    await sleep(20); // early-return path: give any stray async work a beat, then assert
  } else {
    for (let i = 0; i < 200 && ctx.document.body.className !== "geml-body"; i++) await sleep(5);
  }
  return ctx;
}

await test("M1 (http): same-origin src table fetches with credentials:'omit'; cross-origin and //host are refused", async () => {
  const href = "https://site.test/docs/report.geml";
  const raw =
    '=== table {#a format=csv src="data.csv"}\n===\n\n' +
    '=== table {#b format=csv src="https://evil.example/x.csv"}\n===\n\n' +
    '=== table {#c format=csv src="//evil.example/y.csv"}\n===\n';
  const ctx = await runMain({
    href, pathname: "/docs/report.geml", protocol: "https:", docRaw: raw,
    routes: { "https://site.test/docs/data.csv": "Seg, V\nA, 1\nB, 2\n" },
  });

  const srcCalls = ctx.calls.filter((c) => c.url !== href); // exclude the document fetch
  assert.ok(srcCalls.some((c) => c.url === "https://site.test/docs/data.csv"), "same-origin data.csv was fetched");
  assert.ok(srcCalls.length > 0 && srcCalls.every((c) => c.opts && c.opts.credentials === "omit"),
    "every src-table fetch uses credentials:'omit'");
  assert.ok(!ctx.calls.some((c) => c.url.includes("evil.example")), "cross-origin and //host src were NEVER fetched");

  const html = ctx.document.body.innerHTML;
  assert.ok(ctx.document.querySelector("table"), "the allowed same-origin table rendered");
  assert.match(html, /Data not loaded from https:\/\/evil\.example\/x\.csv/, "cross-origin table left as a placeholder");
  assert.match(html, /Data not loaded from \/\/evil\.example\/y\.csv/, "//host table left as a placeholder");
});

await test("M1 (file://): same-directory src fetches; ../ escape and absolute file path are refused", async () => {
  const href = "file:///C:/docs/report.geml";
  const raw =
    '=== table {#a format=csv src="data.csv"}\n===\n\n' +
    '=== table {#b format=csv src="../secret.csv"}\n===\n\n' +
    '=== table {#c format=csv src="file:///C:/Windows/win.ini"}\n===\n';
  const ctx = await runMain({
    href, pathname: "/C:/docs/report.geml", protocol: "file:",
    bodyHtml: `<pre>${raw.replace(/</g, "&lt;")}</pre>`,
    routes: { "file:///C:/docs/data.csv": "Seg, V\nA, 1\n" },
  });

  assert.ok(ctx.calls.some((c) => c.url === "file:///C:/docs/data.csv" && c.opts && c.opts.credentials === "omit"),
    "same-directory data.csv fetched (credentials omit)");
  assert.ok(!ctx.calls.some((c) => c.url.includes("secret.csv")), "../ escape was NEVER fetched");
  assert.ok(!ctx.calls.some((c) => c.url.toLowerCase().includes("win.ini")), "absolute file path was NEVER fetched");
  const html = ctx.document.body.innerHTML;
  assert.ok(ctx.document.querySelector("table"), "the allowed same-directory table rendered");
  assert.match(html, /Data not loaded from \.\.\/secret\.csv/, "../ table left as a placeholder");
});

await test("L3: only paths ending in .geml/.gemlhistory render; a text/plain URL merely containing .geml does not", async () => {
  for (const [pathname, shouldRender] of [
    ["/report.geml", true],
    ["/log.gemlhistory", true],
    ["/notes.geml.txt", false],       // manifest glob matches, but path ends .txt
    ["/download", false],             // e.g. ...?x=a.geml — query is not in pathname
  ]) {
    const href = "https://site.test" + pathname + (pathname === "/download" ? "?x=a.geml" : "");
    const ctx = await runMain({ href, pathname, protocol: "https:", docRaw: "# Title\n\ntext\n", expectRender: shouldRender });
    const rendered = ctx.document.body.className === "geml-body";
    const fetchedDoc = ctx.calls.some((c) => c.url === href);
    assert.equal(rendered, shouldRender, `${pathname}: rendered=${rendered}, expected ${shouldRender}`);
    if (!shouldRender) {
      assert.equal(fetchedDoc, false, `${pathname}: main() returned before reading/rendering (no doc fetch)`);
    }
  }
});

console.warn = _warn;
console.log(`\n${passed} test(s) passed.`);
