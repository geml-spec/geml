# geml — Codex plugin

Author, validate, and blockwise-edit [GEML](https://github.com/geml-spec/geml)
documents from Codex. The plugin ships four things:

- **The authoring skill** (`skills/geml/`) — golden rules, validation loop,
  and a sectioned reference (`references/authoring.geml`) the agent pulls one
  topic at a time.
- **The code-graph skill** (`skills/geml-code-graph/`) — build, view, update
  and navigate a project's call graph as GEML codemap documents: who calls X,
  what X calls, impact paths, with the graph rendered in the browser.
- **The GEML MCP server** (`.mcp.json`) — registered automatically, running
  `npx -y @geml/geml mcp --root .` confined to the project directory of each
  session: `geml_get` / `geml_set` / `geml_check` and friends, so the agent
  edits one block at a time instead of rewriting files.
- **A SessionStart hook** (`hooks/hooks.json`) — a few unconditional lines
  saying the block tools exist and when NOT to reach for them. The skill loads
  by description match, which only fires once a task already sounds like GEML;
  the case worth catching is a long README in a project that has never heard
  of the format.

## Install

Inside Codex, `/plugins` opens the plugin browser: pick the marketplace tab,
open **GEML**, install.

To reach this plugin from a checkout of the repo, the marketplace source is
already committed at `.agents/plugins/marketplace.json` — start Codex in the
repo and it shows up in `/plugins`.

To add it to your own marketplace without cloning, put this in
`~/.agents/plugins/marketplace.json`:

```json
{
  "name": "geml",
  "interface": { "displayName": "GEML" },
  "plugins": [
    {
      "name": "geml",
      "source": {
        "source": "git-subdir",
        "url": "https://github.com/geml-spec/geml.git",
        "path": "./integrations/codex-plugin",
        "ref": "main"
      },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_FIRST_USE" },
      "category": "Productivity"
    }
  ]
}
```

Prefer npm? The same tools, minus the plugin packaging, plus a global `geml`
CLI:

```sh
npx -y @geml/geml skill install
```

That route writes the skill text into whatever agent tools it detects and
registers the MCP server; it touches no plugin manifest.

## Relation to the Claude Code plugin

`integrations/claude-plugin/` is the same payload for a different harness. The
two skills and the hook script are byte-identical copies of one source —
`geml-parser/skill/` for the authoring skill — and a test in
`geml-parser/test/skill-install.test.mjs` fails if any copy drifts. What
differs is only the packaging: `.codex-plugin/plugin.json` instead of
`.claude-plugin/plugin.json`, the MCP server in a separate `.mcp.json` instead
of inline, and `${PLUGIN_ROOT}` instead of `${CLAUDE_PLUGIN_ROOT}` in the hook
command.
