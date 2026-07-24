# GEML 块变更 CLI — 设计文档

状态:设计已评审通过,待写实现计划。
分支:`claude/geml-block-mutation-cli`(基于 `claude/geml-command-consistency-q45khg`)。

---

## 1. 设计出发点(评审视角)

这套 CLI 的设计标尺,是**一个 agent 能否只用命令行,把一个 GEML 文件从无到有地做完**:新建整篇、往里加块、改动已有内容、删掉不要的、以及从别处把内容抄进来。整份设计始终围绕这条追问三件事:

- **够不够全** —— 整个生命周期(创建 / 添加 / 编辑 / 删除 / 复制)都有对应命令,agent 不必为任何增量改动重写整篇。
- **够不够顺手** —— agent 操作时足够灵活、强大、省心,可以多步编辑管道化的流水线操作。
- **够不够一致** —— 命令集不要复杂,参数行为统一、直觉可预测,减少心智成本。

> **实现交付物**:这一设计理念(agent 全程用 CLI 创作 + 上面三条标尺)要写进 `geml-parser/README.md`(新增一段设计理念 + CLI 段改写),并同步根 `README.md` / `README_CN.md` 的 CLI 段。README 与代码在实现阶段一起改,避免 README 描述尚未实现的命令。

---

## 2. 目标与范围

补齐「按 id 外科式、可寻址、低 token」的编辑工具箱,使 agent 对一个已存在文件的**每一次增量改动都不必重写整篇**。这是 GEML 楔子(为 AI 编辑而生的可寻址 + 可版本文档)的兑现。

**生命周期 → 动词映射**:

| 阶段 | 操作 | 动词 |
|---|---|---|
| 创建 | 新建整个文件 | 直接写文本 / `geml x.md --to geml -o x.geml`(**不设专用动词**) |
| 生长 | 加块(尾部 / 某块前后) | **`add`** |
| 编辑 | 换内容 / 换头 / 换正文 | **`set`**(`--head` / `--body`) |
| 编辑 | 改 id | **`rename`** |
| 删除 | 删一个或多个块 | **`delete`** |
| 复制 | 从别处抄内容(替换 / 新增) | `set --in F#src` / `add --in F[#src]` |
| 撤销 | 回退 / 复活已删块 | **`revert`**(扩展) |
| 校验 | 验证 | `check` |

「创建」为何不设动词:GEML 本就是纯文本,agent 直接写出初稿(或从 Markdown `--to geml` 转入);CLI 动词负责**之后每一次增量都外科化**,不替代「写文本」本身。空/新文件的第一个块由 `add --append` 完成。

---

## 3. 收敛后的动词集

块变更四动词 + 既有 `get` / `check` / `revert` / `history` / 转换入口:

| 动词 | 形态 | 一句话 |
|---|---|---|
| `set` | `set <file\|-> #id [--head\|--body] [--in F\|F#src\|-] [-o out]` | 换**已存在**块 #id 的内容(整块 / 头 / 正文),id 稳定 |
| `add` | `add <file\|-> (--append\|--before #x\|--after #x) [--in F\|F#src\|-] [-o out]` | 在某位置 splice 一段合法 GEML 片段(块 / prose,1+) |
| `delete` | `delete <file\|-> #id [#id2 …] [-o out]` | 删一个或多个块 |
| `rename` | `rename <file\|-> #old #new [-o out]` | 改 id 声明 + 同步所有引用 |

`revert` 扩展见 §4.5。

**动词数刻意收敛**:每个动词 = 一个意图 = 一条不变式 = 一种 blast radius,彼此正交、不重叠。砍掉的:`replace`(被 set/add/delete 覆盖)、`move`、`--as`(改 id 走 rename 或管道)、专用 `create`。

---

## 4. 共享骨架 + 逐动词行为矩阵

### 4.0 共享骨架

**块解剖**:每个可寻址块 = **HEAD**(围栏行 `=== type {#id .class k=v}` 或标题行 `## T {#id}`)+ **BODY**(到闭合围栏 / 小节边界的正文)。可寻址 id 只属于类型块、标题、脚注定义——裸段落(prose)无 id。

**内容来源(两个通道,set/add 共用)**:
- **`--in F[#src]`** —— 从 **GEML 文件 F** 取块(F 一律按 GEML 源处理,**忽略扩展名、不做 md 转换**)。`--in F#src` 指定块 `#src`;`--in F`(不带 `#src`)的隐式含义由各动词定义(set:抽 id == 目标 `#t` 的块,§4.1;add:F 的全部块,§4.2)。指定块不存在 → 报错 `no block with id #… in F`。
- **stdin**(不带 `--in`,或 `--in -`)—— 直接给的 raw 字节。
- 管道:文档走 stdin,内容源用 `--in F`(stdin 只能喂一个)。

