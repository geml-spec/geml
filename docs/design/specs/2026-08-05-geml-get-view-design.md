# GEML `get --view` —— 穿过 embed 视窗读到实体块 — 设计文档

状态:**已定稿,待实现**。本设计单独存放在 `feat/geml-get-view` 分支,需要时再合入 `main`。
基线:`main` @ `4a70c2c`(GEP-0005 `data` 块已落地)。
前置阅读:`2026-08-04-geml-get-set-selector-design-change.md`(选择符、`--head`/`--body` 的定义与基数规则)· `2026-07-30-block-transclusion-design.md`(transclusion 链与环检测)· 规范 §3(`embed` 的目标必须当作独立文档解析)。

---

## 1. 出发点:embed 是视窗,窗框和景色是两回事

别的块类型没有这个问题。`=== note` 的内容就在它的 body 里,`geml get '#n'` 拿到的就是全部。`embed` 特殊之处在于**它本身没有内容**:body 在规范上不使用(写了还会报 `ignored-embed-body` 警告),内容全在 `src=` 指向的别处。

把 embed 看成一个**视窗**,而且是可以多层嵌套的视窗:

- **窗框** —— `=== embed {#e src="part.geml#tip"}` 这个声明本身。
- **景色** —— 顺着 `src` 看过去,最终落到的那个实体块。

两者都有真实需求:要改 `src=` 的指向、改属性,要的是窗框;要读内容、要喂给下游消费者,要的是景色。

今天的 `geml get '#e'` 只给窗框:

```
$ geml get host.geml '#e'
=== embed {#e src="part.geml#tip"}
===
```

`--json` 里 `raw` 是空数组、`attrs.src` 是那串未解析的引用;`--body` 返回**空**。这不是缺陷,是 §3 的直接后果 —— 但它让「拿景色」这个需求在 CLI 上无路可走,多层链更是要人肉一跳一跳地拆 `src`。

## 2. `--view` 的语义:解析到实体块

```
geml get <file> <selector> --view
```

语义定义为**「解析到实体块」**,而不是「embed 专用开关」:

- **`embed` 块** —— 顺着 `src` 链走,每一跳都按 §3 把目标当作**独立文档**解析,直到落在一个非 embed 块上。多层视窗自动穿透,中间层不出现在结果里。
- **任何其他块** —— 恒等,返回该块自身。它已经是实体块,链长为 0。

因此 `--view` 对任何 selector 都有定义,调用方不需要先判断块类型。

### 2.1 为什么对非 embed 块恒等,而不是报「这不是 embed 块」

1. **调用方不必先分类。** agent 拿到一个 selector 时未必知道目标是不是 embed。恒等意味着它可以无条件加上这个 flag 来表达「我要内容」这个意图;若改成报错,调用方就得先 `get --json` 看 `type`、再决定第二次怎么调 —— 把一次读变成两次。
2. **恒等是语义的自然延伸,不是特例豁免。** 「解析到实体块」作用在实体块上,答案就是它自己。这条不需要额外规则去豁免。
3. **新块类型零成本兼容。** 基线 `4a70c2c` 刚落地的 GEP-0005 `data` 块就是例子。它自己也有 `src=`,但那是**数据源**(像 `table` 的 `src=`),不是 transclusion —— `data` 块本身就是实体块,`--view` 对它恒等,无需为它写一行代码,也无需在实现里维护一张「哪些类型算实体」的名单。名单会漂,取反不会。

### 2.2 为什么是 flag,而不是 selector 穿透符或独立动词

考虑过两个替代:

- **selector 里加穿透符号**(如 `'#e>'`)。寻址统一进 selector 语言听起来更整齐,但 selector 是 `get` 和 `set` **共享**的一套语法,于是必须造一个「只在 `get` 合法」的 selector —— 给一套统一语法开例外。而 `@<hex>` 内容地址已经占据了后缀位置的直觉。
- **独立动词** `geml view`。读写彻底分离,`set` 天然无从对称。代价是 `--json`/`--head`/`--body` 要么重复实现、要么与 `get` 共享实现却分裂文档;而 `get` 已经是「读一个块」这个动词,再切一个「读一个块但穿透」是切错了关节。

