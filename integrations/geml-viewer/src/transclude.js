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

import { renderBlock, renderInlines, collectLabels } from "./render.js";
import { hasSrcTable, inlineSrcTables, looksTabular } from "./inline-src.js";
import { resolveTarget, selectEmbed } from "./parse-entry.js";
import { translateSlice } from "./translate-browser.js";

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
  // The DEFAULT comes from the host document — the projection — and stays the
  // host's as expansion descends into borrowed documents.
  const metaBlock = (opts.children || []).find((b) => b.kind === "block" && b.type === "meta");
  const state = {
    count: 0, bytes: 0, docs: new Map(), caps, parse: opts.parse, fetchText: opts.fetchText,
    docMeta: metaBlock?.data ?? {},
  };
  // location.href may carry a #fragment; the base a relative src resolves
  // against (and the same-document cycle key) must not.
  const baseUrl = String(opts.docUrl).replace(/#.*$/, "");
  for (const el of [...container.querySelectorAll("div.geml-transclusion-unexpanded[data-src]")]) {
    await expandOne(el, baseUrl, opts.children || [], [], state);
  }
  // Inline projections (`![[#id]]`) go through the same fetch, the same caps and
  // the same cycle key — only the selection rule and the swap differ. They used
  // to be skipped entirely, so a phrase stayed a link in the browser while the
  // reference renderer expanded it: the same document read two ways.
  for (const el of [...container.querySelectorAll(INLINE_SELECTOR)]) {
    await expandOneInline(el, baseUrl, opts.children || [], [], state);
  }
}

const INLINE_SELECTOR = "a.geml-transclusion-inline-unexpanded[data-src]";

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

  // GEP 0010 — `part=` narrows a heading's section to its heading line, its body
  // or its lead-in. Same function the reference renderer calls, so the browser
  // cannot draw the line somewhere else.
  const asked = (el.getAttribute("data-part") || "whole").trim();
  const picked = selectEmbed(children, anchor,
    asked === "head" || asked === "body" || asked === "intro" ? asked : "whole");
  if (picked === null) {
    const what = docPath === "" ? `no \`${written}\` in this document` : `no \`#${anchor}\` in \`${docPath}\``;
    return note(el, "unresolved", what);
  }

  // GEP 0010 — a language-axis projection. `lang=` asks for a target language and
  // `translator="none"` holds this embed back; the browser's on-device Translator
  // does the work, so the borrowed text never leaves the machine. A refusal is
  // NOTED and the source shown, never swallowed: a projection that silently
  // renders its source reads as a translation that happens to look English.
  // Render the borrowed slice with the SOURCE document's labels, so its
  // [[#id]] auto-references keep the text their own document gives them.
  const labels = collectLabels(children);
  const paint = (slice) => {
    const nodes = [];
    for (const b of slice) {
      const n = renderBlock(b, dom, labels);
      if (n) nodes.push(n);
    }
    el.replaceChildren(...nodes);
  };

  // `translate-to` on the embed overrides the document default from `=== meta`;
  // `none` there holds this one back. Resolved by the parser's own rule so the
  // browser and the Markdown export cannot read one document two ways.
  let slice = picked;
  const want = resolveTarget(state.docMeta, {
    ...(el.hasAttribute("data-translate-to") ? { "translate-to": el.getAttribute("data-translate-to") } : {}),
  });
  if (want !== null) {
    const r = await translateSlice(picked, want);
    if (r.ok) slice = r.blocks;
    else {
      el.setAttribute("data-translation-note", r.why);
      // The model is absent and Chrome will only fetch one under a user
      // activation. So: show the source, and offer the gesture. Clicking is the
      // gesture, which is also the moment the reader agrees to a download.
      if (r.needsGesture) el.dataset.gemlTranslateOffer = want;
      else el.dataset.gemlTranslateRefused = r.why;
    }
  }
  paint(slice);
  if (el.dataset.gemlTranslateOffer) offerTranslation(el, dom, want, picked, paint);
  else if (el.dataset.gemlTranslateRefused) refusalNote(el, dom, want, el.dataset.gemlTranslateRefused);
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

