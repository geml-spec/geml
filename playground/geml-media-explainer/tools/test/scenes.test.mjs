// scenes.test.mjs —— 分镜表里的每个场景：三个时刻渲染无异常、非空白、确定、会动。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ROOT, LANGS, shotTable } from "../lib/geml.mjs";
import { startServer } from "../lib/server.mjs";
import { findChrome, openBrowser } from "../lib/chrome.mjs";

const skip = findChrome() === null ? "本机没有 Chromium" : false;
let server, page, blank;
before(async () => {
  server = await startServer(ROOT);
  if (skip) return;
  page = await openBrowser();
  await page.goto(`${server.url}/scenes/stage.html?scene=_probe`);
  await page.evaluate("document.getElementById('root').replaceChildren()");
  blank = await page.screenshot();
});
after(async () => { await page?.close(); await server.close(); });

for (const shot of shotTable(ROOT)) for (const lang of LANGS) {
  test(`${shot.id}（${lang}）：三个时刻渲染无异常、非空白、同一 t 两次一致`, { skip }, async () => {
    await page.goto(`${server.url}/scenes/stage.html?scene=${shot.id}&lang=${lang}`);
    const frames = [];
    for (const t of [0.5, shot.duration / 2, shot.duration - 1 / 30]) {
      await page.evaluate(`window.__seek(${t})`);
      const a = await page.screenshot();
      await page.evaluate(`window.__seek(${t})`);
      assert.ok(a.equals(await page.screenshot()), `${shot.id} 在 t=${t} 不确定`);
      assert.ok(!a.equals(blank), `${shot.id} 在 t=${t} 是空白`);
      frames.push(a);
    }
    assert.ok(!frames[0].equals(frames[2]), `${shot.id} 从头到尾没动`);
    assert.deepEqual(page.errors, []);
  });
}
