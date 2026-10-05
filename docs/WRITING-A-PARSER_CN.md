# 用你的语言写一个 GEML 解析器

*[English](WRITING-A-PARSER.md) | 中文*

你能为 GEML 做的最有价值的一件事：照着规范，用另一种语言实现它。两个互相独立、结果一致的解析器，就是这份规范无歧义的证明——也是让 GEML 成为一个标准、而不只是一个仓库的东西。

这是个周末项目，而且你可以自证：复现一组 JSON 一致性用例，然后把规范自己那份 `.geml` 干净地解析出来。打算动手？**开一个 [实现 issue](https://github.com/geml-spec/geml/issues/new?template=implementation.yml)**——我们会帮忙，并把它链到 README 上。不需要一次做完。

## 「合规」是五件事

你的解析器把 GEML 源码变成一个**文档模型**（块与内联节点）。当以下五条成立时，它是一个合规*解析器*（§8.2）：

1. 它复现一致性测试集里的每一个用例（见下）。
2. 它解析 dogfood 规范 [`GEML-spec.geml`](../spec/in_geml_format/GEML-spec.geml) 时**零 `error` 级诊断**——这一份就把围栏、属性、引用、表格、图表和元数据都跑过了。
3. 引用能解析（§8）：每个 `#id` 唯一，且每一个 `[[#id]]`、`[[doc.geml#id]]`、`[text](#id)`、`[^id]`、表格或图表的 `src=`/`data=`、以及 `embed` 的 `src=` 都指向真实存在的东西。
4. 它严格按 **§0.5** 归一化输入：UTF-8、剥掉一个前导 BOM、行尾统一成 LF、`U+0000` → `U+FFFD`。四行代码而已，而跳过它正是第二个实现在真实文件上悄悄与参考实现分道扬镳的最常见原因。
5. 每条诊断都携带 [附录 A](../spec/GEML-spec.md#appendix-a-diagnostic-catalogue) 规定的**代码与严重级别**。消息文字随你怎么写（或翻译）；**代码才是契约**，也正是它让你的错误路径能和我们的对测。

测试集钉住的是规范以算法陈述的部分——内联强调、列表嵌套、id、块结构、归一化、表格、视图和值树；其余交给 dogfood 覆盖。

按 §9，你还欠一份不可信文档两件事：**给递归深度设上界**（块、列表、内联三种嵌套——产出 `*-nesting-too-deep` 错误并继续跑，绝不让栈炸掉），以及**在构建模型时就中和掉非 `http`/`https`/`mailto`/`tel` 的 URL scheme**，而不是留到渲染出口再处理。

规范固定的上界——链跟进多远、值树嵌套多深、表格最多多少格——都在 §9.2 的固定上界表里，值只写在那一处。照着它取；套件里落在这些边界上的用例带 `bound` 字段，漏了哪个它们就会失败。嵌套上界由你自己定，至少是表里的 `nesting-floor`：参考解析器允许 256 层块嵌套与列表嵌套、100 层内联嵌套（`geml-parser/src/bounds.ts`）。§9.2 要求的、一个文档从别处读入的格子总上限也由你定——每个 view 都复制一份来源，一张百万格的表上开二十个 view 就是两千万格：参考实现到 4,000,000 为止。

## 一致性测试集

就是普通 JSON——拷进去，用你自己的测试框架跑。位置在 [`geml-parser/test/conformance/`](../geml-parser/test/conformance/)，其中 [`manifest.json`](../geml-parser/test/conformance/manifest.json) 列出每个用例文件及它所需的能力——表格、块 id、块树、诊断……——你的解析器具备哪些能力，就跑能覆盖到的那些文件。每个文件覆盖什么、投影怎么定义，见 [README](../geml-parser/test/conformance/README.md)。

每个用例是 `{ name, geml, want }`：

```json
{ "name": "em inside strong", "geml": "**a *b* c**", "want": "strong(\"a \" em(\"b\") \" c\")" }
```

`want` 是解析后模型的一个**投影**——一个紧凑的字符串。把*你的*模型按同样规则投影一遍，断言它等于 `want`。用例还可能带 `ids`、`addresses`、`blocks` 或 `diagnostics`，或者以字节形式（`geml_base64`）给出输入：你具备哪些能力，就检查哪些。

[`_project.mjs`](../geml-parser/test/conformance/_project.mjs) 是参考投影实现——`want` 字符串就是用它的格式写的。文档**是什么意思**由规范决定：每条用例都从规范原文推出，用例与原文不一致时以原文为准。[`impl2.mjs`](../geml-parser/test/conformance/impl2.mjs) 是一个**只照规范写成**、不 import 参考解析器的完整解析器 + 投影（几百行）——它就是你要做的东西的范例。[`geml-parser-rs/`](../geml-parser-rs/) 则是完整尺寸的那个：按本文、只依据规范与测试集写出的第二个实现，Rust 编写、编译为 WebAssembly，声明了全部能力——某条用例对不上时，可以拿它对照你的模型。

## 建议的实现顺序

每一步都对应规范的一节，以及测它的那组用例。增量做。

0. **归一化输入**（§0.5）——解码 UTF-8、剥一个前导 BOM、把 CRLF/CR 折成 LF、替换 `U+0000`。先做这个，后面每一步都会变简单；而且每一步都保持行数不变，所以你仍然能按行索引回原始字节。→ `normalize.json`
1. **围栏 + 块扫描器**（§2–§3）——一串 `=` 开块，等长的一串闭块，更长的围栏可嵌套；ATX 标题、列表、段落、`%%` 行。→ `fences.json`、`blocks.json`、dogfood
2. **属性对象** `{#id .class key=val}`（§4）——对象从哪里开始、到哪里结束（围栏行到最后一个 `}`；标题取行尾那一组），条目在引号区段之外按 White_Space 切分，值的类型判定；没有 `=` 的裸词是布尔开关。→ `blocks.json`、dogfood
3. **`meta` + `{{key}}` 插值**（§3–§4）——在 flow 源文本里替换，跳过逐字保留的 atom（代码跨段、行内公式）和转义的 `\{{key}}`。→ `interp.json`
4. **内联**（§5）——强调/加粗/删除线（三的规则）、代码、公式、链接、自动引用、脚注、图片、换行、转义。**这是最难的一块，靠 fixtures 撑。** → `inline.json`、`precedence.json`
5. **列表**（§2.1）——序号、`start`、嵌套、紧凑/松散、`[ ]`/`[x]`。→ `lists.json`
6. **引用与校验**（§8）——收集 id、解析引用、对重复和悬空报错。→ `ids.json`、`addresses.json`、dogfood
7. **表格与视图**（§6、§6.1）——竖线网格与 `format=csv`/`tsv` 解析成同一个模型，它装的是事实；`view` 在其上派生，用 `compute=`、`summary=`、`where=`、`order=`、`limit=`、`select=`、`by=`/`aggregate=`。→ `coordinates.json`、`views.json`、dogfood
8. **图形与图表**（§7）——图形正文永不被解释；`geml-chart data=#id` 按引用为一张表作图。→ dogfood
9. **经宿主读文档**（§3.3、§5.2、§9.3、§9.4）——指向其他文档的引用只解析一层、解析根、构建时读的数据文件与路由、投射链条。→ `documents.json`，它的用例给一棵文件树（`files`）和要读的文档（`main`）

第 0 步加 1–5 就得到一个可用的解析器。第 6 步是让 GEML 之所以为 *GEML* 的那一步。7–8 是回报。

## 自证

```
for entry in load("manifest.json").files:
    if not entry.requires ⊆ your_capabilities: continue
    for case in load(entry.file):
        doc = parse_in(case.files, case.main) if case.files else parse(case.geml or decode(base64(case.geml_base64)))
        assert project(doc) == case.want
        # 以及你具备的 ids / addresses / blocks / diagnostics

doc = parse(read("spec/in_geml_format/GEML-spec.geml"))
assert no "error" diagnostic in doc.diagnostics

# §0.5 —— 同一份文档，四种写法，必须得到同一个模型
base = "# T\n\n- a\n- b\n"
assert parse(base) == parse("﻿" + base) == parse(base.replace("\n", "\r\n")) == parse(base.replace("\n", "\r"))

# 附录 A —— 你产出的每个代码都在目录里，且严重级别与目录一致
for d in parse(read("spec/in_geml_format/GEML-spec.geml")).diagnostics + your_error_fixtures():
    assert d.code in APPENDIX_A and d.severity == APPENDIX_A[d.code]
```

测试集全绿 + dogfood 干净 + §0.5 + 附录 A = 一个独立且合规的 GEML 解析器。开个 issue 或 PR（见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)），我们把它加到 README 上。

## 参考

- 规范：[`GEML-spec_CN.md`](../spec/GEML-spec_CN.md)（§0–§9 + 附录 A/B）+ [`geml-history-profile_CN.md`](../spec/profiles/geml-history/geml-history-profile_CN.md)。附录 A 的完整诊断表只在[英文版](../spec/GEML-spec.md#appendix-a-diagnostic-catalogue)——它是规范性的，不作翻译以免漂移。
- [`GEML-spec.geml`](../spec/in_geml_format/GEML-spec.geml)——用 GEML 写成的规范本身；你的端到端测试。
- [`geml-parser/`](../geml-parser/)——参考实现（它是指南；**规范才是定义**）。