// One inline projection. Every guard above applies unchanged — depth, count,
// bytes, the cycle key, the `.geml` extension check, the same-origin fetch — so
// an inline phrase cannot buy a budget a block embed would be refused. Two
// things differ: what may be projected (a `text` block holding ONE paragraph,
// the rule the parser enforces), and that a refusal leaves the link exactly as
// the first paint drew it, since a phrase has nowhere to put a note.
async function expandOneInline(el, curUrl, curChildren, stack, state) {
  const dom = el.ownerDocument;
  const written = (el.getAttribute("data-src") || "").trim();
  if (written === "") return;

  const hash = written.indexOf("#");
  const docPath = hash < 0 ? "" : written.slice(0, hash);
  const anchor = hash < 0 ? written : written.slice(hash + 1);
  if (anchor === "") return refuseInline(el, "invalid", `\`${written}\` names no block`);

  let rel = curUrl;
  if (docPath !== "") {
    try { rel = new URL(docPath, curUrl).href.replace(/#.*$/, ""); }
    catch { return refuseInline(el, "invalid", `cannot resolve \`${docPath}\``); }
  }
  const key = `${rel}#${anchor}`;

  if (stack.includes(key)) return refuseInline(el, "error", `transclusion cycle: ${[...stack, key].join(" → ")}`);
  if (stack.length >= state.caps.depth) return refuseInline(el, "too-deep", `transclusion depth cap (${state.caps.depth}) reached`);
  if (state.count >= state.caps.total) return refuseInline(el, "too-large", `transclusion budget spent (${state.caps.total} expansions)`);
  if (state.bytes >= state.caps.bytes) return refuseInline(el, "too-large", `transclusion budget spent (${state.caps.bytes} bytes)`);
  if (docPath !== "" && !/\.geml$/i.test(docPath)) return refuseInline(el, "invalid", `\`${docPath}\` is not a GEML document`);

  let children = curChildren;
  if (docPath !== "") {
    const loaded = await loadChildren(rel, state);
    if (loaded === null) return refuseInline(el, "unresolved", `cannot resolve document \`${docPath}\`, or it is too large`);
    children = loaded;
  }

  const picked = selectProject(children, anchor);
  if (picked === null) {
    const what = docPath === "" ? `no \`#${anchor}\` in this document` : `no \`#${anchor}\` in \`${docPath}\``;
    return refuseInline(el, "unresolved", what);
  }
  if (picked === "not-inline") return refuseInline(el, "unresolved", `\`#${anchor}\` is not inline content`);

  // A phrase, not a block: swap the <a> for a <span> carrying the borrowed
  // inlines, rendered with the SOURCE document's labels so its [[#id]] keeps
  // the text its own document gives it.
  const span = dom.createElement("span");
  span.className = "geml-transclusion-inline geml-transclusion-inline-expanded";
  span.setAttribute("data-src", written);
  span.appendChild(renderInlines(picked, dom, collectLabels(children)));
  el.replaceWith(span);
  state.count++;
  state.bytes += span.innerHTML.length;

  // S9/S4, as for a block: borrowed content owns no anchors here, and its
  // relative links mean the document it came from.
  for (const n of span.querySelectorAll("[id]")) {
    n.setAttribute("data-embed-id", n.getAttribute("id"));
    n.removeAttribute("id");
  }
  if (docPath !== "") {
    for (const a of span.querySelectorAll("a[href]")) {
      const h = a.getAttribute("href");
      if (h.startsWith("#")) a.setAttribute("href", rel + h);
      else if (isRelativeUrl(h)) a.setAttribute("href", rebase(h, rel));
    }
    for (const m of span.querySelectorAll("img[src], audio[src], video[src]")) {
      const src = m.getAttribute("src");
      if (isRelativeUrl(src)) m.setAttribute("src", rebase(src, rel));
    }
  }

  // A borrowed phrase may itself project: recurse with ITS document as the base.
  for (const nested of [...span.querySelectorAll(INLINE_SELECTOR)]) {
    await expandOneInline(nested, rel, children, [...stack, key], state);
  }
}

// A refused phrase keeps the link the first paint drew — the reader still sees
// what was meant to be borrowed — and gains the reason as a title.
// The affordance for a model that is not downloaded yet. It is a button and not
// an automatic retry because the constraint it satisfies is a user activation:
// nothing else counts, and nothing should — a translation model is tens of
// megabytes and the reader is the one paying for it.
// A refusal a READER can see. It used to live only in `data-translation-note`,
// which means the page showed its source in silence — and a projection rendering
// its source silently is indistinguishable from a document that was always in
// that language. Whatever the reason, the reader is told there was meant to be a
// translation and why there is not.
function refusalNote(el, dom, lang, why) {
  const bar = dom.createElement("div");
  bar.className = "geml-translate-offer geml-translate-refused";
  bar.textContent = `Not translated to ${lang}: ${why}`;
  el.prepend(bar);
}

function offerTranslation(el, dom, lang, picked, paint) {
  const bar = dom.createElement("div");
  bar.className = "geml-translate-offer";
  const btn = dom.createElement("button");
  btn.type = "button";
  btn.textContent = `Translate to ${lang} (downloads a model)`;
  bar.appendChild(btn);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = `Downloading the ${lang} model…`;
    const r = await translateSlice(picked, lang, {
      allowDownload: true,
      onProgress: (loaded) => { btn.textContent = `Downloading the ${lang} model… ${Math.round(loaded * 100)}%`; },
    });
    if (r.ok) {
      paint(r.blocks);
      el.removeAttribute("data-translation-note");
      delete el.dataset.gemlTranslateOffer;
    } else {
      btn.textContent = `Could not translate: ${r.why}`;
      el.setAttribute("data-translation-note", r.why);
    }
  });
  el.prepend(bar);
}

