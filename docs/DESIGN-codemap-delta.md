# Code Map 增量设计(v2 Δ v1)—— 基于已交付 geml-code-graph 的差异改造

- 状态:**评审定稿**(2026-07-03,经三轮 review 收敛;逐条定案见 §11)
- 输入:v1 =《方法级调用链导航系统》(P0–P2 已交付,见 `DESIGN-geml-code-graph.md`);v2 =《GEML 代码地图 Code Map v2》(CODEMAPDESIGN.md)
- 方法:**只对 v2−v1 的差异设计**;v1 已交付且 v2 未推翻的原样保留。
- 总原则(评审中确立):**GEML 标准零改动优先**——领域语义放进一份有名有姓的 **codemap profile**(词汇表文档)+ codemap 自己的 `verify` 工具,而不是给标准加机制;唯一的 GEP 是 `geml-code-graph` 渲染 format(阶段 B)。

## 0. Delta 总表

| # | 差异 | 处置 |
|---|---|---|
| Δ1 | **人类可视化**(v1 的 non-goal 被 v2 推翻) | 新增 `geml-code-graph` diagram format(§2,阶段 B 唯一 GEP);生成文件本身**不含** diagram 块 |
| Δ2 | **明细层**(field/const、reads/writes) | 大幅收缩(§3):模块级 consts 进唯一 meta;方法级明细不记;reads/read-by **缓建**,`#ref-by` 表为预留形状 |
| Δ3 | **entry** | 模块级事实 → 容器 meta 的 `entry =` 键(§4);app 入口 → index meta;**不在块上盖章** |
| Δ4 | **边载体**:块内引用行 → 每容器 CSV 边表 | `#calls` / `#called-by` / `#unresolved` 三表(§5);校验 = profile 约定 + verify 工具,**无 refcols 等标准机制** |
| Δ5 | **符号块形态** | `code {#login src=path#Lx-y anchor="…"}` 空体(§6);src= 是普通属性,agent 直接消费 |
| Δ6 | **容器粒度参数化** | `--container=module|dir|file`(§7) |
| Δ7 | **抽取选型** | SCIP 新增(TS 先、自举 geml-parser),Joern/crg 保留——**家族扩容,非替换**(§8) |
| Δ8 | **增量模型** | v2"每次提交全量重生成"= 已交付的"确定性全量+仅写变更+`--history`",零改动 |
| Δ9 | **v1 硬需求守住** | F3 反向 → `#called-by`;F6 → confidence 列 + candidate 行;盲区 → `#unresolved` 表;F4 → name-lookup 保留 |

实测前提(2026-07-03,现有 parser):CSV 单元格与 meta 值中的引用**不被 `geml check` 校验**;`meta {of=}` 不受检;空体 code 块 + 任意属性合法。→ 边完整性校验全部落在 codemap `verify`(profile 约定),标准不动。

## 1. 管线(与已交付架构同构)

```
adapter(scip|joern|crg)→ symbols/edges.jsonl(交换格式,已有)→ emit(改造)→ codemap/ 纯数据文档
                                                                  ↓
                                                    verify(按 profile 校验边表引用)
                                                                  ↓
                                             消费:人=渲染器视图(阶段B) / agent=geml get+skill+MCP
```

## 2. Δ1 渲染:`geml-code-graph` format(阶段 B,唯一 GEP)

**两个场景,一个原则:视图配置跟着数据走。**

- **场景①(codemap 内)**:生成文件是**纯数据**,不含 diagram 块。Profile 声明:识别到 codemap 文档(meta 含 `module =` / `container =`)的渲染器 SHOULD 提供分层方法流视图,roots = 该文档 meta 的 `entry`,深度 = meta 可选 `graph-depth` 或渲染器默认。
- **场景②(在任意文档嵌一张图)**:

  ```geml
  === diagram {format=geml-code-graph src=codemap/index.geml}
  ===
  ```

  **唯一属性 `src=`**,指向 codemap 文档;roots/depth 一律读目标文档的 meta——嵌入点永远不会与数据漂移。要不同的根 = 指向不同的容器文档;方法级下钻 = 交互(点击换根),不是作者属性。
