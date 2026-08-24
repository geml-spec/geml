# `geml mcp` —— 通过 MCP 按块编辑文档

*[English](mcp-guide.md) | 中文*

让 Claude 改文档里的**一个块**，而不是重写整个文件；坏的编辑在落盘之前就被拦住，改错了也能一块一块地撤回。

当 `--root` 下同时存在**代码图**时，同一个 server 再挂上四个只读的调用图工具——一个客户端入口、一个进程，而不是两个。它取代了原先独立的 `geml codemap mcp` server（已被删除）；如果你注册过那个，请换成 `geml mcp --root <dir>`。

## 安装

```sh
npm install -g @geml/geml
```

```sh
claude mcp add geml -- geml mcp --root /abs/path/to/your/docs
```

或者写进 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "geml": {
      "command": "geml",
      "args": ["mcp", "--root", "/abs/path/to/your/docs"]
    }
  }
}
```

`--root` 是必填的，而且是这个 server **唯一**会读写的目录。客户端无法覆盖或放宽它：工具收到的每一个路径都要经它解析，且在检查之前先跟随符号链接——所以 `../../etc/passwd` 逃不出去，工作区内埋下的符号链接也逃不出去。

## 同时服务代码图

把 `--root` 指向仓库，server 会自动发现 `<root>/.geml-code-graph`，并把四个 `geml_codemap_*` 工具加进同一份工具清单：

```sh
geml codemap build --root /abs/path/to/repo      # 先建一次图
claude mcp add geml -- geml mcp --root /abs/path/to/repo
```

如果图放在 root 内的别处，用 `--graph <dir>` 指定。**没有图时这些工具根本不会出现在清单里**，所以客户端永远不会看到一个自己用不了的工具。

图工具是只读的，但它们现在与写操作共享一个进程——所以客户端传来的 `graph_dir` 和其他路径一样被限制在 `--root` 内，而不像旧的独立 server 那样可以任意指定目录。`$GEML_GRAPH_DIR` 在这里同样被忽略，理由一致：能让 server 摸到什么，由选定 `--root` 的那个人决定，不由它继承到的环境决定。

## 工具清单

每个工具都以它包装的那条命令命名——`geml set` 就是 `geml_set`，`geml codemap search` 就是 `geml_codemap_search`——所以 CLI 和工具是同一套词汇，学一次就够。

| 工具 | 做什么 |
|------|--------------|
| `geml_list` | 每一个可寻址的块：地址、种类、标题文本 |
| `geml_find` | 搜块内容——答案是地址，绝不是行号 |
| `geml_get` | 按 id 取一个块，不是整个文件；`part` 把一节切成 `head` / `intro` / `body` |
| `geml_check` | 带稳定代码的诊断（[附录 A](../spec/GEML-spec.md#appendix-a-diagnostic-catalogue)） |
| `geml_history` | 已记录的修订，最新在前 |
| `geml_to` | 转换整篇文档——`json` / `md` / `geml` / `html`；不写任何文件 |
| `geml_set` | 替换一个块（整块 / head / body） |
| `geml_add` | 插入块或散文（append / before / after） |
| `geml_delete` | 按 id 删除块 |
| `geml_rename` | 重命名一个 id，**以及指向它的每一处引用** |
| `geml_revert` | 撤回**一个块**——它最近一次改动，或指定的某个修订 |

`geml_list` 报告**每一个**块，包括作者从未给过 `#id` 的那些，每个都带一个 `address`——而这个地址可以直接喂回 `geml_get` 和 `geml_set`，所以没有 id 的块在这里也能读能写，不只在 CLI 里能。参数名仍然叫 `id`，仍然接受一个裸 id；它只是同时也接受清单里打印出来的其他形式（`## Heading`、`=== type`、`@<hex>`）。内容地址在你写入该块之后会变，所以第二次编辑前请从 `geml_list` 重新取一次；另外注意 `geml_set` 遇到匹配多个块的地址会拒绝，而不是替你挑一个。

`geml_add`、`geml_delete`、`geml_rename` 和 `geml_revert` 仍然只接受 id——它们对应的 CLI 命令也是如此，在这里接受地址就等于承诺了背后那条命令会拒绝的事。

`--root` 下有代码图时，再多四个（全部只读）：

| 工具 | 做什么 |
|------|--------------|
| `geml_codemap_search` | 按名字找符号——默认子串匹配，加 `exact` 匹配全名 |
| `geml_codemap_list` | 列模块，或某个模块的符号——手上没有名字可搜时用它浏览 |
| `geml_codemap_node` | 打开一个节点：符号的块（加 `source: true` 连它真实的源码行一起），或 `#calls` / `#called-by` / `#unresolved` 表 |
| `geml_codemap_callchain` | 多跳链路，以树呈现——`callees` 往下游，`callers` 看影响面 |

