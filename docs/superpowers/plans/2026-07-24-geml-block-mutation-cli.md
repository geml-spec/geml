# GEML 块变更 CLI 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `geml` CLI 补齐块变更动词(`set` 改造 + 新增 `add`/`delete`/`rename` + `revert` 复活已删块),让 agent 只用命令行就能完整创作/编辑一个 GEML 文件,可管道。

**Architecture:** 所有 CLI 动词仍住在 `geml-parser/src/geml.ts`(沿用现有 all-in-one dispatch 模式)。可复用的**纯函数**(id 归一化、引用改写、插入定位)抽到新模块 `geml-parser/src/block-edit.ts`,便于单测。共享一套「解析感知的守卫式写盘 + 输出目标解析」。

**Tech Stack:** TypeScript → `tsc` 编译到 `dist/`;测试是 `.mjs`,`node test/<suite>.test.mjs`,汇总 `node test/all.mjs`;覆盖率 `c8`。

设计依据:[`docs/superpowers/specs/2026-07-24-geml-block-mutation-cli-design.md`](../specs/2026-07-24-geml-block-mutation-cli-design.md)(下称 SPEC;逐动词行为矩阵见 SPEC §4)。

## Global Constraints

- 提交信息 / PR / 注释**不出现任何模型标识符**;提交用用户 git 身份、无 Co-Authored-By。
- 不动 parser / renderer 语义;只改 CLI(`geml.ts` + 新 `block-edit.ts`)+ test/ + 三个 README + version。
- 每个动词落位后走**守卫**:重解析无 error → 才写(delete 的悬空引用是例外,见 Task D)。
- `npm test`(`tsc && node test/all.mjs`)全绿;`npm run coverage:check`(lines/statements/functions/branches 均 ≥95)通过。
- **输出目标规则(仅变更动词 set/add/delete/rename)**:文件输入→默认就地写回;stdin(`-`)输入→默认 stdout;`-o <path>`→写该文件;`-o -`→stdout。`revert` 只收真实文件、默认就地、`-o -` 可吐 stdout。`--to` 转换入口与 `get`/`check` **不适用**此规则(它们不是 mutation)。
- 编辑动词均支持 `<file|->`(stdin),以便管道;管道中文档走 stdin、内容源用 `--in FILE`。
- 提交粒度:每个 Task 独立可测、独立提交。

---

## File Structure

- `geml-parser/src/geml.ts`(改):`runSet` 改造;新增 `runAdd`/`runDelete`/`runRename`;`runRevert` 扩展;dispatch 加 add/delete/rename;USAGE/SUBHELP;输出目标解析改用共享 helper。
- `geml-parser/src/block-edit.ts`(新):纯函数——
  - `normalizeBlockId(blockSrc: string, newId: string): string` — 把一段块源码的 HEAD id 改写成 newId(覆盖围栏 `{#x}`/标签闭合 `=== #x`/标题 `{#x}`/slug/无 id)。
  - `rewriteRefs(docSrc: string, oldId: string, newId: string): string` — 按 id 边界改写全文引用(`[[#x]]`/`[t](#x)`/`[^x]`/chart `data=#x`)。
  - `resolveInsert(docSrc: string, pos: {mode:'append'|'before'|'after', anchor?: string}): number` — 返回插入的物理行下标(splitLines 口径)。
  - `resurrectPos(curSrc: string, revSrc: string, id: string): {mode,anchor} | 'append'` — 按历史邻居推断复活位置。
- `geml-parser/test/`(新/改):`block-edit.test.mjs`(纯函数单测)、`add.test.mjs`、`delete.test.mjs`、`rename.test.mjs`;`get-set.test.mjs`(补 set 归一化/`--body`/输出规则)、`revert.test.mjs`(补复活)、`cli.test.mjs`(输出规则/USAGE);`all.mjs` 注册新套件。
- `geml-parser/package.json` + `src/geml.ts` `PARSER_VERSION`:bump(minor 起,breaking 建议 major——待定,见 Task Docs)。
- `README.md` / `README_CN.md` / `geml-parser/README.md`:CLI 段 + parser README 出发点段。

