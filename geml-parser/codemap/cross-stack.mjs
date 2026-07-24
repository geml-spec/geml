// geml-code-graph cross-stack API links — connect the two disjoint trees a
// full-stack repo produces (frontend call sites ⇄ backend route handlers).
//
// A frontend "call" to the backend is not a symbol reference — it is an HTTP
// string crossing a network boundary, so SCIP/Joern never link it. The join
// key is `METHOD + normalized path`. These links are inherently NOT
// compiler-verifiable, so they are emitted as their OWN edge kinds
// (`http-call` / `http-serve`) with a `confidence`, kept strictly separate
// from the verified `calls` graph — the codemap never launders a heuristic
// guess into a verified reference.
//
// Pluggable + framework-agnostic by design: framework knowledge lives ONLY in
// the per-language detectors below; the matcher/overlay speak a single
// normalized shape ({method, path}). Adding a framework = adding a detector.
//
// Pure: given the indexed `files` list + an injectable `readText`, and the
// already-merged graph (`symbols`/`edges`), it appends synthetic endpoint
// bridge nodes + link edges. No filesystem walking of its own.

// ───────────────────────── path normalization ──────────────────────────────
// {id} / :id / ${x} path params all collapse to a single wildcard token so a
// frontend `/users/${id}` matches a backend `/users/{id}` matches `/users/:id`.
function normPath(p) {
  let s = String(p).split("?")[0].split("#")[0];
  s = s.replace(/\$\{[^}]*\}/g, "{}").replace(/\{[^}]*\}/g, "{}").replace(/:[A-Za-z0-9_]+/g, "{}");
  s = s.replace(/\{\}(?:\{\})+/g, "{}");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s || "/";
}
const pathSegs = (p) => normPath(p).split("/");
function exactEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && a[i] !== "{}" && b[i] !== "{}") return false;
  return true;
}
function prefixCover(pre, fe) {
  if (fe.length < pre.length) return false;
  for (let i = 0; i < pre.length; i++) if (pre[i] !== "" && pre[i] !== fe[i] && pre[i] !== "{}" && fe[i] !== "{}") return false;
  return true;
}
const methodOk = (fe, be) => fe === "ANY" || be === "ANY" || fe === be;

// ─────────────────────────── backend detectors ─────────────────────────────
// Each returns [{ method, path, prefix?, line, via }]. `prefix:true` means the
// route matches any path beginning with `path` (Spring "/x/**", Rust
// starts_with guards). `method:"ANY"` means the declaration does not pin one.

// Spring MVC: class-level @RequestMapping prefix + method-level mappings.
function detectSpringRoutes(text) {
  const routes = [];
  const METHOD_OF = { Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE", Patch: "PATCH", Request: "ANY" };
  // class-level prefix: the last @RequestMapping("...") that precedes `class `.
  let classPrefix = "";
  const classIdx = text.search(/\b(?:public\s+|final\s+|abstract\s+)*class\s/);
  if (classIdx > 0) {
    const head = text.slice(0, classIdx);
    const cm = [...head.matchAll(/@RequestMapping\s*\(([^)]*)\)/g)].pop();
    if (cm) { const p = pathsFromJavaAnno(cm[1])[0]; if (p) classPrefix = p.replace(/\/$/, ""); }
  }
  const lines = text.split(/\r?\n/);
  const RE = /@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(([^)]*)\)/g;
  for (let i = 0; i < lines.length; i++) {
    let m; RE.lastIndex = 0;
    while ((m = RE.exec(lines[i]))) {
      // skip the class-level annotation itself (line is followed by a class decl)
      if (/\bclass\s/.test(lines[i]) || (lines[i + 1] && /\bclass\s/.test(lines[i + 1]))) continue;
      const method = METHOD_OF[m[1]];
      for (const raw of pathsFromJavaAnno(m[2])) {
        const full = joinPath(classPrefix, raw);
        routes.push({ method, path: full, line: i + 1, via: "spring" });
      }
    }
  }
  return routes;
}
// Extract path string(s) from a Spring annotation arg list, honoring
// `value=`/`path=`, brace lists {"a","b"}, and ignoring produces=/consumes=.
function pathsFromJavaAnno(argstr) {
  const braced = /(?:value|path)\s*=\s*\{([^}]*)\}/.exec(argstr);
  if (braced) return [...braced[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  const named = /(?:value|path)\s*=\s*"([^"]*)"/.exec(argstr);
  if (named) return [named[1]];
  const brace = /^\s*\{([^}]*)\}/.exec(argstr);
  if (brace) return [...brace[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  const first = /"([^"]*)"/.exec(argstr);
  return first ? [first[1]] : [""];
}
function joinPath(prefix, sub) {
  if (!prefix) return sub || "/";
  if (!sub || sub === "/" || sub === "") return prefix || "/";
  return (prefix + "/" + sub).replace(/\/{2,}/g, "/");
}

