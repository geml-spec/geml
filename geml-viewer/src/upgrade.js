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

// geml-code-graph (GEP-0003): upgrade .cg-mount placeholders. The slice
// builder (from the reference renderer) is synchronous with a synchronous
// loader; the browser fetches documents asynchronously — so we run the build
// in WAVES: every pass records which documents it needed but did not have,
// those are fetched, and the build re-runs (builds are milliseconds; the wave
// count is bounded by graph-depth). One document cache serves all mounts.
//
//   opts: { buildCodeGraph, parse, runtime,     — from parse-entry.js
//           fetchDoc(relPath) -> Promise<string|null>,
//           selfName?, selfSource? }            — seed for "@self" mounts
export async function upgradeCodeGraph(root, opts) {
  const mounts = Array.from(root.querySelectorAll(".cg-mount[data-src]"));
  if (!mounts.length) return;
  const cache = new Map();
  if (opts.selfName !== undefined) cache.set(opts.selfName, opts.selfSource);
  const failed = new Set();

  // One wave-build, reused for the initial slice AND for the runtime's
  // directed views (the ⊕ callers handle / node-body callee re-build pass a
  // `view`); the document cache is shared, so a re-build only fetches what
  // the new direction actually needs.
  const buildWaves = async (src, view) => {
    let result;
    for (;;) {
      const pending = [];
      result = opts.buildCodeGraph(src, {
        loadDoc: (p) => {
          if (cache.has(p)) return cache.get(p);
          if (!failed.has(p)) pending.push(p);
          return null;
        },
        parseDoc: opts.parse,
      }, view);
      if (!pending.length) break;
      await Promise.all(pending.map(async (p) => {
        try {
          const text = await opts.fetchDoc(p);
          cache.set(p, text);
          if (text === null) failed.add(p);
        } catch {
          cache.set(p, null);
          failed.add(p);
        }
      }));
    }
    return result;
  };

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
    // Live loader for the runtime's caller/callee views (GEP-0003).
    const mountSrc = src;
    mount._cgView = async (view) => {
      const r = await buildWaves(mountSrc, view);
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
