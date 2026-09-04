// 应用层 profile 的词汇表注册表。机制本身是规范性的，见 GEML-spec §8.6
// 「Application-layer vocabularies」；这个文件只是本实现认识哪几份词汇表。
//
// 一份文档在 `=== meta` 里用 `profile = "<name> …"`（空格分隔的列表，
// 因为 §4 不支持数组）声明它使用哪些应用层词汇表。声明之后，那些块类型不再算
// `unknown-block-type`，那些属性键不再算 `unknown-attribute`。
//
// 这不改规范：§8.6 定义了机制，§8.5 明写 "The type registry (§3) is **open**"，§8.2(6) 约束的是
// 处理器*不认识*的类型必须降级。一个处理器通过 profile 认识了更多名字，完全合规。
//
// 为什么这个模块必须存在，而不是在 geml.ts 里多写几个 if：在它之前，codemap 的
// `anchor`/`name`/`entry-via` 硬编码在核心的属性校验表里，后果是这三个键在**任何
// 文档的任何 code 块**上都静默通过 —— 全世界每份 GEML 文档都永久让出了它们的
// 拼写检查，只为一个应用的清净。而且 §8.4 的一致性面被污染：第二实现要么复刻
// codemap 的词汇表，要么报出参考实现不报的 warning。
//
// 同样的理由排除了"旧产物兼容探测"（认 `resolution-default` 为隐式声明）：那是
// 同一类实现特定知识，第二实现照样得复刻它。旧图重新 build 一次即可。
//
// v1 的范围：profile 只放行**名字**，不改 **body 模式** —— 一个被放行的类型，
// body 仍按 §3 当 raw 处理。放宽它影响的是解析结果而不只是诊断，需要单独论证。

/** 一个 profile 放行的词汇。 */
export interface ProfileDef {
  /** 额外放行的块类型名 */
  types?: string[];
  /** 逐块类型额外放行的属性键 */
  attrs?: Record<string, string[]>;
  /**
   * 额外放行的 `diagram` format 名（§8.6.1）。只有 diagram 的 format 可以这样
   * 放行：它选的是渲染器，正文无论如何都是 raw，所以放行**不改变文档模型**。
   * `table` 和 `data` 的 format 不行 —— 它们决定正文怎么解析，直接生成
   * node.table / node.value，放行它们会违反 §8.6.2 第 4 条。
   */
  formats?: string[];
}

