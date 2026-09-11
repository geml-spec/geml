// 页面布局（计划 F）：样式入口的发现、视图模型 → DOM/CSS、组件与状态。
// linkedom 提供 document；三个模块都是纯函数，所以在 Node 里跑。
import { readFileSync } from "node:fs";
import { parse } from "../../../geml-parser/dist/geml.js";
import { loadStylesheet, resolveStyle } from "../src/parse-entry.js";
import { renderBlock, collectLabels, renderDocument } from "../src/render.js";
import { entryUrlFor, isStyleEntry, loadPageStyle, producersOf, STYLE_PREFETCH_FILES } from "../src/style-entry.js";
import { classFor, cssForPage, renderPage } from "../src/layout.js";
import { createState, COMPONENTS } from "../src/components.js";
import { parseHTML } from "linkedom";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const atest = async (name, fn) => { await fn(); passed++; console.log("ok", name); };

const dom = () => parseHTML("<!doctype html><html><head></head><body></body></html>");

test("parse-entry 露出 loadStylesheet / resolveStyle，不经 geml.js", () => {
  assert.equal(typeof loadStylesheet, "function");
  assert.equal(typeof resolveStyle, "function");
});

// ---------------------------------------------------------------- style-entry

const SITE = "https://host.test/site/";
const ENTRY = `=== meta
profile = "geml-style/v1"
default-style = "base.geml"
===

=== table {#sitemap}
| document | template |
|---|---|
| page.geml | page.style.geml |
===
`;
const BASE = `=== meta
profile = "geml-style/v1"
===
=== style-rule {#all match="text" font-size=16px}
===
`;
const PAGE_STYLE = `=== meta
profile = "geml-style/v1"
===
=== embed {#shared src="shared.geml"}
===
=== style-screen {#page axis=column slots="text#hdr, #body"}
===
=== style-frame {#body axis=row slots="table#tree, text#main"}
===
`;
const SHARED = `=== meta
profile = "geml-style/v1"
===
=== style-rule {#tree match="table#tree" component=tree width=321px}
===
`;
const DOC = `=== text {#hdr}
header
===
=== table {#tree format=csv}
name
a
===
=== text {#main}
body
===
`;
const FILES = new Map([
  [SITE + "_index/index.geml", ENTRY],
  [SITE + "_index/base.geml", BASE],
  [SITE + "_index/page.style.geml", PAGE_STYLE],
  [SITE + "_index/shared.geml", SHARED],
]);
const fetchFrom = (files) => async (url) => files.get(url) ?? null;
const deps = { parse, loadStylesheet, resolveStyle };

test("entryUrlFor：与文档同目录的 _index/index.geml", () => {
  assert.equal(entryUrlFor(SITE + "page.geml"), SITE + "_index/index.geml");
  assert.equal(entryUrlFor("file:///C:/docs/a.geml"), "file:///C:/docs/_index/index.geml");
});

test("isStyleEntry：靠 meta.profile 认，不靠路径", () => {
  assert.equal(isStyleEntry(parse(ENTRY)), true);
  assert.equal(isStyleEntry(parse('=== meta\ntitle = "not a style"\n===\n')), false);
  assert.equal(isStyleEntry(parse("# no meta at all\n")), false);
});

await atest("loadPageStyle：入口 → default-style + sitemap 命中 + 传递的 embed，全部预取后求解", async () => {
  const page = await loadPageStyle({ docUrl: SITE + "page.geml", fetchText: fetchFrom(FILES), model: parse(DOC), ...deps });
  assert.ok(page, "有入口");
  assert.equal(page.forDoc, "page.geml");
  assert.deepEqual(page.errors, [], JSON.stringify(page.vm.diagnostics));
  assert.deepEqual(page.vm.screens.map((s) => s.id), ["page"]);
  assert.deepEqual(page.vm.frames.map((f) => f.id), ["body"]);
  const tree = page.vm.bindings.find((b) => b.block === "#tree");
  assert.equal(tree.params.component, "tree", "embed 进来的规则生效了");
  assert.equal(tree.box.width, "321px");
  assert.equal(page.vm.bindings.find((b) => b.block === "#hdr").box["font-size"], "16px", "默认层生效了");
});

await atest("loadPageStyle：没有入口 → null；入口不认 → null；读不到的样式表 → 有诊断的视图模型", async () => {
  assert.equal(await loadPageStyle({ docUrl: SITE + "page.geml", fetchText: fetchFrom(new Map()), model: parse(DOC), ...deps }), null);
  const notEntry = new Map([[SITE + "_index/index.geml", '=== meta\ntitle = "x"\n===\n']]);
  assert.equal(await loadPageStyle({ docUrl: SITE + "page.geml", fetchText: fetchFrom(notEntry), model: parse(DOC), ...deps }), null);
  const missingBase = new Map([[SITE + "_index/index.geml", ENTRY], [SITE + "_index/page.style.geml", PAGE_STYLE], [SITE + "_index/shared.geml", SHARED]]);
  const page = await loadPageStyle({ docUrl: SITE + "page.geml", fetchText: fetchFrom(missingBase), model: parse(DOC), ...deps });
  assert.ok(page.vm.diagnostics.some((d) => d.code === "style-embed-not-expanded" && /base\.geml/.test(d.message)), JSON.stringify(page.vm.diagnostics));
});

await atest("loadPageStyle：预取有上限 —— 超过文件数就当没有入口，不无限拉", async () => {
  // 宽而不深：一份 hub 在第 2 层 embed 几十份兄弟 —— 一条链先撞的是深度上限（8），文件数上限
  // 要靠宽度才碰得到。
  const files = new Map([[SITE + "_index/index.geml", '=== meta\nprofile = "geml-style/v1"\ndefault-style = "s0.geml"\n===\n']]);
  let hub = '=== meta\nprofile = "geml-style/v1"\n===\n';
  for (let i = 1; i <= STYLE_PREFETCH_FILES + 5; i++) {
    hub += `=== embed {#e${i} src="s${i}.geml"}\n===\n`;
    files.set(SITE + `_index/s${i}.geml`, '=== meta\nprofile = "geml-style/v1"\n===\n');
  }
  files.set(SITE + "_index/s0.geml", hub);
  let fetches = 0;
  const counting = async (url) => { fetches++; return files.get(url) ?? null; };
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    const page = await loadPageStyle({ docUrl: SITE + "page.geml", fetchText: counting, model: parse(DOC), ...deps });
    assert.equal(page, null);
  } finally { console.warn = warn; }
  assert.ok(fetches <= STYLE_PREFETCH_FILES + 1, `fetched ${fetches}`);
  assert.equal(warned, 1);
});

// ---------------------------------------------------------------- layout

