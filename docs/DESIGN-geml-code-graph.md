# 详设:方法级调用链导航(geml-code-graph)—— GEML 载体实现

> **历史文档**:文中 `tools/geml-code-graph/` 原型已交付使命并从仓库删除(git 历史可查);
> 现行实现是 `geml-parser/codemap/`(`geml codemap` 子命令)。

- 状态:**待评审**(评审通过后按本文实现)
- 日期:2026-07-02
- 依据:《方法级调用链导航系统 —— 需求与技术方案》(2026-07-02,下称"原方案")+ GEP-0002 的实证结论(valkey 14,406 节点 / 100,020 边)
- 实现落点:本仓库 `tools/geml-code-graph/` + `.claude/skills/geml-code-graph/`,**零 GEML 标准改动**

## 0. 与原方案的差异清单(评审重点)

本详设完整继承原方案的分层、约束(纯文本 + 引用、不落数据库)与验收标准,但有四处**有意的设计改动**,每处都有实证或明确理由:

| # | 原方案 | 本详设 | 理由 |
|---|---|---|---|
| D1 | 每符号一个 `.md` 文件(原方案开放问题 3/4 自己担心数万小文件) | **每源目录一个 `.geml` 文档,每符号一个 `#id` 块**;`geml get doc.geml '#sym'` 按符号精确取 | valkey 实证:14,406 符号 → 44 文档;寻址粒度不降,文件数降约 300 倍;开放问题 3/4 直接消解 |
| D2 | Markdown + URL 编码锚点链接(死链无检查) | **GEML 引用**(`[[#id]]` / 跨文档 `doc.geml#id`),`geml check` 构建期校验 | 断链 = 构建错误而非静默死链;增量更新(原方案 2.5.2 backlink 传播,全方案最易出 bug 处)获得免费的正确性回归 |
| D3 | 富可读锚点直接当文件名/锚(需 URL 编码,如 `%23`) | 富锚点存 **`anchor=` 属性**,GEML 块 id 用稳定短形 `sym-<slug>-<hash6>` | GEML id 字符集限 `[A-Za-z][A-Za-z0-9_-]*`;不为此扩标准(id 简单性是引用语法可靠解析的地基);名称定位本来就走 name-lookup(F4) |
| D4 | 计算层直接对接渲染层 | 中间加一层**交换格式契约** `symbols.jsonl` / `edges.jsonl`(§3) | 原方案"可插拔换引擎"要成立,必须先把层间数据契约写死;Joern / tree-sitter / code-review-graph 各写一个 adapter 即可互换 |

其余全部照原方案:精度标注(F6)、降级路径(F7)、backlink 独立聚合(2.3.3)、name-lookup 用 JSON 不硬塞 GEML(2.3.4)、edges-manifest 仅内部(2.5.2)、非目标(§1.4)。

## 1. 阶段划分

| 阶段 | 内容 | 达成的原方案需求 | 不做 |
|---|---|---|---|
| **P0(本次实现)** | 交换格式 + `crg-sqlite` adapter(吃现有 code-review-graph 的 `graph.db`)+ GEML emit(文档/backlink/index/name-lookup)+ 变更检测式全量构建 + verify + **skill** | F2 F3 F4 F5(子集) F6 F7 F8;验收 2/3/5/6/7 | F1 精确解析(P0 全部边如实标 `heuristic`) |
| **P1** | `joern` adapter:CPGQL 导出 → 同一交换格式;`cpg` 精度、候选集、confidence 分级 | F1;验收 1 | — |
| **P2 ✅(2026-07-03,部分按触发线缓建)** | `.gemlhistory` 挂接(`build --history`,前置:history 引擎 O(n log n) 按 id 匹配优化,14k 单元 2.9s→0.1s)+ MCP 薄封装(`mcp-server.mjs`,零依赖 stdio)。**精确增量 emit 缓建**:§7 自定触发线为全量重算 >30s,实测 1.2s,远未触发——现行"全量重算+仅写变更"已满足验收 4 的可观测口径(实测:删 1 条边 → 恰好正文+backlink 2 个文档重写并入历史,其余 11 个跳过) | F5(工程目的)+ 历史/回滚 + agent 接口 | 增量 emit 机制(未触发) |

