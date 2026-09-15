# GEML 远端 MCP server（Cloudflare Worker，TS 版）— 设计文档

日期：2026-09-14 · 状态：**设计已评审通过；§3 模块切分、§5 双纪元协议层、Worker（`integrations/geml-mcp-worker/`）、CI job、版本字段与 registry 占位均已在工作区实现，待 review 提交；README / PUBLISHING / CHANGELOG 三处文案为草稿，待批准落地** · 基线：`main` @ `0555070` · 实施计划：`docs/design/plans/2026-09-14-geml-mcp-worker.md`
前置阅读：`2026-07-24-geml-block-mutation-cli-design.md`（写守卫「先验后写」的由来）、`geml-parser/src/mcp.ts` 文件头（stdio server 的十一条工具与 root 禁闭）。

---

## 0. 一句话

把参考实现里的 9 个文档动词抽成宿主无关的纯函数，让 CLI、stdio MCP、Cloudflare Worker 三个宿主共用一份代码；Worker 以无状态、免鉴权的 Streamable HTTP 对外提供同一套工具，文档随请求以文本传入，写动词返回改后的整篇文本。

这是「Rust 第二实现 + Cloudflare MCP」评估里拆出来的第一条线：Cloudflare 不等 Rust。将来 Rust 内核成熟，换到同一个 JS 壳后面，外部接口不变。

## 1. 出发点

### 1.1 动词住在 CLI 里，所以 MCP 起子进程

今天 `list / find / get / set / add / delete / rename` 的全部逻辑都在 `cli.ts`（3,008 行，36 处直接读写文件、27 处碰 `process`）。库 `geml.ts` 只导出 `parse / serialize / mdToGeml / gemlToMd / renderHtml` 等，没有这些动词。`mcp.ts` 因此对每次工具调用 `spawnSync` 起一个 CLI 子进程，再用 `parseRefusal` 从 stderr 里捞 `--json` 拒绝帧。

Worker 里没有子进程、没有文件系统。要让 Worker 有这些动词，只有三条路：把 `cli.ts` 原样打包再垫内存文件系统（脆，每次 CLI 改动都可能打断）、在 Worker 里重写一份（会漂，技能文本三处拷贝漂过一次的教训就在眼前）、或者把动词抽成库。选第三条。

### 1.2 无状态是刻意的

远端 server 看不到用户磁盘。三种「文档在哪」的答案里，R2 / KV 多租户和 GitHub 直连都是带鉴权、配额、防滥用的托管产品；无状态传文本零存储、零鉴权，正好对上 Cloudflare 现在推荐的 `createMcpHandler` 式无状态路径，也是最新 MCP 规范（2026-07-28）在基础协议里点名的方向：「Stateless, self-contained requests」。

无状态版的价值边界要说清楚：它是 hosted 校验器、按块读写的演示、registry 上的远端入口，**不是**「按块编辑用户本地 Markdown」这条 wedge 的替代。要撑住 wedge，得做有状态版；本设计只保证到那一步时动词不用再抽一次。

## 2. 目标与边界

**做**：

- Worker 暴露 9 个工具：读 `geml_list / geml_find / geml_get / geml_check / geml_to`，写 `geml_set / geml_add / geml_delete / geml_rename`。
- 写守卫语义与 stdio 版逐字相同：文档原有的 error 不阻塞，新增的 error 拒绝，`delete` 造成的悬空引用只算警告。
- 免鉴权，无会话，每个请求自足。
- CLI 行为逐字节不变；stdio MCP 对外导出名与工具 schema 不变，但改为进程内执行。

**不做**：

- `geml_history / geml_revert`（需要 `.gemlhistory` 侧车，即需要存储）。
- 四个 `geml_codemap_*` 图工具（需要图目录）。
- `geml_get` 的 `view` 穿透读取（需要读到 embed 指向的另一篇文档）。
- 兄弟文档包 `documents:{路径:文本}`。跨文档引用在无状态下不可解析，`check` 照 `geml check -` 今天的行为报 `unresolvable-document` error，工具描述写明，不降级。
- 任何鉴权、限流、计费。Cloudflare 自身的请求配额与 CPU 上限是唯一的闸。

