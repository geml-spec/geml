"""Thin subprocess wrapper over the `geml` CLI. No framework dependencies.

Both the LangChain and LlamaIndex adapters sit on top of this, so the behaviour
they expose is identical and there is exactly one place where the CLI contract
lives. Requires `npm install -g @geml/geml` (Node 22+) on PATH.

Verified against @geml/geml 1.8.4 (history commit/log became save/get in 1.6.0; the no-selector listing gained anonymous rows in 1.7.3). If the CLI's JSON shapes change, this file
is what needs updating; test_geml_core.py (41 checks, no framework deps) is the
contract test — run it against a new CLI before trusting the adapters.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


class GemlError(RuntimeError):
    """A `geml` invocation failed. `diagnostics` is populated when the CLI
    returned structured ones (validation failures), empty otherwise."""

    def __init__(self, message: str, diagnostics: list[dict] | None = None):
        super().__init__(message)
        self.diagnostics = diagnostics or []


@dataclass(frozen=True)
class Block:
    """One addressable block of a GEML document."""

    id: str
    kind: str           # "heading" | "block"
    text: str           # the block's source, verbatim
    type: str | None = None      # for kind="block": table, code, note, diagram, ...
    level: int | None = None     # for kind="heading"
    title: str | None = None     # heading text, or a block's caption
    source: str = ""

    def metadata(self) -> dict[str, Any]:
        """Flat, JSON-serialisable metadata for a vector store record."""
        md = {"source": self.source, "block_id": self.id, "kind": self.kind}
        for key, value in (("type", self.type), ("level", self.level), ("title", self.title)):
            if value is not None:
                md[key] = value
        return md


class Geml:
    """Calls the `geml` binary. One instance per document root."""

    def __init__(self, binary: str = "geml"):
        # Store the RESOLVED path, not the bare name. On Windows npm installs the
        # CLI as a `geml.cmd` shim: shutil.which() finds it (it honours PATHEXT),
        # but subprocess/CreateProcess does not do that resolution itself, so
        # passing the bare "geml" fails with WinError 2. which() returns the full
        # path on every platform, which CreateProcess and execvp both accept.
        resolved = shutil.which(binary)
        if resolved is None:
            raise GemlError(
                f"`{binary}` not found on PATH. Install it with: npm install -g @geml/geml "
                "(needs Node 22+)."
            )
        self.binary = resolved

    # ---- plumbing -------------------------------------------------------

    def _run(self, args: list[str], stdin: str | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [self.binary, *args],
            input=stdin,
            capture_output=True,
            text=True,
            check=False,
        )

    @staticmethod
    def _hash(block_id: str) -> str:
        return block_id if block_id.startswith("#") else f"#{block_id}"

    # ---- read -----------------------------------------------------------

    def list_ids(self, path: str | Path) -> list[dict[str, Any]]:
        """Every addressable id in the document, with its kind and title.

        Exactly what the name says: rows that HAVE an id. Since 1.7.3 the CLI's
        listing also includes anonymous blocks (``=== meta``, ``@hex`` content
        addresses) as rows with an ``address`` and no ``id`` key — every caller
        of this method formats ``e["id"]``, so those rows live in
        :meth:`list_blocks` instead of crashing this one.
        """
        return [e for e in self.list_blocks(path) if "id" in e]

    def list_blocks(self, path: str | Path) -> list[dict[str, Any]]:
        """The full listing, anonymous blocks included. Each row carries an
        ``address`` (paste it into ``geml get`` verbatim); id-bearing rows also
        carry ``id``/``kind``/``text``."""
        proc = self._run(["list", str(path), "--json"])
        if proc.returncode != 0:
            raise GemlError(proc.stderr.strip() or f"geml list {path} failed")
        return json.loads(proc.stdout)

    def read_block(self, path: str | Path, block_id: str) -> str:
        """One block's source, verbatim. A heading id yields its whole section."""
        proc = self._run(["get", str(path), self._hash(block_id)])
        if proc.returncode != 0:
            raise GemlError(proc.stderr.strip() or f"no block `{block_id}` in {path}")
        return proc.stdout

    def read_block_json(self, path: str | Path, block_id: str) -> dict[str, Any]:
        """One block as a model node — for a table or a `view` this includes the
        parsed columns, and for a view the derived ones *already resolved*
        (GEP-0012: a table holds facts, a view computes over one). That is why
        binding a chart to a relation by id keeps the numbers from drifting."""
        proc = self._run(["get", str(path), self._hash(block_id), "--json"])
        if proc.returncode != 0:
            raise GemlError(proc.stderr.strip() or f"no block `{block_id}` in {path}")
        return json.loads(proc.stdout)

    def check(self, path: str | Path, root: str | Path | None = None) -> list[dict[str, Any]]:
        """Diagnostics for the document; empty list means it is valid.
        `root` widens cross-document reference checking to that directory."""
        args = ["check", str(path), "--json"]
        if root is not None:
            args += ["--root", str(root)]
        proc = self._run(args)
        if proc.stdout.strip():
            return json.loads(proc.stdout)
        if proc.returncode != 0:
            raise GemlError(proc.stderr.strip() or f"geml check {path} failed")
        return []

    def blocks(self, path: str | Path, mode: str = "sections") -> list[Block]:
        """The document's blocks, in document order.

        `mode` decides what a chunk is — and, critically, whether chunks OVERLAP:

        * ``"sections"`` (default) — one chunk per heading, holding that
          heading's *own* content: the prose and typed blocks directly under it,
          with nested subsections excluded because they get their own chunks.
          **Non-overlapping**, and covers the whole document. This is what you
          want for a retrieval index.
        * ``"blocks"`` — typed blocks only (tables, code, notes, diagrams), no
          prose. Useful when you want to index data separately from narrative.
        * ``"all"`` — every addressable id exactly as the CLI reports it. Each
          heading yields its *whole* section, so a document's h1 contains the
          entire file and every nested section appears again inside its parent.
          **Chunks overlap heavily** — only use this if you know you want that;
          feeding it to a vector store will index the same prose several times
          and skew retrieval toward whatever is nested deepest.
        """
        if mode not in ("sections", "blocks", "all"):
            raise ValueError(f"mode must be sections|blocks|all, got {mode!r}")

        source = str(path)
        entries = self.list_ids(path)

        def build(entry: dict, text: str) -> Block:
            return Block(
                id=entry["id"],
                kind=entry.get("kind", "block"),
                text=text,
                type=entry.get("type"),
                level=entry.get("level"),
                title=entry.get("text") or entry.get("caption"),
                source=source,
            )

        if mode == "all":
            return [build(e, self.read_block(path, e["id"])) for e in entries]

        if mode == "blocks":
            return [
                build(e, self.read_block(path, e["id"]))
                for e in entries
                if e.get("kind") != "heading"
            ]

        # sections: trim each heading's section at the point its first nested
        # subsection begins, so parent and child never carry the same text.
        headings = [e for e in entries if e.get("kind") == "heading"]
        if not headings:
            # No headings at all — fall back to typed blocks so nothing is lost.
            return [build(e, self.read_block(path, e["id"])) for e in entries]

        out: list[Block] = []
        for index, entry in enumerate(headings):
            text = self.read_block(path, entry["id"])
            nxt = headings[index + 1] if index + 1 < len(headings) else None
            if nxt and (nxt.get("level") or 0) > (entry.get("level") or 0):
                child_head = self.read_block(path, nxt["id"]).splitlines()[0]
                head, sep, _ = text.partition(child_head)
                if sep:
                    text = head
            out.append(build(entry, text))
        return out

    # ---- write ----------------------------------------------------------

    def write_block(
        self, path: str | Path, block_id: str, body: str, part: str = "whole"
    ) -> None:
        """Replace ONE block, leaving every other byte untouched.

        The replacement is validated *before* it is written: if it would break
        the document, nothing is written and GemlError carries the diagnostics.
        """
        if part not in ("whole", "head", "body"):
            raise ValueError(f"part must be whole|head|body, got {part!r}")
        flag = {"head": ["--head"], "body": ["--body"], "whole": []}[part]
        proc = self._run(
            ["set", str(path), self._hash(block_id), *flag, "--in", "-"], stdin=body
        )
        if proc.returncode != 0:
            message = proc.stderr.strip()
            raise GemlError(
                f"{message} (the file on disk is unchanged)",
                diagnostics=self._diagnostics_after_failure(path),
            )

    def revert_block(
        self,
        path: str | Path,
        block_id: str,
        rev: str | None = None,
        changed: bool = False,
    ) -> str:
        """Roll back ONE block to a past revision, leaving the rest of the file
        alone — a granularity file-level version control cannot express.

        Needs a prior snapshot; the CLI does NOT snapshot on write (the
        `geml mcp` server does). `GemlAgentToolkit` snapshots for you.

        **For block-level undo, pass `changed=True`** (`--rev changed`). It walks
        the history newest-to-oldest and lands on this block's previous *distinct*
        version, skipping revisions that never touched it. That is what "undo my
        edit to this block" actually means, and no offset selector gets it
        right once any other write has intervened:

            write #summary GOOD -> write #summary BAD -> write #open-questions
            --rev -1        -> no-op (that revision already has BAD)
            --rev 0         -> no-op (same; 0 is the tip)
            --rev changed   -> GOOD          <- correct

        Caveat: repeated `--rev changed` reverts oscillate between the two nearest
        distinct versions rather than walking further back. It is "undo once",
        not "keep undoing".

        `rev` selects an explicit revision instead: `0` (the tip), `-N`, or an id
        prefix. Omitting both gets the CLI default of `-1`. Offsets count back
        from the newest *snapshot*, not the working file, the way git numbers
        commits — `0` is `HEAD`, `-1` is `HEAD~1`, and the working file is not in
        the numbering at all.

        `changed` and `rev` both choose the SAME thing (the target revision), so
        passing both is contradictory and raises rather than silently favouring
        one — `changed` is the `--rev` *value* `changed`, not a separate flag.
        """
        if changed and rev:
            raise ValueError("pass either `changed=True` or `rev=...`, not both — both select the target revision")
        sel = "changed" if changed else rev
        flags = ["--rev", sel] if sel else []
        proc = self._run(["revert", str(path), self._hash(block_id), *flags])
        # The CLI reports revert status on stderr, not stdout.
        message = (proc.stderr or proc.stdout).strip()
        if proc.returncode != 0:
            raise GemlError(message or f"could not revert `{block_id}`")
        return message

    def history_commit(self, path: str | Path, message: str = "") -> str:
        """Snapshot the document into its `.gemlhistory` sidecar.

        Call this *before* letting an agent write, or there will be nothing for
        `revert_block` to roll back to. `GemlAgentToolkit` does it for you.
        """
        args = ["history", "save", str(path)]
        if message:
            args += ["-m", message]
        proc = self._run(args)
        if proc.returncode != 0:
            raise GemlError(proc.stderr.strip() or f"history commit failed for {path}")
        return proc.stdout.strip()

    def history_log(self, path: str | Path) -> str:
        proc = self._run(["history", "get", str(path)])
        if proc.returncode != 0:
            raise GemlError(proc.stderr.strip() or f"history log failed for {path}")
        return proc.stdout.strip()

    # ---- helpers --------------------------------------------------------

    def _diagnostics_after_failure(self, path: str | Path) -> list[dict[str, Any]]:
        try:
            return self.check(path)
        except GemlError:
            return []


def find_documents(root: str | Path, pattern: str = "**/*.geml") -> Iterable[Path]:
    """Every GEML document under `root`, excluding `.gemlhistory` sidecars."""
    return (p for p in sorted(Path(root).glob(pattern)) if p.suffix == ".geml")
