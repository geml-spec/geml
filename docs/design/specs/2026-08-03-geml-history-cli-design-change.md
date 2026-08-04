# GEML 历史命令 — 设计文档

状态:**全文已实现**(裁定记录见 §9)。§10 是后加的对齐条款,随 `get`/`set` 选择符一并落地。
基线:`origin/main` @ `498be34`。
配套阅读:`2026-08-04-geml-get-set-selector-design.md` —— 顶层 `get`/`set` 的选择符语法。本文 §3.2 的档 2 用的就是那套语法,§10 说明对齐关系。
前置阅读:`2026-07-24-geml-block-mutation-cli-design.md`(§1.1 设计范式、§1.2 动词收敛的回报)、`2026-07-24-geml-revert-history-phase-design.md`(块级 `revert` 的算法与 `--rev` 语法)。

---

## 0. 定稿形态

```
geml history save    <file.geml> [-m msg]
geml history get     <file.geml> [<rev>] [<选择符>] [--json]
geml history restore <file.geml> <rev> [--force]
geml history verify  <file.geml>

geml revert <file.geml> #id [--rev <sel>] …          # 顶层不动,块级
```

选定:`commit` → `save`;`log` / `show` 双双并入 `get`;`restore`、`verify` 保留;`revert` 留在顶层、不搬进 `history`(§3.5)。读历史的动词定为 **`get`** 而非 `show`——理由是它与顶层 `get` 共用「零选择符 = 列表、给选择符 = 那一个」这条已有规则(§1.2),同名同规则比另起一个名字更省心智。

---

## 1. 设计出发点:把块变更那套约束原样搬过来

块变更 CLI 的设计文档定下了两条尺子,这次不发明新的,直接复用——**这正是「命令集收拢」的意思:不是再收一次,是让 history 服从同一套约束**。

### 1.1 「资源是历史本身」——所以留在 `history` 下

你的原话:「资源是历史本身 → 留在 history 下」。这句话就是 §1.1(a)「先给地址、再说做什么」在这一层的应用:

- `geml get doc.geml #intro` —— 资源是**文档里的一个块**,地址是 `file#id`。
- `geml history get doc.geml -3` —— 资源是**这份文档的历史**,地址是 `file` 上的**一条修订**。
- `geml revert doc.geml #intro --rev -3` —— 资源仍是**块**(所以留在顶层),历史只是修饰语。

三条命令的分组由**「谁是资源」**决定,而不是由「实现里读了哪个文件」决定。`revert` 也读 `.gemlhistory`,但它改的是文档里的一个块,所以它不属于 `history` 组——这一条在 §3.5 单独展开,因为它是最容易被质疑「为什么不搬进去」的一处。

### 1.2 「一个动词 = 一个意图 = 一条不变式 = 一种 blast radius」

这是块变更文档 §1.2 的原话。拿它去量今天的五个子命令:

| 今天 | 意图 | 写什么 | blast radius |
|---|---|---|---|
| `commit` | 把当前文件追加为新的 tip | **sidecar** | 只有 `.gemlhistory` 变长一条 |
| `log` | 列出修订 | 不写 | 无(纯读) |
| `show` | 打印某一条修订的全文 | 不写 | 无(纯读) |
| `verify` | 校验链的完整性 | 不写 | 无(纯读) |
| `restore` | 用某条修订覆盖工作文件 | **文档** | 整篇文件被换掉 |

三档 blast radius:**写 sidecar / 不写 / 写文档**。五个动词里,`log` 与 `show` 落在同一档、同一意图(读历史),差别**只是基数**——一个返回多条,一个返回一条。按 §1.2 的标准,它们不是两个动词,是**同一个动词带不带选择符**。

而顶层已经有一个完全同形的先例:

```
geml get doc.geml           # 不给选择符 → 列出全部可寻址 id
geml get doc.geml #intro    # 给了选择符 → 打印那一个块
```

`history get` 是这条规则在历史这层的复读:**不给修订 → 列出全部修订;给了修订 → 打印那一条**。所以 `log` 和 `show` 双双消失,不是因为名字不好听,是因为按已有规则它们本来就该是一个。

剩下三个各自占住一档:`save`(唯一写 sidecar 的)、`restore`(唯一写文档的)、`verify`(唯一只判真假的)。**五收敛到四,并且四个之间没有任何一对能合并**——这是收敛到位的判据,不是巧合。

