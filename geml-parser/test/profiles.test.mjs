// 应用层 profile 的词汇表机制（设计 §3.3）。
//
// 这个机制存在的理由是把 codemap 的词汇从核心 parser 收回去：在它之前，
// `anchor=` / `entry-via=` 在任何文档的任何 code 块上都静默通过，
// 等于全世界每份 GEML 文档都让出了这三个键的拼写检查。
import { vocabularyFor, PROFILES } from "../dist/profiles.js";
import { parse, renderHtml } from "../dist/geml.js";
import { gemlToMd } from "../dist/to-md.js";
import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";

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

test("索引表与注册表是同一张表 —— README 这句话现在被钉住了", () => {
  // spec/profiles/README.md 自称「this table and that file are the same list
  // stated twice」，却没有任何东西检查它：geml-translator/v1 注册了但从未进过
  // 索引表，而 geml-history 那行把类型名写成了 profile 特意避开的裸名
  // （`revision` 而不是 `history-revision`）。声明一个不变量而不检查它，
  // 就是让它慢慢变成假话。
  const readme = readFileSync(new URL("../../spec/profiles/README.md", import.meta.url), "utf8");
  const rows = new Map();
  // `\r?\n`, not `\n`: this repo checks out CRLF on Windows, and `$` after
  // `(.*)` would then never match — `.` does not cross a CR. The test would
  // have passed on CI and failed only on a Windows working tree.
  for (const line of readme.split(/\r?\n/)) {
    const m = /^\|\s*`(geml-[a-z-]+\/v\d+)`\s*\|(.*)$/.exec(line);
    if (m) rows.set(m[1], m[2]);
  }
  assert.deepEqual([...rows.keys()].sort(), Object.keys(PROFILES).sort(),
    "每个注册的 profile 恰好一行，反之亦然");

  for (const [name, def] of Object.entries(PROFILES)) {
    const row = rows.get(name);
    // 放行的类型名是这一层的公开词汇，索引表写错等于教人写出会被拒的文档。
    for (const t of def.types ?? []) {
      assert.ok(row.includes(`\`${t}\``), `${name} 的行没有提到它放行的类型 \`${t}\``);
    }
    // 属性键挂在哪个类型上，同样是读者要照着写的。
    for (const holder of Object.keys(def.attrs ?? {})) {
      assert.ok(row.includes(`\`${holder}\``), `${name} 的行没有提到属性键挂在 \`${holder}\` 上`);
    }
    // 行里链接的文档必须真的存在。
    for (const [, rel] of row.matchAll(/\]\(([^)]+\.md)\)/g)) {
      assert.ok(existsSync(new URL(`../../spec/profiles/${rel}`, import.meta.url)),
        `${name}: 索引表链接的 ${rel} 不存在`);
    }
  }
});


test("geml-form/v1：声明了 profile 的文档，form-* 家族是注册类型；form-options 的体是一张表", () => {
  const doc = parse('=== meta\nprofile = "geml-form/v1"\n===\n\n'
    + '==== form {#f handler=onboarding}\n'
    + '=== form-options {#plans format=csv delim=;}\nvalue ; label\nbasic ; Basic\npro ; Pro\n===\n'
    + '=== form-field {#plan label="Plan" type=select options=#plans}\n===\n'
    + '=== form-field {#phone label="Mobile" type=text required pattern="^[+0-9 ]+$"}\n===\n'
    + '=== form-note {#n}\nWe never share it.\n===\n'
    + '====\n');
  assert.deepEqual(doc.diagnostics.filter((d) => d.severity !== "info"), [], JSON.stringify(doc.diagnostics));
  const form = doc.children.find((b) => b.type === "form");
  assert.ok(form, "form 是块，不是未知类型");
  const opts = form.children.find((b) => b.type === "form-options");
  assert.deepEqual(opts.table.columns, ["value", "label"], "体解析成了表，和 table 走同一个 parseTable");
  assert.deepEqual(opts.table.rows.map((r) => r[0].text.trim()), ["basic", "pro"]);
  // 六个约束键是**声明**（profile §3）：存下来，不校验
  const phone = form.children.find((b) => b.id === "phone");
  assert.equal(phone.attrs.pattern, "^[+0-9 ]+$");
  // 没声明 profile 的文档照旧不认
  const bare = parse("=== form-field {#x type=text}\n===\n");
  assert.ok(bare.diagnostics.some((d) => d.code === "unknown-block-type"), "不声明就不认，profile 是门票");
});

// ---------------------------------------------------------------------------
// profile 类型的一等公民化（设计 2026-09-15-geml-media §9 第 1 条）
//
// 在此之前 `bodyModeFor` 在 profile 分支提前 return，跳过整段属性拼写检查：
// 一个 profile 给它的类型登记了 attrs，那张表从不被执行。下面钉两件事：
// 属性检查按类型 opt-in；`prose` 让一个 profile 类型拿到核心今天只给 `text`
// 的特权（行内投射、md 段落投影）。
// ---------------------------------------------------------------------------

