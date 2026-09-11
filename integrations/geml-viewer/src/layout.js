// 视图模型（计划 E，profile §10）→ 一整页的 DOM 和它的 CSS。
//
// 形状：screens[0] 是页；frame 是页内区域，槽位里裸 #id 引用它；块槽位按 bindings 画。
// 内含词（box）变成每块一条 CSS 规则，挂在 `.geml-b-<id>` 上；`when=` 的 variant 变成
// `body.geml-s-<state>-<value> .geml-b-<id> { … }` —— 状态是 body 上的 class，状态一变只换
// class，不重绘。两个条件的 variant 选择器天然比一个条件的特异性高，正是 §12.5 要的顺序。
// 注入页面的 CSS 不能加载任何资源（raw.githubusercontent 的 default-src 'none'）：这里生成的
// 只有长度、颜色、位置，没有 url()。

import { candidates, address, blockSpans } from "./parse-entry.js";

const BOX_PASS = new Set([
  "width", "max-width", "padding", "margin", "font-size", "line-height", "font-family",
  "text-align", "color", "background", "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-radius", "gap",
]);

/** 部件名 → 它在 DOM 里的标签。闭集，和解析器的 PARTS 一一对应。 */
export const PART_TAG = { link: "a", image: "img", "code-span": "code", strong: "strong", emphasis: "em" };

/**
 * 一个 variant 的 when → 选择器的两半：`$state=value` 是 body 上的 class；`@hover`/`@focus`
 * 是指针给的状态，落在目标自己身上（`:hover` / `:focus-visible`）。
 */
export function whenSelector(when) {
  let body = "", suffix = "";
  for (const [st, val] of Object.entries(when)) {
    if (st === "@hover") suffix += ":hover";
    else if (st === "@focus") suffix += ":focus-visible";
    else body += `body.${stateClass(st, val)}`;
  }
  return { body, suffix };
}

/** `view`/`editable` → 面的名字：rendered | source | source-editable。 */
export function faceOf(box) {
  if (!box || box.view !== "source") return "rendered";
  return box.editable === "yes" ? "source-editable" : "source";
}

/** 一个 binding 用到的全部面。只有 {rendered} 时宿主不包面，DOM 和今天一样。 */
export function facesOf(b) {
  const set = new Set([faceOf(b.box)]);
  for (const v of b.variants ?? []) if (v.box && v.box.view !== undefined) set.add(faceOf(v.box));
  return set;
}

