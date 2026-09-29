// 舞台页的测试场景：一个随 t 平移的方块，颜色随语言。不进分镜表。
import { el, once, C } from "./lib.js";

export default {
  render(t, root, { lang } = { lang: "zh" }) {
    const s = once(root, (r) => {
      const box = el("div", { position: "absolute", top: "400px", width: "200px", height: "200px", background: C.accent });
      r.append(box);
      return { box };
    });
    s.box.style.left = `${Math.round(t * 800)}px`;
    s.box.style.background = lang === "en" ? C.ok : C.accent;
  },
};
