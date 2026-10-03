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

/** `a/b/../c` → `a/c`；越过起点的 `..` 留在开头（相对 `_index/` 的根就是 `..`）。 */
function normalizePath(p) {
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}
const dirOf = (name) => (name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "");
/** GEML §3.3：写在 `from` 里的 `path` 先对 `from` 的目录解析，再对根目录（`_index/` 的上一级）。 */
function candidatesFor(path, from) {
  // 带 scheme 的、以 `/` 开头的（含 `//host`）原样交给 URL 解析和 fetchText 的同源闸 ——
  // 拼目录、规范化只对普通相对路径做，否则 `//evil.example/x` 会被压成一个同源的相对路径。
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/")) return [path];
  const near = normalizePath(dirOf(from) ? `${dirOf(from)}/${path}` : path);
  const root = normalizePath(`../${path}`);
  return near === root ? [near] : [near, root];
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
  // profile §3：语料里的 `embed` 指到的每份 GEML 文档整份进语料，每份一次，按读语料时依次
  // 遇到的顺序加入，加入的文档自己的 `embed` 也算。路径相对本页所在目录。
  const embedsOf = (nodes, into) => {
    for (const b of nodes ?? []) {
      if (b.kind === "block" && b.type === "embed" && typeof b.attrs?.src === "string") {
        const src = b.attrs.src.trim();
        // `other.geml#id` 借的是一个块，文档还是那一份 —— 取文档那一半。
        const doc = src.includes("#") ? src.slice(0, src.indexOf("#")) : src;
        if (/\.geml$/i.test(doc)) into.push(doc);
      }
      if (b.children) embedsOf(b.children, into);
    }
  };
  const dir = new URL(".", baseUrl).href;
  const seen = new Set([new URL(baseUrl).href.split("#")[0]]);
  const out = [];
  const queue = [{ doc: model, url: baseUrl }];
  while (queue.length > 0) {
    const { doc, url } = queue.shift();
    const srcs = [];
    embedsOf(doc.children, srcs);
    for (const rel of srcs) {
      const target = new URL(rel, url).href.split("#")[0];
      if (seen.has(target)) continue;
      seen.add(target);
      if (out.length >= STYLE_PREFETCH_FILES) return out;
      try {
        const text = await fetchText(target);
        if (text == null) continue;
        const parsed = parse(text);
        const path = target.startsWith(dir) ? decodeURIComponent(target.slice(dir.length)) : target;
        out.push({ path, doc: parsed, text });
        queue.push({ doc: parsed, url: target });
      } catch { /* 取不到就算了 —— 少一份语料，不是错误 */ }
    }
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
  // 名字都相对 `_index/`；入口自己叫 `index.geml`。每份文件按写它的那份文件的目录解析，
  // 再按根目录（GEML §3.3），所以预取两处都试，按装载器会用的顺序。
  const cache = new Map();
  const SELF = "index.geml";
  const queue = referencedDocs(entryDoc, forDoc).map((path) => ({ path, from: SELF, depth: 1 }));
  let files = 0;
  const fetchOne = async (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    if (++files > STYLE_PREFETCH_FILES) return undefined;
    const text = await fetchText(new URL(rel, entryUrl).href);
    if (text == null) { cache.set(rel, null); return null; } // 记下"读不到"，loadStylesheet 会报 style-embed-not-expanded
    if (text.length > STYLE_DOC_BYTES_CAP) {
      console.warn(`[geml-viewer] stylesheet \`${rel}\` is larger than ${STYLE_DOC_BYTES_CAP} bytes; treated as unreadable`);
      cache.set(rel, null);
      return null;
    }
    cache.set(rel, text);
    return text;
  };
  while (queue.length > 0) {
    const { path, from, depth } = queue.shift();
    if (depth > STYLE_PREFETCH_DEPTH) continue;
    let name = null;
    let text = null;
    for (const rel of candidatesFor(path, from)) {
      const got = await fetchOne(rel);
      if (got === undefined) {
        console.warn(`[geml-viewer] style entry references more than ${STYLE_PREFETCH_FILES} files; ignoring it`);
        return null;
      }
      if (got !== null) { name = rel; text = got; break; }
    }
    if (text === null) continue;
    let sub;
    try { sub = parse(text); } catch { continue; }
    // 被 embed 的可能也是一份清单 —— 只跟它的 default-style（解析器的规则），sitemap 不跟
    for (const next of referencedDocs(sub, "")) queue.push({ path: next, from: name, depth: depth + 1 });
  }

  const sheet = loadStylesheet(entryDoc, {
    loadDoc: (path, from) => {
      for (const rel of candidatesFor(path, from)) {
        const text = cache.get(rel);
        if (typeof text === "string") return { name: rel, text };
      }
      return null;
    },
    parseDoc: (s) => parse(s),
    forDoc,
    self: SELF,
  });
  // 宿主的组件注册表要往下传，否则 `unknown-component` 这条检查根本不跑 —— 写错组件名
  // 会静默退回默认渲染，一声不吭（GitHub 复刻里 `component=global-header` 就是这么没的）。
  // 宿主 + 它借来的文档一起进语料。地址天然按文档限定（`PUBLISHING.geml#topology`），
  // 所以不需要把借来的块并进宿主，也就不会撞 id。
  const corpus = [{ path: forDoc, doc: model }, ...docs];
  const vm = resolveStyle(sheet, corpus, components ? { components } : undefined);
  return { vm, forDoc, corpus, producers: producersOf(sheet), errors: vm.diagnostics.filter((d) => d.severity === "error") };
}
