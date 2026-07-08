# GEML 定位 & 旗舰软文设计（2026-07-01）

> 状态：脑暴产出，5 节均经用户逐节确认，并已纳入「MD vs HTML 论战」调研（见 `research/md-vs-html-debate.md`）。本 spec 驱动 **旗舰博文（EN+CN）+ 种子帖（EN+CN）**，全部落 `tracker` 分支待审。
> 依赖：`geml get/set #id` 已实现（main `f908ffe`，尚未 push）。

---

## 1. 定位转向（the pivot）

旧楔子「断引用 = 构建错误」对多数人是**维生素不是止痛药**。创始人真实的痒在别处。

**真实痒（来自用户亲历，作为全篇原型）：** 用 Claude Code 写一份不断膨胀、带表带 chart 的**数据仓库迁移 & 重构技术方案**（反复增改），踩到四个坑：
- **① 定位靠 grep、大文件烧 token** —— 每次让 agent 取一块/算一块，都得读进一大片，token 哗哗掉，还未必定位准；
- **② 改乱** —— 章节被重排、表格前后不一致、图表数据和源表对不上；
- **③ 无引用** —— 各部分之间没有可校验的纽带，漂了也没人知道；
- **④ 方案要历史 / 回滚** —— 反复改版需要版本历史，硬绑 git + worktree 又麻烦；
- 结果：**最后还是手工调整才交付了一个满意版本。**

**新楔子：** GEML = 为「被 AI 反复编辑的文档」而生的纯文本格式 —— **像 Markdown 一样轻，像数据结构一样「可寻址 + 带版本」。** ① 可寻址/省 token 领衔；② 版本、③ 轻而可操纵 作支撑；旧的「引用校验」降为一条 proof point。

---

## 2. 一句话定位（dek，选定 A）

> EN: *"GEML is a plain-text document format with addressable blocks: an agent reads or rewrites one section by its `#id` — no grepping, no re-reading the whole file — and the document keeps its own version history, without git."*
>
> 中：块可寻址的纯文本文档格式：agent 按 `#id` 只读/只改某一节——不 grep、不重读整篇——文档还自带版本历史，不绑 git。

（把「像 MD 轻 / 像 HTML 可寻址」这句 thesis 留到文末当 payoff。）

---

## 3. 叙事策略

- **主线 = 用创始人亲历场景构造（scene-first）。**
- 「MD 太散 / HTML 太重」那场论战**殿后当助攻，不当开场。** 三理由：(1) 抽象/thesis 打头 = 读者「没感觉」；(2) 论战开场让 GEML 显衍生，亲历场景 = 「自造的解药」，最可信；(3) 顺序照用户 1→2→3。

**论战的真实焦点（来自调研 `research/md-vs-html-debate.md`，务必如实）：** 那篇 Claude 文章的真实论点**不是**「HTML 更好」，而是「**Markdown 过了 ~100 行就没法让人有效审阅**（review 沦为橡皮图章），HTML 让人**留在环里**」；作者承认 MD 更省 token、自称「HTML maximalist」。全场共识落点：**「HTML 交付、Markdown 做协作/源」**。
→ ③ 段**如实**呈现这个「可审阅性」焦点(「HTML 太重」可以讲——`<tag>`+内联样式+内容本身就吃 token,是实打实的成本;只是别把它当成那篇文章的主论点)，并把 GEML 定位成 **可审阅、可寻址的『源真相』，编译出你要的 MD/HTML 交付物**——这正是调研给的推荐定位，与 get/set + check + **export** 严丝合缝。

---

## 4. 文章骨架（spine）

1. **冷开场**（先抛结局：手工收场）—— ① token/grep + 改乱预览。
2. **proof points**（4 条：pain → GEML 怎么治）。
3. **拉远**：如实的论战焦点（可审阅性；HTML 交付 / MD 做源）+ GEML=「源真相，编译成 MD/HTML」。
4. **回应三条批评**（见 §8.5）+ 诚实 scope。
5. **CTA**（来验我的数）。

