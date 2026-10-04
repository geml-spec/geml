// `component=playlist`：同一条时间线的另一副面孔 —— 一份歌单，逐首播放。
//
// 内容文档不变：geml-media 的主轨本来就按文档顺序一刀接一刀（profile §3.2），一条
// 纯音频的主轨就是一份播放列表，片段不写 in/out 就放整首，src= 指向素材库里的歌。
// 播成剪辑预览（component=player）还是曲目列表，是样式表的事。
//
// 和 player 的区别在驱动：player 按 layoutDoc 排好的绝对时间走一个时钟，所以每一刀都得
// 知道多长；歌单按"这一首放完了"往下走，不排时间，没写 duration 的歌照样能放。页面上
// 只有一个媒体元素，换首就换 src，打开页面什么也不取。
import { assetUrl, findRef } from "./media-player.js";

/** 一个 `media` 块的主轨、主轨的种类，和主轨上的片段（文档顺序）；没有片段就是 null。 */
function primaryOf(b) {
  if (!b || b.kind !== "block" || b.type !== "media" || typeof b.attrs?.tracks !== "string") return null;
  const tracks = b.attrs.tracks.split(/[\s,]+/).filter(Boolean).map((t) => {
    const i = t.indexOf(":");
    return { name: i < 0 ? t : t.slice(0, i), kind: i < 0 ? "" : t.slice(i + 1) };
  });
  // 主轨缺省是第一条声明的轨（profile §2）。
  const primary = typeof b.attrs.primary === "string" ? b.attrs.primary : tracks[0]?.name;
  const kind = tracks.find((t) => t.name === primary)?.kind ?? "";
  const clips = (b.children || []).filter((c) => c.kind === "block" && c.type === "media-clip" && c.attrs?.track === primary);
  return clips.length > 0 ? { kind, clips } : null;
}

/** 一份文档里第一条带片段的时间线。 */
function firstTimeline(doc) {
  let out = null;
  (function walk(bs) {
    for (const b of bs || []) {
      if (out) return;
      out = primaryOf(b);
      if (!out && b.kind === "block" && b.children) walk(b.children);
    }
  })(doc && doc.children);
  return out;
}

const seconds = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** 一首的标题：素材正文（作者的说明，raw 体）的第一个非空行；没写就是文件名。 */
function titleOf(asset, file) {
  const note = (Array.isArray(asset.raw) ? asset.raw : []).find((l) => l.trim() !== "");
  if (note) return note.trim();
  const name = String(file).split("/").pop() || String(file);
  return name.replace(/\.[^.]+$/, "");
}

export function playlist(block, params, ctx) {
  const dom = ctx.dom;
  const entries = [];
  for (const e of ctx.corpus || []) entries.push(e && e.doc ? e : { path: "", doc: e });
  const el = dom.createElement("div");
  el.className = "geml-playlist";

  // 样式规则把它绑在一个 `media` 块上（match=media component=playlist）就放那一条；
  // 作为容器组件（拿不到块）就放语料里的第一条。
  let found = primaryOf(block);
  for (const e of entries) { if (found) break; found = firstTimeline(e.doc); }
  const items = [];
  if (found && (found.kind === "audio" || found.kind === "video")) {
    for (const c of found.clips) {
      const hit = findRef(entries, c.attrs.src);
      if (hit === null) continue;
      const file = hit.block.attrs ? hit.block.attrs.src : undefined;
      if (typeof file !== "string") continue;
      // 同一道同源闸：别处的、带 scheme 的、含 `\` 的，一律不取（media-player.js）。
      const url = assetUrl(file, hit.path, ctx.docUrl);
      if (url === null) continue;
      items.push({ id: c.id, url, title: titleOf(hit.block, file), in: seconds(c.attrs.in), out: seconds(c.attrs.out) });
    }
  }
  if (items.length === 0) {
    el.className += " geml-playlist-empty";
    el.textContent = "这份文档里没有可播的曲目";
    return el;
  }

  // 随机与重复是播放策略，不是文档事实（profile §2）：初始状态来自样式表的参数
  // （component=playlist shuffle=on repeat=all），听的人在面板上随时改。
  el.setAttribute("data-shuffle", params?.shuffle === "on" ? "on" : "off");
  el.setAttribute("data-repeat", params?.repeat === "all" || params?.repeat === "one" ? params.repeat : "off");

  const media = dom.createElement(found.kind === "video" ? "video" : "audio");
  media.className = "geml-playlist-media";
  media.setAttribute("controls", "");
  media.setAttribute("preload", "none");     // 点了才取
  media.setAttribute("playsinline", "");
  el.appendChild(media);

  const bar = dom.createElement("div");
  bar.className = "geml-playlist-transport";
  for (const [cls, label, text] of [["geml-prev", "上一首", "⏮"], ["geml-next", "下一首", "⏭"], ["geml-shuffle", "随机播放", "🔀"], ["geml-repeat", "重复播放", "🔁"]]) {
    const b = dom.createElement("button");
    b.type = "button";
    b.className = cls;
    b.setAttribute("aria-label", label);
    b.textContent = text;
    bar.appendChild(b);
  }
  el.appendChild(bar);

  const list = dom.createElement("ol");
  list.className = "geml-playlist-items";
  for (const it of items) {
    const li = dom.createElement("li");
    li.setAttribute("data-src", it.url);
    if (it.id) li.setAttribute("data-clip", it.id);
    if (it.in !== null) li.setAttribute("data-in", String(it.in));
    if (it.out !== null) li.setAttribute("data-out", String(it.out));
    const b = dom.createElement("button");
    b.type = "button";
    b.className = "geml-playlist-item";
    b.textContent = it.title;
    li.appendChild(b);
    list.appendChild(li);
  }
  el.appendChild(list);
  return el;
}

