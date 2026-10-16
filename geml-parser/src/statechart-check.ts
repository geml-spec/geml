// geml-statechart/v1 的检查器（profile §3）。
//
// 与 media-check 同一形状：按**地址**报（文档 + 块 id），不按行号；不 import
// node:*，文件经 ProfileIO 读。它找出文档里每个 `format=geml-statechart` 的
// `diagram` 块，替它解析 `data=` 与通行要求里的 `#id` / `doc.geml#id` 引用
// （本文档的，或别的文档里的 `data` 块），再交给 buildStatechart。渲染器和其他
// 读状态图的程序走同一个入口（statechartsOf），所以各处读到的是同一个模型。
import { parse, type Block, type Document } from "./geml.js";
import { type ProfileDiagnostic, type ProfileIO } from "./profiles.js";
import { buildStatechart, type JsonValue, type StatechartResult } from "./statechart.js";

type B = Extract<Block, { kind: "block" }>;

/** 一份文档里的全部块，含嵌套的，按文档顺序。 */
export function blocksOf(doc: Document): B[] {
  const out: B[] = [];
  const walk = (bs: Block[]): void => {
    for (const b of bs) if (b.kind === "block") { out.push(b); if (b.children) walk(b.children); }
  };
  walk(doc.children);
  return out;
}

const dirOf = (rel: string): string => { const i = rel.lastIndexOf("/"); return i < 0 ? "" : rel.slice(0, i); };
const joinRel = (base: string, rel: string): string => {
  const out: string[] = base === "" ? [] : base.split("/").filter((x) => x !== "");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop(); else out.push(seg);
  }
  return out.join("/");
};

export interface StatechartBlock { block: B; result: StatechartResult }

/**
 * 文档里每个 `geml-statechart` 块的模型与诊断。`read` 读别的文档（相对根目录），
 * 读不到返回 null；渲染只有本文档时传 `() => null`，跨文档的引用就报解析不到。
 */
export function statechartsOf(doc: Document, entry: string, read: (rel: string) => string | null): StatechartBlock[] {
  const docs = new Map<string, Document | null>([[entry, doc]]);
  const load = (rel: string): Document | null => {
    if (docs.has(rel)) return docs.get(rel) ?? null;
    const src = read(rel);
    // 每份文档按它自己的 `=== meta` 解析（§8.6.2 规则 2）。
    const d = src === null ? null : parse(src);
    docs.set(rel, d);
    return d;
  };
  /** `#id` 或 `doc.geml#id` 指向的 `data` 块的值；不是 `data` 块、没有值或找不到都是 undefined。 */
  const valueOf = (ref: string): JsonValue | undefined => {
    const hash = ref.indexOf("#");
    if (hash < 0 || hash === ref.length - 1) return undefined;
    const docPart = ref.slice(0, hash);
    const id = ref.slice(hash + 1);
    const target = docPart === "" ? doc : load(joinRel(dirOf(entry), docPart));
    if (target === null) return undefined;
    const b = blocksOf(target).find((x) => x.id === id);
    return b === undefined || b.type !== "data" ? undefined : (b.value as JsonValue | undefined);
  };

  const out: StatechartBlock[] = [];
  for (const b of blocksOf(doc)) {
    if (b.type !== "diagram" || b.attrs["format"] !== "geml-statechart") continue;
    const input: Parameters<typeof buildStatechart>[0] = { body: (b.raw ?? []).join("\n"), attrs: b.attrs, resolveRef: valueOf };
    const data = b.attrs["data"];
    if (data !== undefined) input.dataValue = valueOf(String(data)) ?? null;
    out.push({ block: b, result: buildStatechart(input) });
  }
  return out;
}

export function checkStatechart(entry: string, io: ProfileIO): ProfileDiagnostic[] {
  const src = io.readDoc(entry);
  if (src === null) return [];
  const out: ProfileDiagnostic[] = [];
  for (const { block, result } of statechartsOf(parse(src), entry, (rel) => io.readDoc(rel))) {
    for (const d of result.diagnostics) {
      const p: ProfileDiagnostic = { severity: d.severity, code: d.code, message: d.message, doc: entry };
      if (block.id !== undefined) p.id = block.id;
      out.push(p);
    }
  }
  return out;
}
