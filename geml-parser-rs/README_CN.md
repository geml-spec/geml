# geml-parser-rs

GEML 1.0 的第二个独立实现，用 Rust 编写，编译为 WebAssembly。它只依据
[规范](../spec/GEML-spec.md)和[一致性测试集](../geml-parser/test/conformance/)写成，
没有读过参考解析器的任何代码。它的用途就是 §8.4 赋予第二实现的那个：证明决定文档含义的是规范，而不是某一个程序。

**状态：符合规范。** 315 个一致性用例全部通过。测试集 manifest 列出的能力全部声明了，
包括 `tables`、`views`、`ids`、`addresses`、`blocks`、`diagnostics`、`bytes` 和 `yaml`，
所以没有跳过任何用例。测试集跑两遍：

- 原生方式，用本 crate 自己的测试框架（`tests/conformance.rs`）；
- WebAssembly 方式，用测试集自带的 `_runner.mjs` 和 `_project.mjs`。这样读取 wasm
  模块输出的是测试集自己的投影，而不是本 crate 的代码（`wasm/conformance.mjs`）。

[`spec/profiles/`](../spec/profiles/) 下的六个词汇表全部认识，各自的检查也都实现了，
见下文“词汇表”一节。每个词汇表的一致性文件在两种读法下都通过，即声明了词汇表和没有声明两种，
原生方式（`tests/profiles.rs`）和 WebAssembly 方式（`wasm/profiles.mjs`）都跑。

## 构建和测试

```bash
cargo test
```

```bash
cargo llvm-cov --fail-under-lines 95 --fail-under-regions 95 --fail-under-functions 95
```

```bash
wasm-pack build --target nodejs --out-dir wasm/pkg --release -- --features wasm
```

```bash
node wasm/conformance.mjs
```

```bash
node wasm/profiles.mjs
```

覆盖率门禁要求行、区域、函数三项都不低于 95%。分支覆盖率需要 nightly 编译器，没有统计。
CI 的 `parser-rs` 任务会跑这五条命令。

`examples/geml-rs.rs` 是基于本 crate 的一个小命令行，从一个目录读文件，有 `check`、`style`、
`history` 和 `codemap` 四个子命令。

```bash
cargo run --release --example geml-rs -- check <root> <file.geml>
```

## 接口

Rust：

```rust
let doc = geml::parse("# Title {#t}\n\nSee [[#t]].\n");
geml::project(&doc);      // 一致性投影
geml::blocks_of(&doc);    // 一致性块树
geml::to_json(&doc);      // 文档模型的 JSON
doc.diagnostics;          // 诊断码、严重级别、行号、说明
doc.ids;                  // 块 id，声明的和推导的
doc.addresses;            // 列表给出的地址（§4）
```

引用了外部内容的文档，解析时要给出文档名和一个 host。host 负责读取文件的文本，包括其他文档、
表格的数据文件、代码和数据路由，并报告文件的 SHA-256。`host::MapHost` 把这两样都放在内存里。
§9.4 的路径限制由 host 负责，因为只有它了解文件系统：

```rust
let host = geml::host::MapHost::from_json(r#"{"files": {"lib.geml": "…"}}"#)?;
let opts = geml::Options { name: "docs/a.geml".into(), host: Some(&host), ..Default::default() };
let doc = geml::parse_with(text, &opts);
doc.profiles;             // 文档声明、且本实现认识的词汇表
doc.profile_diagnostics;  // 这些词汇表的检查结果：诊断码、级别、地址
```

WebAssembly（`wasm/pkg`）：`parse(text)` 和 `parseBytes(bytes)` 以 JSON 返回模型，
包含 `children`、`diagnostics`、`meta`、`ids`、`addresses`、`profiles` 和
`profileDiagnostics`。核心部分另外还有 `decode`、`project`、`blocksOf`、`addresses` 和
`version`。host 以 JSON 传入，格式是 `{"files": {路径: 文本}, "hashes": {路径: sha256}, "complete": bool}`，
三项都可省略。`files` 放文本文件，它们的哈希按字节算出；`hashes` 放只给哈希的文件（图片、视频、音频）；
`complete` 表示 host 持有全部文件，它没有的路径就是缺失的文件：

| 函数 | 返回 |
|---|---|
| `parseIn(name, text, host)` | 模型，引用经 host 解析，检查也经 host 运行 |
| `styleCheck(host, sheet, corpus, registries)` | `geml-style/v1` 的 view model；`corpus` 是路径组成的 JSON 数组 |
| `historyVerify(sidecar, live?)` | 一个 `.gemlhistory` 的 `{errors, warnings, verified}` |
| `historyReconstruct(sidecar, revision)` | 某个版本的内容，已和记录的哈希核对 |
| `codemapVerify(name, host)` | `{ok, dangling, unchecked, problems}` |

## 实现了什么

