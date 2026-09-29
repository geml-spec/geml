// evidence.test.mjs —— 证据工具的纯函数，以及已采集证据里镜头要依赖的事实。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/geml.mjs";
import { display, stable } from "../capture-evidence.mjs";

test("display：含 #、空格或中文标点的参数加单引号，其余原样", () => {
  assert.equal(display(["media", "log", "x.geml", "--output", "#s01-key", "--root", "."]), "geml media log x.geml --output '#s01-key' --root .");
  assert.equal(display(["--prompt", "雨夜，天台"], "mflux"), "mflux --prompt '雨夜，天台'");
});

test("stable：只抹掉生成时刻", () => {
  assert.equal(stable('{"output":"#a","at":"2026-09-27T14:51:07.622Z","seed":1}'), '{"output":"#a","at":"…","seed":1}');
});

const ev = (n) => readFileSync(join(ROOT, "evidence", `${n}.txt`), "utf8");
const has = existsSync(join(ROOT, "evidence", "ep-todo-fresh.txt"));
const skip = !has && "证据还没采";

test("S04 依赖的事实：刚开工时 14 项待办，8 张图、6 句配音", { skip }, () => {
  const lines = ev("ep-todo-fresh").trimEnd().split("\n").slice(1);
  assert.equal(lines.filter((l) => l.startsWith("生成")).length, 8);
  assert.equal(lines.filter((l) => l.startsWith("配音")).length, 6);
});

test("S06 依赖的事实：做完之后没有待办", { skip }, () => {
  assert.match(ev("ep-todo-done"), /没有待办/);
});

test("S10 依赖的事实：断在一半时只剩后三张图与全部配音", { skip }, () => {
  const lines = ev("ep-resume").trimEnd().split("\n").slice(1);
  assert.deepEqual(lines.filter((l) => l.startsWith("生成")).map((l) => l.match(/#(\S+)/)[1]), ["s04-prompt", "s05-prompt", "s06-prompt"]);
  assert.equal(lines.filter((l) => l.startsWith("配音")).length, 6);
});

test("S11 依赖的事实：改一句台词，只有它的配音与用到配音的那一段要重做", { skip }, () => {
  const ids = [...ev("ep-change-line").matchAll(/^warning: [\w-]+: .*#([\w-]+)\)$/gm)].map((m) => m[1]);
  assert.ok(ids.includes("l4-vo"), ids.join(","));
  for (const id of ids) assert.match(id, /l4/, `点名了与 l4 无关的 #${id}`);
});
