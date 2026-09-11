// 样式入口（profile §1.1）：与文档同目录的 `_index/index.geml`。viewer 的 fetch 是异步的，而
// 解析器的 loadStylesheet 要一个**同步**的 loadDoc —— 所以先把入口引用的每份文件（`default-style`、
// `#sitemap` 对本文档的命中、每条 `embed {src=}`，传递地）预取进一张 Map，再同步喂。
//
// 预取受同一套闸约束：调用方给的 fetchText 已经做了同源/同目录/无凭据/拒 HTML（content.js 里
// 和 src= 表、embed、code-graph 三条路径共用），这里再加深度与文件数上限 —— 样式表和文档一样
// 是不可信输入，一份互相 embed 的样式表不能让 viewer 拉个没完。

export const STYLE_PREFETCH_DEPTH = 8;   // 与解析器的 EMBED_DEPTH_CAP 同值
export const STYLE_PREFETCH_FILES = 32;  // 一页的样式表不该有这么多份
export const STYLE_DOC_BYTES_CAP = 4 * 1024 * 1024; // 与 transclude 的 EMBED_DOC_BYTES_CAP 同值：一份样式表不该有 4 MB

/** 与文档同目录的 `_index/index.geml`。 */
export function entryUrlFor(docUrl) {
  return new URL("_index/index.geml", docUrl).href;
}

/** 用 meta.profile 认入口，不用路径认（§1.1）。 */
export function isStyleEntry(doc) {
  const meta = doc.children.find((b) => b.kind === "block" && b.type === "meta");
  const profile = meta && meta.data ? String(meta.data.profile ?? "") : "";
  return profile.split(/\s+/).includes("geml-style/v1");
}

/** 一份样式表里点名的其它文件：meta 的 default-style、#sitemap 对 forDoc 的命中、每条 embed 的 src 文档部分。 */
function referencedDocs(doc, forDoc) {
  const out = [];
  const meta = doc.children.find((b) => b.kind === "block" && b.type === "meta");
  const dflt = meta && meta.data && typeof meta.data["default-style"] === "string" ? meta.data["default-style"] : "";
  if (dflt) out.push(dflt);
  const sitemap = doc.children.find((b) => b.kind === "block" && b.id === "sitemap");
  const rows = sitemap && sitemap.table ? sitemap.table.rows : [];
  for (const r of rows) {
    if ((r[0]?.text ?? "").trim() !== forDoc) continue;
    const hit = (r[1]?.text ?? "").trim();
    if (hit) out.push(hit);
    break;
  }
  const walk = (nodes) => {
    for (const b of nodes) {
      if (b.kind === "block" && b.type === "embed") {
        const src = typeof b.attrs?.src === "string" ? b.attrs.src.trim() : "";
        const docPath = src.includes("#") ? src.slice(0, src.indexOf("#")) : src;
        if (docPath) out.push(docPath);
      }
      if (b.children) walk(b.children);
    }
  };
  walk(doc.children);
  return out;
}

/**
 * 状态的产生者：视图模型不带"喂它的是哪些块"，宿主接交互时要知道点谁。只认 `type#id` / `#id`
 * 形式的 match（最后一步带 id）；宽选择器不接线，console.warn 说明 —— 接它要解析器把 producer
 * 绑定放进视图模型，那是 profile §10 的变更。
 */
export function producersOf(sheet) {
  const producers = new Map();
  for (const s of sheet.states) {
    const ids = new Set();
    for (const br of s.match) {
      const last = br.steps[br.steps.length - 1];
      if (last && last.id) ids.add(`#${last.id}`);
      else console.warn(`[geml-viewer] state #${s.id}: only \`type#id\` producers are wired; \`${br.source}\` is not`);
    }
    producers.set(s.id, ids);
  }
  return producers;
}

/**
 * 文档 `embed` 指向的那些文档 —— 取回来当**语料**，不并进宿主。
 *
 * 为什么不并：并进来就要回答「借来的 `#topology` 在宿主里叫什么」，撞 id 只是时间问题。
 * 而 `resolveStyle` 收的本来就是 `CorpusDoc[]`、每条绑定都带 `doc`，地址天生按文档限定
 * （`PUBLISHING.geml#topology`，§5.2 的写法），所以加一份语料就够，什么都不用改名。
 * 原文也留着：`view=source` 要显示源码，而 embed 块自己没有 raw —— 内容在借来的那一份里。
 *
 * 取不到就少一份语料，页面照画 —— 借来的块指不到时样式表会报 unmatched-rule，不会静默。
 * 同源、无凭据、拒 HTML 那道闸在调用方给的 `fetchText` 里：扩展走后台读盘或同源 fetch，
 * playground 走普通 fetch，两边的取法不同，**挑出哪些文档**这件事只有这一份实现。
 */
