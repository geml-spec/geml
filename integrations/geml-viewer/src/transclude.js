// Async post-render pass: expand `=== embed` transclusions in place (S7).
//
// render.js paints every embed synchronously as a degraded link
// (.geml-transclusion-unexpanded) — first paint never waits on the network.
// This pass then fetches each target document through a caller-supplied
// fetchText (content.js applies the same-origin gate there, exactly like the
// src= table fetch and the code-graph fetchDoc), selects the addressed slice,
// renders it with the same renderBlock the host document used, and swaps it
// into the wrapper. Anything refused keeps the link and gains a visible note —
// the reader sees what was borrowed and why it did not expand, never a blank.
//
// Selection semantics and every guard mirror geml-parser/src/render.ts:
//   - no fragment → the whole document minus `=== meta` blocks;
//   - a heading id → that heading plus its section (until the next heading of
//     the same or higher level);
//   - cycle key `absUrl[#anchor]` over the expansion chain, so A→B→A and the
//     self-including heading slice both stop with a readable chain;
//   - depth / expansion-count / byte budgets with the parser's cap values;
//   - borrowed content owns no anchors on the host page: ids are stripped and
//     fragment links are rewritten to point back at the source document.

import { renderBlock, collectLabels } from "./render.js";

export const EMBED_DEPTH_CAP = 8;
export const EMBED_TOTAL_CAP = 1000; // expansions per page
export const EMBED_BYTES_CAP = 8 * 1024 * 1024; // rendered bytes per page
export const EMBED_DOC_BYTES_CAP = 4 * 1024 * 1024; // a single fetched document