const SHEET = `=== meta
profile = "geml-style/v1"
===
=== style-screen {#page axis=column slots="text#hdr, #body"}
===
=== style-frame {#body axis=row slots="table#tree, #card"}
===
=== style-frame {#card axis=column slots="text#toolbar, text#main"}
===
=== style-state {#tree type=scalar match="table#tree" on=toggle init-value=open}
===
=== style-rule {#t match="table#tree" component=tree width=321px sticky=0 scroll=own hide-below=1012}
===
=== style-rule {#tc match="table#tree" when="$tree=closed" width=0}
===
=== style-rule {#m match="text#main" padding=32px max-width=1012px font-size=16px line-height=24px color="#1f2328"}
===
`;
const DOC3 = `=== text {#hdr}
header
===
=== table {#tree format=csv}
name
agents
docs
===
=== text {#toolbar}
Preview · Code · Blame
===
=== text {#main}
body text
===
=== text {#orphan}
not placed by any slot
===
`;
const vmOf = (sheetText, docText) => {
  const model = parse(docText);
  const sheet = loadStylesheet(parse(sheetText));
  const vm = resolveStyle(sheet, [{ path: "page.geml", doc: model }]);
  return { vm, model, sheet };
};
const page = (sheetText, docText) => {
  const { vm, model, sheet } = vmOf(sheetText, docText);
  const { document } = dom();
  const out = renderPage(vm, model, document, { renderBlock, labels: collectLabels(model.children), components: {}, state: null, producers: producersOf(sheet) });
  return { ...out, document, vm, model };
};
const kids = (el, sel) => [...el.children].filter((c) => c.matches(sel));

test("classFor：块地址变成合法的 class 名", () => {
  assert.equal(classFor("#file-tree"), "geml-b-file-tree");
  assert.equal(classFor("#a.b c"), "geml-b-a_b_c");
});

test("renderPage：screen → frame → frame 三层，axis 落在 data-axis 上，块按槽位顺序进格子", () => {
  const { root } = page(SHEET, DOC3);
  const screen = root.querySelector('section.geml-frame[data-id="page"]');
  assert.ok(screen); assert.equal(screen.getAttribute("data-axis"), "column");
  const body = kids(screen, 'section.geml-frame[data-id="body"]')[0];
  assert.ok(body); assert.equal(body.getAttribute("data-axis"), "row");
  const card = kids(body, 'section.geml-frame[data-id="card"]')[0];
  assert.ok(card);
  const order = [...screen.querySelectorAll(".geml-placed")].map((e) => e.getAttribute("data-block"));
  assert.deepEqual(order, ["#hdr", "#tree", "#toolbar", "#main"]);
});

test("renderPage：没被放置的块不出现，数量报回来", () => {
  const { root, unplaced } = page(SHEET, DOC3);
  assert.equal(root.querySelector('[data-block="#orphan"]'), null);
  assert.equal(unplaced, 1);
});

test("cssForPage：box 变 CSS；sticky/scroll/hide-below 各有翻译；variant 挂在 body 的状态 class 上", () => {
  const { vm } = vmOf(SHEET, DOC3);
  const css = cssForPage(vm);
  assert.match(css, /\.geml-b-tree \{[^}]*width: 321px/);
  assert.match(css, /\.geml-b-tree \{[^}]*position: sticky; top: 0px/);
  assert.match(css, /\.geml-b-tree \{[^}]*overflow: auto/);
  assert.match(css, /@media \(max-width: 1011px\) \{ \.geml-b-tree \{ display: none \} \}/);
  assert.match(css, /\.geml-b-main \{[^}]*max-width: 1012px;[^}]*font-size: 16px;[^}]*line-height: 24px;[^}]*color: #1f2328/);
  assert.match(css, /body\.geml-s-tree-closed \.geml-b-tree \{[^}]*width: 0px/);
  assert.equal(/url\(/.test(css), false, "CSP：注入的 CSS 不加载任何资源");
});

test("renderPage：0 个 screen 和 2 个 screen 都返回 error，不返回半张页", () => {
  const none = vmOf('=== meta\nprofile = "geml-style/v1"\n===\n=== style-rule {#r match="text" color=red}\n===\n', DOC3);
  assert.match(renderPage(none.vm, none.model, dom().document, { renderBlock, labels: [], components: {}, state: null }).error, /no style-screen/);
  const two = vmOf('=== meta\nprofile = "geml-style/v1"\n===\n=== style-screen {#a slots="text#hdr"}\n===\n=== style-screen {#b slots="text#main"}\n===\n', DOC3);
  assert.match(renderPage(two.vm, two.model, dom().document, { renderBlock, labels: [], components: {}, state: null }).error, /2 style-screen/);
});

// ---------------------------------------------------------------- components + state

const SHEET4 = `=== meta
profile = "geml-style/v1"
===
=== style-screen {#page axis=row slots="table#tree, text#toolbar, text#main"}
===
=== style-state {#tree type=scalar match="table#tree" on=toggle init-value=open}
===
=== style-state {#tab type=scalar match="text#toolbar" on=select init-value=Preview}
===
=== style-rule {#t match="table#tree" component=tree width=321px}
===
=== style-rule {#tc match="table#tree" when="$tree=closed" width=0}
===
=== style-rule {#tb match="text#toolbar" component=tab-bar}
===
=== style-rule {#m match="text#main" component=markdown-body}
===
`;
const pageWith = (sheetText, docText) => {
  const { vm, model, sheet } = vmOf(sheetText, docText);
  const { document, window } = dom();
  const state = createState(vm, document);
  const out = renderPage(vm, model, document, { renderBlock, labels: collectLabels(model.children), components: COMPONENTS, state, producers: producersOf(sheet) });
  document.body.appendChild(out.root);
  return { ...out, document, window, state, vm };
};

test("state：init-value 上 body；set 换 class；toggle 的另一个值来自 when= 点名的那个", () => {
  const { document, state } = pageWith(SHEET4, DOC3);
  assert.equal(state.get("tree"), "open");
  assert.equal(state.get("tab"), "Preview");
  assert.ok(document.body.classList.contains("geml-s-tree-open"));
  assert.equal(state.toggleTarget("tree"), "closed");
  state.set("tree", "closed");
  assert.ok(document.body.classList.contains("geml-s-tree-closed"));
  assert.equal(document.body.classList.contains("geml-s-tree-open"), false);
});

test("state：toggle 找不到恰好一个别的值就惰性（返回 null），组件不装开关", () => {
  const sheet = SHEET4.replace('=== style-rule {#tc match="table#tree" when="$tree=closed" width=0}\n===\n', "");
  const { state, document } = pageWith(sheet, DOC3);
  assert.equal(state.toggleTarget("tree"), null);
});

test("producersOf：宽选择器不接线，console.warn 说明", () => {
  const sheet = loadStylesheet(parse('=== meta\nprofile = "geml-style/v1"\n===\n=== style-state {#any type=scalar match="table" on=toggle}\n===\n'));
  const warn = console.warn; let msg = ""; console.warn = (m) => { msg = String(m); };
  try { assert.deepEqual([...producersOf(sheet).get("any")], []); } finally { console.warn = warn; }
  assert.match(msg, /only `type#id` producers are wired/);
});

