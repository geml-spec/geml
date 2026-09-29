// 场景页的静态服务。Chrome 不让 file:// 页面加载 ES module（CORS），所以渲染与预览都走 http。
//
// 另有一条派生路由 `/_art.json`：现读素材库，把 art-*、evidence-*、ep-* 素材的 id 映射到它的 src。
// 场景只认 id，换真图只改素材库——场景代码一行不动。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { listIds, blockAttrs } from "./geml.mjs";

export function artManifest(root) {
  const out = {};
  for (const id of listIds("library.geml", root).filter((x) => /^(art|evidence|ep)-/.test(x))) out[id] = blockAttrs("library.geml", id, root).src;
  return out;
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
};

export function startServer(root, port = 0) {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel === "/_art.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(artManifest(base)));
      return;
    }
    const file = resolve(join(base, rel));
    if (file !== base && !file.startsWith(base + sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  })));
}
