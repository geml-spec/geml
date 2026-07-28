# GEML for LangChain and LlamaIndex

Block-level document loading for RAG, and edit tools for agents. Both frameworks
sit on `geml_core`, which has no framework dependency of its own — it shells out
to the `geml` CLI — so there is one implementation and two thin bindings.

```
pyproject.toml       makes it installable (importing the loose .py files only works from this directory)
geml_core.py         the CLI wrapper; usable on its own
geml_langchain.py    GEMLDocumentLoader + GemlAgentToolkit
geml_llamaindex.py   GEMLReader + geml_tools
test_geml_core.py    40 tests against the real CLI
proposal.geml        sample document the tests use
```

## Install

```sh
npm install -g @geml/geml            # Node 22+ — everything here calls it
pip install -e '.[langchain]'        # or '.[llamaindex]', or '.[langchain,llamaindex]'
pip install -e .                     # geml_core only, no framework
```

```sh
python3 test_geml_core.py            # 40 passed
```

## RAG: load one addressable block per chunk

```python
from geml_langchain import GEMLDocumentLoader

docs = GEMLDocumentLoader("docs/").load()     # each chunk carries its block_id
```

Block boundaries are **declared by the author**, not guessed by a splitter, so a
table arrives as one chunk instead of sliced across two, a code block keeps its
fence, and every chunk carries a stable `#id` you can cite and then read back
with `geml get` or patch with `geml set`.

Two honest limits:

- **It is not a complete chunking strategy.** Declared boundaries fix *where* to
  split, not *how long* the pieces are. A long section can still exceed your
  embedding window — run a length-aware splitter after this one and carry the
  `block_id` metadata through.
- **It only applies to documents that are already GEML.** Converting a Markdown
  corpus in (`geml notes.md`) is lossy in the other direction.

### `mode` decides whether chunks overlap

| mode | what you get | overlap |
|---|---|---|
| `"sections"` (default) | one chunk per heading, holding only its own content; subsections get their own | **none** |
| `"blocks"` | typed blocks only (tables, code, notes, diagrams) | none, but no prose |
| `"all"` | every id exactly as the CLI reports it | **heavy** |

In `"all"`, a document's h1 carries the entire file, so every section is indexed
again inside its parent. On the sample document: `sections` gives 8 chunks
totalling 2,546 chars against a 2,675-char file; `all` gives 10 chunks totalling
5,538 — **2.07× duplication**, which skews retrieval toward whatever is nested
deepest. Hence the default.

## Agents: edit one block at a time

```python
from geml_langchain import GemlAgentToolkit

tools = GemlAgentToolkit()   # geml_list_ids, read_block, write_block, revert_block, check
```

The write path is the interesting one: the replacement is **validated before it
reaches disk**, so a bad edit comes back as diagnostics with the file untouched
instead of landing and being found a week later.

```
REFUSED: error: replacement would break the document: unresolved reference `#ghost` (line 52)
  error: unresolved reference `#ghost` (line 52)
The file on disk is unchanged. Fix the body and try again.
```

That last line is deliberate — a model that is not told the write was refused
will carry on from a state that does not exist.

`commit_before_write=True` (default) snapshots the document before each write, so
`geml_revert_block` always has something to undo to.

### Undo semantics, precisely

`geml_revert_block` uses `--changed`, which walks back to the block's previous
**distinct** version, skipping revisions that never touched it. Neither offset
selector works here: because every write is snapshotted, the correct `--rev -N`
depends on how many *other* blocks were written since — a count no caller tracks.
Measured, with the write sequence `summary=GOOD, summary=BAD, oq=H1, risks=H2`:

```
--rev -1     -> BAD       wrong
--rev -2     -> GOOD      right, but only because two writes intervened
--rev 0      -> BAD       wrong (the tip is the pre-write state of the LAST write)
--changed    -> GOOD      right, and independent of the count
```

> `latest` and `current` were once accepted as aliases for the tip. They have been
> **removed**; passing either now fails with `revision selector "latest" matched 0
> revisions`. Use `0` for the tip.

What it guarantees, and what it does not:

| | |
|---|---|
| first revert | ✅ always lands on the block's previous distinct version |
| repeated reverts, no intervening write | ✅ keeps walking back |
| repeated reverts, with an intervening write | ⚠️ oscillates between the two nearest versions |
| no history at all | ✅ raises `cannot read history`, file untouched |
| block never edited | ✅ raises `no earlier revision changes \`id\``, file untouched |

So: **undo once, reliably. Not a multi-level undo stack.** Every failure is loud;
none of them corrupt the file.

## If your agent speaks MCP

Prefer the official server — same operations, no Python glue:

```sh
claude mcp add geml-docs -- geml mcp --workspace /abs/path/to/your/docs
```

This package is for the LangChain and LlamaIndex ecosystems specifically, not a
replacement for it.

## Notes for review

- The `geml` CLI must be on PATH; `Geml()` raises with the install command if not.
- These tests are not wired into CI — the repo's CI is TypeScript only. Happy to
  add a workflow if you want one.
- Not published to PyPI; this is a reference integration living in the repo.
- `geml_core.py` is the only file encoding the CLI contract. Verified against
  `@geml/geml` 1.4.2.
