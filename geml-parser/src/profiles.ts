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
// 范围（GEP-0013 之后）：profile 放行名字，**并且**为它放行的类型声明 body 模式。
// 不认识这份词汇表的处理器把那些正文一律当 raw，并报出 `unrecognized-vocabulary`
// —— 规则 4 之所以能给这个例外，靠的就是规则 3 要求把这件事说出来。没声明 body
// 的类型照旧 raw。

import { MEDIA_SEVERITY } from "./media-diagnostics.js";
import { STYLE_SEVERITY } from "./style-diagnostics.js";

/**
 * 一份 profile 在本项目里的成熟度（spec/profiles/README.md「Status」）。
 *
 * 这不是规范的事：§8.6.2 规则 3 明写「处理器认识哪些词汇表由实现自定」，规范
 * 因此管不着一份词汇表有没有状态。它是**仓约定**——而自从 GEP-0013 让词汇表
 * 可以声明 body 模式，它就从整洁变成了承重：加一个名字是小改动，改一个 body
 * 模式会改变所有认识这个名字的人的解析结果。
 *
 * · `draft`    同一个 `/vN` 下还会改，包括改 body 模式。别拿它当稳定接口。
 * · `stable`   同一个 `/vN` 下只增不改：可以加名字，不得改动或移除任何已有名字
 *              的含义。要改就换 `/vN+1`。
 * · `deprecated` 不再加东西，留着是为了已经写好的文档还能读。
 */
export type ProfileState = "draft" | "stable" | "deprecated";

/** 一份 profile 的检查器：吃一个入口（相对根目录）与一份 IO，吐它自己的诊断。 */
export type ProfileCheck = (entry: string, io: ProfileIO) => ProfileDiagnostic[];

/**
 * 一份 profile 自己的检查器报出的一条诊断。
 *
 * **不是**核心的 `Diagnostic`，而且不该是。核心那条报的是**位置**（归一化字符流
 * 里的行号，附录 A 的原话），因为核心的检查全部发生在一份文档之内。profile 的
 * 检查跨文档——「这个片段的 src 指的素材在另一份文件里，而那个文件的哈希对不上」
 * ——它没有单一行号可言，它有的是**地址**。把它塞进核心那个形状，只能给每条塞一个
 * 假的 0 行，那比两个类型更糟。
 *
 * 级别多一档 `info`：结构坏了是 error，事实过期是 warning，**选择**是 info。核心
 * 用不上第三档（附录 A 只有 error 和 warning，而且那是规范性的），profile 用得上。
 */
export interface ProfileDiagnostic {
  severity: "error" | "warning" | "info";
  /** 这份词汇表自己的码，带它的前缀（README「Naming」）。 */
  code: string;
  message: string;
  /** 出问题的文档，相对检查根目录。 */
  doc: string;
  /** 出问题的块；整份文档层面的问题（如 `meta.tracks`）没有 id。 */
  id?: string;
  /** 检查器知道行号时给出；跨文档的多数情况没有。 */
  line?: number;
}

/** 一份 profile 的检查器读盘的方式。核心不替它决定文件从哪来。 */
export interface ProfileIO {
  /** 读一份文档（相对根目录）。越界或不存在返回 null。 */
  readDoc(rel: string): string | null;
  /** 一个文件的 SHA-256（十六进制全长）。不存在返回 null。 */
  hashFile(rel: string): string | null;
  /** 一段文本的 SHA-256（UTF-8，十六进制全长）。 */
  hashText(text: string): string;
}

