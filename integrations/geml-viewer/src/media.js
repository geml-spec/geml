// geml-media/v1 的三个组件契约（profile 文档 §3 / 设计记录 §5.5）。
//
// 时间怎么算**不在这里**：它和 `geml media build` / `export` 用同一份 layoutDoc，
// 因为「这个片段从第几秒开始」只能有一个答案 —— 浏览器里画出来的和 ffmpeg 出片的
// 必须是同一条时间线，否则预览就是在骗人。
//
// 分工：
//   · timeline-track / overlay-track 是**容器**组件，样式表点名它们（style-frame），
//     宿主把那条轨做成一条有刻度的时间带。frame 组件拿不到槽位里的块（layout.js
//     传 null），所以它只负责轨道本身。
//   · clip 是**块**组件：每个 media-clip 自己按时间摆到轨道上。
//
// 一行色值都没有：这里只出结构与相对位置，颜色尺寸归样式表（设计 2026-09-10 §5）。
import { layoutDoc } from "../../../geml-parser/dist/media-timeline.js";

/** 一份文档的时间线只算一次。key 是 Document 对象本身。 */
const cache = new WeakMap();

function timelineFor(ctx) {
  // 片段住在哪份文档里：corpus 是 path → Document。带 media-clip 的那一份就是时间线。
  for (const doc of (ctx.corpus?.values?.() ?? [])) {
    if (cache.has(doc)) return cache.get(doc);
    const hasClip = (function find(bs) {
      for (const b of bs ?? []) {
        if (b.kind === "block" && b.type === "media-clip") return true;
        if (b.kind === "block" && b.children && find(b.children)) return true;
      }
      return false;
    })(doc.children);
    if (!hasClip) continue;
    // 素材的固有时长从素材块读。跨文档的素材在 corpus 里，按 id 找。
    const durationOf = (ref) => {
      const id = ref.includes("#") ? ref.slice(ref.indexOf("#") + 1) : ref;
      const b = ctx.byId?.get?.(id);
      const d = b && b.attrs ? Number(b.attrs.duration) : NaN;
      return Number.isFinite(d) ? d : undefined;
    };
    const tl = layoutDoc(doc, { durationOf });
    cache.set(doc, tl);
    return tl;
  }
  return null;
}

/** 秒 → 百分比。整条时间线的总长是 100%。 */
const pct = (v, total) => (total > 0 ? (v / total) * 100 : 0);

/**
 * `component=clip`：一个片段。按它在时间线上的起点与时长绝对定位，宽度是它占总长的
 * 比例 —— 于是一条轨上的片段天然对齐，不需要任何算术写进样式表。
 */
export function clip(block, params, ctx) {
  const dom = ctx.dom;
  const el = dom.createElement("div");
  el.className = "geml-clip";
  if (block?.id) el.id = block.id;
  const tl = timelineFor(ctx);
  const placed = tl && block?.id ? tl.clips.find((c) => c.id === block.id) : null;
  if (placed && tl.duration > 0) {
    el.style.position = "absolute";
    el.style.left = pct(placed.start, tl.duration).toFixed(4) + "%";
    el.style.width = pct(placed.duration, tl.duration).toFixed(4) + "%";
    el.setAttribute("data-start", placed.start.toFixed(3));
    el.setAttribute("data-duration", placed.duration.toFixed(3));
    el.title = placed.start.toFixed(2) + "s + " + placed.duration.toFixed(2) + "s";
  }
  // 标签：片段的 id 加它引用的东西。渲染成什么样归样式表。
  const label = dom.createElement("span");
  label.className = "geml-clip-label";
  label.textContent = block?.id ?? "";
  el.appendChild(label);
  const inner = block ? ctx.renderBlock(block, dom, ctx.labels, ctx.byId) : null;
  if (inner) el.appendChild(inner);
  return el;
}

function trackEl(ctx, extraClass, params) {
  const dom = ctx.dom;
  const el = dom.createElement("div");
  el.className = "geml-track" + (extraClass ? " " + extraClass : "");
  el.style.position = "relative";
  const tl = timelineFor(ctx);
  if (tl) {
    el.setAttribute("data-duration", tl.duration.toFixed(3));
    // 刻度：每秒一格。格数由时间线决定，不由样式表猜。
    const ruler = dom.createElement("div");
    ruler.className = "geml-track-ruler";
    ruler.setAttribute("aria-hidden", "true");
    for (let s = 0; s <= Math.floor(tl.duration); s++) {
      const tick = dom.createElement("span");
      tick.className = "geml-tick";
      tick.style.position = "absolute";
      tick.style.left = pct(s, tl.duration).toFixed(4) + "%";
      tick.textContent = String(s);
      ruler.appendChild(tick);
    }
    if (params?.ruler !== "no") el.appendChild(ruler);
  }
  return el;
}

/** `component=timeline-track`：一条轨。片段在它里面按时间绝对定位。 */
export function timelineTrack(block, params, ctx) { return trackEl(ctx, "", params); }

/**
 * `component=overlay-track`：同样是一条轨，只是宿主把它画在画面之上。
 * 叠放是**呈现**，所以它在这里，不在内容文档里 —— overlay 轨的种类是 video。
 */
export function overlayTrack(block, params, ctx) { return trackEl(ctx, "geml-track-overlay", params); }

export const MEDIA_COMPONENTS = {
  clip,
  "timeline-track": timelineTrack,
  "overlay-track": overlayTrack,
};
