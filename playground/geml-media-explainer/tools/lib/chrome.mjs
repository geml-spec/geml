// 无依赖地驱动一个无头 Chromium：用 Node 自带的 WebSocket 直接讲 CDP。
// 查找顺序：CHROME 环境变量 → Playwright 缓存里的 chrome-headless-shell → 系统 Chrome。
import { spawn } from "node:child_process";
import { existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const cache of [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")]) {
    if (!existsSync(cache)) continue;
    const dirs = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const d of dirs) {
      for (const sub of ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64", "chrome-headless-shell-linux64"]) {
        const p = join(cache, d, sub, "chrome-headless-shell");
        if (existsSync(p)) return p;
      }
    }
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(mac) ? mac : null;
}

export async function openBrowser({ width = 1920, height = 1080, timeoutMs = 30_000, transparent = false } = {}) {
  const bin = findChrome();
  if (bin === null) throw new Error("找不到 Chromium：设 CHROME=<可执行文件>，或 npx playwright install chromium-headless-shell");
  const profile = mkdtempSync(join(tmpdir(), "explainer-chrome-"));
  const args = ["--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--force-device-scale-factor=1", "--mute-audio", `--user-data-dir=${profile}`];
  if (bin.includes("Google Chrome")) args.push("--headless=new");
  args.push("about:blank");
  const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });

  const wsUrl = await new Promise((ok, fail) => {
    let buf = "";
    const timer = setTimeout(() => fail(new Error("Chromium 10 秒内没有给出调试地址：\n" + buf)), 10_000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); ok(m[1]); }
    });
    proc.once("exit", (code) => { clearTimeout(timer); fail(new Error(`Chromium 退出了（${code}）：\n${buf}`)); });
  });
  const http = wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "");
  const target = (await (await fetch(`${http}/json/list`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.addEventListener("open", ok, { once: true }); ws.addEventListener("error", fail, { once: true }); });

  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== undefined && pending.has(m.id)) {
      const { ok, fail } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) fail(new Error(m.error.message)); else ok(m.result);
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      errors.push(d.exception?.description ?? d.text);
    }
  });
  // 每次调用都有期限：场景里一个死循环会让 Runtime.evaluate 永不返回，没有期限的话渲染工具
  // 就无声地挂在那里（S05 第一版就这样挂过）。
  const send = (method, params = {}, ms = timeoutMs) => new Promise((ok, fail) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP ${method} ${ms / 1000} 秒没有返回：场景卡住了？`)); }, ms);
    pending.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); fail(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Runtime.enable");
  await send("Page.enable");
  // 透明底：截图带 alpha，用来做叠在视频上的字幕层。
  if (transparent) await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });

  return {
    errors,
    evaluate,
    async goto(url) {
      errors.length = 0;
      await send("Page.navigate", { url });
      for (let i = 0; i < 100; i++) {
        if (await evaluate("window.__ready === true").catch(() => false)) return;
        const err = await evaluate("window.__error ?? null").catch(() => null);
        if (err) throw new Error(`页面载入时出错：${url}\n${err}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`页面 5 秒内没有就绪：${url}\n${errors.join("\n")}`);
    },
    async screenshot() {
      return Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64");
    },
    async close() {
      ws.close();
      const gone = new Promise((r) => proc.once("exit", r));
      proc.kill();
      await gone;
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
