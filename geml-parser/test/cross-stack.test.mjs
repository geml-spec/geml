// Cross-stack API-link overlay tests (geml-parser/codemap/cross-stack.mjs).
// Framework-agnostic detectors + METHOD+path matcher + graph overlay, driven
// by inline fixtures (no dependency on any external project). Asserts the
// endpoint bridge nodes and the http-call / http-serve edges wire the frontend
// caller's enclosing function to the backend handler's enclosing function.
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanApiSurface, matchLinks, buildCrossStackOverlay, _internal,
} from "../codemap/cross-stack.mjs";
import { emit } from "../codemap/emit.mjs";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const { normPath, detectSpringRoutes, detectRustRoutes, detectFrontendCalls } = _internal;

// ── path normalization ──────────────────────────────────────────────────────
test("normPath collapses {id}/:id/${x} params and trims", () => {
  assert.equal(normPath("/users/{id}/posts/"), "/users/{}/posts");
  assert.equal(normPath("/users/:userId"), "/users/{}");
  assert.equal(normPath("/a/${x}/b?q=1"), "/a/{}/b");
  assert.equal(normPath("/"), "/");
});

test("normPath: an empty or query-only URL normalizes to the bare root", () => {
  // fetch('?tab=1') / fetch('') — nothing left of the path once query and
  // fragment are stripped; the join key must still be a real path, never "".
  assert.equal(normPath(""), "/");
  assert.equal(normPath("?tab=1"), "/");
  assert.equal(normPath("#frag"), "/");
});

// ── backend: Spring (class-level prefix + method mappings + brace list) ──────
test("Spring detector composes class prefix with method mappings", () => {
  const java = `
@RestController
@RequestMapping("/api/orders")
public class OrderController {
  @GetMapping({"", "/"})
  public List<Order> list() { return null; }
  @PostMapping("/create")
  public Order create() { return null; }
  @GetMapping(value = "/{id}", produces = "application/json")
  public Order get() { return null; }
}`;
  const r = detectSpringRoutes(java);
  const keys = r.map((x) => `${x.method} ${normPath(x.path)}`);
  assert.ok(keys.includes("POST /api/orders/create"), keys.join(" | "));
  assert.ok(keys.includes("GET /api/orders/{}"), keys.join(" | "));
  assert.ok(keys.includes("GET /api/orders"), keys.join(" | ")); // {"", "/"} → prefix only
});

test("Spring detector: prefix-less controller, value={} brace list, argument-less mapping", () => {
  // No class-level @RequestMapping at all — every method path stands alone —
  // plus the two annotation spellings the prefixed fixture above never uses:
  // a NAMED brace list (value = {...}) and a mapping with no argument, whose
  // route is the bare root.
  const java = `class BareCtl {
  @RequestMapping(value = {"/pair/a", "/pair/b"})
  void pair() {}
  @PostMapping()
  void blank() {}
  @GetMapping("/solo")
  void solo() {}
}`;
  const keys = detectSpringRoutes(java).map((x) => `${x.method} ${normPath(x.path)}`);
  assert.ok(keys.includes("ANY /pair/a"), keys.join(" | "));
  assert.ok(keys.includes("ANY /pair/b"), keys.join(" | "));
  assert.ok(keys.includes("POST /"), keys.join(" | "));
  assert.ok(keys.includes("GET /solo"), keys.join(" | "));
  assert.equal(keys.length, 4, "nothing invented beyond the four mappings");
});

// ── backend: Rust worker (match tuples + guard delegations) ──────────────────
test("Rust detector reads match tuples and path guards", () => {
  const rs = `
  let resp = match (method.as_str(), path.as_str()) {
    ("POST", "/accounts/login") => login(req).await,
    ("GET",  "/accounts/me")    => me(req).await,
    ("DELETE", p) if p.starts_with("/accounts/tokens/") => revoke(req).await,
    _ => not_found(),
  };
  if path.starts_with("/admin/members") { return members(req).await; }
  if path == "/admin/audit" { return audit(req).await; }`;
  const r = detectRustRoutes(rs);
  const keys = r.map((x) => `${x.method} ${normPath(x.path)}${x.prefix ? "*" : ""}`);
  assert.ok(keys.includes("POST /accounts/login"), keys.join(" | "));
  assert.ok(keys.includes("DELETE /accounts/tokens*"), keys.join(" | "));
  assert.ok(keys.includes("ANY /admin/members*"), keys.join(" | "));
  assert.ok(keys.includes("ANY /admin/audit"), keys.join(" | "));
});

