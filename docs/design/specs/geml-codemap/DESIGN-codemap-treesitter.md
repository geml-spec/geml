# codemap tree-sitter 兜底适配器设计（Zig 首发）

> 状态：**已实现**（2026-09-14，`geml-parser/codemap/treesitter-export.mjs`、
> `codemap/adapters/treesitter.mjs`、`codemap/treesitter/zig.mjs`）。本文是
> [`DESIGN-geml-code-graph.md`](DESIGN-geml-code-graph.md) D4 决策（「Joern /
> tree-sitter / code-review-graph 各写一个 adapter 即可互换」）的 tree-sitter 一侧
> 落地记录：它是精度梯子的**地板**——SCIP 索引器 > Joern 一梯队 frontend >
> tree-sitter 启发式；一门语言只有前两者都不覆盖时才走这里。

## 0. 决策看板

| # | 问题 | 决定 | 备选与理由 |
|---|---|---|---|
| D1 | 解析野心 | **三层名字解析**（§3）：同文件直呼 → 顺 `@import`/别名/容器/`self` 走结构 → 兜底全仓同名匹配。全部 `resolution: heuristic`，永不出 `high` | B「只做定义+同文件」零误导但图基本空；C「再加 test 块」留待下轮 |
| D2 | 运行时来源 | **npx 现拉一包全语法**：`npx -y -p web-tree-sitter@0.25.10 -p tree-sitter-wasms@0.1.13 node treesitter-export.mjs`，@geml/geml 依赖不变（同 SFC 虚拟化 / scip-typescript 的路子） | 按语言单包（11 MB/语言，且不是每个语法都往 npm 发 wasm）；打进 @geml/geml（+5 MB 起，破零依赖） |
| D3 | 架构 | **导出脚本 + 纯 Node 适配器，语言用 profile 插拔**（§1）：语法层与解析层分开，解析可用手写 JSONL 单测，加语言 = 加一个 profile 文件 | 进程内单文件适配器要整个 `build` 跑在 npx 环境里；借 code-review-graph 无 Zig 保证且 valkey 上跨文件只解 12 条 |
| D4 | web-tree-sitter 版本 | **钉 0.25.x**（`TREESITTER_NPX_PKGS`，detect.mjs） | 0.27 只认 `dylink.0` 段，`tree-sitter-wasms` 由 tree-sitter-cli 0.20 构建、只有旧式 `dylink` 段，加载即抛；0.20/0.24/0.25 两种都收（实测）。官方 release 的 wasm 两段都带，两边都能加载 |
| D5 | 候选上限 | 层③同名候选 **最多 8 个**，超过改 `to_text` + 注记「N same-named — not listed」 | std 里 `deinit` 有 133 个定义，列出来每条调用给 133 个方法各刷一条 backlink |
| D6 | test 块 | `test "…" {}` 里的调用**不产边**（导出即丢） | kind=Test 节点 + `tested-by` 边是自然扩展（D1 的 C），未做 |
| D7 | 自动检测 | `build.zig` / `build.zig.zon` 清单或 `.zig` 占比 ≥5% → treesitter 任务；**Gradle/Maven 的 Java 项目不受影响**（`build.gradle` 仍判 Java→Joern，测试钉死） | — |
| D8 | fixture 里不放 `build.zig` | 仓库自身 codemap 用自动检测；一个清单文件会把整个 geml 仓库判成 Zig 项目、每次自建图都拉 npx | pom.xml 在 Scala fixture 上同样的教训 |

## 1. 架构与组件

```
build.mjs (auto)                    npx 子进程                                  进程内
─────────────────  spawn ────────▶  treesitter-export.mjs  ── JSONL ──▶  adapters/treesitter.mjs ──▶ 交换格式 ──▶ 现有 merge/emit
detect.mjs: Zig 任务                web-tree-sitter + tree-sitter-wasms            三层名字解析（纯 Node，不碰 wasm）
                                    treesitter/zig.mjs (profile)
```

