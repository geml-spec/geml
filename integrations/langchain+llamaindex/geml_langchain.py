"""LangChain adapters: a document loader for RAG, and an agent toolkit for editing.

    pip install langchain-core
    npm install -g @geml/geml     # Node 22+

Both sit on `geml_core`, which is framework-free — if you use neither LangChain
nor LlamaIndex, use that directly.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterator

try:
    from langchain_core.document_loaders import BaseLoader
    from langchain_core.documents import Document
    from langchain_core.tools import StructuredTool
    from pydantic import BaseModel, Field
except ModuleNotFoundError as exc:  # pragma: no cover - import-time guidance
    raise ModuleNotFoundError(
        f"{exc.name} is required by geml_langchain. Install it with:\n"
        "    pip install 'geml-integrations[langchain]'   # or: pip install langchain-core\n"
        "geml_core works on its own if you do not want a framework."
    ) from exc

from geml_core import Geml, GemlError, find_documents


# --------------------------------------------------------------------------
# RAG: loading
# --------------------------------------------------------------------------

class GEMLDocumentLoader(BaseLoader):
    """Load GEML documents one addressable block per `Document`.

    Why this beats splitting the same content as Markdown: the block boundaries
    are **declared by the author**, not guessed by a splitter. A table arrives as
    one chunk rather than sliced across two, a code block keeps its fence, and
    every chunk carries a stable `#id` you can cite and then read back with
    `geml get`, or patch with `geml set`.

    What it does NOT do — be honest about this when you pitch it:

    * It is not a complete chunking strategy. Block boundaries solve *don't split
      a structure down the middle*; they say nothing about **length**. A long
      section can still exceed your embedding window, so run a length-aware
      splitter after this one and keep the `block_id` metadata as you go.
    * It only helps for documents that are already GEML. Converting a Markdown
      corpus in (`geml notes.md`) is lossy in the other direction.

    Args:
        path: a `.geml` file, or a directory to walk.
        glob: pattern used when `path` is a directory.
        mode: ``"sections"`` (default) gives one non-overlapping chunk per
            heading; ``"blocks"`` gives typed blocks only; ``"all"`` gives every
            id as the CLI reports it, which **overlaps** — a heading carries its
            whole section, so parents repeat their children. See `Geml.blocks`.
        validate: run `geml check` per document and raise on a broken reference.
            Off by default — a stale corpus shouldn't stop indexing.
    """

    def __init__(
        self,
        path: str | Path,
        *,
        glob: str = "**/*.geml",
        mode: str = "sections",
        validate: bool = False,
        binary: str = "geml",
    ):
        self.path = Path(path)
        self.glob = glob
        self.mode = mode
        self.validate = validate
        self.geml = Geml(binary)

    def lazy_load(self) -> Iterator[Document]:
        paths = [self.path] if self.path.is_file() else list(find_documents(self.path, self.glob))
        for doc_path in paths:
            if self.validate:
                diagnostics = self.geml.check(doc_path)
                errors = [d for d in diagnostics if d.get("severity") == "error"]
                if errors:
                    raise GemlError(f"{doc_path}: {errors[0]['message']}", diagnostics)
            for block in self.geml.blocks(doc_path, mode=self.mode):
                text = block.text.strip()
                if text:
                    yield Document(page_content=text, metadata=block.metadata())


# --------------------------------------------------------------------------
# Agents: editing
# --------------------------------------------------------------------------

class _ReadArgs(BaseModel):
    file: str = Field(description="Path to the .geml document")
    block_id: str = Field(description="Block id, with or without the leading '#'")


class _ListArgs(BaseModel):
    file: str = Field(description="Path to the .geml document")


class _WriteArgs(BaseModel):
    file: str = Field(description="Path to the .geml document")
    block_id: str = Field(description="Block id to replace, with or without '#'")
    body: str = Field(description="The replacement text for that block")
    part: str = Field(
        default="whole",
        description="What to replace: 'whole' (default), 'head' (the fence/heading line), or 'body'",
    )


class _RevertArgs(BaseModel):
    file: str = Field(description="Path to the .geml document")
    block_id: str = Field(description="Block id to roll back, with or without '#'")


def GemlAgentToolkit(
    *, binary: str = "geml", commit_before_write: bool = True
) -> list[StructuredTool]:
    """Tools that let an agent edit a document one block at a time.

    The write path is the point: a replacement is validated *before* it reaches
    disk, so a bad edit comes back as diagnostics with the file untouched,
    rather than landing and being discovered a week later.

    With `commit_before_write` (default), every write snapshots the document
    first, so `geml_revert` always has a revision to roll back to.

    If your agent speaks MCP, prefer the official server instead — same
    operations, no Python glue:

        claude mcp add geml-docs -- geml mcp --workspace /path/to/docs
    """
    geml = Geml(binary)

    def _list_ids(file: str) -> str:
        entries = geml.list_ids(file)
        return "\n".join(
            f"#{e['id']}  {e.get('kind', '')}  {e.get('type') or e.get('text', '')}".rstrip()
            for e in entries
        ) or "(no addressable ids)"

    def _read_block(file: str, block_id: str) -> str:
        return geml.read_block(file, block_id)

    def _write_block(file: str, block_id: str, body: str, part: str = "whole") -> str:
        if commit_before_write:
            try:
                geml.history_commit(file, f"before write to #{block_id.lstrip('#')}")
            except GemlError:
                pass  # a missing sidecar must not block the edit
        try:
            geml.write_block(file, block_id, body, part)
        except GemlError as exc:
            # Tell the model plainly that nothing changed, or it will assume the
            # write landed and carry on from a state that does not exist.
            lines = [f"REFUSED: {exc}"]
            for d in exc.diagnostics:
                lines.append(f"  {d.get('severity')}: {d.get('message')} (line {d.get('line')})")
            lines.append("The file on disk is unchanged. Fix the body and try again.")
            return "\n".join(lines)
        return f"Wrote #{block_id.lstrip('#')}. Every other byte of {file} is unchanged."

    def _revert_block(file: str, block_id: str) -> str:
        # `changed=True` is the only selector that means "undo my edit to THIS
        # block": it skips revisions that never touched it. Both offset
        # selectors silently no-op once another block has been written in
        # between, which in an agent loop is the normal case, not the corner.
        try:
            return geml.revert_block(file, block_id, changed=True)
        except GemlError as exc:
            return f"Could not revert: {exc}"

    def _check(file: str) -> str:
        diagnostics = geml.check(file)
        if not diagnostics:
            return "ok: no diagnostics"
        return "\n".join(
            f"{d.get('severity')}: {d.get('message')} (line {d.get('line')})" for d in diagnostics
        )

    return [
        StructuredTool.from_function(
            func=_list_ids,
            name="geml_list",
            description=(
                "List every addressable block id in a GEML document. Call this first — "
                "the ids are how you read or edit one part of the document without touching the rest."
            ),
            args_schema=_ListArgs,
        ),
        StructuredTool.from_function(
            func=_read_block,
            name="geml_get",
            description=(
                "Read ONE block by its '#id'. Use this instead of reading the whole file: it "
                "returns only that block, typically a few percent of the document. Reading the "
                "whole file to change one block wastes context and risks changing unrelated content."
            ),
            args_schema=_ReadArgs,
        ),
        StructuredTool.from_function(
            func=_write_block,
            name="geml_set",
            description=(
                "Replace ONE block by its '#id', leaving every other byte untouched. Prefer this "
                "over rewriting a file. The replacement is VALIDATED BEFORE it is written: if it "
                "would break the document, nothing is written and you get the diagnostics back — "
                "read them and fix the body rather than retrying the same content."
            ),
            args_schema=_WriteArgs,
        ),
        StructuredTool.from_function(
            func=_revert_block,
            name="geml_revert",
            description=(
                "Roll back ONE block to its previous revision, leaving the rest of the document "
                "alone. Use this when you have written a block you are not happy with — it undoes "
                "only your block, so concurrent edits elsewhere in the file survive."
            ),
            args_schema=_RevertArgs,
        ),
        StructuredTool.from_function(
            func=_check,
            name="geml_check",
            description=(
                "Validate a GEML document and return its diagnostics. An unresolved reference is "
                "an error, not a warning. Note this checks structure, not whether the prose is any good."
            ),
            args_schema=_ListArgs,
        ),
    ]
