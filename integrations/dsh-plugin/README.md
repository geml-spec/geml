# @geml/dsh-plugin — GEML for DeepSeek Harness

English | [中文](README.zh.md)

This plugin brings **Agent-Native** document handling to the harness. Multi-turn
work drowns in token bloat — whole files read in, whole files written back,
content growing verbose and drifting from the truth.
[GEML](https://github.com/geml-spec/geml) exposes a document as **addressable
blocks** an LLM can reason about and edit precisely: one section in, one section
back, at a fraction of the tokens, leaving the context window for the actual
work. A built-in **reference** mechanism keeps a **single source of truth**, so
facts stop fragmenting across copies and an agent maintains docs at zero
overhead.

The bundle ships three things:

- **The GEML MCP server** — one `@deepseek-ai/dsh-mcp-client` row running
  `npx -y @geml/geml mcp --root .`, confined to the session's project
  directory. The model sees `mcp__geml__geml_get`, `mcp__geml__geml_set`,
  `mcp__geml__geml_check` and friends, so it edits one block at a time instead
  of rewriting files.
- **The authoring skill** (`skills/geml/`) — golden rules, validation loop, and
  a sectioned reference (`references/authoring.geml`) the agent pulls one topic
  at a time.
- **The code-graph skill** (`skills/geml-code-graph/`) — build, view, update and
  navigate a project's call graph: who calls X, what X calls, impact paths, with
  the graph rendered in the browser.

The bundle carries no code of its own — both plugins it configures ship inside
the dsh installation, and the skills are Markdown. Nothing is built at install
time, so no `allowBuilds` approval is involved either way.

## Install

```sh
dsh plugin --profile web add @geml/dsh-plugin
```

Verify the layer without booting, then boot:

```sh
dsh --profile web --dump-config   # shows a "# == @geml/dsh-plugin" layer
dsh --profile web
```

`dsh plugin --profile web remove @geml/dsh-plugin` removes both the
dependency and the layer.

## Configuration

Both rows are ordinary configuration: override them by `id` in your profile's
`cordis.patch.yml`, restating every key the row needs. Point `mcp-geml` at a
pinned CLI version, for instance:

```yaml
- id: mcp-geml
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: geml
    transport: stdio
    command: npx
    args: ['-y', '@geml/geml', 'mcp', '--root', '.']
```

A global `geml` on PATH works as well — `command: geml`, dropping the `npx`
arguments.

The CLI and the same skills for Claude Code instead: `npx -y @geml/geml skill
install`, or the plugin under [`../claude-plugin`](../claude-plugin).
