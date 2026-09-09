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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("播种连带写出入口清单：只播样式表的话，那份样式表没有入口可达", () => {
  // 一个根的样式入口只有 `_index/index.geml` 这一个固定路径 —— 宿主只探它。
  // 所以「播种样式表」和「播种入口」是一件事的两半，缺一半等于没播。
  const dir = mkdtempSync(join(tmpdir(), "geml-gs-"));
  loadOrSeedGraphStyle(dir);
  const mfPath = join(dir, "_index", "index.geml");
  assert.equal(existsSync(mfPath), true, "入口清单和样式表一起落地");
  const mf = parse(readFileSync(mfPath, "utf8"));
  assert.deepEqual(mf.diagnostics.filter((x) => x.severity === "error"), [], "清单本身要 check 干净");
  const meta = mf.children.find((b) => b.kind === "block" && b.type === "meta");
  assert.equal(meta.data.profile, "geml-style/v1", "meta 自证 —— 宿主靠它认，不靠文件名");
  assert.equal(meta.data["default-style"], "style.geml", "default-style 指向刚播下的那份");
});

test("播种：两个文件各自独立 —— 删掉一个，下次只补那一个", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-gs-"));
  loadOrSeedGraphStyle(dir);
  const mfPath = join(dir, "_index", "index.geml");
  const stylePath = join(dir, "_index", "style.geml");
  // 手工改过入口清单（比如加了 #sitemap 表），样式表存在时不能被重写回默认。
  const mine = '=== meta\nprofile = "geml-style/v1"\ndefault-style = "style.geml"\n===\n\n我改过。\n';
  writeFileSync(mfPath, mine);
  const again = loadOrSeedGraphStyle(dir);
  assert.equal(again.seeded, false, "样式表已在，不算新播");
  assert.equal(readFileSync(mfPath, "utf8"), mine, "入口清单不得重写 —— 和 style.geml 一样 edit freely");
  // 反过来：只删入口，样式表留着 —— 下一次 build 把入口补回来，样式表不动。
  const styleBytes = readFileSync(stylePath, "utf8");
  rmSync(mfPath);
  loadOrSeedGraphStyle(dir);
  assert.equal(existsSync(mfPath), true, "缺的那一半补回来了");
  assert.equal(readFileSync(stylePath, "utf8"), styleBytes, "在的那一半没被碰");
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
  // 真实的 map 是 build 产出的，所以夹具也要带上**入口清单** —— 渲染器只经
  // `_index/index.geml` 找样式表，一份只有 style.geml 的目录按定义就是「没指派」。
  if (style !== null) {
    writeFileSync(join(dir, "_index", "style.geml"), style);
    writeFileSync(join(dir, "_index", "index.geml"),
      '=== meta\nprofile = "geml-style/v1"\ndefault-style = "style.geml"\n===\n');
  }
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

test("渲染：有 style.geml 但没有入口清单 → 默认旋钮，不偷偷直读那份样式表", () => {
  // 发现路径只有一条：`_index/index.geml`。一份从旧版本升上来的 map 只有 style.geml，
  // 于是它的旋钮**暂时失效**，直到重新 build 把入口播回来。这是明写的取舍 ——
  // 保留「找不到入口就直读 style.geml」的回落，等于永久留着第二套语义。
  const dir = codemapDir(null);
  writeFileSync(join(dir, "_index", "style.geml"),
    '=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + '=== style-rule {#graph match="diagram[format=geml-code-graph]" fold=3 depth=2}\n===\n');
  assert.deepEqual(graphData(dir).style, defaultGraphStyle(), "没有入口就没有指派");
  // 重新 build（这里就是播种那一步）把入口补回来，同一份 style.geml 立刻生效。
  loadOrSeedGraphStyle(dir);
  const after = graphData(dir).style;
  assert.equal(after.fold, 3, "补上入口后，原来那份 style.geml 的旋钮生效");
  assert.equal(after.depth, 2);
});

test("渲染：default-style 命中与否都加载，#sitemap 那份叠在上面并优先", () => {
  // 和 CSS 同一个模型。默认层写了 fold 和 hide-accessors，指派的那份只写 depth 和
  // fold —— 于是结果里 depth/fold 来自指派那份（它优先），hide-accessors 落回默认层。
  // 「替换」式实现在这一条上会露馅：hideAccessors 会变回 true。
  const dir = codemapDir('=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + '=== style-rule {#graph match="diagram[format=geml-code-graph]" \\\n'
    + '                fold=3 hide-accessors=false}\n===\n');
  writeFileSync(join(dir, "_index", "special.geml"),
    '=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + '=== style-rule {#graph match="diagram[format=geml-code-graph]" fold=5 depth=4}\n===\n');
  writeFileSync(join(dir, "_index", "index.geml"),
    '=== meta\nprofile = "geml-style/v1"\ndefault-style = "style.geml"\n===\n\n'
    + "=== table {#sitemap}\n| document | template |\n|---|---|\n| index.geml | special.geml |\n===\n");
  const s = graphData(dir).style;
  assert.equal(s.fold, 5, "两层都写了 fold —— 指派的那份优先");
  assert.equal(s.depth, 4, "只有指派那份写了 depth");
  assert.equal(s.hideAccessors, false, "只有默认层写了 hide-accessors —— 它必须活下来");
});

test("叠加：一层写了默认值，也不能被上层的『没写』盖掉", () => {
  // 要点：读出来的只有「这份文档真的写了」的键。若某层把 fold 写成 1
  // （恰好等于默认值），它仍然是一次**显式**赋值；反过来，上层没提 fold 就不该
  // 把 fold 重置回 1。这两个方向都在这里钉住。
  const dir = codemapDir('=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + '=== style-rule {#graph match="diagram[format=geml-code-graph]" fold=4 depth=9}\n===\n');
  writeFileSync(join(dir, "_index", "special.geml"),
    '=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + '=== style-rule {#graph match="diagram[format=geml-code-graph]" fold=1}\n===\n');
  writeFileSync(join(dir, "_index", "index.geml"),
    '=== meta\nprofile = "geml-style/v1"\ndefault-style = "style.geml"\n===\n\n'
    + "=== table {#sitemap}\n| document | template |\n|---|---|\n| index.geml | special.geml |\n===\n");
  const s = graphData(dir).style;
  assert.equal(s.fold, 1, "上层显式写的 1 生效 —— 它不是『没写』");
  assert.equal(s.depth, 9, "上层没提 depth，默认层的 9 活下来（没被重置成 6）");
});

test("渲染：入口清单 meta 不自证 → 当作没有入口，不硬当清单读", () => {
  // 名字用来找，meta 用来认。这个路径上放了别的东西时降级到默认旋钮。
  const dir = codemapDir('=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + '=== style-rule {#graph match="diagram[format=geml-code-graph]" fold=3}\n===\n');
  writeFileSync(join(dir, "_index", "index.geml"),
    '=== meta\ntitle = "我不是样式清单"\ndefault-style = "style.geml"\n===\n');
  assert.deepEqual(graphData(dir).style, defaultGraphStyle());
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
