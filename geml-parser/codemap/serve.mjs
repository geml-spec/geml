#!/usr/bin/env node
// geml codemap serve — live viewer for a codemap directory.
//
//   geml codemap serve [codemap-dir] [--port 8140]              foreground
//   geml codemap serve [codemap-dir] [--port 8140] --background survives the session
//   geml codemap serve [codemap-dir] --stop                     stop a background server
//   geml codemap serve [codemap-dir] --watch                    editing-time sync: re-run the
//                                    recorded recipe when indexed sources change (30s quiet)
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
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, openSync, unlinkSync, readdirSync, watch } from "node:fs";
import { join, resolve, sep, basename, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse, renderHtml } from "../dist/geml.js";
import { buildCodeGraph } from "../dist/render.js";
import { isSourcePath, SKIP_DIRS } from "./detect.mjs";

// Where this package's compiled ESM lives — served under /_dist/ so pages can
// import the parser in the browser (live in-place navigation).
const DIST_DIR = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "dist"));

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8140;
const background = args.includes("--background");
const stop = args.includes("--stop");
const noWarm = args.includes("--no-warm");
const noOpen = args.includes("--no-open");
const watchMode = args.includes("--watch");
const cacheIdx = args.indexOf("--cache-mb");
const cacheMb = cacheIdx >= 0 ? Number(args[cacheIdx + 1]) : 256;
if (args.includes("--help") || args.includes("-h") || !Number.isInteger(port) || port <= 0 || !(cacheMb > 0)) {
  console.error("usage: geml codemap serve [codemap-dir] [--port 8140] [--cache-mb 256] [--no-warm] [--no-open] [--watch] [--background|--stop]   (dir defaults to ./.geml-code-graph)");
  process.exit(2);
}
const dir = args.find((a, i) => !a.startsWith("--") && (portIdx < 0 || i !== portIdx + 1) && (cacheIdx < 0 || i !== cacheIdx + 1)) || ".geml-code-graph";
const root = resolve(dir);
const runDir = join(root, "_index");
const pidPath = join(runDir, "serve.pid");
const logPath = join(runDir, "serve.log");

// Project root for the source route: a method node's src path is
// project-root-relative, so it always misses inside the codemap dir. The
// recorded build recipe knows the root (_index/refresh.json "root", relative
// to the codemap dir); without one, assume the codemap sits at <root>/<dir>.
let srcRoot = resolve(root, "..");
try { srcRoot = resolve(root, JSON.parse(readFileSync(join(root, "_index", "refresh.json"), "utf8")).root ?? ".."); } catch { /* no recipe: parent */ }

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
  const child = spawn(process.execPath,
    [process.argv[1], root, "--port", String(port), "--cache-mb", String(cacheMb), "--no-open", ...(noWarm ? ["--no-warm"] : []), ...(watchMode ? ["--watch"] : [])],
    { detached: true, stdio: ["ignore", logFd, logFd] });
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

// Parsed-document cache. Pages still render on every request (never stale:
// entries are validated against mtime+size, so a rebuild is picked up on the
// next hit), but a click-walk revisits the same multi-MB documents constantly
// and re-parsing 7 MB of geml per request is pure waste. The LRU bound is a
// TEXT-BYTE budget, not a document count: one page's graph slice can cross
// hundreds of small documents (a count bound would thrash — evict and
// re-parse the whole working set on every request), while a handful of
// 7 MB documents is what actually threatens memory.
const DOC_CACHE_BUDGET = cacheMb * 1024 * 1024; // --cache-mb, default 256
const docCache = new Map(); // abs path -> { mtime, size, text, doc }
const parsedByText = new Map(); // text (same instance as in docCache) -> doc
let docCacheBytes = 0;
const evict = (abs, entry) => {
  parsedByText.delete(entry.text);
  docCache.delete(abs);
  docCacheBytes -= entry.size;
};
const loadCached = (abs) => {
  let st;
  try { st = statSync(abs); } catch { return null; }
  const hit = docCache.get(abs);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) {
    docCache.delete(abs); docCache.set(abs, hit); // LRU touch
    return hit;
  }
  if (hit) evict(abs, hit);
  let text;
  try { text = readFileSync(abs, "utf8"); } catch { return null; }
  const entry = { mtime: st.mtimeMs, size: st.size, text, doc: parse(text) };
  docCache.set(abs, entry);
  parsedByText.set(text, entry.doc);
  docCacheBytes += entry.size;
  while (docCacheBytes > DOC_CACHE_BUDGET && docCache.size > 1) {
    const oldest = docCache.keys().next().value;
    evict(oldest, docCache.get(oldest));
  }
  return entry;
};
const loadDoc = (rel) => {
  const e = loadCached(join(root, rel));
  return e ? e.text : null;
};
// loadDoc hands out the cached string instance, so the by-text lookup hits
// without re-hashing anything the render loop already loaded.
const parseDoc = (s) => parsedByText.get(s) ?? parse(s);

