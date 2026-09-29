// stage.test.mjs —— 服务、浏览器、舞台页。本机没有 Chromium 时浏览器部分跳过。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ROOT, blockAttrs } from "../lib/geml.mjs";
import { startServer } from "../lib/server.mjs";
import { findChrome, openBrowser } from "../lib/chrome.mjs";

const skip = findChrome() === null ? "本机没有 Chromium" : false;
let server, page;
before(async () => { server = await startServer(ROOT); if (!skip) page = await openBrowser(); });
after(async () => { await page?.close(); await server.close(); });

test("服务：正确的 MIME，目录外 403，不存在 404", async () => {
  const ok = await fetch(`${server.url}/scenes/lib.js`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /javascript/);
  assert.equal((await fetch(`${server.url}/..%2F..%2Fpackage.json`)).status, 403);
  assert.equal((await fetch(`${server.url}/nope.js`)).status, 404);
});

test("舞台：同一 t 两次截图逐字节相同，不同 t 不同", { skip }, async () => {
  await page.goto(`${server.url}/scenes/stage.html?scene=_probe`);
  await page.evaluate("window.__seek(0.5)");
  const a = await page.screenshot();
  await page.evaluate("window.__seek(0.9)");
  await page.evaluate("window.__seek(0.5)");
  const b = await page.screenshot();
  await page.evaluate("window.__seek(0.9)");
  const c = await page.screenshot();
  assert.ok(a.equals(b), "同一 t 的两帧不同：场景不是 t 的纯函数");
  assert.ok(!a.equals(c));
  assert.deepEqual(page.errors, []);
});

test("舞台：场景载入失败时 goto 立刻报出原因，不假装成功，也不干等到超时", { skip }, async () => {
  const t0 = Date.now();
  await assert.rejects(page.goto(`${server.url}/scenes/stage.html?scene=__missing`), /载入时出错/);
  assert.ok(Date.now() - t0 < 3000, "应当在超时之前就报出来");
});

test("舞台：lang 传进场景，zh 与 en 同一 t 画得不同", { skip }, async () => {
  const shot = async (lang) => {
    await page.goto(`${server.url}/scenes/stage.html?scene=_probe&lang=${lang}`);
    await page.evaluate("window.__seek(0.5)");
    return page.screenshot();
  };
  assert.ok(!(await shot("zh")).equals(await shot("en")));
});

test("服务：/_art.json 从素材库现读，图片带正确的 MIME", async () => {
  // 不写死 id：取清单里任意一张图，看路径与素材库头行一致、MIME 与扩展名对得上。
  const m = await (await fetch(`${server.url}/_art.json`)).json();
  const id = Object.keys(m).find((k) => /\.(png|svg|jpg|webp)$/.test(m[k]));
  if (id === undefined) return;   // 素材库里还没有图（这一集还没接进来）
  const src = blockAttrs("library.geml", id, ROOT).src;
  assert.equal(m[id], src);
  const r = await fetch(`${server.url}/${src}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" }[src.slice(src.lastIndexOf("."))]);
});

test("浏览器：场景卡死时 evaluate 在期限内报错，而不是永远等下去", { skip }, async () => {
  const p = await openBrowser({ timeoutMs: 2000 });
  try {
    await p.goto(`${server.url}/scenes/stage.html?scene=_probe`);
    const t0 = Date.now();
    // 真正的死循环（一个永不 resolve 的 Promise 会被回收，不算卡死）。
    await assert.rejects(p.evaluate("for (;;) {}"), /没有返回/);
    assert.ok(Date.now() - t0 < 5000);
  } finally { await p.close(); }
});

