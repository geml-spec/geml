// What this version brings, in a few lines for the upgrade dialog. Each line
// is a key of the words table, so it follows the person's language. Pure.

/** The version the notes are for, and its lines. */
export const RELEASE_NOTES: { version: string; lines: readonly string[] } = {
  version: "0.2.1",
  lines: [
    "状态带只放该你做的一件事和它的选项",
    "看板五个页签：会话、流程、工作项、记录、工具；待处理在工作项最上面",
    "事项流程：记下 → 待你定 → 实施 → 待验收 → 完成",
    "记录里看产物、凭据、阶段变更，每条说是哪一轮引起的",
    "工具页记下真实用过的次数，点一行就能归类",
    "不再问「这个命令能不能用」，安全交给 Claude Code 的权限",
  ],
};

/** Whether `candidate` is a later version than `current`: major, minor, patch, each by number (a pre-release tag is not weighed). */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string): number[] => v.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}