P0 先用 tree-sitter 级数据源的理由:管道、文档形态、agent 消费闭环的验证**不依赖精度**;原方案 §1.4 也明确"第一阶段不要求所有语言精确解析"。P1 换入 Joern 只动 adapter,渲染/存储/消费层零改动——这正是 D4 契约要保证的。

## 2. 架构与数据流

```
计算层 adapters/            交换格式 build/           渲染层                 存储层 graph/
┌─────────────────┐      ┌──────────────────┐      ┌────────────┐      ┌─────────────────────────┐
│ crg-sqlite (P0) │ ───► │ symbols.jsonl    │ ───► │ emit.mjs   │ ───► │ <lang>/<dir>.geml       │
│ joern      (P1) │      │ edges.jsonl      │      │ (确定性)    │      │ _backlinks/<lang>/…geml │
│ (自定义引擎…)    │      │ edges-manifest   │      └────────────┘      │ _index/name-lookup.json │
└─────────────────┘      │ (内部,P2 增量用) │            │             │ index.geml              │
                         └──────────────────┘            ▼             └─────────────────────────┘
                                                    verify.mjs                      │
                                                (geml check 全部文档)                ▼
                                                                          消费层:skill(P0)/MCP(P2)
                                                                          geml get / 跟随引用 / name-lookup
```

职责同原方案四层;`build/` 仅内部,agent 只接触 `graph/`。

## 3. 交换格式(计算层 → 渲染层的契约)

两个 JSON Lines 文件,任何解析引擎写出这两个文件即完成接入。

### 3.1 `build/symbols.jsonl`(每行一个符号)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `anchor` | string | ✓ | 全局唯一富锚点(§4.1),其余字段的主键 |
| `lang` | string | ✓ | `java` / `c` / `python` … |
| `kind` | string | ✓ | `Function` / `Class` / `Test` / `File` / `Type` |
| `name` | string | ✓ | 短名 |
| `file` | string | ✓ | 仓库相对路径(`/` 分隔) |
| `line_start` / `line_end` | int | ✓/– | 定义行号 |
| `signature` | string | – | 完整签名(P0 数据源没有则缺省) |
| `visibility` | string | – | `public`/`private`/`static`…(P1;有则节点加 `.private` 等 class) |
| `is_test` | bool | – | 引擎给的测试用例判定 |
| `resolution` | string | ✓ | 该符号信息的来源:`cpg` / `heuristic` |

### 3.2 `build/edges.jsonl`(每行一条边)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `kind` | string | ✓ | `calls` / `imports` / `inherits` / `tested-by` / `references` |
| `from` | string | ✓ | 源符号 anchor |
| `to` | string | – | 目标符号 anchor;**未解析时缺省** |
| `to_text` | string | – | 未解析时的原文目标名(与 `to` 二选一,不可都缺) |
| `resolution` | string | ✓ | `cpg` / `heuristic` |
| `confidence` | string | ✓ | `high` / `medium` / `low` |
| `candidates` | string[] | – | 虚分发/接口多实现的候选 anchor 列表(此时 `to` 为首选或缺省) |
| `site` | {file,line} | – | 调用点(backlink 页展示用) |

约定:`to` 缺省而 `to_text` 存在的边**不渲染为引用**(不可校验),但参与 `.leaf` 判定(GEP-0002 教训:out-degree 必须含未解析调用,否则 tree-sitter 数据会造假叶子),并在文档中如实列出(§5.3)。

### 3.3 P0 adapter 映射(`crg-sqlite`,吃 code-review-graph `graph.db`)

- symbol:`nodes` 表直映;`anchor = "<lang>:<relfile>#<name>"`,同文件同名冲突追加 `~2`、`~3`(文档序);`resolution = "heuristic"`。
- edge:`CALLS`/`IMPORTS_FROM`/`INHERITS`/`TESTED_BY` → 对应 kind;`target_qualified` 能落到节点 → `to`(`confidence: medium`),否则 → `to_text`(`confidence: low`)。`CONTAINS` 不产边(包含关系 = 文档结构,GEP-0002 已定)。
- 附加信号照搬现有 graph2geml 逻辑:`main` → `.entry`;flows criticality ≥ 0.6 → `.flow-entry`;路径约定 → `.test`;out-degree(含未解析)= 0 且被调 → `.leaf`。

