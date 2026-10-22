// The record's own 35 decision lines (2026-10-19 to 10-21), labelled: the fixed set isStatusLine is measured against. Change the patterns, rerun this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isStatusLine } from "../dist/core/session-log.js";

const LINES = [
 {
  "text": "feat/gemflow is pushed to origin at 8b68029e (gemflow 0.2.43).",
  "kind": "status"
 },
 {
  "text": "No copy icon on the status band's text for now: the user chose 先不加 (2026-10-21).",
  "kind": "choice"
 },
 {
  "text": "Synced to ~/.claude/local-marketplaces/geml-dev/gemflow (watched): node suite 709 pass, engine tests 56/56, plugin validate passed; host.test's no-commits case times out only under the full suite's load.",
  "kind": "status"
 },
 {
  "text": "gemflow 0.2.43 (feat/gemflow): the sessions tab's decisions wrap whole, the before-merging file list is removed, this session's turns come before the other sessions, a turn unfolds in place on one press with split/delete as right-hand icons and no menu, each session's heading carries its export (formats under it, no cancel), and the flow tab sits after the journal.",
  "kind": "status"
 },
 {
  "text": "Plan for the reply: comply as asked, keep Encoding considerations to binary plus UTF-8 plus canonical CRLF, and do not reopen text versus application; the planned nudge email is not sent.",
  "kind": "plan"
 },
 {
  "text": "The IANA reviewer's follow-up asks only that the line-ending, binary and leading-BOM text move from Encoding considerations to Interoperability considerations; it does not raise application/ again.",
  "kind": "finding"
 },
 {
  "text": "RFC 6838 sets no deadline for the media types reviewer; a stalled request is chased through the IANA ticket (iana@iana.org), and a reviewer decision can be appealed to the IESG (section 5.3).",
  "kind": "finding"
 },
 {
  "text": "The IANA reviewer suggested application/vnd.geml; the user wants to keep text/vnd.geml and replied with reasons, and the reviewer has not answered since.",
  "kind": "choice"
 },
 {
  "text": "The prompt that opens a turn is missing from gemflow's session record when gemflow finishes loading after that prompt was submitted: in session 2a5a1545 the prompt arrived 10:12:06, gemflow's tools appeared 10:12:25, and the record starts with that turn's answer at 10:12:44 with no prompt.",
  "kind": "finding"
 },
 {
  "text": "A folder named in CLAUDE_CODE_PLUGIN_DIRS (env block of ~/.claude/settings.json) is watched and hot-reloaded on save in every session; desktop-hosted sessions also need CLAUDE_CODE_PLUGIN_DIR_WATCH=1.",
  "kind": "finding"
 },
 {
  "text": "/reload-plugins only reloads the session it is typed in: each session is its own claude.exe holding its own copy of the plugin module, and an installed plugin (gemflow@geml-dev) is never watched.",
  "kind": "finding"
 },
 {
  "text": "The board shows nothing about a cut prompt.compose; the user chose no header line.",
  "kind": "choice"
 },
 {
  "text": "gemflow 0.2.38 probes once a session whether prompt.compose reaches the engine (bare-named sections present) and sends the sessions/ask instructions through the first prompt's context only when it does not.",
  "kind": "status"
 },
 {
  "text": "gemflow 0.2.37 is verified running: after /reload-plugins the next prompt's context carried the sessions and ask instructions under the Team/Enterprise account.",
  "kind": "status"
 },
 {
  "text": "feat/gemflow is pushed to origin at 42fc7546 (gemflow 0.2.36 and 0.2.37).",
  "kind": "status"
 },
 {
  "text": "gemflow 0.2.36 is committed on feat/gemflow as 17a59912; 0.2.37 is synced to the local marketplace but not committed.",
  "kind": "status"
 },
 {
  "text": "gemflow 0.2.37: the first prompt of a conversation carries the sessions and ask instructions in its context, again after /clear and after a compaction, never once prompt.compose has run in the session.",
  "kind": "status"
 },
 {
  "text": "Under the user's Team/Enterprise account the built-in plugin cc-plugin-sec-default@builtin keeps prompt.compose, so gemflow's system-prompt sections (sessions, ask) never reached the model; prompt.submit context does.",
  "kind": "finding"
 },
 {
  "text": "gemflow's prompt.submit context does reach the model under that account, so it is a channel the two instructions can move to.",
  "kind": "finding"
 },
 {
  "text": "Under the person's Team/Enterprise account the built-in cc-plugin-sec-default plugin is seated first on prompt.compose and does not pass it on, so gemflow's prompt.compose never runs there: the SESSIONS_PROMPT (note tool) and ASK_PROMPT (ask tool) sections never reach the model.",
  "kind": "finding"
 },
 {
  "text": "In the desktop Code tab a new session has no Claude Code process until its first message is sent (the worktree is created and named from that message, then claude.exe starts), so no plugin runs and the band cannot show before the first prompt; this is the host's behaviour, not a gemflow bug.",
  "kind": "finding"
 },
 {
  "text": "With this worktree's real bridge state, 0.2.36's band draws a valid tree on desktop and terminal (可合并：#32 · 合并 #32 · 看板), so a band missing on the desktop is on the host side, not in the module's tree.",
  "kind": "status"
 },
 {
  "text": "A session started fresh at 15:24 loads gemflow 0.2.36 from the folder: its prompt.submit hook and the six model tools are live there.",
  "kind": "status"
 },
 {
  "text": "When one step rides alone on the band, the band shows that step's own text instead of a bare 「待处理」.",
  "kind": "behaviour"
 },
 {
  "text": "From 0.2.36 the board header shows the running module's version; when the folder holds another version, a 「已同步 X」 label appears beside it and the band shows 「待重载：X（运行 Y）」.",
  "kind": "status"
 },
 {
  "text": "This session has run gemflow 0.2.32 since 13:21 (+08); 0.2.33–0.2.35 were synced to the folder but never loaded, so the tab fix was never in effect.",
  "kind": "status"
 },
 {
  "text": "Correction: gemflow's 产物 are called artifacts, never products — the table is .geml/artifacts.geml #artifacts, the copies are in .geml/artifacts/, and the model's tool is the gemflow artifact tool (the earlier note's products names are void).",
  "kind": "choice"
 },
 {
  "text": "tools.geml has one row per tool name, case-sensitive (Edit is Claude Code's, edit/write are pi's and DSH's); a second row for the same name is left out with a warning, never an error.",
  "kind": "choice"
 },
 {
  "text": "Pages published with the Artifact tool are recorded as links automatically; other links and generated pictures are recorded by the model with the gemflow product tool.",
  "kind": "choice"
 },
 {
  "text": "Products of each work item live in the main checkout's .geml/products.geml #products, one row per version; files git does not keep are copied by content hash into .geml/products/ (over 20 MB: only location and hash), GEML documents keep one copy with later versions in its .gemlhistory.",
  "kind": "choice"
 },
 {
  "text": "gemflow 不能误拦也不能让人卡住：工具调用结果最多等桥接 2 秒，连续两次没应答才在状态带提示，git 超时不再判成「没有提交」",
  "kind": "choice"
 },
 {
  "text": "不可逆的按钮都先弹确认：收尾、删词典行、合并 PR、推送、发 PR 评论、删会话轮次",
  "kind": "choice"
 },
 {
  "text": "写文件的工具（Edit、Write、NotebookEdit、apply_patch）之间不再问首选，用哪个都直接放行",
  "kind": "choice"
 },
 {
  "text": "工作项的结局从 git 判定（在做/已合并/已收尾/放下），记在主检出 .geml/project.geml 的 #items 表，只重写这张表",
  "kind": "choice"
 },
 {
  "text": "会话记录统一用 GEML 格式",
  "kind": "choice"
 }
];

test("35 real records: 12 status and 1 plan refused; 12 choices, 9 findings and 1 behaviour sentence pass", () => {
  const refused = LINES.filter((l) => isStatusLine(l.text));
  const passed = LINES.filter((l) => !isStatusLine(l.text));
  assert.deepEqual(refused.filter((l) => l.kind === "choice" || l.kind === "finding" || l.kind === "behaviour").map((l) => l.text.slice(0, 60)), [], "no choice or finding refused");
  assert.deepEqual(passed.filter((l) => l.kind === "status" || l.kind === "plan").map((l) => l.text.slice(0, 60)), [], "no status or plan let through");
  assert.equal(refused.length, 13);
  assert.equal(passed.length, 22);
});
