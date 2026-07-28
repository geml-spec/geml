"""Tests for geml_core against the real CLI. No framework deps needed.

    npm install -g @geml/geml
    python3 test_geml_core.py
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

from geml_core import Geml, GemlError, find_documents

# The sample document ships next to this file; fall back to the outreach repo
# layout so the test also runs from a checkout of that repo.
_HERE = Path(__file__).resolve().parent
DOC = next(
    (p for p in (_HERE / "proposal.geml", _HERE.parents[1] / "demo" / "proposal.geml") if p.exists()),
    _HERE / "proposal.geml",
)

passed = failed = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"ok   {name}")
    else:
        failed += 1
        print(f"FAIL {name}{'  — ' + detail if detail else ''}")


def main() -> int:
    geml = Geml()

    with tempfile.TemporaryDirectory() as tmp:
        doc = Path(tmp) / "proposal.geml"
        shutil.copy(DOC, doc)

        # ---- read ------------------------------------------------------
        ids = geml.list_ids(doc)
        id_set = {e["id"] for e in ids}
        check("list_ids finds the known blocks", {"summary", "migration-plan", "fy26-cost"} <= id_set)

        whole = doc.read_text()
        one = geml.read_block(doc, "#migration-plan")
        check("read_block returns only that block", len(one) < len(whole) / 4,
              f"{len(one)} vs {len(whole)}")
        check("read_block accepts an id without '#'", geml.read_block(doc, "migration-plan") == one)

        table = geml.read_block_json(doc, "#fy26-cost")
        check("read_block_json resolves the computed column",
              "FY" in table["table"]["columns"], str(table["table"]["columns"]))

        check("check on a valid document is clean", geml.check(doc) == [])

        # ---- chunking modes --------------------------------------------
        every = geml.blocks(doc, mode="all")
        check("mode=all covers every id", len(every) == len(ids))
        check("blocks carry metadata", all(b.metadata()["block_id"] for b in every))

        typed = geml.blocks(doc, mode="blocks")
        check("mode=blocks excludes headings", all(b.kind != "heading" for b in typed))
        check("mode=blocks keeps the table whole",
              any(b.id == "fy26-cost" and b.text.count("|") > 20 for b in typed))

        sections = geml.blocks(doc, mode="sections")
        check("mode=sections emits one chunk per heading",
              len(sections) == sum(1 for e in ids if e.get("kind") == "heading"))

        # The defect this mode exists to prevent: in mode="all" the h1 carries
        # the entire document, so every section is indexed twice or more.
        h1_all = next(b for b in every if b.level == 1)
        check("mode=all really does overlap (why it is not the default)",
              "Executive summary" in h1_all.text and "Risk register" in h1_all.text)

        h1_sec = next(b for b in sections if b.level == 1)
        check("mode=sections does not repeat a child inside its parent",
              "Executive summary" not in h1_sec.text, h1_sec.text[:80])

        joined = "\n".join(b.text for b in sections)
        check("mode=sections still covers the whole document",
              all(marker in joined for marker in
                  ("Executive summary", "Risk register", "FY26 warehouse cost", "Open questions")))
        check("mode=sections chunks do not duplicate content",
              joined.count("dominant risk is silent divergence") == 1,
              str(joined.count("dominant risk is silent divergence")))

        # ---- write refused --------------------------------------------
        before = doc.read_bytes()
        try:
            geml.write_block(doc, "#risks", "Tracked in [[#no-such-block]].\n", part="body")
            check("a breaking write is refused", False, "it was accepted")
        except GemlError as exc:
            check("a breaking write is refused", True)
            check("the refusal names the unresolved reference", "no-such-block" in str(exc), str(exc))
        check("a refused write leaves the file byte-identical", doc.read_bytes() == before)

        # ---- write accepted -------------------------------------------
        geml.write_block(doc, "#migration-plan", "Two phases now, gated as before.\n", part="body")
        check("an accepted write lands", "Two phases now" in geml.read_block(doc, "#migration-plan"))
        check("the document is still valid after a write", geml.check(doc) == [])
        check("an unrelated block is untouched",
              "dominant risk is silent divergence" in geml.read_block(doc, "#risks"))

        # ---- revert, following the toolkit's discipline ------------------
        # Snapshot before the write AND before the revert, exactly as the
        # official `geml mcp` server does. That makes the bad state the tip, so
        # the CLI's default `-1` lands on the revision before it.
        good_summary = geml.read_block(doc, "#summary")
        geml.history_commit(doc, "before write")
        geml.write_block(doc, "#summary", "TODO rewrite.\n", part="body")
        geml.write_block(doc, "#open-questions", "RESOLVED: phase 2.\n", part="body")
        geml.history_commit(doc, "before revert")
        geml.revert_block(doc, "#summary")
        check("revert restores the block", geml.read_block(doc, "#summary") == good_summary)
        check("revert preserves a concurrent edit elsewhere",
              "RESOLVED: phase 2." in geml.read_block(doc, "#open-questions"))

        # ---- revision selectors, and why block undo needs `--rev changed` ----
        # Offsets count back from the newest snapshot, not the working file, the
        # way git numbers commits: 0 == HEAD, -1 == HEAD~1.
        sel = Path(tmp) / "sel.geml"
        shutil.copy(DOC, sel)
        geml.history_commit(sel, "v1")
        geml.write_block(sel, "#summary", "V2 CONTENT\n", part="body")
        geml.history_commit(sel, "v2")
        geml.write_block(sel, "#summary", "V3 WORKING\n", part="body")

        def revert_copy(name, **kw):
            c = Path(tmp) / f"sel-{name}.geml"
            shutil.copy(sel, c)
            shutil.copy(sel.with_suffix(".gemlhistory"), c.with_suffix(".gemlhistory"))
            geml.revert_block(c, "#summary", **kw)
            return geml.read_block(c, "#summary")

        check("`0` resolves to the newest snapshot (v2)",
              "V2 CONTENT" in revert_copy("zero", rev="0"))
        check("-1 is one before the newest (v1)", "V2 CONTENT" not in revert_copy("off1", rev="-1"))
        check("omitting rev uses the CLI default of -1",
              "V2 CONTENT" not in revert_copy("default"))
        # `latest` / `current` were removed as tip aliases — `0` is the tip now.
        for gone in ("latest", "current"):
            try:
                revert_copy(f"gone-{gone}", rev=gone)
                check(f"`{gone}` is no longer a selector", False, "it succeeded")
            except GemlError as exc:
                check(f"`{gone}` is no longer a selector", "matched 0 revisions" in str(exc), str(exc))
        # `changed` and an explicit `rev` both choose the target revision, so
        # passing both is contradictory rather than one silently winning.
        try:
            revert_copy("both", rev="-1", changed=True)
            check("passing both changed= and rev= raises", False, "it succeeded")
        except ValueError as exc:
            check("passing both changed= and rev= raises", "not both" in str(exc), str(exc))

        # THE case the toolkit actually faces: an agent writes a block twice,
        # then writes a DIFFERENT block, then wants the first block undone.
        # Every snapshot-per-write scheme makes both offset selectors no-op
        # here, because the revision they land on already holds the bad content.
        # Only `--rev changed` skips revisions that never touched the block.
        inter = Path(tmp) / "interleaved.geml"
        shutil.copy(DOC, inter)

        def toolkit_write(block_id, body):
            geml.history_commit(inter, f"before write {block_id}")
            geml.write_block(inter, block_id, body, part="body")

        toolkit_write("#summary", "GOOD EDIT ONE\n")
        toolkit_write("#summary", "BAD EDIT TWO\n")
        toolkit_write("#open-questions", "HUMAN EDIT\n")
        toolkit_write("#risks", "SECOND HUMAN EDIT\n")

        def undo(name, **kw):
            c = Path(tmp) / f"inter-{name}.geml"
            shutil.copy(inter, c)
            shutil.copy(inter.with_suffix(".gemlhistory"), c.with_suffix(".gemlhistory"))
            try:
                geml.revert_block(c, "#summary", **kw)
            except GemlError:
                pass
            return geml.read_block(c, "#summary")

        # The correct offset depends on how many writes happened since — here
        # -2, one write earlier it was -1 — and the agent does not track that.
        check("`-1` lands on the bad content once two writes intervened",
              "BAD EDIT TWO" in undo("off1", rev="-1"))
        check("`-2` happens to be right here, which is the problem: it moves",
              "GOOD EDIT ONE" in undo("off2", rev="-2"))
        check("`0` (the tip) no-ops as well — so it was never the fix either",
              "BAD EDIT TWO" in undo("tip", rev="0"))
        check("`--rev changed` is invariant to intervening writes",
              "GOOD EDIT ONE" in undo("changed", changed=True))
        check("`--rev changed` leaves the other blocks' edits alone",
              "HUMAN EDIT" in geml.read_block(inter, "#open-questions")
              and "SECOND HUMAN EDIT" in geml.read_block(inter, "#risks"))

        # ---- what "undo" does and does not guarantee --------------------
        # One revert is reliable: `--rev changed` lands on the block's previous
        # distinct version. Repeated reverts are NOT an undo stack. Whether the
        # second one keeps walking back depends on whether a snapshot still
        # holds the version you just left, which is decided by whether another
        # block was written after the edit.
        def seq(name, intervening):
            f = Path(tmp) / f"undo-{name}.geml"
            shutil.copy(DOC, f)
            for bid, body in (("#summary", "AAAA\n"), ("#summary", "BBBB\n")):
                geml.history_commit(f, "w")
                geml.write_block(f, bid, body, part="body")
            if intervening:
                geml.history_commit(f, "w")
                geml.write_block(f, "#open-questions", "OTHER\n", part="body")
            out = []
            for _ in range(2):
                geml.revert_block(f, "#summary", changed=True)
                body = geml.read_block(f, "#summary")
                out.append("AAAA" if "AAAA" in body else "BBBB" if "BBBB" in body else "ORIG")
            return out

        plain, inter_seq = seq("plain", False), seq("inter", True)
        check("one revert always lands on the previous distinct version",
              plain[0] == "AAAA" and inter_seq[0] == "AAAA", f"{plain} {inter_seq}")
        check("with no intervening write, a second revert keeps walking back",
              plain[1] == "ORIG", str(plain))
        check("with an intervening write, a second revert returns to the bad one",
              inter_seq[1] == "BBBB", str(inter_seq))

        # Failure modes are loud, not silent.
        no_history = Path(tmp) / "nohist.geml"
        shutil.copy(DOC, no_history)
        try:
            geml.revert_block(no_history, "#summary", changed=True)
            check("reverting with no history raises", False, "it succeeded")
        except GemlError as exc:
            check("reverting with no history raises", "cannot read history" in str(exc), str(exc))

        untouched = Path(tmp) / "untouched.geml"
        shutil.copy(DOC, untouched)
        geml.history_commit(untouched, "base")
        geml.write_block(untouched, "#summary", "ONLY THIS\n", part="body")
        try:
            geml.revert_block(untouched, "#risks", changed=True)
            check("reverting a never-edited block raises", False, "it succeeded")
        except GemlError as exc:
            check("reverting a never-edited block raises", "no earlier revision" in str(exc), str(exc))
        check("a failed revert leaves the block alone",
              "dominant risk is silent divergence" in geml.read_block(untouched, "#risks"))

        # ---- discovery --------------------------------------------------
        found = list(find_documents(tmp))
        check("find_documents locates .geml files", doc in found)
        check("find_documents skips .gemlhistory sidecars",
              all(p.suffix == ".geml" for p in found), str(found))

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
