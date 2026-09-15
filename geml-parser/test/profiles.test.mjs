// 应用层 profile 的词汇表机制（设计 §3.3）。
//
// 这个机制存在的理由是把 codemap 的词汇从核心 parser 收回去：在它之前，
// `anchor=` / `entry-via=` 在任何文档的任何 code 块上都静默通过，
// 等于全世界每份 GEML 文档都让出了这三个键的拼写检查。
import { vocabularyFor, unrecognizedVocabularies, PROFILES } from "../dist/profiles.js";
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

// ---- GEP-0013：不认识的词汇表要被宣告出来 ----

const diagsOf = (src) => parse(src).diagnostics.filter((d) => d.code === "unrecognized-vocabulary");

test("GEP-0013：声明了本处理器不认识的词汇表 → warning，指在 profile 那一行", () => {
  const src = '=== meta\nprofile = "acme-invoice/v1"\n===\n\n# T\n';
  const d = diagsOf(src);
  assert.equal(d.length, 1, "恰好一条");
  assert.equal(d[0].severity, "warning", "文档没毛病，是这个读者读不全它");
  assert.equal(d[0].line, 1, "指向声明它的 meta 块，不是文档开头兜底的 1 —— 这里两者恰好同值");
  assert.match(d[0].message, /acme-invoice\/v1/, "消息要指名是哪一个");
});

test("GEP-0013：认识的词汇表不报；一份都没声明也不报", () => {
  assert.equal(diagsOf('=== meta\nprofile = "geml-media/v1"\n===\n').length, 0);
  assert.equal(diagsOf("# 普通文档\n\n一段散文。\n").length, 0);
});

