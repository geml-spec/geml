#!/usr/bin/env node
// 证据：画面上出现的 CLI 输出与文档片段，全部来自《重生之夜》第一集（episode/）的真实运行。
//
//   node tools/capture-evidence.mjs     在 produce-episode 做完之后跑
//
// 每条证据：把 episode/ 复制到临时目录，做一处真实改动（清空生成日志 = 刚开工；删掉几条记录 =
// 做到一半断了；改一句台词），跑一条真实命令，把「$ 命令」与输出（stdout、stderr 按出现顺序）写进
// evidence/<名字>.txt，登记为 `#evidence-<名字>`。镜头把它列为输入：这一集或 CLI 变了、输出跟着变，
// 用到它的镜头就过期重渲。只差时间戳的重采保留旧文件。
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, registerFile } from "./lib/geml.mjs";
import { EP, SEEDS, MFLUX, mfluxArgs } from "./produce-episode.mjs";

const CLI = process.env.GEML_CLI ?? resolve(ROOT, "../../geml-parser/dist/geml.js");
const LIB = "library.geml";

/** 画面上显示的命令：观众在 episode 目录里敲的那一行。含空格、# 或引号的参数加单引号。 */
export const display = (args, cmd = "geml") => cmd + " " + args.map((a) => (/[\s#'"，。]/.test(a) ? `'${a.replaceAll("'", "'\\''")}'` : a)).join(" ");

function run(dir, args) {
  const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  const r = spawnSync("sh", ["-c", `${q(process.execPath)} ${q(CLI)} ${args.map(q).join(" ")} 2>&1`], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${display(args)} → 退出码 ${r.status}\n${r.stdout}`);
  return r.stdout.replace(/\s+$/, "");
}

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "explainer-evidence-"));
  cpSync(EP, d, { recursive: true, filter: (p) => !p.includes("/out/") });
  return d;
}

const LOG_RE = /(=== data \{#gen-log[^\n]*\}\n)([\s\S]*?)(\n?===)/;
/** 只留生成日志里 output 不在 drop 里的记录；drop 为 null = 清空（刚开工）。 */
function keepRecords(dir, drop) {
  const p = join(dir, LIB);
  writeFileSync(p, readFileSync(p, "utf8").replace(LOG_RE, (_, head, body, tail) => {
    const kept = drop === null ? [] : body.split("\n").filter((l) => l.trim() !== "" && !drop.some((id) => l.includes(`"output":"#${id}"`)));
    return head + kept.join("\n") + (kept.length ? "\n===" : "===");
  }));
}

const edit = (dir, file, from, to) => {
  const p = join(dir, file);
  const s = readFileSync(p, "utf8");
  if (!s.includes(from)) throw new Error(`${file} 里没有「${from}」：这一集变了，证据的改动要跟着改`);
  writeFileSync(p, s.replace(from, to));
};

const cmd = (dir, args) => `$ ${display(args)}\n${run(dir, args)}`;
const TODO = ["media", "todo", ".", "--root", "."];
const CHECK = ["check", "cut.geml", "--root", "."];
const VOICES = ["n1-vo", "n2-vo", "l1-vo", "l2-vo", "l3-vo", "l4-vo"];
const raw = (f) => () => readFileSync(join(EP, f), "utf8");

/** 名字 → 产出证据文本的函数。 */
export const EVIDENCE = {
  "ep-story": raw("story.md"),
  "ep-characters": raw("characters.geml"),
  "ep-script": raw("script.geml"),
  "ep-cut": raw("cut.geml"),
  "ep-genlog": () => readFileSync(join(EP, LIB), "utf8").match(LOG_RE)[2].trim(),
  "ep-todo-fresh": (d = fixture()) => { keepRecords(d, null); return cmd(d, TODO); },
  "ep-todo-json": (d = fixture()) => { keepRecords(d, null); return cmd(d, [...TODO, "--json"]); },
  "ep-mflux": () => {
    // 与 produce-episode 用的是同一个参数构造；提示词取 todo 展开好的那串字
    const d = fixture(); keepRecords(d, null);
    const item = JSON.parse(run(d, [...TODO, "--json"])).find((x) => x.address.endsWith("#s01-prompt"));
    return `$ ${display(mfluxArgs(item.prompt.trim(), SEEDS["s01-key"], "assets/s01-key.png"), MFLUX)}`;
  },
  "ep-log": (d = fixture()) => {
    keepRecords(d, null);
    const out = cmd(d, ["media", "log", LIB, "--output", "#s01-key", "--model", "z-image-turbo-q8", "--mode", "t2i",
      "--prompt", "script.geml#s01-prompt", "--seed", String(SEEDS["s01-key"]), "--root", "."]);
    const rec = readFileSync(join(d, LIB), "utf8").match(LOG_RE)[2].trim().split("\n").pop();
    return `${out}\n${rec}`;
  },
  "ep-todo-voices": (d = fixture()) => { keepRecords(d, VOICES); return cmd(d, TODO); },
  "ep-todo-done": (d = fixture()) => cmd(d, TODO),
  "ep-build": (d = fixture()) => cmd(d, ["media", "build", "cut.geml", "--out", "out/ep01.mp4", "--root", "."]),
  "ep-check": (d = fixture()) => cmd(d, CHECK),
  "ep-resume": (d = fixture()) => { keepRecords(d, ["s04-key", "s05-key", "s06-key", ...VOICES]); return cmd(d, TODO); },
  "ep-change-line": (d = fixture()) => { edit(d, "script.geml", "这一次，换你喝。", "这一次，轮到你喝。"); return cmd(d, CHECK); },
};

// 输出里会随每次运行变的部分：生成记录的时刻。只有它变了，就不算证据变了。
export const stable = (text) => text.replace(/"at":"[^"]*"/g, '"at":"…"');

async function main() {
  if (!existsSync(join(EP, "cut.geml"))) throw new Error("这一集还没做完：先跑 node tools/produce-episode.mjs");
  mkdirSync(join(ROOT, "evidence"), { recursive: true });
  for (const [name, make] of Object.entries(EVIDENCE)) {
    const text = make().replace(/\n?$/, "\n");
    const file = `evidence/${name}.txt`;
    const abs = join(ROOT, file);
    const same = existsSync(abs) && stable(readFileSync(abs, "utf8")) === stable(text);
    if (!same) writeFileSync(abs, text);
    registerFile(LIB, `evidence-${name}`, file, { kind: "other", role: "workflow" });
    console.log(`${name}  ${same ? "未变" : `${text.split("\n").length - 1} 行 → ${file}`}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
