"""LlamaIndex adapters: a block-level reader, and the same edit tools.

    pip install llama-index-core
    npm install -g @geml/geml     # Node 22+

Same behaviour as the LangChain adapters — both are thin shells over
`geml_core`, so there is one implementation and two bindings.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

try:
    from llama_index.core.readers.base import BaseReader
    from llama_index.core.schema import Document
    from llama_index.core.tools import FunctionTool
except ModuleNotFoundError as exc:  # pragma: no cover - import-time guidance
    raise ModuleNotFoundError(
        f"{exc.name} is required by geml_llamaindex. Install it with:\n"
        "    pip install 'geml-integrations[llamaindex]'   # or: pip install llama-index-core\n"
        "geml_core works on its own if you do not want a framework."
    ) from exc

from geml_core import Geml, GemlError, find_documents


class GEMLReader(BaseReader):
    """Read GEML documents one addressable block per `Document`.

    Block boundaries are declared by the author, so a table is never sliced down
    the middle and every node keeps a stable `#id` you can cite and read back.

    This is not a complete chunking strategy: it fixes *where* to split, not
    *how long* the pieces are. Run a length-aware splitter after it and carry
    the `block_id` metadata through. It also only applies to documents that are
    already GEML.

    `mode` is "sections" (default, non-overlapping), "blocks" (typed blocks
    only), or "all" (every id as the CLI reports it, which OVERLAPS — a heading
    carries its whole section). See `Geml.blocks`.
    """

    def __init__(
        self,
        *,
        mode: str = "sections",
        validate: bool = False,
        binary: str = "geml",
    ):
        super().__init__()
        self.mode = mode
        self.validate = validate
        self.geml = Geml(binary)

    def load_data(self, file: str | Path, extra_info: dict[str, Any] | None = None) -> list[Document]:
        path = Path(file)
        paths = [path] if path.is_file() else list(find_documents(path))
        documents: list[Document] = []
        for doc_path in paths:
            if self.validate:
                errors = [d for d in self.geml.check(doc_path) if d.get("severity") == "error"]
                if errors:
                    raise GemlError(f"{doc_path}: {errors[0]['message']}", errors)
            for block in self.geml.blocks(doc_path, mode=self.mode):
                text = block.text.strip()
                if not text:
                    continue
                metadata = {**block.metadata(), **(extra_info or {})}
                documents.append(Document(text=text, metadata=metadata))
        return documents


def geml_tools(*, binary: str = "geml", commit_before_write: bool = True) -> list[FunctionTool]:
    """Edit tools for a LlamaIndex agent. See `geml_langchain.GemlAgentToolkit`
    for the rationale; the tool descriptions are deliberately identical.

    If your agent speaks MCP, prefer the official server:

        claude mcp add geml-docs -- geml mcp --workspace /path/to/docs
    """
    geml = Geml(binary)

    def geml_list(file: str) -> str:
        """List every addressable block id in a GEML document. Call this first —
        the ids are how you read or edit one part without touching the rest."""
        entries = geml.list_ids(file)
        return "\n".join(
            f"#{e['id']}  {e.get('kind', '')}  {e.get('type') or e.get('text', '')}".rstrip()
            for e in entries
        ) or "(no addressable ids)"

    def geml_get(file: str, block_id: str) -> str:
        """Read ONE block by its '#id'. Use this instead of reading the whole
        file: it returns only that block, typically a few percent of the
        document. Reading the whole file to change one block wastes context and
        risks changing unrelated content."""
        return geml.read_block(file, block_id)

    def geml_set(file: str, block_id: str, body: str, part: str = "whole") -> str:
        """Replace ONE block by its '#id', leaving every other byte untouched.
        The replacement is VALIDATED BEFORE it is written: if it would break the
        document, nothing is written and you get the diagnostics back — read them
        and fix the body rather than retrying the same content."""
        if commit_before_write:
            try:
                geml.history_commit(file, f"before write to #{block_id.lstrip('#')}")
            except GemlError:
                pass
        try:
            geml.write_block(file, block_id, body, part)
        except GemlError as exc:
            lines = [f"REFUSED: {exc}"]
            for d in exc.diagnostics:
                lines.append(f"  {d.get('severity')}: {d.get('message')} (line {d.get('line')})")
            lines.append("The file on disk is unchanged. Fix the body and try again.")
            return "\n".join(lines)
        return f"Wrote #{block_id.lstrip('#')}. Every other byte of {file} is unchanged."

    def geml_revert(file: str, block_id: str) -> str:
        """Roll back ONE block to its previous revision, leaving the rest of the
        document alone. Use this when you have written a block you are not happy
        with — concurrent edits elsewhere in the file survive."""
        try:
            return geml.revert_block(file, block_id, changed=True)
        except GemlError as exc:
            return f"Could not revert: {exc}"

    def geml_check(file: str) -> str:
        """Validate a GEML document and return its diagnostics. An unresolved
        reference is an error, not a warning. Checks structure, not prose quality."""
        diagnostics = geml.check(file)
        if not diagnostics:
            return "ok: no diagnostics"
        return "\n".join(
            f"{d.get('severity')}: {d.get('message')} (line {d.get('line')})" for d in diagnostics
        )

    return [
        FunctionTool.from_defaults(fn=fn)
        for fn in (geml_list, geml_get, geml_set, geml_revert, geml_check)
    ]
