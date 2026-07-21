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
  // body.className is set BEFORE the awaited upgradeCodeGraph, so the paint poll
  // above returns before any code-graph fetchDoc runs. For R2-3, wait until every
  // .cg-mount has left the initial "loading code graph …" state — i.e. each mount
  // has been built (or refused), which is when all fetchDoc calls have settled.
  if (opts.waitCodeGraph) {
    for (let i = 0; i < 400; i++) {
      const mounts = [...ctx.document.querySelectorAll(".cg-mount")];
      if (mounts.length && mounts.every((m) => !/^loading/.test(m.textContent || ""))) break;
      await sleep(5);
    }
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

// ==========================================================================
// ROUND 2
// ==========================================================================

// --------------------------------------------------------------------------
// R2-2 — control-character-obfuscated schemes in the pure renderer.
// render.js schemeOf() strips [\x00-\x20] before detecting the scheme, so a
// `java<HT>script:` or a leading <0x01>javascript: still reads as javascript:
// and is neutralized (no href). Browsers drop those embedded C0 controls before
// acting on a URL, so failing to strip them here would let the link fire.
// --------------------------------------------------------------------------

await test("R2-2 link: control-char-obfuscated javascript: stays inert (viewer schemeOf); legit links keep href", () => {
  const TAB = String.fromCharCode(9); // a real HT byte, NOT the two chars "\t"
  const C1 = String.fromCharCode(1);  // a real C0 control, NOT the text "\\x01"

  // (a) Through parse → render: the viewer's OUTPUT must be safe for each dest.
  // (The reference parser already nulls these hrefs, so this guards the whole
  // pipeline; the render.js-specific defense is asserted in (b).)
  for (const dest of ["javascript:alert(1)", "java" + TAB + "script:alert(1)", C1 + "javascript:alert(1)"]) {
    const root = render("see [m](" + dest + ") end.\n");
    for (const a of root.querySelectorAll("a")) {
      const h = a.getAttribute("href");
      if (h == null) continue;
      const norm = h.replace(/[\x00-\x20]/g, "").toLowerCase();
      assert.ok(!norm.startsWith("javascript:"), `no javascript: href after control-strip (got ${JSON.stringify(h)})`);
    }
    assert.ok(noUnsafeUrlAttr(root), "no unsafe scheme in any href/src");
  }

  // (b) Direct renderDocument on a synthetic model. The parser strips embedded
  // control chars before render.js ever sees them, so feeding an href that STILL
  // contains the control byte is the only seam that exercises the viewer's own
  // schemeOf() [\x00-\x20] stripping — the actual R2-2 fix.
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const model = {
    diagnostics: [],
    children: [{
      kind: "paragraph",
      inlines: [
        { type: "link", href: "java" + TAB + "script:alert(1)", children: [{ type: "text", value: "a" }] },
        { type: "link", href: C1 + "javascript:alert(2)", children: [{ type: "text", value: "b" }] },
        { type: "link", href: "https://ok.example/p", children: [{ type: "text", value: "c" }] },
        { type: "link", href: "#sec", children: [{ type: "text", value: "d" }] },
        { type: "link", href: "sub/page.geml", children: [{ type: "text", value: "e" }] },
      ],
    }],
  };
  const anchors = [...renderDocument(model, document).querySelectorAll("a")];
  assert.equal(anchors[0].hasAttribute("href"), false, "TAB-obfuscated javascript: link is inert");
  assert.equal(anchors[1].hasAttribute("href"), false, "leading-C0 javascript: link is inert");
  assert.equal(anchors[2].getAttribute("href"), "https://ok.example/p", "https kept");
  assert.equal(anchors[3].getAttribute("href"), "#sec", "#anchor kept");
  assert.equal(anchors[4].getAttribute("href"), "sub/page.geml", "relative kept");
});

// --------------------------------------------------------------------------
// R2-6 — remote-media classified by SCHEME, not slash count. `https:/host`
// (ONE slash) normalizes to https://host in a browser and would auto-connect,
// so it must be gated exactly like a two-slash absolute URL — not mistaken for
// local media. Relative and data: media still load inline.
// --------------------------------------------------------------------------

await test("R2-6 media: single-slash & protocol-relative remote schemes are click-to-load, not auto-loaded", () => {
  for (const [src, why] of [["https:/host/beacon.png", "single-slash https"], ["//host/x.png", "protocol-relative"]]) {
    const root = render("![x](" + src + ")\n");
    const a = root.querySelector("a.geml-remote-media");
    assert.ok(a, `${why} → click-to-load remote-media link`);
    assert.equal(a.getAttribute("target"), "_blank", `${why}: opens in a new context`);
    const rel = a.getAttribute("rel") || "";
    assert.match(rel, /noopener/, `${why}: rel has noopener`);
    assert.match(rel, /noreferrer/, `${why}: rel has noreferrer`);
    assert.equal(hrefOf(a), src, `${why}: link carries the opt-in URL`);
    assert.equal(root.querySelector("img,audio,video"), null, `${why}: NO auto-loading media element`);
  }
  // Local/relative and data: still load inline — the gate is remote-only.
  const rel = render("![x](pic.png)\n");
  assert.equal(rel.querySelector("a.geml-remote-media"), null, "relative image not gated");
  assert.ok(rel.querySelector("img") && rel.querySelector("img").getAttribute("src") === "pic.png", "relative image inline");
  const data = render("![x](data:image/png;base64,iVBORw0KGgo=)\n");
  assert.equal(data.querySelector("a.geml-remote-media"), null, "data:image not gated");
  assert.ok(data.querySelector("img") && data.querySelector("img").getAttribute("src").startsWith("data:image/"), "data:image inline");
});

// --------------------------------------------------------------------------
// R2-3 — the code-graph fetchDoc in content.js shares the src-table's
// isSameOriginSrc confinement. Driven end-to-end through main(): a
// geml-code-graph diagram block becomes a .cg-mount[data-src]; upgradeCodeGraph
// → codeGraphWaves → buildCodeGraph → fetchDoc.
//
// SEAM NOTE (why the negatives are what they are): the code-graph path runs
// data-src through the renderer's own cgJoin() path-normalizer BEFORE fetchDoc.
// cgJoin collapses `//` → `/` and resolves `..`, so `//host`, a same-scheme
// absolute (`https://evil` on an https page) and `../escape` all relativize to
// same-origin / same-directory and never reach a foreign host — cgJoin, not the
// guard, stops those. The inputs that genuinely reach fetchDoc as an escape and
// are REFUSED by isSameOriginSrc are a cross-SCHEME absolute (http:// on an
// https page) and an absolute file:/// outside the doc directory; those are the
// guard-exercising negatives below. `//host` / `../` are kept as documented
// same-origin invariants. All mounts resolve to errors (no data-graph), so the
// draw runtime is a no-op under linkedom.
// --------------------------------------------------------------------------

// A same-origin sibling that loads but yields no drawable graph (container index
// with a #modules table lacking the module/doc columns → buildCodeGraph errors,
// so no data-graph is set and codeGraphRuntime stays a no-op). The point of the
// case is only that the sibling WAS fetched.
const CG_SIBLING = '=== meta\ncontainer = "x"\n===\n\n=== table {#modules format=csv header=1}\na, b\n1, 2\n===\n';

await test("R2-3 (http): code-graph fetchDoc fetches same-origin siblings (credentials omit); cross-origin is refused", async () => {
  const href = "https://site.test/docs/report.geml";
  const raw =
    '=== diagram {#g1 format=geml-code-graph src="sibling.geml"}\n===\n\n' +
    '=== diagram {#g2 format=geml-code-graph src="http://evil.example/g.geml"}\n===\n\n' +
    '=== diagram {#g3 format=geml-code-graph src="//evil.example/y.geml"}\n===\n';
  const ctx = await runMain({
    href, pathname: "/docs/report.geml", protocol: "https:", docRaw: raw,
    routes: { "https://site.test/docs/sibling.geml": CG_SIBLING },
    waitCodeGraph: true,
  });

  const cg = ctx.calls.filter((c) => c.url !== href); // drop the document read
  // fetchDoc ALLOWED the same-origin sibling — with credentials omitted.
  const sib = cg.find((c) => c.url === "https://site.test/docs/sibling.geml");
  assert.ok(sib, "same-origin sibling was fetched");
  assert.equal(sib.opts && sib.opts.credentials, "omit", "sibling fetch omits credentials");
  // The cross-scheme absolute genuinely reaches fetchDoc as a foreign origin and
  // is REFUSED — never requested (this is the isSameOriginSrc guard firing).
  assert.ok(!cg.some((c) => c.url === "http://evil.example/g.geml"), "cross-origin doc was never requested");
  // Belt: NO code-graph fetch ever leaves the document's origin (covers the
  // //host case, which cgJoin relativizes onto site.test rather than the foreign host).
  assert.ok(cg.length > 0 && cg.every((c) => { try { return new URL(c.url).host === "site.test"; } catch { return false; } }),
    "every code-graph fetch stayed on the document origin");
});

await test("R2-3 (file://): code-graph fetchDoc reads same-directory siblings; absolute/out-of-dir paths are refused", async () => {
  const href = "file:///C:/docs/report.geml";
  const raw =
    '=== diagram {#g1 format=geml-code-graph src="data.geml"}\n===\n\n' +
    '=== diagram {#g2 format=geml-code-graph src="file:///C:/Windows/win.ini"}\n===\n\n' +
    '=== diagram {#g3 format=geml-code-graph src="../secret.geml"}\n===\n';
  const ctx = await runMain({
    href, pathname: "/C:/docs/report.geml", protocol: "file:",
    bodyHtml: `<pre>${raw.replace(/</g, "&lt;")}</pre>`,
    routes: { "file:///C:/docs/data.geml": CG_SIBLING },
    waitCodeGraph: true,
  });

  const cg = ctx.calls; // file:// reads the document from the <pre>, so no doc fetch
  const sib = cg.find((c) => c.url === "file:///C:/docs/data.geml");
  assert.ok(sib, "same-directory sibling was fetched");
  assert.equal(sib.opts && sib.opts.credentials, "omit", "sibling fetch omits credentials");
  // The absolute out-of-directory file path genuinely reaches fetchDoc and is
  // REFUSED — never requested (isSameOriginSrc's file:// directory guard firing).
  assert.ok(!cg.some((c) => /win\.ini/i.test(c.url)), "absolute out-of-dir file path was never requested");
  // Belt: NO code-graph fetch escapes the document's own directory (covers the
  // ../escape case, which cgJoin resolves back inside file:///C:/docs/).
  assert.ok(cg.length > 0 && cg.every((c) => c.url.startsWith("file:///C:/docs/")),
    "every code-graph fetch stayed inside the document directory");
});

console.warn = _warn;
console.log(`\n${passed} test(s) passed.`);