### 1.3 幂等性:两套框架仍然给同一答案

块变更文档 §1.1(b) 用 SQL/HTTP 双视角推出了每个动词的幂等性。同一张表在这里:

| 动词 | SQL | HTTP | 幂等 |
|---|---|---|---|
| `get` | SELECT | GET | 是(且安全:什么都不改) |
| `verify` | — | GET(条件判断) | 是(且安全) |
| `restore` | UPDATE(整表) | PUT | **是** —— 同一 rev restore 两次,文件逐字节相同 |
| `save` | INSERT | POST | **否**(见下) |

`save` 是四个里唯一不幂等的——它 append。这直接推出 §3.1 里那条行为修正:**内容没变时 `save` 应当什么都不做**。今天的 `commit` 不做这个判断,连续跑两次会在链上留下一条 ops 为空的修订(id 里含时间戳,所以两次的 id 不同,不会撞车,只会白白变长)。而 `geml mcp` 那边写盘前已经在用 `isCurrent()` 挡住了这种空提交(`src/mcp.ts:259`)——也就是说**同一个不变式,MCP 守了,CLI 没守**。补齐它,agent 重试一次不确定是否成功的 save 就不会污染历史。

---

## 2. 收敛后的动词集

| 动词 | 形态 | 一句话 |
|---|---|---|
| `save` | `history save <file> [-m msg]` | 把工作文件的当前内容追加为新的 tip |
| `get` | `history get <file> [<rev>] [<选择符>] [--json]` | 读历史:不给 rev 列出全部;给了 rev 打印那条;再给选择符打印那条里命中的块 |
| `restore` | `history restore <file> <rev> [--force]` | 用某条修订覆盖工作文件 |
| `verify` | `history verify <file>` | 校验整条链:逐条重建、比对哈希 |

四个动词共享一个可选项 `--history <path>`(改写 sidecar 路径,默认 `<file 去掉 .geml>.gemlhistory`),这一条今天就有,原样保留。

**砍掉的**:`commit`(更名为 `save`)、`log`(并入 `get` 的零选择符档)、`show`(并入 `get` 的单选择符档)。三者都是**硬删除**,不是别名——理由见 §6。

---

## 3. 逐动词行为矩阵

### 3.1 `save` —— 追加一条修订

```
geml history save <file.geml> [-m <msg>]
```

| 项 | 行为 |
|---|---|
| 读 | 工作文件的当前字节 |
| 写 | `.gemlhistory`(新增一条修订 + 一个 keyframe;不碰文档) |
| 输出 | `saved <id>`(今天是 `committed <id>`) |
| 退出码 | 0 成功 / 1 操作错(文件读不到、反向补丁不能往返) |
| `-m` `--message` | 修订摘要,默认空。**save 的唯一参数** |

**保留的不变式**(今天就有,不改):写盘前把新算出的反向补丁应用回去,必须逐字节重建出父修订,否则**中止**,`.gemlhistory` 一个字节都不动(`history.ts:534`)。历史宁可写不进去,也不能写进一条重建不出来的。

**一处行为修正(已裁定,§9-Q1)**:当工作文件与 tip 逐字节相同时,`save` **不追加**,打印 `already saved as <id> (no changes)` 并 exit 0。理由在 §1.3:同一不变式 MCP 已经在守(`mcp.ts:259` 的 `isCurrent()`),CLI 补齐后 `save` 才是「重试安全」的。不提供 `--allow-empty` 之类的绕过——空修订没有任何已知用途,加个开关等于承认它有。

这是全稿唯一一处**行为**改动,其余都是命名与分组。

**`--author` / `--at` 已从 CLI 撤下(已裁定,§9-Q4)**。撤之前量过:本仓库 81 条真实修订里带 author 的是 **0** 条(仅有的 12 处 `author="alice"/"george"` 在 `spec/in_geml_format/GEML-history-spec*.gemlhistory` 里,是规范自己的示例被 dogfood 进去的);三个自动写入方——PostToolUse 钩子、`geml mcp`、`codemap build --history`——**一个都不传**。CLI 层面 `--at` 只有 4 处调用、`--author` 只有 1 处,全在测试里。

