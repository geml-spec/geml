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
//
// The pieces are exported (and the auto-run at the bottom is main-module
// guarded) so the test suite can drive them in-process; the CLI dispatcher
// always runs this file as a child's MAIN module, where nothing changes.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, openSync, unlinkSync, readdirSync, watch, realpathSync } from "node:fs";
import { join, resolve, sep, basename, dirname, relative } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, renderHtml } from "../dist/geml.js";
import { buildCodeGraph } from "../dist/render.js";
import { isSourcePath, SKIP_DIRS } from "./detect.mjs";

// Where this package's compiled ESM lives — served under /_dist/ so pages can
// import the parser in the browser (live in-place navigation).
const DIST_DIR = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "dist"));

const USAGE = "usage: geml codemap serve [codemap-dir] [--port 8140] [--cache-mb 256] [--no-warm] [--no-open] [--watch] [--background|--stop]   (dir defaults to ./.geml-code-graph)";

// argv -> options, or null on a usage error (--help included: the caller
// prints the usage line and exits 2 either way).
export function parseServeArgs(args) {
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8140;
  const background = args.includes("--background");
  const stop = args.includes("--stop");
  const noWarm = args.includes("--no-warm");
  const noOpen = args.includes("--no-open");
  const watchMode = args.includes("--watch");
  const cacheIdx = args.indexOf("--cache-mb");
  const cacheMb = cacheIdx >= 0 ? Number(args[cacheIdx + 1]) : 256;
  if (args.includes("--help") || args.includes("-h") || !Number.isInteger(port) || port <= 0 || !(cacheMb > 0)) return null;
  const dir = args.find((a, i) => !a.startsWith("--") && (portIdx < 0 || i !== portIdx + 1) && (cacheIdx < 0 || i !== cacheIdx + 1)) || ".geml-code-graph";
  return { dir, port, background, stop, noWarm, noOpen, watchMode, cacheMb };
}

// Project root for the source route: a method node's src path is
// project-root-relative, so it always misses inside the codemap dir. The
// recorded build recipe knows the root (_index/refresh.json "root", relative
// to the codemap dir); without one, assume the codemap sits at <root>/<dir>.
export function resolveSrcRoot(root) {
  let srcRoot = resolve(root, "..");
  try { srcRoot = resolve(root, JSON.parse(readFileSync(join(root, "_index", "refresh.json"), "utf8")).root ?? ".."); } catch { /* no recipe: parent */ }
  return srcRoot;
}

// --stop: end a background server via its recorded pid. Returns the exit code.
export function stopServer({ pidPath }) {
  if (!existsSync(pidPath)) { console.error("codemap serve: no pid file — nothing to stop"); return 0; }
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  let running = true;
  try { process.kill(pid); } catch { running = false; }
  // Remove the pid file BEFORE reporting — the old order announced "stale pid
  // file removed" and only then attempted the unlink, so the message could
  // outrun (or misstate) the actual removal.
  try { unlinkSync(pidPath); } catch { /* already gone */ }
  console.error(running
    ? `codemap serve: stopped (pid ${pid})`
    : `codemap serve: pid ${pid} not running (stale pid file removed)`);
  return 0;
}

// --background: start a detached copy of this script and report once the port
// answers. Returns the exit code. `selfPath` defaults to this script
// (argv[1]); it is a parameter so tests can substitute a stand-in child.
export async function launchBackground({ dir, root, port, cacheMb, noWarm, watchMode, runDir, logPath }, selfPath = process.argv[1]) {
  // Already serving? Don't stack a second server on the port.
  try {
    const pre = await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" });
    if (pre.status > 0) {
      console.error(`codemap serve: port ${port} already answers — assuming it is up`);
      console.error(`  -> http://localhost:${port}/   (stop: geml codemap serve ${dir} --stop)`);
      return 0;
    }
  } catch { /* nothing there: start one */ }
  // Detach fully: own process group, stdio to the log file — the child owes
  // the launching session nothing. Report only once the port answers.
  mkdirSync(runDir, { recursive: true });
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath,
    [selfPath, root, "--port", String(port), "--cache-mb", String(cacheMb), "--no-open", ...(noWarm ? ["--no-warm"] : []), ...(watchMode ? ["--watch"] : [])],
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
    return 1;
  }
  console.error(`codemap serve: running in background (pid ${child.pid}) — survives this session`);
  console.error(`  -> http://localhost:${port}/`);
  console.error(`  stop: geml codemap serve ${dir} --stop   (log: ${logPath})`);
  return 0;
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
export const extOf = (p) => { const m = /\.[A-Za-z0-9]+$/.exec(p); return m ? m[0].toLowerCase() : ""; };

