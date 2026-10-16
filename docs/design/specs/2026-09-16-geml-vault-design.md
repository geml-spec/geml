# geml-vault — 在 Markdown 知识库上叠一层块寻址 · 设计文档

日期：2026-09-16 · 状态：**已批准（2026-09-16），P0–P3 已实现** · 基线：`main` @ `91c8411`（实现分支已 rebase 到此）
前置阅读：`integrations/obsidian/README.md`（现有的 `.geml` 渲染插件）、`geml-parser/src/cli.ts` §`gemlFilesUnder`、`.claude/skills/geml/instructions.geml`
调研对象：[claudian](https://github.com/YishenTu/claudian)（Obsidian 原生插件）、[claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) v1.6.0（vault 模板 + 11 个 Claude Code skill）、[claude-obsidian-assistant](https://github.com/nemocake/claude-obsidian-assistant)（轻量 vault 模板）

---

## 0. 一句话

不动 Markdown 一个字节，给 Markdown 知识库配一套"先拿地址再动手"的 agent 纪律：`geml find` 定位到 `file#address`、`geml get` 只取那一块、`geml set`/`add` 只改那一块，替换掉"Grep 拿行号 → Read 整页 → Edit 凑 old_string"这条既费 token 又易错的老路。

## 1. 出发点

### 1.1 调研结论：两个项目不在一个层

| | claudian | claude-obsidian / -assistant |
|---|---|---|
| 形态 | Obsidian 原生插件（TS + esbuild，Obsidian ≥1.13，仅桌面端） | vault 模板 + Claude Code skills |
| 干什么 | 把 Claude Code/Codex/Grok/OpenCode 塞进侧边栏，vault 即 agent 工作目录 | 定义知识库的结构与流程（`.raw/` → `wiki/` → `CLAUDE.md` 三层，Karpathy LLM-Wiki 模式） |
| 对笔记格式的假设 | 几乎没有——只是 UI + runtime | 全部都是——frontmatter、wikilink、Dataview/Bases、canvas、index/log/hot 约定 |

"用 GEML 替换 Markdown"只对第二类有意义；claudian 那边没有可替换的东西。

### 1.2 为什么不是"把 `.md` 换成 `.geml`"

拿 claude-obsidian v1.6.0 的真实页面做往返转换，实测损耗：

| 方向 | 现象 | 性质 |
|---|---|---|
| md → geml | `tags: [meta, dashboard]` → `tags=""`；`related: [[index]]…` → `related=""` | **数据丢失**（`=== meta` 是扁平 key=value，容不下 YAML 列表） |
| geml → md | `[[index]]` → `\[\[index\]\]` | 链接全断 |
| geml → md | `> [!tip] 标题` → `=== note` → 转义的引用块 | callout 失效 |
| geml → md | `![[dashboard.base]]` → 转义 | 嵌入失效 |
| geml → md | `---`（分隔线）、heading id | 丢弃 |

加上结构性事实：Obsidian 的 graph view、backlinks、Bases/Dataview、canvas、全文搜索、移动端**全部只认 `.md`**；本仓现有的 `integrations/obsidian/main.ts` 是 76 行只读 `TextFileView`，能渲染 `.geml` 但不能编辑、不解析链接、不喂 graph。

尺度上也不划算：该 vault 46 页 4158 行，**平均 90 行/页**，最大 348 行。GEML 的核心价值是"不整读、只取块"，90 行的页面本来就整读了。收益集中在会无限长大的控制面文件（`index.md`、`log.md` 218 行且只增不减、`hot.md`）上，不在普通笔记页上。

（注：这是插件自带的演示 vault，成熟用户的 vault 可能更大，此数据有偏。）

### 1.3 那 geml 在这里到底出什么力

三件 grep + Read + Edit 做不到的事：

1. **地址不是行号。** 行号在上方任何改动后即失效；`#entities` 不会。
2. **写入是外科手术。** 实测：`geml set` 后 frontmatter 与其余所有块**逐字节不变**，且 Obsidian 语法（callout / wikilink / embed）**原样写入、未被转义**。不需要读整页去凑 `old_string`。
3. **离线。** claude-obsidian 今天的"外科手术式编辑"依赖 Obsidian Local REST API 的 `PATCH`，要求 Obsidian 开着 + 装插件 + API key（`skills/wiki/references/rest-api.md`）。geml 路径不要求任何进程在跑。

### 1.4 被否决的路线，及其代价

**全 `.geml` vault**：只有在放弃 Obsidian、自己做阅读器时才成立（本仓有 geml-viewer + playground）。那就不是扩展 Obsidian 而是和它竞争。若将来要做，最小改造清单是：`=== meta` 支持 YAML 列表、md writer 不转义 `[[`、callout 往返保真、把 `integrations/obsidian` 从只读视图升级成可编辑视图 + 链接解析 + graph 数据源。本设计**不做**，记录于此以免重新论证。

**vault 索引派生物**（仿 `.geml/codemap/`）：会陈旧，且本设计选择了"修真缺口"（§3）而不是"加一层缓存"。

**提升为 CLI 子命令 `geml vault graph|lint` + `geml-vault/v1` profile**：有先例（`geml codemap build/verify`），但路径 3 的图谱逻辑还没被真实用例打磨过。先在 `integrations/` 里当脚本养着，跑顺了再按 codemap 的成例提升。见 §10。

## 2. 形态与目录

核心 skill 对**任意 Markdown 知识库**通用，不假设 claude-obsidian 存在；它的约定单独做成一份适配层参考。产物全部落在现有的 `integrations/obsidian/`，让该目录成为"GEML ↔ Obsidian 的全部"：渲染侧（看）+ agent 侧（改）。

```
integrations/obsidian/
  main.ts  manifest.json  esbuild.config.mjs      # 现有渲染插件，本次不动
  README.md                                       # 改：分「看」「改」两节
  package.json                                    # 改：加 test 脚本 + @geml/geml 依赖
  skills/geml-vault/
    SKILL.md                                      # 核心：块寻址纪律
    references/invariants.md                      # 实测不变量与禁忌
    references/claude-obsidian.md                 # 适配层
  scripts/vault-graph.mjs                         # P2
  test/fixtures/vault/                            # 回归夹具
  test/vault.test.mjs                             # 不变量回归
geml-parser/src/cli.ts                            # P0
```

## 3. P0 — `geml find` 的目录遍历按后缀识别

`gemlFilesUnder`（`cli.ts:1330`）当前对目录只收 `*.geml`。实测后果：对一个全是 `.md` 的 vault 目录，`geml find` **一条也搜不到，且静默返回**。

改为按后缀收 `.geml` **和** `.md`，**不加开关**。理由：`--from` 本来就靠后缀推断（`cli.ts:751`），而 `get`/`list`/`set` 都能直接处理 `.md`——目录遍历把 parser 原生能读的一种格式排除在外，是它自己前后不一致。`cli.ts:1328` 那段注释（"taking every file would drag the whole source tree through the parser"）要重写：过滤器仍在，不会把 `.ts`/`.py` 拖进 parser，但收的是"parser 认的两种格式"而非"只有 .geml"。`.gemlhistory` 不以 `.geml` 结尾，自动仍排除；隐藏目录与 `node_modules` 的跳过规则不变。

**这是行为变更，不是 bugfix**，CHANGELOG 要如实记：改完之后在本仓 `geml find X .` 会开始扫 `spec/*.md`、`docs/*.md`、`README.md`。

验收：`geml-parser/test/find.test.mjs` 新增用例 → `node test/all.mjs` → `npm run coverage:check`。不动 `geml.ts` 顶层导出，因此不触发 viewer esbuild stub 的镜像要求（实现时实测确认，别假设）。

## 4. P1 — 核心 skill 的契约

**读**（替换 Grep 拿行号 → Read 整页）

```sh
geml find '<字面串>' <dir> --head     # → file ⇥ #address ⇥ 命中行
geml get  <file> '#address' --body    # 只取这一块
```

**写**（替换 Read 整页 → Edit 凑 old_string，以及对 REST API 的依赖）

```sh
geml list <file>                       # 先拿地址，不是行号
geml set  <file> '#id' --body --in -   # 改一块
geml add  <file> --after '#id' --in -  # 插一块
geml add  <file> --append   --in -     # 追加（log 页）
```

**禁忌，全部来自实测，逐条进 `references/invariants.md`：**

1. **绝不对 frontmatter 块跑 `set`。** 闭合的 `---` 属于该块 body，替换后消失，整页 YAML 失效——Properties、Dataview、graph 关系边一起断。frontmatter 标记为只读，要改用别的手段。
2. **绝不拿 `@hash` 地址做写入。** `@anon` 是内容哈希，改完即变（实测 `@07bb2b3b` → `@e9c420e9`）。写只用 `#id`。
3. **已存在的页面禁止 `Write`**（会毁 frontmatter 和其余块）；新建页才用。
4. `find` 是**字面子串、不是正则**（`Hot.Cache` 搜不到）。
5. `find --head` 每块只回**第一条**命中行——一个有 13 个 wikilink 的块只吐一个。定位靠 `find`，抽全部内容要另跑 `get` 或 `--to json`。
6. `set --body` 会连块尾的 `---` 分隔线一并替换。
7. `set` 后标题与正文之间的空行会被吃掉（仅观感，不影响 Obsidian 渲染）。
8. 目录遍历跳过隐藏目录 → `.raw/` 这类点开头目录必须显式指名。

## 5. P2 — `scripts/vault-graph.mjs`

依赖走 `geml-agent-runtime` 的成例：`"@geml/geml": "file:../../geml-parser"`。

**为什么不是 grep 脚本**：`[[x]]` 出现在 ```` ```dataview ```` 里不是链接。走 parser 的文档模型能按块类型跳过 code/raw，grep 不能。这是 geml 在这一步真正出力的地方。

抽链接的来源有两处，**容易漏第二处**：块正文，以及 **frontmatter**——`related: - "[[index]]"` 在 Obsidian Properties 里是真实的图边。

归一化：`[[Folder/Name#Heading|Alias]]` → 目标 `Folder/Name`，剥锚点、剥别名；`![[...]]` 嵌入算链接。解析按 basename 全库匹配，`Folder/Name` 走路径限定，重名进 `ambiguous`。

输出 **stdout JSON，不落盘**（不制造会陈旧的派生物）：

```
{ pages: [{path, outbound, inbound}], orphans: [path], dead: [{from, address, target}], ambiguous: [...] }
```

`dead` 每条带**块地址**而非行号——所以修复动作直接就是 `geml set <file> '#address'`。这条是它区别于 grep 脚本的地方。

## 6. P3 — 历史：默认关

`geml history save <page>` + `geml revert <page> '#id'`。代价说明白：每改一页多一个 `<page>.md.gemlhistory`，会进 Obsidian sync 和 git。

claude-obsidian **已经有 PostToolUse 的 git-add 钩子在版本化整个 vault**，再叠一层按块历史是重复的。适配层里直接写"这个别开"。四条路径里这条最弱；若要砍范围，先砍它。

## 7. 适配层 `references/claude-obsidian.md`

- 目录：`.raw/`（点开头，遍历跳过，**必须显式指名**）+ `wiki/`
- `index.md` 的块地址已实测稳定：`#concepts` `#entities` `#sources` `#questions` `#comparisons` `#decisions` `#domains`——新增一条 entity 就是 `geml set wiki/index.md '#entities' --body`
- frontmatter schema（`type`/`title`/`updated`/`tags`/`status`/`related`）标记为**只读**，不经 geml 改（§4 禁忌 1）
- 替换点清单：`wiki-ingest` 的"读 3-5 页"、`wiki-query` 的检索、`wiki-lint` 的链接类检查
- **地雷**：`.vault-meta/address-counter.txt` 只能经 `scripts/allocate-address.sh` 改。`wiki-ingest/SKILL.md:226` 写明 Write/Edit 会触发 PostToolUse 钩子里的 `git add wiki/ .raw/`，可能误提交无关的待定改动
- 定位说明：geml 路径是 REST API `PATCH` 的**离线**替代，不要求 Obsidian 开着

## 8. 测试

`integrations/obsidian/package.json` 目前**没有 `test` 脚本**，而 `integrations/test-all.mjs` 对这种情况是"报告『有代码没测试』而不是跳过"。本次顺手补上这个既有缺口。

夹具 `test/fixtures/vault/`：frontmatter + wikilink + callout + dataview 代码块 + 隐藏 `.raw/` + 一个孤儿页 + 一条死链。

断言即 §4 的不变量：

1. `set` 之后 frontmatter 与其余所有块**逐字节不变**
2. Obsidian 语法原样写入、未被转义
3. `set` 打在 frontmatter 块上**会毁页**——以 negative test 把这个行为钉住（skill 禁止它，测试证明为什么）
4. graph 认出夹具里的孤儿和死链，且 `dead` 带块地址
5. 代码块里的 `[[x]]` 不计入链接

跨平台：路径分隔符、CRLF、`.md` 大小写——夹具与断言都要在 Windows 与 Linux 上成立。

## 9. 阶段与验收

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| P0 | `find` 目录遍历按后缀识别 | 新用例过 + `node test/all.mjs` 全绿 + `coverage:check` 过 + CHANGELOG 记行为变更 |
| P1 | `SKILL.md` + `invariants.md` + 读写路径 | 不变量 1/2/3 的回归测试过；`integrations/obsidian` 有 `test` 脚本且 `test-all.mjs` 不再报"有代码没测试" |
| P2 | `vault-graph.mjs` | 不变量 4/5 的回归测试过 |
| P3 | 历史（默认关） | 适配层写明"claude-obsidian 下别开"；`.gemlhistory` 的处置（gitignore / Obsidian excluded files）留给用户 |

分支：本设计是大改动，按仓约定开新特性分支；实现已 rebase 到 `origin/main` @ `91c8411` 并并入 `main`。

## 10. 待办 / 待讨论

本次**不做**，逐条有归属：

| # | 事项 | 处置 |
|---|---|---|
| 1 | skill 命名 `geml-vault` 是否合适（"vault" 是 Obsidian 词汇，而核心层号称通用） | 已定：沿用 `geml-vault`，它落在 `integrations/obsidian/` 下，词汇一致 |
| 2 | 把 `vault-graph` 提升为 `geml vault graph\|lint` + `geml-vault/v1` profile | P2 跑顺、有真实用例后再议（§1.4） |
| 3 | `find` 只支持字面子串，不支持正则 | 记录为已知限制；是否值得加，等使用反馈 |
| 4 | `find --head` 每块只回一条命中行 | 同上 |
| 5 | `set --body` 吃掉块尾 `---` 分隔线、吃掉标题后空行 | 本次不修，记入 `invariants.md`；是否算 bug 待定 |
| 6 | **frontmatter 在 md 模式下是 anon prose 块，无法安全编辑** | 这是 GEML 面对 Obsidian 的真实缺口。要修得给 md 模式一个 frontmatter 块类型（能表达 YAML 列表）。本次只用禁忌绕开，不修 |
| 6b | **`[[Note#Heading]]` 写不进去**：GEML 的跨文档引用语法与 Obsidian 的锚点 wikilink 同形，写入时被解析并校验，找不到名为 `Note` 的文档（只有 `Note.md`）→ 拒绝。`[[Note.md#Heading]]` 可以，Obsidian 也认。实施中发现，已钉进测试与 invariants | 与第 6 条同类：GEML 与 Obsidian 在同一串字符上语义冲突。真修需要 md 模式下把 `[[…]]` 整体当文本、不认作 GEML 引用——那会动到核心解析，本次不做 |
| 6d | **`set --body` 打在散文块上静默追加而非替换**（旧内容一字不删，退出码 0）。上游 `91c8411` 修好了不带 `--body` 的那一半，`--body` 这一半仍在。本次用 skill 规则 + 测试钉住，未修 parser | 候选的后续 parser 修复：散文块上出现 `--body` 时应报错而非写入。改的是 `verbs.ts`，和 `91c8411` 同一处 |
| 6c | 重复标题致全文件不可写，错误信息指的是碰撞处而非你的编辑，读起来像"你弄坏了没碰过的东西" | 信息措辞可改善（CLI 已有"预先存在的错误不是你造成的"这一说法，但这条路径没走它）。本次只记录 |
| 7 | 全 `.geml` vault 路线 | 明确不做，改造清单见 §1.4 |
| 8 | claudian 侧的集成 | 无事可做——它不对笔记格式做假设，本设计与它正交 |