## 3. 模块切分

```
geml-parser/src/
  verbs.ts        新：9 个动词的纯函数（文本进、文本出）
  mcp-core.ts     新：工具表 + JSON-RPC 分发 + 写守卫，按 Host 参数化
  mcp.ts          改：stdio 宿主。root 禁闭、realpath、history 快照、readline、codemap 图工具
  cli.ts          改：argv 解析、读写文件、退出码；动词逻辑搬走
integrations/geml-mcp-worker/
  src/worker.js   新：fetch 处理器 = HTTP 壳 + 内存宿主
  src/node-stub.js 转发到 geml-parser/codemap/browser-stub.mjs（与 viewer 同一招）
  test/*.test.mjs
  wrangler.jsonc  package.json  README.md  SECURITY.md
```

### 3.1 `verbs.ts`（已实现，2026-09-14）

每个动词是 `verb(source, file, …, ctx)`：`source` 是文档文本，`file` 是它的名字（进消息、`self`、`.geml`/`.md` 规则），`ctx` 是宿主给的上下文。拒绝不是返回值而是抛 `VerbError`，带 CLI 一直在用的退出码（2 用法、1 文档/操作）和守卫写被拒时的完整诊断表：

```ts
class VerbError extends Error { exit: 1 | 2; diagnostics?: Diagnostic[] }
interface VerbContext {
  docOpts(file: string, root?: string): { resolveDoc; docExists };   // 跨文档解析；无状态宿主恒返 null/false
  note(line: string): void;                                          // CLI 的 stderr 旁白：dropped #x、3 note blocks、new address
  files?: { readConfined(rel, root): string; shownPath(rel, root): string };   // --view 链与 md 导出的受限旁读；无则链被拒
}
type Content = { kind: "raw"; text } | { kind: "file"; spec; read(path): string };   // set/add 的内容通道：stdin 字节，或 --in F[#src]
interface HistoryReader { resolve(sel); firstChanged(current, pick) }             // revert 的侧车，由宿主绑到一个文件

list(source, file, json, ctx) → string            findInSource(source, file, pattern, {sensitive, withLine}) → FindHit[]
get(source, file, sel, {part, json, view, root}, ctx) → { output, from[] }
check(source, file, ctx, root?) → Document         transform(src, file, {inFmt, outFmt, fragment, root}, ctx) → { output, notes, doc? }
replace(source, file, old, new, within, ctx) → { text, summary }
set(source, file, sel, {part, named, content}, ctx) → { text }      add(source, file, {content, append, before, after}, ctx) → { text }
del(source, file, ids, ctx) → { text }             rename(source, file, old, new, {historyTip}, ctx) → { text }
revert(source, file, id, {rev, dryRun, headOnly, …, history, historyError}, ctx) → unchanged | dry-run | write
```

约束：不 `import` `node:fs`、不碰 `process`、不 `exit`、不打印（`dist/verbs.js` 里 `node:` 导入为零）。`find` 只对单篇文档，目录遍历留在宿主。选择符解析、`@hash` 地址、`--head/--intro/--body` 三分、fragment 插入、id 改名与引用重写、守卫拼接 `spliceSpan`，全部随动词搬进来；所有消息文字逐字保留。

**`host-fs.ts`**（新）：磁盘宿主两边共用的部分——`resolverFor / existsFor / docOptsFor`（带 realpath 双闸的跨文档解析）、`readConfined / shownPath`（`--view` 旁读）、`gemlFilesUnder`（目录遍历）、`historyError`。cli.ts 与 mcp.ts 都从这里取，禁闭逻辑只写一份。

### 3.2 `mcp-core.ts` 与 `McpHost`（已实现，2026-09-14）

从 `mcp.ts` 搬出工具表、写管线 `applyWrite`、JSON-RPC 分发，按宿主参数化：

