# /// script
# requires-python = ">=3.10"
# dependencies = ["sqlglot>=27"]
# ///
# geml-code-graph SQL export (docs/DESIGN-codemap-sql.md).
# Runs via `uv run sql-export.py` (self-provisions sqlglot) or plain
# `python sql-export.py` when sqlglot is already importable; emits raw
# object/reference records as JSONL for adapters/sql.mjs.
#
# Parameters come from ENVIRONMENT VARIABLES, mirroring joern-export.sc (the
# contract that already survives every OS/shell):
#
#   GEML_SRC=/abs/path/to/root  GEML_OUT=/abs/path/to/build/sql \
#     [GEML_SQL_DIALECT=hive|spark|postgres|tsql|mysql|...] uv run sql-export.py
#
# Output:
#   <GEML_OUT>/objects.jsonl  one record per SQL object:
#     {"uid": "o0",                    unique within its file
#      "file": "etl/daily.sql",       GEML_SRC-relative POSIX path
#      "kind": "table|view|materialized-view|procedure|function",
#      "name": "analytics.wh_daily",  display name (an INSERT/MERGE/UPDATE
#                                     target is emitted as its `table`)
#      "qualified": "analytics.wh_daily",  lowercased dotted resolution key
#      "lineStart": 3, "lineEnd": 9}  1-based statement span
#   <GEML_OUT>/refs.jsonl     one record per outgoing reference:
#     {"file": "etl/daily.sql", "fromUid": "o0",
#      "to": "sales.orders",           normalized like `qualified`
#      "toText": "sales.orders",       as written (unresolved fallback text)
#      "refKind": "table|proc", "line": 3}
#
# A file that fails to tokenize/parse is SKIPPED with a `warn <file>: ...`
# line on stderr — one broken file never aborts the run (the codemap simply
# has a blind spot there). Identity/resolution live in the adapter; this
# script stays dumb on purpose.
import json
import logging
import os
import re
import sys
from pathlib import Path

import sqlglot
from sqlglot import exp
from sqlglot.tokens import TokenType

# sqlglot logs "unsupported syntax, falling back to Command" warnings — noise
# for our purposes (Command fallbacks are handled); our own `warn` lines are
# the signal channel.
logging.getLogger("sqlglot").setLevel(logging.ERROR)

# Mirrors detect.mjs SKIP_DIRS: vendored/build trees never hold first-party SQL.
SKIP_DIRS = {
    "node_modules", "target", "dist", "out", "build", ".git", "vendor",
    ".geml-code-graph", ".geml-build", ".idea", ".gradle",
}

DDL_KINDS = {"TABLE": "table", "VIEW": "view", "PROCEDURE": "procedure", "FUNCTION": "function"}
# Top-level DML whose TARGET table is the (resolvable) node it defines.
STMT_VERBS = (exp.Insert, exp.Merge, exp.Update)
# Text-level proc-call fallback: dialects whose EXEC/CALL never reaches the AST
# structurally (see DESIGN §2). Heuristic by design — the whole tier is.
PROC_CALL_RE = re.compile(r'\b(?:EXEC|EXECUTE|CALL)\s+([A-Za-z_"`\[][\w."`\]\[]*)', re.IGNORECASE)
QUOTES = str.maketrans("", "", '"`[]\'')


def norm(name: str) -> str:
    """Lowercased dotted resolution key with dialect quoting stripped."""
    return ".".join(p for p in name.translate(QUOTES).lower().split(".") if p)


def table_parts(t: exp.Table) -> str:
    """Display name of a Table node from its identifier parts (never .sql() —
    that would drag aliases/partitions along)."""
    return ".".join(p for p in (t.catalog, t.db, t.name) if p)


def split_statements(text: str, dialect):
    """Token-level statement splitting: on `;` at depth 0, where BEGIN and CASE
    open a depth that their shared END closes — so a BEGIN…END proc body stays
    one statement. Returns [(sql, line_start, line_end)]. Raises on tokenize
    errors (caller skips the file)."""
    chunks, cur, depth = [], [], 0
    for t in sqlglot.tokenize(text, read=dialect):
        if t.token_type in (TokenType.BEGIN, TokenType.CASE):
            depth += 1
            cur.append(t)
        elif t.token_type == TokenType.END:
            depth = max(0, depth - 1)
            cur.append(t)
        elif t.token_type == TokenType.SEMICOLON and depth == 0:
            if cur:
                chunks.append(cur)
            cur = []
        else:
            cur.append(t)
    if cur:
        chunks.append(cur)
    return [
        (
            text[c[0].start : c[-1].end + 1],
            1 + text.count("\n", 0, c[0].start),
            1 + text.count("\n", 0, c[-1].end),
        )
        for c in chunks
    ]


