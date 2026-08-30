# GEP-0008 的证据

[GEP-0008](../../../spec/proposals/0008-form-block.md) 给自己设了一条准入门槛：
**先用现有载体（`table` / `data`）做出真实表单，让它们硌手的地方决定字段词汇，
而不是猜。** 这里是那些表单，测量可复现。

| 文件 | 载体 | 压的是什么 |
|---|---|---|
| [`build-options.geml`](build-options.geml) | `table` | `geml codemap build` 的真实 flag：枚举、路径、布尔、可重复项、互斥组 |
| [`gep-submit.geml`](gep-submit.geml) | `data` | GEP 提交：分组、条件分组（`showIf`）、日期、URL、长文章节 |
| [`forms.style.geml`](forms.style.geml) | — | 把两者绑到 `component=form handler=submit` 的样式表 |

第三个表单——vercel/next.js 的 "Report an issue"（44 选项，其中 23 个含空格；
15 个 markdown 链接跨 5 段）——**没有收录**：耐用的是测量，模板是别家的内容。
它的数字写在 GEP 正文里。

## 跑

```bash
geml check docs/examples/forms/build-options.geml
geml style check docs/examples/forms/forms.style.geml docs/examples/forms/*.geml
```

`forms.style.geml` 声明 `profile = "geml-style/v1"`，所以 `geml style check`
需要 geml-style profile 已经落地。**本目录因此排在 geml-style 之后**；
在那之前这三个文件是惰性的（`style-rule` 只会得到一条 unknown-block-type warning，
不是错误）。

## 它们测出了什么

两种载体**精确互补，各缺一半**：

| | `table` | `data` |
|---|---|---|
| 标签/帮助里的 inline（链接、粗体、code） | **保留**——完整的 `[text](url)` 解析成真 `link` | 纯字符串，反引号是字面量 |
| 嵌套 / 分组 / 条件 | 矩形，不行 | **可以** |
| enum 是真列表 | 空格分隔字符串——44 选项里 23 个含空格时直接失效 | **真数组** |
| 多段值 | 换行必须编码 | **可以** |
| 帮助文本里的分隔符 | **吃掉后半句**（`--lang JAVASRC\|NEWC` 只剩前半） | JSON 转义，没事 |
| 寻址一个字段 | 不行 | 不行 |

真实表单**两半同时要**：一个 44 选项的多选，描述里 15 个链接跨 5 段。
而 `table` 的绕法要另起一张表用 `field` 列做外键——**51 行，没有任何东西检查它**。
正是这个格式存在要消灭的那种悬空指针。
