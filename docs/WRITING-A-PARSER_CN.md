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

测试集钉住的是有歧义的部分（内联强调、列表嵌套）；其余交给 dogfood 覆盖。

按 §9，你还欠一份不可信文档两件事：**给递归深度设上界**（块、列表、内联三种嵌套——产出 `*-nesting-too-deep` 错误并继续跑，绝不让栈炸掉），以及**在构建模型时就中和掉非 `http`/`https`/`mailto`/`tel` 的 URL scheme**，而不是留到渲染出口再处理。

## 一致性测试集

就是普通 JSON——拷进去，用你自己的测试框架跑。位置在 [`geml-parser/test/conformance/`](../geml-parser/test/conformance/)：

| 文件 | 覆盖什么 |
|------|--------|
| `inline.json` | 强调 / 加粗 / 删除线、三的规则、转义、嵌套 |
| `precedence.json` | atom 与强调的先后：代码、公式、链接、图片、脚注、换行 |
| `lists.json` | 有序/无序、`start`、缩进嵌套、紧凑与松散、任务标记 |

每个用例是 `{ name, geml, want }`：

```json
{ "name": "em inside strong", "geml": "**a *b* c**", "want": "strong(\"a \" em(\"b\") \" c\")" }
```

`want` 是解析后模型的一个**投影**——一个紧凑的字符串。把*你的*模型按同样规则投影一遍，断言它等于 `want`。

### 投影格式

```
文本            "abc"                       （JSON 引号形式）
强调            em( … )
加粗            strong( … )
删除线          s( … )
代码跨段        code("…")
行内公式        math("…")
硬换行          br
图片            img("src")
链接            link("target" children…)    target = href | #anchor | doc#anchor
自动引用        ref("target")
脚注引用        fn("id")
段落            子节点，空格分隔
N 级标题        hN( children… )
列表            ul[…] | ol[…]   松散加后缀 "*"，有序且 start ≠ 1 加 "@N"
列表项          li(…) | li[ ](…) | li[x](…)   嵌套列表附在里面
```

子节点之间用一个空格连接。[`_project.mjs`](../geml-parser/test/conformance/_project.mjs) 是参考投影实现——有任何说不清的地方，以它为准。[`impl2.mjs`](../geml-parser/test/conformance/impl2.mjs) 是一个**只照规范写成**、不 import 参考解析器的完整解析器 + 投影（几百行）——它就是你要做的东西的范例。

## 建议的实现顺序

每一步都对应规范的一节，以及测它的那组用例。增量做。

0. **归一化输入**（§0.5）——解码 UTF-8、剥一个前导 BOM、把 CRLF/CR 折成 LF、替换 `U+0000`。先做这个，后面每一步都会变简单；而且每一步都保持行数不变，所以你仍然能按行索引回原始字节。→ `preliminaries`
1. **围栏 + 块扫描器**（§2–§3）——一串 `=` 开块，等长的一串闭块，更长的围栏可嵌套；ATX 标题、列表、段落、`%%` 行。→ dogfood
2. **属性对象** `{#id .class key=val}`（§4）——值的类型判定；没有 `=` 的裸词是布尔开关。→ dogfood
3. **`meta` + `{{key}}` 插值**（§3–§4）——在 flow 源文本里替换，跳过逐字保留的 atom（代码跨段、行内公式）和转义的 `\{{key}}`。→ `interp.json`
4. **内联**（§5）——强调/加粗/删除线（三的规则）、代码、公式、链接、自动引用、脚注、图片、换行、转义。**这是最难的一块，靠 fixtures 撑。** → `inline.json`、`precedence.json`
5. **列表**（§2.1）——序号、`start`、嵌套、紧凑/松散、`[ ]`/`[x]`。→ `lists.json`
6. **引用与校验**（§8）——收集 id、解析引用、对重复和悬空报错。→ dogfood
7. **表格**（§6）——竖线网格与 `format=csv`/`tsv` 解析成同一个模型；`compute=`、`summary=`。→ dogfood
8. **图形与图表**（§7）——图形正文永不被解释；`geml-chart data=#id` 按引用为一张表作图。→ dogfood

第 0 步加 1–5 就得到一个可用的解析器。第 6 步是让 GEML 之所以为 *GEML* 的那一步。7–8 是回报。

## 自证

```
for file in [inline.json, precedence.json, lists.json, interp.json]:
    for case in load(file):
        assert project(parse(case.geml)) == case.want

doc = parse(read("spec/in_geml_format/GEML-spec.geml"))
assert no "error" diagnostic in doc.diagnostics

# §0.5 —— 同一份文档，四种写法，必须得到同一个模型
base = "# T\n\n- a\n- b\n"
assert parse(base) == parse("﻿" + base) == parse(base.replace("\n", "\r\n"))

# 附录 A —— 你产出的每个代码都在目录里，且严重级别与目录一致
for d in parse(read("spec/in_geml_format/GEML-spec.geml")).diagnostics + your_error_fixtures():
    assert d.code in APPENDIX_A and d.severity == APPENDIX_A[d.code]
```

测试集全绿 + dogfood 干净 + §0.5 + 附录 A = 一个独立且合规的 GEML 解析器。开个 issue 或 PR（见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)），我们把它加到 README 上。

## 参考

- 规范：[`GEML-spec_CN.md`](../spec/GEML-spec_CN.md)（§0–§9 + 附录 A/B）+ [`GEML-history-spec_CN.md`](../spec/profiles/geml-history/geml-history-profile_CN.md)。附录 A 的完整诊断表只在[英文版](../spec/GEML-spec.md#appendix-a-diagnostic-catalogue)——它是规范性的，不作翻译以免漂移。
- [`GEML-spec.geml`](../spec/in_geml_format/GEML-spec.geml)——用 GEML 写成的规范本身；你的端到端测试。
- [`geml-parser/`](../geml-parser/)——参考实现（它是指南；**规范才是定义**）。