两者**保留在库 API 上**(`save({ author, at })`,库层各 49 / 85 处调用):`.gemlhistory` 的格式仍然定义 `author` 字段,嵌入方要写得进去;而确定性时间戳是测试能钉住修订 id 的前提(修订 id = 时间戳 + 内容哈希)。撤掉的只是**命令行上没人拉过的那根杆**。

传了会**硬报错**、不是静默忽略——理由与退役动词同一条(§6):`save -m x --author alice` 默默不记 author,丢的正好是调用方特意打出来的那个东西。

### 3.2 `get` —— 读历史(核心动词)

```
geml history get <file.geml>                    # 档 0:列出全部修订
geml history get <file.geml> <rev>              # 档 1:那条修订的全文
geml history get <file.geml> <rev> <选择符>      # 档 2:那条修订里的那个(些)块
```

三档由**给了几个地址**决定,与顶层 `get` 的两档同一条规则。逐档:

| 档 | 选择符 | stdout | `--json` |
|---|---|---|---|
| 0 | 无 | 每行 `<sel> <id> <author> <summary>`,**新→旧** | `RevisionInfo[]`(即 MCP `geml_history` 今天返回的那个数组) |
| 1 | `<rev>` | 那条修订的**全文,逐字节**(换行按 sidecar 存的形态,即 LF) | `{ id, text }` |
| 2 | `<rev> <选择符>` | 那条修订里该选择符命中的块(N 个则 N 份,§10) | `{ id, block }` / N 个则数组 |

**档 0 的第一列是可复制的选择符**:tip 是 `0`,往前是 `-1`、`-2`……这条今天就成立,是刻意维持的——它印出来的东西必须原样喂得进 `restore`、`revert --rev` 和 `get` 自己。这个「一份语法、一处实现」的约束由 `resolveRevision()` 单点保证(`history.ts:692`),该函数的注释里记着上一次违反它的后果:选择符语法曾经写了两遍,`restore` 那份漏掉了 `0`/`-N` 分支,于是 `log` 打印出来的选择符被 `show` 拒收。**新增的档 2 必须走同一个 `resolveRevision`**,否则就是第二次犯同一个错。

**`<rev>` 的语法**(不变,`history.ts:692`):`0`(tip)| `-N`(往前 N 条)| 修订 id 的**无歧义**前缀 / 后缀 / 全称。匹配到 0 条或 >1 条都报错并说明匹配数,不猜。

**档 2 是新增能力**,今天没有等价物:想看「三个版本前的 `#intro` 长什么样」,今天只能 `history show` 打印全文再自己找。实现上不新增算法——一条修订重建出来就是一篇文档文本,直接喂给顶层 `get` 的**同一个选择符解析器**(§10)。选择符在该修订里命中 0 个 → 报错 `no block matching … in revision <id>`,exit 1(不是空输出,空输出会被 agent 读成「那时它是空的」)。

**为什么档 1 不给 `-o`**:顶层 `get` 也没有,它是纯读、结果走 stdout 让调用方自己重定向。要落地成文件的是 `restore`,那是另一个意图(§1.2 的另一档 blast radius)。

### 3.3 `restore` —— 用一条修订覆盖工作文件

```
geml history restore <file.geml> <rev> [--force]
```

| 项 | 行为 |
|---|---|
| 读 | `.gemlhistory` |
| 写 | **文档**(整篇替换) |
| 输出 | `restored <file> to <rev>` |
| `--force` | 覆盖「工作文件有未保存改动」的拒绝 |

保持原样,一个字不改。它与 `get <rev>` 的关系,正是块变更文档 §4.0「输出镜像输入源」的另一面:同一份内容,**读到 stdout 是 `get`,写回文件是 `restore`**。两者不合并,因为一个不写盘、一个整篇写盘——§1.2 里最粗的那条 blast radius 分界线正好落在这里。

### 3.4 `verify` —— 校验整条链

```
geml history verify <file.geml>
```

逐条重建每个修订并比对哈希,把 error / warning 打到 stderr,最后一行 `verify: OK|FAILED (<n> revisions reconstructed & hashed)`;FAILED 时 exit 1。保持原样。

