# GEML 推广计划书 · v2（2026-07-01 修订）

> **本次最大改动:楔子 PIVOT。** 原核心卖点「引用一断,构建就红」(`geml check`)**降级为一条 proof**。新楔子 = **「给 AI 反复编辑的文档:可寻址 + 带版本」**——agent 按 `#id` 只改一个块(`geml get/set`,实测 ~31× 少 token)、数字不漂、自带历史。下面「定位」已按新楔子重写,其余勾掉已完成、只留待办。
>
> 相关成品都在本分支(`tracker`):`blog/`、`seeds/`、`research/`、定位 spec `docs/superpowers/specs/2026-07-01-geml-positioning-design.md`;精简进度清单见 `task.geml`。

## 〇、地基:已完成 ✅

- ✅ **playground**(`geml-spec.github.io/geml/playground/`,含「弄断引用→变红」)
- ✅ **GitHub Action** 包 `geml check`(`geml-check-action/`;未抽独立 repo / 上 Marketplace)
- ✅ **双协议**(代码 MIT / 规范 CC-BY-4.0)· **中立 org** `geml-spec/`
- ✅ **治理**:GOVERNANCE + CONTRIBUTING + GEP 模板 + issue 模板
- ✅ **一致性 fixtures + 《用你的语言写 parser》**(`docs/WRITING-A-PARSER.md`)
- ✅ **npm** `@geml/geml@1.0.0`
- ✅ **VS Code 扩展 + Obsidian 插件**(已构建,**未上架**)
- ✅ **旗舰博文 + 种子帖(英+中)** —— 新楔子版
- ✅ **对比表** · **MD-vs-HTML 论战调研(英+中)**
- ✅ **`geml get/set #id`**(兑现「可寻址」+ 31×)· 覆盖率 CI 门 · `aside` 精简(GEP-0001)

## 一、定位(用这版,别用旧的）

| | 旧楔子 | **新楔子(现在)** |
|---|---|---|
| 一句话 | 引用一断,构建就红 | **改一行字,不该让 AI 先读完整份文档** |
| 主打 | 只 `geml check` | `geml get/set #id`(只改一块,~31× 少 token)领衔;数字不漂、自带历史;`geml check` 退为 proof |
| 对手 | 模糊 | 火力对准 **Markdown**(HTML 一笔带过:太重、`<tag>` 吃 token);GEML=可审阅/可寻址的**源**,`export` 成 MD/HTML |
| 情绪钩子 | agent 留死链 | agent 改巨型文档:烧 token、改乱章节/表/数、无版本回滚,最后手工收场 |
| 必答三连 | 927 | ①扩展 MD = 方言 = 歧义,规范化才是解药;②生态锁定(致命)→ `export` 共存;③模型还不会写→ 语法回归 + 可手改 |

## 二、杀手 demo(GIF)⏳ 待办,需按新楔子重录

同一份大文档、同一个 agent——左(MD)改一段得 grep + 读整篇、烧一坨 token、还改乱旁边的表;右(GEML)`geml get #id` 只取那块(token 计数肉眼可见地小)、`geml set #id` 只改那块、别处一字不动。15 秒不解说。**你的活。**

## 三、还需做的（按节奏）

**A. 先补的技术活(可代做)**
- [ ] **README 首屏按新楔子重写**(现仍是旧「引用完整性」)
- [ ] **推 `geml get/set` + 发 npm 1.0.1**(带正确 repo URL + 新命令)
- [ ] **Show HN 帖 + 首楼评论**(新标题;首楼预判 927 + 贴 playground)
- [ ] 对比表补一列「AI 编辑 / token 友好度」

**B. 真实案例 + 暗中预热**
- [ ] 拿一份真文档做 `geml get` before/after token 实测(替换博文占位 31×)
- [ ] Discord 预热:Latent Space、LLM Devs,收 2–3 条反馈

**C. 发射(顺序喂,全部待办)**
- [ ] Show HN(周二~四 美东 8–9am)→ 守评 4h → Lobsters → Reddit 错峰(r/ExperiencedDevs、r/devops → r/LocalLLaMA、r/LLMDevs → r/programming)→ newsletter / awesome PR

**D. 自助分发(发射后)**
- [ ] **上架** VS Code(publisher `geml-spec` + `vsce publish`)+ Obsidian(社区库)——已构建,就差上架
- [ ] tree-sitter 真语法(现只有 design brief)· 抽 `geml-check-action` 独立 repo(可选)

## 四、会复利的内容
- ✅ 旗舰故事《改一行字…》· ✅ 诚实对比表
- [ ] 自举故事《我用 GEML 写 GEML 规范,它能自校验》(杀「玩具」指控)
- [ ] 《为什么 AI 改文档需要可寻址的格式》(取代旧的「交叉引用应被类型检查」,那条已降级)

## 五、标准化轨道（纯 $0,待办）
- [ ] **独立实现者 #2**(最高杠杆;fixtures + 指南已备,就差钓到人、把 Python/Rust 作者身份让出去)
- [ ] **W3C CG**——门槛先凑 **5 个真实支持者**(本身就是 go/no-go);别碰 CNCF/Apache/OpenJS
- [ ] **GitHub Linguist**——门槛 ≥20 个公开 `.geml` + 真实使用

## 六、决策门
| 门 | 触发 | 然后 |
|---|---|---|
| **发射门** | playground✅ + Action✅ + **README 新楔子改完(待办)** | 才 Show HN |
| 楔子牵引 | ≥20 个 `.geml` / ≥1 真实案例 | 提 Linguist |
| 多实现门 | 1 个他人实现 | 大力宣传 |
| 标准门 | 5 个真实支持者 | 开 W3C CG |

## 七、诚实赔率
细分地位更具体:从「链接完整性检查器」→ **「AI 编辑文档的可寻址 + 带版本源格式」**,赛道更大(所有拿 coding agent 碰文档的人)。「取代 Markdown 成 THE 标准」仍 <2%、十年副产品、非目标。6–12 个月好结果:几千 stars + 该细分地位 + 2–3 独立实现者 + 也许 W3C CG。

## ⭐ 现在就动手的 5 件（替换旧版）
1. **README 首屏重写**(新楔子)— 可代做
2. **录新 demo GIF**(token / 可寻址 对比)— 你的活
3. **推 `geml get/set` + 发 1.0.1** — 可代做
4. **上架 VS Code + Obsidian** — 你注册 publisher,我备料
5. **draft Show HN 帖 + 首楼** — 可代做
