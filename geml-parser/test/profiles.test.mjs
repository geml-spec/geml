// 应用层 profile 的词汇表机制（设计 §3.3）。
//
// 这个机制存在的理由是把 codemap 的词汇从核心 parser 收回去：在它之前，
// `anchor=` / `entry-via=` 在任何文档的任何 code 块上都静默通过，
// 等于全世界每份 GEML 文档都让出了这三个键的拼写检查。
import { vocabularyFor } from "../dist/profiles.js";
import { parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const meta = (o) => new Map(Object.entries(o));

test("注册表：声明了 codemap/v1 才放行它的属性键", () => {
  const v = vocabularyFor(meta({ profile: "codemap/v1" }));
  assert.equal(v.attrs.get("code")?.has("anchor"), true);
  assert.equal(v.attrs.get("code")?.has("entry-via"), true);
});

test("注册表：没声明就什么都不放行 —— 拼写检查回到其他文档手里", () => {
  const v = vocabularyFor(meta({ title: "an ordinary document" }));
  assert.equal(v.attrs.get("code"), undefined);
  assert.equal(v.types.size, 0);
});

test("注册表：geml-style/v1 放行三个块类型（计划 A 的回报）", () => {
  const v = vocabularyFor(meta({ profile: "geml-style/v1" }));
  for (const t of ["style-rule", "style-state", "style-screen"]) {
    assert.equal(v.types.has(t), true, `应放行 ${t}`);
  }
});

test("注册表：profile 是空格分隔的列表，语义是并集（设计 §3.1）", () => {
  const v = vocabularyFor(meta({ profile: "codemap/v1 geml-style/v1" }));
  assert.equal(v.attrs.get("code")?.has("anchor"), true);
  assert.equal(v.types.has("style-rule"), true);
});

test("注册表：未知 profile 名被忽略，不炸也不放行", () => {
  const v = vocabularyFor(meta({ profile: "nope/9 codemap/v1" }));
  assert.equal(v.attrs.get("code")?.has("anchor"), true);
  assert.equal(v.types.size, 0);
});

test("注册表：没有后门 —— 只有 profile= 声明才放行（决策 1）", () => {
  // 旧 codemap 产物靠 resolution-default 自我标识，但那是 emit 的生成物标记，
  // 不是 profile 声明。认它会把 §8.4 一致性面的污染以更小的形式重新引入。
  const v = vocabularyFor(meta({ module: "a/b", "resolution-default": "cpg" }));
  assert.equal(v.attrs.get("code"), undefined);
});

const warns = (src, code) => parse(src).diagnostics.filter((d) => d.code === code);

const CODEMAP_BLOCK =
  '=== code {#esc anchor="ts:render.ts#esc(string)" entry-via=main}\n===\n';

test("回归：普通文档里的 anchor= 现在被抓了 —— 拼写检查回来了", () => {
  const d = warns('=== meta\ntitle = "ordinary"\n===\n\n' + CODEMAP_BLOCK, "unknown-attribute");
  assert.equal(d.length, 2, "anchor 和 entry-via 都该报");
});

test("声明了 codemap/v1 之后，同样的块检查干净", () => {
  const d = warns('=== meta\nprofile = "codemap/v1"\n===\n\n' + CODEMAP_BLOCK, "unknown-attribute");
  assert.deepEqual(d, []);
});

test("旧产物（只有 resolution-default）现在会报 —— 重新 build 一次即可（决策 1）", () => {
  const d = warns('=== meta\nresolution-default = "cpg"\n===\n\n' + CODEMAP_BLOCK, "unknown-attribute");
  assert.equal(d.length, 2);
});

test("拼错的键在任何情况下都被抓 —— 放行的是名字，不是整个类型", () => {
  const d = warns('=== meta\nprofile = "codemap/v1"\n===\n\n=== code {#a ancohr="typo"}\n===\n', "unknown-attribute");
  assert.equal(d.length, 1);
  assert.match(d[0].message, /ancohr/);
});

test("geml-style 样式表不再逐块报 unknown-block-type（计划 A 的回报）", () => {
  const sheet =
    '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#a match="table"}\n===\n\n' +
    '=== style-rule {#b match="code"}\n===\n';
  assert.deepEqual(warns(sheet, "unknown-block-type"), []);
  // 没声明 profile 的同一份内容照旧逐块报
  assert.equal(warns(sheet.replace('profile = "geml-style/v1"', 'title = "x"'), "unknown-block-type").length, 2);
});

test("放行的类型 body 仍按 §3 当 raw —— v1 不改 body 模式", () => {
  const d = parse('=== meta\nprofile = "geml-style/v1"\n===\n\n=== style-rule {#a match="table"}\nnot parsed\n===\n');
  const block = d.children.find((c) => c.kind === "block" && c.type === "style-rule");
  assert.equal(block.mode, "raw");
});

test("codemap 的两个 meta 写出点都声明 profile", () => {
  const src = readFileSync(new URL("../codemap/emit.mjs", import.meta.url), "utf8");
  const declarations = src.match(/profile = "codemap\/v1"/g) ?? [];
  assert.equal(declarations.length, 2, "index 与 container 两个写出点都要声明");
});

test("端到端：codemap 内容文档与 geml-style 样式表各自声明，各自检查干净", () => {
  const clean = (f) => {
    const d = parse(readFileSync(new URL(f, import.meta.url), "utf8"));
    assert.deepEqual(d.diagnostics.map((x) => x.code), [], `${f} 应无诊断`);
  };
  clean("./fixtures/style/codemap-content.geml");
  clean("./fixtures/style/codemap.style.geml");
});

console.log(`\n${passed} passed`);
