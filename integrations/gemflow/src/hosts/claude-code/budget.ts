/**
 * The desktop draws and presses a pane of some 1,500 elements and none past
 * it: the person's test pages on 2026-10-23 drew 1,476 elements fine and
 * 1,676 not, however few of them were buttons (800 plain buttons drew fine).
 * The board keeps its body under BODY_NODES and says what it left out.
 */

/** The most elements the board's body draws on a surface that draws pictures. */
export const BODY_NODES = 1_100;

/** The elements in a drawn tree: each element and those under it; strings, numbers and nothing are not elements. */
export function elementsIn(node: unknown): number {
  if (node === null || typeof node !== "object") return 0;
  if (Array.isArray(node)) return node.reduce((n: number, x: unknown) => n + elementsIn(x), 0);
  const el = node as { children?: unknown; props?: { children?: unknown } };
  return 1 + elementsIn(el.children ?? el.props?.children ?? []);
}

/** The leading items whose elements fit in `budget`, how many were left out, and the elements drawn. */
export function fitToBudget<T>(items: readonly T[], budget: number = BODY_NODES): { kept: T[]; left: number; drawn: number } {
  let drawn = 0;
  for (let k = 0; k < items.length; k++) {
    const n = elementsIn(items[k]);
    if (drawn + n > budget) return { kept: items.slice(0, k), left: items.length - k, drawn };
    drawn += n;
  }
  return { kept: [...items], left: 0, drawn };
}