**为什么是 `verify` 而不是跟顶层同名的 `check`**:顶层 `check` 校验的是**一篇文档**是否合规范;这里校验的是**一个多修订产物**的内部一致性。同一个区分在 codemap 那边已经定型了——`geml codemap verify` 也是「整个产物」这一档。所以 `verify` 不是这里的特例,是**子命名空间里既有的拼法**:顶层查文档用 `check`,查一整个由多份内容组成的产物用 `verify`。

### 3.5 `revert` 为什么留在顶层

最容易被质疑的一处,所以单独回答。三条理由,任何一条单独成立:

1. **资源不同(§1.1)**。`history *` 的资源是历史;`revert` 的资源是**文档里的一个块**——它的地址是 `file#id`,`--rev` 只是修饰语。按「先给地址、再说做什么」,它和 `set` / `delete` 是同类,不和 `save` 同类。
2. **blast radius 不同(§1.2)**。`restore` 换整篇,`revert` 只动一个块、其余逐字节不变。这正是块变更设计文档 §1.2 花了一整节论证的东西:块级撤销之所以只有三个分支而不是一套 undo 引擎,是因为动词正交。把它降级成 `history` 的一个子命令,等于在文档结构上宣称它是历史的附属功能,而它其实是**块变更动词集的第五个成员**(§4.5 就是这么写的)。
3. **它已经是顶层了**,并且顶层帮助里就和 `set/add/delete/rename` 排在一起。改动它只会制造一次没有收益的破坏性变更。

顺带回答一个可能的追问:`revert` 读 sidecar,所以它只接受**真实文件**、不接受 stdin(块变更文档 §4.0 的那条例外)。这个限制不因为它留在顶层而改变。

---

## 4. 与顶层词汇表的对应

收敛之后,`history` 的四个动词有三个能在顶层找到同名或同职的对应——这是「一套词汇」是否真的成立的检验:

| history 动词 | 顶层对应 | 关系 |
|---|---|---|
| `get` | `get` | **同名同规则**:零选择符 = 列表,给选择符 = 那一个 |
| `verify` | `check` / `codemap verify` | 同职;拼法随「查文档 vs 查产物」的既有区分(§3.4) |
| `restore` | `revert` | 同职不同粒度:整篇 vs 一个块 |
| `save` | 无 | **唯一的新意图**——顶层没有任何动词会往 `.gemlhistory` 追加 |

`save` 没有对应物,正是它必须存在的证明;`log` / `show` 都能在顶层找到已经存在的规则来解释,正是它们不必存在的证明。

---

## 5. MCP 面

**工具名不改(已裁定,§9-Q3)**:`geml_history` 保持原名,不改成 `geml_history_get`。已注册的客户端不受这次收敛影响。

代价要说清楚:`geml mcp --help` 里写着「every tool is `geml_` + its CLI verb」,而 `geml_history` 对应的是**命令组**而非动词。这条偏差可接受,因为 MCP 上这个组**只有一个只读工具**——`_get` 后缀要等到出现第二个 history 工具时才有区分价值,而按下一段的理由那一天不会来。实现时把 `--help` 里那句话改准确(工具名镜像的是 CLI 的**命令路径**,`geml_history` ↔ `geml history`),而不是让一句不再成立的话留在帮助文本里。

**跟着 CLI 长出来的能力**(不是破坏性变更,纯新增可选参数):

| 参数 | 行为 | 对应 CLI |
|---|---|---|
| 都不给 | 修订列表(今天的行为,不变) | `history get <file>` |
| `rev` | 那条修订的全文 | `history get <file> <rev>` |
| `rev` + `id` | 那条修订里的那个块 | `history get <file> <rev> #id` |

第三档对 agent 最有用:退之前先看一眼「三版前的 `#intro`」,不必把整篇修订读进上下文。

**不改的**:不新增 `geml_history_save`。写路径上的每一次 `geml_set/add/delete/rename` 已经自动 commit 一条 PRE-write 修订(`mcp.ts:248`),这正是 `geml_revert` 永远有东西可退的前提;再给 agent 一个手动 save 只会让它在自动修订之间插入语义不明的空档。`restore`(整篇覆盖)与 `verify` 同理不上 MCP——前者的 blast radius 太大而 agent 手里已经有块级 `geml_revert`,后者是维护动作不是编辑动作。**这也是工具名保持组名不会出问题的原因:这个组在 MCP 上不会有第二个工具。**

---

## 6. 破坏性变更与迁移

三个动词硬删除:`commit`、`log`、`show`。

