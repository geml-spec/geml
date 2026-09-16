# GEML for Obsidian

Two halves, one directory: **reading** GEML inside Obsidian, and **working** a
Markdown vault by block address from an agent.

## 1. Read — the plugin

Render [GEML](https://github.com/geml-spec/geml) inside Obsidian, using the
reference parser and the viewer's renderer (the same code path as the web
playground). Obsidian users already think in `[[wikilinks]]`, so GEML's
build-time-checked references feel native.

Two entry points:

1. **`` ```geml `` code blocks** in any note — embed a typed-block document,
   a computed table, or a `geml-chart` (inline SVG) right in your vault, with a
   diagnostics banner if a reference is broken.
2. **`.geml` files** — open one and read it rendered.

(Math and Mermaid diagrams fall back to labelled placeholders; tables,
`geml-chart`, and diagnostics — the point — render with no network.)

### Install (manual)

The reference parser must be built once, then bundle the plugin:

```sh
cd ../../geml-parser && npm install && npm run build
cd ../integrations/obsidian && npm install && npm run build   # → main.js
```

Copy `manifest.json` and `main.js` into your vault at
`.obsidian/plugins/geml/`, then enable **GEML** in *Settings → Community plugins*.

## 2. Write — the `geml-vault` skill

`skills/geml-vault/` is an agent skill for a vault that stays Markdown. Nothing
is converted: what changes is that an agent reaches a page by **block address**
instead of by line number, and writes one block instead of a file.

```sh
geml find '<literal text>' wiki --head   # → file ⇥ #address ⇥ the matching line
geml get  wiki/index.md '#entities' --body
geml set  wiki/index.md '#entities' --body --in -
```

Frontmatter and every unaddressed block come out byte-for-byte unchanged, and
callouts, wikilinks and embeds are written through verbatim — the page still
renders in Obsidian. No Obsidian process, no Local REST API, no API key.

- `skills/geml-vault/SKILL.md` — the read and write contract
- `skills/geml-vault/references/invariants.md` — what holds, and the ten things
  that bite. Read it before the first write; two of them damage a page silently.
- `skills/geml-vault/references/claude-obsidian.md` — mapping onto the
  [`claude-obsidian`](https://github.com/AgriciDaniel/claude-obsidian) vault
  convention, as one worked example

Do **not** convert a vault to `.geml`. The round trip is lossy for
Obsidian-flavoured Markdown — frontmatter lists are dropped, wikilinks and
callouts come back escaped — and Obsidian's graph, backlinks, Bases and canvas
read `.md` and nothing else. `invariants.md` has the measured table.

### The link graph

```sh
node scripts/vault-graph.mjs <vault-dir> [more-dirs…] [--json]
```

Orphan pages and dead wikilinks. Each dead link carries the **block address**
that holds it, so the fix is a `geml set` on that address rather than a hunt
through the page. Links inside code fences and inline code are not links;
frontmatter wikilinks are. Exit 1 when there is a dead link.

## Tests

```sh
npm test
```

Pins the invariants the skill rests on, including the destructive ones — a
negative test is how a footgun stays documented.

## Status

The plugin is built against the documented Obsidian plugin API; its rendering
core is shared with (and tested via) the reference viewer. Not yet submitted to
the community plugin store.

## License

MIT.