// Rust CF-worker / bespoke router: `match (method, path)` tuple arms +
// `if path == "…"` / `path.starts_with("…")` guards.
const RUST_BROAD = new Set(["/admin", "/admin/", "/accounts", "/accounts/", "/", "/console", "/console/", "/api", "/api/"]);
function detectRustRoutes(text) {
  const routes = [];
  const lines = text.split(/\r?\n/);
  const TUPLE = /\(\s*"(GET|POST|PUT|DELETE|PATCH)"\s*,\s*"([^"]+)"\s*\)/g;
  const TUPLE_SW = /\(\s*"(GET|POST|PUT|DELETE|PATCH)"\s*,\s*[a-z_]+\s*\)\s*if\s+[a-z_]+\.starts_with\(\s*"([^"]+)"/g;
  const GUARD_EQ = /\bpath\s*==\s*"([^"]+)"/g;
  const GUARD_SW = /\bpath\.starts_with\(\s*"([^"]+)"\s*\)/g;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]; let m;
    TUPLE.lastIndex = 0; while ((m = TUPLE.exec(ln))) if (m[2].startsWith("/")) routes.push({ method: m[1], path: m[2], line: i + 1, via: "rust-worker" });
    TUPLE_SW.lastIndex = 0; while ((m = TUPLE_SW.exec(ln))) if (m[2].startsWith("/")) routes.push({ method: m[1], path: m[2], prefix: true, line: i + 1, via: "rust-worker" });
    GUARD_EQ.lastIndex = 0; while ((m = GUARD_EQ.exec(ln))) if (m[1].startsWith("/") && !RUST_BROAD.has(m[1])) routes.push({ method: "ANY", path: m[1], line: i + 1, via: "rust-guard" });
    GUARD_SW.lastIndex = 0; while ((m = GUARD_SW.exec(ln))) { const p = m[1].replace(/\/$/, ""); if (m[1].startsWith("/") && !RUST_BROAD.has(m[1])) routes.push({ method: "ANY", path: p, prefix: true, line: i + 1, via: "rust-guard" }); }
  }
  return routes;
}

function detectBackendRoutes(relFile, text) {
  if (relFile.endsWith(".java")) return detectSpringRoutes(text);
  if (relFile.endsWith(".rs")) return detectRustRoutes(text);
  return [];
}

