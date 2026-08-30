// geml-code-graph 的显示期调节面（计划 D）。
//
// 存在的理由：codemap 已经有两个调节面，劈得很别扭 —— 构建期折叠在
// `_index/foldings.geml`（一份「edit freely」的 GEML 文档），显示期折叠写死在
// 渲染器 JS 里。这个模块给显示期补上同样的面。
import { parseGraphStyle, defaultGraphStyle, serializeGraphStyle } from "../dist/graph-style.js";
import { parse } from "../dist/geml.js";
import { renderHtml, pageAssets } from "../dist/render-html.js";
import { loadOrSeedGraphStyle } from "../dist/graph-style.js";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

test("默认值就是渲染器今天的行为 —— 反转不改变任何现状", () => {
  const d = defaultGraphStyle();
  assert.equal(d.fold, 1);
  assert.equal(d.depth, 6);
  assert.equal(d.hideAccessors, true);
  assert.equal(Array.isArray(d.palette), true);
  assert.equal(d.palette.length, 12);
});

test("解析：style-rule 上的旋钮覆盖默认值", () => {
  const cfg = parseGraphStyle(
    '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#graph match="diagram[format=geml-code-graph]" fold=2 depth=3}\n===\n'
  );
  assert.equal(cfg.fold, 2);
  assert.equal(cfg.depth, 3);
  assert.equal(cfg.hideAccessors, true, "没写的键保持默认");
});

test("解析：布尔旗标关掉 accessor 隐藏", () => {
  const cfg = parseGraphStyle(
    '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#graph match="diagram[format=geml-code-graph]" hide-accessors=false}\n===\n'
  );
  assert.equal(cfg.hideAccessors, false);
});

test("解析：palette 是空格分隔的色值（§4 不支持数组）", () => {
  const cfg = parseGraphStyle(
    '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#graph match="diagram[format=geml-code-graph]" palette="#111 #222 #333"}\n===\n'
  );
  assert.deepEqual(cfg.palette, ["#111", "#222", "#333"]);
});

test("解析：没有 style-rule 的文档退回默认值，不抛异常", () => {
  assert.deepEqual(parseGraphStyle('=== meta\ntitle = "空"\n===\n'), defaultGraphStyle());
});

test("解析：坏输入退回默认值 —— 调节面坏掉不该让渲染失败", () => {
  assert.deepEqual(parseGraphStyle("=== 这不是 geml"), defaultGraphStyle());
});

test("序列化的种子文件能被自己解析回来", () => {
  const seeded = serializeGraphStyle(defaultGraphStyle());
  assert.deepEqual(parseGraphStyle(seeded), defaultGraphStyle());
});

test("装载：没有文件时播种，并返回默认值", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-gs-"));
  const r = loadOrSeedGraphStyle(dir);
  assert.equal(r.seeded, true);
  assert.deepEqual(r.config, defaultGraphStyle());
  assert.equal(existsSync(join(dir, "_index", "style.geml")), true);
});

test("装载：已有文件时读它，且不重写 —— 和 foldings 一样 edit freely", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-gs-"));
  mkdirSync(join(dir, "_index"), { recursive: true });
  const mine = '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#graph match="diagram[format=geml-code-graph]" fold=2}\n===\n';
  writeFileSync(join(dir, "_index", "style.geml"), mine);
  const r = loadOrSeedGraphStyle(dir);
  assert.equal(r.seeded, false);
  assert.equal(r.config.fold, 2);
  assert.equal(readFileSync(join(dir, "_index", "style.geml"), "utf8"), mine, "不得重写");
});

test("装载：播种出来的文件 geml check 干净（能被 geml style check 验）", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-gs-"));
  loadOrSeedGraphStyle(dir);
  const d = parse(readFileSync(join(dir, "_index", "style.geml"), "utf8"));
  assert.deepEqual(d.diagnostics.filter((x) => x.severity === "error"), []);
});

// ---- 配置随 payload 送进页面
function codemapDir(style) {
  const dir = mkdtempSync(join(tmpdir(), "geml-gs-"));
  mkdirSync(join(dir, "_index"), { recursive: true });
  writeFileSync(join(dir, "index.geml"),
    '=== meta\nprofile = "codemap/v1"\nrepo = t\ncontainer = module\nresolution-default = cpg\n===\n\n' +
    "# Code map\n\n" +
    '=== table {#modules format=csv}\nmodule, doc, methods, entries, tests\na, a.geml, 1, 0, 0\n===\n');
  writeFileSync(join(dir, "a.geml"),
    '=== meta\nprofile = "codemap/v1"\nmodule = a\nresolution-default = cpg\n===\n\n# a\n\n' +
    '=== code {#f anchor="x:a#f()"}\n===\n');
  if (style !== null) writeFileSync(join(dir, "_index", "style.geml"), style);
  return dir;
}

function graphData(dir) {
  const src = '=== meta\ntitle = "t"\n===\n\n=== diagram {#g format=geml-code-graph src=index.geml}\n===\n';
  const html = renderHtml(parse(src), {
    loadDoc: (rel) => { try { return readFileSync(join(dir, rel), "utf8"); } catch { return null; } },
    parseDoc: (text) => parse(text),
  });
  const m = /data-graph="([^"]*)"/.exec(html);
  assert.notEqual(m, null, "应当渲染出 cg-mount");
  return JSON.parse(unescapeAttr(m[1]));
}