复用现有:`blockSpans`、`splitLines`、`narrowToHead`、`spliceBlock`、`parse`、`resolverFor`、`flag`、`positionals`、`fail`、`readInput`、history 层(`resolveContent` 等)。

---

## 阶段与任务

### Task O: 输出目标 helper(变更动词统一;先落到 set)

**Files:** Modify `geml-parser/src/geml.ts`;Test `geml-parser/test/cli.test.mjs`、`geml-parser/test/get-set.test.mjs`

**Interfaces — Produces:** `resolveOutTarget(file: string, oFlag: string | undefined): { write(text: string): void }` —— file 为真实文件且无 `-o`→就地写回 file;file==='-' 且无 `-o`→stdout;`-o -`→stdout;`-o <p>`→写 p。写文件时 stderr 打 `wrote <p>`。

- [ ] **Step 1: 失败测试(set 文件输入默认就地)** —— 在 `get-set.test.mjs` 加:写 `doc.geml`,`run(["set", f, "#a", "--in", g])`(无 `-o`),断言 `code===0`、**文件已被改**(read(f) 含新内容)、stdout 为空。
- [ ] **Step 2: 失败测试(set stdin 输入默认 stdout)** —— `run(["set","-","#a","--in",g], DOC)` 断言 stdout 含更新后的整篇、文件系无(用 stdin)。
- [ ] **Step 3: 失败测试(`-o -`→stdout)** —— `run(["set", f, "#a","--in",g,"-o","-"])` 断言 stdout 有内容、f 未变。
- [ ] **Step 4: 跑测试确认失败** —— `node test/get-set.test.mjs`;预期新用例失败(当前 set 默认 stdout)。
- [ ] **Step 5: 实现 `resolveOutTarget` 并改 `runSet` 用它** —— 逻辑见上 Produces;`runSet` 末尾从「`if(out)writeFile else stdout.write`」换成 `resolveOutTarget(file, out).write(updated)`。
- [ ] **Step 6: 迁移既有 set 用例** —— 原来靠「默认 stdout」的 set 用例(如 `run(["set",f,"#a"],repl)` 拿 stdout)改成显式 `-o -`,或改断文件已改。全文件扫 `["set"` 调用,逐个校准。
- [ ] **Step 7: 跑 `node test/get-set.test.mjs` + `node test/cli.test.mjs` 绿**
- [ ] **Step 8: Commit** —— `feat(cli): mutation output = in-place for a file, stdout for stdin (-o/-o - redirect)`

---

### Task S: `set` id 归一化 + `--head`/`--body`(SPEC §4.1)

**Files:** Create `geml-parser/src/block-edit.ts`;Create `geml-parser/test/block-edit.test.mjs`;Modify `geml-parser/src/geml.ts`(`runSet`);Modify `get-set.test.mjs`

**Interfaces — Produces:** `normalizeBlockId(blockSrc, newId)`(见 File Structure)。**Consumes:** Task O 的 `resolveOutTarget`。

- [ ] **Step 1: 失败单测 `normalizeBlockId`(block-edit.test.mjs)** —— 断言:
  - `=== note {#rough .lead}\nx\n===\n` + `intro` → `=== note {#intro .lead}\nx\n===\n`
  - 标签闭合 `=== note {#rough}\nx\n=== #rough\n` → `… {#intro} … === #intro`
  - 标题 `## T {#rough}` → `## T {#intro}`;`## T`(slug) → `## T {#intro}`
  - 无 id `=== note\nx\n===` → `=== note {#intro}\nx\n===`