- **分层算法进规范文**(O(V+E)):切片内 DFS 摘回边(回边虚线回勾、自递归环徽标,v2-D9)→ 最长路径分层 → 层内稳定排序。数据构建期、布局绘制期(v2-D8);`.leaf` 目标默认淡化/折叠,`.test` 可过滤。
- 渲染器 MAY 按符号块 `src=` 加载源码显示(v2-D10),作为本 format 的渲染行为,不设独立 spec 条款。
- 落点:CLI `geml render`(循表格先例:模型构建期 + 嵌入式 JS 运行期,内嵌 roots 可达闭包)+ viewer/playground(在线按需 fetch);交互 demo 移植。含一致性用例 + 第二实现(geml-chart 先例全套)。

## 3. Δ2 明细层(收缩后)

- **模块级 consts**:进容器唯一的 meta(`consts = JWT_SECRET SESSION_TTL …`)。方法级 consts/局部变量**不记录**(无影响分析价值)。
- **正向 reads 不物化**:方法读了什么,打开其源码(`src=` 一跳)即见;图的独特价值在反向。
- **反向 read-by:阶段 A 缓建**(无消费场景不建,纪律同 GEP-0002)。预留形状(写进 profile,启用时生成器加一张表,格式不动):

  ```geml
  === table {#ref-by format=csv hidden}
  from,             to,          kind,  member
  auth.geml#login,  #loadConfig, reads, JWT_SECRET
  ```

  member 列纯文本(细符号不建块);from/to 由 verify 校验。

## 4. Δ3 entry(两级,各归其位)

- **模块级事实 → meta**:`entry = #login`(多值空格分),生成器算(存在容器外调用者)并写入;块上**无** entry 属性。
- **app 入口 → index meta**:`entry = server.geml#boot server.geml#handleLogin`。
- **符号级事实 → 块 class**:`.leaf`(零出边含未解析且被调)、`.test`(测试领地)保留;`exported`(声明可见性)等 SCIP 提供后作参考信息另议。

## 5. Δ4 边表家族(每容器至多三张)

```geml
=== table {#calls format=csv}
from,        to,                     kind,      confidence
#login,      db.geml#getUserByEmail, call,
#login,      crypto.geml#verify,     call,      medium
#login,      crypto.geml#verifyHmac, candidate,
#issueToken, crypto.geml#sign,       call,
===

=== table {#called-by format=csv}
from,                    to,     kind, site
server.geml#handleLogin, #login, call, src/server/routes.ts:88
===

=== table {#unresolved format=csv hidden}
from,   to
#login, log.debug
===
```

- **`#calls`**(出边):confidence 空 = high;candidate 行紧随其主 call 行、置信度继承(F6 守住)。
- **`#called-by`**(入边,生成器聚合):同文件正反俱全——agent 一次 get、`dir=in` 渲染前沿懒加载成立(补 v2 缺口);site 列纯文本;candidate 如实镜像。
- **`#unresolved`**(盲区,hidden):to 列纯文本不校验;它是边,归表家族,不占 meta。
- **空表不生成**。
- **校验(profile 约定,verify 执行,非标准机制)**:`#calls`/`#called-by`(及启用后的 `#ref-by`)的 from/to 列逐格解析引用,悬空 = 构建失败;meta 的 `entry` 值同样受检。

## 6. Δ5 定稿文件形状(每文件恰好一个 meta)

**容器文件 auth.geml:**

```geml
=== meta
module = auth
src = src/auth/
entry = #login
resolution-default = cpg
===

# auth

=== code {#login src=src/auth/login.ts#L42-58 anchor="ts:src/auth/login.ts#login"}
===

=== code {#issueToken src=src/auth/token.ts#L10-31 anchor="ts:src/auth/token.ts#issueToken"}
===

(#calls / #called-by / #unresolved 三表,见 §5)
```

**index.geml:**

```geml
=== meta
repo = demo-shop
commit = 42b5788
container = module
entry = server.geml#boot server.geml#handleLogin
resolution-default = cpg
===

# Code map — demo-shop

=== table {#modules format=csv}
module, doc,         methods, entries, tests
auth,   auth.geml,   2,       1,       0
…
===

=== table {#module-edges format=csv}
from, to,     calls
auth, crypto, 3
…
===
```

