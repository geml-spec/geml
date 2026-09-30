// GEML's MCP server as a stateless Cloudflare Worker.
//
// This file is only the HTTP shell. The tools, the write pipeline and the
// JSON-RPC dispatch are geml-parser's mcp-core, bound to its INLINE host: the
// document travels in `source`, a write comes back as `document`, nothing is
// kept between calls. What is decided here is what an HTTP transport has to
// decide — Origin, body size, the mirrored headers MCP 2026-07-28 requires,
// and which era a request speaks — and nothing else.
import {
  LEGACY_VERSIONS, MODERN_VERSIONS, SERVER_INFO, dispatch, eraOf, inlineHost, toolsFor,
} from "../../../geml-parser/dist/mcp-core.js";
import parserPkg from "../../../geml-parser/package.json" with { type: "json" };

// The parser reads its version from package.json next to dist/ at import
// time; in the bundle that file is not there (node:fs is a stub), so the
// lookup falls back to 0.0.0. The version is bundled in from the same
// package.json instead — one source, read at build time.
SERVER_INFO.version = parserPkg.version;

const TOOLS = toolsFor(inlineHost());
const tools = () => TOOLS;

const DEFAULT_ORIGINS = "http://localhost:*,http://127.0.0.1:*";
const DEFAULT_MAX_BODY = 2 * 1024 * 1024;
const README = "https://github.com/geml-spec/geml/tree/main/integrations/geml-mcp-worker";

export default {
  fetch(request, env = {}, _ctx) {
    return handle(request, env);
  },
};

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

const DEFAULT_PORT = { "http:": "80", "https:": "443" };

/** Is `origin` on the allowlist? Entries: `scheme://host`, `scheme://host:port`, `scheme://host:*`, or `*`. */
export function originAllowed(origin, env) {
  let o;
  try { o = new URL(origin); } catch { return false; }
  const list = String(env?.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);
  const oPort = o.port || DEFAULT_PORT[o.protocol] || "";
  return list.some((pat) => {
    if (pat === "*") return true;
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/:]+)(?::(\*|\d+))?$/i.exec(pat);
    if (!m) return pat === origin;
    const [, scheme, host, port] = m;
    if (o.protocol !== `${scheme.toLowerCase()}:` || o.hostname.toLowerCase() !== host.toLowerCase()) return false;
    if (port === "*") return true;
    return oPort === (port ?? DEFAULT_PORT[o.protocol] ?? "");
  });
}

// ---------------------------------------------------------------------------
// Mirrored headers (MCP 2026-07-28, Streamable HTTP "Request Metadata")
// ---------------------------------------------------------------------------

/** A header value, with the `=?base64?…?=` sentinel decoded as UTF-8; anything undecodable stays literal. */
export function decodeHeaderValue(v) {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try {
    const bin = atob(m[1]);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return v;
  }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function cors(request, env) {
  const origin = request.headers.get("origin");
  if (!origin || !originAllowed(origin, env)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

const json = (body, status, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
const rpcError = (id, code, message, status, extra = {}) =>
  json({ jsonrpc: "2.0", id, error: { code, message } }, status, extra);

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

export async function handle(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  // Servers MUST validate Origin (both eras of the spec say so). No Origin is a
  // non-browser client and passes; an Origin off the allowlist is refused.
  if (origin && !originAllowed(origin, env)) {
    return rpcError(null, -32600, "origin not allowed", 403);
  }
  const extra = cors(request, env);

  if (url.pathname === "/") {
    return new Response(
      `geml MCP server ${SERVER_INFO.version} — POST JSON-RPC to /mcp (MCP ${MODERN_VERSIONS.join(", ")}; ${LEGACY_VERSIONS.join(", ")} via initialize). ${README}\n`,
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8", ...extra } },
    );
  }
  if (url.pathname !== "/mcp") return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain", ...extra } });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: extra });
  if (request.method !== "POST") {
    // No SSE stream to open, no session to terminate: 405 is what both spec
    // revisions prescribe for GET and DELETE here.
    return new Response("method not allowed\n", { status: 405, headers: { allow: "POST, OPTIONS", "content-type": "text/plain", ...extra } });
  }

  // Body size, by declaration first and by measurement after.
  const max = Number(env?.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return rpcError(null, -32600, `request body exceeds ${max} bytes`, 413, extra);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > max) return rpcError(null, -32600, `request body exceeds ${max} bytes`, 413, extra);

  let msg;
  try { msg = JSON.parse(text); } catch { return rpcError(null, -32700, "parse error: the body is not JSON", 400, extra); }
  if (Array.isArray(msg)) return rpcError(null, -32600, "batching is not supported: send one JSON-RPC message per request", 400, extra);
  if (typeof msg !== "object" || msg === null) return rpcError(null, -32600, "invalid request", 400, extra);

  const version = request.headers.get("mcp-protocol-version");
  if (eraOf(msg) === "modern") {
    // The body is the source of truth; the headers mirror it so intermediaries
    // can route without parsing. A missing or disagreeing header is rejected.
    const bodyVersion = msg.params._meta["io.modelcontextprotocol/protocolVersion"];
    const mismatch = (what) => rpcError(msg.id ?? null, -32020, `Header mismatch: ${what}`, 400, extra);
    if (version === null) return mismatch("MCP-Protocol-Version header is required");
    if (version !== bodyVersion) return mismatch(`MCP-Protocol-Version header '${version}' does not match body value '${bodyVersion}'`);
    const method = request.headers.get("mcp-method");
    if (method === null) return mismatch("Mcp-Method header is required");
    if (method !== msg.method) return mismatch(`Mcp-Method header '${method}' does not match body value '${msg.method}'`);
    if (msg.method === "tools/call" && typeof msg.params?.name === "string") {
      const name = request.headers.get("mcp-name");
      if (name === null) return mismatch("Mcp-Name header is required on tools/call");
      const decoded = decodeHeaderValue(name);
      if (decoded !== msg.params.name) return mismatch(`Mcp-Name header '${decoded}' does not match body value '${msg.params.name}'`);
    }
  } else if (version !== null && !LEGACY_VERSIONS.includes(version)) {
    // A legacy client that omits the header (pre-2025-06-18) is taken as
    // 2025-03-26, as the spec allows; one that names a version we do not
    // speak is refused.
    return rpcError(msg.id ?? null, -32600, `unsupported protocol version '${version}' (this server speaks ${LEGACY_VERSIONS.join(", ")} via initialize, and ${MODERN_VERSIONS.join(", ")})`, 400, extra);
  }

  const d = dispatch(msg, tools);
  if (!d.reply) return new Response(null, { status: 202, headers: extra });
  return json(d.reply, d.status, extra);
}
