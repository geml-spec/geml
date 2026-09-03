# Submitting `geml` to the Grok plugin marketplace

The marketplace is a git repository, not a portal:
[xai-org/plugin-marketplace](https://github.com/xai-org/plugin-marketplace).
Listing a third-party plugin is a pull request that CI validates and a code
owner reviews.

## Route: local vendored, not remote source

xAI takes third-party plugins two ways. We want the **local** one:

- **`{"type": "local", "path": "./external_plugins/geml"}`** — the PR carries
  a copy of this directory. What we submit is exactly what was tested.
- `{"source": "url", "url": "...", "sha": "<40 hex>"}` — the marketplace fetches
  our repo instead, and then looks for plugin components (`.mcp.json`,
  `skills/`) at the **repository root**. This repo is a monorepo: its root has
  no `.mcp.json`, and adding one would also hijack the dev loop of anyone
  working *in* this repo — their agent would launch the published `npx` server
  instead of the local build under `geml-parser/dist/`. The remote route also
  pins a full 40-character commit SHA, so every release needs a follow-up PR.

## The pull request

1. Copy this directory in, minus the two working notes:

   ```sh
   # from a clone of xai-org/plugin-marketplace, with $GEML pointing at this repo
   mkdir -p external_plugins/geml
   cp -r "$GEML/integrations/grok-plugin/." external_plugins/geml/
   rm external_plugins/geml/SUBMISSION.md external_plugins/geml/marketplace-entry.json
   ```

2. Append the object in [marketplace-entry.json](marketplace-entry.json) to the
   `plugins` array of `.grok-plugin/marketplace.json`.

3. Run their validator and read its output, not just its exit code:

   ```sh
   python3 scripts/validate-catalog.py
   ```

4. Open the PR. CI runs the same validator; a code owner has to approve.

## What the reviewer will see

| field | value |
|---|---|
| Plugin id | `geml` |
| Category | `development` |
| Ships | 2 skills + 1 stdio MCP server (`npx -y @geml/geml mcp --root .`) |
| Credentials needed | none — no account, no API key, no hosted endpoint |
| Network | `npx` fetching `@geml/geml` from the npm registry |
| License | MIT |

## After a merge

The version in [.grok-plugin/plugin.json](.grok-plugin/plugin.json) is pinned to
the parser's by `geml-parser/test/mcp.test.mjs`, so a release bumps it here too.
Whether users of the merged listing ever see that bump is unverified — the
catalog vendors a copy of these files, so assume a follow-up PR is needed and
check before promising an update reached anyone.