| 文件 | 职责 | 依赖 |
|---|---|---|
| `codemap/treesitter-export.mjs` | **语法层**。读 `GEML_SRC`/`GEML_OUT`/`GEML_LANG`（+`GEML_EXCLUDE` 换行分隔的 glob、`GEML_NO_GITIGNORE`），用 `collectSourceFiles` + `makeExcluder` 枚举该语言源文件（和 detect/build 同一套规则），加载 profile 声明的 wasm，逐文件跑 profile 的三个生成器，写 `defs.jsonl` / `bindings.jsonl` / `calls.jsonl` / `meta.json`。**不解析名字、不判 confidence。** 同时导出 `runExport()` 供测试进程内调用 | web-tree-sitter、tree-sitter-wasms（经 `npx-require.mjs` 从 npx 的 `_npx/.bin` PATH 项反推 node_modules，其次项目自己的 node_modules——测试靠 devDependencies 走这条） |
| `codemap/treesitter/zig.mjs` | **Zig profile**：`lang`、`exts`、`wasm` 候选路径、`importTarget(spec, fromFile)`，以及三个基于语法树的生成器 `definitions` / `bindings` / `calls`。语言相关的东西全在这里 | 无 |
| `codemap/adapters/treesitter.mjs` | **解析层**。`extract({raw})` 读四份文件，建符号表，做 §3 的三层解析，出 `{symbols, edges}`。语言无关：profile 决定什么算定义/绑定/调用，这里只做连接 | 无（与 joern.mjs 同级） |
| `codemap/npx-require.mjs` | 从 `sfc-virtualize.mjs` 抽出的库解析器 `makeNpxResolver(startDir, importMetaUrl)`，两处共用 | 无 |
| `detect.mjs` / `build.mjs` | `Zig → { indexer: "treesitter", tsLang: "zig" }`；`indexerCommand` 出 npx 步骤（env 只在设了时才带键，指纹稳定）；任务排序 scip → joern → treesitter；adapter 白名单加 `treesitter`；recipe 记录 `{ env:{GEML_SRC:".", GEML_OUT, GEML_LANG, GEML_EXCLUDE?, GEML_NO_GITIGNORE?}, argv:[npx …] }`，`refresh` 原样重放 | — |

### 1.1 原始 JSONL 契约（export 写、adapter 读；路径仓库相对、`/` 分隔）

```jsonc
// defs.jsonl —— 一个 fn 一条；container 是外层容器/外层 fn 的名字链，最外层在前
{"file":"src/net.zig","name":"connect","container":["Client"],"pub":true,"lineStart":12,"lineEnd":16}
// bindings.jsonl —— 调用路径能穿过的 const 绑定；scope 是声明所在的容器链
{"file":"src/main.zig","name":"net","kind":"import","target":"src/net.zig","scope":[],"line":2}      // @import("net.zig") 落到文件
{"file":"src/main.zig","name":"std","kind":"import","target":null,"scope":[],"line":1}               // 外部包
{"file":"src/main.zig","name":"Conn","kind":"alias","target":"src/net.zig","path":["Client"],"scope":[],"line":3} // @import(...).Client
{"file":"src/net.zig","name":"Client","kind":"struct","scope":[],"line":4}                           // const Client = struct {…}
{"file":"src/net.zig","name":"Self","kind":"self","scope":["Client"],"line":5}                       // const Self = @This()
{"file":"src/a.zig","name":"p","kind":"alias","path":["std","debug","print"],"scope":["Custom","dump"],"line":11} // fn 体内局部别名
// calls.jsonl —— 一个调用点一条；callee 是按 `.` 切开的路径；caller 指向 defs 里的一条
{"file":"src/main.zig","line":7,"caller":{"name":"main","container":[]},"callee":["net","Client","connect"]}
{"file":"src/main.zig","line":8,"caller":{"name":"main","container":[]},"callee":["c","send"]}
// meta.json
{"lang":"zig","files":3,"parseErrors":0,"defs":10,"bindings":7,"calls":12}
```

约定：值绑定（`const c = foo();`）不是命名空间，不进 bindings；builtin（`@import`、`@memcpy`…）不是 `call_expression`，不进 calls；callee 头如果是 `@import("x.zig")` 表达式，export 用 profile 的 `importTarget` 改写成 `@file:<target>` / `@pkg:<spec>`，adapter 因此不需要 profile；头不是名字（调用结果、下标、解引用、`try`）记为 `"<expr>"`。