test("GEP-0013：混合声明只报不认识的那些", () => {
  const src = '=== meta\nprofile = "geml-style/v1 acme-a/v1 geml-media/v1 acme-b/v1"\n===\n';
  const named = diagsOf(src).map((d) => d.message.match(/`([^`]+)`/)[1]).sort();
  assert.deepEqual(named, ["acme-a/v1", "acme-b/v1"]);
});

test("GEP-0013：unrecognizedVocabularies 不把原型键当成已注册词汇表", () => {
  // `x in PROFILES` 会把 toString / constructor 认成注册过的，于是一个写了
  // `profile = "toString"` 的文档静默通过。Object.hasOwn 不会。
  assert.deepEqual(unrecognizedVocabularies(meta({ profile: "toString constructor" })),
    ["toString", "constructor"]);
});

test("GEP-0013：规则 4 仍然拦着 —— 放行不改变被放行正文之外的地址", () => {
  const withIt = parse('=== meta\nprofile = "geml-media/v1"\n===\n\n## S\n\n=== media-text {#x}\n散文\n===\n');
  const without = parse('## S\n\n=== media-text {#x}\n散文\n===\n');
  const ids = (doc) => JSON.stringify(doc).match(/"id":"[^"]+"/g)?.sort() ?? [];
  assert.deepEqual(ids(withIt), ids(without), "认不认识这份词汇表，地址集相同");
});

test("注册表：两个 profile 不得对同一类型声明不同的 body 模式", () => {
  // vocabularyFor 取并集，body 模式是最后写入者赢 —— 静默的。注册表是静态的，
  // 所以这个冲突应当由测试挡在这里，而不是留给某份文档去发现。
  const seen = new Map();
  for (const [name, def] of Object.entries(PROFILES)) {
    for (const [type, mode] of Object.entries(def.bodies ?? {})) {
      const prev = seen.get(type);
      assert.ok(prev === undefined || prev[1] === mode,
        `${type} 的 body 模式被 ${prev?.[0]} 声明为 ${prev?.[1]}，又被 ${name} 声明为 ${mode}`);
      seen.set(type, [name, mode]);
    }
    for (const type of def.prose ?? []) {
      const prev = seen.get(type);
      assert.ok(prev === undefined || prev[1] === "prose",
        `${type} 被 ${name} 声明为 prose，却被 ${prev?.[0]} 声明为 ${prev?.[1]}`);
      seen.set(type, [name, "prose"]);
    }
  }
});

test("GEP-0013：页面上没有读不了的块时，不点名任何词汇表", () => {
  // 通知存在是为了解释页面下方那些 "unknown block type" 标签。没有要解释的东西，
  // 就只剩下白白说出一个依赖的名字。
  const docs = { "B.geml": '=== meta\nprofile = "acme-x/v1"\n===\n\n## 公开 {#public}\n\n只是一段散文。\n' };
  const doc = parse("# A\n\n=== embed {src=B.geml#public}\n===\n",
    { resolveDoc: (p) => docs[p] ?? null, self: "A.geml" });
  assert.doesNotMatch(renderHtml(doc, {}), /geml-missing-vocab">Rendered/);
});

test("GEP-0013：不认识的词汇表**跟着内容**穿过 embed 边界，报在宿主那条 embed 上", () => {
  // 宿主自己什么都没声明，看起来干干净净；被它嵌进来的目标声明了本处理器没有的
  // 词汇表，于是宿主渲染出来的是 raw。读的人看的是宿主——所以宿主必须说话。
  const target = '=== meta\nprofile = "acme-media/v1"\n===\n\n=== acme-text {#look}\n一段散文。\n===\n';
  const host = "# 宿主\n\n=== embed {src=t.geml#look}\n===\n";
  const d = parse(host, { resolveDoc: (p) => (p === "t.geml" ? target : null), self: "h.geml" })
    .diagnostics.filter((x) => x.code === "unrecognized-vocabulary");
  assert.equal(d.length, 1);
  assert.equal(d[0].line, 3, "报在那条 embed 上 —— 是它把读不了的内容带进来的");
  assert.match(d[0].message, /t\.geml/);
  assert.match(d[0].message, /acme-media\/v1/);
});

test("GEP-0013：目标的词汇表认得时，穿过 embed 不产生噪音", () => {
  const target = '=== meta\nprofile = "geml-media/v1"\n===\n\n=== media-text {#look}\n一段散文。\n===\n';
  const host = "# 宿主\n\n=== embed {src=t.geml#look}\n===\n";
  const d = parse(host, { resolveDoc: (p) => (p === "t.geml" ? target : null), self: "h.geml" })
    .diagnostics.filter((x) => x.code === "unrecognized-vocabulary");
  assert.equal(d.length, 0);
});

test("GEP-0013：文档自己的毛病不跟着走 —— 只有能力类诊断过边界", () => {
  // 目标里的 unknown-block-type 是目标的事实，留在目标。跨过来的只有
  // 「这个处理器读不了」这一条。
  const target = "=== acme-thing {#x}\nbody\n===\n";
  const host = "# 宿主\n\n=== embed {src=t.geml#x}\n===\n";
  const codes = parse(host, { resolveDoc: (p) => (p === "t.geml" ? target : null), self: "h.geml" })
    .diagnostics.map((x) => x.code);
  assert.ok(!codes.includes("unknown-block-type"), "目标的 unknown-block-type 不该出现在宿主");
});

test("GEP-0013：自包含页面在顶上说清自己缺哪份词汇表", () => {
  // 未知类型的兜底渲染把块标成 "unknown block type" —— 和一个**拼错的**类型
  // 一模一样。读的人分不出"文档写错了"和"我的渲染器少一份词汇表"，而这正是
  // 「是谁的错」这个问题本身。所以整页在内容之上说一次。
  const doc = parse('=== meta\nprofile = "acme-media/v1"\n===\n\n=== acme-text {#x}\n一段散文。\n===\n');
  const html = renderHtml(doc, {});
  assert.match(html, /<div class="geml-missing-vocab">/);
  assert.match(html, /<code>acme-media\/v1<\/code>/, "要指名是哪一份");
  assert.match(html, /unknown block type/, "并把页面下方那个标签解释掉");
});

test("GEP-0013：认得的词汇表不出通知；fragment 模式一律不出", () => {
  const known = parse('=== meta\nprofile = "geml-media/v1"\n===\n\n=== media-text {#x}\n一段散文。\n===\n');
  assert.doesNotMatch(renderHtml(known, {}), /<div class="geml-missing-vocab">/);
  // fragment 进的是别人的版面，chrome 归人家管；viewer 自己有横幅。
  const missing = parse('=== meta\nprofile = "acme-media/v1"\n===\n\n=== acme-text {#x}\nx\n===\n');
  assert.doesNotMatch(renderHtml(missing, { fragment: true }), /<div class="geml-missing-vocab">/);
});

test("GEP-0013：诊断带结构化的 subject —— 渲染器不必从散文里抠名字", () => {
  // 附录 A 明写消息措辞可改；页面若去解析消息，就把页面绑在了措辞上。
  const d = parse('=== meta\nprofile = "acme-a/v1 acme-b/v1"\n===\n')
    .diagnostics.filter((x) => x.code === "unrecognized-vocabulary");
  assert.deepEqual(d.map((x) => x.subject).sort(), ["acme-a/v1", "acme-b/v1"]);
});

// ---- 命名与生命周期：这一层自己的约定（spec/profiles/README.md）----
//
// 规范管不着这两件事。§8.6.2 规则 3 明写「处理器认识哪些词汇表由实现自定」，所以
// 一份词汇表有没有状态、名字长什么样，规范都不该管。管的是本项目——而自从
// GEP-0013 放开了 body 模式，不管的代价变大了：profile 会长得更快，而改一个 body
// 模式会改变所有认识这个名字的人的解析结果。

/**
 * 已知的命名违规。每一条都带**理由**和**何时解除**——一张没有解除条件的豁免表
 * 就是把规则作废，只是作废得比较客气。下面第二个测试会拦住陈旧的条目。
 */
const NAMING_EXCEPTIONS = {
  "geml-form/v1:type:form": "GEP-0008 正把 form-* 家族送进 §3 的核心注册表，届时这个不带连字符的名字归规范所有。GEP 落地即解除；若 GEP 被否，改名。",
  "geml-media/v1:type:media": "没有 GEP 认领它。media 设计稿 §9.7 明说裸 media 类型「现在不提」进核心，所以它今天就占着 §8.5 为规范未来版本保留的位置。这是真违规，解除办法是改名 media-timeline 或提 GEP。",
  "geml-media/v1:meta:tracks": "六个 meta 键早于本约定；fps 与 aspect 尤其是第二份 profile 会想要的通用词。geml-media 仍是 draft，可在 /v1 内改名。",
  "geml-media/v1:meta:primary": "同上。",
  "geml-media/v1:meta:fps": "同上。",
  "geml-media/v1:meta:aspect": "同上。",
  "geml-media/v1:meta:target-duration": "同上。",
  "geml-media/v1:meta:episode": "同上。",
};

const stemOf = (name) => name.replace(/^geml-/, "").replace(/\/v\d+$/, "");
function namingViolations() {
  const out = [];
  for (const [name, def] of Object.entries(PROFILES)) {
    const want = stemOf(name) + "-";
    const check = (kind, names) => {
      for (const n of names ?? []) if (!n.startsWith(want)) out.push(`${name}:${kind}:${n}`);
    };
    check("type", def.types);
    check("code", Object.keys(def.diagnostics ?? {}));
    check("meta", def.metaKeys);
  }
  return out;
}

test("命名：类型名、诊断码、meta 键都带 profile 自己的前缀", () => {
  // 属性键**不**在内，而这是有理由的：它们已经按类型分桶登记，作用域由类型给，
  // 所以 `code.anchor` 和别人的 `x.anchor` 撞不上。没有分桶的这三种才需要前缀。
  const unexcused = namingViolations().filter((v) => !(v in NAMING_EXCEPTIONS));
  assert.deepEqual(unexcused, [],
    `命名约定见 spec/profiles/README.md「Naming」。要么改名，要么在 NAMING_EXCEPTIONS 里写清理由与解除条件`);
});

test("命名：豁免表里没有陈旧条目 —— 名字改好了就要把豁免删掉", () => {
  // 一条留在表里却已经不成立的豁免，读起来像「这里有个问题」，其实没有。
  const live = new Set(namingViolations());
  const stale = Object.keys(NAMING_EXCEPTIONS).filter((k) => !live.has(k));
  assert.deepEqual(stale, [], "这些豁免对应的名字已经合规，删掉它们");
});

test("生命周期：每份 profile 都声明状态，且只用三个值之一", () => {
  for (const [name, def] of Object.entries(PROFILES)) {
    assert.ok(["draft", "stable", "deprecated"].includes(def.state),
      `${name} 的 state 是 ${JSON.stringify(def.state)}`);
  }
});

test("生命周期：stable 的 profile 不得声明 body 模式之外的易变面", () => {
  // stable 承诺的是「同一个 /vN 下只增不改」。今天能机械检查的那一半：一份
  // stable 的 profile 若还在改 body 模式，它就不该叫 stable —— 所以要求它的
  // bodies/prose 声明与文档一致地保守。这里只钉住「stable 必须有文档」，
  // 更强的不变量要等第一次真正的 /v2 才知道怎么写。
  for (const [name, def] of Object.entries(PROFILES)) {
    if (def.state !== "stable") continue;
    const dir = stemOf(name);
    const doc = new URL(`../../spec/profiles/geml-${dir}/geml-${dir}-profile.md`, import.meta.url);
    assert.ok(existsSync(doc), `${name} 标了 stable，却没有 spec/profiles/geml-${dir}/ 下的文档`);
  }
});

test("索引表也带状态 —— 读的人不必翻进 profile 文档才知道能不能依赖它", () => {
  const readme = readFileSync(new URL("../../spec/profiles/README.md", import.meta.url), "utf8");
  for (const [name, def] of Object.entries(PROFILES)) {
    const line = readme.split(/\r?\n/).find((l) => l.startsWith(`| \`${name}\``));
    assert.ok(line, `索引表没有 ${name} 这一行`);
    assert.ok(line.includes(def.state), `${name} 的行没写出它的状态 ${def.state}`);
  }
});

