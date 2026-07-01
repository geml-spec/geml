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
