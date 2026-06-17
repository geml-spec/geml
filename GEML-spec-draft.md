# GEML — General Expressive Markup Language · Mini Spec (Draft)

- **Working name / 工作名**: GEML (General Expressive Markup Language)
- **Version / 版本**: 0.1 (draft / 草案)
- **File extension / 文件后缀**: `.geml`

---

## 1. Constraints / 约束

**EN**
1. A `.geml` file MUST be fully readable as plain text without rendering.
2. Code, diagrams, tables, math and callouts MUST share the single typed-block
   primitive (§3); no per-content grammar.
3. Every block MAY carry a stable `id`; references MUST be resolved and validated
   at build time (§5).
4. Graphics MUST embed an external DSL; the format defines the hosting protocol
   only, never a diagram language (§7).
5. There is no raw-HTML escape hatch; semantics are not tied to any backend.
6. Headings use ATX `#` only. Setext headings and `---`/`===` thematic-break or
   frontmatter rules are not part of GEML.

**中文**
1. `.geml` 文件必须无需渲染即可作为纯文本完整阅读。
2. 代码、图形、表格、公式、提示框必须共用唯一的类型块原语（§3）；不为每种内容
   单设语法。
3. 每个块可携带稳定 `id`；引用必须在构建时解析并校验（§5）。
4. 图形必须内嵌外部 DSL；格式只定义托管协议，绝不内建图形语言（§7）。
5. 不存在原始 HTML 逃逸口；语义不绑定任何后端。
6. 标题只用 ATX `#`。setext 标题与 `---`/`===` 分隔线、frontmatter 规则不属于 GEML。

---

## 2. Document model / 文档模型

**EN** — A document is a sequence of **blocks**, in two shapes:
- **Flow blocks**: paragraphs, headings, lists — body parsed as inline GEML.
- **Typed blocks**: fenced; body handling decided by the block *type* (raw or flow).

Every block MAY carry an **attribute object** `{#id .class key=val}`. Inline
content exists only inside flow blocks.

**中文** — 一篇文档是**块**的序列，块只有两种形态：
- **流式块**：段落、标题、列表——正文按内联 GEML 解析。
- **类型块**：带围栏；正文如何处理由块*类型*决定（raw / flow）。

每个块可携带**属性对象** `{#id .class key=val}`。内联内容只存在于流式块中。

---

## 3. Typed-block primitive / 类型块原语

**EN**
```
=== <type> <attrs>?
<body>
===
```
- The fence is a run of `=` (≥3). The closing fence MUST be a run of `=` of
  exactly the opening length; a shorter or longer run does not close the block.
- Nesting uses longer fences (`====` wraps `===`).
- The **type registry** declares each type's body mode: `raw` (verbatim, e.g.
  `code` with `lang=`, `diagram`/`table` with `format=`, `math`) or `flow`
  (parsed, e.g. `note`, `aside`).
- An unknown type is a build warning; its body is preserved as raw.

**中文**
```
=== <类型> <属性>?
<正文>
===
```
- 围栏是连续的 `=`（≥3 个）。闭合围栏必须是与开围栏**等长**的 `=` 串；更短或更长
  的串都不闭合该块。
- 嵌套用更长的围栏（`====` 包住 `===`）。
- **类型注册表**声明每种类型的正文模式：`raw`（原样，如带 `lang=` 的 `code`、带
  `format=` 的 `diagram`/`table`、`math`）或 `flow`（解析，如 `note`、`aside`）。
- 未知类型产生构建告警，其正文按 raw 保留。

### EBNF (draft) / EBNF（草稿）

```ebnf
document      = { block } ;
block         = flow-block | typed-block ;

typed-block   = fence , SP , type , [ SP , attrs ] , NL ,
                body ,
                close-fence ;
fence         = "===" , { "=" } ;            (* open: N equals signs, N>=3 *)
close-fence   = fence ;                       (* exactly equal to opening length *)
type          = NAME ;
body          = { LINE } ;                    (* raw or flow per registry *)

attrs         = "{" , { attr-item , [ SP ] } , "}" ;
attr-item     = id-attr | class-attr | kv-attr ;
id-attr       = "#" , NAME ;
class-attr    = "." , NAME ;
kv-attr       = NAME , "=" , value ;
value         = bare-word | quoted-string ;

flow-block    = heading | list | paragraph ;
heading       = "#" , { "#" } , SP , text , [ SP , attrs ] , NL ;
NAME          = ALPHA , { ALPHA | DIGIT | "-" | "_" } ;
```

---

## 4. Attributes & identifiers / 属性与标识符

