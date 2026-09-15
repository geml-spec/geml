# geml-mcp-worker — GEML's MCP server on Cloudflare, stateless

The same nine document tools `geml mcp` serves over stdio, reachable over HTTPS
with nothing installed. The Worker keeps no files: every tool takes the
document's text as `source`, and a write comes back as `document` — the whole
new text — for the caller to save. Nothing is stored, nothing needs an account
to call.

```
https://geml-mcp.<subdomain>.workers.dev/mcp
```

The `<subdomain>` placeholder is filled in at first deploy (below). Until then
this README, `wrangler.jsonc` and `geml-parser/server.json` all carry the
placeholder on purpose.

## Two kinds of client, one endpoint

The endpoint speaks both shapes of MCP and decides per request:

- **Legacy** (protocol versions `2024-11-05` … `2025-11-25`): open with
  `initialize`, then `tools/list` / `tools/call`. Point the client at the URL
  above; no session id is ever issued or required.
- **Modern** (`2026-07-28` and later): no handshake. Send any request with
  `_meta.io.modelcontextprotocol/protocolVersion` and `…/clientCapabilities`,
  and the three mirrored headers `MCP-Protocol-Version`, `Mcp-Method` and (on
  `tools/call`) `Mcp-Name`. `server/discover` is implemented.

```sh
# legacy
curl -s -X POST https://geml-mcp.<subdomain>.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'

# modern
curl -s -X POST https://geml-mcp.<subdomain>.workers.dev/mcp \
  -H 'content-type: application/json' -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: server/discover' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'

# a write: the new document comes back in the result
curl -s -X POST https://geml-mcp.<subdomain>.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"geml_set","arguments":{"source":"# T {#t}\n\n=== note {#a}\nfirst\n===\n","id":"a","body":"=== note {#a}\nsecond\n===\n"}}}'
```

## The tools, and how they differ from `geml mcp`

| Tool | Here | `geml mcp` (stdio, a root directory) |
|---|---|---|
| `geml_list` `geml_find` `geml_get` `geml_check` `geml_to` | `source` (+ optional `name`) | `file` under `--root` |
| `geml_set` `geml_add` `geml_delete` `geml_rename` | result carries `document`, the new text | the file is written, result carries `revision` |
| `geml_history` `geml_revert` | not served — nothing is kept | served, over the `.gemlhistory` sidecar |
| `geml_codemap_*` | not served | served when the root holds a code graph |

`name` (default `document.geml`) decides how the text is read — a `.md` name
reads Markdown — and is how the document is called in messages. The write
guard is the same code as the stdio server's: a document's pre-existing errors
do not block an edit, a new error refuses it with the diagnostics, and a
refused write returns no `document`, so what you sent is still the document.

A cross-document reference such as `[[other.geml#id]]` cannot be resolved here
— there is no other document — and `geml_check` reports it as
`unresolvable-document`.

## Configuration

Both are Worker variables (`wrangler.jsonc` → `vars`, or the dashboard):

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_ORIGINS` | `http://localhost:*,http://127.0.0.1:*` | Browser origins allowed to call the endpoint (MCP requires Origin validation). `scheme://host:*` matches any port; `*` allows every origin. Clients that send no `Origin` are not gated. |
| `MAX_BODY_BYTES` | `2097152` | Request body cap; a larger document is refused with 413. |

## Limits

Cloudflare's free plan allows 10 ms of CPU per request, fixed. The reference
parser takes about 12 ms (Node, warm) on the specification itself, a 106 KB
document, so a document that size is at the edge on the free plan and needs
the paid plan (30 s default). Ordinary documents are far below it.

## Deploy

Needs a Cloudflare account and the parser built once (the Worker bundles
`geml-parser/dist/`):

```sh
cd geml-parser && npm ci && npm run build && cd ../integrations/geml-mcp-worker
npm install
npx wrangler login
npm run deploy          # prints https://geml-mcp.<your-subdomain>.workers.dev
```

Then replace `<subdomain>` here and in `geml-parser/server.json` (`remotes`),
and publish the registry entry (Actions → *Publish MCP Server*; it is a manual
workflow, so the placeholder can never be published by accident).

## Develop

```sh
npm test                # Node drives the fetch handler directly; no wrangler, no network
npm run check           # wrangler deploy --dry-run: the bundle builds, no account needed
npm run dev             # http://localhost:8787/mcp
```

`compatibility_date` is capped by the workerd your wrangler ships; move it
forward when you upgrade wrangler, not before.