**统一写盘守卫**(set / add / rename 共用一道门,delete 有例外见 §4.3):落位后**重解析**,当且仅当:① 无 error 诊断(无解析错、无重复 id、无断引用);② 意图 id 结果成立(set/add:目标 id 在;rename:#new 在、#old 无残留);③ 没误伤其它已有 id —— 才写盘;否则 exit 1、原样不动。**绝不写坏文档。**

**id 规则总原则**:**凡在命令上点名了目标 id,放进去的内容就取那个 id;set 必点(#id 是「改谁」的地址)→ 内容归一化成它;add 不点(id 从内容自带)→ 各块保留自身 id,撞车即失败。** rename / delete 按已有 id 寻址。改 id 只由 rename(或管道)完成。

**输出语义 / 可管道(所有变更动词一致)**:`set` / `add` / `delete` / `rename` 输出的都是**整篇更新后的文档**,绝不是片段(吐片段是 `get` 的活)。输出目标**镜像输入源**:

- **文件输入** → 默认**就地写回**该文件;`-o <path>` 改写别处,`-o -` 写 stdout。
- **stdin(`-`)输入** → 默认写 **stdout**(过滤器风格,供管道);`-o <path>` 落到文件。

因此天然可串成流水线:`… | geml set - #x --in a.geml | geml rename - #x #y | geml add - --after #z --in b.geml -o out.geml`(管道中文档走 stdin,内容源用 `--in FILE`——stdin 只能喂一个)。例:`rename doc.geml #a #b`(无 `-o`)= 就地把整篇 #a→#b;`rename doc.geml #a #b -o -` = 改完吐 stdout。

**破坏性变更**:这把现有 `set` 的默认从「总是 stdout」改成「文件输入→就地」——依赖 `geml set file … > out` 的脚本会受影响。属有意的大改,需 **版本号 bump + changelog**(见 §7/§8)。

**例外**:`revert` 需读同名 `.gemlhistory`,故只接受**真实文件**、默认就地写;可用 `-o -` 把结果吐给下游(能做管道**起点**,不能做中/下游)。

---

### 4.1 `set` —— 换已存在块 #id 的内容(归一化)

`#t` 是**地址**(必填,指现存块)。内容按「通道 × 模式」取。

**两个通道**:
- `--in F[#src]` = 从 GEML 文件 F 抽一个块:`--in F#src` 抽 `#src`;`--in F`(不带 `#src`)抽 **id == #t** 的块(隐式);F 里没有 → 报错。
- stdin(无 `--in` 或 `--in -`)= raw 字节。

**三个模式**(决定取块的哪部分 / 如何解释 raw):

| 模式 | 换 #t 的 | `--in F[#src]` 取 | stdin 取 | id 处理 |
|---|---|---|---|---|
| 默认(无 flag) | 整段(HEAD+BODY) | 抽出的整块 | 必须能解析成一个块 | **归一化成 #t**(只改 id,type/class/attrs/body 照搬) |
| `--head` | 只换 HEAD 行,留 BODY | 抽出块的头行 | raw 头行 | 归一化成 #t |
| `--body` | 只换 BODY,留 HEAD | 抽出块的 body | raw 正文(prose 从这来) | HEAD(含 #t)本就保留,无需归一 |

**id 归一化**(`normalizeBlockId(src, #t)`,`src/block-edit.ts`):把块/头行 HEAD 的 id 改写成 #t,覆盖全部形态——围栏 `{#x …}`→`{#t …}`(留其余 class/attrs)、标签闭合 `=== #x`→`=== #t`、标题 `## T {#x}`→`## T {#t}`、标题自动 slug(无 `{#…}`)→ 追加 `{#t}`、无 id 块 `=== note`→`=== note {#t}`。

**归一化例**:`set doc #intro --in draft.geml#rough`(draft 里 `=== note {#rough .lead}\nHello\n===`)→ doc 的 #intro 变成 `=== note {#intro .lead}\nHello\n===`(只 id 改成 #intro,其余照搬)。

**边角**:
- 默认模式内容非单块(纯 prose / 多块)→ **报错**;prose 情形提示用 `--body`。
- `--in F` / `--in F#src` 在 F 里找不到该 id → 报错 `no block with id #… in F`。
- 空内容(空 stdin / 空文件 / `--in -`)→ 统一友好报错 `no replacement content`。
- 守卫:splice 后重解析,无 error + #t 仍在 + 未丢其它 id 才写(复用 `spliceBlock`)。输出复用 `resolveOutTarget`(§4.0)。

---

### 4.2 `add` —— 在某位置 splice 一段合法 GEML 片段

**定位(三选一,必填其一)**:`--append`(文档尾)/ `--before #x` / `--after #x`。(置顶用 `--before <首块>`;不设 `--prepend`。)

**内容**:任意合法 GEML 片段——**块和/或 prose,1 个或多个**。片段原样 splice 到定位处。

- 各块**保留自身 id**(不归一化——`add` 未点名目标 id)。
- **id 冲突**(与文档已有 id、或批次内部重复)→ **直接失败**(exit 1,不写)。要改 id 后再加 → **走管道**(如 `geml get src '#b' | <改 id> | geml add doc --after #x --in -`)或先 add 再 `rename`。
- **纯 prose(无 id)→ 正常追加段落**(GEML 本就允许裸段落),无 id 冲突之虞。
- `--in FILE`(多块整文件)→ 把全部块/段落追加进来(批量导入 / 跨文件复制);id 须全部唯一。
- 定位锚点 `#x` 不存在 → 报错。空内容 → 报错(无内容可加)。

**覆盖「复制其他来源」两条路**:
- 抄成**新块**:`add --after #x --in src.geml#block`(块带自身 id,撞车则失败)。
- 批量抄:`add --append --in src.geml`(整份多块)。

---

### 4.3 `delete` —— 删一个或多个块

`delete <file> #id [#id2 …]`:

- **多 id**:一条命令删多个,避免多次调用。
- **缺失 id**:跳过 + 在 stderr 记一句,**不报错**(声明式「确保这些块不在」;exit 0)。
- **悬空引用**:删掉被 `[[#id]]` / `[t](#id)` / `[^id]` / chart `data=#id` 引用的块 → 产生悬空引用 → **只告警(warning),不拒写,exit 0**。理由:delete 是有意的破坏性操作,且可逆(见 §4.5);GEML 一般仍把悬空视为 error,故之后 `geml check` 会 loudly 报出——delete 本身不挡你,但下一次校验会提醒你去修或撤销。
- **原子性**:多 id 删除一次性重解析、一次性写盘;删除本身不会造成解析错(移除完整块 span 后周围仍合法),故 delete 结构上总能成功,唯一「副作用」是可能的悬空引用告警。

> 注:这是**对统一守卫的有意例外**——set/add/rename「绝不写坏文档」,delete 允许留下悬空引用(仅告警),因为它的意图就是移除、且有 revert 兜底。

---

### 4.4 `rename` —— 改 id + 同步引用

`rename <file|-> #old #new`:唯一「碰 span 外」的动词。**支持 stdin**(它只在文档文本里改 id + 引用,不碰 `.gemlhistory`,故能进管道:`… | geml rename - #a #b | …`)——这点与 `revert` 不同(revert 需 sidecar,只接受真实文件)。

- 重写 #old 的**声明**(围栏 / 标签闭合 / 标题 `{#…}` / slug),并**按 id 边界**改写**所有引用**:`[[#old]]`、`[t](#old)`、`[^old]`、chart `data=#old`。
- **id 边界**:`#old` 后不能再跟 `[A-Za-z0-9_-]`,避免误伤 `#old2`、`#old-x` 等前缀相同的 id。
- 守卫:重解析净 + #new 唯一(与现有 id 不撞)+ #old 彻底无残留(无声明、无引用)。
- 可选(实现待定):是否同步 `.gemlhistory` 里的 id —— 先不做,记为待办。

---

### 4.5 `revert` —— 回退,并**扩展为可复活已删块**

> **状态:推迟到后续「history 阶段」**——本次先做完全部正向动词(set/add/delete/rename)。history 阶段统一做:revert 复活、rename→`.gemlhistory` 同步、并**逐命令过一遍其 revert 语义**。以下为该阶段的设计,尚未实现。

现状:`revert <file> #id [--rev sel]` 把**现存**的 #id 换成历史版本。扩展:

- **#id 还在** → 就地换成历史版本(现状,不变)。
- **#id 已删** → **复活**:从历史修订取出 #id 那一块的源码,**重新插回**:
  - **默认按锚点推断位置**:在历史修订里看 #id 的**前一个仍存活的邻居**,插到其**之后**;若前面的邻居都已不在,则找**后一个存活邻居**插到其**之前**;都找不到 → 追加到尾部。(删完立刻 revert 的常见情形,邻居都在 → 精确归位。)
  - **可显式指定**:`--after #x` / `--before #x` / `--append` 覆盖推断。
  - 守卫:重解析净 + #id 现在存在且唯一。
- 前提:历史里有那一版,即**删前 `history commit` 过**。

**这使 delete 成为 per-block 可逆**:`revert #id` 直接把删掉的块(按原位或指定位)复活,不必再走 `history restore` 整文件回滚。

---

## 5. 覆盖 / 强大 / 一致 —— 对出发点的回答

**覆盖(§2 生命周期表)**:创建=写文本 / 转换;生长=`add`;编辑=`set`(+`--head`/`--body`)/`rename`;删除=`delete`;复制=`set --in F#src`(替换)/ `add --in F[#src]`(新增/批量);撤销=`revert`(含复活)。**全流程闭环,无需为任何增量改动重写整篇。**

**强大 / 灵活**:
- 复制两方向都通:替换到位(set 归一化,源 id 自动落成目标 id)、新增/批量(add 保留 id、整文件导入)。
- 编辑三粒度:整块 / 头 / 正文(`--head` / `--body`)。
- 删除批量 + 声明式容错(缺失跳过)。
- 删除可逆(revert 复活)。

**一致**:
- **共享三件套**:内容来源(stdin / `--in F` / `--in F#src`)、写盘守卫、`-o` 语义,四动词一致。
- **id 规则一条总原则**(§4.0):点名目标 id → 内容取之(set);不点名 → 内容自带(add);改 id 只走 rename。set 归一化与 add 不归一化的差异**由「是否点名地址」这条原则自然导出**,不是特例。
- **唯一的守卫例外**(delete 悬空→告警)有明确理由(破坏性意图 + revert 兜底),并写明其可预测边界。

---

## 6. 非目标 / YAGNI

- `set` 不支持多块(多块用 `add`)。
- `add` 无 `--as` id 覆盖(改 id 走 rename 或管道);无 `--prepend`。
- 无 `replace` / `move` / 专用 `create` 动词。
- `rename` 暂不同步 `.gemlhistory` 内的 id(待办)。
- `revert` 复活的位置推断只做「最近存活邻居 / 追加」,不做复杂结构对齐。

---

## 7. 交付物 / 改动范围(实现阶段)

- `geml-parser/src/geml.ts`:
  - **统一输出规则**(§4.0):文件输入→就地写回、stdin 输入→stdout、`-o <path>` 重定向、`-o -`→stdout;`set`/`add`/`delete`/`rename` 一致。**含把现有 `set` 默认从「总是 stdout」改为「文件→就地」(breaking)。**
  - `set`:加 id 归一化(默认 / `--head`)+ `--body` 模式;边角(多块报错、prose→`--body`、空内容统一友好报错)。
  - 新增 `add` / `delete`(多 id + 缺失容错 + 悬空告警) / `rename`(支持 stdin,按 id 边界改引用)。
  - 扩展 `revert`(复活已删块 + 位置推断 / 显式定位)。
  - USAGE / SUBHELP 更新。
- 测试(`geml-parser/test/`):逐动词行为矩阵 + 全部边角;沿用现有风格;覆盖率不低于现门槛(95%)。
- **版本号 bump + changelog**(package.json + `src/geml.ts` PARSER_VERSION):记 `set` 默认输出变更(breaking)与新增命令 —— 属大改,建议 minor 或 major。
- 文档:
  - `geml-parser/README.md`:**新增「设计出发点」理念段(§1 的理念,自然语气,含「可管道」)** + CLI 段改写为新模型。
  - 根 `README.md` / `README_CN.md`:CLI 段同步。
- **不动** parser / renderer 语义。
- 提交信息 / PR / 注释不出现任何模型标识符。

---

## 8. 待确认 / 风险

- `rename` 的引用改写按 id 边界(正则负向前瞻类),需测 `#old2`/`#old-x` 不误伤、跨文档引用是否在范围内。
- `revert` 复活的锚点推断在结构大改时会退化(退到追加);需清晰告知用户并支持 `--after` 显式定位。
- `delete` 留下悬空引用后 `geml check` 会 error —— 这是**有意**的(loudly 提醒去修/撤销),需在文档说明。
- `set` id 归一化的解析感知改写需覆盖全部 HEAD 形态(围栏/标签闭合/标题/slug/无 id)。
- **`rename` 后的 `revert`(已知限制,history 阶段处理)**:历史按提交时的 id(#old)记账,`rename` 只改文档不同步 `.gemlhistory`。故 `revert #new --rev <改名前>` 找不到 #new(那版是 #old);`revert #old` 在复活实现后会带回重复块。当前建议:rename 后 `history commit`,并**不要跨 rename 边界 revert**。history 阶段做 rename→sidecar 同步 + 复活去重来根治。
- **`rename` 已知残余**:id 边界替换跳过了 raw/data 块正文,但**无 id 的 raw 块正文**、以及 flow 内联的 `` `code` ``/`$math$` 里若出现 `#old` 字面仍会被改写(罕见);彻底解决需解析感知的内联定位。