// The parse cache, request handler, and http server for ONE codemap
// directory. `dir` is the raw argument spelling (for the --stop hint).
export function createApp({ dir, root, port, cacheMb, srcRoot }) {
  // Flattened [name, doc, id] rows for the /_search endpoint, loaded once from
  // name-lookup.json on first query (kept server-side so a huge index never
  // ships to the browser).
  let searchRows = null;

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

  // Symlink-safe confinement: a lexical resolve()+startsWith() guard is
  // defeated by a symlink inside the served dir that resolves lexically-inside
  // but points at an external target. realpathSync canonicalizes through
  // symlinks, so comparing the REAL path against the REAL base closes that
  // hole (and Windows path casing/8.3 shortnames normalize the same way, since
  // both sides come from realpathSync). A path that does not exist makes
  // realpathSync throw — that is a normal miss, answered as null (never a
  // crash), so callers fall through to their existing 404. Bases are resolved
  // once; if a base itself cannot be realpath'd we fall back to its lexical
  // form (nothing will resolve under it, so confine still refuses).
  const realBase = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const realRoot = realBase(root);
  const realSrcRoot = realBase(srcRoot);
  const confine = (abs, base = realRoot) => {
    let real;
    try { real = realpathSync(abs); } catch { return null; }
    return (real === base || real.startsWith(base + sep)) ? real : null;
  };

  const handler = (req, res) => {
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
      // confine() both requires existence (realpathSync throws otherwise) and
      // rejects a symlink that escapes root; target===root (a codemap dir
      // itself named *.geml, reached via ../<basename>) stays allowed and the
      // builder reports its own clean load failure.
      if (!rel.endsWith(".geml") || !confine(target)) {
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
    // Name -> node search for the viewer typeahead: substring-match the build's
    // name-lookup and return the top matches (small), so even a 45M index stays
    // server-side and never ships to the browser. Static file:// pages, which
    // can't hit this route, load _index/search-index.js via <script> instead.
    if (urlPath === "/_search") {
      let q = "";
      try { q = (new URL(req.url, `http://127.0.0.1:${port}`).searchParams.get("q") || "").trim().toLowerCase(); } catch { /* fall through */ }
      if (q.length < 2) { done(200); return send(200, JSON.stringify({ total: 0, hits: [] }), MIME[".json"]); }
      if (!searchRows) {
        searchRows = [];
        try {
          const lk = JSON.parse(readFileSync(join(root, "_index", "name-lookup.json"), "utf8"));
          for (const name of Object.keys(lk)) for (const c of lk[name]) searchRows.push([name, c.doc, c.id]);
        } catch { /* no lookup — leave empty */ }
      }
      // Rank so the cap keeps the BEST hits, not the alphabetically first:
      // exact name, then prefix, then qualified-tail prefix (Cls::q / Cls.q),
      // then substring. The lookup also aliases bare member names to the same
      // node — dedupe on doc#id keeping the best-ranked row, and report the
      // HONEST total so the UI can say "showing K of N". (The static viewer
      // ranks with the same rules client-side over search-index.js.)
      const score = (n) => {
        if (n === q) return 0;
        if (n.startsWith(q)) return 1;
        const c2 = n.lastIndexOf("::"), d = n.lastIndexOf(".");
        const cut = Math.max(c2 >= 0 ? c2 + 2 : 0, d >= 0 ? d + 1 : 0);
        if (cut > 0 && n.slice(cut).startsWith(q)) return 2;
        return n.includes(q) ? 3 : -1;
      };
      const ranked = [];
      for (const [name, doc, id] of searchRows) {
        const s = score(name.toLowerCase());
        if (s >= 0) ranked.push({ s, name, doc, id });
      }
      ranked.sort((a, b) => a.s - b.s || a.name.localeCompare(b.name));
      const seen = new Set(), hits = [];
      for (const h of ranked) {
        const k = h.doc + "#" + h.id;
        if (seen.has(k)) continue;
        seen.add(k);
        hits.push(h);
      }
      done(200);
      return send(200, JSON.stringify({ total: hits.length, hits: hits.slice(0, 100).map(({ name, doc, id }) => ({ name, doc, id })) }), MIME[".json"]);
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
    // *.html: render the .geml source live when it exists. confine() gates on
    // the REAL path so a symlinked .geml that points outside root is refused
    // (a directory named *.geml still resolves in-root and the render
    // try/catch answers its clean 500, as before).
    if (urlPath.endsWith(".html")) {
      const geml = file.replace(/\.html$/, ".geml");
      if (confine(geml)) {
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
    const realFile = confine(file);
    if (realFile && statSync(realFile).isFile()) {
      done(200);
      return send(200, readFileSync(realFile), MIME[extOf(file)] || "application/octet-stream");
    }
    // Source files as a route: the graph's click-to-source fetches a method's
    // src path (project-root-relative), which misses inside the codemap dir.
    // Resolve the miss against the project root — read-only, indexed source
    // extensions only, traversal-guarded. Still a viewer, not a file server.
    if (isSourcePath(urlPath)) {
      const srcFile = resolve(join(srcRoot, "." + urlPath.replace(/\//g, sep)));
      // Same symlink-safe confinement against the (realpath'd) source root: a
      // symlinked source file pointing outside the project tree is refused.
      const realSrcFile = confine(srcFile, realSrcRoot);
      if (realSrcFile && statSync(realSrcFile).isFile()) {
        done(200);
        return send(200, readFileSync(realSrcFile), "text/plain; charset=utf-8");
      }
    }
    done(404);
    return send(404, `not found: ${urlPath}`);
  };

  const server = createServer(handler);

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

  return { server, handler, loadCached, loadDoc, parseDoc, warmCache, docCache, cacheBytes: () => docCacheBytes };
}

// Open the graph in the default browser — ONLY when serving interactively in a
// real terminal (isTTY). A --background child (stdio -> log file) and piped/CI
// runs are non-TTY and never open; `--no-open` opts out explicitly. A missing
// opener is not an error — the URL is already printed.
export const openBrowser = (url, spawnImpl = spawn) => {
  const argv = process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : process.platform === "darwin" ? ["open", url]
    : ["xdg-open", url];
  try {
    const child = spawnImpl(argv[0], argv.slice(1), { stdio: "ignore", detached: true });
    // spawn() reports a missing opener (e.g. no xdg-open on a headless Linux
    // box) ASYNCHRONOUSLY via an 'error' event on the ChildProcess — the
    // try/catch only catches a SYNCHRONOUS throw, so without this listener the
    // unhandled 'error' would crash the whole serve process. Swallow it: the
    // URL is already printed, so a failed auto-open is never fatal.
    child?.on?.("error", () => { /* no opener available: the printed URL is enough */ });
    child?.unref?.();
  } catch { /* synchronous spawn failure: the printed URL is enough */ }
};

// --watch: editing-time sync. Watch the project's indexed source files and,
// after a quiet window, re-run the recorded recipe so the codemap follows the
// EDIT, not just the commit (the hook covers commits). --force is required:
// refresh's up-to-date check pins to git HEAD, which editing doesn't move.
// Single-flight — a change arriving mid-refresh queues exactly one more run.
// Pages render live from .geml, so when a run lands an F5 shows it.
const WATCH_QUIET = Number(process.env.GEML_WATCH_QUIET_MS) || 30_000;
export function startWatch({ root, runDir, srcRoot, logPath }) {
  if (!existsSync(join(runDir, "refresh.json"))) {
    console.error("watch: no _index/refresh.json recipe recorded — --watch disabled (build once first)");
    return;
  }
  // A missing source root must disable watch on EVERY platform. Windows' native
  // fs.watch throws on a nonexistent path (caught below), but Linux's manual
  // watchTree silently tolerates it and would "watch" nothing — so guard here.
  if (!existsSync(srcRoot)) {
    console.error(`watch: recursive fs.watch unavailable here (source root ${srcRoot} does not exist) — --watch disabled`);
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
  // Shared filter: `rel` is the changed path relative to srcRoot, or null when
  // the platform could not attribute the event. An event we cannot filter
  // still schedules — the quiet window and the single-flight runner absorb an
  // occasional false refresh, whereas dropping it deafens --watch.
  const onFsEvent = (rel) => {
    if (rel) {
      const parts = String(rel).split(/[\\/]/);
      if (parts.some((p) => SKIP_DIRS.has(p) || p.startsWith("."))) return;
      if (!isSourcePath(String(rel))) return;
    }
    schedule();
  };
  try {
    // Linux's native recursive fs.watch silently misses events inside
    // pre-existing subdirectories (CI proved it: zero events for 15s of edits
    // under src/), so there the tree is watched by hand — one plain inotify
    // watcher per directory, SKIP_DIRS pruned. macOS/Windows keep the native
    // recursive watcher. GEML_WATCH_TREE=1 forces the manual walker so tests
    // exercise it on every platform.
    if (process.platform === "linux" || process.env.GEML_WATCH_TREE === "1") {
      watchTree(srcRoot, onFsEvent);
    } else {
      watch(srcRoot, { recursive: true }, (_ev, rel) => onFsEvent(rel));
    }
    console.error(`watch: watching ${srcRoot} — a source change re-runs the recipe after ${WATCH_QUIET / 1000}s of quiet`);
  } catch (e) {
    console.error(`watch: recursive fs.watch unavailable here (${e.message}) — --watch disabled`);
    return;
  }
  return { run, schedule, onFsEvent };
}

// Manual recursive watcher: one non-recursive fs.watch per directory, new
// directories picked up as they appear. Dead watchers on deleted directories
// just fall silent — nothing to clean up for our purpose.
export function watchTree(rootDir, onEvent) {
  const watched = new Set();
  const add = (dir) => {
    if (watched.has(dir)) return;
    let w;
    try { w = watch(dir, (_ev, name) => hit(dir, name ? String(name) : null)); } catch { return; } // vanished mid-walk
    watched.add(dir);
    w.on("error", () => watched.delete(dir));
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) add(join(dir, e.name));
    }
  };
  const hit = (dir, name) => {
    if (!name) { onEvent(null); return; } // unattributed: let the caller decide
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.startsWith(".")) add(full); // new subtree
        return; // directory churn itself is not a source edit
      }
    } catch { /* deleted — an unlinked source file is still a change */ }
    onEvent(relative(rootDir, full));
  };
  add(rootDir);
  return { add, hit, watched };
}

// Foreground serving: create the app and listen. Returns the app so an
// in-process caller can close the server; the CLI just leaves it running.
export function startServing(cfg) {
  const { root, port } = cfg;
  const app = createApp(cfg);
  app.server.listen(port, "127.0.0.1", () => {
    // Record the pid so `--stop` can find us (best effort — a read-only
    // codemap dir just means no pid file).
    try { mkdirSync(cfg.runDir, { recursive: true }); writeFileSync(cfg.pidPath, String(process.pid)); } catch { /* read-only */ }
    console.error(`geml codemap serve: ${root}`);
    console.error(`  -> http://localhost:${port}/  (pages render live from .geml — rebuilds show on refresh)`);
    if (process.stdout.isTTY && !cfg.noOpen) openBrowser(`http://localhost:${port}/`);
    if (!cfg.noWarm) app.warmCache();
    if (cfg.watchMode) startWatch(cfg);
  });
  return app;
}

export async function main(argv = process.argv.slice(2)) {
  const cfg = parseServeArgs(argv);
  if (!cfg) {
    console.error(USAGE);
    process.exit(2);
  }
  const root = resolve(cfg.dir);
  const runDir = join(root, "_index");
  const ctx = {
    ...cfg, root, runDir,
    pidPath: join(runDir, "serve.pid"),
    logPath: join(runDir, "serve.log"),
    srcRoot: resolveSrcRoot(root),
  };

  if (ctx.stop) process.exit(stopServer(ctx));

  if (!existsSync(join(root, "index.geml")) && !existsSync(join(root, "index.html"))) {
    console.error(`error: ${root} has no index.geml — not a codemap directory? (build one: geml codemap build)`);
    process.exit(1);
  }

  if (ctx.background) process.exit(await launchBackground(ctx));

  return startServing(ctx);
}

// Auto-run only as a MAIN module: the CLI dispatcher spawns this file as a
// child's entry script (src/geml.ts runCodemap), and `node codemap/serve.mjs`
// hits it directly — an in-process `import` (the tests) stays inert.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