// ---- profile 的检查挂在核心 check 上（#5）----

import { spawnSync } from "node:child_process";
import { resolve as presolve } from "node:path";
const CLI = presolve("dist/geml.js");
const FIX = presolve("test/fixtures/media/ep01/ep01-cut.geml");
const cli = (...args) => {
  const r = spawnSync(process.execPath, [CLI, "check", FIX, ...args], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

test("分发：文档声明了哪份词汇表，就跑哪份的检查 —— 不必换命令名", () => {
  // 要不要按 media 的规则查，是文档自己在 === meta 里说了算的。此前这是 cli.ts
  // 里的一句 if；现在是对 declaredVocabularies 的一次循环，第七份 profile 接上
  // 检查器时不用再动 check 这个动词。
  const r = cli();
  assert.match(r.out, /media-stale-clip/, "profile 的码出现在核心 check 的输出里");
  assert.match(r.out, /ep01-cut\.geml#c0/, "而且按地址报，不是按行号");
});

test("--only 只留匹配的 profile 码，核心诊断不受影响", () => {
  const all = cli(), only = cli("--only", "media-stale-*");
  assert.match(all.out, /media-of-unresolved|media-speaker-unresolved/, "夹具里本来有非 stale 的码");
  assert.doesNotMatch(only.out, /media-of-unresolved|media-speaker-unresolved/);
  assert.match(only.out, /media-stale-/);
});

test("--severity 可以降级，但降不到静默 —— 最低是 info", () => {
  const r = cli("--only", "media-stale-*", "--severity", "media-stale-clip=info");
  assert.match(r.out, /^info: media-stale-clip/m, "级别变了");
  assert.match(r.out, /info/, "但它仍然出现在输出里；让它消失是 --only 的事");
  const bad = cli("--severity", "media-stale-clip=off");
  assert.equal(bad.code, 2);
  assert.match(bad.out, /info is the floor/);
});

test("--severity 拒绝核心的码 —— 附录 A 的级别是规范性的", () => {
  // 「处理器必须以本附录指派的代码与严重级别报告诊断」。一个能改核心级别的开关
  // 会让这个程序不合规，所以它只认已注册词汇表定义过的码。
  const r = cli("--severity", "unknown-block-type=error");
  assert.equal(r.code, 2);
  assert.match(r.out, /Appendix A/);
});

test("meta 键：只查落在已声明词汇表命名空间里的那些", () => {
  // `=== meta` 同时装两种东西：文档元数据（作者的，开放）和词汇表参数。对整块做
  // 闭集检查会把前者报成拼错——实测本仓 playground 的教程用 `chapter = "6 / 7"`，
  // 它不该也不可能被任何词汇表登记。所以查的是命名空间，不是整块。
  const withMeta = (src) => parse(src).diagnostics.filter((d) => d.code === "unknown-meta-key");

  // 不带前缀 = 作者的，永不报
  assert.equal(withMeta('=== meta\nprofile = "geml-media/v1"\nchapter = "6 / 7"\ntitle = "t"\n===\n').length, 0);

  // 带前缀、而那份词汇表没登记 = 报
  const d = withMeta('=== meta\nprofile = "geml-media/v1"\nmedia-fsp = 24\n===\n');
  assert.equal(d.length, 1);
  assert.equal(d[0].subject, "media-fsp");
  assert.match(d[0].message, /geml-media\/v1/, "要指名是谁的命名空间");

  // 没声明那份词汇表时，同一个键不归任何人管，也不报
  assert.equal(withMeta('=== meta\ntitle = "t"\nmedia-fsp = 24\n===\n').length, 0);
});

test("meta 键：一份没有登记 metaKeys 的词汇表，命名空间不设防", () => {
  // geml-style 的 meta 是一张作者自定义的 token 表（`{{accent}}` 这样引用），
  // 和它的属性空间开放同理——核心不可能持有那份词典。登记一个闭集会把每个 token
  // 报成拼错的键；实测最初那版就是这么报了 accent / fg / line / muted 七个。
  const d = parse('=== meta\nprofile = "geml-style/v1"\nstyle-anything = 1\n===\n')
    .diagnostics.filter((x) => x.code === "unknown-meta-key");
  assert.equal(d.length, 0);
});

// ---- 运行时注册：机制在，开关默认关 ----

import { enableProfileRegistration, registerProfile, knownProfiles } from "../dist/geml.js";

test("注册：开关默认是关的 —— 一次 import 不该替宿主做决定", () => {
  // 一个宿主注册了词汇表，它的诊断就和别的宿主不同。规则 1 允许这件事，但那是
  // **宿主的决定**，所以要显式打开。
  assert.throws(() => registerProfile("acme-x/v1", { state: "draft" }), /registration is off/);
});

test("注册：打开之后，一份第三方词汇表不必 fork 解析器就能被认识", () => {
  enableProfileRegistration();
  try {
    const before = parse('=== meta\nprofile = "acme-plot/v1"\n===\n\n=== acme-plot-fig {#f}\nx\n===\n').diagnostics;
    assert.ok(before.some((d) => d.code === "unrecognized-vocabulary"), "注册前：不认识");
    assert.ok(before.some((d) => d.code === "unknown-block-type"), "注册前：类型也不认识");

    registerProfile("acme-plot/v1", { state: "draft", types: ["acme-plot-fig"] });
    const after = parse('=== meta\nprofile = "acme-plot/v1"\n===\n\n=== acme-plot-fig {#f}\nx\n===\n').diagnostics;
    assert.equal(after.length, 0, `注册后应当干净，得到 ${JSON.stringify(after)}`);
    assert.ok(knownProfiles().includes("acme-plot/v1"));
  } finally { enableProfileRegistration(false); }
});

test("注册：当场执行命名约定 —— 内建的有历史豁免，新来的没有", () => {
  enableProfileRegistration();
  try {
    assert.throws(() => registerProfile("acme-plot/v1", { state: "draft", types: ["plot"] }),
      /owns the prefix `acme-plot-`/, "类型名不带前缀");
    assert.throws(() => registerProfile("acme-plot/v1", { state: "draft", diagnostics: { "bad-thing": "error" } }),
      /owns the prefix/, "诊断码不带前缀");
    assert.throws(() => registerProfile("Acme/V1", { state: "draft" }), /must look like/, "名字形状");
    assert.throws(() => registerProfile("geml-media/v1", { state: "draft" }), /is built in/, "不得替换内建");
  } finally { enableProfileRegistration(false); }
});

test("注册：关掉开关会把注册过的清空 —— 不留下半开的状态", () => {
  enableProfileRegistration();
  registerProfile("acme-q/v1", { state: "draft", types: ["acme-q-box"] });
  assert.ok(knownProfiles().includes("acme-q/v1"));
  enableProfileRegistration(false);
  assert.ok(!knownProfiles().includes("acme-q/v1"));
});

test("动词槽位：注册表声明名字，CLI 分派查表 —— 两边是同一张表", () => {
  // 分派此前是三个写死的 else if（media / style / codemap），核心的命令行因此
  // 按名字认识三份词汇表。现在名字由注册表声明；这条断言把两边钉在一起。
  const declared = new Set(Object.values(PROFILES).flatMap((d) => d.verbs ?? []));
  for (const v of ["media", "style", "codemap", "history"]) {
    assert.ok(declared.has(v), `${v} 应当由某份词汇表声明`);
  }
  // 每个声明的动词都真的能跑（history 走核心那条路径，其余走 PROFILE_VERBS）
  for (const v of declared) {
    const r = spawnSync(process.execPath, [CLI, v], { encoding: "utf8" });
    assert.notEqual(r.status, 0, `${v} 无参数应当报用法`);
    assert.match((r.stdout ?? "") + (r.stderr ?? ""), /usage|unknown .* subcommand/i,
      `${v} 应当认得自己，而不是落进「unknown command」`);
  }
});

test("动词槽位：没被任何词汇表声明的词仍然是「unknown command」", () => {
  const r = spawnSync(process.execPath, [CLI, "acme-nope"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match((r.stderr ?? ""), /unknown command/);
});

test("geml-agent/v1：五个 agent-* 类型被放行，声明与否只差诊断", () => {
  const doc = (declared) =>
    "=== meta\n" + (declared ? 'profile = "geml-agent/v1"\n' : "") + 'title = "t"\n===\n\n'
    + '=== agent-vars {#vars}\n{"type":"object","properties":{}}\n===\n\n'
    + '=== agent-state {#a initial tools="read_file" vars=none rollback-on-error}\nDo the thing.\n===\n\n'
    + '=== agent-state {#b final}\nStop.\n===\n\n'
    + '=== agent-transition {#a-b from=#a to=#b requires=#g approval}\nGo.\n===\n\n'
    + '=== data {#g format=json}\n{"type":"object"}\n===\n\n'
    + '=== agent-snapshot {#rev-0 rev=0 state=#a cause=enter hash="sha256:00" at="2026-01-01T00:00:00Z"}\n{}\n===\n\n'
    + '=== agent-refused {#refused-1 rev=0 at="2026-01-01T00:00:00Z" tool=agent_set}\n{"reason":"r","diagnostics":[]}\n===\n';
  assert.deepEqual(parse(doc(true)).diagnostics, [], "declared: no diagnostics at all");
  const undeclared = parse(doc(false)).diagnostics.map((d) => d.code);
  assert.equal(undeclared.filter((c) => c === "unknown-block-type").length, 6, "undeclared: every agent-* block warns");
});

test("geml-agent/v1：agent-state / agent-transition 的体是 flow，其余是 raw", () => {
  const src = '=== meta\nprofile = "geml-agent/v1"\n===\n\n'
    + '=== agent-state {#a initial}\nRead [[#a]] first.\n\n- one\n- two\n===\n\n'
    + '=== agent-vars {#v}\n{"type":"object"}\n===\n';
  const d = parse(src);
  const state = d.children.find((b) => b.kind === "block" && b.type === "agent-state");
  const vars = d.children.find((b) => b.kind === "block" && b.type === "agent-vars");
  assert.equal(state.mode, "flow");
  assert.equal(state.children.some((c) => c.kind === "list"), true, "flow body parsed the list");
  assert.equal(vars.mode, "raw");
  assert.deepEqual(vars.raw, ['{"type":"object"}']);
});

test("geml-agent/v1：放行的属性键只挂在各自类型上", () => {
  const v = vocabularyFor(meta({ profile: "geml-agent/v1" }));
  assert.equal(v.attrs.get("agent-state")?.has("rollback-on-error"), true);
  assert.equal(v.attrs.get("agent-transition")?.has("requires"), true);
  assert.equal(v.attrs.get("agent-snapshot")?.has("restores"), true);
  assert.equal(v.attrs.get("agent-refused")?.has("tool"), true);
  assert.equal(v.attrs.get("agent-vars"), undefined, "agent-vars declares no keys");
  assert.equal(v.attrs.get("agent-state")?.has("requires"), false);
});
console.log(`\n${passed} passed`);