### 3.4 P1 adapter 轮廓(`joern`)

- **语言成熟度调研结论(2026-07-03,原方案开放问题 1 已核实)**。官方 frontend
  列表(docs.joern.io/frontends)覆盖 C/C++、Java(源码/字节码)、JS、Python、
  Kotlin、Go、Ruby、Swift、C#、PHP、二进制(Ghidra),但"存在 frontend ≠ 方法级
  调用解析精度可信",按证据分三梯队:
  | 梯队 | 语言 | 依据 | 策略 |
  |---|---|---|---|
  | 一 | **C/C++、Java、JavaScript、Python** | Joern 起家语言 + 仅有的三个配独立详细文档页的 frontend;历史最久、社区使用最多 | 直接可用 `resolution: cpg` |
  | 二 | Kotlin | 存在多年,文档不完整 | 冒烟测试后用 |
  | 三 | Go、Ruby、Swift、C#、PHP | 2023 年官方博客自述"刚开始开发";gosrc2cpg 2024 年底仍在修调用/CFG bug;无官方声明已达一梯队精度 | **必须先冒烟测试**(见下),不过关即切 tree-sitter 降级 |
- **冒烟测试闸门(二、三梯队语言接入前强制)**:在目标代码库上小规模构建 CPG,
  人工抽查 10–20 处**已知**调用关系(含至少一处跨文件、一处接口/虚分发)是否解析
  正确;不达标该语言即走 `heuristic` 降级路径,不得因"frontend 列表里有"而默认可信。
- **P1 已落地(2026-07-03,valkey `src/`,C=一梯队)**:钉住的 4 处已知关系全部
  通过——同文件 `hashtableFind→findBucket`、跨文件 `initServer→aeCreateEventLoop`
  与 `setGenericCommand→addReply` 均 `confidence: high`;函数指针
  `c->cmd->proc(c)`(`<operator>.pointerCall`)如实进 `calls-unresolved:`。
  **跨文件已解析调用 12(P0)→ 23,235**;9,192 方法 / 66,543 调用点,
  Joern 导出 ≈2–3 分钟,adapter+emit 1.2s,verify 13/13(原方案开放问题 5 的
  耗时口径就此填实)。已知噪音:c2cpg 把大写宏当调用计入 unresolved(如
  `CMD_ADMIN`),诚实无害,后续可过滤。
- **Windows 陷阱(已绕过)**:`joern.bat → repl-bridge.bat` 双层转发会按 cmd.exe
  规则把 `--param k=v` 在 `=` 处重新分词(引号也保不住);导出脚本因此改用
  **环境变量**(`GEML_SRC`/`GEML_OUT`)传参,跨平台稳定。
- 导出:CPGQL 脚本(`joern --script`)遍历 `cpg.method` 与 `cpg.call`,输出 §3.1/3.2 格式;`anchor` 用 Joern 的 `fullName + signature`。
- confidence 映射:唯一静态目标 → `high`;虚分发/接口多实现 → 首选 + `candidates`,`medium`;CHA 兜底宽收敛 → `low`。**不为"看起来精确"强行收敛单一候选**(原方案 2.2 的红线,照抄)。

## 4. 锚点与 id

### 4.1 anchor(富可读,存属性)

沿用原方案 2.3.1 的 SCIP 式命名哲学,格式因引擎而异,唯一性由 adapter 保证:

```
P1(Joern):java:com.example.service.OrderService#calculateTotal(java.util.List)
P0(crg):  c:src/server.c#main        (无签名数据,文件+名称;重名加 ~n)
```

### 4.2 GEML 块 id(稳定短形)

```
sym-<slug>-<hash6>          正文符号块        例:sym-calculateTotal-a3f2c1
bl-<slug>-<hash6>           backlink 块       例:bl-calculateTotal-a3f2c1
```