/** 一个 profile 放行的词汇。 */
export interface ProfileDef {
  /** 成熟度。必填 —— 一份没写状态的 profile，读的人无从判断能不能依赖它。 */
  state: ProfileState;
  /** 注册它的解析器版本，供 CHANGELOG 与索引表对照。 */
  since?: string;
  /**
   * 这份词汇表在 `=== meta` 里用的键。**核心不校验 meta 键**（没有
   * `unknown-meta-key` 这种诊断），所以登记它们不是为了执行，是为了让命名规则
   * 测得着、让索引表有东西可对。
   */
  metaKeys?: string[];
  /**
   * 这份词汇表自己的诊断码，连同**默认级别**。
   *
   * 一张表而不是一串名字，买到三样东西：命名规则测得着（码是撞得最狠的一类名字，
   * 因为读的人拿它去 grep、去配 CI 门禁）；`--severity <code>=<level>` 对任意码
   * 成立，不必每条重要的诊断各长一个专用 flag；第二实现要复刻的是这张表——可抄、
   * 可 diff、可断言，而不是去参考实现里挖字符串。
   */
  diagnostics?: Record<string, ProfileDiagnostic["severity"]>;
  // 检查**函数**不在这里，而在 CLI 侧的注册表（cli.ts `PROFILE_CHECKS`）。
  // 理由是打包：这个模块被 geml.ts 引，而 geml.ts 是浏览器包的入口。把
  // checkMedia 拉进来，就把它的文件 IO 一路拖进扩展的构建——CLAUDE.md 点名过
  // 这条，viewer 的 esbuild 在任何一个缺失的具名导出上整包失败。
  // 声明的那一半（`diagnostics` 码表）留在这里，它是纯数据。
  /** 额外放行的块类型名 */
  types?: string[];
  /** 逐块类型额外放行的属性键 */
  attrs?: Record<string, string[]>;
  /** 这些类型的体怎么解析（默认 raw）。`flow` = 体里还能有块。 */
  bodies?: Record<string, "raw" | "flow" | "data" | "prose">;
  /**
   * **散文类型**：这些类型和核心 `text` 一样装散文，因此拿到核心今天只给 `text`
   * 的那几项待遇 —— 可以做 `![[…]]` 的目标、`--to md` 投成段落而不是引用块、
   * `--to html` 渲成同一种容器。**蕴含 `bodies: prose`**（GEP-0013），不必声明两遍。
   *
   * 与 `bodies: flow` 不是一回事，而这正是 GEP-0013 的分界：`form`/`form-group` 是 flow 的
   * **容器**（体里装带 id 的块，放行它们会让地址集随词汇表变化，规则 4 正为此存在）。它们不该
   * 能被行内投射、也不该渲染成一段话。所以两个轴分开声明，谁也顶替不了谁。
   */
  prose?: string[];
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
    state: "stable", since: "1.9.0",
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
    state: "draft", since: "1.10.0",
    attrs: { embed: ["translate-to"] },
  },
  // spec/profiles/geml-style/geml-style-profile.md
  "geml-style/v1": {
    state: "draft", since: "1.9.0",
    // 八个码里七个不带 `style-` 前缀，违反本层的命名约定（README「Naming」）。
    // 引用检查器自己的那张表而不是抄一遍——同一份事实抄两处，上游一动就漂。
    diagnostics: STYLE_SEVERITY,
    types: ["style-rule", "style-state", "style-screen", "style-frame"],
  },
  // spec/profiles/geml-form/geml-form-profile.md — GEP 0008 (draft).
  // The form-* family itself is the specification's (a body mode and an id scope
  // need §3's registry); the CONSTRAINTS on a field need neither, so they ride
  // here as attribute keys: declared, stored, never evaluated (§9.1). Until
  // form-field is a registered type these keys have nothing to attach to, and
  // admitting them is inert.
  "geml-form/v1": {
    state: "draft", since: "1.10.0",
    // 类型进来了：在 GEP-0008 落到 §3 的核心注册表之前，声明了这个 profile 的文档就能用
    // form-* 家族 —— 和 geml-style 用同一条路。不声明的文档照旧 unknown-block-type。
    types: ["form", "form-field", "form-group", "form-options", "form-note"],
    // form 和 form-group 是容器：`==== form` 里套 form-field（GEP-0008 §6）。
    bodies: { form: "flow", "form-group": "flow" },
    // 这几张表现在**会被执行**（属性检查按类型 opt-in）。所以它们必须完整，否则
    // GEP-0008 自己的例子会逐键报未知。键的归属是分开的，写在这里只是因为类型还
    // 住在 profile 里：
    //   · 六个约束键（pattern/min/max/step/maxlength/accept）是**这份 profile 的**；
    //   · 其余是 **GEP-0008 的**（label/description/placeholder/type/required/
    //     multiple/value/options，form 的 handler，form-options 的表体键）。
    // GEP-0008 一旦落进 §3，后者应当搬到核心的类型表里，这里只留前六个。
    attrs: {
      "form-field": [
        "pattern", "min", "max", "step", "maxlength", "accept",
        "label", "description", "placeholder", "type", "required", "multiple", "value", "options",
      ],
      form: ["handler"],
      "form-group": ["label", "description", "required"],
      // 体是一张 value/label 表（GEP-0008 §6），所以收表体那几个键。此前这几个键
      // 写在核心的 validRe 分支里，而那条分支永远走不到 —— form-options 不在核心
      // REGISTRY 里，profile 类型在它之前就 return 了。
      "form-options": ["format", "delim", "header", "src"],
    },
  },
  // spec/profiles/geml-media/geml-media-profile.md —— 素材、剪辑与生成血缘。
  //
  // 三个类型，不是两个：`media-text` 是剧本层的散文块（外貌、提示词、台词），
  // 它就是「`text` 加五个键」。为什么不直接在核心 `text` 上放行那五个键：那样键
  // 跟着**文档**走，声明了 profile 的文档里每个 `text` 块都合法；挂在自己的类型上
  // 则跟着**类型**走。代价是核心把 `text` 当特权类型的那几处要认得它 —— 所以有
  // `prose`，没有它 `![[#hero-look]]` 这样的投射会直接报
  // inline-transclusion-not-inline，而那是这份 profile 最核心的机制。
  //
  // 属性表是**闭集**（登记了 attrs 就会被查拼写）。这三个类型的键全部来自设计稿
  // §5，按第一个真实用例跑过一遍。
  "geml-media/v1": {
    state: "draft", since: "1.10.3",
    // 六个 meta 键都不带 `media-` 前缀，违反命名约定；`fps` 和 `aspect` 尤其是
    // 第二份 profile 会想要的通用词。登记以让测试拦得住新增的同类。
    metaKeys: ["tracks", "primary", "fps", "aspect", "target-duration", "episode"],
    diagnostics: MEDIA_SEVERITY,
    types: ["media", "media-asset", "media-clip", "media-text"],
    prose: ["media-text"],
    // `media` 是容器：`==== media` 里套 `media-clip`。无体的 `media` 是一个可播的单源。
    bodies: { media: "flow" },
    attrs: {
      // §5.0 一段可播的东西，两种形态由**形状**分，不由属性分 —— 和 `<video>` 一样：
      // `<video src>` 是单源，`<video><source></video>` 是它的孩子说了算。
      //   **有体**＝装配：`tracks` `primary` `fps` 三个键，片段住在体里。
      //   **无体 + src=**＝单源：`src` `in` `out` `duration`，它就是「只有一个片段的
      //   时间线」，下游一条代码都不用分叉。
      // 两组互斥，`check` 会管。画面比例不在这儿（那是呈现，归样式表），种类也不在
      // （从被引的 `media-asset` 读，同一件事不写两遍）。
      media: ["tracks", "primary", "fps", "src", "in", "out", "duration"],
      // §5.1 一个文件。`of` 说这份素材画的是谁，`role` 说它在生成里当什么用 ——
      // 没有这两个，「林夏的三视图是哪张」只能靠文件名猜。
      "media-asset": ["src", "sha256", "kind", "duration", "fps", "size",
        "origin", "license", "mime", "of", "role"],
      // §5.2 一个片段。`track` 必填，轨道的种类由所属 `media` 的 `tracks=` 给出。
      "media-clip": ["track", "src", "in", "out", "duration", "over", "offset", "at",
        "transition-in", "transition-out", "transition-duration",
        "gain", "fade-in", "fade-out", "speed", "xywh"],
      // §5.4 剧本层。`speaker` 必填；`shot` 把提示词钉到分镜表的镜号上。
      "media-text": ["shot", "speaker", "to", "emotion", "since"],
    },
  },
  // spec/profiles/geml-history/geml-history-profile.md
  // （语义是规范性的，在 spec/profiles/geml-history/geml-history-profile.md）—— `.gemlhistory` 边车自己的词汇表。它是一份
  // 姊妹**规范**的产物，不是第三方扩展，但同样必须声明：核心注册表只认 §3 的
  // 九个类型，所以在此之前这个项目写出的每一个 .gemlhistory 都固定吃三条
  // unknown-block-type（全库 333 处）。属性键取自规范的块定义，并与语料逐一核对。
  "geml-history/v1": {
    state: "stable", since: "1.9.0",
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
  /**
   * 这个 profile 的类型各自的体怎么解析（`flow` = 里面还能有块）。默认 `raw`。
   * 名字只影响诊断，体模式影响**解析结果** —— 所以它必须写出来，不能靠猜。
   */
  bodies: Map<string, "raw" | "flow" | "data" | "prose">;
  /** 放行的 `diagram` format 名（§8.6.1） */
  formats: Set<string>;
  /** 散文类型：和核心 `text` 同待遇（见 ProfileDef.prose） */
  prose: Set<string>;
}

