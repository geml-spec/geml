#!/usr/bin/env node
// Builds a game into a release, as the game's own game.config.geml says: check
// its documents, import the project, run its probes, export it, check that
// every asset it ships has a credit, package it with its licenses, and start
// the unpacked package once. Every step goes into report.geml beside the
// release, so a build that stops says where and why.
//
//   node integrations/geml-gamemaker/src/build.mjs <game-dir> [--godot <dir|exe>] [--out <dir>]
//
// The game names its engine (`engine:` in `#game-cfg`); what the build does
// with one is in engines/<name>/engine.mjs, and this file knows no engine's
// details. Where an engine is on this machine is the machine's business, not
// the game's: `--<engine>`, else the engine's variable (GODOT_BIN), else PATH.
// The documents are checked by this checkout's geml-parser — build it first —
// with the engine's format reader.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as godot from "../engines/godot/engine.mjs";
import { BuildError, fail } from "./error.mjs";
import { readZip, writeZip } from "./zip.mjs";

export { BuildError };

/** The engines a game can name, by `engine:`. */
export const ENGINES = { godot };

const here = dirname(fileURLToPath(import.meta.url));
const GEML = resolve(here, "..", "..", "..", "geml-parser", "dist", "geml.js");

// ---- the game's configuration ---------------------------------------------

const OPS = new Set(["=", "!=", ">=", "<=", ">", "<"]);
const flatten = (blocks) => blocks.flatMap((b) => [b, ...flatten(b.children ?? [])]);

async function gemlParser() {
  if (!existsSync(GEML)) fail(`the geml parser is not built: run \`npm ci && npm run build\` in ${dirname(dirname(GEML))}`);
  return import(pathToFileURL(GEML).href);
}

// A table's rows by column name. A cell that is one reference — `[[doc#coord]]`
// — keeps where it points, so a probe's expected value can be the design's.
function rowsOf(block, columns) {
  const have = block.table?.columns ?? [];
  const missing = columns.filter((c) => !have.includes(c));
  if (missing.length > 0) fail(`\`#${block.id}\` has no ${missing.map((c) => `\`${c}\``).join(", ")} column`);
  return block.table.rows.map((row) => Object.fromEntries(columns.map((c) => {
    const cell = row[have.indexOf(c)] ?? { text: "" };
    const only = (cell.inlines ?? []).filter((n) => !(n.type === "text" && n.value.trim() === ""));
    const ref = only.length === 1 && only[0].type === "autoref" && only[0].doc !== undefined ? { doc: only[0].doc, anchor: only[0].anchor } : undefined;
    return [c, { text: (cell.text ?? "").trim(), ref }];
  })));
}

/** The game a directory's game.config.geml describes, by its blocks' ids. */
export async function readConfig(gameDir) {
  const dir = resolve(gameDir);
  const file = join(dir, "game.config.geml");
  if (!existsSync(file)) fail(`no game.config.geml in ${dir}`);
  const { parse } = await gemlParser();
  const blocks = flatten(parse(readFileSync(file, "utf8")).children);
  const find = (id) => blocks.find((b) => b.id === id);
  const need = (id) => find(id) ?? fail(`game.config.geml has no \`#${id}\` block`);

  const game = need("game-cfg").value ?? {};
  for (const k of ["name", "version", "engine", "project"]) {
    if (typeof game[k] !== "string" || game[k].trim() === "") fail(`\`#game-cfg\` needs a \`${k}\``);
  }
  if (!Object.hasOwn(ENGINES, game.engine)) fail(`\`#game-cfg\`: no engine \`${game.engine}\` here (there is ${Object.keys(ENGINES).map((e) => `\`${e}\``).join(", ")})`);
  const design = game.design ?? [];
  if (!Array.isArray(design) || design.some((d) => typeof d !== "string")) fail("`#game-cfg` `design` is a list of documents");

  const release = need("release-cfg").value ?? {};
  for (const k of ["preset", "package"]) {
    if (typeof release[k] !== "string" || release[k].trim() === "") fail(`\`#release-cfg\` needs a \`${k}\``);
  }
  const licenses = release.licenses ?? {};
  if (typeof licenses !== "object" || Array.isArray(licenses) || Object.values(licenses).some((v) => typeof v !== "string")) {
    fail("`#release-cfg` `licenses` maps a name in the release to a file of the game");
  }

  const probes = find("probe-checks") === undefined ? [] : rowsOf(find("probe-checks"), ["probe", "key", "op", "value"]).map((r) => {
    if (!OPS.has(r.op.text)) fail(`\`#probe-checks\`: \`${r.op.text}\` is not one of ${[...OPS].join(" ")}`);
    return { probe: r.probe.text, key: r.key.text, op: r.op.text, value: r.value };
  });
  const credits = rowsOf(need("credit-rows"), ["what", "files", "holder", "license", "source"]).map((r) => ({
    what: r.what.text, holder: r.holder.text, license: r.license.text, source: r.source.text,
    files: r.files.text.split(",").map((f) => f.trim()).filter((f) => f !== ""),
  }));

  const fill = (s) => s.replaceAll("{name}", game.name).replaceAll("{version}", game.version);
  return {
    dir, file, name: game.name, version: game.version, engine: game.engine, project: resolve(dir, game.project), design,
    preset: release.preset, packageName: fill(release.package), licenses, probes, credits,
  };
}