- `slug` = 符号短名净化为 `[A-Za-z0-9_-]`、截断 24 字符、保证首字符为字母(必要时前缀 `s`);
- `hash6` = `sha256(anchor)` 前 6 位 hex。**id 只由 anchor 决定**:重建、换机器、增量,id 都不漂移(替换现 graph2geml 的 `n<rowid>`——rowid 重建即变,对增量与历史不友好);
- 同文档内 hash6 碰撞时(10⁵ 级符号下概率可忽略),emit 检测并对碰撞双方升 `hash10`;
- 符号改名/改签名 = anchor 变 = 新 id;旧引用悬空 → `geml check` 报错 → 逼着 backlink 同步重渲染。**断链可检测是特性**,不是缺陷。

## 5. 存储层:文档形态

### 5.1 目录约定

```
graph/
  index.geml                          全局索引(入口/测试/规模导航,同现 graph2geml)
  <lang>/<dir-path>.geml              正文:每源目录一文档(路径 / → --)
  _backlinks/<lang>/<dir-path>.geml   backlink:与正文镜像分文件
  _index/name-lookup.json             名称 → 锚点(F4)
build/                                symbols/edges.jsonl、edges-manifest.json(内部)
```

backlink 与正文**分文件**的理由:backlink 内容的变更源自*其它*文档的边变化(原方案 2.5.2);若与正文同文件,一次无关变更就重写正文文档,制造 diff 与历史噪音。镜像分文件让增量重生成的文件集合最小。

### 5.2 正文文档结构

```
=== meta
graph-of = "<repo>"
partition = "src/main/java/com/example/service"
lang = "java"
nodes = 38
tests = 0
resolution-default = "heuristic"      ← P0;P1 为 "cpg"
===

# com/example/service

Entry points: [main — App.java](#sym-main-77ab12) · …      ← 有入口才出现

## OrderService.java {#sym-OrderService-file01}

=== note {#sym-calculateTotal-a3f2c1 .Function anchor="java:com.example.service.OrderService#calculateTotal(java.util.List)" file="src/main/java/com/example/service/OrderService.java" lines="42-58"}
`public BigDecimal calculateTotal(List<Item> items)`

calls: [[#sym-validateItems-9be201]] [getPrice](../model.geml#sym-getPrice-77cd02)
- calls [apply](discount.geml#sym-apply-cd3401) (medium — 接口调用,3 个实现) candidates: [[#sym-apply-ef56aa]] [PercentageDiscount#apply](discount.geml#sym-apply-19c2bb)
calls-unresolved: `formatCurrency` `log.debug`
called-by: [3 个调用点](../../_backlinks/java/com--example--service.geml#bl-calculateTotal-a3f2c1)
===
```

**边行约定(F6 的落地,固定为可 grep 的行首关键字):**

| 行 | 含义 | 校验 |
|---|---|---|
| `calls:` / `imports:` / `inherits:` / `tested-by:` | **默认置信**(= meta 的 `resolution-default`,confidence high/medium 且无候选集)的边,聚合一行,目标为 GEML 引用 | `geml check` 全校验 |
| `- calls … (medium — 说明) candidates: …` | **异常边逐条展开**:低于默认置信、或带候选集、或降级来源(P1 里混入的 heuristic 边标 `(heuristic, low)`) | 引用与候选全校验 |
| `calls-leaf:` | 指向 `.leaf` 符号的边(渲染端可默认淡化/隐藏,GEP-0002 已定) | 校验 |
| `calls-unresolved:` | 未解析目标,**纯 code span 非引用** | 不校验(如实呈现,供 agent 知道盲区) |
| `called-by:` | 指向本符号 backlink 块的单条引用(带计数) | 校验 |

"默认聚合、异常展开"的取舍:方法级 out-degree 常态为个位数,全部逐条展开会让文档膨胀、agent 读取费 token;聚合行覆盖常态,**凡精度可疑处必须显式站出来**——这恰好是 F6 要的"供 agent 判断可信度"。

### 5.3 backlink 文档结构(原方案 2.3.3)