// 名字统一以 `geml-` 起头，好一眼认出这是本项目自己出的词汇表，而不是第三方的。
// 改名此刻是免费的：profile 机制落在 46eb5fd（2026-08-30），晚于 1.8.8 发布，
// 而 1.9.0 尚未 publish —— 没有任何已发布产物声明过旧名字。
export const PROFILES: Record<string, ProfileDef> = {
  // spec/profiles/geml-codemap/geml-codemap-profile.md
  "geml-codemap/v1": {
    attrs: { code: ["anchor", "name", "entry-via"] },
  },
  // spec/profiles/geml-translator/geml-translator-profile.md — GEP 0010.
  // A translated document is a projection: `=== embed` blocks carrying the axis
  // (`lang=`), a hint at who should do the work (`translator=`), and the blocks
  // held back from it (`except=`). §8.6.1 lists attribute keys among the three
  // things a vocabulary may admit, so this needs no specification change.
  //
  // `translate-to` and not `lang`: on `code`, `lang=` names a PROGRAMMING language
  // and is a statement about what the body is. Here it would name a natural
  // language and be an INSTRUCTION about what to do with it — two value spaces and
  // two word classes under one key. `translate-to=` is a verb and cannot be read
  // as either of the other two.
  //
  // `translate-to` is the whole vocabulary: on `=== meta` it is the document's
  // default and on an `embed` it overrides that, with `none` holding one back.
  // There is no key for WHICH ENGINE — there is one engine, so a key selecting
  // among engines would parse, do nothing, and read as supported. `translator=`
  // is reserved for when there is a second.
  //
  // There is no `except=`. An earlier draft had one — a list of ids to leave
  // alone inside a section embed — and the document default removed the need for
  // it: a mosaic of one embed per unit now costs almost nothing to write, so an
  // exception is `translate-to=none` on the one embed that means it. A second
  // spelling for the same intent would also have needed a core diagnostic, since
  // a typo in such a list draws only `unknown attribute` and never an unresolved
  // reference — silence, in a vocabulary whose purpose is to remove it.
  "geml-translator/v1": {
    attrs: { embed: ["translate-to"] },
  },
  // spec/profiles/geml-style/geml-style-profile.md
  "geml-style/v1": {
    types: ["style-rule", "style-state", "style-screen"],
  },
  // spec/profiles/geml-form/geml-form-profile.md — GEP 0008 (draft).
  // The form-* family itself is the specification's (a body mode and an id scope
  // need §3's registry); the CONSTRAINTS on a field need neither, so they ride
  // here as attribute keys: declared, stored, never evaluated (§9.1). Until
  // form-field is a registered type these keys have nothing to attach to, and
  // admitting them is inert.
  "geml-form/v1": {
    attrs: { "form-field": ["pattern", "min", "max", "step", "maxlength", "accept"] },
  },
  // spec/profiles/geml-history/geml-history-profile.md
  // （语义是规范性的，在 spec/profiles/geml-history/geml-history-profile.md）—— `.gemlhistory` 边车自己的词汇表。它是一份
  // 姊妹**规范**的产物，不是第三方扩展，但同样必须声明：核心注册表只认 §3 的
  // 九个类型，所以在此之前这个项目写出的每一个 .gemlhistory 都固定吃三条
  // unknown-block-type（全库 333 处）。属性键取自规范的块定义，并与语料逐一核对。
  "geml-history/v1": {
    // §8.5 asks an extension for hyphenated names, so these carry the profile's
    // own prefix the way `style-rule` carries geml-style's. The bare `revision`
    // / `keyframe` / `blob` they replace are not read: an unhyphenated name this
    // specification does not define squats space reserved for future versions of
    // it, and keeping a second spelling alive would have been the squatting.
    types: ["history-revision", "history-keyframe", "history-blob"],
    attrs: {
      "history-revision": ["id", "parent", "author", "summary", "hash", "newline"],
      "history-keyframe": ["id", "hash"],
      "history-blob": ["lang"],
    },
  },
};

export interface Vocabulary {
  types: Set<string>;
  attrs: Map<string, Set<string>>;
  /** 放行的 `diagram` format 名（§8.6.1） */
  formats: Set<string>;
}

/**
 * 一份文档的 meta 决定它放行哪些名字。多个 profile 取**并集** —— 校验只问
 * "这个名字允许吗"，不问"它是什么意思"，所以两个 profile 放行同一个键不是冲突，
 * 是同一个答案说了两遍（§8.6）。
 */
export function vocabularyFor(meta: Map<string, string>): Vocabulary {
  const declared = new Set((meta.get("profile") ?? "").split(/\s+/).filter((x) => x.length > 0));
  const types = new Set<string>();
  const attrs = new Map<string, Set<string>>();
  const formats = new Set<string>();
  for (const [name, def] of Object.entries(PROFILES)) {
    if (!declared.has(name)) continue;
    for (const t of def.types ?? []) types.add(t);
    for (const f of def.formats ?? []) formats.add(f);
    for (const [type, keys] of Object.entries(def.attrs ?? {})) {
      let set = attrs.get(type);
      if (set === undefined) { set = new Set<string>(); attrs.set(type, set); }
      for (const k of keys) set.add(k);
    }
  }
  return { types, attrs, formats };
}

/**
 * 空词汇表，给那些刻意不带 meta 的惰性上下文用（gatherEmbeds / gatherIds /
 * tableFromDocument：它们丢弃诊断，只要结构）。具名常量而不是就地 new，
 * 是为了让"这里确实什么都不放行"读起来像决定，而不像遗漏。
 */
export const EMPTY_VOCABULARY: Vocabulary = { types: new Set(), attrs: new Map(), formats: new Set() };
