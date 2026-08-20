# Logseq 集成定界（scoping）

日期:2026-08-20 · 状态:**spike 已完成并在真图谱上验证**(见 §六) ·
结论先行:**做"DB 图谱的 GEML 序列化",不做 viewer 移植**

## 一、事实基础(2026-08-20 查证)

- Logseq 开源,**AGPL-3.0**,仓库活跃(当日有提交)。
- **2.0.1(DB 版)已于 2026-07 正式 release**;0.10.15(文件版最后一线)停在 2025-12。
- 官方公告([Logseq is splitting into two versions](https://logseq.io/p/e3YDyX5AYr)):
  - **Logseq OG**(Markdown 文件版):只维护——安全补丁、依赖升级,"maintenance and
    reliability rather than new feature development"。
  - **Logseq(DB 版)**:source of truth 是本地数据库,**没有文件层**。
  - Markdown 支持在 DB 版里是**未解决的公开问题**:官方还在"researching",
    候选方案包括"把每个 Markdown 文件当作数据库里的单个块"与"可靠的双向同步"。
  - 插件方向:"Plugin API upgrades and ClojureScript SDK" 列为 DB 版近期改进;
    `@logseq/libs` 0.0.17(2026-06 更新,即为 2.0 服务)。

## 二、判断

1. **viewer 移植(Obsidian 路线的复刻)不做。** OG 冻结,往冻结平台投入为零回报;
   DB 版没有"打开 .geml 文件"的位置——它根本不以文件为单位工作。
2. **"GEML 作为基础文件格式/全新 graph"没有宿主。** 两个版本各以其方式排除了它。
3. **真正的机会:GEML 作为 Logseq DB 的文本序列化格式。** 官方卡住的
   "Markdown 双向同步"问题,根因是 Markdown 无稳定块 id——这正是 GEML 语法层
   解决的问题。Logseq DB 的内部模型与 GEML 四能力逐项同构:

   | Logseq DB | GEML |
   |---|---|
   | 块 UUID | `{#id}` |
   | 块属性(typed properties) | 属性对象 `{key=val}` |
   | `{{embed ((uuid))}}` 引用嵌入 | `=== embed` |
   | DB 事务/历史 | `.gemlhistory` |

   导出即得到:git 可版本化、agent 可用 geml 动词按块编辑、`geml check` 可校验
   断链的图谱文本形态;导回时 `#id`=UUID 保证块身份不丢,往返因此可以无损——
   这是 Markdown 结构性做不到的。

## 三、方案分级

| 级 | 内容 | 判断 |
|---|---|---|
| A | OG 插件渲染 ```geml 块 | 不做(平台冻结) |
| B | DB 版插件渲染 ```geml 块 | 顺手可做,非重点 |
| **C** | **导出/导入插件:DB 图谱 ⇄ .geml,无损往返** | **主攻。先做 spike** |
| D | 引擎级贡献(AGPL,ClojureScript) | 只在 C 撞上插件 API 天花板后考虑 |

## 四、Spike 定义(C 的第一步)

用最小的代码对着一个真实 DB 图谱验证(定稿时设想走 `@logseq/libs` 插件;
实际 spike 走了更轻的官方 CLI `export-edn`/`import-edn` 路线,见 §六):

1. **导出**:全部页面 → 每页一个 `.geml`;块 UUID → `{#id}`,属性 → 属性对象,
   块层级 → 标题/列表结构,`{{embed}}` → `=== embed`。
2. **校验**:导出物 `geml check --root .` 全绿(引用即 UUID 引用,断链当场可见)。
3. **回改**:在导出物上用 `geml set` 改一个块。
4. **导入**:把改动作为事务写回 DB(按 `#id`=UUID 定位块)。
5. **成功标准**:导出→导入(零编辑)后图谱无 diff;导出→`geml set` 一块→导入后
   **仅**目标块变化。

### Spike 要验证的插件 API 能力(未验,勿当结论)

- 读:`Editor.getAllPages` / `getPageBlocksTree` / `DB.datascriptQuery` 在 2.0 的可用性
- 写:按 UUID 更新块内容/属性的 API;批量事务
- 属性的类型保真(数字/布尔/引用型属性 ⇄ GEML 属性值)
- 插件能否触碰本地文件系统(导出落盘),还是要走下载/剪贴板

## 五、开放问题

1. 用户实际运行的版本(OG 还是 2.0)——决定 spike 在谁的机器上先跑。
2. AGPL 边界:插件走 `@logseq/libs`(sandboxed iframe),沿社区惯例可独立许可;
   引擎级(方案 D)则整体 AGPL。
3. 命名:`logseq-geml`?进 Logseq marketplace 的要求待查(独立仓库?)。
4. 与 Obsidian 线共享的"渲染核心抽包"对 B 有用,对 C 无关——C 不渲染,只序列化。

## 六、后记:当日实测结果(§四的全部判据已过)

- fixture 4/4(判据即 `integrations/logseq/test/roundtrip.test.mjs`);
  真图谱(schema 65.22)只读往返**结构恒等**,`--edit` 探针经
  `geml set → import-edn → logseq validate: Valid!`,再导出确认
  **按 uuid 原位合并、零复制**——§四第 5 条的"合并语义"问题就此有了答案。
- 无 GUI 建图可行(`bin/create-graph.mjs`):CLI vendor 了整套 logseq.db,
  `open-db!` + `build-db-initial-data` 即建,产物被官方 list/show/validate 认可。
  坑:目录要自己 mkdir;Node 24 下 better-sqlite3 需 override 到 ≥12.11.1
  (引用实测数字时须注明此偏差)。
- 真导出教的两课:`:blocks []` 空向量≠缺键(已修);**uuid 只在块被引用时导出**
  ——寻址密度取决于图内引用密度。
- 块引用在标题里就是 `[[<uuid>]]`,离 GEML 受校验的 `[[#uuid]]` 一个字符,
  §三"引用翻译"的成本比预估更低。
- **官方 CLI 的 mcp-server 自带 `upsertNodes`(含 dry-run)**:交互式点编辑
  是官方链路的主场,本方案不与之竞争——GEML 的位置是文本资产层
  (git/批量重构/全树校验/跨语料引用/逃逸通道),两条链路互补。