```
=== note {#bl-calculateTotal-a3f2c1 .backlinks anchor="java:…#calculateTotal(java.util.List)"}
`OrderService#calculateTotal` 的调用方(3):
- [checkout](../../java/com--example--controller.geml#sym-checkout-11aa22) — OrderController.java:88
- [generate](../../java/com--example--invoice.geml#sym-generate-33cc44) — InvoiceGenerator.java:23
- [retryPayment](../../java/com--example--payment.geml#sym-retryPayment-55ee66) — PaymentJob.java:41 (medium)
===
```

每条 = 调用方引用 + 调用点(`site`);非默认置信附标注。**backlink 页本身可被链接跳转**(正文 `called-by:` 行指过来),符合"查询即导航"。

### 5.4 name-lookup(原方案 2.3.4)

```json
{ "calculateTotal": [ { "anchor": "java:…#calculateTotal(java.util.List)",
                        "doc": "java/com--example--service.geml",
                        "id": "sym-calculateTotal-a3f2c1" } ] }
```

短名为键;value 直接带 `doc`+`id`,resolve 后一步 `geml get` 即达。规模大时按首字母分片(`name-lookup/a.json` …)——留待实测(原方案开放问题 4 原样保留)。

## 6. 渲染层实现(`tools/geml-code-graph/`,历史路径——现为 `geml-parser/codemap/`)

```
tools/geml-code-graph/
  build.mjs          入口:--adapter crg|joern --db|--project … --root <repo> --out graph/
  adapters/crg.mjs   P0:graph.db → symbols/edges.jsonl(§3.3)
  adapters/joern.mjs P1(§3.4)
  emit.mjs           jsonl → graph/ 全部文档 + name-lookup + index
  verify.mjs         对 graph/ 下所有 .geml 逐个跑 `geml check`,任一失败即非零退出
```

- **emit 确定性**:同输入字节 → 同输出字节(排序:文档按路径、块按 line_start、边按目标 id);写盘前与旧文件比较,**内容相同不落盘**——`mtime` 天然成为"哪些文档真的变了"的证据(P0 就能满足验收 4 的可观测口径)。
- 复用:分区 / 文件分节 / 入口·测试·leaf 标注 / index 生成逻辑自现 `graph2geml.mjs` 迁移演进;`graph2geml.mjs` 本体保留不动(GEP-0002 的实证工具)。
- `verify.mjs` 每次构建收尾必跑:跨文档引用(正文 ↔ backlink 互指)全部经 `geml check` 校验,增量渲染漏更新 = 构建失败。

## 7. 增量更新

- **P0:变更检测式全量**。全量重算 + 确定性 emit + 差异落盘。实证依据:valkey 全量 emit + 45 文档 check < 2s、产物 0.9MB——在 10⁴ 符号量级,"算全量、写增量"已满足 F5 的工程目的(只有受影响文档变化,可由 mtime 验证)。`build/edges-manifest.json`(每符号出边快照)P0 即落盘,为 P2 铺垫。
- **P2:精确传播**。file-hash diff → 受影响符号 → 仅重 emit 其所在文档 + 新旧出边差异涉及的 backlink 文档(原方案 2.5.2 三条规则原样)+ name-lookup 增量。收尾仍全量 `verify`(0.66s@14k,便宜的兜底)。
- 升级触发条件:P0 的全量重算耗时在目标仓库实测超过约 30s 时启动 P2(原方案开放问题 5 的量化口径)。

## 8. 消费层(P0 = skill;MCP 延后 P2)

`.claude/skills/geml-code-graph/SKILL.md`,教 agent 三个动作(与原方案 2.6 三工具一一对应):

| 原方案工具 | P0 实现 |
|---|---|
| `resolve_name` | 读 `graph/_index/name-lookup.json`(精确/前缀匹配) |
| `open_symbol` | `geml get graph/<doc>.geml '#sym-…'` |
| `get_backlinks` | `geml get graph/_backlinks/<doc>.geml '#bl-…'`(正文 `called-by:` 行直接给出目标) |

skill 工作流示例:定位(name-lookup)→ `geml get` 取符号块 → 读 `calls:` 行跟随引用(注意 `(medium…)`/`candidates:`/`calls-unresolved:` 的可信度语义)→ 需要反向时走 `called-by:` → 循环。另附:何时该信 `heuristic` 边、`.leaf`/`.test`/`.entry` class 的过滤用法。

MCP 三工具已交付(P2,`tools/geml-code-graph/mcp-server.mjs`,零依赖 newline-JSON-RPC/stdio;graph 目录经 GEML_GRAPH_DIR 或每次调用的 graph_dir 传入):`claude mcp add geml-code-graph -e GEML_GRAPH_DIR=<abs>/graph -- node tools/geml-code-graph/mcp-server.mjs`。(历史用法;现行等价命令为 `geml codemap mcp`。)

## 9. 验收标准(映射原方案 §4)

| 原方案验收 | 阶段 | 验收方式 |
|---|---|---|
| 2. 调用关系 = 指向其他文档的链接,纯文本 | P0 | 抽查 + `geml check`(引用可解析) |
| 3. 每符号有 backlink 页,可锚点跳转 | P0 | 正文 `called-by:` → backlink 块往返可达 |
| 5. 未覆盖语言降级 + `heuristic` 标注 | P0 | P0 全库即降级形态;meta `resolution-default` + 异常行标注 |
| 6. `resolve_name` 多义不隐藏 | P0 | name-lookup 多候选原样返回 |
| 7. 纯文件系统,无查询语言 | P0 | 目录审查;agent 消费仅 `geml get` + 读 JSON |
| 4. 增量:仅受影响文档被重新生成 | P0(口径)/P2(机制) | mtime / 构建日志;P2 后含 backlink 传播最小集 |
| 1. 精确目标 + 候选集 + 置信度 | **P1 ✅(2026-07-03)** | valkey src/ 冒烟 4/4 过闸(§3.4);候选集/置信度机制经合成夹具验证 |

附加验收(GEML 载体带来的,原方案没有):**verify 全绿**——任何一次构建后 `graph/` 下所有文档 `geml check` 零 error;故意删除一个被引用符号再增量构建,verify 必须失败(证明断链检测有效)。

## 10. 风险与开放问题

1. ~~Joern 语言支持成熟度~~ → **已核实**(2026-07-03,结论与分梯队策略见 §3.4):
   一梯队 C/C++/Java/JS/Python 直接可用;二、三梯队(Kotlin;Go/Ruby/Swift/C#/PHP)
   接入前必须过冒烟测试闸门,不过关即降级 tree-sitter。另注意:官方 quickstart
   示例与实际运行结果有对不上的社区反馈(2026-02),P1 落地时以实测为准、不照抄文档。
2. **P0 数据源跨文件调用缺失**(GEP-0002 实证:valkey 已解析跨文件 CALLS 仅 12 条)→ P0 的 `calls:` 行大多为同文件边 + 大量 `calls-unresolved:`;这是数据源天花板,**文档如实呈现即是 F7 的正确形态**,P1 Joern 换入后同一管道自动变准。
3. **anchor 稳定性(P0)**:无签名数据下重载符号共享 `~n` 序号,文档顺序变化可能导致 `~2`/`~3` 互换 → id 漂移。缓解:`~n` 按 `line_start` 排序分配;P1 有签名后自然消解。
4. **超高频符号的 backlink 页规模**(如被数千处调用的日志函数)→ P0 不处理(列表长但无害);P2 按调用方文档分组折叠。
5. **name-lookup 单文件规模**(原方案开放问题 4)→ 阈值:> 5MB 时分片,留实测。

## 11. 工作量与顺序(P0)

1. `adapters/crg.mjs` + 交换格式(半天)
2. `emit.mjs`(自 graph2geml 迁移 + backlink/anchor/标注/稳定 id,1 天)
3. `verify.mjs` + valkey 全量验收跑通(半天)
4. skill 撰写 + 真实导航演练(半天)
5. GEP-0002 增补 consumer 一节 + README ecosystem 一行(评审通过后一并提交)

P1(Joern)已交付(2026-07-03):joern-export.sc(env 传参)+ adapters/joern.mjs;valkey src/ 实测见 §3.4。P2(精确增量、MCP 封装)待排。
