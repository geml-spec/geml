// geml-media profile 的诊断目录（spec/profiles/geml-media/geml-media-profile.md §7）。
//
// 这些码属于 profile，不进 GEML 规范的 Appendix A —— profile 不是规范，而 Appendix A
// 的码与严重性是规范性的，§8.6.1 明写词汇表不得改动它。geml-style 已经走过同一条路
// （style-diagnostics.ts），这里照它的形状。
//
// 与 style 的两处不同：
//
//   · 多一级 `info`。核心 Diagnostic 只有 error/warning，因为规范里没有第三级；
//     profile 自己的目录可以有，而 media 确实需要 —— "这份素材现在的字节来历不明"
//     是值得说出来的观察，不是缺陷。
//   · 按**地址**报，不按行号。核心诊断带 line，因为它在解析一份文档时知道行；media 的
//     检查天然跨文档（一个片段在 cut 里、它的素材在 library 里、产它的记录在第三份
//     文件里），没有单一的行号可言。所以每条诊断带 {doc, id}，和这个项目"id 优于行号"
//     的立场一致 —— 要行号，`geml list <doc>` 给得出来。
//
// v1 只收第一个真实用例真正会撞到的码。编导口味的几条
// （runtime-off-target、emotion-drift、look-outdated…）、模型卡与时间线形状的几条留在
// 设计记录里不实现：一条没人需要过的诊断，只是披着码的猜测。

export type MediaDiagnosticCode =
  | "media-src-unresolved"
  | "media-src-not-asset"
  | "media-file-missing"
  | "media-hash-mismatch"
  | "media-asset-unhashed"
  | "media-dur-required"
  | "media-track-missing"
  | "media-track-undeclared"
  | "media-track-kind-missing"
  | "media-track-kind-unknown"
  | "media-of-unresolved"
  | "media-speaker-unresolved"
  | "media-line-no-speaker"
  | "media-gen-schema"
  | "media-orphan-record"
  | "media-stale-generation"
  | "media-stale-clip";

export type MediaSeverity = "error" | "warning" | "info";

/**
 * 级别沿用核心的规矩：**结构坏了是 error，事实过期是 warning，选择是 info**。
 * 过期必须是 warning 而不是 error —— 否则改一次角色卡整条流水线红掉，人就会学着
 * 忽略它，而它恰恰是这份 profile 最值钱的一条。
 */
export const MEDIA_SEVERITY: Record<MediaDiagnosticCode, MediaSeverity> = {
  // 结构：引用断了、类型对不上、必填的没填
  "media-src-unresolved": "error",
  "media-src-not-asset": "error",
  "media-dur-required": "error",
  "media-track-missing": "error",
  "media-track-kind-missing": "error",
  "media-track-kind-unknown": "error",
  "media-of-unresolved": "error",
  "media-speaker-unresolved": "error",
  "media-line-no-speaker": "error",
  "media-gen-schema": "error",
  // 文件在、内容却不是它说的那个 —— 比没有更糟，那是错的文件。
  "media-hash-mismatch": "error",
  // 描述别处素材的库照样合法，只是未校验。
  "media-file-missing": "warning",
  // 没有哈希不是错，但这份素材的血缘从此不可校验，该说出来。
  "media-asset-unhashed": "warning",
  "media-track-undeclared": "warning",
  // 事实过期
  "media-stale-generation": "warning",
  "media-stale-clip": "warning",
  // 观察：现在这份字节没有任何记录认领
  "media-orphan-record": "info",
};

export interface MediaDiagnostic {
  severity: MediaSeverity;
  code: MediaDiagnosticCode;
  message: string;
  /** 出问题的文档，相对根目录 */
  doc: string;
  /** 出问题的块。整份文档层面的问题（如 meta.tracks）没有 id */
  id?: string;
}

export function mediaDiag(code: MediaDiagnosticCode, message: string, doc: string, id?: string): MediaDiagnostic {
  const d: MediaDiagnostic = { severity: MEDIA_SEVERITY[code], code, message, doc };
  if (id !== undefined) d.id = id;
  return d;
}
