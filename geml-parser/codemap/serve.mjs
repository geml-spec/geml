#!/usr/bin/env node
// geml codemap serve — live viewer for a codemap directory.
//
//   geml codemap serve <codemap-dir> [--port 8140]              foreground
//   geml codemap serve <codemap-dir> [--port 8140] --background survives the session
//   geml codemap serve <codemap-dir> --stop                     stop a background server
//
// Every *.html request is rendered FROM ITS *.geml AT REQUEST TIME, so the
// pages are never stale: rebuild the codemap (or upgrade the renderer) and a
// browser refresh shows the new state — no pre-render step. Pre-rendered
// static .html files (from `geml codemap render`) are served only when no
// .geml source exists for the path.
//
// --background detaches the server from the launching process (an agent
// session ending must not take the viewer down): stdio goes to
// _index/serve.log, the pid lands in _index/serve.pid, and the parent waits
// until the port actually answers before reporting the URL.
//
// Local viewer by design: binds 127.0.0.1. HEAD is answered without a body —
// the in-page navigation probes targets before embedding them.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join, resolve, sep, basename } from "node:path";
import { spawn } from "node:child_process";
import { parse, renderHtml } from "../dist/geml.js";

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8140;
const background = args.includes("--background");
const stop = args.includes("--stop");
const dir = args.find((a, i) => !a.startsWith("--") && (portIdx < 0 || i !== portIdx + 1));
if (!dir || dir === "--help" || !Number.isInteger(port) || port <= 0) {
  console.error("usage: geml codemap serve <codemap-dir> [--port 8140] [--background|--stop]");
  process.exit(2);
}
const root = resolve(dir);
const runDir = join(root, "_index");
const pidPath = join(runDir, "serve.pid");
const logPath = join(runDir, "serve.log");

if (stop) {
  if (!existsSync(pidPath)) { console.error("codemap serve: no pid file — nothing to stop"); process.exit(0); }
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  try {
    process.kill(pid);
    console.error(`codemap serve: stopped (pid ${pid})`);
  } catch {
    console.error(`codemap serve: pid ${pid} not running (stale pid file removed)`);
  }
  try { unlinkSync(pidPath); } catch { /* already gone */ }
  process.exit(0);
}

if (!existsSync(join(root, "index.geml")) && !existsSync(join(root, "index.html"))) {
  console.error(`error: ${root} has no index.geml — not a codemap directory? (build one: geml codemap build)`);
  process.exit(1);
}

if (background) {
  // Already serving? Don't stack a second server on the port.
  try {
    const pre = await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" });
    if (pre.status > 0) {
      console.error(`codemap serve: port ${port} already answers — assuming it is up`);
      console.error(`  -> http://localhost:${port}/   (stop: geml codemap serve ${dir} --stop)`);
      process.exit(0);
    }
  } catch { /* nothing there: start one */ }
  // Detach fully: own process group, stdio to the log file — the child owes
  // the launching session nothing. Report only once the port answers.
  mkdirSync(runDir, { recursive: true });
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [process.argv[1], root, "--port", String(port)], {
    detached: true, stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  const deadline = Date.now() + 8000;
  let up = false, exited = false;
  child.once("exit", () => { exited = true; });
  while (Date.now() < deadline && !up && !exited) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" });
      up = r.status > 0;
    } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!up) {
    let tail = "";
    try { tail = readFileSync(logPath, "utf8").split("\n").slice(-4).join("\n  "); } catch { /* no log */ }
    console.error(`codemap serve: failed to start on port ${port}\n  ${tail}`);
    process.exit(1);
  }
  console.error(`codemap serve: running in background (pid ${child.pid}) — survives this session`);
  console.error(`  -> http://localhost:${port}/`);
  console.error(`  stop: geml codemap serve ${dir} --stop   (log: ${logPath})`);
  process.exit(0);
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

server.on("error", (e) => {
  console.error(e && e.code === "EADDRINUSE"
    ? `error: port ${port} is in use — pick another with --port, or stop the old server (geml codemap serve ${dir} --stop)`
    : `error: ${e.message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  // Record the pid so `--stop` can find us (best effort — a read-only
  // codemap dir just means no pid file).
  try { mkdirSync(runDir, { recursive: true }); writeFileSync(pidPath, String(process.pid)); } catch { /* read-only */ }
  console.error(`geml codemap serve: ${root}`);
  console.error(`  -> http://localhost:${port}/  (pages render live from .geml — rebuilds show on refresh)`);
});