- `code src=path#Lx-y`:**普通属性**,agent 读字符串自己开文件;源码显示语义归 §2 的渲染 format。
- 块 id = 短名(容器内唯一);重名 → 追加 `-hash6`。改名 = 断边 = verify 报错(特性)。
- `anchor=` 保留(跨引擎稳定身份)。
- name-lookup.json 原样(F4)。

## 7. Δ6 容器粒度

`--container=module|dir|file`(class 延后):`module` = 仓库根/src 下一级目录聚合(可映射文件覆写),`dir` = 现状,`file` = 每源文件。index 聚合表(`#modules`/`#module-edges`)为纯统计,不参与引用校验。

## 8. Δ7 抽取器家族

- `scip`(新):TS 先(scip-typescript),**首个目标 = geml-parser 仓库自举**;坑先说破——SCIP 无现成调用边,需由"引用 occurrence ∈ 方法 enclosing_range"推导(缺失则区间近似并降 confidence);接口多实现走 `relationships: implementation` → candidate 行。
- `joern`(保留):C/C++/Java,P1 已验证(跨文件 12→23,235)。
- `crg`(保留):兜底,heuristic。
- 交换格式不变(edges 增 kind 枚举即可)。

## 9. 消费(agent 侧微调)

- skill:resolve_name(name-lookup)→ `geml get doc '#login'`(块)+ 读 meta(entry/consts)→ 读 `#calls`/`#called-by` 表跟引用 → `#unresolved` 知盲区。
- MCP:open_symbol/resolve_name 不变;get_backlinks 改读同文档 `#called-by` 表。
- `--history`/revert 原样(v2 §7 诉求直接吃现成)。

## 10. 阶段划分

| 阶段 | 内容 | spec 依赖 |
|---|---|---|
| **A(开工项)** | emit 改 v2 定稿形状(§4–6)+ verify 按 profile 校验 + `--container` 参数 + **codemap-profile.md**(词汇表:meta 键、表 schema、id 规则、校验规则)+ skill/MCP 适配;valkey(Joern 数据)重生成验收 | **零** |
| **B ✅(2026-07-03)** | GEP-0003(format 注册 + 分层算法规范文 + 回边规则)+ CLI 渲染器(嵌入式 JS 绘制期布局:点击换根/回边虚线/candidate 点线/.leaf 淡化;场景①自动出图 + 场景②嵌入;400 节点毛球保险)。浏览器 DOM 实证 + valkey/自举双数据源渲染通过。viewer/playground 支持与 demo 移植留作后续 | GEP-0003 已立(accepted) |
| **C ✅(2026-07-03)** | `adapters/scip.mjs`(内嵌极简 protobuf 读取器直读 index.scip——scip CLI 无 Windows 产物;enclosing_range 归因调用方,接口实现→candidate,未定义符号→unresolved)+ geml-parser 自举:166 方法/10 容器,verify 11/11,entry 计算精准(render.ts 唯一入口=renderHtml),自己的渲染器画自己的调用图闭环 | 零 |

## 11. 评审定案记录(2026-07-03)

1. 反向导航 = 同文件 `#called-by` 表(替代 `_backlinks/` 镜像目录)。✅
2. F6 = `#calls` 扩 confidence 列 + candidate 行。✅
3. 明细层:否决"细符号 hidden 块化"(领域属性铺得太开)与 refcols 标准机制;定为 profile + verify 工具级校验;每文件恰好一个 meta;方法级明细不记,模块级 consts 进 meta。✅
4. entry:从块属性上移到容器 meta;`.leaf`/`.test` 符号级 class 保留。✅
5. diagram:生成文件零 diagram 块(场景①);嵌入场景唯一属性 `src=`(场景②);format 定名 **geml-code-graph**;roots/depth 永远来自 src 指向文档的 meta。✅
6. `code src=` = 普通属性,不设 spec 条款;渲染加载语义并入 format GEP。✅
7. read-by:阶段 A 缓建,`#ref-by` 为预留形状(用户未反对,按推荐定案,可随时推翻,零沉没成本)。✅
8. Joern 不被替换,SCIP 为新增。✅