## 2. Zig profile 读语法树的规则

（节点形状对 tree-sitter-grammars/tree-sitter-zig v1.1.2 实测。）

- **定义**：每个 `function_declaration`（含 `extern` 原型，它们是叶子）。`name` 字段取名；`pub` 是子 token。容器链 `containerPath`：向上走，遇 `function_declaration` 推其名，遇 `struct/enum/union/opaque_declaration` 且父节点是 `variable_declaration` 推该变量名——所以 `const Client = struct { pub fn init() }` 得 `["Client"]`，泛型构造器 `fn List(comptime T: type) type { return struct { pub fn init() } }` 里的方法得 `["List"]`（匿名 struct 不贡献名字，命名它的是外层 fn），fn 体内 `const Inner = struct { fn go() }` 得 `["outer","Inner"]`。
- **绑定**：每个带初值的 `variable_declaration`：初值是容器声明 → `struct`；`@This()` → `self`；`@import("x")` → `import`（`.zig` 结尾按声明文件所在目录解析为仓库相对路径，否则 `target: null` 视为外部包）；`@import("x").A.B` → `alias{target, path}`；`a.b.C` 或 `f` → `alias{path}`；其它（调用结果、字面量、运算）跳过。
- **调用**：每个 `call_expression` 的 `function` 字段展平为路径；`.foo`（enum 字面量）、纯 `<expr>` 不产行。caller = 最近的外层 `function_declaration`（名 + 其容器链）；先碰到 `test_declaration` 或到文件顶层则无 caller，export 丢弃。

## 3. 三层名字解析（adapter）

查找起点是 caller **自己的作用域** `[...container, callerName]`，向外到容器、再到文件顶层（所以 fn 体内的局部别名、嵌套 fn 都可见）。

| 层 | 形态 | 规则 | confidence |
|---|---|---|---|
| ① | 直呼 `foo()` | 同文件，作用域由内向外找 `…foo`；找不到但有同名 `alias` 绑定则代入 | `medium` |
| ② | 路径 `a.b.c()` | 头 `a` 在可见作用域找绑定：`import` → 到目标文件顶层找 `b.c`（找不到但目标文件顶层有绑定 `b` → 递归，re-export 多跳，上限 8 跳防环）；`alias` → 代入 `path` 后继续；`struct` → 在同文件容器 `a` 下找；`self` 绑定或裸 `self`/`Self` → 在当前容器找；`@file:` 头直接进文件；`@pkg:` 头 → 外部 | 结构落到定义 → `medium`；**结构已知但成员缺失**（`Client.missing`、`std.debug.print`）→ `to_text`（真实空洞，不猜） |
| ③ | 头无绑定（参数、局部值、调用结果） | 只能拿**最后一段**去全仓同名匹配：唯一 → `to` + 注记 `name match only`；2–8 个 → 无 `to`、`candidates`；>8 或 0 → `to_text`（注记带同名数） | 唯一 `low`；候选 `low` |

递归调用（`from === to`）不产边，与 SCIP 适配器一致。`.leaf` 判定沿用 emit 的口径：出度含未解析边（GEP-0002 教训）。

## 4. 检测、命令、recipe

- `detect.mjs`：`MANIFEST_LANG` 加 `build.zig` / `build.zig.zon`；`EXT_LANG` 加 `zig`（`isSourcePath` 因此认 `.zig`，`refresh` 会为 Zig 变更重建）；`LANG_JOB.Zig = { indexer: "treesitter", tsLang: "zig" }`；`indexerCommand` 出 `{ adapter:"treesitter", raw:<build>/treesitter-zig, argv:["npx","-y","-p",…TREESITTER_NPX_PKGS,"node",<treesitter-export.mjs>], env:{GEML_SRC, GEML_OUT, GEML_LANG[, GEML_EXCLUDE][, GEML_NO_GITIGNORE]}, cwd: root }`。
- `build.mjs`：把 `--exclude` glob 与 `--no-gitignore` 传给 `indexerCommand`；recipe 步骤 `env.GEML_SRC="."`（步骤在 root 重放）、脚本路径记正斜杠形式；一门语言的索引器失败照旧不拖垮其它语言。
- 显式路径：`geml codemap build --adapter treesitter --raw <dir> --root <repo>`，`<dir>` 是 export 的输出目录。