/**
 * escAttr 的逆运算。**`&amp;` 必须最后解码**：escAttr 先把 `&` 转义成 `&amp;`，
 * 所以数据里字面量的 `&lt;` 会被写成 `&amp;lt;`；若先解 `&amp;` 再解 `&lt;`，
 * 它就变成了 `<` —— 二次解码，数据被悄悄改写（CodeQL js/double-escaping）。
 * 转义时元字符第一个，解码时元字符最后一个。
 */
function unescapeAttr(s) {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

test("辅助函数：&amp; 最后解码，数据里的字面量 &lt; 不被二次解码", () => {
  // escAttr('a &lt; b & "c"') 的产物 —— 字面量的 &lt; 被写成了 &amp;lt;
  assert.equal(unescapeAttr('a &amp;lt; b &amp; &quot;c&quot;'), 'a &lt; b & "c"');
});

test("渲染：data-graph 里带上 style 配置", () => {
  const dir = codemapDir('=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#graph match="diagram[format=geml-code-graph]" fold=3 depth=2}\n===\n');
  const data = graphData(dir);
  assert.equal(data.style.fold, 3);
  assert.equal(data.style.depth, 2);
});

test("渲染：没有 style.geml 时是默认值 —— 旧 codemap 行为不变", () => {
  const data = graphData(codemapDir(null));
  assert.deepEqual(data.style, defaultGraphStyle());
});

test("运行时读配置而不是字面量：三个旋钮都走 cgStyle/cgFold/cgPalette", () => {
  const js = pageAssets.codeGraphJs;
  assert.match(js, /cgFold\(\)/, "fold 应从配置读");
  assert.match(js, /cgStyle\([^)]*\)\.hideAccessors/, "hideAccessors 应从配置读");
  assert.match(js, /PALETTE = cgPalette\(/, "palette 应从配置读");
  // 回退值仍在（旧页面行为不变），但不再是唯一来源
  assert.match(js, /CG_PALETTE_FALLBACK/, "回退调色板应保留");
});

test("运行时在 boot 里先吃配置 —— deriveView 的 first() 依赖 fold，跑在前面", () => {
  const js = pageAssets.codeGraphJs;
  const boot = js.slice(js.indexOf("function boot("), js.indexOf("function boot(") + 400);
  assert.match(boot, /cgStyle\(data0\)/, "boot 开头必须播种配置");
});

// ---- 拒绝与回退路径：调节面坏掉，渲染照常
test("解析：裸旗标是真布尔值，不是字符串 \"true\"", () => {
  const cfg = parseGraphStyle('=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#g match="diagram[format=geml-code-graph]" hide-accessors}\n===\n');
  assert.equal(cfg.hideAccessors, true);
});

test("解析：嵌在 flow 块里的 style-rule 也找得到", () => {
  const cfg = parseGraphStyle('=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '==== note {#wrap}\n包一层\n\n=== style-rule {#g match="x" fold=4}\n===\n====\n');
  assert.equal(cfg.fold, 4);
});

test("解析：非字符串输入不抛异常，退回默认值", () => {
  assert.deepEqual(parseGraphStyle(null), defaultGraphStyle());
  assert.deepEqual(parseGraphStyle(undefined), defaultGraphStyle());
});

test("解析：负数/零/非数字的 fold、depth 被忽略", () => {
  const cfg = parseGraphStyle('=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#g match="x" fold=0 depth=-3}\n===\n');
  assert.equal(cfg.fold, 1);
  assert.equal(cfg.depth, 6);
});

test("解析：空 palette 不会把配色清空", () => {
  const cfg = parseGraphStyle('=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#g match="x" palette="   "}\n===\n');
  assert.equal(cfg.palette.length, 12);
});

test("装载：style.geml 是个目录时退回默认值，不炸", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-gs-"));
  mkdirSync(join(dir, "_index", "style.geml"), { recursive: true });
  const r = loadOrSeedGraphStyle(dir);
  assert.equal(r.seeded, false);
  assert.deepEqual(r.config, defaultGraphStyle());
});

test("装载：播种写不进去时仍然返回默认值继续渲染", () => {
  // 制造写失败的手段是「该是目录的地方摆一个文件」，不是 chmod。
  // chmod 在 Windows 上只切换**文件**的只读属性，对目录写入毫无作用 —— 种子照样
  // 写成功、seeded 变 true，win32 的 CI 就是这么红的（本地 macOS 全绿）。
  // 而 mkdirSync 撞上同名文件在每个平台都抛（EEXIST / ENOTDIR），
  // 所以这个写法三个 OS 上走的是同一条 catch 分支，覆盖率也不会因平台缺口。
  const dir = mkdtempSync(join(tmpdir(), "geml-gs-"));
  writeFileSync(join(dir, "_index"), "a file where the directory has to go");
  const r = loadOrSeedGraphStyle(dir);
  assert.equal(r.seeded, false, "写不进去就不算播种");
  assert.deepEqual(r.config, defaultGraphStyle());
});

console.log(`\n${passed} passed`);
