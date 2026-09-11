// 宿主注册表（profile §2.1：component 是名字，实现在宿主）和状态存储（§5：interaction → state → view）。
// 状态住在 <body> 的 class 上（layout.js 的 variant 规则挂在那儿），所以 set() 就是换 class。
//
// 这里只有**不认页面**的东西（设计 2026-09-10 §5）：任何一行不许出现色值、尺寸、某个站点的类名。
// 第一个页面用例长出来的 bar / tab-bar / field / editor / icon / markdown-body 都删了 —— 它们做的事
// GEML 本来就有办法说（列表 + 行内链接与图片、form-field select、view=source）。

import { stateClass, safeCssValue } from "./layout.js";

/**
 * 状态存储。toggle 翻到哪个值 profile 没说：取 init-value 和所有 variant 的 when= 里
 * 为该状态点名的**那一个**别的值（设计 §12.7）；点名了零个或多个就惰性 —— 返回 null。
 */
export function createState(vm, dom) {
  const values = new Map();
  const named = new Map(); // state → Set(values named by when=)
  for (const s of vm.states) values.set(s.id, s.initValue ?? "");
  // 「被 when= 点名的值」不只在块的绑定里 —— 容器（screen/frame）也有变体（整栏折叠、菜单弹出）。
  const bindings = vm.screens[0] ? vm.screens[0].bindings : vm.bindings;
  const withVariants = [...bindings, ...(vm.screens ?? []), ...(vm.frames ?? [])];
  for (const b of withVariants) for (const v of b.variants ?? []) {
    for (const [s, val] of Object.entries(v.when)) {
      if (s.startsWith("@")) continue; // @hover / @focus 是指针给的，不是这里管的状态
      if (!named.has(s)) named.set(s, new Set());
      named.get(s).add(val);
    }
  }
  const body = dom.body;
  const apply = (id, prev, next) => {
    if (!body) return;
    if (prev !== undefined && prev !== "") body.classList.remove(stateClass(id, prev));
    if (next !== "") body.classList.add(stateClass(id, next));
  };
  for (const [id, v] of values) apply(id, undefined, v);
  const listeners = new Set();
  return {
    /** 被某个 `when=` 点名过的值（含初值）。 */
    namedValues: (id) => [...new Set([values.get(id), ...(named.get(id) ?? [])])].filter((v) => v !== undefined && v !== ""),
    get: (id) => values.get(id),
    set(id, v) {
      const prev = values.get(id);
      values.set(id, v);
      apply(id, prev, v);
      for (const fn of listeners) fn(id, v);
    },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    toggleTarget(id) {
      const init = vm.states.find((s) => s.id === id)?.initValue ?? "";
      const others = [...(named.get(id) ?? [])].filter((v) => v !== init);
      if (others.length !== 1) return null;
      return values.get(id) === init ? others[0] : init;
    },
  };
}

/** 哪个状态由这个块的这种交互喂：state 的 match 命中它（producersOf 只认 type#id / #id）。 */
export function producing(ctx, block, on) {
  if (!ctx.state || !block?.id) return null;
  const addr = `#${block.id}`;
  for (const s of ctx.vmStates ?? []) if (s.on === on && s.matchIds.has(addr)) return s.id;
  return null;
}

/**
 * 嵌套列表 → 可折叠的树：带子列表的条目包成 details/summary。缩进就是层级（§2.2），
 * 没有列名、没有缩进算术；折叠是原生的，零脚本。有子项 = 展开着（GitHub 也只下发展开
 * 目录的子项）。展开箭头是系统 ::marker，CSP 下它本来也引不了图。
 */
export function tree(block, params, ctx) {
  const dom = ctx.dom;
  const inner = ctx.renderBlock(block, dom, ctx.labels, ctx.byId);
  if (!inner) return null;
  inner.classList.add("geml-tree");
  // 每一层缩进多少是**这一棵树的样子**，不是「树」这件事本身，所以它是组件参数
  // （设计 §12.3 把 `indent` 点名为组件词）。不给就用一个能看出层级的默认值 ——
  // 一棵不缩进的树不是树。值过和内含词同一道闸：样式表是不可信输入。
  const indent = safeCssValue(params.indent ?? "1.2em") ?? "1.2em";
  for (const li of [...inner.querySelectorAll("li")]) {
    const sub = [...li.children].find((c) => c.tagName === "UL" || c.tagName === "OL");
    if (!sub) continue;
    sub.style.paddingLeft = indent;
    const details = dom.createElement("details");
    details.setAttribute("open", "");
    const summary = dom.createElement("summary");
    while (li.firstChild && li.firstChild !== sub) summary.appendChild(li.firstChild);
    li.insertBefore(details, sub);
    details.appendChild(summary);
    details.appendChild(sub);
  }
  return inner;
}

/**
 * `form-field type=select` 画成一组分段按钮（一选多的另一副样子）。值仍是字段的值；
 * 它喂哪个状态由 style-state 说（`on=select`），和原生控件同一条接线。
 */
export function segments(block, params, ctx) {
  const dom = ctx.dom;
  const a = block?.attrs ?? {};
  const wrap = dom.createElement("div");
  wrap.className = "geml-segments";
  wrap.setAttribute("role", "group");
  if (block?.id) wrap.id = block.id;
  const ref = typeof a.options === "string" ? a.options.replace(/^#/, "") : "";
  const opts = ref && ctx.byId ? ctx.byId.get(ref) : null;
  const cols = opts?.table?.columns ?? [];
  const vi = cols.indexOf("value"), li = cols.indexOf("label");
  const stateId = producing(ctx, block, "select");
  let current = String(a.value ?? "");
  if (stateId) {
    const s = ctx.state.get(stateId);
    if (s) current = String(s); else if (current) ctx.state.set(stateId, current);
  }
  const buttons = [];
  const paint = () => { for (const b of buttons) b.setAttribute("aria-pressed", b.getAttribute("data-value") === current ? "true" : "false"); };
  for (const r of opts?.table?.rows ?? []) {
    const value = (r[vi >= 0 ? vi : 0]?.text ?? "").trim();
    const label = (r[li >= 0 ? li : (cols.length > 1 ? 1 : 0)]?.text ?? "").trim() || value;
    const btn = dom.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.setAttribute("data-value", value);
    btn.addEventListener("click", () => { current = value; paint(); if (stateId) ctx.state.set(stateId, value); });
    buttons.push(btn);
    wrap.appendChild(btn);
  }
  paint();
  if (stateId && ctx.state.subscribe) ctx.state.subscribe((id, v) => { if (id === stateId) { current = String(v); paint(); } });
  return wrap;
}

/** codemap 播种的样式表把显示旋钮挂在 `component=code-graph` 上；旋钮由 graph-style 另行读取，这里照常画块。 */
function codeGraph(block, params, ctx) {
  return ctx.renderBlock(block, ctx.dom, ctx.labels, ctx.byId);
}

export const COMPONENTS = { tree, segments, "code-graph": codeGraph };