## 5. 错误处理

- `GEML_LANG` 先过 `^[a-z][a-z0-9_-]*$` 再拼 import 路径（env 可控，防目录穿越）；无 profile → 退出 1，报有哪些。
- 找不到 web-tree-sitter / wasm → 退出 1，错误里带完整 npx 配方。
- 语法错误（grammar 比代码旧）：按文件计数进 `meta.parseErrors`，export 与 adapter 各在 stderr 报一行；**该文件的行是部分的，但不丢**。
- 别名环 / re-export 链：8 跳上限。

## 6. 测试（`geml-parser/test/treesitter.test.mjs`，13 项）

- 适配器 7 项：手写 JSONL，覆盖 anchor/`~n`/File 节点、层①（含遮蔽与递归跳过）、层②（import、alias、struct、self、re-export 多跳、成员缺失→to_text）、层③（唯一/候选/无/`<expr>` 头）、无 caller 与未知 caller 丢弃、parse-error 注记、**caller 自身作用域**（fn 体内别名 → 外部目标名、嵌套 fn）、**候选上限**。
- 检测 3 项：`build.zig`、`.zig` 占比、混合 tsconfig+build.zig 的顺序、**Gradle Java 仓库 + 1 个 .zig 仍只有一个 Joern 任务**、`indexerCommand` 形态与 pin。
- 真 grammar 2 项：`runExport` 进程内跑 `test/fixtures/zig-app/`（web-tree-sitter + tree-sitter-wasms 是 devDependencies）核对三张表，再过 adapter 钉 11 条边 + `c.send()` 二义；CLI 入口（env 驱动，坏 `GEML_LANG` 拒绝且不落盘）。
- e2e 1 项（`GEML_TS_E2E=1` 才跑，首次需联网拉 npx 包）：`geml codemap build --root <zig 项目>` 自动检测 → recipe 记 npx 步骤 → `verify` 全绿。

## 7. 冒烟（Zig std lib，zig 0.17.0-dev，553 文件）

| 指标 | 值 |
|---|---|
| fn / 调用点 | 12,601 / 50,132 |
| 导出（解析）/ 适配 | 13.7 s / 0.4 s |
| 边 | 49,889：medium 20,147（40%）、名字唯一 7,875（16%）、候选 10,506（21%，每条 ≤8）、to_text 11,361（23%） |
| 语法报错文件 | 69（12%）——grammar v1.1.2（2024-12）比 0.17-dev 语法旧；稳定版 Zig 项目应明显更低 |

抽查：`StringContext.hash → hashString`、`hashString → Wyhash.hash`（跨文件 import）、`Auto → Custom`（泛型构造器调用）正确；`self.entries.deinit` 这类值上的方法调用是 to_text + 「133 same-named」注记，诚实无害。

## 8. 已知边界

- 无类型信息：值上的方法调用（层③）只能按名字猜，`anytype`/泛型实例、函数指针、`comptime` 生成的调用不可见或只到 to_text。
- `usingnamespace`、`@field(x, "f")()`、`@import("x").f()` 之外的 builtin 间接调用不解析。
- 没有 Test 节点、没有 `tested-by` 边（D6）。
- 每个 profile 的 wasm 版本随 `tree-sitter-wasms` 走，语言新语法可能落后（§7 的 12%）。
- `.leaf`、`.entry`（文件级 `main`）与其它适配器同口径；`visibility` 未进交换格式（emit 不消费）。

## 9. 加一门语言

写 `codemap/treesitter/<lang>.mjs`（`lang`、`exts`、`wasm` 候选、`importTarget`、三个生成器），`detect.mjs` 的 `LANG_JOB` 加一行 `{ indexer:"treesitter", tsLang:"<lang>" }`（清单与扩展名各加一行），`treesitter-export.mjs` 的 `PROFILES` 加名字，再补一个 fixture 与 pin 测试。导出、适配器、build/refresh 不动。`tree-sitter-wasms` 0.1.13 已含 44 个语法（Scala 在内）。