// ---- probes --------------------------------------------------------------------

/** The `key=value` pairs of the last `PROBE` line a probe printed. */
export function parseProbe(out) {
  const lines = out.split(/\r?\n/).filter((l) => /^PROBE\s/.test(l.trim()));
  if (lines.length === 0) return null;
  const values = {};
  for (const pair of lines.at(-1).trim().slice(5).trim().split(/\s+/)) {
    const at = pair.indexOf("=");
    if (at > 0) values[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return values;
}

const numeric = (s) => s.trim() !== "" && Number.isFinite(Number(s));

/** Whether `got op want` holds: as numbers when both are, else as text. */
export function compare(got, op, want) {
  if (numeric(got) && numeric(want)) {
    const a = Number(got), b = Number(want);
    return { "=": a === b, "!=": a !== b, ">=": a >= b, "<=": a <= b, ">": a > b, "<": a < b }[op];
  }
  if (op === "=") return got === want;
  if (op === "!=") return got !== want;
  return false;
}

const tail = (out, n = 2) => out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(" / ");

function gemlCli(args, cwd, readerPath) {
  const r = spawnSync(process.execPath, [GEML, ...args, "--reader", readerPath], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

// ---- credits ---------------------------------------------------------------------

/** A credit row's pattern against a project-relative path. `*` and `?` stay in
 *  one folder, `**` crosses folders; a pattern with no `/` is a file name,
 *  wherever the file is. */
export function globMatch(pattern, path) {
  const p = pattern.replaceAll("\\", "/");
  const subject = p.includes("/") ? path : path.slice(path.lastIndexOf("/") + 1);
  const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = p.split("**").map((part) => part.split("*").map((q) => q.split("?").map(esc).join("[^/]")).join("[^/]*")).join(".*");
  return new RegExp(`^${source}$`).test(subject);
}

export const uncredited = (assets, credits) => assets.filter((a) => !credits.some((row) => row.files.some((p) => globMatch(p, a))));

/** CREDITS.txt: the rows, then the engine, then the license texts shipped. */
export function creditsText(config, engineLines, licenseFiles) {
  const lines = [`${config.name} ${config.version}`, ""];
  for (const row of config.credits) {
    lines.push(row.what, `  ${row.holder}. ${row.license}.`, `  Files: ${row.files.join(", ")}`);
    if (row.source) lines.push(`  Source: ${row.source}`);
    lines.push("");
  }
  lines.push("Engine", ...engineLines, "");
  lines.push("License texts", ...licenseFiles.map((f) => `  licenses/${f}`), "");
  return lines.join("\n");
}

// ---- the report ----------------------------------------------------------------------

export const STEPS = [
  ["engine", "引擎"], ["documents", "文档"], ["import", "导入"], ["probes", "探针"],
  ["export", "导出"], ["credits", "授权"], ["package", "打包"], ["self-test", "自测"],
];
const RESULT = { passed: "通过", failed: "失败", skipped: "未跑" };
const cell = (s) => String(s).replace(/\r?\n/g, " ").replaceAll("|", "\\|");

/** report.geml: what the build did, step by step. */
export function reportText(config, steps, outcome, meta = {}) {
  const label = Object.fromEntries(STEPS);
  const stopped = steps.find((s) => s.result === "failed");
  const lines = ["=== meta", `title = "构建报告 — ${config.name} ${config.version}"`];
  for (const [k, v] of Object.entries(meta)) lines.push(`${k} = ${JSON.stringify(String(v))}`);
  lines.push("===", "", "# 结果 {#result}", "");
  lines.push(stopped
    ? `停在「${label[stopped.name]}」：${cell(stopped.note)}。没有生成发行包。`
    : `通过：发行包 \`${outcome.zip}\`（${outcome.size}），sha256 \`${outcome.sha256}\`。`);
  lines.push("", "# 各步 {#stages}", "", "=== table {#stage-rows}", "| 步骤 | 结果 | 用时 | 说明 |", "|---|---|---:|---|");
  for (const s of steps) {
    lines.push(`| ${label[s.name]} | ${RESULT[s.result]} | ${s.seconds === undefined ? "" : `${s.seconds.toFixed(1)} s`} | ${cell(s.note ?? "")} |`);
  }
  lines.push("===", "");
  return lines.join("\n");
}

// ---- the build -----------------------------------------------------------------------

const megabytes = (n) => `${(n / 1048576).toFixed(1)} MB`;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path).split(sep).join("/"));
    }
  };
  walk(dir);
  return out;
}