```ts
interface McpHost {
  docArg: "path" | "inline";        // 工具 schema 里文档参数怎么长：file（root 下路径）或 source + name
  docNote: string;                  // 追加到每条工具描述末尾的一句话（磁盘宿主为空；inline 说明无状态与跨文档引用不可解析）
  unchangedHint: string;            // 拒绝时的那句话：磁盘未动 / 未返回文档
  open(args): OpenedDoc;            // { text, file(回显名), label(动词看到的名字), ctx, validate(服务端独立复验用的解析器), root? }
  write(doc, text, summary): { revision?: string; document?: string };   // 磁盘：history 快照 + 落盘；inline：把新全文放进结果
  find(args): FindHit[];            // 磁盘：遍历 root；inline：只搜 source
  checkOpts(doc, root): ParseOptions;
  history?(doc): HistoryAccess;     // 只有磁盘宿主有；决定 geml_history / geml_revert 是否被服务
}
toolsFor(host): Tool[]              // 磁盘 11 条，inline 9 条；顺序、名字、描述、schema 与原 mcp.ts 逐字一致（docArg 差异除外）
createHandler(() => Tool[])         // 原 handleLine 的分发，一字不改
inlineHost(): McpHost               // Worker 将来直接用的宿主；本轮已有 13 条用例（test/mcp-inline.test.mjs）
```

写管线不变，只是「产出」从 `runCli` 换成动词调用（`VerbError` 即原来 stderr 里的 `--json` 拒绝帧），「落盘」换成 `host.write`：产出 → 独立复验 → 与写前比对 → 写。`parseRefusal` 与 stderr 捞帧整段删除。

`handleMessage` 同时承担 §5.1 的纪元判别：legacy 与 modern 两条路径共用同一张工具表与同一个 `tools/call` 执行函数，只在信封（`resultType`、`serverInfo`、`ttlMs`）和方法集（`initialize / ping` 对 `server/discover`）上分叉。

写管线不变，只是把「产出」从 `runCli` 换成 `verbs`，把「落盘」换成 `host.write`：产出 → 独立复验 → 与写前比对 → 写。`parseRefusal` 与 stderr 捞帧整段删除。

### 3.3 `mcp.ts`（stdio 宿主）

保留：`configure / resolveInRoot / parseArgs / MCP_USAGE / loadGraphTools`、realpath 双侧禁闭、`.gemlhistory` 快照、readline 主循环、codemap 图工具。去掉：`spawnSync`、`CLI` 路径常量、`runCli`、`parseRefusal`、`ROOT_VERBS`。现有 `mcp.test.mjs` 从 `dist/mcp.js` 导入的名字一个不少。

## 4. Worker 工具契约

纯 JS ESM，直接 `import` `../../geml-parser/dist/*.js`，与 viewer、logseq 一致，不引 TS 编译步骤。

| 工具 | 参数（`source` 必填，`name` 选填，其余同 stdio 版） | 返回 |
|---|---|---|
| `geml_list` | — | 地址表，与 CLI `list` 同文本 |
| `geml_find` | `pattern`, `case?`, `head?` | 命中表 `#address` 行 |
| `geml_get` | `id`, `part?: whole\|head\|intro\|body` | 块文本；`view` 不提供 |
| `geml_check` | — | `{ diagnostics }` |
| `geml_to` | `to: json\|html\|md\|geml`, `from?` | 转换结果文本 |
| `geml_set` | `id`, `body`, `part?` | `{ ok, document?, diagnostics, hint? }` |
| `geml_add` | `body`, `append?` \| `before?` \| `after?` | 同上 |
| `geml_delete` | `ids: string[]` | 同上，另带被删块清单 |
| `geml_rename` | `from`, `to` | 同上 |

- `name` 缺省视为 `document.geml`；以 `.md` 结尾则按 Markdown 读，与 CLI 按扩展名推断一致。
- 写成功时 `document` 是新全文；`document` 与 `source` 相同则 `ok: true` 且 hint 为「No change」。被拒时无 `document`，hint 明说没有任何东西被改动、调用方手里的文本即现状。
- 每个工具描述末尾加一句：本 server 无状态，看不到其它文档，`[[other.geml#id]]` 一类跨文档引用会报 `unresolvable-document`。

## 5. 协议层：双纪元

