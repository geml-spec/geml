# codemap profile v1 — 词汇表与约定

- 状态:随 `DESIGN-codemap-delta.md` 定稿(2026-07-03)
- 性质:**应用层 profile,不是 GEML 标准的一部分**。GEML 标准保持不动;本文档定义 codemap 生成物使用的类型、属性、meta 键、表 schema 与校验规则——如同 schema.org 之于 HTML。生成器/校验器随 `@geml/geml` 包分发:`geml codemap build` / `geml codemap verify`(源码 `geml-parser/codemap/`)。

## 1. 文件布局

```
.geml-code-graph/          %% 默认输出目录名(更早的 codemap/、graph/ 目录:重新生成一次替代即可)
  index.geml                 总入口:仓库元信息 + 模块聚合表
  <container>.geml           每容器一份(module|dir|file 粒度,--container)
  _index/name-lookup.json    名称 → {anchor, doc, id}(F4)
  _build/                    原始索引产物 + symbols/edges.jsonl(中间物,可重生成/gitignore,agent 不读)
```

容器文档名 = 容器**展示路径**净化(见 §2 `module`;`/`→`--`,非 `[A-Za-z0-9_.-]`→`-`);冲突追加 `-2`。

**生成范围**:build 默认跳过被 `.gitignore` 忽略的源文件(vendored 副本、构建
产物不进图);`--exclude <glob>`(可重复)排除仍被 git 跟踪的路径;
`--no-gitignore` 关闭 git 侧过滤。被排除符号的边随之消失,不留悬空引用。

## 2. 文档规则

- **每文档恰好一个 `meta` 块**,键:
  | 键 | 出现 | 含义 |
  |---|---|---|
  | `module` | 容器文档 | 容器**展示路径**:真实目录剥去 ceremony 后的短路径。以构建清单(pom.xml/package.json/tsconfig.json/go.mod/Cargo.toml 等)所在目录为模块根,先剥掉构建源码根(`src/main\|test/<lang>`、裸 `src`),再剥掉该模块内共享的最长公共段前缀:`magic-api/src/main/java/org/ssssssss/magicapi/core/config` → `magic-api/core/config`。测试代码(`src/test/*`、顶层 `test`/`tests`/`__tests__`/`spec`)归入顶层 `test/` 分支;单模块仓库以仓库名作模块段;file 粒度同样归一,但保留文件名(不整段收拢)。只影响展示与文档名 |
  | `src` | 容器文档 | 源目录/文件**真实**相对路径(不归一——定位源码用) |
  | `entry` | 有入口时 | 空格分隔的引用列表:**被容器外调用**的方法,或 app 入口(main);**受 verify 校验** |
  | `resolution-default` | 均 | `cpg` / `heuristic`(本文档边的默认解析来源) |
  | `repo` / `commit` / `container` | index | 仓库名 / git 短哈希 / 容器粒度 |
  | `graph-depth` | 可选 | 渲染深度覆写(渲染器默认 6) |
  | `consts` | 预留 | 模块级常量名单(抽取器提供后启用) |
- 标题 `# <容器名>`;容器跨多个源文件时,按 `## <文件名>` 分节(包含关系 = 文档结构)。

## 3. 方法块

```geml
=== code {#hashtableFind src=hashtable.c#L1606-1616 anchor="c:hashtable.c#hashtableFind(bool(hashtable*,void*,void**))"}
===
```

