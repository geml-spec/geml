# DESIGN — codemap SQL adapter (lineage as call graph)

- Status: implemented with this document (2026-07-13)
- Fits `docs/codemap-profile.md` unchanged — no new meta keys, no new resolution
  values, no new table schemas. SQL is one more extractor behind the same
  exchange format (`DESIGN-geml-code-graph.md` §3), mirroring the Joern pattern:
  shipped export script → raw JSONL → adapter.
- Prior art / motivating use case: the maintainer's DataWorks cross-domain
  dependency analysis (`~/.claude/skills/dw-cross-domain-analysis`) already
  treats a warehouse as FROM/JOIN → sources, INSERT INTO/OVERWRITE → targets
  over exported ODPS_SQL task files — this adapter is that extraction,
  generalized and landed in the codemap vocabulary. Its layer/domain bucketing
  (ods/dwd/dws/ads classification, cross- vs same-domain edge grouping) is
  explicitly v2 — v1 ships the raw lineage graph.

## 1. Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Node kinds | Every SQL **object** is a `code` block (exchange kind `Function`): `CREATE TABLE` / `VIEW` / `MATERIALIZED VIEW` / `PROCEDURE` / `FUNCTION`, plus **top-level DML** (`INSERT`/`MERGE`/`UPDATE`), whose **target table is the node** — resolvable, named by the table, fed by the statement's source tables, so a downstream task's `FROM <table>` resolves to it. (This is what connects cross-task lineage in an INSERT-driven warehouse like DataWorks/ODPS that carries no `CREATE TABLE` DDL — validated on a 585-task export: 29→933 resolved edges. A `statement` kind still exists in the exchange format and `sql.mjs` handles it, but the extractor no longer emits it.) Container = the `.sql` file (dir mode groups files by directory as usual); the tested consumer shape is a DataWorks-style export — one ODPS_SQL task = one `.sql` file holding several statements, hundreds of files per warehouse. `src=file#Lstart-Lend` spans the whole statement. The SQL object kind rides in the exchange `signature` field (invisible in the doc; the DDL behind `src=` is self-describing) | One vocabulary for the whole codemap; emit/verify/serve need zero changes |
| D2 | Edge semantics | SQL has no call graph; it has **dependency/lineage**. v1 maps everything onto the existing `calls` kind, direction = referencer → referenced: a view CALLS the tables/views it selects from; a proc CALLS the procs it EXECUTEs/CALLs and the tables it touches; an `INSERT..SELECT` target table CALLS (is fed by) its source tables — the target is the node, so cross-task lineage connects through it. Read/write distinction is v2 (the profile's reserved `#ref-by` table is the natural landing spot). Other top-level statements (`SELECT`, `DROP`, `USE`, standalone `CALL`…) produce no nodes in v1 | `#calls`/`#called-by`/`#unresolved` already answer the questions that matter ("who feeds this table", "what breaks if I drop it") without touching the profile |
| D3 | Resolution tier | **`heuristic`** (reused as-is — the profile offers only `cpg`/`heuristic`, and name-based matching is not compiler-grade). Matching: names normalized case-insensitively, dialect quoting stripped; exact qualified match wins; on a miss, an *unqualified* reference matches any schema's object of that bare name, and a *qualified* reference may match an object defined without a schema — but never another schema's object (a false edge is worse than a blind spot). Unique match → `to`, confidence high (SQL names *are* the linkage; no overloading); several matches → first + `candidates`, medium — never silently pick one; no match → `to_text` in `#unresolved` (the profile's blind-spot semantics, exactly like joern.mjs) | Honest label; the extractor is blind to `search_path`/current-schema context, so `heuristic` it is |
| D4 | Dialect | sqlglot `read=` dialect from `--sql-dialect` / env `GEML_SQL_DIALECT`; default = sqlglot's permissive default dialect. First-class tested: **`hive`** — the closest dialect to ODPS/MaxCompute SQL, the motivating warehouse (backticked identifiers, `STORED AS`, `INSERT OVERWRITE TABLE`; ODPS deviations sqlglot rejects fall under parse-error-skip). Also: `spark`, `postgres`, `tsql`, `mysql`, anything sqlglot reads. A file that fails to tokenize/parse is **skipped with a warning line** — never aborts the run; skipped files are simply absent (no nodes, no edges) | One flag covers the fleet; per-file dialect mixing is v2 |
| D5 | Indexer plumbing | `sql-export.py` is PEP-723 self-provisioning (`uv run` installs `sqlglot>=27`); inputs via env like joern-export.sc: `GEML_SRC` (tree to scan for `*.sql`, pruning node_modules/.git/target/…), `GEML_OUT` (raw JSONL dir), `GEML_SQL_DIALECT` (optional). Auto-detect: `.sql` extension share ≥ the usual bar → SQL job; runner = `uv run`, falling back to `python` when uv is missing **and** sqlglot imports; neither → not-found error with both install hints. Recipe recorded like the other indexers | Zero global Python deps; mirrors the joern env-var contract that already survives Windows |

## 2. Known blind spots (v1, stated on purpose)

- **Dollar-quoted bodies** (`AS $$…$$`) parse only under `--sql-dialect postgres`
  (the default tokenizer splits on the `;` inside the body → parse error → file
  skipped with a warning). When they do parse, the body is re-parsed
  best-effort; an unparseable procedural body (plpgsql `DECLARE/IF/LOOP`) keeps
  the proc node but contributes no refs.
- **`EXEC`/`CALL` under the default dialect** is not structural AST — proc-call
  refs come from `Execute`/`Command` nodes when the dialect provides them, plus
  a text-level `EXEC|EXECUTE|CALL <name>` scan as fallback (heuristic, matching
  the tier label).
- Backtick-quoted DDL needs `--sql-dialect hive`/`mysql`; under the default
  dialect sqlglot degrades it to an opaque `Command` (object silently absent).
- Ref sites carry the **statement's** start line, not the exact reference line.

## 3. Raw JSONL contract (extractor → adapter; shapes also documented in sql-export.py)

- `objects.jsonl`: `{uid, file, kind: table|view|materialized-view|procedure|function|statement, name, qualified|null, lineStart, lineEnd}` — `uid` unique per file; `name` is the display name (`analytics.daily_sales`, `insert-into-wh_daily@L12`); `qualified` is the lowercased dotted resolution key (null for statement nodes).
- `refs.jsonl`: `{file, fromUid, to, toText, refKind: table|proc, line}` — `to` normalized like `qualified`; `toText` as written (lands in `#unresolved` when unresolved).
- Adapter (`adapters/sql.mjs`): anchor grammar `sql:<relpath>#<object-name>` (same-file duplicates get `~2`, `~3` by line order — the joern rule); one `File` symbol per `.sql` file; everything `lang:"sql"`, `resolution:"heuristic"`.

## 4. Later (noted, not built)

- Read/write lineage via the reserved `#ref-by` table (writes vs reads split).
- dbt: a `manifest.json` adapter would bypass sqlglot entirely (dbt already
  resolved refs) and emit the same exchange format — it slots in as
  `adapters/dbt.mjs` + a `dbt_project.yml` manifest signal in detect.mjs.
- Per-file dialect override (e.g. sidecar comment `-- geml-dialect: tsql`).