MCP 规范在 2026-07-28 版做了断代式修改（SEP-2575 / SEP-2567）：删掉 `initialize` 握手与 `Mcp-Session-Id` 会话，每个请求在 `params._meta` 里自带 `io.modelcontextprotocol/protocolVersion` 与 `clientCapabilities`；服务端必须实现 `server/discover`；所有结果带 `resultType: "complete"`；HTTP 上强制 `MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name` 三个镜像头并校验与请求体一致；`GET` 流、`ping`、SSE 续传全部移除。规范自己把两个时代命名为 **modern**（2026-07-28 起）与 **legacy**（2025-11-25 及更早），并允许一个服务端同时服务两者（dual-era）。

2026-09 这个时点，两种客户端都在。所以 `mcp-core.ts` 做**双纪元**，逐条消息判别，与传输无关；Worker 与 stdio 因此一起获得 modern 支持。

### 5.1 纪元判别与两套版本表

```ts
const LEGACY_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];  // 2025-11-25 对纯工具服务端无破坏性变更，已核对其 changelog
const MODERN_VERSIONS = ["2026-07-28"];
```

- 消息的 `params._meta["io.modelcontextprotocol/protocolVersion"]` 存在 → **modern**；否则（含 `initialize`）→ **legacy**。
- **legacy** 路径即今天 `handleLine` 的行为：`initialize` 回显客户端要的版本，不在表内则回表内最新项；`ping`、`notifications/initialized`、`tools/list`、`tools/call` 照旧；结果形状不变，现有测试零改动。
- **modern** 路径：
  - `_meta` 缺 `protocolVersion` 或 `clientCapabilities` → `-32602`；版本不在 `MODERN_VERSIONS` → `-32022 UnsupportedProtocolVersion`，`data.supported / requested` 按规范填。
  - 方法：`server/discover`（返回 `supportedVersions = MODERN_VERSIONS`、`capabilities: { tools: {} }`、`instructions` 一句、`ttlMs`、`cacheScope: "public"`）、`tools/list`（加 `ttlMs`、`cacheScope`，顺序固定）、`tools/call`（同一张工具表）。其它方法 `-32601`。
  - 每个结果带 `resultType: "complete"` 与 `_meta["io.modelcontextprotocol/serverInfo"]`。未知工具是协议错误 `-32602`，工具执行失败是 `isError: true` 的结果，与今天一致。
- stdio 宿主不需要额外代码：modern 客户端按规范先发 `server/discover` 探测，legacy 客户端照旧 `initialize`；`notifications/cancelled` 已在处理。

### 5.2 HTTP 壳

约 150 行，零依赖，只用 Web 标准 API（`Request / Response / URL / TextEncoder`）。

| 请求 | 处理 |
|---|---|
| `POST /mcp`，JSON-RPC 请求（两个纪元） | `handleMessage` → `200`，`Content-Type: application/json` |
| `POST /mcp`，通知 | `202`，空体 |
| `POST /mcp`，JSON 数组 | `400`，`-32600`（2025-06-18 起无批量） |
| `POST /mcp`，非法 JSON | `400`，无 id 的 `-32700` |
| `POST /mcp`，modern 且镜像头缺失或与体不符 | `400`，`-32020 HeaderMismatch` |
| `POST /mcp`，modern 且版本不支持 | `400`，`-32022` |
| `POST /mcp`，modern 且方法未知 | `404`，`-32601` |
| `GET /mcp`、`DELETE /mcp` | `405`（无 SSE 流，无会话终止） |
| `OPTIONS /mcp` | 按 Origin 白名单回 CORS 头 |
| `GET /` | 一行文本：server 名、版本、README 链接 |
| 其它 | `404` |

