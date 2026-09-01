// 应用层 profile 的词汇表机制（设计 §3.3）。
//
// 这个机制存在的理由是把 codemap 的词汇从核心 parser 收回去：在它之前，
// `anchor=` / `entry-via=` 在任何文档的任何 code 块上都静默通过，
// 等于全世界每份 GEML 文档都让出了这三个键的拼写检查。
import { vocabularyFor, PROFILES } from "../dist/profiles.js";
import { parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const meta = (o) => new Map(Object.entries(o));

test("注册表：声明了 geml-codemap/v1 才放行它的属性键", () => {
  const v = vocabularyFor(meta({ profile: "geml-codemap/v1" }));
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
  const v = vocabularyFor(meta({ profile: "geml-codemap/v1 geml-style/v1" }));
  assert.equal(v.attrs.get("code")?.has("anchor"), true);
  assert.equal(v.types.has("style-rule"), true);
});

test("注册表：未知 profile 名被忽略，不炸也不放行", () => {
  const v = vocabularyFor(meta({ profile: "nope/9 geml-codemap/v1" }));
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

test("声明了 geml-codemap/v1 之后，同样的块检查干净", () => {
  const d = warns('=== meta\nprofile = "geml-codemap/v1"\n===\n\n' + CODEMAP_BLOCK, "unknown-attribute");
  assert.deepEqual(d, []);
});

test("旧产物（只有 resolution-default）现在会报 —— 重新 build 一次即可（决策 1）", () => {
  const d = warns('=== meta\nresolution-default = "cpg"\n===\n\n' + CODEMAP_BLOCK, "unknown-attribute");
  assert.equal(d.length, 2);
});

test("拼错的键在任何情况下都被抓 —— 放行的是名字，不是整个类型", () => {
  const d = warns('=== meta\nprofile = "geml-codemap/v1"\n===\n\n=== code {#a ancohr="typo"}\n===\n', "unknown-attribute");
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
  const declarations = src.match(/profile = "geml-codemap\/v1"/g) ?? [];
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

test("geml-history/v1 放行 .gemlhistory 自己的词汇，未声明时照旧报未知类型", () => {
  const doc = (declared) =>
    "=== meta\n" + (declared ? 'profile = "geml-history/v1"\n' : "") + 'history-of = "a.geml"\n===\n\n'
    + '====== history-keyframe {id="20260101T000000Z-aaaaaaaa" hash="sha256:aa"}\nx\n======\n\n'
    + '=== history-revision {id="20260101T000000Z-aaaaaaaa" author="a" summary="s" hash="sha256:aa" newline=lf}\n'
    + '==== history-blob {#b-1 lang=geml}\ny\n====\n===\n';
  // 声明之前，这个项目自己的工具写出的文件报自己的类型为未知。
  const bare = parse(doc(false)).diagnostics.map((x) => x.code);
  assert.ok(bare.includes("unknown-block-type"), JSON.stringify(bare));
  // 声明之后，类型与属性键都放行。
  assert.deepEqual(parse(doc(true)).diagnostics.map((x) => x.code), []);
});

test("history 的 meta 写出点声明 profile", () => {
  const src = readFileSync(new URL("../src/history.ts", import.meta.url), "utf8");
  const declarations = src.match(/profile {2,}= "geml-history\/v1"/g) ?? [];
  assert.equal(declarations.length, 1, "写出 .gemlhistory 的那一处必须声明，否则每份边车都自报未知");
});

test("注册表里的名字统一以 geml- 起头，好认出是本项目自己出的词汇表", () => {
  for (const name of Object.keys(PROFILES)) {
    assert.match(name, /^geml-[a-z-]+\/v\d+$/, `profile 名不合约定: ${name}`);
  }
});

test("跨 profile 边界：声明与否只改诊断，不改解析结果（v1 不放行 body 模式）", () => {
  // 这条钉的是 embed / get / set 跨文档时的安全前提：两份文档的 profile 可以
  // 不一致，因为被放行的类型和未知类型解析成同一个东西。一旦有人让 profile
  // 影响 body 模式（profiles.ts 顶部把这一步单独留出并要求另行论证），同一段
  // 字节在两份文档里就会解析成不同的树，这条测试会先红。
  const doc = (declared) =>
    "=== meta\n" + (declared ? 'profile = "geml-history/v1"\n' : "") + 'title = "t"\n===\n\n'
    + '=== history-revision {#r1 id="20260101T000000Z-aaaaaaaa" author="a" summary="s" hash="sha256:aa" newline=lf}\n'
    + "raw *not* emphasised\n===\n";
  const a = parse(doc(true)), b = parse(doc(false));
  const blk = (d) => d.children.find((c) => c.kind === "block" && c.type === "history-revision");
  assert.equal(blk(a).mode, blk(b).mode, "body 模式必须与 profile 无关");
  assert.equal(blk(a).mode, "raw");
  assert.deepEqual(blk(a).body, blk(b).body, "body 必须逐字相同");
  assert.equal(blk(a).id, blk(b).id);
  // 唯一的差别，就是诊断。
  assert.deepEqual(a.diagnostics.map((x) => x.code), []);
  assert.deepEqual(b.diagnostics.map((x) => x.code), ["unknown-block-type"]);
});

test("放行第三类：diagram 的 format 名（§8.6.1）", () => {
  const doc = (declared) =>
    "=== meta\n" + (declared ? 'profile = "geml-style/v1"\n' : "") + 't = "x"\n===\n\n'
    + "=== diagram {#d format=acme-flow}\nX -> Y\n===\n";
  const codes = (src) => parse(src).diagnostics.map((x) => x.code);

  // 未声明：照旧 warning。
  assert.deepEqual(codes(doc(false)), ["unknown-diagram-format"]);
  // 已声明但该 profile 没放行这个 format：仍然 warning —— 放行是逐名字的。
  assert.deepEqual(codes(doc(true)), ["unknown-diagram-format"]);

  // 放行之后不再 warning。目前没有任何已发布的 profile 声明 format（geml-chart
  // 与 geml-code-graph 都已是 §7 的内建渲染器），所以这里临时给注册表加一条再还原
  // —— 机制该被钉住，不能因为暂时没人用就不测。
  const saved = PROFILES["geml-style/v1"].formats;
  try {
    PROFILES["geml-style/v1"].formats = ["acme-flow"];
    assert.deepEqual(codes(doc(true)), [], "放行的 format 不再报 unknown-diagram-format");
    // 而模型必须一字不差 —— 这是第 4 条对 format 的形态。
    const blk = (src) => { const b = parse(src).children.find((c) => c.kind === "block" && c.type === "diagram"); return { mode: b.mode, raw: b.raw }; };
    assert.deepEqual(blk(doc(true)), blk(doc(false)), "放行不得改变文档模型");
  } finally {
    if (saved === undefined) delete PROFILES["geml-style/v1"].formats;
    else PROFILES["geml-style/v1"].formats = saved;
  }
});

test("table / data 的 format 不可被放行 —— 它们决定正文怎么解析", () => {
  // 记录判据本身：diagram 的模型里没有 format 派生的字段，table 和 data 有。
  const g = (src) => parse(src).children.find((c) => c.kind === "block");
  assert.equal(g("=== diagram {#d format=mermaid}\ngraph TD\n===\n").table, undefined);
  assert.ok(g("=== table {#t format=csv header=1}\na,b\n1,2\n===\n").table, "table 的 format 产出 node.table");
  assert.ok(g('=== data {#j format=jsonl}\n{"a":1}\n===\n').value, "data 的 format 产出 node.value");
});

console.log(`\n${passed} passed`);