function refuseInline(el, why, text) {
  el.classList.add(`geml-transclusion-${why}`);
  el.setAttribute("title", text);
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
//
// A borrowed document gets the SAME pre-parse pass content.js gives the host
// (§6): a `=== table {src=…}` has its data pulled in before parsing, so data /
// compute / summary / chart all run on real rows. Without it the very same
// table rendered its data at home and "Data not loaded from …" once transcluded
// — one document, two answers, decided by who was reading it. Sources resolve
// against the BORROWED document's URL, not the host's, and go through the same
// caller-supplied fetch (so the same-origin gate applies).
async function loadChildren(absUrl, state) {
  if (state.docs.has(absUrl)) return state.docs.get(absUrl);
  let children = null;
  try {
    let text = await state.fetchText(absUrl);
    if (typeof text === "string" && text.length <= state.caps.docBytes) {
      if (hasSrcTable(text)) {
        text = await inlineSrcTables(
          text,
          (src) => { try { return new URL(src, absUrl).href; } catch { return src; } },
          async (url) => {
            const t = await state.fetchText(url);
            // looksTabular guards against an error page arriving as 200 text.
            return typeof t === "string" && looksTabular(t) ? t : null;
          },
        );
      }
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

// A projection may only stand for INLINE content, and the target decides:
// `projectableInlines` in geml-parser/src/geml.ts is the normative rule — a
// `text` block whose only non-blank child is a single paragraph. Anything else
// ("not-inline") keeps the link, which is what the parser's
// `inline-transclusion-not-inline` diagnostic already told the author.
function selectProject(children, id) {
  const found = findProjectTarget(children, id);
  if (found === undefined) return null;
  if (found.kind !== "block" || found.type !== "text") return "not-inline";
  const kids = (found.children || []).filter((c) => !(c.kind === "paragraph" && (c.text || "").trim() === ""));
  if (kids.length !== 1 || kids[0].kind !== "paragraph") return "not-inline";
  return kids[0].inlines || [];
}

function findProjectTarget(blocks, id) {
  for (const b of blocks) {
    if ((b.kind === "block" || b.kind === "heading") && b.id === id) return b;
    if (b.kind === "block" && b.children) {
      const inner = findProjectTarget(b.children, id);
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}