export async function borrowedDocs(model, parse, fetchText, baseUrl) {
  const srcs = new Set();
  const walk = (nodes) => {
    for (const b of nodes ?? []) {
      if (b.kind === "block" && b.type === "embed" && typeof b.attrs?.src === "string") {
        const src = b.attrs.src.trim();
        // `other.geml#id` 借的是一个块，文档还是那一份 —— 取文档那一半。
        const doc = src.includes("#") ? src.slice(0, src.indexOf("#")) : src;
        if (doc) srcs.add(doc);
      }
      if (b.children) walk(b.children);
    }
  };
  walk(model.children);
  const out = [];
  for (const rel of srcs) {
    try {
      const text = await fetchText(new URL(rel, baseUrl).href);
      if (text == null) continue;
      out.push({ path: rel, doc: parse(text), text });
    } catch { /* 取不到就算了 —— 少一份语料，不是错误 */ }
  }
  return out;
}

/**
 * 找到并求解本页的样式。返回 null = 没有样式入口（或入口不认、或预取超限）；
 * 否则 { vm, forDoc, producers, errors }。errors 非空时 content.js 退回默认渲染并把它们画成横幅。
 */
export async function loadPageStyle({ docUrl, fetchText, parse, loadStylesheet, resolveStyle, model, components, docs = [] }) {
  const entryUrl = entryUrlFor(docUrl);
  const entryText = await fetchText(entryUrl);
  if (entryText == null) return null;
  let entryDoc;
  try { entryDoc = parse(entryText); } catch { return null; }
  if (!isStyleEntry(entryDoc)) return null;

  const forDoc = decodeURIComponent(new URL(docUrl).pathname.split("/").pop() || "");
  // 相对路径 → 文本。键是**相对 _index/ 的原样路径**，loadStylesheet 就是拿它来查的。
  const cache = new Map();
  const queue = referencedDocs(entryDoc, forDoc).map((rel) => ({ rel, depth: 1 }));
  let files = 0;
  while (queue.length > 0) {
    const { rel, depth } = queue.shift();
    if (cache.has(rel) || depth > STYLE_PREFETCH_DEPTH) continue;
    if (++files > STYLE_PREFETCH_FILES) {
      console.warn(`[geml-viewer] style entry references more than ${STYLE_PREFETCH_FILES} files; ignoring it`);
      return null;
    }
    const text = await fetchText(new URL(rel, entryUrl).href);
    if (text == null) { cache.set(rel, null); continue; } // 记下"读不到"，loadStylesheet 会报 style-embed-not-expanded
    if (text.length > STYLE_DOC_BYTES_CAP) {
      console.warn(`[geml-viewer] stylesheet \`${rel}\` is larger than ${STYLE_DOC_BYTES_CAP} bytes; treated as unreadable`);
      cache.set(rel, null);
      continue;
    }
    cache.set(rel, text);
    let sub;
    try { sub = parse(text); } catch { continue; }
    // 被 embed 的可能也是一份清单 —— 只跟它的 default-style（解析器的规则），sitemap 不跟
    for (const next of referencedDocs(sub, "")) queue.push({ rel: next, depth: depth + 1 });
  }

  const sheet = loadStylesheet(entryDoc, {
    loadDoc: (rel) => cache.get(rel) ?? null,
    parseDoc: (s) => parse(s),
    forDoc,
  });
  // 宿主的组件注册表要往下传，否则 `unknown-component` 这条检查根本不跑 —— 写错组件名
  // 会静默退回默认渲染，一声不吭（GitHub 复刻里 `component=global-header` 就是这么没的）。
  // 宿主 + 它借来的文档一起进语料。地址天然按文档限定（`PUBLISHING.geml#topology`），
  // 所以不需要把借来的块并进宿主，也就不会撞 id。
  const corpus = [{ path: forDoc, doc: model }, ...docs];
  const vm = resolveStyle(sheet, corpus, components ? { components } : undefined);
  return { vm, forDoc, corpus, producers: producersOf(sheet), errors: vm.diagnostics.filter((d) => d.severity === "error") };
}