- **头校验只对 modern 请求**：`MCP-Protocol-Version` 必须等于 `_meta` 里的版本；`Mcp-Method` 必须等于 `method`；`tools/call` 的 `Mcp-Name` 必须等于 `params.name`，值若是 `=?base64?…?=` 哨兵格式先解码再比。本服务端不声明任何 `x-mcp-header`，陌生的 `Mcp-Param-*` 头忽略。
- **legacy 请求**：`MCP-Protocol-Version` 头缺失按规范当作 `2025-03-26`；在 `LEGACY_VERSIONS` 内放行；否则 `400`。`Mcp-Session-Id`、`Last-Event-ID` 一律忽略，不铸造、不回显。
- **无会话、无状态**：两个纪元都不发会话头；`initialize` 不是任何请求的前置条件。
- **Origin**：头存在且不在白名单 → `403`。白名单来自环境变量 `ALLOWED_ORIGINS`（逗号分隔），缺省只放 `http://localhost:*` 与 `http://127.0.0.1:*`，够 MCP Inspector 本地用。非浏览器客户端不带 Origin，直接放行。两个纪元的规范都把这条写成 MUST。
- **体积**：请求体上限 `MAX_BODY_BYTES`，缺省 2 MiB，超出 `413`。先看 `Content-Length`，缺失则读完再量。

## 6. 错误处理与安全

- JSON-RPC 层：方法不存在 → `-32601`；参数错 → `-32602`；工具内部异常 → `isError: true` 的 tool result，不是 HTTP 500。与 stdio 版一致。
- 解析器 §9.2 的三种递归上限照常生效；文档是不可信输入，Worker 不会给它任何额外能力。
- Worker 内无文件系统：`node:fs / path / crypto / child_process / readline / url / os` 在 `wrangler.jsonc` 的 `alias` 里指到 `codemap/browser-stub.mjs`。`PARSER_VERSION` 读不到 `package.json` 时已回退 `0.0.0`；`isCliInvocation` 在无 argv 时已返回 false。Worker 不 import `cli.ts` 与 `mcp.ts`，只 import `mcp-core.ts` 与 `verbs.ts`。
- CPU：免费档 10 ms 固定。参考实现解析 106 KB 的 dogfood 规范约 12 ms（Node 热态）。README 写明：大文档需要付费档（默认 30 s）。
- 日志：不记录文档内容。`console.log` 只留请求方法与耗时。

## 7. 测试与 CI

- **`verbs.ts`**：现有 59 个测试文件是回归网，CLI 行为逐字节不变即通过。另加一组直接调用纯函数的用例，覆盖每个动词的成功与拒绝路径。
- **`mcp-core.ts`**：现有 `mcp.test.mjs` 不改；新增 inline 宿主的用例：工具表在两种 `docArg` 下的 schema 差异、写返回 `document`、拒绝时无 `document`。新增 modern 纪元用例：`server/discover` 的形状、`tools/list` 带 `ttlMs / cacheScope / resultType`、`_meta` 缺字段 → `-32602`、版本不支持 → `-32022` 且 `data.supported` 正确、未知方法 → `-32601`；同一进程里 legacy `initialize` 与 modern `server/discover` 交错发送都正确。
- **Worker**：`test/worker.test.mjs` 在 Node 里直接调导出的 `fetch(new Request(...))`，不需要 wrangler。用例：legacy `initialize`、modern `server/discover`、`tools/list` 数到 9、每个工具各一条成功、一条写被拒且 hint 正确、`GET/DELETE → 405`、数组 → `400`、legacy 坏版本头 → `400`、modern 缺 `Mcp-Method` 或 `Mcp-Name` 不符 → `400 -32020`、`Mcp-Name` base64 哨兵解码后匹配 → `200`、modern 未知方法 → `404`、陌生 Origin → `403`、超体积 → `413`、通知 → `202`。无文件系统假设，三平台矩阵都能跑。
- **冒烟**：本地 `wrangler dev`，用 `curl` 打一次 `initialize` 与一次 `geml_set`，输出留档；MCP Inspector 连一次。
- **覆盖率**：parser 的 95% 闸门照跑；重构后 `cli.ts` 变薄、`verbs.ts` 变厚，总量不变。
- **CI**：`ci.yml` 照 viewer 的样子加一个 job：先在 `geml-parser` `npm ci && npm run build`，再在 `integrations/geml-mcp-worker` `npm ci && npm test`。`integrations/test-all.mjs` 自动发现有 `test` 脚本的目录，无需登记。

## 8. 发布物与文档

