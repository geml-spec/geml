# @geml/dsh-plugin — DeepSeek Harness 上的 GEML

[English](README.md) | 中文

本插件为 harness 提供 **Agent-Native** 的文档处理能力。多轮交互最容易被 Token
膨胀拖垮——整篇读进来、整篇写回去，内容越滚越臃肿，也越来越偏离事实。
[GEML](https://github.com/geml-spec/geml) 把文档呈现为**可寻址的块**，让 LLM
能精准理解与改写：取一个小节、写回一个小节，Token 只需零头，宝贵的上下文窗口
留给真正的工作。内建的**引用机制**维持**单一数据源（Single Source of
Truth）**，事实不再散落成互相漂移的副本，Agent 可以零负担地读写与维护。

这个 bundle 带三样东西：

- **GEML MCP server** —— 一行 `@deepseek-ai/dsh-mcp-client`，运行
  `npx -y @geml/geml mcp --root .`，限定在会话自己的项目目录内。模型看到的是
  `mcp__geml__geml_get`、`mcp__geml__geml_set`、`mcp__geml__geml_check` 等工具，
  于是一次改一个块，而不是重写整个文件。
- **写作技能**（`skills/geml/`）—— 黄金规则、校验闭环，以及一份分节的参考文档
  （`references/authoring.geml`），Agent 按需取其中一节。
- **代码图谱技能**（`skills/geml-code-graph/`）—— 构建、查看、更新和浏览项目的
  调用图：谁调用了 X、X 调用了谁、影响路径，并在浏览器里渲染出图。

这个 bundle 自身不含任何代码——它配置的两个插件都随 dsh 安装自带，技能则是
Markdown。安装时不构建任何东西，因此完全不涉及 `allowBuilds` 构建授权。

## 安装

```sh
dsh plugin --profile web add @geml/dsh-plugin
```

先不启动、只验证这一层，再启动：

```sh
dsh --profile web --dump-config   # 应能看到 "# == @geml/dsh-plugin" 这一层
dsh --profile web
```

`dsh plugin --profile web remove @geml/dsh-plugin` 会同时移除依赖和这一层。

## 配置

两行都是普通配置：在你 profile 的 `cordis.patch.yml` 里按 `id` 覆盖即可，注意
要把该行需要的每个键都重新写全。例如把 `mcp-geml` 钉到某个 CLI 版本：

```yaml
- id: mcp-geml
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: geml
    transport: stdio
    command: npx
    args: ['-y', '@geml/geml', 'mcp', '--root', '.']
```

用 PATH 上的全局 `geml` 也可以——把 `command` 改成 `geml`，去掉 `npx` 那几个
参数。

想要 CLI 和同一套技能用在 Claude Code 上：`npx -y @geml/geml skill install`，
或使用 [`../claude-plugin`](../claude-plugin) 下的插件。