- **空体**;`src=` 为普通属性(`路径[#L起-止]`),agent 直接读取后自行打开源码;渲染器 MAY 据此显示源码(归 `geml-code-graph` format,阶段 B)。
- `anchor=` = 引擎级稳定身份(语言:文件#名称(签名))。
- `name=`(可选)= 展示名,仅当 id 净化改变了它时写入(如 `RenderCtx.block` → id `RenderCtx-block`);渲染器用它做节点标签,引用仍走 id。
- **id 规则**:方法短名(净化为合法 id);同文档内重名 → 全部追加 `-<sha256(anchor) 前 6 位>`;若前 6 位在该重名组内仍碰撞,该组统一升到 8、10……位(按需升级,不全局加长)。改名 = id 变 = 引用悬空 = verify 报错(特性,不是缺陷)。
- 符号级 class:`.leaf`(零出边**含未解析**且被调)、`.accessor`(bean 型 get/set/is 叶子——渲染器默认隐藏,带可见计数与开关;表数据不受影响)、`.test`(测试领地路径约定)、`.flow-entry`(引擎给出的关键执行流入口,可选)。
- **entry 不在块上**——它是模块级事实,只出现在 meta(§2)。

## 4. 边表(每容器至多三张;空表不生成)

| 表 id | 列 | 说明 |
|---|---|---|
| `#calls` | `from, to, kind, confidence` | 出边。kind ∈ `call` / `candidate`(虚分发/接口多实现的候选,紧随其主 call 行,置信度继承);confidence 空 = high |
| `#called-by` | `from, to, kind, site` | 入边(生成器全图聚合)。site = `文件:行`,纯文本 |
| `#unresolved` | `from, to` | 盲区(hidden)。to = 未解析目标的原文,**纯文本不校验** |
| `#ref-by` | `from, to, kind, member` | **预留**(reads/writes 反向,member 为纯文本字段名;启用另行决定) |

- **引用语法**(from/to 列、meta `entry` 值):`#id`(本文档)或 `doc.geml#id`(相对路径兄弟文档);预留的 reads 值可带 `.member` 纯文本后缀(id 字符集不含 `.`,机械可切)。
- 纯文本单元格(site、unresolved to)不得含逗号/换行(生成器以空格替换),且方括号替换为圆括号——**表格单元格会被 inline 解析**,`f[i](&x)` 会被误读为链接。

## 5. 校验(职责分工)

- `geml check`(标准):文档结构、id 唯一、原生引用。**CSV 单元格与 meta 值对标准不透明——设计使然,标准不为 codemap 开洞。**
- `verify.mjs`(profile):`#calls`/`#called-by`/`#ref-by` 的 from/to 逐格解析 + meta `entry` 值解析;悬空 = 构建失败(exit 1)。构建后必跑;红了 = 图过期或漏更新,先重建再信导航。

## 6. 渲染(阶段 B,唯一 GEP:`geml-code-graph` diagram format)

- **场景①(codemap 内)**:生成文档是纯数据,**不含 diagram 块**。识别到 codemap 文档(meta 含 `module =`/`container =`)的渲染器 SHOULD 提供分层方法流视图:roots = 该文档 meta `entry`,深度 = `graph-depth` 或默认;`.leaf` 淡化、`.test` 可过滤;回边虚线、自递归环徽标。
- **场景②(任意文档嵌图)**:`=== diagram {format=geml-code-graph src=.geml-code-graph/index.geml}` ——**唯一属性 `src=`**;roots/depth 永远读 src 指向文档的 meta(视图配置跟着数据走)。下钻 = 交互,不是作者属性。

## 7. 版本化

`build.mjs --history [-m msg]`:变更文档提交进各自 `.gemlhistory`;`geml history log` 看图的演变、`geml revert doc '#方法' --to -1` 单方法回滚。

## 8. 消费速查(agent)

```sh
node -e "console.log(JSON.stringify(require('./.geml-code-graph/_index/name-lookup.json')['hashtableFind']))"
geml get .geml-code-graph/hashtable.c.geml '#hashtableFind'     # 方法块(src= 一跳到源码)
geml get .geml-code-graph/hashtable.c.geml '#calls'             # 出边;跟 doc.geml#id 引用继续走
geml get .geml-code-graph/hashtable.c.geml '#called-by'         # 谁调我(含 site)
head -8 .geml-code-graph/hashtable.c.geml                       # meta:entry 面一眼可见
```

信任语义:`resolution-default` 说明边怎么来的(`cpg` 精确 / `heuristic` 语法级);confidence 列与 candidate 行是解析器拒绝替你猜的地方;`#unresolved` 是盲区不是"没有";heuristic 下"无 `#called-by` 行"≠"无调用方"。