// 开放值域的内含词（width、color、border…）会原样进 CSS 文本，而样式表是不可信输入：一个
// `width="0} body{display:none} .x{"` 就跳出了自己的规则、改写整页。只放行长度、颜色、关键字、
// rgb()/calc() 用得着的字符；`;` `{` `}` `<` `>` `\` 引号 `!` `@` 一律不收，`url(` 和 `/*` 单独点名。
// 不收的丢弃并报回去（renderPage 的 `unsafe`），不静默。
const SAFE_VALUE = /^[A-Za-z0-9 #%.,()+\-/_]*$/;
export function safeCssValue(v) {
  const s = typeof v === "number" ? `${v}px` : String(v);
  if (s === "" || !SAFE_VALUE.test(s) || /url\s*\(|\/\*/i.test(s)) return null;
  return s;
}

export function classFor(addr) {
  return "geml-b-" + String(addr).replace(/^#/, "").replace(/[^A-Za-z0-9_-]/g, "_");
}

/** 容器（screen / frame）自己的 class —— 它的 box 挂在这上面。 */
export function frameClassFor(id) {
  return "geml-f-" + String(id).replace(/[^A-Za-z0-9_-]/g, "_");
}

export function stateClass(state, value) {
  return `geml-s-${state}-${String(value).replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** 一个 box 对象 → CSS 声明串。sticky/scroll/hide-below 不是 CSS 属性名，各有翻译；hide-below 走 @media，由 cssForPage 单独处理。 */
function declarations(box, dropped, where, skip = new Set()) {
  const out = [];
  for (const [k, v] of Object.entries(box)) {
    if (skip.has(k)) continue;
    if (BOX_PASS.has(k)) {
      const s = safeCssValue(v);
      if (s === null) { dropped.push(`${where}: ${k}=${JSON.stringify(String(v))} is not a value this host puts in CSS`); continue; }
      out.push(`${k}: ${s}`);
      // 写了宽度就是「就这么宽」，不是「至少这么宽」。行容器是 flex，默认会拉伸/压缩 ——
      // 切一次 tab 侧栏就变宽，正是这个。
      if (k === "width" && s !== "auto") out.push("flex: 0 0 auto");
    } else if (k === "sticky") out.push(`position: sticky; top: ${Number(v)}px`);
    else if (k === "scroll" && v === "own") out.push("overflow: auto; max-height: 100vh");
    // 浮层：盖在页面上、不占位置。锚在最近的容器上（.geml-frame 都是 position: relative）。
    else if (k === "layer" && v === "overlay") out.push("position: absolute; top: 100%; left: 0; z-index: 20");
    // 盖住整个视口、内容居中 —— 开场提示、模态框、吐司都是这一件事。
    else if (k === "layer" && v === "screen") out.push("position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center");
    // 画出来之后自己淡掉。keyframes 与「减少动态效果」的让步在静态表里（都不带页面常量）。
    else if (k === "fade-out") out.push(`animation: geml-fade ${Number(v)}s ease-in forwards`);
    // 带不带下划线。宿主不再替所有页面剥，浏览器的默认立着，要去掉由样式表说。
    else if (k === "underline") out.push(v === "yes" ? "text-decoration: underline" : "text-decoration: none");
    // 按状态显示/隐藏。`hide-below` 是按视口的那一半，这是按状态的那一半。
    else if (k === "visible") out.push(v === "no" ? "display: none" : "display: revert");
    // 吃不吃剩余空间。默认（不写）就是 CSS 自己的 flex: 0 1 auto —— 按内容大小。
    else if (k === "grow") out.push(v === "yes" ? "flex: 1 1 auto" : "flex: 0 1 auto");
  }
  return out.join("; ");
}

/** 整页的 CSS：每个 binding 的 box，再是它的 variants，hide-below 用 media query。丢弃的值追加进 dropped。 */
export function cssForPage(vm, dropped = []) {
  const rules = [];
  const screen = vm.screens[0];
  const bindings = screen ? screen.bindings : vm.bindings;
  // 容器的 box：区域的背景、内边距、槽位间距（gap）。screen 是**页**，所以它的背景
  // 就是页面底色 —— 只挂在 .geml-page 上，文档比视口短时下面还是宿主的白，所以 body 也上一遍。
  const container = (c, sel) => {
    const decl = declarations(c.box || {}, dropped, `container #${c.id}`);
    if (decl) rules.push(`${sel} { ${decl} }`);
    if (typeof (c.box || {})["hide-below"] === "number") {
      rules.push(`@media (max-width: ${c.box["hide-below"] - 1}px) { ${sel} { display: none } }`);
    }
    // 容器也能按状态变（下拉菜单、浮层、整栏收起都是这一件事）。选择器和块上的同形：
    // 状态是 body 上的 class，所以换状态只换 class，不重绘。
    for (const v of c.variants ?? []) {
      const { body, suffix } = whenSelector(v.when);
      const cond = body ? `${body} ` : "";
      const d = declarations(v.box, dropped, `container #${c.id} when ${JSON.stringify(v.when)}`);
      if (d) rules.push(`${cond}${sel}${suffix} { ${d} }`);
      if (typeof v.box["hide-below"] === "number") {
        rules.push(`@media (max-width: ${v.box["hide-below"] - 1}px) { ${cond}${sel}${suffix} { display: none } }`);
      }
    }
  };
  if (screen) {
    container(screen, ".geml-page");
    const bg = (screen.box || {}).background;
    const safeBg = bg === undefined ? null : safeCssValue(bg);
    if (safeBg) rules.push(`body.geml-body { background: ${safeBg} }`);
  }
  for (const f of vm.frames || []) container(f, "." + frameClassFor(f.id));
  for (const b of bindings) {
    const cls = classFor(b.block);
    // 部件绑定接标签：`.geml-b-nav a`。块绑定就是 `.geml-b-nav`。
    const target = `.${cls}` + (b.part ? ` ${PART_TAG[b.part] ?? "span"}` : "");
    // 块上的 axis：条目容器（列表/表单，renderPage 标成 .geml-items）横排或竖排；gap 跟条目走，不留在块自己身上。
    const items = (box, cond) => {
      if (box.axis === undefined) return;
      const gap = box.gap === undefined ? null : safeCssValue(box.gap);
      rules.push(`${cond}${target} .geml-items { display: flex; flex-direction: ${box.axis === "row" ? "row" : "column"}; list-style: none; margin: 0; padding: 0${gap ? `; gap: ${gap}` : ""} }`);
      // 同一个 `gap` 也落到条目**里面** —— 图标和它的文字之间。宿主原来在这儿写死 6px，
      // 那是这一页的样子，样式表还够不着（它只生成 `.geml-items` 的规则，到不了 li）。
      if (gap) rules.push(`${cond}${target} .geml-items > li { gap: ${gap} }`);
    };
    const skipFor = (box) => new Set(box.axis === undefined ? [] : ["gap"]);
    const base = declarations(b.box, dropped, b.block, skipFor(b.box));
    if (base) rules.push(`${target} { ${base} }`);
    items(b.box, "");
    if (typeof b.box["hide-below"] === "number") {
      rules.push(`@media (max-width: ${b.box["hide-below"] - 1}px) { ${target} { display: none } }`);
    }
    // 面：view=source 是另一副面孔。两副都在 DOM 里（renderPage 画），这里只切显示：基础面显示、其余隐藏。
    const faces = facesOf(b);
    if (faces.size > 1 || !faces.has("rendered")) {
      rules.push(`${target} > .geml-face { display: none }`);
      rules.push(`${target} > .geml-face-${faceOf(b.box)} { display: revert }`);
    }
    // variants 已按条件数升序（§12.5）；这里的输出顺序保留它，特异性也随条件数递增。
    for (const v of b.variants ?? []) {
      const { body, suffix } = whenSelector(v.when);
      const cond = body ? `${body} ` : "";
      const decl = declarations(v.box, dropped, `${b.block} when ${JSON.stringify(v.when)}`, skipFor(v.box));
      if (decl) rules.push(`${cond}${target}${suffix} { ${decl} }`);
      items(v.box, cond);
      if (typeof v.box["hide-below"] === "number") {
        rules.push(`@media (max-width: ${v.box["hide-below"] - 1}px) { ${cond}${target}${suffix} { display: none } }`);
      }
      if (v.box.view !== undefined) {
        rules.push(`${cond}${target}${suffix} > .geml-face { display: none }`);
        rules.push(`${cond}${target}${suffix} > .geml-face-${faceOf(v.box)} { display: revert }`);
      }
    }
  }
  return rules.join("\n");
}

/**
 * 地址 → 节点。枚举与地址都用**解析器**的那一份（parse-entry 再导出的 candidates/address）：
 * 标题、块之间的散文、类型块各自算什么地址，宿主再实现一遍必然和构建期分叉。
 */
function nodesByAddress(corpus) {
  const out = new Map();
  for (const { path, doc } of corpus) {
    for (const c of candidates(doc)) {
      const a = address(c);
      out.set(`${path}${a}`, c.block);
      // 只有一份文档时裸地址也建一个键：调用方（和一堆老测试）不一定知道视图模型
      // 把这份文档叫什么。多份文档时限定名是唯一的钥匙，不会撞。
      if (corpus.length === 1) out.set(a, c.block);
    }
  }
  return out;
}

/** 语料里的地址：`page.geml#id`。槽位和绑定给的就是这两半，拼起来才是钥匙。 */
const at = (doc, block) => `${doc}${block}`;

/**
 * 画一页。返回 { root, css, unplaced } 或 { error }。
 * opts.components：名字 → (block, params, ctx) => Element，缺省用 renderBlock。
 * opts.state：components.js 的状态存储（get/set/subscribe/toggleTarget）；null 表示不接交互。
 * opts.producers：state id → 喂它的块地址集合（style-entry 的 producersOf）。
 */
/**
 * 一页最多放多少个块 + frame 实例。frame 可以被放多处（§2.4），所以嵌套 + 复用是**乘法**：每层两个
 * 槽位指向同一个子 frame、叠 16 层，就是 65536 份叶子 —— 检查器走一遍是线性的（已访问集），
 * 渲染却得每处都画。和 transclude 的 EMBED_TOTAL_CAP 同一个理由，超了整页不画、退回默认渲染。
 */
export const PLACEMENT_CAP = 2000;

export function renderPage(vm, model, dom, opts) {
  // 语料：宿主文档 + 它 embed 进来的那些。没给就只有宿主自己 —— 路径要跟**视图模型**
  // 里的一致（绑定都带 doc），否则 `page.geml#hdr` 和 `#hdr` 对不上，一个块都摆不出来。
  const corpus = opts.corpus ?? [{ path: opts.docPath ?? "", doc: model }];
  const { renderBlock, labels, components = {}, state = null, producers = null } = opts;
  if (vm.screens.length !== 1) {
    return { error: vm.screens.length === 0 ? "no style-screen in the stylesheet" : `${vm.screens.length} style-screen blocks; a page has one` };
  }
  let placements = 0;
  const over = () => ++placements > PLACEMENT_CAP;
  const screen = vm.screens[0];
  const byAddr = nodesByAddress(corpus);
  const binding = new Map();
  for (const b of screen.bindings) {
    // 部件绑定（`text#nav link`）只生成 CSS，不参与放置 —— 它和块绑定同地址，放进这张表会把块的
    // component / axis 盖掉（真页面上树不折叠、列表不横排，就是这么丢的）。
    if (b.part) continue;
    binding.set(at(b.doc, b.block), b);
    if (corpus.length === 1) binding.set(b.block, b);
  }
  const frames = new Map(vm.frames.map((f) => [f.id, f]));
  const placed = new Set();
  const vmStates = vm.states.map((s) => ({ ...s, matchIds: producers?.get(s.id) ?? new Set() }));
  // 组件也要能按地址找块（`icons=#icons` 的图标集、`options=#id` 的选项表）——
  // 地址是 GEML 本来就有的东西，没必要让样式表把数据抄一遍。
  // `options=#id` 给的是**裸 id**，而语料里的地址是 `page.geml#id` —— 取最后一个 `#`
  // 之后的那一段。（之前剥的是前导 `#`，单文档时对，加了第二份文档就全查不到了：
  // 下拉框变成空壳，还不报错。）
  const byId = new Map();
  for (const [addr, node] of byAddr) {
    const h = String(addr).lastIndexOf("#");
    if (h >= 0) byId.set(String(addr).slice(h + 1), node);
  }
  // 源文本：`view=source` 要画块的原文。embed 的原文是借来那份文档的 text；宿主文档自己的块
  // 按 blockSpans 切行（`geml list` 用的同一份行段）。都没有就退回块的 raw / text。
  const sources = new Map(corpus.filter((e) => typeof e.text === "string").map((e) => [e.path, e.text]));
  const hostPath = corpus[0]?.path;
  const hostText = sources.get(hostPath);
  let spans = null;
  if (typeof hostText === "string") { try { spans = blockSpans(hostText); } catch { spans = null; } }
  const ctx = { dom, renderBlock, labels, state, model, vmStates, byId, corpus, sources, spans };

  const sourceOf = (node, docPath) => {
    if (node.kind === "block" && node.type === "embed") {
      const src = typeof node.attrs?.src === "string" ? node.attrs.src.trim() : "";
      const path = src.includes("#") ? src.slice(0, src.indexOf("#")) : src;
      const t = sources.get(path);
      if (typeof t === "string") return t;
    }
    const id = node.kind === "heading" || node.kind === "block" ? node.id : undefined;
    const span = id !== undefined && spans && docPath === hostPath ? spans.get(id) : undefined;
    if (span && typeof hostText === "string") {
      return hostText.split(/\r?\n/).slice(Math.max(0, span.start - 1), span.end).join("\n");
    }
    if (Array.isArray(node.raw)) return node.raw.join("\n");
    return typeof node.text === "string" ? node.text : "";
  };

  /**
   * 让一个元素成为某个 toggle 状态的触发者：可点、可键盘。块（文档里的一张图）和容器（一片 frame）
   * 走同一段代码。只有**真的把某一片浮起来**的状态才「点别处关掉」—— 侧栏折叠不是浮层，
   * 一视同仁会让点一下正文把已收起的侧栏又弹回来。
   */
  const wireTrigger = (el, trigger) => {
    if (!trigger || !state) return;
    el.setAttribute("data-triggers", trigger.id);
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    const flip = () => {
      const next = state.toggleTarget(trigger.id);
      if (next !== null) state.set(trigger.id, next);
    };
    const drivesOverlay = [...(vm.screens ?? []), ...(vm.frames ?? [])]
      .some((c) => (c.variants ?? []).some((v) => v.box?.layer === "overlay" && trigger.id in v.when));
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      flip();
      if (drivesOverlay && state.get(trigger.id) !== (trigger.initValue ?? "")) {
        const off = (ev) => {
          if (el.contains(ev.target)) return;
          if (ev.target.closest?.(`[data-opened-by="${trigger.id}"]`)) return;
          state.set(trigger.id, trigger.initValue ?? "");
          dom.removeEventListener("click", off, true);
        };
        dom.addEventListener("click", off, true);
      }
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
  };

  // 单文档时视图模型里的路径（`page.geml`）和语料里的路径（调用方给什么算什么）不一定
  // 同名 —— 一份文档没有歧义，所以限定名找不到就回落到裸地址。多份文档时限定名是唯一钥匙。
  const lookup = (m, doc, block) => m.get(at(doc, block)) ?? (corpus.length === 1 ? m.get(block) : undefined);
  /** 这个 `embed` 借的文档在语料里吗 —— 借到了就不是悬空的引用。 */
  const inCorpus = (node) => {
    if (node.type !== "embed") return false;
    const src = typeof node.attrs?.src === "string" ? node.attrs.src.trim() : "";
    const path = src.includes("#") ? src.slice(0, src.indexOf("#")) : src;
    return path !== "" && corpus.some((c) => c.path === path);
  };
  /** `embed {src="other.geml"}` → 语料里那份文档的全部块，画成一片。 */
  const borrowedFor = (node) => {
    const src = typeof node.attrs?.src === "string" ? node.attrs.src.trim() : "";
    const path = src.includes("#") ? src.slice(0, src.indexOf("#")) : src;
    const entry = path ? corpus.find((c) => c.path === path) : null;
    if (!entry) return null; // 没借到就退回渲染器画的降级链接
    const frag = dom.createElement("div");
    frag.className = "geml-borrowed";
    frag.setAttribute("data-doc", path);
    // 借来的块是**跟着这个 embed 一起画出去的**，不是漏摆 —— 记上，别进 unplaced。
    // 顺带按文档序记下每个块的地址：借来的块也要戴上自己的 class，否则样式表能为它们
    // 求出绑定、生成 CSS，却没有元素可落 —— 一页的正文就是它嵌进来的这份文档，样式表
    // 管不到它说不过去。
    const addrOf = new Map();
    for (const c of candidates(entry.doc)) {
      placed.add(at(path, address(c)));
      if (c.part === undefined) addrOf.set(c.block, address(c));
    }
    for (const child of entry.doc.children ?? []) {
      if (over()) throw new RangeError("placement cap");
      const el = renderBlock(child, dom, labels, ctx.byId);
      if (!el) continue;
      const addr = addrOf.get(child);
      if (addr === undefined) { frag.appendChild(el); continue; }
      const wrap = dom.createElement("div");
      wrap.className = `geml-placed ${classFor(addr)}`;
      wrap.setAttribute("data-block", addr);
      wrap.setAttribute("data-doc", path);
      wrap.appendChild(el);
      frag.appendChild(wrap);
    }
    return frag;
  };

  const place = (doc, block) => {
    const addr = at(doc, block);
    const node = lookup(byAddr, doc, block);
    if (!node) return null;
    if (over()) throw new RangeError("placement cap");
    placed.add(byAddr.has(addr) ? addr : block);
    const b = lookup(binding, doc, block);
    const params = b ? b.params : {};
    const name = typeof params.component === "string" ? params.component : "";
    // hasOwn，不是 `components[name]`：component= 来自样式表，`constructor` / `toString` /
    // `__proto__` 都是合法的名字，从原型链上取到的是 Object 的方法 —— 当渲染函数调用会抛，整页不画。
    const render = Object.hasOwn(components, name) ? components[name] : ((blk) => renderBlock(blk, dom, labels, ctx.byId));
    // 槽位摆的是一个 `embed`，而它借的文档就在语料里 —— 那就把那份文档画在这儿。
    // 样式说「这份文档放这个位置」，里面有什么由文档自己决定。
    // 有组件时**组件优先**：它可能要拿这份内容做别的事（编辑器就要预览 + 源码两副面孔），
    // 所以把「画借来的文档」当成一个能力交给它，而不是抢在它前面画掉。
    ctx.renderBorrowed = (n) => (n?.kind === "block" && n.type === "embed" ? borrowedFor(n) : null);
    const named = Object.hasOwn(components, name);
    const inner = named ? render(node, params, ctx) : (ctx.renderBorrowed(node) ?? render(node, params, ctx));
    const wrap = dom.createElement("div");
    wrap.className = `geml-placed ${classFor(block)}`;
    wrap.setAttribute("data-block", block);
    if (doc) wrap.setAttribute("data-doc", doc);
    if (name) wrap.setAttribute("data-component", name);
    // 块上的 axis：条目容器标出来，CSS（cssForPage）对它做 flex。第一个列表/表单就是最外层的那个。
    if (b && inner && (b.box.axis !== undefined || (b.variants ?? []).some((v) => v.box?.axis !== undefined))) {
      const items = inner.matches?.("ul, ol, .geml-form") ? inner : inner.querySelector("ul, ol, .geml-form");
      if (items) items.classList.add("geml-items");
    }
    // 面：view=source 是另一副面孔，两副都画，CSS 按状态切显示。只有 rendered 时不包，DOM 和从前一样。
    const faces = b ? facesOf(b) : new Set(["rendered"]);
    if (faces.size > 1 || !faces.has("rendered")) {
      const rendered = dom.createElement("div");
      rendered.className = "geml-face geml-face-rendered";
      if (inner) rendered.appendChild(inner);
      wrap.appendChild(rendered);
      const text = sourceOf(node, doc);
      for (const f of faces) {
        if (f === "rendered") continue;
        // 可编辑的是 textarea，不可编辑的是 pre。textarea 没有写回路径 —— 本地草稿，刷新即失。
        const face = dom.createElement(f === "source-editable" ? "textarea" : "pre");
        face.className = `geml-face geml-face-${f} geml-source`;
        face.setAttribute("spellcheck", "false");
        face.textContent = text;
        wrap.appendChild(face);
      }
    } else if (inner) {
      wrap.appendChild(inner);
    }
    // 块当触发者（toggle）：点这一片，翻那个状态。折叠按钮、下拉箭头都是文档里的一张图。
    wireTrigger(wrap, ctx.vmStates.find((st) => st.on === "toggle" && st.matchIds?.has(block)));
    // 字段喂状态（select）：控件的值就是状态；没 init-value 就用字段的 value=。segments 这类组件
    // 自己画按钮、自己接线，这里找不到标准控件就不重复接。
    const feeder = state ? ctx.vmStates.find((st) => st.on === "select" && st.matchIds?.has(block)) : null;
    const control = feeder ? wrap.querySelector(".geml-form-control") : null;
    if (feeder && control) {
      if ((state.get(feeder.id) ?? "") === "" && control.value) state.set(feeder.id, control.value);
      control.addEventListener("change", () => state.set(feeder.id, control.value));
      state.subscribe?.((id, v) => { if (id === feeder.id && control.value !== v) control.value = v; });
    }
    return wrap;
  };

  const container = (c) => {
    if (over()) throw new RangeError("placement cap");
    const sec = dom.createElement("section");
    sec.className = "geml-frame " + frameClassFor(c.id);
    sec.setAttribute("data-id", c.id);
    sec.setAttribute("data-axis", c.axis);
    if (c.component) sec.setAttribute("data-component", c.component);
    // 容器也能带说明文字：下拉箭头那种触发器是一整片 frame，不是表里的一个条目。
    if (typeof c.params?.title === "string") {
      sec.setAttribute("title", c.params.title);
      sec.setAttribute("aria-label", c.params.title);
    }
    // 哪个状态把这一片浮出来的 —— 「点别处关掉」要靠它认人
    for (const v of c.variants ?? []) {
      if (v.box?.layer === "overlay") for (const st of Object.keys(v.when)) sec.setAttribute("data-opened-by", st);
    }
    // 容器也可以是组件：样式表点名、宿主实现，参数从容器上来。块组件签名是 (block, params, ctx)，
    // 这里没有块，传 null。容器也能当状态的触发者（`style-state {match="#menu-btn"}`），和块同一段接线。
    wireTrigger(sec, ctx.vmStates.find((st) => st.on === "toggle" && st.matchIds?.has(`#${c.id}`)));
    if (c.component && Object.hasOwn(components, c.component)) {
      const made = components[c.component](null, c.params || {}, ctx);
      if (made) sec.appendChild(made);
    }
    for (const slot of c.slots) {
      if (slot.kind === "frame") {
        const f = frames.get(slot.frame);
        if (f) sec.appendChild(container(f));
      } else if (slot.kind === "state") {
        // profile §2.4：渲染那个块引用状态指向的块。这一版没有块引用状态的用例，先放占位；
        // 不再画开关 —— 折叠按钮是文档里的一个块（一张图）当触发者，不是宿主编的 ☰。
        const holder = dom.createElement("div");
        holder.className = "geml-slot-state";
        holder.setAttribute("data-state", slot.state);
        sec.appendChild(holder);
      } else {
        for (const { doc, block } of slot.blocks) {
          const el = place(doc, block);
          if (el) sec.appendChild(el);
        }
      }
    }
    return sec;
  };

  const root = dom.createElement("div");
  root.className = "geml-page";
  try {
    root.appendChild(container(screen));
  } catch (e) {
    if (e instanceof RangeError && e.message === "placement cap") {
      return { error: `the stylesheet places more than ${PLACEMENT_CAP} blocks and frames on one page (frames placed inside frames multiply); rendering without it` };
    }
    throw e;
  }
  const unplaced = [...byAddr.keys()].filter((a) => {
    const b = byAddr.get(a);
    if (placed.has(a)) return false;
    // meta 不是给人看的；标题和散文现在也是可放置节点，漏了同样算漏。
    if (b.kind !== "block") return true;
    if (b.type === "meta") return false;
    // 一份文档可以只写「这页 = 这个模板 + 这份文档」，两个 `embed` 把它们拉进语料，
    // 剩下的由样式表的 slots 逐块摆。那种 `embed` 不是漏摆的块 —— 它的活儿是把文档
    // 带进来，而它带进来的块要么被摆了、要么自己会出现在这张单子上。
    return !inCorpus(b);
  }).length;
  const unsafe = [];
  const css = cssForPage(vm, unsafe);
  return { root, css, unplaced, unsafe };
}
