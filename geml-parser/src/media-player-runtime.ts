// 播放器的时钟。**它住在解析器里**，因为时间是解析器算的：`layoutDoc` 说每一刀从第几
// 秒起、放多久，这里只负责按那份结果推真的 `<video>`/`<audio>`——没有哪个元素自己往下
// 播，让它们自由跑就会漂。
//
// 三个宿主用同一份源码：viewer 的组件直接调它；`geml media export --to player` 把它的
// 源码原样内联进静态页；演示页的生成脚本走后者。所以它**不引用模块作用域里的任何东西**
// ——一旦引用，内联那条路就会在浏览器里报 undefined。
//
// 没有 `node:` 依赖，也不碰 DOM 之外的东西。
export function drivePlayer(root: any): void {
  if (!root || root.__gemlDriven) return;
  root.__gemlDriven = true;
  const total = Number(root.getAttribute("data-duration")) || 0;
  const layers = Array.prototype.slice.call(root.querySelectorAll(".geml-layer"));
  const cap = root.querySelector(".geml-caption");
  const btn = root.querySelector(".geml-play");
  const seek = root.querySelector(".geml-seek");
  const clock = root.querySelector(".geml-clock");
  let cues: any[] = [];
  try { cues = JSON.parse(root.getAttribute("data-captions") || "[]"); } catch (e) { cues = []; }

  let t = 0, playing = false, last = 0, unlocked = false;
  let timer: any = 0;
  const fmt2 = (v: number): string => {
    const m = Math.floor(v / 60), s = v - m * 60;
    return String(m) + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
  };
  const num = (el: any, name: string, dflt: number): number => {
    const v = Number(el.getAttribute(name));
    return isFinite(v) ? v : dflt;
  };

  function paint() {
    for (const el of layers) {
      const start = num(el, "data-start", 0), end = num(el, "data-end", 0), inPt = num(el, "data-in", 0);
      if (t >= start && t < end) {
        const want = inPt + (t - start);
        if (Math.abs(el.currentTime - want) > 0.15) { try { el.currentTime = want; } catch (e) { /* 还没 loadedmetadata */ } }
        // 转场只有淡入淡出会动不透明度；cut 什么都不做。
        const td = num(el, "data-transition-dur", 0.3);
        const ti = el.getAttribute("data-transition-in"), to = el.getAttribute("data-transition-out");
        let o = 1;
        if ((ti === "dissolve" || ti === "fade") && t - start < td) o = (t - start) / td;
        if ((to === "dissolve" || to === "fade") && end - t < td) o = Math.min(o, (end - t) / td);
        let g = num(el, "data-gain", 1);
        const fi = num(el, "data-fade-in", 0), fo = num(el, "data-fade-out", 0);
        if (fi > 0 && t - start < fi) g *= (t - start) / fi;
        if (fo > 0 && end - t < fo) g *= (end - t) / fo;
        if (!el.muted) el.volume = Math.max(0, Math.min(1, g));
        el.style.opacity = String(Math.max(0, Math.min(1, o)));
        el.style.visibility = "visible";
        if (playing && el.paused) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
        if (!playing && !el.paused) el.pause();
      } else {
        el.style.visibility = "hidden";
        if (!el.paused) el.pause();
      }
    }
    if (cap) {
      let text = "";
      for (const c of cues) if (t >= c.start && t < c.end) { text = c.text; break; }
      if (cap.textContent !== text) cap.textContent = text;
      cap.style.visibility = text ? "visible" : "hidden";
    }
    if (seek && root.ownerDocument.activeElement !== seek) seek.value = String(t);
    if (clock) clock.textContent = fmt2(t) + " / " + fmt2(total);
  }

  function stop() {
    playing = false;
    if (timer !== 0) { clearInterval(timer); timer = 0; }
    if (btn) btn.textContent = "\u25B6";
    for (const el of layers) if (!el.paused) el.pause();
  }
  // 时钟走 setInterval 而不是 rAF：标签页切到后台时 rAF 完全停摆，而 <video> 照放不误
  // —— 实测第一版就是这样，时钟停在 0:00 而画面已经播到 5s。setInterval 在后台只是被
  // 节流到一秒一次，配合 performance.now() 的差值，时间依然是对的。
  function tick() {
    if (!playing) return;
    const now = performance.now();
    t += (now - last) / 1000;
    last = now;
    if (t >= total) { t = total; stop(); paint(); return; }
    paint();
  }
  function start() {
    if (t >= total) t = 0;
    playing = true;
    if (btn) btn.textContent = "\u23F8";
    last = performance.now();
    // 第一次播放要在用户手势里把每个元素解锁，否则后面才切进来的那些会被自动播放策略挡下。
    if (!unlocked) {
      unlocked = true;
      for (const el of layers) {
        const p = el.play();
        if (p && p.then) p.then(() => { if (el.style.visibility === "hidden") el.pause(); }).catch(() => {});
        else if (el.style.visibility === "hidden") el.pause();
      }
    }
    if (timer !== 0) clearInterval(timer);
    timer = setInterval(tick, 33);
    paint();
  }
  if (btn) btn.addEventListener("click", () => { if (playing) { stop(); paint(); } else start(); });
  if (seek) seek.addEventListener("input", () => { t = Number(seek.value) || 0; last = performance.now(); paint(); });
  root.setAttribute("tabindex", "0");
  root.addEventListener("keydown", (e: any) => {
    if (e.key === " " || e.key === "k") { e.preventDefault(); if (playing) { stop(); paint(); } else start(); }
  });
  paint();
}