// ── frontend: fetch / hub / base-prefix / param / noise filter ───────────────
test("FE detector resolves base-prefixed + param URLs, ignores non-API .get", () => {
  const vue = `
    const map = new Map(); map.get('some-key');       // must be ignored
    await fetch(\`\${config.apiBase}/accounts/login\`, { method: 'POST' });
    await api.get('/console/apis');
    await api.delete(\`/console/datasources/\${encodeURIComponent(id)}\`);
    await fetch(\`https://\${runHost}/_sandbox/demo\`, { method: 'POST' });`;
  const c = detectFrontendCalls("src/pages/x.vue", vue);
  const keys = c.map((x) => `${x.method} ${x.path}`);
  assert.ok(keys.includes("POST /accounts/login"), keys.join(" | "));
  assert.ok(keys.includes("GET /console/apis"), keys.join(" | "));
  assert.ok(keys.includes("DELETE /console/datasources/{}"), keys.join(" | "));
  assert.ok(keys.includes("POST /_sandbox/demo"), keys.join(" | "));
  assert.ok(!keys.some((k) => k.includes("some-key")), "Map.get must not be treated as an API call");
});

// ── matching: exact, prefix, method-divergent, unmatched, dead ───────────────
test("matchLinks classifies exact / prefix / divergent / unmatched / dead", () => {
  const calls = [
    { method: "POST", path: "/accounts/login", file: "fe.ts", line: 2 },
    { method: "DELETE", path: "/accounts/tokens/{}", file: "fe.ts", line: 3 }, // prefix route
    { method: "POST", path: "/backup/rollback", file: "fe.ts", line: 4 },      // divergent (BE is GET)
    { method: "GET", path: "/nope", file: "fe.ts", line: 5 },                  // unmatched
  ];
  const routes = [
    { method: "POST", path: "/accounts/login", file: "be.rs", line: 10 },
    { method: "DELETE", path: "/accounts/tokens/", prefix: true, file: "be.rs", line: 11 },
    { method: "GET", path: "/backup/rollback", file: "be.rs", line: 12 },
    { method: "GET", path: "/orphan", file: "be.rs", line: 13 },               // dead
  ];
  const { links, unmatchedFE, divergent, deadRoutes } = matchLinks({ calls, routes });
  assert.equal(links.length, 3);
  assert.equal(divergent.length, 1);
  assert.equal(divergent[0].call.path, "/backup/rollback");
  assert.equal(unmatchedFE.length, 1);
  assert.equal(unmatchedFE[0].path, "/nope");
  assert.deepEqual(deadRoutes.map((r) => normPath(r.path)), ["/orphan"]);
  const exact = links.find((l) => l.call.path === "/accounts/login");
  assert.equal(exact.confidence, "high");
  const pre = links.find((l) => l.call.path === "/accounts/tokens/{}");
  assert.equal(pre.confidence, "medium");
});

// ── overlay: direct FE-caller → BE-handler http edge, endpoint as label ──────
test("buildCrossStackOverlay links FE caller directly to BE handler", () => {
  // Ranges are set so the FE call (fe.ts line 2) sits inside doLogin (1-5) and
  // the BE route (be.rs line 3) sits inside dispatch (1-6) — enclosing lookup
  // must attribute each edge end to the right function.
  const symbols = [
    { anchor: "ts:fe.ts#doLogin", kind: "Function", file: "fe.ts", line_start: 1, line_end: 5 },
    { anchor: "rust:be.rs#dispatch", kind: "Function", file: "be.rs", line_start: 1, line_end: 6 },
  ];
  const files = ["fe.ts", "be.rs"];
  const src = {
    "fe.ts": `function doLogin() {\n  fetch('/accounts/login', { method: 'POST' });\n}\n`,
    "be.rs": `fn dispatch() {\n  let r = match (m, p) {\n    ("POST", "/accounts/login") => handle_login(),\n    _ => nf(),\n  };\n}\n`,
  };
  const readText = (rel) => src[rel];
  const { edges, audit } = buildCrossStackOverlay({ symbols, files, readText });

  assert.equal(edges.length, 1, "one http edge");
  const e = edges[0];
  assert.equal(e.kind, "http");
  assert.equal(e.from, "ts:fe.ts#doLogin");
  assert.equal(e.to, "rust:be.rs#dispatch");
  assert.equal(e.endpoint, "POST /accounts/login");
  assert.equal(e.confidence, "high");
  assert.equal(audit.matched, 1);
  assert.equal(audit.endpoints, 1);
});