---

## 5. 开场段（定稿草案）

> I finished it by hand.
>
> A sprawling technical proposal — a plan to migrate and re-architect a data warehouse, thick with tables and charts, and still growing every week — and after days of driving Claude Code through revision after revision, the only way to ship a version I trusted was to sit down and fix the last mile myself. Not because the model wasn't capable. Because the *document* was working against both of us.
>
> Every small change cost far more than its size. Ask the agent to adjust one section and it would grep, pull long stretches of the file into context just to get its bearings, and spend thousands of tokens locating a few lines. Then it would "helpfully" do more than I asked — reorganizing sections I never mentioned, reflowing a table two pages away. Tables drifted out of step with the prose; a number in a chart stopped matching the table it came from. Nothing caught any of it, because in a plain-text document nothing *can*: there's no unit the agent can grab and say "only this block," no link binding a chart to its source table, no record of what the last good version even was.
>
> By the end I wasn't editing a document. I was babysitting one.

> **规模走定性（已确认）**：不写确切行数（用户对「5万行」不确定）；硬指标只用第 6 节可复现的 31×。

---

## 6. Proof points（pain → GEML 怎么治 → 真东西）

**过渡句：** *Every one of those failures is the same missing thing wearing a different mask: a plain-text document has no structure you can address, check, or version. So I gave it one. GEML is still plain text — you read and diff it like Markdown — but every block is a typed, `#id`-addressable unit.*

**① 只碰这一块 — `geml get/set #id`**
- pain：改一节 → 读整篇 + 改多了。
- GEML：每块一个 `#id`；`geml get #id` 只吐那一块，`geml set #id` 只换那一块、别处一字节不动。
- 真东西（实测，可复现）：真实的 `GEML-spec.geml` 共 **19,775 字符**，`geml get #abstract` = **633 字符** → 碰一个块只需读进 **~3.2%（≈31× less）**，文档越大差距越大。**定稿在更接近数仓方案的文档上重测。**

**② 数字不会漂移 — 计算列 + 图表绑表**
- pain：表格前后不一致；图表数据和源表对不上（用户「让 AI 算些、加数据表格」正是重灾区）。
- GEML：表自算列 `compute="FY [%.1f] = Q1 + Q2 + Q3 + Q4"`，图按 id 绑表 `data=#fy25` 而非复制数字。数值只存一份，加一行则合计与图表自动跟随——「图和表对不上」从根上不可能。

**③ 引用要么解析要么报错 — `geml check`**
- pain：各部分间无纽带，漂了没人知道。
- GEML：任意块按 id 引用（`[[#migration-plan]]`、图表 `data=#fy25`、脚注），`geml check` 把未解析引用变成**构建错误**，CI 里当场炸。（旧楔子降为此条。）

**④ 自带「上一个好版本」— `geml history`，不绑 git**
- pain：方案反复改版、要历史/回滚，硬绑 git 麻烦。
- GEML：`geml history` 把每个版本存进纯文本 `.gemlhistory` sidecar，提交/查看/回滚，离线、不绑 git、不依赖服务——你想要的那种「联机文档历史」，就在文件旁边。

**收束：** 这不是四个功能，是一个根——文档需要可寻址、可校验、带版本的结构。

---

## 7. CTA（文末，呼应开场「手工收场」）

> **Try it — and check my numbers.** Don't take the ~31× on faith: clone the repo and run `geml get #id` on the spec yourself — the spec is written in GEML.
> - **Playground** — in your browser, no install: https://geml-spec.github.io/geml/playground/ . Break a reference, watch the build go red.
> - **CLI:** `npm i -g @geml/geml`, then run `geml get`, `geml check`, and `geml history` against your own worst document.
> - **Repo & spec:** https://github.com/geml-spec/geml . Early and deliberately small — open proposal process (GEP), a conformance suite a second implementation can reproduce. Issues, critique, and a third-language parser all welcome.
>
> I built this because a document I couldn't hand to an agent beat me into finishing it by hand. I'd like to hear where it beats you — and where GEML doesn't hold up.