`geml_codemap_search` 和 `geml_codemap_callchain` 是把 agent 从「一跳一次调用」的跑步机上救下来的两个：前者是因为你手上通常只有一个子串（`exact` 留给你知道全名的时候），后者是因为一条三层链路否则就是三次往返、每次驮一整个符号块。链路打印的每一行都是完整的 `doc.geml#id`，可以直接喂回 `geml_codemap_node`，不必先搞清它属于哪份文档。调用**点**（`file:line`）在 `#called-by` 表里——用 `geml_codemap_node` 读它。

符号的块里存的是一个**指针**（`src=path#Lstart-end`），不是代码本身。`geml_codemap_node(doc, id, source: true)` 会顺着它取回该符号自己的那几行，带行号——和本地 viewer 在侧栏里显示的是同一份源码，所以一次查询不必以「现在你自己去开文件吧」收尾。它默认关闭，因为节点常常是在循环里被打开的，那时指针就够了。

源码在哪，用的是图自己记录的答案（`_index/refresh.json`，`geml codemap serve` 用的也是这一份）。那个文件在图里面，所以 `geml mcp` 同样把它限制在 `--root` 内：手工改过、指向外面的配方会被拒绝而不是被照做，解析到源码树之外的 `src=` 也一样。

**建图和刷新图仍然只在 CLI 上**（`geml codemap build` / `refresh`）：两者都会跑索引器或记录下来的 shell 步骤，`refresh` 因此还挡着一道信任门——这不是应该让模型触发的事。`geml codemap serve` 渲染给人看的 HTML，模型消费不了。

## 它和直接改文件差在哪

**写入在落盘之前就被校验。** 每一次变更都先在不碰文件的前提下算出来；然后解析*结果*；只有结果干净才覆盖文件。坏的编辑会连同拒绝它的诊断一起被退回：

```json
{ "ok": false,
  "diagnostics": [
    { "severity": "error", "code": "unresolved-reference",
      "message": "unresolved reference `#ghost`", "line": 12 }
  ],
  "hint": "… The write was refused; the file on disk is unchanged." }
```

那个 `hint` 是给模型看的：不明确告诉它文件没变，模型读到「error」就会当作自己的编辑已经生效然后继续往下走。

**每次写入之前都先存一条历史修订**，所以 `geml_revert` 总有一个可回退的目标。用 `--no-history` 可以关掉；默认是开的，因为没有它，这套工具里最强的那个就无处可回退。

**`geml_revert` 只撤一个块。** 一次坏编辑之后，你恢复的是那一个块，而文档的其他每一个字节——包括这期间做的好的编辑——都保持原样。通用的文件编辑工具能从快照还原整个文件；没有一个能放回单独一个块。

不带 `rev` 调用时，它撤的是**该块最近一次改动**，中间还有多少别的块被改过都不影响。这件事比听起来重要：历史是每次写入存一份整篇文档的快照，所以 `-N` 偏移是一个*文档*游标，而某个块的上一版内容落在第几个 N，取决于之后又发生了多少次无关的写入——这个数字调用方根本无从得知。只在你确实要某个特定修订时才传 `rev`：

```
geml_revert(file, id)                 # 撤回我对这个块的最近一次编辑
geml_revert(file, id, rev="-2")       # 去某一个特定的文档快照
geml_revert(file, id, rev="c9d5f1cc") # 去某一个特定的修订 id
```

重复调用不会继续往前走——它会在该块最近两个版本之间来回切。撤一次，看一眼结果，需要更往前就从 `geml_history` 里取一个明确的 `rev`。

## 两条值得知道的行为

**删除一个被引用的块是允许的。** 因此悬空的引用会报在 `diagnostics` 里，但不会阻止删除——有意移除某样东西是正当操作，修还是还原由调用方决定。

**一份本来就有错误的文档会被锁住，直到错误被修好。** 写前检查会拒绝任何含 error 的结果，包括文档原本就有的那些，所以在一份坏文档里编辑一个无关的块同样会被拒。拒绝信息会把这一点讲明白——错误早于这次编辑、以及具体是哪几条——所以正确的做法是先把它们修掉。修它们本身从不被阻止。

## 试一下

```
> 列出 spec.geml 里的块
> 读 #budget
> 把 #budget 的正文改写成提到 Q3
> 改错了——把 #budget 撤回去
```

## 排障

| 现象 | 原因 |
|---------|-------|
| `--root <dir> is required` | server 宁可不启动，也不会去服务整个文件系统。 |
| `path escapes the server root` | 路径解析到了 `--root` 外面。请用相对该 root 的路径。 |
| `graph_dir escapes the server root` | 代码图工具同一条规则：目录必须在 `--root` 里面。 |
| 代码图工具不见了 | 没找到图。跑 `geml codemap build --root <dir>`，或者传 `--graph <dir>`。 |
| 一次写入反复被同一个错误拒掉 | 那个错误早于你这次编辑。跑 `geml_check` 先把它修掉。 |
| `no .gemlhistory sidecar yet` | 还没有任何东西经这个 server 写过；第一次写入会创建它。 |
