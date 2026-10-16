---
name: gemflow-mcp
description: >-
  Work inside a project's Gemflow workflow through the gemflow MCP server
  (tools status, move, set). Use when those tools are connected or the
  project has .geml/gemflow.geml: read the current stage before acting, let
  status read PR, CI and file evidence, and move the workflow only along its
  transitions.
---

# Gemflow over MCP

A project's workflow lives in `.geml/workflows/<name>/flow.geml`: one
`diagram {format=geml-statechart}` block. The stage it is in, and what that
stage asks of you, is in `.geml/context.geml` — the `text {#current}` block.

**Every turn, before anything else, read the stage** — call `status`, or run
`geml get .geml/context.geml '#current'`. Your host has no channel that hands
it to you. (In Claude Code the Gemflow plugin delivers it itself, and so do
the plugin's hooks on Codex once a person has trusted them; there you
need not read it.)

- `status` says where the workflow stands: the work item (usually the branch), the state, every variable with where it reads from, each transition out with whether its guard holds, and the stage text. It reads git, gh and the file variables afresh before it answers, so call it after you push, open a PR or write what the stage needs.
- A variable with a source (`tool:<use>`, `file:<glob>`, `git:<fact>`, `human`) is evidence: not yours to `set`. Over MCP this host shows Gemflow no tool calls, so `tool` evidence (a test run's or a deploy's exit status) is never written here and nothing is refused: tell the person what you ran and what it printed, so they can tick a `human` variable the guard accepts, or approve the transition. (Codex with the plugin's hooks trusted is the exception: there a call is judged and its exit status recorded as on Claude Code, and a line `[gemflow exit N]` at the end of a command's output is that record, not something to act on.)
- `move` takes a transition whose guard is a sentence you judge, or one with no guard. A machine-judged transition is taken on its own when its guard holds; one that needs a person is theirs — ask them to approve it on the Gemflow board or with `gemflow advance <state>` in their own terminal. A guard holds for a person's `gemflow advance` just as it does for you.
- `set` records the variables without a source, by name; a value of the wrong type writes nothing.
- `gemflow mark`, `gemflow unmark` and `gemflow advance` are a person's commands. Never run them yourself: over MCP nothing refuses them, and the journal would credit a person with it.
- The tool dictionary `tools.geml` beside the workflow binds each use a state declares to this project's tools, and a use is usable only in the states that declare it. Over MCP nothing refuses a tool for you: check the stage with `status` before you run one the stage does not list.

Registering the server (stdio), in the host's MCP configuration:

```text
command: npx
args:    -y @geml/gemflow mcp --host <host>
```