穿透是**读取的一个维度**,不是新的寻址语言,也不是新的动作。所以它是 `get` 的一个 flag。

## 3. 链的停止条件:不新造诊断码

| 停止原因 | 诊断 | 退出码 |
|---|---|---|
| 落在实体块 | —— | 0 |
| 链上出现环 | `transclusion-cycle`(已有) | 1 |
| 走到深度上限仍未落地 | 现状无诊断,见 §3.2 | 1 |
| 目标文档读不到 / 越出 confinement root | `unresolvable-document`(已有) | 1 |
| fragment 的 id 在目标文档不存在 | `unresolved-reference`(已有) | 1 |
| 目标不是 `.geml` | `embed-target-not-geml`(已有) | 1 |
| 目标是 `http(s)` | `unchecked-cross-document-reference`(已有警告) | 1,见 §3.1 |

一条新诊断码都不加。这不只是图省事:新增码要同步 `diagnostics.ts`、英文规范附录 A、两份 dogfood 副本,还要过 `preliminaries.test.mjs` 的机械校验 —— 而这里没有任何一种**新的失败模式**。`--view` 走的是 `check` 早就在走的那条链,失败原因也就是 `check` 早就在报的那些。

### 3.1 `http(s)` 目标:停下并说明,绝不发请求

规范 §9.5 允许 `http`/`https`/`mailto`/`tel` 作为可导航目标,所以 `src=https://…/part.geml` 是合法文档。但 CLI 的文档解析器只读本地文件,且受 confinement root 约束。

`--view` **不得**为了走完链去发网络请求。理由不是实现难度,是信任边界:`geml get` 是一条读取命令,agent 和编辑器会无条件、高频地调它;让它能被文档内容驱动去访问任意 URL,等于把一条读命令变成 SSRF 入口。

所以链走到非本地目标就停在那里,报 `unchecked-cross-document-reference`(警告)。选择复用而非新造码的取舍:这条码的原意是「没有解析器所以没检查」,这里是「刻意不跨网络」,语义略有拉伸;但它的**严重级别和后果完全一致**(目标没被检查、内容没拿到),而新造一条码要付 §3 开头列的那四处同步成本。message 要把真实原因写清楚 —— 规范明说 message 是散文、可改,码才是契约。

### 3.2 深度上限:复用常量,但**不**复用「静默」

复用 `geml.ts` 的 `EMBED_DEPTH_LIMIT`(与 `render.ts` 的 `EMBED_DEPTH_CAP` 对齐,当前为 8)。不新定义常量:否则 `check`、渲染、`--view` 会对「这条链能走多深」产生三种答案,而这三者本该对同一份文档给同一个结论。

但**行为不能照搬**。今天 `detectTransclusionCycles` 撞到上限是直接 `return`(`geml.ts:793`),不报任何诊断 —— 对环检测来说这是对的:一条 9 层的链并没有环,渲染器也只展开 8 层,文档本身合规。

`--view` 不能这样静默。它的契约是「返回实体块」,而在第 8 层停下时,手里拿着的很可能**还是一个 embed 块**。静默把它返回就是违约,而且调用方无从察觉。所以走到上限仍未落地 → 按 §3.3 算命令失败。

### 3.3 拿不到实体块,就是命令失败

退出码规则一句话:**没拿到实体块就是失败,退出码 1。**

这不是新规矩,而是现有行为的自然延伸 —— `get` 的选择符没命中任何块时,今天就是 `error: no block with id …` 加退出码 1(实测)。「链断在中途」和「选择符没命中」对调用方是同一件事:要的东西没给到。

所以 §3 表格里除第一行以外全是退出码 1,`http(s)` 那格也是:内容确实没拿到,尽管文档层面只报了一条警告。失败时 stdout **不输出半成品** —— 绝不打印中途那个 embed 块,以免被当成结果消费。

这样 `geml get … --view > out && use out` 才是安全写法。

**多结果下是「全或无」。** selector 命中多个块时(§4.3),只要其中任何一个的链没能落到实体块,整条命令就失败:退出码 1、stdout **不输出任何内容**,stderr 说明是哪一个块断在哪里。理由与上一段同源 —— 部分景色不是景色,而「输出一半 + 非零退出」会让忽略退出码的调用方拿到静默不完整的数据。

