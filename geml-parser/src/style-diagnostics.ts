// geml-style profile 的诊断目录（设计 §7）。
//
// 这些码属于 profile，不进 GEML 规范的 Appendix A —— profile 不是规范。
// 严重性哲学：结构性错误 = error（歧义、悬空引用），未知名字 = warning + 惰性回退，
// 以保住 §8.5 的前向兼容机制（一个处理器不认识的名字必须降级，不能拒收文档）。
//
// 目录里没有 `binding-cycle`：数据流被限死成 interaction → state → view，
// 状态永不读状态，因此没有图，也就没有环可成（设计 §5.1）。

export type StyleDiagnosticCode =
  | "selector-unsupported"
  | "ambiguous-rule"
  | "unmatched-rule"
  | "unknown-state"
  | "unknown-screen"
  | "unmatched-producer"
  | "unknown-value-source"
  | "unknown-interaction"
  | "unknown-component"
  | "unknown-handler"
  | "style-missing-attribute"
  | "style-unknown-attribute";

export type StyleSeverity = "error" | "warning";

export const STYLE_SEVERITY: Record<StyleDiagnosticCode, StyleSeverity> = {
  "selector-unsupported": "error",
  "ambiguous-rule": "error",
  "unknown-state": "error",
  "unknown-screen": "error",
  "unknown-value-source": "error",
  // 封闭词汇的非法成员是**错误**，不是 warning —— 和核心 GEML 的
  // `chart-unknown-type` 同级。开放注册表（component/handler）的未知名字才降级。
  "unknown-interaction": "error",
  "style-missing-attribute": "error",
  "unmatched-rule": "warning",
  "unmatched-producer": "warning",
  "unknown-component": "warning",
  "unknown-handler": "warning",
  "style-unknown-attribute": "warning",
};

export interface StyleDiagnostic {
  severity: StyleSeverity;
  code: StyleDiagnosticCode;
  message: string;
  /** 出问题的样式表块 id，若能定位 */
  rule?: string;
}

export function styleDiag(code: StyleDiagnosticCode, message: string, rule?: string): StyleDiagnostic {
  const d: StyleDiagnostic = { severity: STYLE_SEVERITY[code], code, message };
  if (rule !== undefined) d.rule = rule;
  return d;
}