/**
 * 一份文档的 meta 决定它放行哪些名字。多个 profile 取**并集** —— 校验只问
 * "这个名字允许吗"，不问"它是什么意思"，所以两个 profile 放行同一个键不是冲突，
 * 是同一个答案说了两遍（§8.6）。
 */
/**
 * 文档声明了、而本处理器不认识的词汇表名（§8.6.2 规则 3，GEP-0013）。
 *
 * 规则 3 从「当作不存在，不是错误也不是警告」改成了「什么也不放行，并且必须报出
 * 来」。报的不是文档的毛病——文档有效——而是**这个读者读不全它**：那些类型的正文
 * 会按 §8.2(6) 当 raw，那个词汇表本会让它们产生的可寻址单元在这里就是没有。规则 4
 * 之所以能放开 body 模式，靠的正是这句话被说出来。
 *
 * `Object.hasOwn` 而不是 `in`：`PROFILES` 是普通对象，`in` 会把 `toString` 这类
 * 原型键认成已注册的词汇表。
 */
export function unrecognizedVocabularies(meta: Map<string, string>): string[] {
  return (meta.get("profile") ?? "")
    .split(/\s+/)
    .filter((name) => name.length > 0 && !Object.hasOwn(PROFILES, name));
}

/**
 * 文档声明了、而且**本处理器认识**的词汇表名。`unrecognizedVocabularies` 的补集，
 * 供需要按 profile 做事的宿主用：跑哪几份词汇表的检查，由文档的 `=== meta` 说了算。
 */