def collect_refs(node: exp.Expression, exclude_ids: set[int], stmt_text: str) -> list[tuple[str, str, str]]:
    """All (refKind, normalized, as-written) references under `node`:
    proc calls from Execute/Command nodes plus the text-level fallback, then
    table references (minus CTE aliases, proc-call targets, and the definition
    target the caller excluded)."""
    refs: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str]] = set()

    def add(kind: str, text_form: str):
        n = norm(text_form)
        if not n or (kind, n) in seen:
            return
        seen.add((kind, n))
        refs.append((kind, n, text_form.translate(QUOTES)))

    proc_table_ids: set[int] = set()
    for ex in node.find_all(exp.Execute):  # tsql EXEC — structural
        t = ex.this if isinstance(ex.this, exp.Table) else (ex.this.find(exp.Table) if ex.this else None)
        if t is not None:
            proc_table_ids.add(id(t))
            add("proc", table_parts(t))
    for cmd in node.find_all(exp.Command):  # CALL under most dialects — opaque command
        head = str(cmd.this or "").upper()
        if head in ("CALL", "EXEC", "EXECUTE"):
            arg = cmd.expression.this if isinstance(cmd.expression, exp.Literal) else str(cmd.expression or "")
            m = re.match(r'\s*([A-Za-z_"`\[][\w."`\]\[]*)', str(arg))
            if m:
                add("proc", m.group(1))
    for m in PROC_CALL_RE.finditer(stmt_text):  # text fallback (default dialect)
        add("proc", m.group(1))

    ctes = {c.alias_or_name.lower() for c in node.find_all(exp.CTE) if c.alias_or_name}
    for t in node.find_all(exp.Table):
        if id(t) in exclude_ids or id(t) in proc_table_ids:
            continue
        name = table_parts(t)
        if not name:
            continue  # table function / derived table — no identifier to link
        if not t.db and not t.catalog and t.name.lower() in ctes:
            continue  # CTE alias, not a real object
        add("table", name)
    return refs


def target_table(node: exp.Expression | None) -> exp.Table | None:
    """The Table under a Create/Insert/Merge/Update target, unwrapping
    Schema / StoredProcedure / UserDefinedFunction wrappers."""
    if node is None:
        return None
    return node if isinstance(node, exp.Table) else node.find(exp.Table)


def extract_file(path: Path, rel: str, dialect) -> tuple[list[dict], list[dict]] | None:
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    try:
        statements = split_statements(text, dialect)
        parsed = [(sqlglot.parse_one(s, read=dialect), s, a, b) for s, a, b in statements if s.strip()]
    except Exception as e:  # tokenize or parse error -> skip the whole file
        print(f"warn {rel}: {str(e).splitlines()[0][:200]}", file=sys.stderr)
        return None

    objects: list[dict] = []
    refs: list[dict] = []

    def emit(kind, name, qualified, a, b, ref_list):
        uid = f"o{len(objects)}"
        objects.append({
            "uid": uid, "file": rel, "kind": kind, "name": name,
            "qualified": qualified, "lineStart": a, "lineEnd": b,
        })
        for ref_kind, to, to_text in ref_list:
            refs.append({"file": rel, "fromUid": uid, "to": to, "toText": to_text,
                         "refKind": ref_kind, "line": a})

    for e, stmt_text, a, b in parsed:
        if isinstance(e, exp.Create):
            kind = DDL_KINDS.get(str(e.kind or "").upper())
            if kind is None:
                continue  # CREATE INDEX/SCHEMA/... — not a v1 node
            tgt = target_table(e.this)
            if tgt is None:
                continue
            props = e.args.get("properties")
            if kind == "view" and props and any(isinstance(p, exp.MaterializedProperty) for p in props.expressions):
                kind = "materialized-view"
            body_refs = collect_refs(e, {id(tgt)}, stmt_text)
            # Opaque string body (postgres $$…$$ Heredoc / AS '…' literal):
            # best-effort re-parse; an unparseable procedural body keeps the
            # node but contributes no refs (DESIGN §2).
            body = e.args.get("expression")
            if isinstance(body, (exp.Heredoc, exp.Literal)) and isinstance(body.this, str):
                try:
                    inner = [(sqlglot.parse_one(s, read=dialect), s) for s, _, _ in split_statements(body.this, dialect) if s.strip()]
                    known = {(k, t) for k, t, _ in body_refs}
                    for ie, itext in inner:
                        body_refs += [r for r in collect_refs(ie, set(), itext) if (r[0], r[1]) not in known]
                except Exception:
                    pass
            emit(kind, table_parts(tgt), norm(table_parts(tgt)), a, b, body_refs)
        elif type(e) in STMT_VERBS:
            tgt = target_table(e.this)
            if tgt is None:
                continue
            # The WRITTEN table is the node (resolvable), fed by its source
            # tables — so a downstream task's FROM <table> resolves to it. In an
            # INSERT-driven warehouse (no CREATE DDL, e.g. DataWorks/ODPS) this
            # is what connects cross-task lineage. Target excluded from its refs.
            emit("table", table_parts(tgt), norm(table_parts(tgt)), a, b, collect_refs(e, {id(tgt)}, stmt_text))
        # anything else (SELECT/DROP/USE/standalone CALL/...) — no v1 node
    return objects, refs


def main() -> int:
    src = os.environ.get("GEML_SRC")
    out = os.environ.get("GEML_OUT")
    if not src or not out:
        print("GEML_SRC and GEML_OUT must be set", file=sys.stderr)
        return 2
    dialect = os.environ.get("GEML_SQL_DIALECT") or None
    root = Path(src)

    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        files += (Path(dirpath) / f for f in sorted(filenames) if f.lower().endswith(".sql"))

    all_objects: list[dict] = []
    all_refs: list[dict] = []
    skipped = 0
    for p in files:
        rel = p.relative_to(root).as_posix()
        r = extract_file(p, rel, dialect)
        if r is None:
            skipped += 1
            continue
        all_objects += r[0]
        all_refs += r[1]

    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, rows in (("objects.jsonl", all_objects), ("refs.jsonl", all_refs)):
        with open(out_dir / name, "w", encoding="utf-8", newline="\n") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(
        f"geml-code-graph sql-export: {len(all_objects)} objects, {len(all_refs)} refs "
        f"from {len(files) - skipped}/{len(files)} file(s)"
        f"{f' ({skipped} skipped, see warnings)' if skipped else ''} -> {out_dir}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