- §0 输入规范化；§2 段落和列表；§3 类型块、围栏、带标签的关闭行、``` 屏蔽区、续行折叠；
  §3.2 的 `json`、`jsonl` 和 `yaml` 子集，遵守 I-JSON 的限制；§4 属性、按 NFD 比较的名字、
  标题 id、散文地址、合并后的 `meta`、插值；§5 行内原子、按分隔符侧翼规则的强调、引用和坐标；
  §6 表格；§6.1 视图，包括完整的 `compute`/`where`/`by`/`order`/`limit`/`select`/`summary`
  流程和显示格式；§9.2 嵌套上限；§9.5 URL scheme 规则。
- 经 host 实现跨文档的 §5.2 和 §9.3：指向另一份 GEML 文档的引用、行内投影、`embed`、
  视图和图表的数据源、`data` 的 schema，都解析一层。目标文档只解析出 id 和单元，它自己的引用不再跟下去。
- 经 host 读取文档引用的文件。`code` 路由（§3.3）会读出文件并核对行号范围：范围超出文件报
  `bad-source-range`，文件读不到报 `unresolvable-code-source`。`data` 路由（§3.2）读出后按范围截取、
  解析成块的值；格式由扩展名决定，写了 `format=` 时以它为准。表格、视图和图表的本地数据文件
  （§6、§6.1、§7.1）在构建时读出并当场核对列，后缀无关紧要：表格的按 `format=` 读，视图和图表的
  按后缀是 `.tsv` 则 tsv、否则 csv；图表的 `.json`/`.jsonl` 记录源读出后校验记录和列。
  路由先按文档相对路径解析，再从 host 的根目录解析
  （即 §3.3 的 `--root`）；`http(s)` 来源归渲染器处理，解析器不读取：构建期该块没有模型，
  读取它的 view、图表或坐标随它一起推迟。
- §9.3 的嵌入链：每个 `embed`，以及每个能放进句子里的行内投影，都会经 host 跟进到其他文档。
  链回到一份正在展开的文档时报 `transclusion-cycle`。模型里不做任何展开。
- 上述内容涉及的附录 A 诊断码，严重级别与目录一致，由 `tests/behaviour.rs` 检查。
  `tests/robustness.rs` 把每个用例在每个字符位置截断后解析，还解析一组恶意输入，
  例如 2 万层深的标签、10 万个星号、5000 个键的属性对象。

## 词汇表

文档按它自己的 `meta` 声明的词汇表来读（§8.6）。认识的词汇表会接纳它的块类型、属性键和
`meta` 键，并给每个类型指定正文模式：flow、raw，或 GEP-0013 的 prose。prose 正文只包含段落。
属于某个已认识词汇表的命名空间、但该词汇表没有定义的键，报 `unknown-meta-key`；本实现不认识的名字报
`unrecognized-vocabulary`。设置 `Options::recognize = false` 时，所有文档都按一个词汇表都不认识的处理器来读。

各词汇表的检查按地址报告（`doc.geml#id`，匿名块则是文档名加行号），级别沿用词汇表的三级：
error、warning、info。

| 词汇表 | 检查内容 |
|---|---|
| `geml-form/v1` | GEP-0008 规定的诊断：表单族的块放在表单外面、字段没有 `name=` 或和同一表单里另一个字段同名、字段带正文、字段类型未知、`options=` 和 `#note` 属性指向了错的块、没有字段使用的 `form-options` 或 `form-note`；`form` 或 `form-group` 上的坐标按 name 指向字段（`#signup["email"]`），指向它的引用显示字段的 label |
| `geml-media/v1` | 全部 33 个诊断码：时间线和轨道表、每条轨道能接受的片段来源、素材本身的时长、经 host 核对素材文件的 SHA-256、台词和说话人、合成画面和图层、按几何关系（裁切、缩放、镜像、偏移）解析的交互，以及跨文档的生成日志溯源，包括过期的生成结果、过期的剪辑片段、没有来源记录的素材 |
| `geml-style/v1` | `check::style::check` 把样式表对一组语料求解，得到 §10 的 view model：选择器、层内按条件集合仲裁、样式入口的三个层、`when=` 变体、box 和 params 的划分、token、embed、语料里的 `embed` 带进来的文档、状态、屏幕和 frame 以及给它们加样式的规则、frame 图，覆盖全部 21 个诊断码。对样式表运行 `geml check` 时，只跑不需要语料的检查 |
| `geml-history/v1` | `check::history` 读取 sidecar，沿 parent 链一次走完，把每个版本和记录的哈希核对，可以重建任意版本；工作文件和当前版本不一致时给出警告 |
| `geml-codemap/v1` | `check::codemap::verify` 经 host 跨文档解析边表的每个单元格和每个 `entry`，报告悬空的引用 |
| `geml-translator/v1` | 它的属性键和 `meta` 键；这个词汇表没有定义检查 |

本仓库自己的数据都能对上：规范的 history sidecar 57 个版本全部校验通过（`tests/history.rs`），
playground 的 57 份 codemap 文档没有悬空引用，网站上的 style 示例解出的视图模型和参考解析器的一样。

## 没有实现什么

- **没有 host 时不读取文档以外的任何内容。** 这时跨文档引用报 `unchecked-cross-document-reference`，也不读任何文件。
- **没有渲染器**（§8.3 规定渲染器是可选的）。
- **没有 `toml` 和 `edn` 的解析器。** 这两种格式的 `data` 块保留原文，报 `data-format-no-engine`，这是 §3.2 允许的做法。