这是有意的保守选择。若实际用起来嫌它太严(比如整节里只有一个 embed 指向缺失文件,却导致整节读不出来),放宽比收紧容易:放宽只是多输出一些东西,收紧会打破已经依赖它的脚本。

## 4. 出处是强制的,不是可选装饰

§2 的穿透意味着返回的字节属于**另一个文档**。规范 §3 说得很硬:

> The document `src=` names MUST be **parsed as a document in its own right** … it is **never a run of text spliced into** the document that named it.

它的元数据、引用、相对路径基准、外部 `src=` 数据全部相对**它自己**解析。规范给的例子:`a.geml` embed 了 `b.geml#tbl`,而那个表的 `src=rows.csv` 按 **b.geml** 的目录解析。

所以「返回一段裸文本」恰恰是规范禁止的那种文本拼接。**带上出处,是让输出保持诚实的最低要求**:调用方必须能知道拿到的是 `part.geml#tip`,而不是宿主文档在这个位置的内容。带了出处,§3 的基准问题就从设计缺陷降级为一项标注义务。

### 4.1 文本模式:内容进 stdout,出处进 stderr

stdout 只有内容,保持可管道:

```
$ geml get host.geml '#e' --view
=== note {#tip}
Borrowed body from the other file.
===
```

出处同时写到 stderr,形如 `view: #e -> part.geml#tip`(格式是契约,定义见 §7.3)。走 stderr 有先例:`set` 通过 `@<hex>` 地址写入时,就是把新地址打到 stderr。

### 4.2 `--json`:向后兼容的 `from` 字段

块对象上增加 `from: {doc, id}`。**不带 `--view` 时这个键不出现**,所以现有 `--json` 消费者不受影响 —— 现有块对象没有 `from` 键,新增键是纯扩展。

### 4.3 多结果:整篇与整节

`src=other.geml`(无 fragment)指向一整篇文档;fragment 指向标题时,按 §3 选中标题的**整节**。两种情况下景色都是**一组**实体块,而不是一个。

输出沿用现有多匹配行为:打印 N 份内容,计数走 stderr —— 和 `'=== type'` selector 命中多个块时完全一致。不为 `--view` 发明第二套多结果格式。

**`--view` 逐 unit 作用,而不是逐块。** selector 命中的每一个 unit 各自解析:embed unit 解析到它的实体块,非 embed unit 按 §2 恒等原样返回。所以 `'=== embed' --view` 会把每个 embed 各自解析掉,结果按顺序拼接,总数走 stderr。

**但整节 selector 是恒等的 —— 它绝不拼接。**(实现期修正,2026-08-05:初稿在这里承诺「作用在整节的每个块上」,那与 §3 冲突。)整节在实现上是**一个跨多块的 unit**,而不是多个 unit;真去穿透节内的 embed,产出的会是一段**混合基准的字节**:一半来自宿主文档、一半来自目标文档,拼在一起,而这份文本在任何一个文档里都不存在 —— 这正是 §3 明令禁止的 "a run of text spliced into the document that named it"。

所以整节原样返回,节内的 embed 仍是窗框。要穿透节内某个 embed,就单独寻址那个 embed —— 与 §5 同一条原则:意愿明确。

两者的区别是「一个 span 覆盖几块」还是「几个 span 各覆盖一块」:后者的每个结果都是一个完整的目标块,不存在混合,所以可以逐个穿透。

`src=other.geml`(无 fragment)属于后者的合法情形:它展开成目标文档的多个顶层块,但**全部来自同一个目标文档**,基准统一,所以没有拼接问题。(实现注意:标题的 unit 跨整节,所以枚举时只取顶层 unit,否则节内的块会被输出两次。)

## 5. `set` 不接受 `--view`

`set` 与 `get` 共享 selector,但 `--view` 是**只读**的。传给 `set` 是用法错误,退出码 2(与其他用法错误一致),错误信息必须指路而不只是拒绝:

> `--view` is read-only. To edit the target, read the frame's `src` and edit that document.

这是「意愿明确」的机械保障:想改被 embed 的内容,必须显式打开目标文档去改。没有任何路径能让一次 `set` 悄悄写到另一个文件。

明确记下被否掉的两个选项及其理由,以免日后重新提出:

