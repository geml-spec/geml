// Cross-stack API-link overlay tests (geml-parser/codemap/cross-stack.mjs).
// Framework-agnostic detectors + METHOD+path matcher + graph overlay, driven
// by inline fixtures (no dependency on any external project). Asserts the
// endpoint bridge nodes and the http-call / http-serve edges wire the frontend
// caller's enclosing function to the backend handler's enclosing function.
import { strict as assert } from "node:assert";
import {
  scanApiSurface, matchLinks, buildCrossStackOverlay, _internal,
} from "../codemap/cross-stack.mjs";

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

// ── overlay: endpoint bridge nodes + edges wired to enclosing symbols ────────
test("buildCrossStackOverlay wires FE caller → endpoint → BE handler", () => {
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
  const { symbols: syms, edges, audit } = buildCrossStackOverlay({ symbols, edges: [], files, readText });

  assert.equal(syms.length, 1, "one endpoint node");
  assert.equal(syms[0].kind, "Endpoint");
  assert.equal(syms[0].name, "POST /accounts/login");
  assert.equal(syms[0].anchor, "http-endpoint:POST /accounts/login");

  const call = edges.find((e) => e.kind === "http-call");
  const serve = edges.find((e) => e.kind === "http-serve");
  assert.ok(call, "http-call edge exists");
  assert.equal(call.from, "ts:fe.ts#doLogin");
  assert.equal(call.to, "http-endpoint:POST /accounts/login");
  assert.equal(call.confidence, "high");
  assert.ok(serve, "http-serve edge exists");
  assert.equal(serve.from, "http-endpoint:POST /accounts/login");
  assert.equal(serve.to, "rust:be.rs#dispatch");
  assert.equal(audit.matched, 1);
  assert.equal(audit.endpoints, 1);
});

// ── overlay: unresolved FE base (dynamic) is skipped, not mis-linked ─────────
test("overlay leaves fully-dynamic FE URLs unmatched", () => {
  const files = ["fe.ts"];
  const readText = () => `const u = buildUrl(x); fetch(u);\n`;
  const { symbols, edges } = buildCrossStackOverlay({ symbols: [], edges: [], files, readText });
  assert.equal(symbols.length, 0);
  assert.equal(edges.length, 0);
});

console.log(`${passed} test(s) passed.`);