// ---------------------------------------------------------------- 端到端：真 fixture

const FIX = new URL("../../../geml-parser/test/fixtures/style-page/", import.meta.url);
const PAGE_GEML = readFileSync(new URL("first-page.geml", FIX), "utf8");
const GH_STYLE = readFileSync(new URL("first-page.style.geml", FIX), "utf8");

import { register } from "node:module";
// ---------------------------------------------------------------- 集成：真的 content.js main()，假的全局

// content.js 顶层就跑 main()、还 import CSS；照 security.test 的做法：css 走 loader hook，
// document/location/fetch/chrome 用假的，每个 case 动态 import 一份新的 content.js。
const _warn = console.warn;
console.warn = (...a) => { if (typeof a[0] === "string" && /quirks mode/i.test(a[0])) return; _warn(...a); };
register("./css-stub-hooks.mjs", import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let caseN = 100;
const resp = (text, url, { ok = true, ct = "text/plain" } = {}) => ({ ok, url, headers: { get: (h) => (h.toLowerCase() === "content-type" ? ct : null) }, text: async () => text });

async function runContent({ href, docRaw, routes = {}, files = {} }) {
  const u = new URL(href);
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  try { Object.defineProperty(document, "contentType", { value: "text/plain", configurable: true }); } catch { /* fixed */ }
  globalThis.document = document;
  globalThis.location = { href, pathname: u.pathname, protocol: u.protocol, hash: "" };
  const asked = [];
  globalThis.chrome = {
    runtime: {
      getURL: (p) => "chrome-extension://test/" + p,
      sendMessage: async (msg) => {
        if (msg && msg.type === "geml-read-file") { asked.push(msg.url); return files[msg.url] !== undefined ? { ok: true, text: files[msg.url] } : { ok: false }; }
        return { ok: false };
      },
    },
  };
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (u.protocol !== "file:" && String(url) === href) return resp(docRaw, href);
    if (Object.prototype.hasOwnProperty.call(routes, String(url))) return resp(routes[String(url)], String(url));
    return resp("", String(url), { ok: false });
  };
  if (u.protocol === "file:") document.body.innerHTML = `<pre>${docRaw.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
  await import(`../src/content.js?case=${caseN++}`);
  for (let i = 0; i < 300 && document.body.className !== "geml-body"; i++) await sleep(5);
  await sleep(30); // 让 paint 里的 await 收尾
  return { document, calls, asked };
}

const HTTPS_DOC = "https://site.test/docs/page.geml";
const ENTRY_TXT = '=== meta\nprofile = "geml-style/v1"\ndefault-style = "github.style.geml"\n===\n';

await atest("集成（https）：文档旁有入口 → 画成页；样式文件都以 credentials:omit 同源取", async () => {
  const ctx = await runContent({
    href: HTTPS_DOC, docRaw: PAGE_GEML,
    routes: { "https://site.test/docs/_index/index.geml": ENTRY_TXT, "https://site.test/docs/_index/github.style.geml": GH_STYLE },
  });
  const pageEl = ctx.document.querySelector(".geml-page");
  assert.ok(pageEl, "画成了页");
  assert.deepEqual([...ctx.document.querySelectorAll("section.geml-frame")].map((s) => s.getAttribute("data-id")), ["page", "body", "main", "card"]);
  assert.equal(ctx.document.querySelector(".geml-doc"), null, "没有再画默认文档");
  const css = ctx.document.getElementById("geml-page-css").textContent;
  assert.match(css, /\.geml-b-file-tree \{[^}]*width: 321px/);
  const styleFetches = ctx.calls.filter((c) => c.url !== HTTPS_DOC);
  assert.ok(styleFetches.some((c) => c.url === "https://site.test/docs/_index/index.geml"), "取了入口");
  assert.ok(styleFetches.every((c) => c.opts && c.opts.credentials === "omit"), "全部 credentials:omit");
});

await atest("集成（https）：没有入口 → 今天的单栏，一字不差；入口有 2 个 screen → 横幅 + 单栏", async () => {
  const plain = await runContent({ href: HTTPS_DOC, docRaw: PAGE_GEML });
  assert.equal(plain.document.querySelector(".geml-page"), null);
  assert.ok(plain.document.querySelector(".geml-doc"));
  assert.equal(plain.document.querySelector(".geml-diag-error"), null);

  const two = await runContent({
    href: HTTPS_DOC, docRaw: PAGE_GEML,
    routes: {
      "https://site.test/docs/_index/index.geml": ENTRY_TXT,
      "https://site.test/docs/_index/github.style.geml": GH_STYLE + '=== style-screen {#second slots="text#content"}\n===\n',
    },
  });
  assert.equal(two.document.querySelector(".geml-page"), null);
  assert.ok(two.document.querySelector(".geml-doc"));
  assert.match(two.document.querySelector(".geml-diag-error").textContent, /2 style-screen/);
});

await atest("集成（https）：样式表有 error（悬空 frame）→ 横幅列出诊断 + 单栏；跨域 embed 从未被 fetch", async () => {
  const ctx = await runContent({
    href: HTTPS_DOC, docRaw: PAGE_GEML,
    routes: {
      "https://site.test/docs/_index/index.geml": ENTRY_TXT,
      "https://site.test/docs/_index/github.style.geml":
        '=== meta\nprofile = "geml-style/v1"\n===\n=== embed {#x src="https://evil.example/x.geml"}\n===\n=== style-screen {#page slots="#nope"}\n===\n',
    },
  });
  assert.ok(ctx.document.querySelector(".geml-doc"));
  assert.match(ctx.document.querySelector(".geml-diag-error").textContent, /unknown-frame/);
  assert.equal(ctx.calls.some((c) => c.url.includes("evil.example")), false, "跨域 embed 没被 fetch");
});



// ---------------------------------------------------------------- 覆盖率补位：兜底分支与没走到的形状


test("cssForPage：variant 也能带 hide-below；没有 screen 时退回全局 bindings；容器的 component= 落在 data-component 上", () => {
  const sheet = `=== meta
profile = "geml-style/v1"
===
=== style-screen {#page component=grid axis=row slots="table#tree, $tree"}
===
=== style-state {#tree type=scalar match="table#tree" on=toggle init-value=open}
===
=== style-rule {#t match="table#tree" width=321px}
===
=== style-rule {#tc match="table#tree" when="$tree=closed" hide-below=600}
===
`;
  const { vm, model } = vmOf(sheet, DOC3);
  const css = cssForPage(vm);
  assert.match(css, /@media \(max-width: 599px\) \{ body\.geml-s-tree-closed \.geml-b-tree \{ display: none \} \}/);
  const { document } = dom();
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: {}, state: null });
  const screen = out.root.querySelector('section[data-id="page"]');
  assert.equal(screen.getAttribute("data-component"), "grid");
  assert.ok(screen.querySelector('.geml-slot-state[data-state="tree"]'), "$state 槽位是占位，带 data-state");
  // 没有 screen：cssForPage 用全局 bindings
  const noScreen = vmOf('=== meta\nprofile = "geml-style/v1"\n===\n=== style-rule {#t match="table#tree" width=1px}\n===\n', DOC3);
  assert.match(cssForPage(noScreen.vm), /\.geml-b-tree \{ width: 1px; flex: 0 0 auto \}/);
});

test("renderPage：槽位指向的块不在这份文档里就跳过（视图模型和文档不一致时不崩）", () => {
  const { vm, model } = vmOf(SHEET, DOC3);
  vm.screens[0].slots.unshift({ kind: "blocks", selector: "text#ghost", blocks: [{ doc: "page.geml", block: "#ghost" }] });
  const out = renderPage(vm, model, dom().document, { renderBlock, labels: [], components: {}, state: null });
  assert.equal(out.root.querySelector('[data-block="#ghost"]'), null);
  assert.equal(out.root.querySelector('[data-block="#hdr"]') !== null, true);
});

test("createState：没有 init-value 的状态从空串起；没有 screen 时读全局 bindings；没有 body 也不崩；未知状态 toggle 返回 null", () => {
  const { vm } = vmOf('=== meta\nprofile = "geml-style/v1"\n===\n=== style-state {#s type=scalar match="table#tree" on=toggle}\n===\n=== style-rule {#r match="table#tree" when="$s=on" width=0}\n===\n', DOC3);
  const state = createState(vm, { body: null });
  assert.equal(state.get("s"), "");
  assert.equal(state.toggleTarget("s"), "on", "init 是空串，when 点名的那一个是 on");
  state.set("s", "on");
  assert.equal(state.get("s"), "on");
  assert.equal(state.toggleTarget("nope"), null);
  const { document } = dom();
  const withBody = createState(vm, document);
  withBody.set("s", "");
  assert.equal([...document.body.classList].some((c) => c.startsWith("geml-s-s-")), false, "空值不留 class");
});

await atest("style-entry：sitemap 的缺格行、没 src 的 embed、带 #锚点 的 embed、以 / 结尾的文档 URL", async () => {
  const files = new Map([
    [SITE + "_index/index.geml", '=== meta\nprofile = "geml-style/v1"\ndefault-style = "d.geml"\n===\n=== table {#sitemap}\n| document | template |\n|---|---|\n| |\n| page.geml |\n===\n'],
    [SITE + "_index/d.geml", '=== meta\nprofile = "geml-style/v1"\n===\n=== embed {#none}\n===\n=== embed {#anch src="shared.geml#tree"}\n===\n'],
    [SITE + "_index/shared.geml", SHARED],
  ]);
  const seen = [];
  const page = await loadPageStyle({ docUrl: SITE + "page.geml", fetchText: async (u) => { seen.push(u); return files.get(u) ?? null; }, model: parse(DOC), ...deps });
  assert.ok(seen.includes(SITE + "_index/shared.geml"), "#锚点前面的文档部分被预取了");
  assert.equal(page.vm.bindings.find((b) => b.block === "#tree").params.component, "tree", "锚点选中的那一节进来了");
  assert.ok(page.vm.diagnostics.some((d) => d.code === "style-embed-not-expanded" && /no `src=`/.test(d.message)));
  const slash = await loadPageStyle({ docUrl: SITE, fetchText: async (u) => files.get(u) ?? null, model: parse(DOC), ...deps });
  assert.equal(slash.forDoc, "");
});

// ---------------------------------------------------------------- content.js 里原来就没盖到的路径

await atest("集成：入口 fetch 抛异常 → console.error 一条、退回单栏；空文档 → 什么都不画", async () => {
  const err = console.error; const errors = []; console.error = (...a) => errors.push(a.join(" "));
  try {
    const u = new URL(HTTPS_DOC);
    const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
    Object.defineProperty(document, "contentType", { value: "text/plain", configurable: true });
    globalThis.document = document;
    globalThis.location = { href: HTTPS_DOC, pathname: u.pathname, protocol: u.protocol, hash: "" };
    globalThis.chrome = { runtime: { getURL: (p) => p, sendMessage: async () => ({ ok: false }) } };
    globalThis.fetch = async (url) => {
      if (String(url) === HTTPS_DOC) return resp(PAGE_GEML, HTTPS_DOC);
      throw new Error("network down");
    };
    await import(`../src/content.js?case=${caseN++}`);
    for (let i = 0; i < 300 && document.body.className !== "geml-body"; i++) await sleep(5);
    await sleep(30);
    assert.ok(document.querySelector(".geml-doc"), "退回单栏");
    assert.equal(document.querySelector(".geml-page"), null);
  } finally { console.error = err; }
  // http(s) 下 readText 不吞 fetch 异常（只有 file:// 的 sendMessage 分支有 try），所以它一路
  // 冒到 content.js 的 catch —— 一条 "style entry failed"，然后照常单栏。
  assert.equal(errors.length, 1, errors.join(" | "));
  assert.match(errors[0], /style entry failed/);

  const empty = await runContent({ href: HTTPS_DOC, docRaw: "   \n" });
  assert.equal(empty.document.body.className, "", "空文档不激活");
});

await atest("集成：样式表里的不安全值被丢弃并 console.warn 点名", async () => {
  const warn = console.warn; const warns = []; console.warn = (...a) => { const s = a.join(" "); if (!/quirks mode/i.test(s)) warns.push(s); };
  try {
    const ctx = await runContent({
      href: HTTPS_DOC, docRaw: PAGE_GEML,
      routes: {
        "https://site.test/docs/_index/index.geml": ENTRY_TXT,
        "https://site.test/docs/_index/github.style.geml": GH_STYLE + '=== style-rule {#bad match="text#content" background="red} body{display:none"}\n===\n',
      },
    });
    assert.ok(ctx.document.querySelector(".geml-page"));
    const css = ctx.document.getElementById("geml-page-css").textContent;
    assert.equal(/body\s*\{|background: red/.test(css), false, css); // 注入的那截没进 CSS（fixture 自己的 hide-below 媒体查询里有合法的 display: none，不能拿它当判据）
  } finally { console.warn = warn; }
  assert.ok(warns.some((w) => /stylesheet value dropped/.test(w)), warns.join(" | "));
});

await atest("集成（默认路径）：同源 embed 展开后出现导出按钮；mermaid 图在没有 chunk 时留源码、报一条 console.error", async () => {
  const err = console.error; const errors = []; console.error = (...a) => errors.push(a.join(" "));
  let ctx;
  try {
    ctx = await runContent({
      href: HTTPS_DOC,
      docRaw: '=== embed {#e src="other.geml"}\n===\n\n=== diagram {#d format=mermaid}\ngraph TD; A-->B\n===\n',
      routes: { "https://site.test/docs/other.geml": "=== note {#n}\nborrowed\n===\n" },
    });
    for (let i = 0; i < 200 && !ctx.document.querySelector(".geml-export-btn"); i++) await sleep(5);
  } finally { console.error = err; }
  assert.ok(ctx.document.querySelector(".geml-transclusion-expanded"), "embed 展开了");
  assert.ok(ctx.document.querySelector(".geml-export-btn"), "有借来的内容才有导出按钮");
  assert.ok(errors.some((e) => /mermaid chunk load failed/.test(e)), errors.join(" | "));
});



test("容器的 box 变成 CSS：screen 画整页（body 也上一遍），frame 画自己那片", () => {
  const { vm } = vmOf(`=== meta
profile = "geml-style/v1"
===
=== style-screen {#p axis=column background="#0d1117" padding=24px gap=16px slots="text#hdr, #side"}
===
=== style-frame {#side axis=row gap=8px border-radius=6px hide-below=800 slots="table#tree"}
===
`, DOC3);
  const css = cssForPage(vm);
  assert.match(css, /\.geml-page \{[^}]*background: #0d1117/);
  assert.match(css, /\.geml-page \{[^}]*gap: 16px/);
  assert.match(css, /body\.geml-body \{ background: #0d1117 \}/, "文档比视口短时，页底下还得是这个色");
  assert.match(css, /\.geml-f-side \{[^}]*border-radius: 6px/);
  assert.match(css, /@media \(max-width: 799px\) \{ \.geml-f-side \{ display: none \} \}/);
  // 容器的值同样过形状闸
  const unsafe = [];
  cssForPage(vmOf('=== meta\nprofile = "geml-style/v1"\n===\n=== style-screen {#p background="0} body{display:none} .x{" slots="text#hdr"}\n===\n', DOC3).vm, unsafe);
  assert.equal(unsafe.length, 1, unsafe.join());
});

test("标题和散文能摆：一个 `*` 槽位按文档顺序摆下整篇，容器带上自己的 class", () => {
  const doc = "# Head {#h}\n\nloose prose\n\n=== table {#t format=csv}\na\n1\n===\n";
  const { vm, model } = vmOf('=== meta\nprofile = "geml-style/v1"\n===\n=== style-screen {#p slots="*"}\n===\n', doc);
  const { document } = dom();
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: {}, state: null });
  assert.ok(out.root, out.error);
  assert.deepEqual([...out.root.querySelectorAll("[data-block]")].map((e) => e.getAttribute("data-block")),
    ["#h", "[1]", "#t"], "标题、散文、表格，按文档顺序");
  assert.equal(out.root.querySelector('[data-block="#h"] h1').textContent, "Head");
  assert.equal(out.root.querySelector('[data-block="[1]"] p').textContent, "loose prose");
  assert.equal(out.unplaced, 0);
  assert.match(out.root.querySelector("section.geml-frame").className, /geml-f-p/);
});

await atest("整页布局下 mermaid 图照样升级：占位符在布局里，升级不受 usedLayout 影响", async () => {
  // 真 content.js，file:// 路径，bg 用真实读盘应答；mermaid 用一个假引擎顶上 ——
  // 要验的是**我们这条路**（布局画出来的占位符还找不找得到、换不换得掉），不是 mermaid 本身。
  const doc = '=== diagram {#g .doc format=mermaid}\nflowchart TD\n  A --> B\n===\n';
  const style = '=== meta\nprofile = "geml-style/v1"\n===\n'
    + '=== style-screen {#page slots=".doc"}\n===\n'
    + '=== style-rule {#md match=".doc" component=markdown-body padding=8px}\n===\n';
  const files = {
    "file:///C:/d/page.geml": doc,
    "file:///C:/d/_index/index.geml": '=== meta\nprofile = "geml-style/v1"\ndefault-style = "s.geml"\n===\n',
    "file:///C:/d/_index/s.geml": style,
  };
  const { document } = parseHTML(`<!doctype html><html><head></head><body><pre>${doc.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre></body></html>`);
  try { Object.defineProperty(document, "contentType", { value: "text/plain", configurable: true }); } catch { /* fixed */ }
  globalThis.document = document;
  globalThis.location = { href: "file:///C:/d/page.geml", pathname: "/C:/d/page.geml", protocol: "file:" };
  let asked = 0;
  globalThis.chrome = {
    runtime: {
      getURL: (p) => "chrome-extension://test/" + p,
      sendMessage: async (msg) => {
        if (msg && msg.type === "geml-read-file") {
          const t = files[String(msg.url)];
          return t === undefined ? { ok: false } : { ok: true, text: t };
        }
        if (msg && msg.type === "geml-load-mermaid") {
          asked++;
          globalThis.__GEML_MERMAID__ = {
            initialize() {},
            async render(id, src) { return { svg: `<svg data-src="${src.trim().split("\n")[0]}"><g/></svg>` }; },
          };
          return { ok: true };
        }
        return { ok: false };
      },
    },
  };
  globalThis.fetch = async (u) => { throw new Error("no fetch on file://: " + u); };
  delete globalThis.__GEML_MERMAID__;

  await import("../src/content.js?mermaid-in-layout");
  for (let i = 0; i < 400 && !document.querySelector(".geml-page"); i++) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 400 && !document.querySelector(".geml-mermaid svg"); i++) await new Promise((r) => setTimeout(r, 5));

  assert.ok(document.querySelector(".geml-page"), "走的是整页布局这条路");
  assert.equal(asked, 1, "布局路径下依然向 background 要了 mermaid");
  const svg = document.querySelector(".geml-mermaid svg");
  assert.ok(svg, "占位符被换成了 SVG");
  assert.equal(svg.getAttribute("data-src"), "flowchart TD", "换进去的是这张图的源");
  assert.ok(document.querySelector('[data-block="#g"] .geml-mermaid svg'), "而且还在它那个槽位里");
});

test("geml-form/v1 的控件：七种 type 各画成什么，options=#id 从哪儿取，约束键原样落到属性上", () => {
  const doc = parse('=== meta\nprofile = "geml-form/v1"\n===\n'
    + '=== form-options {#plans format=csv}\nvalue,label\nbasic,Basic\npro,Pro\n===\n'
    + '==== form {#f handler=onboarding}\n'
    + '=== form-field {#a label="Name" type=text required maxlength=40 placeholder="Full name"}\n===\n'
    + '=== form-field {#b label="Bio" type=textarea}\n===\n'
    + '=== form-field {#c label="Revenue" type=number min=0 max=99999 step=1}\n===\n'
    + '=== form-field {#d label="When" type=date}\n===\n'
    + '=== form-field {#e label="Agree" type=boolean}\n===\n'
    + '=== form-field {#g label="Plan" type=select options=#plans}\n===\n'
    + '=== form-field {#h label="Licence" type=file accept=".pdf,image/*"}\n===\n'
    + '=== form-note {#n}\nWe never share it.\n===\n'
    + '====\n');
  const { document } = dom();
  const root = renderDocument(doc, document);

  assert.ok(root.querySelector("form.geml-form"), "form 是个 <form>");
  assert.equal(root.querySelector('#a input').getAttribute("type"), "text");
  assert.equal(root.querySelector('#a input').getAttribute("maxlength"), "40", "约束键是声明：原样落到属性上，这里不代替谁校验");
  assert.equal(root.querySelector('#a input').hasAttribute("required"), true);
  assert.ok(root.querySelector("#b textarea"));
  assert.equal(root.querySelector("#c input").getAttribute("type"), "number");
  assert.equal(root.querySelector("#c input").getAttribute("step"), "1");
  assert.equal(root.querySelector("#d input").getAttribute("type"), "date");
  assert.equal(root.querySelector("#e input").getAttribute("type"), "checkbox");
  assert.equal(root.querySelector("#h input").getAttribute("accept"), ".pdf,image/*");
  // select 的选项来自 `options=#plans` 那张表 —— 按地址找，不把选项抄进字段
  const opts = [...root.querySelectorAll("#g option")].map((o) => [o.getAttribute("value"), o.textContent]);
  assert.deepEqual(opts, [["basic", "Basic"], ["pro", "Pro"]]);
  // form-options 自己不占版面
  assert.equal(root.querySelector("#plans"), null);
  assert.match(root.querySelector(".geml-form-note").textContent, /never share/);
});

// ---------------------------------------------------------------- 第二个页面用例（设计 2026-09-10）

test("cssForPage：部件绑定接标签；@hover 接 :hover；块上的 axis 生成 .geml-items 的 flex；gap 跟着 axis 走", () => {
  const { vm } = vmOf(`=== meta
profile = "geml-style/v1"
===
=== style-screen {#p slots="text#nav"}
===
=== style-state {#side type=scalar match="text#nav" on=toggle init-value=open}
===
=== style-rule {#n match="text#nav" axis=row gap=16px padding=8px}
===
=== style-rule {#l match="text#nav link" color="#0969da" padding="4px 6px"}
===
=== style-rule {#h match="text#nav link" when="@hover" background="#eaeef2"}
===
=== style-rule {#hc match="text#nav link" when="$side=closed, @hover" background="#fff"}
===
=== style-rule {#i match="text#nav image" width=16px}
===
`, '=== text {#nav}\n- ![](a.svg) [Code](https://x)\n===\n');
  const css = cssForPage(vm);
  assert.match(css, /\.geml-b-nav \{ padding: 8px \}/, "gap 不在块自己身上");
  assert.match(css, /\.geml-b-nav \.geml-items \{ display: flex; flex-direction: row; list-style: none; margin: 0; padding: 0; gap: 16px \}/);
  assert.match(css, /\.geml-b-nav a \{ color: #0969da; padding: 4px 6px \}/);
  assert.match(css, /\.geml-b-nav a:hover \{ background: #eaeef2 \}/);
  assert.match(css, /body\.geml-s-side-closed \.geml-b-nav a:hover \{ background: #fff \}/);
  assert.match(css, /\.geml-b-nav img \{ width: 16px; flex: 0 0 auto \}/);
  assert.doesNotMatch(css, /geml-s-@/, "伪状态不会变成 body 上的 class");
});

test("cssForPage：view 有两副面孔 —— 基础面显示、其余隐藏，按条件反过来", () => {
  const { vm } = vmOf(`=== meta
profile = "geml-style/v1"
===
=== style-screen {#p slots="text#doc"}
===
=== style-state {#tab type=scalar match="text#doc" on=select init-value=Preview}
===
=== style-rule {#r match="text#doc" view=rendered max-width=1012px}
===
=== style-rule {#c match="text#doc" when="$tab=Code" view=source editable=yes}
===
=== style-rule {#b match="text#doc" when="$tab=Blame" view=source}
===
`, '=== text {#doc}\nbody\n===\n');
  const css = cssForPage(vm);
  assert.match(css, /\.geml-b-doc > \.geml-face \{ display: none \}/);
  assert.match(css, /\.geml-b-doc > \.geml-face-rendered \{ display: revert \}/);
  assert.match(css, /body\.geml-s-tab-Code \.geml-b-doc > \.geml-face \{ display: none \}/);
  assert.match(css, /body\.geml-s-tab-Code \.geml-b-doc > \.geml-face-source-editable \{ display: revert \}/);
  assert.match(css, /body\.geml-s-tab-Blame \.geml-b-doc > \.geml-face-source \{ display: revert \}/);
  assert.doesNotMatch(css, /view:|editable:/, "view/editable 不是 CSS 属性");
});


await atest("端到端：GitHub blob 页的 fixture 经入口 → 视图模型 → 一整页 DOM + CSS", async () => {
  const files = new Map([
    [SITE + "_index/index.geml", '=== meta\nprofile = "geml-style/v1"\ndefault-style = "github.style.geml"\n===\n'],
    [SITE + "_index/github.style.geml", GH_STYLE],
  ]);
  const model = parse(PAGE_GEML);
  const pg = await loadPageStyle({ docUrl: SITE + "page.geml", fetchText: fetchFrom(files), model, ...deps });
  assert.deepEqual(pg.errors, [], JSON.stringify(pg.vm.diagnostics));
  const { document, window } = dom();
  const state = createState(pg.vm, document);
  const out = renderPage(pg.vm, model, document, { renderBlock, labels: collectLabels(model.children), components: COMPONENTS, state, producers: pg.producers });
  assert.ok(out.root, out.error);
  document.body.appendChild(out.root);
  assert.equal(out.unplaced, 0, "那一页的每个块都被放置了");
  const ids = [...out.root.querySelectorAll("section.geml-frame")].map((s) => s.getAttribute("data-id"));
  assert.deepEqual(ids, ["page", "body", "main", "card"]);
  // 第一个用例的 fixture 还点着 tab-bar / markdown-body 这些已删的组件名：它们退回默认渲染，
  // 块照常在位；$tree 槽位是占位。宿主不认得的名字只是 warning，不是 error。
  assert.ok(out.root.querySelector('[data-block="#toolbar"]'));
  assert.ok(out.root.querySelector('[data-block="#content"]'));
  assert.equal(out.root.querySelector(".geml-slot-state").getAttribute("data-state"), "tree");
  assert.match(out.css, /\.geml-b-file-tree \{[^}]*width: 321px/);
  assert.match(out.css, /body\.geml-s-tree-closed \.geml-b-file-tree \{[^}]*width: 0px/);
  assert.match(out.css, /@media \(max-width: 1011px\)/);
  // 交互：树是 $tree 的产生者（on=toggle）—— 块当触发者，点它折叠
  const tree = out.root.querySelector('[data-block="#file-tree"]');
  assert.equal(tree.getAttribute("role"), "button");
  tree.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.ok(document.body.classList.contains("geml-s-tree-closed"));
});

test("容器当组件：component= 与参数从容器来，宿主注册什么就画什么", () => {
  const doc = "=== text {#body}\nthe document\n===\n";
  const { vm, model } = vmOf(`=== meta
profile = "geml-style/v1"
===
=== style-screen {#page axis=column slots="#top, text#body"}
===
=== style-frame {#top axis=row component=stamp label="hello" slots=""}
===
`, doc);
  const { document } = dom();
  const stamp = (_block, params, ctx) => { const s = ctx.dom.createElement("span"); s.className = "stamp"; s.textContent = String(params.label); return s; };
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: { stamp }, state: null });
  assert.ok(out.root, out.error);
  const top = out.root.querySelector('section[data-id="top"]');
  assert.equal(top.getAttribute("data-component"), "stamp");
  assert.equal(top.querySelector(".stamp").textContent, "hello");
  assert.equal(out.root.querySelector('[data-block="#body"]').textContent.trim(), "the document");
});

test("$state 槽位：scalar 状态是空占位，带 data-state；不再画 ☰", () => {
  const sheet = "=== meta\nprofile = \"geml-style/v1\"\n===\n"
    + '=== style-screen {#p axis=column slots="$tree, table#tree"}\n===\n'
    + '=== style-state {#tree type=scalar match="table#tree" on=toggle init-value=open}\n===\n'
    + '=== style-rule {#c match="table#tree" when="$tree=closed" width=0}\n===\n';
  const { vm, model } = vmOf(sheet, DOC3);
  const { document } = dom();
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: COMPONENTS, state: createState(vm, document) });
  const slot = out.root.querySelector(".geml-slot-state");
  assert.equal(slot.getAttribute("data-state"), "tree");
  assert.equal(slot.children.length, 0);
  assert.equal(out.root.querySelector("button"), null);
});

test("块当触发者：toggle 状态的产生者是块时，包装元素可点、可键盘；浮层状态点别处关掉，非浮层不管", () => {
  const sheet = `=== meta
profile = "geml-style/v1"
===
=== style-screen {#p axis=column slots="text#caret, #menu, text#other"}
===
=== style-frame {#menu axis=column slots="text#items"}
===
=== style-state {#m type=scalar match="text#caret" on=toggle init-value=closed}
===
=== style-rule {#hide match="#menu" visible=no}
===
=== style-rule {#show match="#menu" when="$m=open" visible=yes layer=overlay}
===
`;
  const doc = '=== text {#caret}\n![Open](caret.svg)\n===\n=== text {#items}\n- [a](https://a)\n===\n=== text {#other}\nelsewhere\n===\n';
  const { vm, model, sheet: loaded } = vmOf(sheet, doc);
  const { document } = dom();
  const state = createState(vm, document);
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: COMPONENTS, state, producers: producersOf(loaded) });
  document.body.appendChild(out.root);
  const caret = out.root.querySelector('[data-block="#caret"]');
  assert.equal(caret.getAttribute("role"), "button");
  assert.equal(caret.getAttribute("tabindex"), "0");
  caret.dispatchEvent(new document.defaultView.Event("click", { bubbles: true }));
  assert.equal(state.get("m"), "open");
  out.root.querySelector('[data-block="#other"]').dispatchEvent(new document.defaultView.Event("click", { bubbles: true }));
  assert.equal(state.get("m"), "closed", "浮层开着，点别处关掉");
  // linkedom 没有 KeyboardEvent：用普通 Event 带上 key
  const enter = new document.defaultView.Event("keydown", { bubbles: true });
  Object.defineProperty(enter, "key", { value: "Enter" });
  caret.dispatchEvent(enter);
  assert.equal(state.get("m"), "open", "键盘也能翻");
});

test("字段喂状态：select 状态的产生者是 form-field 时，值就是状态；没 init-value 用字段的 value=；change 写状态", () => {
  const sheet = `=== meta
profile = "geml-style/v1"
===
=== style-screen {#p axis=column slots="form-field#view, text#doc"}
===
=== style-state {#tab type=scalar match="form-field#view" on=select}
===
=== style-rule {#c match="text#doc" when="$tab=Code" color=red}
===
`;
  const doc = '=== meta\nprofile = "geml-form/v1"\n===\n=== form-options {#views format=csv}\nvalue,label\nPreview,Preview\nCode,Code\n===\n=== form-field {#view type=select options=#views value=Preview}\n===\n=== text {#doc}\nbody\n===\n';
  const { vm, model, sheet: loaded } = vmOf(sheet, doc);
  const { document } = dom();
  const state = createState(vm, document);
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: COMPONENTS, state, producers: producersOf(loaded) });
  assert.equal(state.get("tab"), "Preview", "初值取字段的 value=");
  const sel = out.root.querySelector("select");
  // linkedom 的 select.value 只有 getter：用 option 的 selected 属性选中
  for (const o of sel.querySelectorAll("option")) o.removeAttribute("selected");
  sel.querySelector('option[value="Code"]').setAttribute("selected", "");
  sel.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
  assert.equal(state.get("tab"), "Code");
  assert.ok(document.body.classList.contains("geml-s-tab-Code"));
});

test("segments：select 画成分段按钮，aria-pressed 跟状态，点击写字段值与状态", () => {
  const sheet = `=== meta
profile = "geml-style/v1"
===
=== style-screen {#p axis=column slots="form-field#view"}
===
=== style-state {#tab type=scalar match="form-field#view" on=select}
===
=== style-rule {#seg match="form-field#view" component=segments}
===
`;
  const doc = '=== meta\nprofile = "geml-form/v1"\n===\n=== form-options {#views format=csv}\nvalue,label\nPreview,Preview\nCode,Code\nBlame,Blame\n===\n=== form-field {#view type=select options=#views value=Preview}\n===\n';
  const { vm, model, sheet: loaded } = vmOf(sheet, doc);
  const { document } = dom();
  const state = createState(vm, document);
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: COMPONENTS, state, producers: producersOf(loaded) });
  const btns = [...out.root.querySelectorAll(".geml-segments button")];
  assert.deepEqual(btns.map((b) => b.textContent), ["Preview", "Code", "Blame"]);
  assert.deepEqual(btns.map((b) => b.getAttribute("aria-pressed")), ["true", "false", "false"]);
  assert.equal(state.get("tab"), "Preview");
  btns[1].dispatchEvent(new document.defaultView.Event("click", { bubbles: true }));
  assert.equal(state.get("tab"), "Code");
  assert.deepEqual(btns.map((b) => b.getAttribute("aria-pressed")), ["false", "true", "false"]);
  assert.equal(out.root.querySelector("select"), null, "不再是原生下拉");
});

test("tree：嵌套列表里带子列表的条目包成 details[open]/summary，没子列表的不包；没有列名", () => {
  const sheet = '=== meta\nprofile = "geml-style/v1"\n===\n=== style-screen {#p slots="text#t"}\n===\n=== style-rule {#r match="text#t" component=tree}\n===\n';
  const doc = '=== text {#t}\n- ![](d.svg) [docs](https://d)\n  - ![](f.svg) [a.md](https://d/a)\n- ![](f.svg) [README.md](https://r)\n===\n';
  const { vm, model } = vmOf(sheet, doc);
  const { document } = dom();
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: COMPONENTS, state: null });
  const lis = [...out.root.querySelectorAll('[data-block="#t"] > .text > ul > li')];
  assert.equal(lis.length, 2);
  const d = lis[0].querySelector("details");
  assert.ok(d && d.hasAttribute("open"), "有子项 = 展开着");
  assert.equal(d.querySelector("summary a").getAttribute("href"), "https://d");
  // `d.querySelector("ul a")` 会连外层 ul 一起算祖先，选到 summary 里的链接；要的是 details 里那个子列表
  const sub = [...d.children].find((c) => c.tagName === "UL");
  assert.equal(sub.querySelector("a").getAttribute("href"), "https://d/a");
  assert.equal(lis[1].querySelector("details"), null);
});