/** 临时给注册表打补丁再还原（同上面 format 那条的做法）。 */
function withProfile(name, patch, fn) {
  const saved = PROFILES[name];
  try { PROFILES[name] = { ...saved, ...patch }; fn(); }
  finally { PROFILES[name] = saved; }
}

test("属性检查 opt-in：登记了 attrs 的 profile 类型，没登记的键被报出", () => {
  const d = warns('=== meta\nprofile = "geml-form/v1"\n===\n\n'
    + "=== form-field {#f sinse=3}\n===\n", "unknown-attribute");
  assert.equal(d.length, 1, "登记过 attrs 的类型必须查拼写");
  assert.match(d[0].message, /sinse/);
});

test("属性检查 opt-in：没登记 attrs 的 profile 类型保持开放 —— geml-style 的透传参数不能被误报", () => {
  // style-rule 的属性空间是故意开放的：非内含词一律透传给宿主组件，
  // 核心不可能有它的词典。一刀切会让每个透传参数都变成 unknown-attribute。
  const d = warns('=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + '=== style-rule {#a match="table" component=grid overlay-place=bottom whatever=1}\n===\n',
    "unknown-attribute");
  assert.deepEqual(d, [], "没登记 attrs 就是开放集");
});

test("属性检查 opt-in：hidden / caption 对 profile 类型同样普适", () => {
  const d = warns('=== meta\nprofile = "geml-form/v1"\n===\n\n'
    + '=== form-field {#f pattern="x" hidden caption="c"}\n===\n', "unknown-attribute");
  assert.deepEqual(d, []);
});

test("prose：声明了 prose 的 profile 类型可以做 ![[…]] 的目标", () => {
  withProfile("geml-style/v1", { types: ["style-rule", "mt"], prose: ["mt"] }, () => {
    const src = '=== meta\nprofile = "geml-style/v1"\n===\n\n'
      + "=== mt {#look}\n银灰短发齐耳。\n===\n\n"
      + "=== text {#p}\n![[#look]] 特写。\n===\n";
    const d = parse(src).diagnostics.filter((x) => x.code === "inline-transclusion-not-inline");
    assert.deepEqual(d, [], "prose 类型必须可被行内投射");
  });
});

test("prose：只声明 flow 体、没声明 prose 的类型仍不能做投射目标 —— 两个轴不互相顶替", () => {
  withProfile("geml-style/v1", { types: ["style-rule", "ct"], bodies: { ct: "flow" } }, () => {
    const src = '=== meta\nprofile = "geml-style/v1"\n===\n\n'
      + "=== ct {#look}\n银灰短发齐耳。\n===\n\n"
      + "=== text {#p}\n![[#look]] 特写。\n===\n";
    const d = parse(src).diagnostics.filter((x) => x.code === "inline-transclusion-not-inline");
    assert.equal(d.length, 1, "flow 不等于 prose：容器类型不该被行内投射");
  });
});

test("prose 蕴含 prose 体（GEP-0013）—— 不必声明两遍", () => {
  withProfile("geml-style/v1", { types: ["style-rule", "mt"], prose: ["mt"] }, () => {
    const doc = parse('=== meta\nprofile = "geml-style/v1"\n===\n\n=== mt {#a}\n*强调*\n===\n');
    const b = doc.children.find((c) => c.kind === "block" && c.type === "mt");
    assert.equal(b.mode, "prose", "prose 类型的体是 prose：段落与行内，不含嵌套块");
  });
});

test("核心 text 的行为一字不变 —— 这组改动只增不改", () => {
  const src = "=== text {#look}\n银灰短发齐耳。\n===\n\n=== text {#p}\n![[#look]] 特写。\n===\n";
  assert.deepEqual(parse(src).diagnostics, []);
  const b = parse(src).children.find((c) => c.kind === "block" && c.type === "text");
  assert.equal(b.mode, "flow");
});

test("prose：--to html 也和核心 text 同待遇（第三处特权）", () => {
  withProfile("geml-style/v1", { types: ["style-rule", "mt"], prose: ["mt"] }, () => {
    const one = (src) => renderHtml(parse(src), { bare: true });
    const mine = one('=== meta\nprofile = "geml-style/v1"\n===\n\n=== mt {#a}\n一段话。\n===\n');
    const core = one('=== meta\nprofile = "geml-style/v1"\n===\n\n=== text {#a}\n一段话。\n===\n');
    // 只差块类型这一个 chrome token，其余逐字相同
    assert.equal(mine.replace(/"mt"/g, '"text"'), core, "prose 类型的 html 应与 text 同形");
    assert.match(mine, /<div[^>]*id="a"[^>]*>/);
  });
});

test("geml-form 的六个约束键：profile 文档说的那六个，注册表里一个不少", () => {
  // profile 文档 §1.1 现在明说「注册表里不止六个，其余是 GEP-0008 的」。
  // 那句话只有在**这六个确实都在**时才成立；声明一个不变量而不检查它，
  // 就是让它慢慢变成假话（同上面索引表那条）。
  const doc = readFileSync(new URL("../../spec/profiles/geml-form/geml-form-profile.md", import.meta.url), "utf8");
  const six = [...doc.matchAll(/^\| `([a-z]+)` \| /gm)].map((m) => m[1]);
  assert.equal(six.length, 6, "§2 的表应恰好六行: " + six.join(","));
  const registered = new Set(PROFILES["geml-form/v1"].attrs?.["form-field"] ?? []);
  for (const k of six) assert.ok(registered.has(k), `文档列了 \`${k}\`，注册表里没有`);
});

// ---------------------------------------------------------------------------
// geml-media/v1 落地（设计 2026-09-15-geml-media §14 P1）
// ---------------------------------------------------------------------------

test("geml-media/v1：三个类型进来，media-text 是散文类型", () => {
  const v = vocabularyFor(meta({ profile: "geml-media/v1" }));
  for (const t of ["media-asset", "media-clip", "media-text"]) {
    assert.equal(v.types.has(t), true, `应放行 ${t}`);
  }
  assert.equal(v.prose.has("media-text"), true, "media-text 必须是散文类型");
  assert.equal(v.bodies.get("media-text"), "prose", "prose 蕴含 prose 体（GEP-0013）");
});

test("geml-media/v1：五个键挂在 media-text 上，核心 text 不受影响", () => {
  const v = vocabularyFor(meta({ profile: "geml-media/v1" }));
  for (const k of ["shot", "speaker", "to", "emotion", "since"]) {
    assert.equal(v.attrs.get("media-text")?.has(k), true, `media-text 应放行 ${k}`);
  }
  assert.equal(v.attrs.get("text"), undefined, "核心 text 的命名空间必须干净");
});

test("geml-media/v1：提示词投射到角色卡不报错，且 --to md 投成段落", () => {
  const src = '=== meta\nprofile = "geml-media/v1"\n===\n\n'
    + "=== media-text {#hero-look .look}\n银灰短发齐耳。\n===\n\n"
    + "=== media-text {#s01-prompt .prompt shot=s01}\n![[#hero-look]] 特写。\n===\n";
  const doc = parse(src);
  assert.deepEqual(doc.diagnostics.filter((d) => d.severity === "error"), [],
    JSON.stringify(doc.diagnostics));
  const md = gemlToMd(doc).text ?? gemlToMd(doc);
  assert.ok(!String(md).split("\n").some((l) => l.startsWith("> ")),
    "media-text 不该投成引用块: " + md);
});

test("geml-media/v1：属性拼写被查 —— 登记了 attrs 就是闭集", () => {
  const d = warns('=== meta\nprofile = "geml-media/v1"\n===\n\n'
    + "=== media-asset {#a src=x.png sha256=aa kind=image sha265=oops}\n===\n", "unknown-attribute");
  assert.equal(d.length, 1, "sha265 应被报出");
  assert.match(d[0].message, /sha265/);
});

// GEP-0013：散文体的不变量 —— 放行不得改变**可寻址单元的集合**。
const addressesOf = (src) => {
  const out = [];
  const walk = (bs) => bs.forEach((b) => { if (b.id) out.push("#" + b.id); if (b.children) walk(b.children); });
  walk(parse(src).children);
  return out;
};

test("GEP-0013：散文体里的围栏行不是构造 —— 认不认识这份词汇表，地址集都一样", () => {
  const body = "=== media-text {#outer}\n一段话。\n=== text {#nested}\n我不该成为一个块\n===\n===\n";
  const know = addressesOf('=== meta\nprofile = "geml-media/v1"\n===\n\n' + body);
  const dont = addressesOf('=== meta\ntitle = "x"\n===\n\n' + body);
  assert.deepEqual(know, dont, "地址集必须一致（规则 4 的不变量）");
  assert.deepEqual(know, ["#outer"], "散文体只贡献它自己这一个地址");
});

test("GEP-0013：散文体仍然解析行内 —— 强调、投射照常", () => {
  const src = '=== meta\nprofile = "geml-media/v1"\n===\n\n'
    + "=== media-text {#look}\n银灰短发。\n===\n\n"
    + "=== media-text {#p}\n**强调** 与 ![[#look]] 投射。\n===\n";
  const doc = parse(src);
  assert.deepEqual(doc.diagnostics.filter((d) => d.severity === "error"), [],
    JSON.stringify(doc.diagnostics));
  const p = doc.children.find((c) => c.kind === "block" && c.id === "p");
  const para = (p.children ?? []).find((c) => c.kind === "paragraph");
  assert.ok(para, "散文体产出段落");
  assert.ok(para.inlines.some((n) => n.type === "strong"), "强调被解析");
  assert.ok(para.inlines.some((n) => n.type === "project"), "投射被解析");
});

test("GEP-0013：散文体是 prose，不是 flow —— 两者不可互相顶替", () => {
  const doc = parse('=== meta\nprofile = "geml-media/v1"\n===\n\n=== media-text {#a}\nx\n===\n');
  const b = doc.children.find((c) => c.kind === "block" && c.type === "media-text");
  assert.equal(b.mode, "prose");
});
console.log(`\n${passed} passed`);