**EN**
- `{#budget}` sets block id `budget`. Ids MUST be unique per document.
- `{.warning}` adds a semantic class (no styling implied).
- `{caption="Annual cost"}` and other `key=val` pairs are type-defined params.
- A heading auto-derives an id from its text; an explicit id is written as a
  trailing attribute object on the heading line, e.g. `## Title {#sec}`.
- Attribute value typing: a quoted `"…"` is always a string; `true`/`false` is a
  boolean; a bare word matching integer/float syntax is a number; any other bare
  word is a string. Arrays, dates and nested tables are not supported.

**中文**
- `{#budget}` 设定块 id 为 `budget`。文档内 id 必须唯一。
- `{.warning}` 添加语义类（不含样式）。
- `{caption="年成本"}` 等 `key=val` 是各类型自定义的参数。
- 标题的 id 未显式给出时按文本自动生成；显式给出时写在标题行末尾的属性对象里，
  如 `## 标题 {#sec}`。
- 属性值类型：带引号 `"…"` 恒为字符串；`true`/`false` 为布尔；匹配整数/浮点
  语法的裸词为数字；其余裸词为字符串。不支持数组、日期与嵌套表。

---

## 5. Inline content & links / 内联内容与链接

### 5.1 Inline elements / 内联元素

**EN** — Inline elements appear only inside flow blocks.