基调：不催装、不吹量；主 CTA = **「来验我的数」**。

---

## 8. 目标读者 & 分发

- **主攻：** 用 AI coding agent（Claude Code / Cursor）写、改、维护**大型结构化技术文档**的工程师——技术方案 / 设计文档 / 迁移&架构方案 / 规范 / 数据文档 / runbook。痛点：token 成本、agent 改乱大文档、文档没像样版本。
- **写作视角：** 默认读者在用 Claude Code、按 token 付费、维护一份会不断膨胀的文档。
- **不是（现在的）目标：** 随手笔记 / 博客 / 小 README —— 对他们 Markdown 挺好，文里直说（诚实 scope）。
- **落地在哪（接种子帖）：** Claude Code / LLM-dev 圈（**那篇 HTML 博客的读者群**）、r/devops、r/ExperiencedDevs、数据/平台工程社区、docs-as-code（Write the Docs）、HN。

---

## 8.5 回应三条批评（source: `research/md-vs-html-debate.md`）

文章必须正面（哪怕简短）回应，否则会被这三条秒杀：

1. **XKCD 927「凭啥又一个标准」** → 只打别人**结构上给不了**的那条轴：`#id` 可寻址 + `geml check` 构建期校验；**绝不**自称「更漂亮的 Markdown」。
2. **生态锁定（调研评为「决定性杀手」）** → Markdown 王牌是 GitHub/Notion/Slack/Pandoc 到处原生渲染，所有挑战者都死在这。**对策（P0）：把 `geml export` 到 MD/HTML 摆在显眼处，通篇「共存、不锁定」——GEML 当源，交付照旧是 `.md`/`.html`。**
3. **协作摩擦 + 「模型不会写它」** → 诚实承认新语法训练数据少；用「回归的语法好学 + agent `--json` 自查自修 + 你仍像 MD 一样直接读改」来缓，别让 `geml set` 显得「又多一道坎」。

---

## 9. 数字与真实性政策（integrity）

- **不写「总共烧了多少 token」**——历史账事后算不清，硬编即自毁「可验证」招牌。
- **硬数字只用「单次改一个块」的可复现比值**（实测 31×，读者 clone 后可自验）；定稿在更接近数仓场景的文档上重测。
- **开场体量定性**（已定），不用没把握的「5 万行」。
- 所有技术示例/命令输出/数字必须对齐真实工具。

---

## 10. 定位护栏（guardrails）

- **不打「取代 Markdown」**；**不喊「AI-native」buzzword**（靠具体场景，不靠词）；强调与 Markdown 共存（`geml convert` / `geml export`），export 抬为 P0。
- **诚实 scope**：早期、刻意做小、GEP、第二实现规划中；「没被咬过就先别切」。
- 只用 `note`（GEP-0001 已移除 `aside`；main 已干净，tracker 旧副本随瘦身删除，无遗留）。

---

## 11. 依赖 & 待办

- `geml get/set` 已实现（main `f908ffe`，**未 push**）——发布前需 push。
- 需在「接近数仓方案」的文档上实测 before/after 真实数。
- 论战调研已提交 tracker `research/md-vs-html-debate.md`，作补充参考，可能反哺协议。
- tracker 已瘦身为纯营销分支（产品文件在 main）。
- playground 已支持 break-a-ref；是否加「get 一块」演示待定。

---

## 12. 本 spec 驱动的交付物

- `blog/flagship-en.md` + `blog/flagship-zh.md`（**重写**，替换旧的「引用完整性」版）。
- `seeds/seed-posts-en.md` + `seeds/seed-posts-zh.md`（**重写**）。
- CN 为地道改写，非直译；EN 优先。旧版覆盖（git 历史保留）。
