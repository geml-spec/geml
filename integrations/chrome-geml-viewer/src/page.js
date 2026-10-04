// 页面布局（计划 F）：文档旁边有样式入口（`_index/index.geml`）就按它画整页。扩展（content.js）
// 和 playground 包（主页的演示页）共用这一份 —— 一页怎么画只有一处实现，两个宿主只在「怎么取文件」
// 和「这一页的 CSS 放进哪个 <style>」上不同。

import { parse, loadStylesheet, resolveStyle } from "./parse-entry.js";
import { renderDocument, renderBlock, collectLabels } from "./render.js";
import { loadPageStyle, borrowedDocs } from "./style-entry.js";
import { renderPage } from "./layout.js";
import { createState, COMPONENTS } from "./components.js";

/**
 * 找到并求解本页的样式。返回 null = 文档旁边没有样式入口（或入口不认、或预取超限）。
 * `fetchText` 是宿主的同源闸：扩展走后台读盘或同源 fetch，playground 走普通 fetch。
 */
export async function loadPage({ docUrl, raw, model, fetchText }) {
  const page = await loadPageStyle({
    docUrl, fetchText, parse, loadStylesheet, resolveStyle, model,
    // 文档 embed 进来的那些也进语料 —— 样式才指得到借来的块（地址是 `other.geml#id`）。
    // 同一道同源闸；取不到就少一份语料，页面照画。入口认下之后才取。
    borrow: () => borrowedDocs(model, parse, fetchText, docUrl),
    // 注册表往下传，unknown-component 才检查得起来（否则组件名写错静默退回默认渲染）。
    components: Object.keys(COMPONENTS),
  });
  // 宿主文档的原文也进语料：`view=source` 要按行段切出块的源码。借来的文档在 borrowedDocs 里已带 text。
  if (page && page.corpus && page.corpus[0]) page.corpus[0].text = raw;
  return page;
}

/**
 * 画一页；样式表有错或 screen 数不是 1 时退回默认文档并在顶上说明。
 * 返回 { root, usedLayout, css }：css 是这一页的样式，由宿主放进它自己的 <style>；退回时为 null。
 */
export function paintPage(page, model, dom, focus) {
  const banner = (text) => {
    const d = dom.createElement("div");
    d.className = "geml-diag geml-diag-error";
    d.textContent = text;
    return d;
  };
  if (page.errors.length > 0) {
    const root = renderDocument(model, dom, focus);
    root.prepend(banner(`stylesheet has ${page.errors.length} error(s); rendering without it — ` + page.errors.map((d) => `${d.code}: ${d.message}`).join(" · ")));
    return { root, usedLayout: false, css: null };
  }
  const state = createState(page.vm, dom);
  const out = renderPage(page.vm, model, dom, {
    renderBlock, labels: collectLabels(model.children), components: COMPONENTS, state, producers: page.producers,
    corpus: page.corpus, docUrl: page.docUrl,
  });
  if (out.error) {
    const root = renderDocument(model, dom, focus);
    root.prepend(banner(`stylesheet: ${out.error}; rendering without it`));
    return { root, usedLayout: false, css: null };
  }
  if (out.unplaced > 0) console.info(`[geml-viewer] ${out.unplaced} block(s) are placed by no slot and are not shown`);
  for (const line of out.unsafe) console.warn(`[geml-viewer] stylesheet value dropped — ${line}`);
  return { root: out.root, usedLayout: true, css: out.css };
}