// opts: { parse, fetchText(absUrl)→text|null, docUrl, children, caps? }.
// `children` is the host document's parsed model — a same-document `src=#id`
// selects from it without touching the network. caps exists for tests.
export async function expandTransclusions(container, opts) {
  const caps = {
    depth: opts.caps?.depth ?? EMBED_DEPTH_CAP,
    total: opts.caps?.total ?? EMBED_TOTAL_CAP,
    bytes: opts.caps?.bytes ?? EMBED_BYTES_CAP,
    docBytes: opts.caps?.docBytes ?? EMBED_DOC_BYTES_CAP,
  };
  const state = { count: 0, bytes: 0, docs: new Map(), caps, parse: opts.parse, fetchText: opts.fetchText };
  // location.href may carry a #fragment; the base a relative src resolves
  // against (and the same-document cycle key) must not.
  const baseUrl = String(opts.docUrl).replace(/#.*$/, "");
  for (const el of [...container.querySelectorAll("div.geml-transclusion-unexpanded[data-src]")]) {
    await expandOne(el, baseUrl, opts.children || [], [], state);
  }
}

// One wrapper div. `curUrl`/`curChildren` are the document the embed is
// WRITTEN in — inside borrowed content that is the borrowed document, not the
// host — so relative paths and `src=#id` resolve the way the author of that
// document meant them. `stack` is the chain of expansion keys above this node.
async function expandOne(el, curUrl, curChildren, stack, state) {
  const dom = el.ownerDocument;
  const written = (el.getAttribute("data-src") || "").trim();
  if (written === "") return; // renderer already labelled the missing/blanked src=

  const hash = written.indexOf("#");
  const docPath = hash < 0 ? written : written.slice(0, hash);
  const anchor = hash < 0 ? undefined : written.slice(hash + 1);

  let rel = curUrl;
  if (docPath !== "") {
    try {
      rel = new URL(docPath, curUrl).href.replace(/#.*$/, "");
    } catch {
      return note(el, "invalid", `cannot resolve \`${docPath}\``);
    }
  }
  const key = anchor === undefined ? rel : `${rel}#${anchor}`;

  if (stack.includes(key)) {
    el.className = "geml-transclusion geml-transclusion-error";
    el.textContent = `transclusion cycle: ${[...stack, key].join(" → ")}`;
    return;
  }
  if (stack.length >= state.caps.depth) {
    return note(el, "too-deep", `transclusion depth cap (${state.caps.depth}) reached`);
  }
  if (state.count >= state.caps.total) {
    return note(el, "too-large", `transclusion budget spent (${state.caps.total} expansions)`);
  }
  if (state.bytes >= state.caps.bytes) {
    return note(el, "too-large", `transclusion budget spent (${state.caps.bytes} bytes)`);
  }
  if (docPath !== "" && !/\.geml$/i.test(docPath)) {
    return note(el, "invalid", `\`${docPath}\` is not a GEML document`);
  }

  let children = curChildren;
  if (docPath !== "") {
    const loaded = await loadChildren(rel, state);
    if (loaded === null) return note(el, "unresolved", `cannot resolve document \`${docPath}\`, or it is too large`);
    children = loaded;
  }

  const picked = selectEmbed(children, anchor);
  if (picked === null) {
    const what = docPath === "" ? `no \`${written}\` in this document` : `no \`#${anchor}\` in \`${docPath}\``;
    return note(el, "unresolved", what);
  }

  // Render the borrowed slice with the SOURCE document's labels, so its
  // [[#id]] auto-references keep the text their own document gives them.
  const labels = collectLabels(children);
  const nodes = [];
  for (const b of picked) {
    const n = renderBlock(b, dom, labels);
    if (n) nodes.push(n);
  }
  el.replaceChildren(...nodes);
  el.className = "geml-transclusion geml-transclusion-expanded";
  state.count++;
  state.bytes += el.innerHTML.length;

  // S9 — borrowed content owns no anchors on the host page: demote ids to
  // data-embed-id (kept for styling/debugging, host namespace unpolluted).
  // The wrapper keeps its own host-document id.
  for (const n of el.querySelectorAll("[id]")) {
    n.setAttribute("data-embed-id", n.getAttribute("id"));
    n.removeAttribute("id");
  }
  // S4 — borrowed content resolves like it renders at home: fragment links
  // point back at the document they are anchors OF, and relative href/src
  // rebase onto the source document's URL (a borrowed `![](img/pic.png)`
  // must load the SOURCE's image, not a host-relative miss). A same-document
  // expansion skips all of this — its anchors and paths already mean this page.
  if (docPath !== "") {
    for (const a of el.querySelectorAll("a[href]")) {
      const h = a.getAttribute("href");
      if (h.startsWith("#")) a.setAttribute("href", rel + h);
      else if (isRelativeUrl(h)) a.setAttribute("href", rebase(h, rel));
    }
    for (const m of el.querySelectorAll("img[src], audio[src], video[src]")) {
      const s = m.getAttribute("src");
      if (isRelativeUrl(s)) m.setAttribute("src", rebase(s, rel));
    }
  }

  // Borrowed content may itself embed: recurse with ITS document as the base.
  for (const nested of [...el.querySelectorAll("div.geml-transclusion-unexpanded[data-src]")]) {
    await expandOne(nested, rel, children, [...stack, key], state);
  }
}

// Refusal: keep the degraded link, add a kind class and a visible note.
function note(el, why, text) {
  el.classList.add(`geml-transclusion-${why}`);
  el.setAttribute("title", text);
  let span = el.querySelector(".geml-transclusion-note");
  if (!span) {
    span = el.ownerDocument.createElement("span");
    span.className = "geml-transclusion-note";
    el.appendChild(span);
  }
  span.textContent = text;
}

// Fetch + parse, memoized per absolute URL (nulls too — a refused document is
// refused once, not once per embed). The per-document byte cap is applied to
// the raw text before parsing.
async function loadChildren(absUrl, state) {
  if (state.docs.has(absUrl)) return state.docs.get(absUrl);
  let children = null;
  try {
    const text = await state.fetchText(absUrl);
    if (typeof text === "string" && text.length <= state.caps.docBytes) {
      children = state.parse(text).children || [];
    }
  } catch {
    children = null;
  }
  state.docs.set(absUrl, children);
  return children;
}

// A path with no scheme, not protocol-relative, not a bare fragment. Only
// these rebase — absolute http(s), data:, mailto: and `#…` keep their meaning.
function isRelativeUrl(u) {
  return typeof u === "string" && u !== "" && !u.startsWith("#") && !u.startsWith("//")
    && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u);
}
function rebase(u, baseUrl) {
  try { return new URL(u, baseUrl).href; } catch { return u; }
}

// --- target selection, ported verbatim from geml-parser/src/render.ts ------

function selectEmbed(children, anchor) {
  if (anchor === undefined) return children.filter((b) => !(b.kind === "block" && b.type === "meta"));
  return findEmbedTarget(children, anchor);
}

function findEmbedTarget(blocks, id) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === "heading" && b.id === id) {
      const out = [b];
      for (let j = i + 1; j < blocks.length; j++) {
        const next = blocks[j];
        if (next.kind === "heading" && next.level <= b.level) break;
        out.push(next);
      }
      return out;
    }
    if (b.kind === "block" && b.id === id) return [b];
    if (b.kind === "block" && b.children) {
      const inner = findEmbedTarget(b.children, id);
      if (inner !== null) return inner;
    }
  }
  return null;
}