/** Build the game in `gameDir`. `options[engine]` is where that engine is
 *  (`{ godot: "C:/engines/4.7.2" }`). Resolves to what happened; never throws
 *  for a build that stops, only for a report that cannot be written. */
export async function build(gameDir, { out, env = process.env, ...options } = {}) {
  const steps = [];
  const meta = { built: new Date().toISOString() };
  let config;
  try {
    config = await readConfig(gameDir);
  } catch (e) {
    if (!(e instanceof BuildError)) throw e;
    return { ok: false, steps: [], error: e.message };
  }
  const engine = ENGINES[config.engine];
  const outDir = resolve(out ?? join(config.dir, "build"));
  mkdirSync(outDir, { recursive: true });
  engine.keepOut(outDir);
  const stage = join(outDir, config.packageName);
  const zipPath = join(outDir, `${config.packageName}.zip`);
  const ctx = { found: null, file: null, platform: null };
  const outcome = {};

  const work = {
    engine() {
      ctx.found = engine.locate(options[config.engine], env);
      meta.engine = `${engine.label} ${ctx.found.version}`;
      return `${engine.label} ${ctx.found.version}：\`${ctx.found.exe}\`（来自 ${ctx.found.where}）`;
    },
    documents() {
      const docs = ["game.config.geml", ...config.design];
      let warnings = 0;
      for (const d of docs) {
        const r = gemlCli(["check", d], config.dir, engine.readerPath);
        if (r.code !== 0) fail(`${d}：${tail(r.out + r.err)}`);
        warnings += (r.out + r.err).split(/\r?\n/).filter((l) => l.startsWith("warning:")).length;
      }
      return `${docs.join("、")} 没有错误${warnings ? `，${warnings} 个警告` : ""}`;
    },
    import() {
      return engine.importProject(ctx.found, config.project);
    },
    probes() {
      if (config.probes.length === 0) return "配置里没有探针";
      const said = [];
      const wrong = [];
      for (const probe of [...new Set(config.probes.map((p) => p.probe))]) {
        const script = resolve(config.dir, probe);
        if (!existsSync(script)) fail(`没有探针 \`${probe}\``);
        const r = engine.runProbe(ctx.found, config.project, script);
        const values = parseProbe(r.out);
        if (r.code !== 0 || values === null) fail(`\`${probe}\` 没有打印 PROBE 行（退出码 ${r.code}）：${r.why}`);
        for (const row of config.probes.filter((p) => p.probe === probe)) {
          const got = values[row.key];
          let want = row.value.text;
          if (row.value.ref) {
            const g = gemlCli(["get", row.value.ref.doc, `#${row.value.ref.anchor}`], config.dir, engine.readerPath);
            if (g.code !== 0) fail(`取不到 \`${row.value.text}\`：${tail(g.err)}`);
            want = g.out.trim();
          }
          const from = row.value.ref ? "（设计文档）" : "";
          if (got === undefined) wrong.push(`\`${row.key}\` 探针没报`);
          else if (!compare(got, row.op, want)) wrong.push(`\`${row.key}\` ${got} 不 ${row.op} ${want}${from}`);
          else said.push(`\`${row.key}\` ${got} ${row.op} ${want}${from}`);
        }
      }
      if (wrong.length) fail(wrong.join("；"));
      return said.join("；");
    },
    export() {
      const p = engine.preset(config.project, config.preset);
      ctx.file = p.file || config.name;
      ctx.platform = p.platform;
      rmSync(stage, { recursive: true, force: true });
      mkdirSync(stage, { recursive: true });
      const target = join(stage, ctx.file);
      engine.exportRelease(ctx.found, config.project, config.preset, target);
      return `\`${ctx.file}\`，${megabytes(statSync(target).size)}`;
    },
    credits() {
      const assets = engine.assets(config.project, [outDir]);
      const missing = uncredited(assets, config.credits);
      if (missing.length) fail(`${missing.map((a) => `\`${a}\``).join("、")} 没有授权行`);
      const licenses = join(stage, "licenses");
      mkdirSync(licenses, { recursive: true });
      for (const [name, from] of Object.entries(config.licenses)) {
        const src = resolve(config.dir, from);
        if (!existsSync(src)) fail(`许可证文件 \`${from}\` 不存在`);
        copyFileSync(src, join(licenses, name));
      }
      engine.writeLicenses(ctx.found, licenses);
      const shipped = readdirSync(licenses).sort();
      writeFileSync(join(stage, "CREDITS.txt"), creditsText(config, engine.creditLines(ctx.found.version), shipped));
      return `${assets.length} 个素材文件都有授权行；${shipped.length} 份许可证`;
    },
    package() {
      const entries = filesUnder(stage).map((f) => ({
        name: `${config.packageName}/${f}`,
        data: readFileSync(join(stage, f)),
        mode: f === ctx.file ? 0o755 : 0o644,
      }));
      const zip = writeZip(entries);
      writeFileSync(zipPath, zip);
      Object.assign(outcome, { zip: basename(zipPath), size: megabytes(zip.length), sha256: sha256(zip), files: entries.length });
      return `\`${outcome.zip}\`，${outcome.size}，${entries.length} 个文件`;
    },
    "self-test"() {
      const tmp = mkdtempSync(join(tmpdir(), "geml-gamemaker-selftest-"));
      try {
        const entries = readZip(readFileSync(zipPath));
        for (const e of entries) {
          const path = join(tmp, ...e.name.split("/"));
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, e.data, { mode: e.mode || 0o644 });
        }
        if (entries.length !== outcome.files) fail(`解出 ${entries.length} 个文件，打进去的是 ${outcome.files} 个`);
        if (ctx.platform !== process.platform) return `解出 ${entries.length} 个文件；这台机器跑不了「${config.preset}」的包，没有启动`;
        const said = engine.startExported(join(tmp, config.packageName, ctx.file));
        return `解出 ${entries.length} 个文件；\`${ctx.file}\` ${said}`;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  };

  let stopped = false;
  for (const [name] of STEPS) {
    if (stopped) { steps.push({ name, result: "skipped" }); continue; }
    const t0 = performance.now();
    try {
      const note = await work[name]();
      steps.push({ name, result: "passed", seconds: (performance.now() - t0) / 1000, note });
    } catch (e) {
      const error = e instanceof BuildError ? e : new BuildError(`内部错误：${e?.stack ?? e}`);
      steps.push({ name, result: "failed", seconds: (performance.now() - t0) / 1000, note: error.message });
      stopped = true;
    }
    options.log?.(steps.at(-1));
  }
  if (stopped) rmSync(zipPath, { force: true });
  const report = join(outDir, "report.geml");
  writeFileSync(report, reportText(config, steps, outcome, meta));
  return { ok: !stopped, steps, report, ...outcome, zipPath: stopped ? undefined : zipPath };
}

