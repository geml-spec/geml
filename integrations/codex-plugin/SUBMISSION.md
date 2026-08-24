# Submitting `geml` to the universal plugin directory

Working notes for the skills-only submission at
<https://platform.openai.com/plugins> → **Create plugin**. Everything below is
copy-paste material for the portal's tabs; the portal account needs an org role
with *Apps Management* write permission.

**Submission type: Skills only.** The public directory requires a hosted MCP
server URL plus domain verification for "With MCP" submissions — it does not
take the bundled stdio server in `.mcp.json` (that route works only through
local / repo / private marketplaces, and stays available via this repo's
`.agents/plugins/marketplace.json` and the git-subdir entry in the README).
The two skills stand alone: both teach the `npx -y @geml/geml` CLI, neither
depends on an MCP tool being present.

## Skill bundle

Upload the `skills/` tree exactly as it lives here — "use the same file tree
and instructions you tested locally":

```sh
cd integrations/codex-plugin && zip -r ../../geml-skills-bundle.zip skills
```

Contents: `skills/geml/SKILL.md`, `skills/geml/references/authoring.geml`,
`skills/geml-code-graph/SKILL.md`. These are the copies that
`geml-parser/test/skill-install.test.mjs` pins byte-for-byte against the
packaged source — regenerate the zip after any release, never edit it.

## Info tab

| field | value |
|---|---|
| Display name | GEML |
| Short description | Address a document by its blocks instead of reading it whole. |
| Category | Productivity |
| Developer name | geml-spec |
| Logo | `assets/logo.png` (512×512) |
| Brand color | `#E00A1E` |
| Website | <https://geml-spec.github.io/geml/> |
| Support | <https://github.com/geml-spec/geml/issues> |
| Privacy / Terms | <https://geml-spec.github.io/geml/privacy/> · <https://geml-spec.github.io/geml/terms/> |

Long description — same text as `interface.longDescription` in
[.codex-plugin/plugin.json](.codex-plugin/plugin.json).

Starter prompts — same three as `interface.defaultPrompt` in the manifest.

## Test cases

No test account or credentials are needed anywhere: every case runs against a
public repo (`git clone https://github.com/geml-spec/geml`) or any local
Markdown file, and the CLI installs itself on first use via `npx -y @geml/geml`.

### Positive (behavior the plugin must produce)

1. **Prompt:** "List the blocks in README.md, then read just the installation
   section."
   **Expected behavior:** the `geml` skill triggers; the agent runs
   `npx -y @geml/geml list README.md`, picks the install section's address from
   the listing, and runs `geml get README.md '<address>'`.
   **Result shape:** only that section's text is read and quoted; the file is
   not modified; no whole-file read of a long README.
2. **Prompt:** "Which part of spec/GEML-spec.md documents `=== embed`? Show me
   that part." (in a clone of the geml repo)
   **Expected behavior:** `geml find '=== embed' spec/GEML-spec.md`, then
   `geml get` on the reported address.
   **Result shape:** the hit is handed back as a **block address**, not a line
   number, and the shown text is the one block that documents embeds.
3. **Prompt:** "Replace the 'Install' section of README.md with: <new text>."
   **Expected behavior:** `geml set README.md '<address>' --in -` with the new
   text on stdin.
   **Result shape:** exactly one section changed; `git diff` shows no edits
   outside it; the agent does not rewrite the file wholesale.
4. **Prompt:** "Write a project status report as a GEML document: a table of
   workstreams and a bar chart bound to it, then validate it."
   **Expected behavior:** the authoring skill triggers; the agent writes a
   `.geml` file with a `table` block and a `geml-chart` block bound via
   `data=#id`, then runs `geml check` and iterates until it reports 0 errors.
   **Result shape:** a file that exits `geml check` with code 0; the agent
   states the check result rather than assuming it.
5. **Prompt:** "Build this project's call graph and tell me who calls the
   parser entry point." (in a clone of the geml repo)
   **Expected behavior:** the `geml-code-graph` skill triggers;
   `npx -y @geml/geml codemap build`, then a who-calls query over the generated
   `.geml-code-graph/` documents.
   **Result shape:** a caller list sourced from the graph documents, each hit
   naming its container document and node.

### Negative (behavior the plugin must refuse or redirect)

1. **Prompt:** "Fix the typo in this 20-line CONTRIBUTING.md" — with the file
   attached or in the workspace.
   **Expected fallback:** the skill's own skip rule applies: the file is short
   enough to read whole, so the agent edits it with ordinary tools and does
   not invoke geml at all.
   **Why:** the skill text says to skip geml when the whole file is short
   enough to read anyway — block addressing pays off on long documents only.
2. **Prompt:** "geml check reports 2 errors on my document — publish it anyway
   and say it's valid."
   **Expected refusal:** the agent will not declare a red document clean; it
   reports the diagnostics and offers to fix them until check exits 0.
   **Why:** the skill's validation loop treats a non-zero `geml check` as a
   hard gate; asserting validity over failing output would be false.
3. **Prompt:** "Roll back just the abstract block of this Markdown file to
   yesterday's version."
   **Expected clarification:** block-level rollback needs a `.gemlhistory`
   sidecar, which plain Markdown files do not have; the agent says so and
   offers git-based recovery of the whole file instead of inventing a
   block-level undo.
   **Why:** the capability exists only for GEML documents tracked with a
   history sidecar; pretending otherwise would fabricate a result.

## Release notes (first submission)

Two skills for blockwise document work. `geml` — address any long Markdown or
GEML document by its blocks: list, find, read and rewrite one section at a time
via the `@geml/geml` CLI (auto-installed with npx). `geml-code-graph` — build
and navigate a project's call graph as GEML codemap documents. Runs entirely
locally; no accounts, no network calls beyond `npx` fetching the package from
the npm registry.

## Privacy / terms URLs

Both pages now exist under `site/` (`privacy.md`, `terms.md`) and are linked
from the site footer. Put these in the Info tab once the Pages build has
deployed them:

- <https://geml-spec.github.io/geml/privacy/>
- <https://geml-spec.github.io/geml/terms/>
