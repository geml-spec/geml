#!/usr/bin/env node
// DataWorks tasks JSON -> a .sql tree the SQL codemap consumes.
//
//   node dataworks-export.mjs <tasks.json> [--out <dir>]
//
// A DataWorks export (dataworks mcp / Open API) is one JSON holding every
// scheduled task. This writes one `.sql` file per ODPS_SQL task — its
// `script_content` verbatim (sqlglot-hive parses real ODPS SQL as-is; no
// preprocessing) — under `<out>/<schema>/<task-name>.sql`, so
// `geml codemap build --root <out> --sql-dialect hive` groups the lineage
// codemap by warehouse schema (biz_all, biz_bp, …).
//
// SCOPE (v1): ODPS_SQL only — the SQL lineage view. DI (datax sync), VIRTUAL
// (scheduling placeholders) and other node types carry no SQL and are skipped
// with a count; the DataWorks scheduling DAG (task `dependencies`) is a
// separate graph, out of scope here.
//
// Schema of a task = where its output table lives, derived in a cascade:
//   1. the target table's schema — INSERT OVERWRITE/INTO TABLE … or
//      CREATE TABLE/VIEW … , second-to-last dotted segment (skipping a
//      leading ${var}); handles 2-part schema.table and 3-part proj.schema.table
//   2. else the `project=<proj>.<schema>` scheduling parameter
//   3. else the task-name domain: <layer>_<domain>_… -> biz_<domain>
//   4. else "_misc"
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DOMAINS = new Set(["all", "bp", "ap", "gp", "other"]);

// The target table of the statement that DEFINES this task's output.
export function targetTable(sql) {
  const strip = (s) => s.replace(/[`"]/g, "");
  const ins = sql.match(/INSERT\s+(?:OVERWRITE|INTO)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.${}[\]]+)/i);
  if (ins) return strip(ins[1]);
  const cre = sql.match(/CREATE\s+(?:EXTERNAL\s+|TEMPORARY\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.${}[\]]+)/i);
  if (cre) return strip(cre[1]);
  return null;
}

// Second-to-last dotted segment of a table ref, if it is a literal (not a
// ${var}) — the schema in schema.table / proj.schema.table.
function schemaOfTable(tbl) {
  if (!tbl) return null;
  const segs = tbl.split(".").filter(Boolean);
  if (segs.length < 2) return null;
  const cand = segs[segs.length - 2];
  return cand.includes("${") ? null : cand;
}

function paramSchema(task) {
  const m = String(task.script_parameters || "").match(/(?:^|\s)project=(\S+)/);
  if (!m) return null;
  const p = m[1].split(".").filter(Boolean);
  return p.length >= 2 ? p[p.length - 1] : null;
}

function nameSchema(task) {
  const parts = String(task.name || "").split("_");
  return parts[1] && DOMAINS.has(parts[1]) ? `biz_${parts[1]}` : null;
}

// The cascade. Exported for tests.
export function deriveSchema(task) {
  return schemaOfTable(targetTable(task.script_content || ""))
    || paramSchema(task)
    || nameSchema(task)
    || "_misc";
}

const safeName = (s) => String(s || "task").replace(/[^A-Za-z0-9_.-]/g, "_");

// Pure planner: tasks -> { files:[{path, content}], skipped:{TYPE:n}, schemas:Set }.
// Exported so tests assert layout without touching disk.
export function planExport(tasks) {
  const files = [];
  const skipped = {};
  const schemas = new Set();
  const used = new Set();
  for (const t of tasks) {
    if (t.type !== "ODPS_SQL" || !t.script_content) {
      skipped[t.type] = (skipped[t.type] || 0) + 1;
      continue;
    }
    const schema = deriveSchema(t);
    schemas.add(schema);
    let base = safeName(t.name);
    let rel = `${schema}/${base}.sql`;
    for (let i = 2; used.has(rel); i++) rel = `${schema}/${base}__${i}.sql`; // collision-safe
    used.add(rel);
    files.push({ path: rel, content: t.script_content });
  }
  return { files, skipped, schemas };
}

function main(argv) {
  const args = argv.slice(2);
  const input = args.find((a) => !a.startsWith("--"));
  const outI = args.indexOf("--out");
  const out = outI >= 0 ? args[outI + 1] : "dataworks-sql";
  if (!input) {
    console.error("usage: node dataworks-export.mjs <tasks.json> [--out <dir>]");
    return 2;
  }
  const data = JSON.parse(readFileSync(input, "utf8"));
  const tasks = Array.isArray(data) ? data : data.tasks || [];
  const { files, skipped, schemas } = planExport(tasks);
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  for (const f of files) {
    const abs = join(out, f.path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, f.content.endsWith("\n") ? f.content : f.content + "\n");
  }
  const skipStr = Object.entries(skipped).map(([k, n]) => `${k}×${n}`).join(", ") || "none";
  console.error(
    `dataworks-export: ${files.length} ODPS_SQL task(s) -> ${schemas.size} schema dir(s) `
    + `(${[...schemas].sort().join(", ")}) under ${out}; skipped non-SQL: ${skipStr}`,
  );
  console.error(`next: geml codemap build --root ${out} --sql-dialect hive`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