// ---- the command -----------------------------------------------------------------------

async function main(argv) {
  const args = { _: [] };
  let bad = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a.startsWith("--") ? a.slice(2) : null;
    if (a === "--help" || a === "-h") args.help = true;
    else if (key === "out" || Object.hasOwn(ENGINES, key)) {
      if (argv[i + 1] === undefined) bad = true;
      args[key] = argv[++i];
    } else if (key !== null) bad = true;
    else args._.push(a);
  }
  if (args.help || bad || args._.length !== 1) {
    const flags = Object.values(ENGINES).map((e) => `[--${e.name} <dir|exe>]`).join(" ");
    console.log(`usage: node integrations/geml-gamemaker/src/build.mjs <game-dir> ${flags} [--out <dir>]\n`
      + "  <game-dir> holds game.config.geml, which names its engine; the engine is --<engine>,\n"
      + `  else its variable (${Object.values(ENGINES).map((e) => e.variable).join(", ")}), else PATH;\n`
      + "  the release and report.geml go to --out, else <game-dir>/build.");
    return args.help ? 0 : 2;
  }
  const label = Object.fromEntries(STEPS);
  const { _: [gameDir], help, ...given } = args;
  const result = await build(gameDir, {
    ...given,
    log: (s) => console.log(`${RESULT[s.result].padEnd(3, "　")} ${label[s.name].padEnd(3, "　")} ${s.seconds === undefined ? "" : `${s.seconds.toFixed(1)} s  `}${s.note ?? ""}`),
  });
  if (result.error) { console.error(result.error); return 1; }
  console.log(result.ok ? `\n${result.zipPath}\nsha256 ${result.sha256}` : "");
  console.log(`report: ${result.report}`);
  return result.ok ? 0 : 1;
}

const invoked = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (invoked) process.exitCode = await main(process.argv.slice(2));