- **顺链写目标文档** —— 一个入口就能编辑整条链,威力很大,但一次 `set` 会静默修改另一个文件,`.gemlhistory` 快照也落在别处。读命令穿透是便利,写命令穿透是陷阱。
- **把景色实体化进宿主** —— 用 `set` 把展开结果替换掉 embed 块。这等于烧死引用,transclusion 退化成一次性复制粘贴,源文档后续修改再也传不过来。这恰好是 transclusion 要解决的问题本身。

`set` 在 embed 块上的语义保持不变:它操作的是**窗框** —— 那个块的属性(`src=` 等)和围栏行。

## 6. flag 组合

| 组合 | 结果 |
|---|---|
| `--view` | 实体块的完整源文本 |
| `--view --json` | 实体块的模型 + `from` |
| `--view --head` | 实体块的围栏行(其中的 `#id` 是目标文档的 id;只读,不会撞进宿主) |
| `--view --body` | 实体块的正文 —— 这正是「景色」最常用的形态 |
| `set … --view` | 用法错误,退出码 2(§5) |

`--head`/`--body` 的含义不变(定义见前置阅读那份文档的 §4),`--view` 只改变它们**作用在哪个块**上。

## 7. MCP:`geml_get` 暴露 `view` 与 `body`

agent 是这个特性的主要消费场景,所以 MCP 面必须跟上 —— 否则 `--view` 只对在 shell 里敲命令的人有用。

`geml_get` 今天是 CLI 的**薄壳**:`runCli(["get", real, sel])`,成功返回 `run.stdout`,失败把 `run.stderr` 塞进 `Error`。改动因此很小,但有一个 CLI 那边不存在的问题:**MCP 没有 stderr**,而成功路径上 `run.stderr` 今天被直接丢弃 —— 出处恰好走 stderr(§4.1)。

### 7.1 新增 `view`,并让 `part` 与 `geml_set` 对称

- `view: true` —— 传 `--view`,语义与 CLI 完全一致(§2)。
- `part: "whole" | "head" | "body"`(默认 `whole`)—— 与 `geml_set` **同名同枚举**。`view` + `part="body"` 是「拿到景色的内容」这个主场景最常用的组合(§6),而让 agent 自己从源文本里剥围栏靠的是字符串处理,在嵌套围栏上容易出错。

**为什么是 `part` 而不是 `body: true`** —— 两条硬理由:

1. **`body` 这个名字在本服务里已被占用,含义还几乎相反。** `geml_set` 的 `body` 参数是**替换文本**(一个字符串,`mcp.ts:475`)。同一个 MCP 服务里让 `body` 一处指「内容字符串」、一处指「只要正文」的布尔,是给 agent 埋歧义。
2. **读写两侧的粒度本该对称。** `geml_set` 早就有 `part: whole|head|body`(`mcp.ts:476`),写侧能只写正文;读侧却只能整块读。共用一个参数名与枚举,agent 学一个概念就够 —— 这也修正了初稿里「MCP 面刻意不暴露任何 flag」那个不准确的说法:不暴露的只有 `geml_get`。

`head` 因此顺带就有了 —— 它是那个枚举里的一个值,单独排除它反倒要写额外的校验和说明。`json` 仍然不加:那是模型需求,目前没有场景驱动。

### 7.2 view 模式返回结构化对象,出处不再丢失

不带 `view` 时返回**字符串**(现状不变,向后兼容)。带 `view` 时返回对象:

```json
{ "from": "part.geml#tip", "content": "=== note {#tip}\nBorrowed body.\n===\n" }
```

`asText` 对非字符串结果做 `JSON.stringify`,所以 agent 看到两个明确字段,不会把出处当成块内容的一部分 —— 这比在文本前面拼一行 `from: …` 安全得多。返回对象也有先例:`geml_check` 就是这么做的。

### 7.3 stderr 那行的格式因此是契约

MCP 层的 `from` 直接取自 `runCli` 已经交到手上的 `run.stderr`,不额外跑一次 CLI。这让 §4.1 那行出处从「人看的提示」升级为 **CLI ↔ MCP 的内部契约**,格式固定为:

```
view: <selector> -> <doc>#<id>
```