**不做别名**,理由是本仓库已经定过两次同样的性质、也承受过后果:`geml mcp --workspace` 改 `--root` 是硬改,`geml codemap mcp` 入口是**直接删除**(你的原话:「不仅是弃用,而是直接删除入口」)。同一把尺子:一个词只能有一个意思,留着旧词指向新行为,等于让文档、教程、agent 的记忆里长期并存两套说法。

**版本号**:按块变更设计文档 §7/§8 的惯例,破坏性变更需要 version bump + changelog 条目。

---

## 7. 改动范围(实现阶段)

| 文件 | 改什么 |
|---|---|
| `geml-parser/src/geml.ts` | `runHistory()` 重写为四分支 + 三条替代提示;`SUBHELP.history`;总 USAGE 里的 history 行;`history get` 档 2 复用 `pick`/`blockSpans` |
| `geml-parser/src/history.ts` | 导出 `commit()` → `save()`;`isCurrent()` 前移到 CLI 的空 save 判断;注释里的 `history log` / `history show` 字样 |
| `geml-parser/src/mcp.ts` | `geml_history` 新增可选 `rev`/`id` 参数(工具名不变);`--help` 里那句命名约定改准确;`commit()` → `save()` 的调用点 |
| `geml-parser/codemap/build.mjs` | 注释里的 `history log / revert per node` |
| `geml-parser/README.md` | CLI 段的 history 行;`geml history commit` 两处 |
| `README.md` / `README_CN.md` | 各一行 `geml history commit` 示例 |
| `docs/mcp-guide.md` | `history commit` 的说法 |
| `docs/design/specs/codemap/codemap-profile{,_CN}.md` | `history log` 两处 |
| `spec/proposals/0002-code-graph-representation.md` | `history log` 一处 |
| `playground/playground.js` | **构建产物**,重新打包即可(它内嵌了 CLI 帮助文本) |
| 测试 | `test/cov-history-cli.test.mjs`(主战场)、`test/revert.test.mjs`、`test/mcp.test.mjs`;新增:三条替代提示的退出码、`get` 三档、`get --json` 三档、空 save 的 no-op |

§10 的对齐是**另一批**改动,随 `get`/`set` 选择符一起落地,不在上表内。

**不改**:`spec/GEML-history-spec{,_CN}.md` 及其 `in_geml_format/` 版本。它们描述的是 `.gemlhistory` **文件格式**,不提任何 CLI 动词——这本身就是分层做对了的证据:改命令名不该惊动格式规范。

---

## 8. 非目标

- **`rename` 的历史血缘**。今天 `rename #a #b` 之后,`revert #b` 追不回改名前的历史(`diffReverse` 按块 key 做 LCS,改名在它眼里是 delete+insert)。已评估:产品代码约 80 行,但需要在反向补丁里新增第五种 op(`rename <new> <- <old>`),而 `parseOps()` 对未知 op 是**抛错**的,所以那是一次**格式的硬向前不兼容**。与本次纯命令层的收敛不是一个量级,单独立项。今天的行为(`geml.ts:2197` 在改名有历史的 id 时打 warning)保持不变。
- **`spec/GEML-spec.gemlhistory` 的断链**。该文件 `history verify` 报 24 个 error(含 `unit @ba82baff not found while applying reverse patch`),可追到 2026-07-21,**先于**本次改动,属于 `locateUnit` 那条代码路径的既有缺陷。本次不修——但它必须先于「rename 血缘」被查清,因为两者动的是同一段代码。
- **同一 id 的多版本并存**。`.gemlhistory` 是**严格线性**的 parent 链(格式规范 §8:分叉即损坏)。不提供 `branch` / `merge`。
- **`prune` / `squash` / `history delete`**。历史可被裁剪,就不再是可验证的链;`verify` 的价值来自「每一条都能重建出来」,而任何删除都会把这句话变成「除了被删掉的那些」。
- **跨文件的历史操作**。四个动词都只认一个 `<file.geml>`,与块变更那套「无状态、无当前文档」一致。

---

## 9. 裁定记录