// ── overlay: unenclosed ends fall back to *_text, still one edge ─────────────
test("overlay falls back to file:line text when no function encloses a site", () => {
  const files = ["fe.ts", "be.rs"];
  const src = {
    "fe.ts": `fetch('/x', { method: 'GET' });\n`,          // top-level, no enclosing fn symbol
    "be.rs": `match (m,p) { ("GET","/x") => h(), _=>() };\n`,
  };
  const { edges } = buildCrossStackOverlay({ symbols: [], files, readText: (r) => src[r] });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, undefined);
  assert.equal(edges[0].from_text, "fe.ts:1");
  assert.equal(edges[0].to_text, "be.rs:1");
});

// ── overlay: a symbol with no recorded span never captures attribution ───────
test("overlay: a spanless symbol does not enclose anything — the site falls back to file:line", () => {
  // An adapter can emit a symbol without line_start/line_end (a degraded
  // extraction). Its span must default to an empty [0,0], never swallow the
  // whole file — the call at line 1 stays text-attributed.
  const symbols = [{ anchor: "ts:fe.ts#mystery", kind: "Function", file: "fe.ts" }];
  const src = {
    "fe.ts": `fetch('/x', { method: 'GET' });\n`,
    "be.rs": `match (m,p) { ("GET","/x") => h(), _=>() };\n`,
  };
  const { edges } = buildCrossStackOverlay({ symbols, files: ["fe.ts", "be.rs"], readText: (r) => src[r] });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, undefined, "the spanless symbol claimed nothing");
  assert.equal(edges[0].from_text, "fe.ts:1");
});

// ── overlay: fully-dynamic FE URL produces no link ───────────────────────────
test("overlay leaves fully-dynamic FE URLs unmatched", () => {
  const files = ["fe.ts"];
  const readText = () => `const u = buildUrl(x); fetch(u);\n`;
  const { edges } = buildCrossStackOverlay({ symbols: [], files, readText });
  assert.equal(edges.length, 0);
});