多结果时每个结果一行,顺序与 stdout 一致。实现时 MCP 侧按这个前缀解析;格式一改必须同时改两边,所以测试要钉住它(§8)。

## 8. 测试

CLI 部分进现有的 `embed.test.mjs`(embed 语义已经都在那里,不新开套件),MCP 部分进 `mcp.test.mjs`。16 组用例:

1. 单跳:`--view` 拿到实体块源文本,stderr 有出处
2. 多层 A→B→C:落到 **C**,而非 B 的 embed 声明
3. 非 embed 块恒等:`--view` 输出等于不带 `--view`
4. `--view --json` 有 `from`;**不带** `--view` 时无 `from`(向后兼容断言)
5. `--view --head` / 6. `--view --body`
7. 环 → `transclusion-cycle`
8. 走到深度上限仍未落地:退出码 1,且 stdout **不含**中途那个 embed 块(§3.2、§3.3)
9. 目标 id 不存在 → `unresolved-reference`
10. 目标非 `.geml` → `embed-target-not-geml`
11. `http(s)` 目标 → 警告,且**不挂起**(用不可达地址断言快速返回,以此证明没发请求)
12. 无 fragment 的整篇多结果 + heading fragment 的整节多结果
13. `set --view` → 退出码 2,错误信息含指路

MCP(§7):

14. `geml_get` 带 `view` → 返回 `{from, content}` 对象;**不带** `view` 时仍返回字符串(向后兼容断言)
15. `geml_get` 带 `view` + `part="body"` → `content` 只有正文,不含围栏;`part` 非法值被拒(与 `geml_set` 同样的校验)
16. §7.3 的 stderr 出处格式被钉住:CLI 打印的那行与 MCP 解析用的前缀是同一个格式(格式漂移必须让测试红)

覆盖率仍需过 95% 闸门(`npm run coverage:check`)。

## 9. 相对今天的改动

- `geml.ts`:`get` 的参数解析新增 `--view`;新增一个「顺链解析到实体块」的函数,复用现成的 `resolveDoc`、`relJoinPath`、`EMBED_DEPTH_LIMIT`。
- **不改 `detectTransclusionCycles` 撞上限时的静默 `return`。** 那对环检测是正确行为(§3.2),失败只发生在 `--view` 自己的走链函数里 —— 否则 `check` 会开始对合规文档报错。
- `--help`:`get` 的 usage 串加 `--view` 及一句话语义。
- `mcp.ts`:`geml_get` 的 inputSchema 加 `view` 与 `part`,`run` 里透传到 argv,并在 view 模式下返回 `{from, content}`(§7)。`part` 的校验与 `geml_set` 同形。工具 description 要说明 `view` 的语义,否则 agent 不会知道它存在。
- skill 的 `#cli` 节(`geml-parser/skill/references/authoring.geml` 及两份镜像副本)—— 三份必须同步,否则 `skill-install.test.mjs` 的三方漂移测试会红。
- **不动规范。** `--view` 没有引入任何新的语言语义:链怎么解析、基准算谁的,§3 早已定完,`--view` 只是把既有语义暴露成一个读取入口。复用的诊断码在附录 A 已有条目,而规范明说 message 是散文可改,所以连附录都不用动。
- **不碰 `geml.ts` 的 top-level import / re-export**。否则要同步 viewer 的 esbuild stub(`render-html-stub.js`、node-stub),那是本仓库已经踩过两次的雷(`4b93941`、`cd8bed4`)。

## 10. 非目标

- **MCP 不加 `json`。** 见 §7.1:那是模型需求,目前没有场景驱动。`view` 与 `part` 加了是因为 agent 是这个特性的主要消费场景(且 `part` 本就该与 `geml_set` 对称),这不等于 MCP 面从此对齐 CLI 全部 flag。
- **行内投影 `![[#id]]` 不做。** `get` 的操作单位是块,行内投影不是块。
- **不做「就地展开并写回」。** 见 §5 被否掉的第二个选项。若将来真需要这个动作,它应该是一个名字里带「展开/固化」的独立命令,而不是 `set --view`。
- **不缓存链解析结果。** `get` 是无状态的一次性读取;缓存要考虑失效,而收益要等到有人在热路径上反复 `--view` 同一条链时才成立。