- [ ] **Step 2: 跑 `node test/block-edit.test.mjs` 失败(模块不存在)**
- [ ] **Step 3: 实现 `block-edit.ts` 的 `normalizeBlockId`** —— 解析首个 HEAD 行(复用 `blockSpans`/parse 定位首块 head)+ 闭合围栏;正则/结构化改写 id;各形态见 Step1。
- [ ] **Step 4: 跑 `node test/block-edit.test.mjs` 绿**
- [ ] **Step 5: 失败 CLI 测试(set 归一化 + 三模式)**,在 get-set.test.mjs:
  - 默认整块归一化:`set doc #intro --in draft#rough`(不同 id)→ exit 0,`get #intro` 显示 draft 内容但 id=intro。
  - `--head`:`set doc #a --head --in src#b`(源头行不同 id)→ 头行换成 src 的(归一化 id=a),body 保留。
  - `--body`:`set doc #a --body`(stdin 纯 prose)→ 只换正文、头(含 #a)保留。
  - 默认模式喂纯 prose(无 head)→ exit≠0,stderr 提示用 `--body`。
  - 多块内容 → exit≠0(expected one block)。
  - 空内容(`--in -` 空/空文件/省略)→ 统一友好 `no replacement content`。
- [ ] **Step 6: 跑测试失败**
- [ ] **Step 7: 改 `runSet`** —— 加 `--body` flag;默认/`--head` 分支:取内容→`normalizeBlockId(content, id)`→`spliceBlock`(默认整块;`--head` 用 narrowToHead 目标 + 内容取归一化后的头行);`--body`:保留目标 head、只替换 body(用 blockSpans 求 head/body 边界);形态判定(单块/多块/纯 prose)与空内容统一报错。归一化让「id 不符」不再失败。
- [ ] **Step 8: 跑 get-set + block-edit 绿**
- [ ] **Step 9: Commit** —— `feat(cli): set normalizes content id to the target; add --head/--body`

---

### Task A: `add`(SPEC §4.2)

**Files:** Create `geml-parser/test/add.test.mjs`;Modify `geml-parser/src/geml.ts`(新增 `runAdd` + dispatch);Modify `src/block-edit.ts`(`resolveInsert`);`all.mjs`(注册 `add`)

**Interfaces — Produces:** `runAdd(argv)`;`resolveInsert(docSrc,{mode,anchor})→行下标`。**Consumes:** Task O `resolveOutTarget`。

- [ ] **Step 1: 失败单测 `resolveInsert`** —— append→末行;`after #x`→#x span end;`before #x`→#x span start;anchor 不存在→抛错(由调用方转 fail)。
- [ ] **Step 2: 跑失败 → 实现 `resolveInsert` → 跑绿**
- [ ] **Step 3: 失败 CLI 测试 add.test.mjs**:
  - `add doc --after #x --in src#blk` → #blk 插到 #x 后(保留自身 id),exit 0。
  - `add doc --append --in src.geml`(多块)→ 全部块追加,id 须唯一。
  - `add doc --append`(stdin 纯 prose)→ 追加段落,exit 0(**prose 允许**)。
  - id 冲突(块 id 撞文档已有 / 批内重复)→ exit≠0,不写。
  - `--before #x` / anchor 不存在报错 / 空内容报错。
  - 管道:`cat frag | geml add - --after #x`(doc=stdin)→ stdout 输出整篇。
- [ ] **Step 4: 跑失败**
- [ ] **Step 5: 实现 `runAdd`** —— 解析定位 flag(append/before/after)+ 内容来源(stdin/`--in F`/`--in F#src`,复用 set 的来源逻辑,但**不归一化**);`resolveInsert` 求下标;splice 片段进去;守卫(重解析净 + 声明 id 唯一);`resolveOutTarget` 写。dispatch 加 `add`。
- [ ] **Step 6: 注册 all.mjs `add`;跑 add.test 绿**
- [ ] **Step 7: Commit** —— `feat(cli): add — splice a GEML fragment (1+ blocks / prose) at a position`

---

### Task D: `delete`(SPEC §4.3)

**Files:** Create `geml-parser/test/delete.test.mjs`;Modify `geml-parser/src/geml.ts`(`runDelete`+dispatch);`all.mjs`

**Interfaces — Produces:** `runDelete(argv)`。

- [ ] **Step 1: 失败 CLI 测试 delete.test.mjs**:
  - `delete doc #a #b`(多 id)→ 两块都没了,exit 0。
  - 缺失 id `delete doc #a #ghost` → 删 #a、stderr 记一句 `#ghost` 跳过、**exit 0**、#ghost 不报错。
  - 删被 `[[#a]]` 引用的块 → **exit 0 + stderr warning(悬空)**、块确实删了(不拒写)。
  - 之后 `geml check` 对结果 → exit 1(悬空是 error)——单独断言这条,证明「delete 只告警、check 才拦」。
  - 管道 `geml delete - #a`(doc=stdin)→ stdout 整篇。
- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现 `runDelete`** —— 收集多个 id(positionals);对每个存在的块用 blockSpans 求 span、从后往前删(避免下标漂移);缺失 id→stderr note、跳过;删完重解析:parse error(非悬空)→ fail;悬空引用诊断→ **warning 到 stderr、不拦**;`resolveOutTarget` 写;exit 0。dispatch 加 `delete`。
- [ ] **Step 4: 注册 all.mjs;跑 delete.test 绿**
- [ ] **Step 5: Commit** —— `feat(cli): delete one or more blocks; missing = skip, dangling refs = warn not refuse`

---

### Task R: `rename`(SPEC §4.4)

**Files:** Modify `src/block-edit.ts`(`rewriteRefs`);Modify `block-edit.test.mjs`;Create `geml-parser/test/rename.test.mjs`;Modify `src/geml.ts`(`runRename`+dispatch);`all.mjs`

**Interfaces — Produces:** `rewriteRefs(docSrc, oldId, newId)`;`runRename(argv)`。

- [ ] **Step 1: 失败单测 `rewriteRefs`(block-edit.test.mjs)**:
  - `[[#old]]`/`[t](#old)`/`[^old]`/`data=#old` 全改成 new。
  - **id 边界**:`#old2`、`#old-x` **不**被误改;`{#old}` 声明本身也改。
- [ ] **Step 2: 跑失败 → 实现 `rewriteRefs`(负向前瞻 `#old(?![\w-])`)→ 跑绿**
- [ ] **Step 3: 失败 CLI 测试 rename.test.mjs**:
  - `rename doc #a #b` → #a 声明 + 所有引用变 #b,exit 0(默认就地)。
  - #b 已存在 → exit≠0(唯一性),不写。
  - #old 有引用、正常改到 #new 后引用仍解析 → check 净。
  - stdin:`cat doc | geml rename - #a #b` → stdout 整篇(证明支持 stdin/管道)。
- [ ] **Step 4: 跑失败**
- [ ] **Step 5: 实现 `runRename`** —— 读 doc;`rewriteRefs` + 声明改写(可复用 normalizeBlockId 只改那一块的声明,或统一在 rewriteRefs 里含声明);守卫(重解析净 + #new 唯一 + #old 无残留);`resolveOutTarget` 写(支持 `<file|->`)。dispatch 加 `rename`。
- [ ] **Step 6: 注册 all.mjs;跑 rename.test 绿**
- [ ] **Step 7: Commit** —— `feat(cli): rename — rewrite an id's declaration and every reference (id-boundary safe)`

---

### Task V: `revert` 复活已删块(SPEC §4.5)

**Files:** Modify `src/block-edit.ts`(`resurrectPos`);`block-edit.test.mjs`;Modify `src/geml.ts`(`runRevert`);Modify `revert.test.mjs`

**Interfaces — Produces:** `resurrectPos(curSrc, revSrc, id)`。**Consumes:** `resolveInsert`。

- [ ] **Step 1: 失败单测 `resurrectPos`** —— 历史里 #id 前邻 #p 仍在当前 → `{after,#p}`;前邻都没了、后邻 #n 在 → `{before,#n}`;都没了 → `append`。
- [ ] **Step 2: 跑失败 → 实现 → 跑绿**
- [ ] **Step 3: 失败 CLI 测试 revert.test.mjs**:
  - 建 doc + `history commit` + `delete #mid` → `revert #mid` → #mid 按原位(邻居后)复活,exit 0。
  - `revert #mid --after #x` 显式定位 → 插到 #x 后。
  - #id 仍在时 revert → 就地换历史版本(现状回归,不破坏)。
- [ ] **Step 4: 跑失败**
- [ ] **Step 5: 改 `runRevert`** —— 当前逻辑:`blockSpans.get(id)` 无 → 现在不再直接 fail,而是**复活分支**:取历史 #id 块源码(现有 `pick`/`resolveContent`),`resurrectPos`(或 `--after/--before/--append` 覆盖)求位置,`resolveInsert` splice 进去;守卫(重解析净 + #id 唯一)。#id 仍在 → 走原就地替换分支。
- [ ] **Step 6: 跑 revert.test + block-edit 绿**
- [ ] **Step 7: Commit** —— `feat(cli): revert can resurrect a deleted block (anchor-inferred or explicit position)`

---

### Task U: USAGE / SUBHELP

**Files:** Modify `src/geml.ts`(USAGE、SUBHELP);Modify `cli.test.mjs`

- [ ] **Step 1: 改 USAGE** —— 加 `add`/`delete`/`rename` 行;`set` 行标 `[--head|--body]`;输出规则一句(文件→就地 / `-` →stdout)。SUBHELP 加三条。
- [ ] **Step 2: 改 cli.test 的 `--help` 断言** —— 列出的命令加 get/set/add/delete/rename/revert/check/history/codemap。
- [ ] **Step 3: 跑 cli.test 绿**
- [ ] **Step 4: Commit** —— `docs(cli): USAGE/SUBHELP for add/delete/rename + set --head/--body`

---

### Task Docs: 三个 README + 出发点 + 版本 bump

**Files:** Modify `README.md`、`README_CN.md`、`geml-parser/README.md`、`geml-parser/package.json`、`src/geml.ts`(PARSER_VERSION)

> 人面向 prose —— 落笔前把改写稿给用户过目、确认再改(遵循 docs 审批习惯,中文答复)。

- [ ] **Step 1: 拟 parser README 的「设计出发点」段 + CLI 段新模型草稿,呈交用户确认**(不直接改)。
- [ ] **Step 2: 用户确认后**改 `geml-parser/README.md`:新增出发点理念段(SPEC §1 的理念,自然语气,含「可管道」)+ CLI 段列 set/add/delete/rename/revert + 输出规则。
- [ ] **Step 3: 同步** 根 `README.md` / `README_CN.md` 的 CLI 段(与 parser README 逐条对齐;CN 与 EN 内容一致)。
- [ ] **Step 4: 版本 bump** —— `package.json` version + `src/geml.ts` `PARSER_VERSION` 同步;changelog 记「set 默认输出变更(breaking)+ 新增 add/delete/rename + revert 复活」。minor vs major 由用户定(breaking → 倾向 major)。
- [ ] **Step 5: Commit** —— `docs(readme): document the block-mutation CLI + design rationale; bump version`

---

### Task Final: 全量回归

- [ ] **Step 1:** `npm test` 全绿(所有套件,含新 add/delete/rename/block-edit)。
- [ ] **Step 2:** `npm run coverage:check` ≥95(四项)。缺口补测试。
- [ ] **Step 3:** `geml --help` 冒烟 + 每个新动词一条真实调用冒烟(临时目录)。
- [ ] **Step 4:** push 分支(用户确认后)。

---

## Self-Review(对 SPEC 的覆盖核对)

- SPEC §4.1 set 三模式 + 归一化 → Task S ✓;输出规则 → Task O ✓。
- §4.2 add(定位/多块/prose/冲突) → Task A ✓。
- §4.3 delete(多 id/缺失/悬空告警) → Task D ✓。
- §4.4 rename(id 边界/stdin) → Task R ✓。
- §4.5 revert 复活 → Task V ✓。
- §7 交付物(USAGE/README/版本 bump) → Task U + Docs ✓。
- §8 风险(rename 边界、revert 推断、delete 悬空、归一化 HEAD 形态) → 分别落在 R/V/D/S 的测试用例 ✓。
- 类型一致性:`resolveOutTarget`/`normalizeBlockId`/`rewriteRefs`/`resolveInsert`/`resurrectPos` 命名在 Produces/Consumes 间一致 ✓。