| # | 问题 | 裁定 | 落在 |
|---|---|---|---|
| Q1 | `save` 遇内容未变时怎么办 | **no-op**:打印 `already saved as <id> (no changes)`,exit 0,不追加空修订 | §3.1 |
| Q2 | 读历史的动词叫什么 | **`get`**(与顶层 `get` 同名同规则),`log` / `show` 一并硬删除 | §0 §2 §3.2 |
| Q3 | MCP 工具是否跟着改名 | **不改**,`geml_history` 保持原名;改准 `--help` 里那句已不精确的命名约定 | §5 |
| Q4 | `save` 的 `--author` / `--at` 要不要留 | **两个都撤出 CLI**(库 API 保留);传了硬报错 | §3.1 |

四项均已确认并实现。§10 是之后补的对齐条款,已随 `get`/`set` 选择符落地。


---

## 10. 与 `get` / `set` 选择符设计的对齐(后加,已实现)

本文 §1–§9 定稿并实现时,顶层 `get` 的选择符语义还没收敛。之后
`2026-08-04-geml-get-set-selector-design.md` 把它定成了一条规则(选择符是过滤器,
`#id` 是 `{#id}` 的省略),并让 `set` 共用。本节把 `history get` 挂到同一套语法上。

**这不是新决定,是履行 §1.2 已经写下的那句话** ——「`history get` 是顶层 `get` 那条规则在历史这层的复读」。规则一旦收紧,复读就得跟着收紧,否则「同名同规则」这个当初选 `get` 而非 `show` 的理由就不成立了。

### 10.1 档 2 用完整的选择符语法

档 2 原本写的是 `<rev> #id`,收窄成了 id 一种形式。改为**接受顶层 `get` 的全部选择符**:

| 写法 | 在档 2 的含义 |
|---|---|
| `#id` / `id` | 那条修订里 id 为该值的块 |
| `## 标题` | 那条修订里该标题的整节 |
| `=== type` | 那条修订里全部该类型的块 —— **N 个则 N 份内容** |
| `=== type@<hex>[~n]` | 那条修订里内容匹配的那个块 |
| `=== type {k=v}` | 与顶层同,报「今天只实现了 `#id` 这一个 key」 |

基数与顶层 `get` 一致:0 → exit 1、1 → 内容、N → N 份内容原样拼接。
`--head` / `--body` 也一并可用,语义与顶层同(§5.1 的那张逐档表)。
`--head` 与 `--body` 同给、`--json` 与二者同给 → exit 2,同一条「绝不静默丢弃」规则。

**实现上不新增算法。** 一条修订重建出来就是一篇文档的完整文本;把它交给顶层 `get` 用的同一个选择符解析器即可。这也是原 §3.2 那条约束的延续:选择符语法**一份定义、一处实现**,那里说的是修订选择符 `resolveRevision()`,这里说的是块选择符。

### 10.2 两套选择符,不会混淆

一条命令上有两个位置、两套语法,值得说清为什么不冲突:

```
geml history get doc.geml   -3        '=== note@a3f9c1d2'
                            ↑修订选择符   ↑块选择符
```

- **位置固定**:第一个位置永远是修订,第二个位置永远是块。
- **词法不重叠**:修订选择符是 `0` / `-N` / 十六进制风格的修订 id;块选择符恒以 `#`、`##`、`===` 或 `@` 起头。没有一个字符串同时属于两套。

### 10.3 `@<hex>` 在历史里的可用性(诚实说明)

内容地址是**内容**的函数,所以从当前文档列出来的 `@<hex>` 一般**匹配不上旧修订** —— 那个块的内容本来就变了,这正是内容地址的设计意图(§3.2:过期即报错,不静默指向别的块)。

要拿到某条旧修订里的地址,把那条修订喂给顶层 `get` 的列出档:

```
geml history get doc.geml -3 | geml get -        # 列出 -3 那一版的全部地址
```

这条组合是两套语法各归其位之后自然掉出来的,不需要为它加任何东西。

### 10.4 不改的

- **MCP `geml_history` 的参数名。** 它今天是 `rev` + `id`;`id` 严格说该叫 `selector` 了。不改:改名要动已注册的客户端,而 `id` 仍然是最常用的取值。记为连带项,与 `geml_get` 的 `part` 参数(get/set 设计 §10)一并处理。
- **`history restore` / `verify` / `save`。** 它们不接块选择符 —— `restore` 的地址是修订、`verify` 没有地址、`save` 的输入是整个工作文件。这套语法只落在档 2。