test("axis 上块：第一个列表标成 .geml-items；view=source 画两副面，源码来自语料原文或块的行段", () => {
  const sheet = `=== meta
profile = "geml-style/v1"
===
=== style-screen {#p axis=column slots="text#nav, embed#doc, code#c"}
===
=== style-state {#tab type=scalar match="text#nav" on=toggle init-value=Preview}
===
=== style-rule {#n match="text#nav" axis=row}
===
=== style-rule {#d match="embed#doc" when="$tab=Code" view=source editable=yes}
===
=== style-rule {#cc match="code#c" view=source}
===
`;
  const host = '=== text {#nav}\n- [a](https://a)\n===\n=== embed {#doc src="other.geml"}\n===\n=== code {#c lang=js}\nlet x = 1;\n===\n';
  const other = "=== text {#o}\nborrowed\n===\n";
  const model = parse(host);
  const loaded = loadStylesheet(parse(sheet));
  const corpus = [{ path: "page.geml", doc: model, text: host }, { path: "other.geml", doc: parse(other), text: other }];
  const vm = resolveStyle(loaded, corpus);
  const { document } = dom();
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: COMPONENTS, state: createState(vm, document), corpus });
  assert.ok(out.root, out.error);
  assert.ok(out.root.querySelector('[data-block="#nav"] ul.geml-items'), "条目容器标出来了");
  const doc = out.root.querySelector('[data-block="#doc"]');
  assert.ok(doc.querySelector(".geml-face-rendered"), "渲染面");
  const ta = doc.querySelector("textarea.geml-face-source-editable");
  assert.ok(ta, "可编辑的源码面是 textarea");
  assert.equal(ta.textContent.trim(), other.trim(), "embed 的源码是借来那份文档的原文");
  const pre = out.root.querySelector('[data-block="#c"] pre.geml-face-source');
  assert.ok(pre, "不可编辑的源码面是 pre");
  assert.match(pre.textContent, /=== code \{#c lang=js\}/, "宿主文档的块按行段切，连围栏一起");
  assert.match(pre.textContent, /let x = 1;/);
});