// ── emit: http edges become cross-doc #api-calls / #api-served-by tables ─────
test("emit renders http edges as cross-tree #api-calls / #api-served-by", () => {
  const symbols = [
    { anchor: "ts:web/api.ts#login", kind: "Function", name: "login", file: "web/api.ts", line_start: 1, line_end: 3, resolution: "heuristic" },
    { anchor: "rust:srv/routes.rs#dispatch", kind: "Function", name: "dispatch", file: "srv/routes.rs", line_start: 1, line_end: 5, resolution: "heuristic" },
  ];
  const edges = [
    { kind: "http", from: "ts:web/api.ts#login", to: "rust:srv/routes.rs#dispatch", endpoint: "POST /login", confidence: "high", site: { file: "web/api.ts", line: 2 } },
  ];
  const out = mkdtempSync(join(tmpdir(), "geml-xstack-emit-"));
  try {
    emit({ symbols, edges, outDir: out, repoName: "demo", container: "dir", root: out });
    const docs = Object.fromEntries(readdirSync(out).filter((f) => f.endsWith(".geml")).map((f) => [f, readFileSync(join(out, f), "utf8")]));
    const feDoc = Object.values(docs).find((t) => t.includes("#api-calls"));
    const beDoc = Object.values(docs).find((t) => t.includes("#api-served-by"));
    assert.ok(feDoc, "some doc has #api-calls");
    assert.match(feDoc, /#dispatch/, "FE doc links to the backend handler id");
    assert.match(feDoc, /POST \/login/, "endpoint label present");
    assert.ok(beDoc, "some doc has #api-served-by");
    assert.match(beDoc, /#login/, "BE doc names the frontend caller id");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ── emit: method-divergent link carries a marker; unresolved end tolerated ───
test("emit marks method-mismatch and tolerates an unresolved end", () => {
  const symbols = [
    { anchor: "ts:web/api.ts#roll", kind: "Function", name: "roll", file: "web/api.ts", line_start: 1, line_end: 3, resolution: "heuristic" },
  ];
  const edges = [
    { kind: "http", from: "ts:web/api.ts#roll", to: undefined, to_text: "srv/routes.rs:9", endpoint: "POST /backup/rollback", confidence: "low", methodDivergent: true, site: { file: "web/api.ts", line: 2 } },
  ];
  const out = mkdtempSync(join(tmpdir(), "geml-xstack-emit2-"));
  try {
    emit({ symbols, edges, outDir: out, repoName: "demo", container: "dir", root: out });
    const web = readdirSync(out).filter((f) => f.endsWith(".geml")).map((f) => readFileSync(join(out, f), "utf8")).find((t) => t.includes("#api-calls"));
    assert.ok(web, "some doc has #api-calls");
    assert.match(web, /method-mismatch/, "divergent verb flagged");
    assert.match(web, /srv\/routes\.rs:9/, "unresolved handler shown as file:line text");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ── emit: every unresolved-cell shape in the api tables ──────────────────────
test("emit api tables: ghost anchors render as ?, text ends ride verbatim, a siteless edge leaves the cell empty", () => {
  const symbols = [
    { anchor: "ts:web/api.ts#login", kind: "Function", name: "login", file: "web/api.ts", line_start: 1, line_end: 3, resolution: "heuristic" },
    { anchor: "rust:srv/routes.rs#dispatch", kind: "Function", name: "dispatch", file: "srv/routes.rs", line_start: 1, line_end: 5, resolution: "heuristic" },
    { anchor: "rust:srv/routes.rs#fallback", kind: "Function", name: "fallback", file: "srv/routes.rs", line_start: 7, line_end: 9, resolution: "heuristic" },
  ];
  const edges = [
    // same endpoint THREE times from the same caller — two resolved handlers
    // around one bare file:line, so the deterministic ordering has to compare
    // a text end from both sides
    { kind: "http", from: "ts:web/api.ts#login", to: "rust:srv/routes.rs#dispatch", endpoint: "GET /dup", confidence: "high", site: { file: "web/api.ts", line: 2 } },
    { kind: "http", from: "ts:web/api.ts#login", to: undefined, to_text: "srv/other.rs:3", endpoint: "GET /dup", confidence: "low" },
    { kind: "http", from: "ts:web/api.ts#login", to: "rust:srv/routes.rs#fallback", endpoint: "GET /dup", confidence: "medium" },
    // an anchor the emitted symbol set does not know, and no *_text either:
    // the cell degrades to `?` rather than a dangling reference
    { kind: "http", from: "ts:web/api.ts#login", to: "rust:ghost#gone", endpoint: "GET /ghost", confidence: "low" },
    // resolved handler reached from an UNresolved caller with no site recorded
    { kind: "http", from: undefined, from_text: "web/main.ts:9", to: "rust:srv/routes.rs#dispatch", endpoint: "POST /serve", confidence: "high" },
    // …and one with NO caller information at all — the from cell degrades to ?
    { kind: "http", to: "rust:srv/routes.rs#dispatch", endpoint: "PUT /mystery", confidence: "low" },
  ];
  const out = mkdtempSync(join(tmpdir(), "geml-xstack-emit3-"));
  try {
    emit({ symbols, edges, outDir: out, repoName: "demo", container: "dir", root: out });
    const docs = readdirSync(out).filter((f) => f.endsWith(".geml")).map((f) => readFileSync(join(out, f), "utf8"));
    const feDoc = docs.find((t) => t.includes("#api-calls"));
    assert.ok(feDoc, "some doc has #api-calls");
    assert.match(feDoc, /#login,\s+[\w-]*srv\.geml#dispatch,\s+GET \/dup,\s+high/, "resolved handler as a cross-doc ref");
    assert.match(feDoc, /#login,\s+srv\/other\.rs:3,\s+GET \/dup,\s+low/, "text end verbatim");
    assert.match(feDoc, /#login,\s+[\w-]*srv\.geml#fallback,\s+GET \/dup,\s+medium/, "second resolved handler kept too");
    assert.match(feDoc, /#login,\s+\?,\s+GET \/ghost,\s+low/, "ghost anchor degrades to ? — never a dangling ref");
    const beDoc = docs.find((t) => t.includes("#api-served-by"));
    assert.ok(beDoc, "some doc has #api-served-by");
    assert.match(beDoc, /[\w-]*web\.geml#login,\s+#dispatch,\s+GET \/dup,\s+web\/api\.ts:2/, "resolved caller with its site");
    assert.match(beDoc, /web\/main\.ts:9,\s+#dispatch,\s+POST \/serve,$/m, "text caller; a siteless edge leaves the site cell empty");
    assert.match(beDoc, /\?,\s+#dispatch,\s+PUT \/mystery,$/m, "callerless edge renders as ? instead of vanishing");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ── scanApiSurface: extension dispatch + skips unreadable/empty files ────────
test("scanApiSurface routes .java to the backend detector and tolerates bad reads", () => {
  const src = {
    "Ctrl.java": `class C {\n  @GetMapping("/x")\n  void x(){}\n}`,
    "app.vue": `api.get('/x')`,
    "gone.rs": null, // readText returns null → skipped
  };
  const readText = (rel) => { if (rel === "boom.ts") throw new Error("io"); return src[rel]; };
  const { calls, routes } = scanApiSurface({ files: ["Ctrl.java", "app.vue", "gone.rs", "boom.ts"], readText });
  assert.ok(routes.some((r) => r.file === "Ctrl.java" && r.method === "GET"), "java route via detectBackendRoutes");
  assert.ok(calls.some((c) => c.path === "/x" && c.file === "app.vue"), "vue call detected");
  assert.ok(!routes.some((r) => r.file === "gone.rs"), "null read skipped");
  // boom.ts throwing must not crash the scan
  assert.ok(!calls.some((c) => c.file === "boom.ts"));
});

// ── FE arg reader balances nested brackets (doesn't split on an inner comma) ──
test("FE arg reader does not split on a comma nested inside brackets", () => {
  // The comma lives inside [...]; the reader must balance brackets rather than
  // stop at it and read a truncated argument. Expr isn't a literal → no path,
  // but the balancer must run without mis-parsing or throwing.
  const calls = detectFrontendCalls("x.ts", `fetch(pick(['/a', '/b']))`);
  assert.equal(calls.length, 0);
});

// ── overlay edge cases: File-node skip, fileless symbol, ANY verb, probe ──────
test("overlay skips File/fileless symbols, adopts caller verb for ANY routes, probes below the annotation", () => {
  const symbols = [
    { anchor: "noFile", kind: "Function" },                                              // no .file → skipped in the index
    { anchor: "f:app.vue", kind: "File", file: "app.vue", line_start: 1, line_end: 9 },  // File node → skipped as an encloser
    { anchor: "fn:app.vue#save", kind: "Function", file: "app.vue", line_start: 2, line_end: 4 },
    { anchor: "be:Ctrl.java#save", kind: "Function", file: "Ctrl.java", line_start: 5, line_end: 6 },
  ];
  const src = {
    "app.vue": `x\n  api.post('/res/save')\n\n`,                                          // call on line 2
    "Ctrl.java": `class C {\n\n\n  @RequestMapping("/res/save")\n  void save(){}\n}`,     // ANY-method route annotation on line 4, handler on line 5
  };
  const { edges } = buildCrossStackOverlay({ symbols, files: ["app.vue", "Ctrl.java"], readText: (r) => src[r] });
  assert.equal(edges.length, 1);
  const e = edges[0];
  assert.equal(e.endpoint, "POST /res/save", "ANY route adopts the caller's verb");
  assert.equal(e.from, "fn:app.vue#save", "attributed to the function, not the File node");
  assert.equal(e.to, "be:Ctrl.java#save", "handler found by probing the line below its annotation");
});

console.log(`${passed} test(s) passed.`);