- **parser** bump patch 到 **1.10.4**：八文件仪式（`package.json`、`server.json` ×2、`package-lock.json` ×2、四个 vendor 清单），`CHANGELOG.md` 记「MCP server 进程内执行，不再为每次工具调用起子进程；新增 `verbs` 与 `mcp-core` 模块」。CLI 无行为变化。
- **Worker** 自带 `package.json`，版本 **1.0.0**；`wrangler.jsonc` 里 `name: geml-mcp`，`compatibility_date` 取实施日；README 写用法、两个纪元的接法（legacy 客户端直连 URL；modern 客户端亦直连，`server/discover` 可用）、`ALLOWED_ORIGINS / MAX_BODY_BYTES`、免费档 CPU 提示、`wrangler deploy` 步骤；`SECURITY.md` 照其它集成的样子。
- **CHANGELOG** 1.10.4 条目同时记「stdio MCP server 支持 MCP 2026-07-28 的 `server/discover` 与按请求 `_meta`，旧客户端不受影响」。
- **registry**：`geml-parser/server.json` 加 `remotes: [{ type: "streamable-http", url: "https://geml-mcp.<subdomain>.workers.dev/mcp" }]`，`<subdomain>` 是占位。`publish-mcp.yml` 只能 `workflow_dispatch` 手动触发，占位不会被自动发出去；**部署拿到真实子域并替换后才可发布**。
- **PUBLISHING.geml** 加一节 `#a-worker`：版本文件、落地位置、`wrangler deploy` 与前置条件（Cloudflare 账号、`wrangler login`）、发布后检查（`curl` initialize、registry 条目可连）。`PUBLISHING.md` 由 `--to md` 再生，`PUBLISHING_CN` 手改。
- **README** 提一句远端用法。所有人读的文案改动先给 diff 再落。

## 9. 裁定记录

| 问题 | 裁定 | 理由 |
|---|---|---|
| 工具面 | 读 5 + 写 4，写返回新全文 | 按块编辑的完整闭环；不含 history / revert / codemap |
| 兄弟文档包 | 不做 | 多一层输入体积与 schema；跨文档引用照 `check -` 报错 |
| 动词怎么进 Worker | 抽 `verbs.ts`，三宿主共用 | 不漂；stdio 顺带去掉子进程；为 URL 宿主、有状态版、Rust 内核预留同一接口 |
| 传输层 | 手写无状态 Streamable HTTP，零依赖 | `handleLine` 本就与传输无关；官方 SDK 会带进 zod 与第二套工具定义 |
| 协议纪元 | 双纪元：legacy 到 2025-11-25，modern 2026-07-28 | 两种客户端并存；判别放在共享的 mcp-core，stdio 顺带获得 `server/discover` |
| stdio 是否也做 modern | 做，零额外代码 | 纪元判别在 mcp-core，不做反而要在 stdio 壳里挡掉 |
| 部署地址 | workers.dev 子域，先占位 | 用户部署后补真实子域 |
| 版本 | parser 1.10.4，Worker 1.0.0 | 用户裁定 |
| 谁部署 | 用户 | 需要 Cloudflare 账号；我只做本地 `wrangler dev` 验证 |

## 10. 不在本设计内、但已为之留口

- **`geml get/set <url>`**：读那半是 `file` 参数为 URL 时 fetch 后走同一套动词；写那半需要一个拥有存储的服务端收新全文。`verbs.ts` 与 `Host` 接口就是为此准备的，届时只加一个 URL 宿主。
- **有状态版**（R2 / KV / GitHub 直连）：`Host.read / write` 换实现，`history` 快照钩子已在接口里。
- **Rust 内核**：`verbs.ts` 的函数签名就是 wasm 导出面；JS 壳不变。

## 11. 验收

1. `geml-parser`：`npm test` 三平台绿，`coverage:check` 过 95% 闸门，CLI 测试零改动。
2. `mcp.test.mjs` 零改动通过；`dist/mcp.js` 不再出现 `spawnSync`；stdio 下 `server/discover` 返回 `DiscoverResult`。
3. Worker：`npm test` 绿；`wrangler dev` 下 `curl` 完成 legacy `initialize`、modern `server/discover`，以及一次 `geml_set` 往返并返回 `document`。
4. `server.json` 含占位 `remotes`；`CHANGELOG` 有 1.10.4 条目；PUBLISHING 有 `#a-worker` 节。
