// geml-style profile 的诊断目录（设计 §7）。
//
// 这些码属于 profile，不进 GEML 规范的 Appendix A —— profile 不是规范。
// 严重性哲学：结构性错误 = error（歧义、悬空引用），未知名字 = warning + 惰性回退，
// 以保住 §8.5 的前向兼容机制（一个处理器不认识的名字必须降级，不能拒收文档）。
//
// 目录里没有 `binding-cycle`：数据流被限死成 interaction → state → view，
// 状态永不读状态，因此没有图，也就没有环可成（设计 §5.1）。
// `frame-cycle` 抓的是另一张图 —— style-frame 的包含关系（设计 §12.4）——
// 区域装区域可以成环，那张图有环检测；状态管道这一条依然成立。

export type StyleDiagnosticCode =
  | "selector-unsupported"
  | "ambiguous-rule"
  | "unmatched-rule"
  | "unknown-state"
  | "unknown-screen"
  | "unmatched-producer"
  | "unknown-value-source"
  | "unknown-interaction"
  | "unknown-token"
  | "reserved-name"
  | "unknown-component"
  | "unknown-handler"
  | "style-missing-attribute"
  | "style-unknown-attribute"
  | "style-embed-not-expanded"
  | "unknown-frame"
  | "screen-nested"
  | "frame-cycle"
  | "frame-too-deep"
  | "unused-frame"
  | "style-invalid-value";

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
  // `{{key}}` 指到本样式表 meta 里没有的键。和核心 §4 的 unknown-metadata-reference
  // 同一判断：单一事实来源的引用悬空了就该响，静默代换成空串会让整页悄悄掉色。
  "unknown-token": "error",
  // 一个名字同时是部件名和块类型名。不拒绝、照块类型匹配，只把另一种读法说出来 ——
  // 硬错误会让一个类型叫 `link` 的块用类型名根本选不到，而选择器该尽量命中。
  "reserved-name": "warning",
  "style-missing-attribute": "error",
  "unmatched-rule": "warning",
  "unmatched-producer": "warning",
  "unknown-component": "warning",
  "unknown-handler": "warning",
  "style-unknown-attribute": "warning",
  // `embed` 是这个语言的 include，所以把默认层拉进一份样式表是它自然的写法 ——
  // 而装载器不展开它，被拉进来的规则一条都不生效。这是 warning 而不是 error，
  // 因为它和 `style-unknown-attribute` 同一性质：我们忽略了作者写下的东西，
  // 该说出来。沉默才是这里最坏的结果 —— 一份看起来组合好了的样式表，实际只有
  // 本文件里的那几条规则，页面少一大块而没有人吭声。
  "style-embed-not-expanded": "warning",
  // 槽位里裸 `#x` 是本样式表的 frame 引用（设计 §12.4）。悬空、指到页、成环都是
  // 结构性错误，和 unknown-screen / unknown-state 同级。
  "unknown-frame": "error",
  "screen-nested": "error",
  "frame-cycle": "error",
  // 嵌套有上限，这是安全边界：样式表是不可信输入（§9），一万个 frame 串成的链没有环，
  // 却不能让宿主渲染一万层盒子。和 embed 的深度上限同一个理由。
  "frame-too-deep": "error",
  // 声明了没人引用：我们忽略了作者写下的东西，该说出来 —— 和 unmatched-rule 同性质。
  "unused-frame": "warning",
  // 内含词里值域封闭的几个取了域外值，与 unknown-interaction 同一哲学：封闭词汇的
  // 非法成员是错误，不是"未知名字降级"。
  "style-invalid-value": "error",
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
