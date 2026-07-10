// Upgrade rendered GEML placeholders in place, using KaTeX + Mermaid. Pure DOM
// plus injected libraries, so the extension (content.js) and the web playground
// share one implementation — and one mermaid-normalization fix. `root` scopes
// the queries; `katex` / `mermaid` are passed in so each caller owns its imports.

export function upgradeMath(root, katex) {
  for (const span of root.querySelectorAll(".geml-math")) {
    const tex = span.getAttribute("data-tex");
    try { katex.render(tex, span, { throwOnError: false }); } catch { /* keep source fallback */ }
  }
  for (const div of root.querySelectorAll(".geml-math-display")) {
    const tex = div.getAttribute("data-tex");
    try { katex.render(tex, div, { displayMode: true, throwOnError: false }); } catch { /* keep fallback */ }
  }
}

export async function upgradeMermaid(root, mermaid) {
  const nodes = [...root.querySelectorAll(".geml-mermaid")];
  if (!nodes.length) return;
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  } catch (e) {
    console.error("[geml] mermaid init failed:", e);
    return; // mermaid unavailable
  }
  let i = 0;
  for (const node of nodes) {
    const src = normalizeMermaid(node.textContent || "");
    if (!src) continue;
    try {
      // Programmatic render from the source string with a unique id. Unlike
      // run({nodes}), this never parses an element twice — the double-processing
      // that otherwise surfaces as a spurious "Syntax error in text".
      const { svg } = await mermaid.render(`geml-mermaid-${i++}`, src);
      // securityLevel:"strict" makes mermaid sanitize the SVG (DOMPurify) before
      // returning it, so inserting it is safe even for untrusted remote docs.
      node.innerHTML = svg;
    } catch (e) {
      // Keep the source text visible as a fallback, but surface why it failed.
      console.error("[geml] mermaid render failed:", e);
    }
  }
}

// D2 placeholders (.geml-d2) are upgraded with SVG strings produced elsewhere:
// the extension renders them in a sandboxed iframe (WASM engine + blob worker,
// which MV3 page CSP would forbid anywhere else), so this function only takes
// `renderAll(sources) -> Promise<[{svg}|{error}]>` — ONE batched call for all
// placeholders — and swaps the results in. A failure keeps the source text
// visible, like mermaid's failure path.
export async function upgradeD2(root, renderAll) {
  const nodes = [...root.querySelectorAll(".geml-d2")];
  if (!nodes.length) return;
  let results;
  try {
    results = await renderAll(nodes.map((n) => n.textContent || ""));
  } catch (e) {
    console.error("[geml] d2 render failed:", e);
    return; // keep every source fallback
  }
  nodes.forEach((node, i) => {
    const r = (results && results[i]) || { error: "no result" };
    // The SVG comes from the D2 engine over a couple of message hops; a basic
    // guard against anything script-bearing before it is inserted.
    const bad = r.svg !== undefined && /<script/i.test(r.svg);
    if (r.svg !== undefined && !bad) {
      const wrap = node.ownerDocument.createElement("div");
      wrap.innerHTML = r.svg;
      node.replaceChildren(wrap);
      return;
    }
    // Keep the source text visible as a fallback, but surface why it failed.
    const err = bad ? "unsafe svg rejected" : String(r.error ?? "unknown error");
    console.error("[geml] d2 render failed:", err);
    const note = node.ownerDocument.createElement("p");
    note.className = "geml-d2-error";
    note.textContent = `d2: ${err}`;
    node.appendChild(note);
  });
}

// Mermaid v11 is picky about whitespace between tokens — notably multiple spaces
// after an edge label (`|label|   Node`). GEML preserves the author's alignment
// spacing, so normalize before handing the source to mermaid; the placeholder
// keeps the original text as the fallback.
export function normalizeMermaid(s) {
  return s
    .replace(/\r/g, "")
    .split("\n").map((l) => l.replace(/\s+$/, "")).join("\n")
    .replace(/(\|[^|\n]*\|) +/g, "$1 ")
    .trim();
}

// geml-code-graph (GEP-0003): upgrade .cg-mount placeholders. The async wave
// builder lives in the reference renderer (codeGraphWaves — one
// implementation, shared with the live script on served pages) and is
// injected here as opts.waves so this file stays import-free.
//
//   opts: { waves, parse, runtime,              — from parse-entry.js
//           fetchDoc(relPath) -> Promise<string|null>,
//           selfName?, selfSource? }            — seed for "@self" mounts
export async function upgradeCodeGraph(root, opts) {
  const mounts = Array.from(root.querySelectorAll(".cg-mount[data-src]"));
  if (!mounts.length) return;
  // One wave-builder for all mounts and all directed re-builds (⊕ callers /
  // node-body callee views pass a `view`): its document cache means a
  // re-build only fetches what the new direction actually needs.
  const w = opts.waves(opts.fetchDoc, opts.parse);
  if (opts.selfName !== undefined) w.seed(opts.selfName, opts.selfSource);
  const buildWaves = (src, view) => w.build(src, view);

  for (const mount of mounts) {
    let src = mount.getAttribute("data-src");
    if (src === "@self") {
      if (opts.selfName === undefined) { mount.textContent = "geml-code-graph: no self source"; continue; }
      src = opts.selfName;
    }
    const result = await buildWaves(src);
    if (result.error !== undefined) {
      mount.textContent = "geml-code-graph: " + result.error;
      continue;
    }
    mount.textContent = "";
    mount.setAttribute("data-graph", JSON.stringify(result.data));
    // Live loader for the runtime's directed views and in-place document
    // navigation (GEP-0003): {dir,node} = caller/callee chain of one node,
    // built from the node's OWN document (its meta names the module and
    // graph-depth); {doc} = another codemap document's default view
    // (breadcrumb / module click) — the embed walks the geml tree without
    // leaving the page.
    const mountSrc = src;
    mount._cgView = async (view) => {
      const from = view && view.doc ? view.doc
        : view && view.node ? view.node.slice(0, view.node.lastIndexOf("#"))
        : mountSrc;
      const r = await buildWaves(from, view && view.doc ? undefined : view);
      return r.error !== undefined ? null : r.data;
    };
    if (result.truncated) {
      const note = mount.ownerDocument.createElement("p");
      note.className = "cg-note";
      note.textContent = "slice truncated — narrow the entry set or lower graph-depth";
      mount.parentNode.insertBefore(note, mount.nextSibling);
    }
  }
  opts.runtime(root);
}