export function declaredVocabularies(meta: Map<string, string>): string[] {
  return (meta.get("profile") ?? "")
    .split(/\s+/)
    .filter((name) => name.length > 0 && Object.hasOwn(PROFILES, name));
}

export function vocabularyFor(meta: Map<string, string>): Vocabulary {
  const declared = new Set((meta.get("profile") ?? "").split(/\s+/).filter((x) => x.length > 0));
  const types = new Set<string>();
  const attrs = new Map<string, Set<string>>();
  const formats = new Set<string>();
  const bodies = new Map<string, "raw" | "flow" | "data" | "prose">();
  const prose = new Set<string>();
  for (const [name, def] of Object.entries(PROFILES)) {
    if (!declared.has(name)) continue;
    for (const t of def.types ?? []) types.add(t);
    for (const f of def.formats ?? []) formats.add(f);
    for (const [t, m] of Object.entries(def.bodies ?? {})) bodies.set(t, m);
    // `prose` 蕴含 flow：散文要装段落。显式的 bodies 优先，所以把一个 prose 类型
    // 声明成 raw 是说得出口的 —— 那是自相矛盾，由注册表自己的测试挡，不在这里猜。
    for (const t of def.prose ?? []) { prose.add(t); if (!bodies.has(t)) bodies.set(t, "prose"); }
    for (const [type, keys] of Object.entries(def.attrs ?? {})) {
      let set = attrs.get(type);
      if (set === undefined) { set = new Set<string>(); attrs.set(type, set); }
      for (const k of keys) set.add(k);
    }
  }
  return { types, attrs, formats, bodies, prose };
}

/**
 * 空词汇表，给那些刻意不带 meta 的惰性上下文用（gatherEmbeds / gatherIds /
 * tableFromDocument：它们丢弃诊断，只要结构）。具名常量而不是就地 new，
 * 是为了让"这里确实什么都不放行"读起来像决定，而不像遗漏。
 */
export const EMPTY_VOCABULARY: Vocabulary = { types: new Set(), attrs: new Map(), formats: new Set(), bodies: new Map(), prose: new Set() };