const server = createServer((req, res) => {
  const send = (status, body, type) => {
    // never-stale extends to the BROWSER: without this, heuristic caching
    // keeps serving yesterday's pages and /_dist modules across restarts.
    res.writeHead(status, { "content-type": type || "text/plain; charset=utf-8", "cache-control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : body);
  };
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
  } catch {
    return send(400, "bad request");
  }
  if (urlPath.endsWith("/")) urlPath += "index.html";

  const done = (status) => console.error(`${req.method} ${urlPath} ${status}`);
  // Graph payloads as a sidecar: pages carry data-graph-src instead of a
  // multi-MB inline attribute; the runtime fetches this route after first
  // paint. Computed on demand from the SAME parse cache — never stale.
  if (urlPath === "/_graph") {
    let rel = "";
    try { rel = new URL(req.url, `http://127.0.0.1:${port}`).searchParams.get("doc") || ""; } catch { /* fall through */ }
    const target = resolve(join(root, "." + ("/" + rel).replace(/\//g, sep)));
    if (!rel.endsWith(".geml") || (target !== root && !target.startsWith(root + sep)) || !existsSync(target)) {
      done(404);
      return send(404, JSON.stringify({ error: `no such document: ${rel}` }), "application/json; charset=utf-8");
    }
    try {
      const r = buildCodeGraph(rel, { loadDoc, parseDoc });
      done(200);
      return send(200,
        JSON.stringify(r.error !== undefined ? { error: r.error } : { data: r.data, truncated: !!r.truncated }),
        "application/json; charset=utf-8");
    } catch (e) {
      done(500);
      return send(500, JSON.stringify({ error: e.message }), "application/json; charset=utf-8");
    }
  }
  // The parser's own ESM dist, for the live module script the pages load —
  // clicks then swap views in place instead of navigating between pages.
  if (urlPath.startsWith("/_dist/")) {
    const sub = urlPath.slice("/_dist/".length);
    // The import map in served pages sends every node:* builtin here, so the
    // parser dist loads in a browser exactly like the bundled viewer does.
    if (sub === "_node-stub.js") {
      done(200);
      return send(200, readFileSync(join(dirname(fileURLToPath(import.meta.url)), "browser-stub.mjs")), "text/javascript; charset=utf-8");
    }
    const distFile = resolve(join(DIST_DIR, "." + sep + sub.replace(/\//g, sep)));
    if (!distFile.startsWith(DIST_DIR + sep) || !distFile.endsWith(".js") || !existsSync(distFile)) {
      done(404);
      return send(404, `not found: ${urlPath}`);
    }
    done(200);
    return send(200, readFileSync(distFile), "text/javascript; charset=utf-8");
  }
  // Stay inside the codemap directory — a viewer, not a file server.
  const file = resolve(join(root, "." + urlPath.replace(/\//g, sep)));
  if (file !== root && !file.startsWith(root + sep)) return send(403, "forbidden");
  // *.html: render the .geml source live when it exists.
  if (urlPath.endsWith(".html")) {
    const geml = file.replace(/\.html$/, ".geml");
    if (existsSync(geml)) {
      try {
        const doc = loadCached(geml).doc;
        const html = renderHtml(doc, {
          source: basename(geml), loadDoc, parseDoc,
          liveGraph: "/_dist/", graphSidecar: "/_graph?doc=",
        });
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
  // Source files as a route: the graph's click-to-source fetches a method's
  // src path (project-root-relative), which misses inside the codemap dir.
  // Resolve the miss against the project root — read-only, indexed source
  // extensions only, traversal-guarded. Still a viewer, not a file server.
  if (isSourcePath(urlPath)) {
    const srcFile = resolve(join(srcRoot, "." + urlPath.replace(/\//g, sep)));
    if (srcFile.startsWith(srcRoot + sep) && existsSync(srcFile) && statSync(srcFile).isFile()) {
      done(200);
      return send(200, readFileSync(srcFile), "text/plain; charset=utf-8");
    }
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
// Background prewarm: the parse cache is lazy, so the FIRST click into a big
// container otherwise pays its whole cross-document working set (seconds at
// repo scale). Warm largest-first — the big documents are the long-tail
// first-clicks — ONE document per event-loop turn so requests arriving
// mid-warm are served normally (a tight synchronous loop would block them),
// and stop at 80% of the byte budget: warming past it only evicts what was
// just warmed. Requests still validate mtime+size, so a rebuild mid-warm is
// picked up as usual.
async function warmCache() {
  let files = [];
  try {
    files = readdirSync(root)
      .filter((f) => f.endsWith(".geml"))
      .map((f) => {
        const p = join(root, f);
        try { return { p, size: statSync(p).size }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.size - a.size);
  } catch { return; }
  const t0 = Date.now();
  let n = 0;
  // Brake on CUMULATIVE bytes pushed through the cache, not on current
  // occupancy — the LRU evicts as it goes, so occupancy self-limits and
  // would never stop the loop; past 80% of the budget every further load
  // only evicts something just warmed.
  let warmed = 0;
  for (const { p, size } of files) {
    if (warmed >= DOC_CACHE_BUDGET * 0.8) break;
    if (loadCached(p)) { n++; warmed += size; }
    await new Promise((r) => setImmediate(r));
  }
  console.error(`prewarm: ${n}/${files.length} document(s), ${(docCacheBytes / 1048576).toFixed(1)} MB cached, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// Open the graph in the default browser — ONLY when serving interactively in a
// real terminal (isTTY). A --background child (stdio -> log file) and piped/CI
// runs are non-TTY and never open; `--no-open` opts out explicitly. A missing
// opener is not an error — the URL is already printed.
const openBrowser = (url) => {
  const argv = process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : process.platform === "darwin" ? ["open", url]
    : ["xdg-open", url];
  try { spawn(argv[0], argv.slice(1), { stdio: "ignore", detached: true }).unref(); }
  catch { /* no opener available: the printed URL is enough */ }
};

// --watch: editing-time sync. Watch the project's indexed source files and,
// after a quiet window, re-run the recorded recipe so the codemap follows the
// EDIT, not just the commit (the hook covers commits). --force is required:
// refresh's up-to-date check pins to git HEAD, which editing doesn't move.
// Single-flight — a change arriving mid-refresh queues exactly one more run.
// Pages render live from .geml, so when a run lands an F5 shows it.
const WATCH_QUIET = Number(process.env.GEML_WATCH_QUIET_MS) || 30_000;
function startWatch() {
  if (!existsSync(join(runDir, "refresh.json"))) {
    console.error("watch: no _index/refresh.json recipe recorded — --watch disabled (build once first)");
    return;
  }
  let timer = null, running = false, again = false;
  const run = () => {
    if (running) { again = true; return; }
    running = true;
    console.error("watch: sources changed — refreshing the codemap…");
    const child = spawn(process.execPath,
      [join(dirname(fileURLToPath(import.meta.url)), "refresh.mjs"), root, "--force"],
      { stdio: ["ignore", 2, 2] });
    child.on("exit", (c) => {
      running = false;
      console.error(c === 0
        ? "watch: codemap refreshed — reload the browser to see it"
        : `watch: refresh failed (exit ${c}) — see ${logPath.replace(/serve\.log$/, "refresh.log")}`);
      if (again) { again = false; schedule(); }
    });
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, WATCH_QUIET); };
  try {
    watch(srcRoot, { recursive: true }, (_ev, rel) => {
      if (!rel) return;
      const parts = String(rel).split(/[\\/]/);
      if (parts.some((p) => SKIP_DIRS.has(p) || p.startsWith("."))) return;
      if (!isSourcePath(String(rel))) return;
      schedule();
    });
    console.error(`watch: watching ${srcRoot} — a source change re-runs the recipe after ${WATCH_QUIET / 1000}s of quiet`);
  } catch (e) {
    console.error(`watch: recursive fs.watch unavailable here (${e.message}) — --watch disabled`);
  }
}

server.listen(port, "127.0.0.1", () => {
  // Record the pid so `--stop` can find us (best effort — a read-only
  // codemap dir just means no pid file).
  try { mkdirSync(runDir, { recursive: true }); writeFileSync(pidPath, String(process.pid)); } catch { /* read-only */ }
  console.error(`geml codemap serve: ${root}`);
  console.error(`  -> http://localhost:${port}/  (pages render live from .geml — rebuilds show on refresh)`);
  if (process.stdout.isTTY && !noOpen) openBrowser(`http://localhost:${port}/`);
  if (!noWarm) warmCache();
  if (watchMode) startWatch();
});
