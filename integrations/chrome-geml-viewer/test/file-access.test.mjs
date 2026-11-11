// "Allow access to file URLs" — the switch no extension can turn on for itself.
// The background worker opens src/file-access.html when the extension is
// installed with the switch off; the page says why, leads to the
// switch, and shows whether it is on now. Both run here against stubs of the
// chrome.* calls they make, nothing more.
import { parseHTML } from "linkedom";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
// Run under the file's own path, so coverage counts these lines against it.
const run = (p, ctx) => vm.runInNewContext(read(p), ctx, { filename: fileURLToPath(new URL(p, import.meta.url)) });
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const settle = () => new Promise((r) => setTimeout(r, 0));

// --- the background worker -------------------------------------------------

function worker(allowed) {
  const opened = [];
  let onInstalled;
  const chrome = {
    runtime: {
      onInstalled: { addListener: (f) => { onInstalled = f; } },
      onMessage: { addListener: () => {} },
      getURL: (p) => `chrome-extension://abc/${p}`,
    },
    extension: { isAllowedFileSchemeAccess: async () => allowed },
    tabs: { create: (o) => opened.push(o.url) },
  };
  run("../src/bg.js", { chrome, URL, Map, Promise, fetch: () => Promise.reject(new Error("no fetch")) });
  return { opened, fire: async (reason) => { onInstalled({ reason }); await settle(); } };
}

test("bg: an install with file access off opens the file-access page", async () => {
  const w = worker(false);
  await w.fire("install");
  assert.deepEqual(w.opened, ["chrome-extension://abc/src/file-access.html"]);
});

test("bg: with file access on, or on any update, nothing opens", async () => {
  // An update with the switch off opens nothing: whoever keeps it off on purpose
  // would otherwise see the page after every update.
  for (const [allowed, reason] of [[true, "install"], [true, "update"], [false, "update"], [false, "chrome_update"], [false, "shared_module_update"]]) {
    const w = worker(allowed);
    await w.fire(reason);
    assert.deepEqual(w.opened, [], `${reason}, allowed=${allowed}`);
  }
});

// --- the page --------------------------------------------------------------

async function page({ language = "en-US", ua = "Mozilla/5.0 Chrome/130.0", search = "", allowed = false } = {}) {
  const { document, window } = parseHTML(read("../src/file-access.html"));
  const opened = [];
  const timers = [];
  const chrome = {
    runtime: { id: "abc" },
    extension: { isAllowedFileSchemeAccess: async () => allowed },
    tabs: { create: (o) => opened.push(o.url) },
  };
  const ctx = {
    document, chrome, URLSearchParams, Promise,
    location: { search },
    navigator: { language, userAgent: ua },
    setInterval: (f, ms) => timers.push(ms),
  };
  run("../src/file-access.js", ctx);
  await settle();
  const $ = (id) => document.getElementById(id);
  return { $, document, window, opened, timers };
}

test("page: in English it names the switch, and says it is off until the browser says otherwise", async () => {
  const p = await page();
  assert.equal(p.$("title").textContent, "Let GEML Viewer open .geml files on this computer");
  assert.equal(p.document.documentElement.getAttribute("lang"), "en");
  assert.equal(p.$("why").querySelector("b").textContent, "Allow access to file URLs");
  assert.match(p.$("why").textContent, /file:\/\/\/…/);
  assert.equal(p.$("open").textContent, "Open the details page");
  assert.equal(p.$("state").dataset.on, "false");
  assert.equal(p.$("said").textContent, "Now: off");
  assert.deepEqual(p.timers, [1500], "it looks again while the tab is open");
});

test("page: a Chinese browser reads it in Chinese, with the switch named as Chrome or Edge names it", async () => {
  const chrome = await page({ language: "zh-CN" });
  assert.equal(chrome.$("title").textContent, "让 GEML Viewer 打开本机的 .geml 文件");
  assert.equal(chrome.$("why").querySelector("b").textContent, "「允许访问文件网址」");
  assert.equal(chrome.$("open").textContent, "打开详细信息页");
  assert.equal(chrome.$("said").textContent, "现在：未开启");
  assert.match(chrome.$("web").textContent, /网上的 \.geml（https:\/\/）不需要这个权限。/);
  const edge = await page({ language: "zh-CN", ua: "Mozilla/5.0 Chrome/130.0 Edg/130.0" });
  assert.equal(edge.$("why").querySelector("b").textContent, "「允许访问文件 URL」");
});

test("page: once the switch is on, it says so; the button opens this extension's details page", async () => {
  const p = await page({ language: "zh-TW", allowed: true });
  assert.equal(p.$("state").dataset.on, "true");
  assert.equal(p.$("said").textContent, "现在：已开启。本机的 .geml 会直接渲染，可以关掉这页了。");
  p.$("open").dispatchEvent(new p.window.Event("click"));
  assert.deepEqual(p.opened, ["chrome://extensions/?id=abc"]);
});

test("page: nothing in it is parsed as HTML, so no element comes from its strings", async () => {
  const js = read("../src/file-access.js");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

let passed = 0;
for (const [name, fn] of tests) {
  await fn();
  console.log(`ok ${name}`);
  passed++;
}
console.log(`\n${passed} file-access tests passed.`);
