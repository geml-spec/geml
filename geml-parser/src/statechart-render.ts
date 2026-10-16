// `geml-statechart` — the diagram renderer geml-statechart/v1 supplies
// (profile §2.6). Host-registered under `RenderOptions.diagrams`, like
// `geml-code-graph`: a build that does not register it leaves the block to §7's
// labelled-source fallback, which is the right degradation and not an error.
//
// The picture is the model drawn by statechart-svg.ts, inline, with no runtime
// to load; a link under it hands the same SVG over as a file (a slide takes it
// as it is). Under that, two lists of `<details>` — one per state, one per
// transition — open on what the profile says a reader sees when opening one:
// the title, description and attributes of a state with its edges, the guard
// read out, the actions and attributes of a transition. The lists are plain
// HTML; the picture's nodes carry the state ids, nothing scripts them.
import { type DiagramRenderer, esc, escAttr } from "./render.js";
import { statechartsOf } from "./statechart-check.js";
import { edgeLabel, guardText, type JsonValue, type StatechartModel, type Transition } from "./statechart.js";
import { statechartSvg, statechartSvgDataUrl } from "./statechart-svg.js";

const show = (v: JsonValue): string => (typeof v === "string" ? v : JSON.stringify(v));
/** A short, stable hash of a body: 32-bit FNV-1a in hex. */
const hashOf = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
};
const attrRows = (attrs: Record<string, JsonValue>): string =>
  Object.keys(attrs).length === 0 ? "" : `<dl>${Object.entries(attrs).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(show(v))}</dd>`).join("")}</dl>`;
const edge = (t: Transition): string => { const l = edgeLabel(t); return `<code>${esc(t.name)}</code>${l === "" ? "" : ` — ${esc(l)}`}`; };

function statesList(m: StatechartModel): string {
  return m.states.map((s) => {
    const marks = [s.id === m.initial ? "initial" : "", m.finals.includes(s.id) ? "final" : "", s.id === m.current ? "current" : ""].filter(Boolean);
    const out = m.transitions.filter((t) => t.from === s.id).map((t) => `<li>→ ${edge(t)}</li>`).join("");
    const into = m.transitions.filter((t) => t.to === s.id).map((t) => `<li>← ${edge(t)}</li>`).join("");
    return `<details class="statechart-state"${s.id === m.current ? " open" : ""}><summary>${esc(s.title)}${s.title === s.id ? "" : ` <code>${esc(s.id)}</code>`}${marks.length ? ` <small>${marks.join(", ")}</small>` : ""}</summary>` +
      `${s.description === undefined ? "" : `<p>${esc(s.description)}</p>`}${attrRows(s.attrs)}${out || into ? `<ul>${out}${into}</ul>` : ""}</details>`;
  }).join("");
}

function transitionsList(m: StatechartModel): string {
  return m.transitions.map((t) => {
    const g = t.guard === undefined ? "" : `<p><b>guard</b> ${esc(guardText(t.guard))}</p>`;
    const a = t.actions.length === 0 ? "" : `<p><b>actions</b> ${esc(t.actions.map(show).join("; "))}</p>`;
    return `<details class="statechart-transition"><summary><code>${esc(t.name)}</code></summary>${g}${a}${attrRows(t.attrs)}</details>`;
  }).join("");
}

export const statechartDiagram: DiagramRenderer = (b, ctx) => {
  const { idAttr, cap, classes } = ctx;
  const name = ctx.opts.source ?? "document.geml";
  const found = statechartsOf(ctx.doc, name, (rel) => ctx.opts.loadDoc?.(rel) ?? null).find((x) => x.block === b);
  const result = found?.result;
  if (result === undefined || result.model === null) {
    const why = (result?.diagnostics ?? []).map((d) => d.message).join("; ") || "no model";
    return `<figure${ctx.clsAttr(classes, "statechart")}${idAttr}><p class="render-error">geml-statechart: ${esc(why)}</p>${cap}</figure>`;
  }
  const m = result.model;
  // Marker ids must differ between pictures on one page: the block id, else a hash of the body.
  const key = b.id ?? `sc${hashOf((b.raw ?? []).join("\n"))}`;
  const svg = statechartSvg(m, { key, ...(ctx.caption !== undefined ? { title: ctx.caption } : {}) });
  const file = `${b.id ?? "statechart"}.svg`;
  return `<figure${ctx.clsAttr(classes, "statechart")}${idAttr}>${svg}` +
    `<p class="statechart-tools"><a download="${escAttr(file)}" href="${statechartSvgDataUrl(svg)}">Download SVG</a></p>` +
    `<div class="statechart-states">${statesList(m)}</div><div class="statechart-transitions">${transitionsList(m)}</div>${cap}</figure>`;
};