| Syntax | Meaning |
|--------|---------|
| `*emphasis*` | emphasis |
| `**strong**` | strong |
| `` `code` `` | code span (verbatim; nothing parsed inside) |
| `~~strike~~` | strikethrough |
| `$…$` | inline math (verbatim body) |
| `![alt](src)` | inline image; an attribute object is allowed: `![alt](src){#fig}` |
| `\` at line end | hard line break |
| `\` + ASCII punctuation | escape: the punctuation is literal |

- Emphasis/strong delimiters MUST attach to a non-space character and MUST NOT
  span block boundaries.
- Block-level math uses the `=== math` typed block (§3).

**中文** — 内联元素只出现在流式块内部。

| 语法 | 含义 |
|------|------|
| `*强调*` | 强调（emphasis） |
| `**加重**` | 加重（strong） |
| `` `代码` `` | 代码片段（原样；内部不解析） |
| `~~删除~~` | 删除线 |
| `$…$` | 内联数学（正文原样） |
| `![alt](src)` | 内联图片；可带属性对象：`![alt](src){#fig}` |
| 行尾 `\` | 强制换行 |
| `\` + ASCII 标点 | 转义：该标点取字面值 |

- 强调/加重定界符必须贴住非空白字符，且不得跨块边界。
- 块级数学使用 `=== math` 类型块（§3）。

### 5.2 Links & references / 链接与引用

**EN** — Internal and cross-document references are validated at build time.

| Form | Meaning |
|------|---------|
| `[text](https://…)` | external link |
| `[text](#budget)` | internal ref to block `budget`, explicit text |
| `[[#budget]]` | auto-ref: link text taken from target's caption/heading |
| `[text](other.geml#budget)` | cross-document ref |
| `[^note]` | footnote: renders the block with id `note` as a footnote |

- External link options go in the attribute object: `[text](url){rel=nofollow target=_blank}`.
- An unresolved `#id`, `other.geml#id`, or `[^id]` is a build **error**.
- *Note (non-normative):* backlinks and graph views are a derived inverted index
  over resolved references; GEML adds no syntax for them.

**中文** — 内部与跨文档引用均在构建时校验。

| 形式 | 含义 |
|------|------|
| `[文字](https://…)` | 外部链接 |
| `[文字](#budget)` | 指向块 `budget` 的内部引用，文字自定义 |
| `[[#budget]]` | 自动引用：链接文字取自目标的 caption/标题 |
| `[文字](other.geml#budget)` | 跨文档引用 |
| `[^note]` | 脚注：把 id 为 `note` 的块渲染为脚注 |

- 外链选项放进属性对象：`[文字](url){rel=nofollow target=_blank}`。
- 无法解析的 `#id`、`other.geml#id` 或 `[^id]` 是构建**错误**。
- *注（非规范）：* 反向链接与图谱是对已解析引用的倒排索引，由工具层提供；GEML
  不为此新增语法。

### 5.3 Precedence / 优先级

**EN**
1. Backslash escapes, code spans, and inline math are recognized first; their
   contents are not parsed further.
2. Then images, links, auto-refs (`[[#id]]`), and footnote refs (`[^id]`); a link
   or ref MUST NOT nest inside another link or ref.
3. Then emphasis, strong, and strikethrough.

**中文**
1. 先识别反斜杠转义、代码片段与内联数学；其内容不再进一步解析。
2. 再识别图片、链接、自动引用（`[[#id]]`）与脚注引用（`[^id]`）；链接或引用不得
   嵌套在另一个链接或引用内部。
3. 最后识别强调、加重与删除线。

---

## 6. Tables / 表格

**EN** — Block type `table`, two interchangeable bodies parsed to one model.

**(a) Visual form**
```
=== table {#budget caption="Annual cost"}
| Plan     | Months | Rate |
|----------|-------:|-----:|
| Org      |      1 |   30 |
| AsciiDoc |      2 |   30 |
===
```

**(b) Data form**
```
=== table {#budget format=csv header=1 compute="Total = Months * Rate"}
Plan,     Months, Rate, Total
Org,      1,      30,
AsciiDoc, 2,      30,
===
```

- Merged cells are declared, not drawn: `span="r2c1:2x1"`.
- `compute` formulas operate per row over columns referenced by header name or
  letter, using `+ - * / ( )`; summary rows MAY use the aggregates `sum, avg,
  min, max, count`. No cross-row addressing, conditionals or lookups.

**中文** — 块类型 `table`，两种可互换正文，解析为同一模型。

**(a) 可视化形态**
```
=== table {#budget caption="年成本"}
| 方案     | 人月 | 单价 |
|----------|-----:|-----:|
| Org      |    1 |   30 |
| AsciiDoc |    2 |   30 |
===
```

**(b) 数据形态**
```
=== table {#budget format=csv header=1 compute="小计 = 人月 * 单价"}
方案,     人月, 单价, 小计
Org,      1,    30,
AsciiDoc, 2,    30,
===
```

- 合并单元格用 `span` 声明、不画线：`span="r2c1:2x1"`。
- `compute` 公式按表头名或列字母逐行运算，运算符限 `+ - * / ( )`；汇总行可用
  聚合函数 `sum、avg、min、max、count`。不支持跨行寻址、条件与查表。

---

## 7. Graphics / 图形

**EN** — Block type `diagram` hosts an external diagram DSL.

```
=== diagram {#flow format=mermaid caption="Review flow"}
graph LR
  A[Draft] --> B{Review}
  B -->|ok|   C[Publish]
  B -->|back| A
===
```

- `format` selects a pluggable renderer (`mermaid`, `graphviz`, `d2`, `plantuml`, …).
- Body is `raw` and passed verbatim to that renderer.
- A processor MUST expose the renderer registry and MUST NOT interpret the body.
  An unknown `format` is a warning; body is preserved.
- `#flow` makes the diagram referenceable: `see [[#flow]]`.

**中文** — 块类型 `diagram` 托管外部图形 DSL。

```
=== diagram {#flow format=mermaid caption="评审流程"}
graph LR
  A[草稿] --> B{评审}
  B -->|通过| C[发布]
  B -->|打回| A
===
```

- `format` 选择可插拔渲染器（`mermaid`、`graphviz`、`d2`、`plantuml`…）。
- 正文为 `raw`，原样交给该渲染器。
- 处理器必须暴露渲染器注册表，且不得自行解释正文。未知 `format` 产生告警，保留正文。
- `#flow` 让该图可被引用：`见 [[#flow]]`。

---

## 8. Conformance / 一致性

**EN** — A conforming processor MUST:
1. Parse the typed-block primitive (§3) and the attribute object (§4).
2. Build a document model in which every block id is unique and resolvable.
3. Emit an **error** on any unresolved internal/cross-doc reference (§5).
4. Treat an unknown block `type` and an unknown diagram `format` as **warnings**,
   never errors, preserving the body verbatim.
5. NOT require any specific editor, and NOT depend on raw HTML.

A test suite accompanies the spec: input `.geml` ⇒ expected document-model JSON.
配套测试集：输入 `.geml` ⇒ 期望的文档模型 JSON。

**中文** — 合规处理器必须：
1. 解析类型块原语（§3）与属性对象（§4）。
2. 构建文档模型，其中每个块 id 唯一且可解析。
3. 对任何无法解析的内部/跨文档引用报**错误**（§5）。
4. 把未知块 `type` 和未知图 `format` 当**告警**而非错误，原样保留正文。
5. 不依赖任何特定编辑器，不依赖原始 HTML。

---

## 9. Open questions / 待定问题

**EN**
- Structured metadata: replace the header bullet list with a `=== meta {format=toml}`
  block?
- Multilingual content: a block-level `{lang=…}` attribute instead of ad-hoc
  language markers?

**中文**
- 结构化元数据：是否用 `=== meta {format=toml}` 块替代文件头的裸列表？
- 多语言内容：是否引入块级 `{lang=…}` 属性，替代临时的语言标记？
