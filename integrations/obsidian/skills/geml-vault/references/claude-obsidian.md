# Adapter: the `claude-obsidian` vault

[`claude-obsidian`](https://github.com/AgriciDaniel/claude-obsidian) is a Claude
Code plugin that sets up an Obsidian vault on Karpathy's LLM-Wiki pattern. This
page maps the core skill onto its conventions. Nothing here is required by the
core skill — any Markdown vault works; this one is written out because it is the
one the tests were measured against (v1.6.0).

## Layout

```
.raw/        source documents, immutable — dot-prefixed to stay out of
             Obsidian's file explorer and graph, which also means the
             directory walk SKIPS it. Name it explicitly.
wiki/        the generated knowledge base
CLAUDE.md    schema and instructions
```

```sh
geml find 'needle' wiki .raw --head       # both, or you search half the vault
```

## Where the addresses are

`wiki/index.md` is the file this skill pays for: it grows with the page count
and is touched on every ingest. Its blocks are stable:

| address | holds |
|---|---|
| `#concepts` `#entities` `#sources` | the catalogue lists |
| `#questions` `#comparisons` `#decisions` `#domains` | the rest of the catalogue |

Filing a new entity is one command, with nothing read first:

```sh
geml get wiki/index.md '#entities' --body > /tmp/e && \
  printf -- '- [[New Thing]] — one line (status: seed)\n' >> /tmp/e && \
  geml set wiki/index.md '#entities' --body --in - < /tmp/e
```

`wiki/log.md` is append-only and never shrinks — `geml add wiki/log.md --append
--in -`. `wiki/hot.md` is a ~500-word cache the plugin overwrites wholesale;
leave that one alone, whole-file replacement is correct for it.

## Frontmatter is read-only

Every page carries `type` / `title` / `updated` / `tags` / `status` / `related`.
`tags` and `related` are YAML **lists**, and `related` entries are wikilinks
that Obsidian resolves into real graph edges. None of it can be edited through
this skill — see invariant 1. Let the plugin's own templates write it.

## What to replace in the plugin's skills

| its step | replace with |
|---|---|
| `wiki-ingest`: "read 3-5 existing pages per ingest" | `geml find` to locate, `geml get` to read the section that matters |
| `wiki-ingest`: update `index.md` after filing | `geml set wiki/index.md '#<section>'` |
| `wiki-query`: find which page answers a question | `geml find … --head` over `wiki` and `.raw` |
| `wiki-lint`: orphans and dead links | `scripts/vault-graph.mjs` |
| `wiki/references/rest-api.md`: `PATCH` for surgical edits | `geml set` — same surgery, no Obsidian process, no API key |

That last row is the point. The plugin's own instruction is "use PATCH for
surgical edits, never re-read an entire file to update one field"
(`skills/wiki-ingest/SKILL.md:148`) — correct advice that until now required the
Local REST API plugin running on port 27124 with a key. The block path does it
offline.

## One file you must not touch

`.vault-meta/address-counter.txt` is mutated **only** by
`scripts/allocate-address.sh`. The plugin's own skill spells out why
(`skills/wiki-ingest/SKILL.md:226`): a `Write` or `Edit` there fires a
PostToolUse hook that runs `git add wiki/ .raw/`, which can sweep unrelated
pending changes into a commit with a generic message. `geml set` is a tool write
like any other — the same hook, the same risk. Use the script.

## Do not turn on block history here

The plugin already versions the whole vault through that git hook. Adding
`.gemlhistory` sidecars on top gives you a second, partial history and one extra
file per edited page inside a directory Obsidian syncs. Redundant. Leave it off.