/**
 * 歌单的驱动：点哪首放哪首，放完接下一首，上一首/下一首，随机与重复。片段写了 in/out
 * 就只放那一段。自包含、不 import 任何东西 —— 静态导出把它的源码原样内联
 * （tools/media-page.mjs），和 drivePlayer 一样，一份源码，两个宿主。`random` 只给测试
 * 换一个可复现的随机源。
 *
 * 不随机：按文档顺序。随机：这一轮每首放一遍 —— 一个洗好的待放队列，一份放过的记录。
 * 下一首（手按的、放完自动接的）都从队列里取；上一首沿记录往回走，现在这首回到队列
 * 最前面，再按下一首就回到它。手按的上一首/下一首一直能点，到了头就绕回去（随机是
 * 再洗一轮）；放完自动接到头，全部重复才接着来，不然停下。
 */
export function drivePlaylist(el, random) {
  if (!el || el.__gemlDriven) return;   // 接一次；再调是空操作
  el.__gemlDriven = true;
  const media = el.querySelector(".geml-playlist-media");
  const items = Array.from(el.querySelectorAll(".geml-playlist-items > li"));
  if (!media || items.length === 0) return;
  const rand = typeof random === "function" ? random : Math.random;
  const n = items.length;
  const shuffleBtn = el.querySelector(".geml-shuffle");
  const repeatBtn = el.querySelector(".geml-repeat");
  let shuffled = el.getAttribute("data-shuffle") === "on";
  let repeat = el.getAttribute("data-repeat") || "off";   // off | all | one
  let at = -1;
  let queue = [];     // 随机：这一轮还没放的，按要放的顺序
  let history = [];   // 随机：这一轮放过的，按放的顺序；正在放的在最后
  let done = false;   // 放到底停下了：再按播放就从头来
  const num = (li, k) => {
    const v = li.getAttribute(k);
    return v === null ? null : Number(v);
  };
  const show = () => {
    el.setAttribute("data-shuffle", shuffled ? "on" : "off");
    el.setAttribute("data-repeat", repeat);
    if (shuffleBtn) shuffleBtn.setAttribute("aria-pressed", shuffled ? "true" : "false");
    if (repeatBtn) {
      repeatBtn.setAttribute("data-mode", repeat);
      repeatBtn.setAttribute("aria-pressed", repeat === "off" ? "false" : "true");
      repeatBtn.setAttribute("aria-label", repeat === "one" ? "单曲重复" : repeat === "all" ? "全部重复" : "不重复");
    }
  };
  // Fisher–Yates。
  const shuffle = (list) => {
    for (let k = list.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      const t = list[k]; list[k] = list[j]; list[j] = t;
    }
    return list;
  };
  const all = () => items.map((_, k) => k);
  const play = () => {
    if (typeof media.play !== "function") return;
    const p = media.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  };
  const stop = () => {
    done = true;
    if (typeof media.pause === "function") media.pause();
  };
  const select = (i, go) => {
    if (i < 0 || i >= n) return;
    at = i;
    done = false;
    items.forEach((li, k) => {
      if (k === i) li.setAttribute("aria-current", "true");
      else li.removeAttribute("aria-current");
    });
    // 设 src 就开始加载；preload 先定好，只是选上（没要播）的那一首什么也不取。
    media.setAttribute("preload", go ? "auto" : "none");
    media.setAttribute("src", items[i].getAttribute("data-src"));
    if (go) play();
  };
  const again = () => {
    media.currentTime = num(items[at], "data-in") ?? 0;
    play();
  };
  // 随机里真放起来的那一首：从队列里拿出来，记进放过的。选上而没放的不算 ——
  // 打开页面时选上的第一首，等它真放了才算这一轮放过。
  const took = (i) => {
    const k = queue.indexOf(i);
    if (k >= 0) queue.splice(k, 1);
    if (history[history.length - 1] !== i) history.push(i);
  };
  const forward = (auto) => {
    if (!shuffled) {
      if (at + 1 < n) select(at + 1, true);
      else if (auto && repeat !== "all") stop();
      else select(0, true);
      return;
    }
    const next = queue.find((k) => k !== at);
    if (next !== undefined) { took(next); select(next, true); return; }
    if (auto && repeat !== "all") stop();
    else newRound();
  };
  // 新的一轮：全部重洗，别让刚放完的那首排第一；记录从它起，上一首还退得回去。
  const newRound = () => {
    queue = shuffle(all());
    history = at >= 0 ? [at] : [];
    if (n > 1 && queue[0] === at) queue.push(queue.shift());
    took(queue[0]);
    select(history[history.length - 1], true);
  };
  const back = () => {
    if (!shuffled) { select(at > 0 ? at - 1 : n - 1, true); return; }
    if (history.length > 1 && history[history.length - 1] === at) {
      queue.unshift(history.pop());
      select(history[history.length - 1], true);
      return;
    }
    // 这一轮没有更早的了：从待放的末尾拿一首，现在这首（放过的话）排回队首。
    const prev = [...queue].reverse().find((k) => k !== at);
    if (prev === undefined) { again(); return; }
    queue.splice(queue.lastIndexOf(prev), 1);
    if (history[history.length - 1] === at && !queue.includes(at)) queue.unshift(at);
    history = [prev];
    select(prev, true);
  };
  const reshuffle = () => {
    queue = shuffle(all().filter((k) => k !== at));
    history = at >= 0 && !media.paused ? [at] : [];
    if (history.length === 0 && at >= 0) queue.unshift(at);
  };
  items.forEach((li, i) => li.querySelector("button")?.addEventListener("click", () => {
    if (shuffled) took(i);
    select(i, true);
  }));
  el.querySelector(".geml-next")?.addEventListener("click", () => forward(false));
  el.querySelector(".geml-prev")?.addEventListener("click", back);
  shuffleBtn?.addEventListener("click", () => {
    shuffled = !shuffled;
    if (shuffled) reshuffle();
    show();
  });
  repeatBtn?.addEventListener("click", () => {
    repeat = repeat === "off" ? "all" : repeat === "all" ? "one" : "off";
    show();
  });
  // 入点只有一个监听，跳的是**当时**选着的那一首：每次换首挂一个一次性的，点得快了
  // 旧的还没等到元数据就留下来，把下一首跳到上一首的入点。
  media.addEventListener("loadedmetadata", () => {
    const start = at < 0 ? null : num(items[at], "data-in");
    if (start !== null) media.currentTime = start;
  });
  // 原生控件上按的播放：放到底停下了，就从头再来（随机是新的一轮）；位置已经出了
  // 这一段（过了 out），就回到入点 —— 不然一放就又碰到 out，立刻停下。按的这一首也
  // 算这一轮放过了。
  media.addEventListener("play", () => {
    if (done) {
      done = false;
      if (shuffled) newRound();
      else select(0, true);
      return;
    }
    if (at < 0) return;
    const start = num(items[at], "data-in") ?? 0;
    const end = num(items[at], "data-out");
    if ((end !== null && media.currentTime >= end) || media.currentTime < start) media.currentTime = start;
    if (shuffled) took(at);
  });
  const ended = () => { if (repeat === "one") again(); else forward(true); };
  media.addEventListener("ended", ended);
  media.addEventListener("timeupdate", () => {
    const end = at < 0 ? null : num(items[at], "data-out");
    if (end !== null && media.currentTime >= end) ended();   // 到了这一段的 out
  });
  // 一开始就随机的，第一首也是随机的：洗好的队首选上、不取数据，放了才算放过。
  if (shuffled) {
    queue = shuffle(all());
    select(queue[0], false);
  } else {
    select(0, false);
  }
  show();
}

export function playlistLive(block, params, ctx) {
  const el = playlist(block, params, ctx);
  if (typeof window !== "undefined") drivePlaylist(el);
  return el;
}
