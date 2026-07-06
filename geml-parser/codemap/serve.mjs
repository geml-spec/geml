#!/usr/bin/env node
// geml codemap serve — live viewer for a codemap directory.
//
//   geml codemap serve <codemap-dir> [--port 8140]
//
// Every *.html request is rendered FROM ITS *.geml AT REQUEST TIME, so the
// pages are never stale: rebuild the codemap (or upgrade the renderer) and a
// browser refresh shows the new state — no pre-render step. Pre-rendered
// static .html files (from `geml codemap render`) are served only when no
// .geml source exists for the path.
//
// Local viewer by design: binds 127.0.0.1. HEAD is answered without a body —
// the in-page navigation probes targets before embedding them.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, sep, basename } from "node:path";
import { parse, renderHtml } from "../dist/geml.js";

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8140;
const dir = args.find((a, i) => a !== "--port" && i !== portIdx + 1);
if (!dir || dir === "--help" || !Number.isInteger(port) || port <= 0) {
  console.error("usage: geml codemap serve <codemap-dir> [--port 8140]");
  process.exit(2);
}
const root = resolve(dir);
if (!existsSync(join(root, "index.geml")) && !existsSync(join(root, "index.html"))) {
  console.error(`error: ${root} has no index.geml — not a codemap directory? (build one: geml codemap build)`);
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".geml": "text/plain; charset=utf-8",
  ".gemlhistory": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};
const extOf = (p) => { const m = /\.[A-Za-z0-9]+$/.exec(p); return m ? m[0].toLowerCase() : ""; };
const loadDoc = (rel) => {
  try { return readFileSync(join(root, rel), "utf8"); } catch { return null; }
};

const server = createServer((req, res) => {
  const send = (status, body, type) => {
    res.writeHead(status, { "content-type": type || "text/plain; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : body);
  };
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
  } catch {
    return send(400, "bad request");
  }
  if (urlPath.endsWith("/")) urlPath += "index.html";
  // Stay inside the codemap directory — a viewer, not a file server.
  const file = resolve(join(root, "." + urlPath.replace(/\//g, sep)));
  if (file !== root && !file.startsWith(root + sep)) return send(403, "forbidden");

  const done = (status) => console.error(`${req.method} ${urlPath} ${status}`);
  // *.html: render the .geml source live when it exists.
  if (urlPath.endsWith(".html")) {
    const geml = file.replace(/\.html$/, ".geml");
    if (existsSync(geml)) {
      try {
        const doc = parse(readFileSync(geml, "utf8"));
        const html = renderHtml(doc, { source: basename(geml), loadDoc, parseDoc: (s) => parse(s) });
        done(200);
        return send(200, html, MIME[".html"]);
      } catch (e) {
        done(500);
        return send(500, `render error in ${basename(geml)}: ${e.message}`);
      }
    }
  }
  if (existsSync(file) && statSync(file).isFile()) {
    done(200);
    return send(200, readFileSync(file), MIME[extOf(file)] || "application/octet-stream");
  }
  done(404);
  return send(404, `not found: ${urlPath}`);
});

server.listen(port, "127.0.0.1", () => {
  console.error(`geml codemap serve: ${root}`);
  console.error(`  -> http://localhost:${port}/  (pages render live from .geml — rebuilds show on refresh)`);
});
