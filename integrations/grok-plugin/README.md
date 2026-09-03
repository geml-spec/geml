# geml — Grok plugin

Author, validate, and blockwise-edit [GEML](https://github.com/geml-spec/geml)
documents from Grok. The plugin ships three things:

- **The authoring skill** (`skills/geml/`) — golden rules, validation loop,
  and a sectioned reference (`references/authoring.geml`) the agent pulls one
  topic at a time.
- **The code-graph skill** (`skills/geml-code-graph/`) — build, view, update
  and navigate a project's call graph as GEML codemap documents.
- **The GEML MCP server** (`.mcp.json`) — `npx -y @geml/geml mcp --root .`,
  confined to the project directory of each session: `geml_get` / `geml_set` /
  `geml_check` and friends, so the agent edits one block at a time instead of
  rewriting files.

No SessionStart hook, unlike the Claude and Codex plugins: this harness's hook
contract has not been verified here, and a hook that silently never fires is
worse than none. The skills stand alone — both teach the `npx -y @geml/geml`
CLI and neither depends on an MCP tool being present.

## Status

**Not submitted yet.** The marketplace is a repository, so listing means a pull
request against [xai-org/plugin-marketplace](https://github.com/xai-org/plugin-marketplace);
[SUBMISSION.md](SUBMISSION.md) is the working note for it, and
[marketplace-entry.json](marketplace-entry.json) is the catalog entry to paste.

Until it is merged, install this directory as a local plugin — the same files,
fetched by hand:

```sh
git clone https://github.com/geml-spec/geml
# then point Grok's plugin loader at geml/integrations/grok-plugin
```

The skill copies here are pinned byte-for-byte against the packaged source by
`geml-parser/test/skill-install.test.mjs` — never edit them in place; edit
`geml-parser/skill/` and re-copy.