// ─────────────────────────── frontend detector ─────────────────────────────
// Hub-aware: raw fetch/$fetch/useFetch AND object-hub calls. Covers both the
// standard verbs (`api.get('/x')`, `axios.put(...)`) and the common wrapped-hub
// convention (`request.sendGet('/x')`, `http.sendJson(...)`, `req.send(...)`).
// The "resolved path must start with /" filter drops non-API `.get()`/`.send()`
// noise (Map.get('k'), emitter.send(evt), etc.). Verb → HTTP method below.
const FE_VERB = "get|post|put|delete|patch|sendGet|sendPost|sendPut|sendDelete|sendPatch|sendJson|send|request";
const FE_CALL = new RegExp(`\\b(?:\\$fetch|useFetch|fetch)\\s*\\(|\\b[\\w$]+\\.(${FE_VERB})\\s*\\(`, "g");
const VERB_METHOD = {
  get: "GET", post: "POST", put: "PUT", delete: "DELETE", patch: "PATCH",
  sendGet: "GET", sendPost: "POST", sendPut: "PUT", sendDelete: "DELETE",
  sendPatch: "PATCH", sendJson: "POST", send: "ANY", request: "ANY",
};
function readCallArg(src, startIdx) {
  let depth = 0, i = startIdx, arg = "", inStr = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) { arg += c; if (c === inStr && src[i - 1] !== "\\") inStr = null; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; arg += c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; arg += c; continue; }
    if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; arg += c; continue; }
    if (c === "," && depth === 0) break;
    arg += c;
  }
  return { arg: arg.trim(), end: i };
}
function resolveFeUrl(arg) {
  arg = arg.trim();
  let body = null;
  if (arg.startsWith("`")) body = arg.slice(1, arg.lastIndexOf("`"));
  else { const m = /^(['"])(.*?)\1/.exec(arg); if (m) body = m[2]; }
  if (body === null) return { path: null, dynamic: true };
  // strip scheme://authority and a leading base interpolation (${apiBase}/…)
  let s = body.replace(/^https?:\/\/[^/]*/i, "").replace(/^\$\{[^}]*\}/, "");
  if (!s.startsWith("/")) return { path: null, dynamic: true }; // non-path first arg → not an API call
  s = s.split("?")[0].split("#")[0].replace(/\$\{[^}]*\}/g, "{}");
  return { path: normPath(s), dynamic: false };
}
function detectFrontendCalls(relFile, text) {
  if (!/\.(vue|svelte|ts|tsx|js|jsx|mjs|cjs)$/.test(relFile)) return [];
  const calls = [];
  let m; FE_CALL.lastIndex = 0;
  while ((m = FE_CALL.exec(text))) {
    const { arg, end } = readCallArg(text, FE_CALL.lastIndex);
    const { path, dynamic } = resolveFeUrl(arg);
    if (dynamic || !path) continue;
    // method: verb from the hub call, else `method:` in the options object, else GET
    let method = "GET";
    if (m[1] && VERB_METHOD[m[1]]) method = VERB_METHOD[m[1]];
    else { const mm = /method\s*:\s*['"`]?(GET|POST|PUT|DELETE|PATCH)/i.exec(text.slice(end, end + 220)); if (mm) method = mm[1].toUpperCase(); }
    const line = text.slice(0, m.index).split(/\r?\n/).length;
    calls.push({ method, path, line, raw: arg.slice(0, 80) });
  }
  return calls;
}

// ───────────────────────────── surface scan ────────────────────────────────
export function scanApiSurface({ files = [], root, readText }) {
  const calls = [], routes = [];
  for (const rel of files) {
    let text; try { text = readText(rel); } catch { continue; }
    if (text == null) continue;
    for (const c of detectFrontendCalls(rel, text)) calls.push({ ...c, file: rel });
    for (const r of detectBackendRoutes(rel, text)) routes.push({ ...r, file: rel });
  }
  return { calls, routes };
}

// ─────────────────────────────── matching ──────────────────────────────────
// For each FE call, find the backend route it hits. A route is a candidate if
// its (possibly-prefix) path covers the call path; method must agree unless one
// side is ANY. Records method-divergent hits (path matches, verb differs) as a
// contract-drift signal rather than dropping them.
export function matchLinks({ calls, routes }) {
  const links = [], unmatchedFE = [], divergent = [];
  const hitRoute = new Set();
  const routeKey = (r) => `${r.method} ${r.path} ${r.file}:${r.line}`;
  for (const c of calls) {
    const cs = pathSegs(c.path);
    let pathHit = null, methodHit = null;
    for (const r of routes) {
      const ok = r.prefix ? prefixCover(pathSegs(r.path), cs) : exactEq(pathSegs(r.path), cs);
      if (!ok) continue;
      if (!pathHit) pathHit = r;
      if (methodOk(c.method, r.method)) { methodHit = r; break; }
    }
    if (methodHit) {
      links.push({ call: c, route: methodHit, confidence: methodHit.prefix ? "medium" : "high" });
      hitRoute.add(routeKey(methodHit));
    } else if (pathHit) {
      divergent.push({ call: c, route: pathHit });
      links.push({ call: c, route: pathHit, confidence: "low", methodDivergent: true });
      hitRoute.add(routeKey(pathHit));
    } else {
      unmatchedFE.push(c);
    }
  }
  const deadRoutes = routes.filter((r) => !hitRoute.has(routeKey(r)));
  return { links, unmatchedFE, divergent, deadRoutes };
}

// ─────────────────────────── overlay assembly ──────────────────────────────
// Turn matched links into graph nodes+edges: an endpoint bridge node per
// (method, path), an `http-call` edge from the FE caller's enclosing symbol to
// the endpoint, and an `http-serve` edge from the endpoint to the BE handler's
// enclosing symbol. Edges reference real function anchors so the two trees
// become one connected graph.
function enclosingIndex(symbols) {
  const byFile = new Map();
  for (const s of symbols) {
    if (!s.file) continue;
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file).push(s);
  }
  return (file, line) => {
    const list = byFile.get(file);
    if (!list) return null;
    let best = null, bestSpan = Infinity;
    for (const s of list) {
      const a = s.line_start ?? 0, b = s.line_end ?? a;
      if (line >= a && line <= b && b - a < bestSpan) { best = s; bestSpan = b - a; }
      else if (s.kind === "File" && !best) best = s; // fall back to the file node
    }
    return best;
  };
}
const endpointAnchor = (method, path) => `http-endpoint:${method} ${normPath(path)}`;

export function buildCrossStackOverlay({ symbols = [], edges = [], files = [], readText }) {
  const scan = scanApiSurface({ files, readText });
  const { links, unmatchedFE, divergent, deadRoutes } = matchLinks(scan);
  const enclosing = enclosingIndex(symbols);
  const outSyms = [], outEdges = [];
  const endpointSeen = new Map();
  for (const { call, route, confidence, methodDivergent } of links) {
    const method = route.method === "ANY" ? call.method : route.method;
    const anchor = endpointAnchor(method, route.path);
    if (!endpointSeen.has(anchor)) {
      endpointSeen.set(anchor, true);
      outSyms.push({
        anchor, lang: "http", kind: "Endpoint",
        name: `${method} ${normPath(route.path)}`,
        file: route.file, line_start: route.line, line_end: route.line,
        resolution: "heuristic", via: route.via,
      });
      // endpoint → backend handler (the code that serves it)
      const handler = enclosing(route.file, route.line);
      if (handler) outEdges.push({ kind: "http-serve", from: anchor, to: handler.anchor, confidence: "high", site: { file: route.file, line: route.line } });
    }
    // frontend caller → endpoint
    const caller = enclosing(call.file, call.line);
    outEdges.push({
      kind: "http-call",
      from: caller ? caller.anchor : undefined,
      to: anchor,
      to_text: caller ? undefined : `${call.file}:${call.line}`,
      confidence,
      methodDivergent: methodDivergent || undefined,
      site: { file: call.file, line: call.line },
    });
  }
  return {
    symbols: outSyms,
    edges: outEdges,
    audit: {
      matched: links.length,
      endpoints: outSyms.length,
      divergent: divergent.map((d) => ({ fe: `${d.call.method} ${d.call.path}`, feSite: `${d.call.file}:${d.call.line}`, be: `${d.route.method} ${d.route.path}` })),
      unmatchedFE: unmatchedFE.map((c) => ({ call: `${c.method} ${c.path}`, site: `${c.file}:${c.line}` })),
      deadRoutes: deadRoutes.map((r) => ({ route: `${r.method} ${normPath(r.path)}`, site: `${r.file}:${r.line}` })),
    },
  };
}

// exported for unit tests
export const _internal = { normPath, detectSpringRoutes, detectRustRoutes, detectFrontendCalls, enclosingIndex };