test("cssForPage：layer=screen 盖住视口并居中；fade-out 出一条动画，秒数来自样式表", () => {
  const { vm } = vmOf(`=== meta
profile = "geml-style/v1"
===
=== style-screen {#p slots="#splash, text#nav"}
===
=== style-frame {#splash layer=screen fade-out=1 slots="text#nav"}
===
=== style-rule {#n match="text#nav" fade-out=2.5}
===
`, '=== text {#nav}\n- [a](https://a)\n===\n');
  const css = cssForPage(vm);
  assert.match(css, /\.geml-f-splash \{[^}]*position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center/);
  assert.match(css, /\.geml-f-splash \{[^}]*animation: geml-fade 1s ease-in forwards/);
  assert.match(css, /\.geml-b-nav \{[^}]*animation: geml-fade 2\.5s ease-in forwards/);
  assert.doesNotMatch(css, /fade-out:|layer:/, "两个都不是 CSS 属性名");
  assert.equal(/url\(/.test(css), false, "CSP：注入的 CSS 不加载任何资源");
});

test("gap 同时管条目之间和条目里面 —— 图标和文字的距离不再写死在宿主", () => {
  const { vm } = vmOf('=== meta\nprofile = "geml-style/v1"\n===\n'
    + '=== style-screen {#p slots="text#nav, text#plain"}\n===\n'
    + '=== style-rule {#n match="text#nav" axis=row gap=8px}\n===\n'
    + '=== style-rule {#q match="text#plain" axis=row}\n===\n',
    '=== text {#nav}\n- ![](a.svg) [a](https://a)\n===\n=== text {#plain}\n- b\n===\n');
  const css = cssForPage(vm);
  assert.match(css, /\.geml-b-nav \.geml-items \{[^}]*gap: 8px \}/);
  assert.match(css, /\.geml-b-nav \.geml-items > li \{ gap: 8px \}/);
  assert.doesNotMatch(css, /\.geml-b-plain \.geml-items > li/, "没写 gap 就不生成条目内的规则");
});

test("tree 的 indent 是组件参数：样式表给就用它，不给用默认值，危险值退回默认", () => {
  const doc = '=== text {#t}\n- [docs](https://d)\n  - [a.md](https://d/a)\n===\n';
  const sheet = (extra) => '=== meta\nprofile = "geml-style/v1"\n===\n'
    + '=== style-screen {#p slots="text#t"}\n===\n'
    + `=== style-rule {#r match="text#t" component=tree${extra}}\n===\n`;
  const indentOf = (extra) => {
    const { vm, model } = vmOf(sheet(extra), doc);
    const { document } = dom();
    const out = renderPage(vm, model, document, { renderBlock, labels: [], components: COMPONENTS, state: null });
    return out.root.querySelector('[data-block="#t"] details > ul').style.paddingLeft;
  };
  assert.equal(indentOf(" indent=24px"), "24px");
  assert.equal(indentOf(""), "1.2em", "不给就用默认 —— 一棵不缩进的树不是树");
  assert.equal(indentOf(' indent="0} body{display:none"'), "1.2em", "样式表是不可信输入，过不了闸就退回默认");
});

console.log(`\n${passed} layout tests passed.`);
