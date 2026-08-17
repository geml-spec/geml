# geml — Claude Code plugin

Author, validate, and blockwise-edit [GEML](https://github.com/geml-spec/geml)
documents from Claude Code. The plugin ships three things:

- **The authoring skill** (`skills/geml/`) — golden rules, validation loop,
  and a sectioned reference (`references/authoring.geml`) Claude pulls one
  topic at a time.
- **The code-graph skill** (`skills/geml-code-graph/`) — build, view, update
  and navigate a project's call graph as GEML codemap documents: who calls X,
  what X calls, impact paths, with the graph rendered in the browser.
- **The GEML MCP server** — registered automatically, running
  `npx -y @geml/geml mcp --root .` confined to the project directory of each
  session: `geml_get` / `geml_set` / `geml_check` and friends, so the agent
  edits one block at a time instead of rewriting files.

## Install

```sh
claude plugin marketplace add geml-spec/geml
```

then `/plugin install geml@geml` inside Claude Code.

Prefer npm? The same setup in one shot, plus a global `geml` CLI:

```sh
npx -y @geml/geml skill install
```

Neither route touches `settings.json` or installs hooks.
