// `/gemflow` (spec §8.3): parsing its argument string and wording its answers.
// Pure and Node-free: the hooks module runs the intent through the bridge.
// The words follow the language chosen (text.ts); the Chinese constants are
// what the tests pin.
import type { BoardTab } from "./actions.js";
import type { BridgeResponse, ShellStatus } from "./protocol.js";
import { nextText, SEP, varSegment } from "./band.js";
import { ZH, type T } from "./text.js";

export type CommandIntent =
  | { kind: "status" }
  | { kind: "board"; tab?: BoardTab }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "use"; workflow: string }
  | { kind: "add"; workflow?: string }
  | { kind: "help"; reason?: string };

export const COMMAND_HINT = "[board [标签] | pause | resume | use <流程> | add [流程]]";

/** The usage, in the language chosen. */
export function usageText(t: T = ZH): string {
  return [
    `/gemflow                 ${t("当前工作项、阶段、变量与下一步")}`,
    `/gemflow board [标签]    ${t("打开流程看板（sessions | flow | items | journal | tools）")}`,
    `/gemflow pause           ${t("暂停当前工作项：证据照记，什么都不推进")}`,
    `/gemflow resume          ${t("继续")}`,
    `/gemflow use <流程>      ${t("设定新工作项的默认流程（已开始的工作项沿用自己的）")}`,
    `/gemflow add [流程]      ${t("列出内置流程；带名字时写入 .geml/workflows/")}`,
  ].join("\n");
}

export const COMMAND_USAGE = usageText(ZH);

const TAB_WORDS: Readonly<Record<string, BoardTab>> = { sessions: "sessions", flow: "flow", items: "items", journal: "journal", tools: "tools" };

export function parseCommand(args: string): CommandIntent {
  const words = args.trim().split(/\s+/).filter((w) => w.length > 0);
  const [head, ...rest] = words;
  if (head === undefined) return { kind: "status" };
  if (head === "help" && rest.length === 0) return { kind: "help" };
  if (head === "board" && rest.length === 0) return { kind: "board" };
  if (head === "board" && rest.length === 1 && TAB_WORDS[rest[0]!] !== undefined) return { kind: "board", tab: TAB_WORDS[rest[0]!] };
  if (head === "pause" && rest.length === 0) return { kind: "pause" };
  if (head === "resume" && rest.length === 0) return { kind: "resume" };
  if (head === "use" && rest.length === 1) return { kind: "use", workflow: rest[0]! };
  if (head === "add" && rest.length <= 1) return rest.length === 1 ? { kind: "add", workflow: rest[0]! } : { kind: "add" };
  return { kind: "help", reason: `不认识的用法：/gemflow ${args.trim()}` };
}

/** Why there is no status, in a line: the quiet case points at /gemflow add. */
export function noStatusText(shell: ShellStatus, t: T = ZH): string {
  if (shell.problem?.quiet === true) {
    const s = shell.suggest;
    return s !== undefined
      ? t("这个项目还没有流程。建议 {0}（{1}）：/gemflow add {0}；/gemflow add 列出全部。", s.workflow, s.file ?? t("默认"))
      : t("这个项目还没有流程。用 /gemflow add 选一个内置流程。");
  }
  return `gemflow：${shell.problem?.text ?? t("没有状态")}`;
}

export function statusText(shell: ShellStatus, t: T = ZH): string {
  const s = shell.status;
  if (s === null) return noStatusText(shell, t);
  const head = `${t("流程 {0}（{1}）", s.workflow.name, s.workflow.title)}${s.workflow.default !== undefined ? `· ${t("默认流程 {0}", s.workflow.default)}` : ""}`;
  if (s.item.kind === "inactive") return `${head}\n${s.item.reason}`;
  const vars = Object.keys(s.vars).map((name) => {
    const seg = varSegment(name, s.vars[name]);
    const src = s.sources[name];
    return src !== undefined ? `${seg.text}（${src}）` : seg.text;
  });
  const state = s.state;
  const lines = [
    head,
    `${t("工作项 {0} · 阶段 #{1}", s.item.id, state?.id ?? "?")}${state !== undefined && state.title !== state.id ? ` ${state.title}` : ""} · rev ${state?.rev ?? 0}${s.paused ? ` · ${t("已暂停")}` : ""}`,
    t("工具：{0}", state?.uses.length ? state.uses.join(" ") : t("没有声明用途")),
    t("变量：{0}", vars.length > 0 ? vars.join(SEP) : t("无")),
    t("下一步：{0}", s.next.length > 0 ? s.next.map((x) => nextText(x, t)).join(t("；")) : t("无（终点）")),
  ];
  if (s.gh !== undefined && !s.gh.available) lines.push(t("git 证据不可用：{0}", s.gh.reason));
  lines.push(t("{0} 次拒绝", s.refusals));
  return lines.join("\n");
}

export function addText(res: Extract<BridgeResponse, { ok: true }>, t: T = ZH): string {
  if (res.added !== undefined) {
    const { name, activated } = res.added;
    return activated
      ? t("已把内置流程 {0} 写入 .geml/workflows/{0}.geml，并设为当前流程。", name)
      : t("已把内置流程 {0} 写入 .geml/workflows/{0}.geml。用 /gemflow use {0} 让它成为当前流程。", name);
  }
  const installed = new Set(res.installed ?? []);
  const list = (res.workflows ?? []).map((n) => (installed.has(n) ? t("{0}（已在本项目）", n) : n));
  return `${t("内置流程：{0}", list.length > 0 ? list.join("、") : t("无"))}\n${t("用 /gemflow add <流程> 把一个写入 .geml/workflows/。")}`;
}

/** What `/gemflow board` says: opened, opened but waiting for room, or why the board could not be read (then nothing opens). */
export function boardText(waitReason: string | undefined, failure?: string, t: T = ZH): string {
  if (failure !== undefined) return t("看板打不开：{0}", failure.replace(/^gemflow：/, ""));
  return waitReason === undefined ? t("已打开 Gemflow 看板。") : t("看板已打开，终端够宽时显示（{0}）。", waitReason);
}

/** Why a `board` request brought no board — no answer, an error answer, no workflow or a broken one — or undefined when it did. */
export function boardFailure(res: BridgeResponse | undefined, problem: string | null, t: T = ZH): string | undefined {
  if (res === undefined) return problem ?? `gemflow：${t("桥接不可用")}`;
  if (!res.ok) return `gemflow：${res.error.replace(/^gemflow: /, "")}`;
  if (res.board !== undefined) return undefined;
  return noStatusText(res.shell, t);
}

export function commandText(intent: CommandIntent, res: BridgeResponse | undefined, problem: string | null, t: T = ZH): string {
  if (intent.kind === "help") return intent.reason !== undefined ? `${intent.reason}\n${usageText(t)}` : usageText(t);
  if (res === undefined) return problem ?? `gemflow：${t("桥接不可用")}`;
  if (!res.ok) return `gemflow：${res.error}`;
  if (intent.kind === "pause") return `${t("已暂停。")}\n${statusText(res.shell, t)}`;
  if (intent.kind === "resume") return `${res.entered?.length ? t("已继续 · 进了 {0}", res.entered.map((s) => `#${s}`).join(" → ")) : t("已继续。")}\n${statusText(res.shell, t)}`;
  if (intent.kind === "use") return `${t("默认流程：{0}", intent.workflow)}\n${statusText(res.shell, t)}`;
  if (intent.kind === "add") return addText(res, t);
  return statusText(res.shell, t);
}
