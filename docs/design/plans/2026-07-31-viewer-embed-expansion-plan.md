# Task: expand `=== embed` in the viewer (Plan A — async fetch + in-place render)

- **Date**: 2026-07-31 · **Surface**: `integrations/geml-viewer/` (content script + playground)
- **Design authority**: [`docs/design/specs/2026-07-30-block-transclusion-design.md`](../specs/2026-07-30-block-transclusion-design.md) — clauses cited as S2–S9 below
- **Goal in one line**: a `.geml` page viewed in the browser renders `=== embed {src=doc.geml#id}` as the referenced content in place — the same result `geml <host> --root <dir> --to html` already produces — instead of today's S7 link.

## Current state (verified 2026-07-31, all line refs at repo HEAD)

- `src/render.js:256` renders `embed` as a deliberate S7 fallback: a
  `div.geml-transclusion.geml-transclusion-unexpanded[data-src]` containing one
  link. Comment: *"This renderer has no sibling-document fetch."* This is the
  **placeholder contract** — keep it.
- `src/content.js` has **no upgrade pass** for embeds (grep `transclusion|embed`: no hits).
- The bundled parser (`dist/viewer.bundle.js`) carries the full embed model and
  diagnostics; its `resolveDoc` hook is **synchronous** `(doc) => string | null`
  and therefore **cannot be implemented in a browser page** (no sync I/O). Do not
  try — expansion must be a post-render async pass.
- Precedents already in this extension, to be imitated rather than re-invented:
  - **async placeholder upgrade**: `geml-code-graph` blocks render a
    `.cg-mount[data-src]` and are upgraded asynchronously (`src/render.js:284`,
    `src/upgrade.js`);
  - **extension-context work**: `offscreen.html` + `src/offscreen.js` (+ messaging
    via `src/bg.js`) already serve the d2/graphviz sandboxes.
- `manifest.json` **needs no change**:
  `host_permissions: ["file:///*.geml*", "*://*/*.geml*"]` already covers every
  fetch this task performs (extension-context fetches to matched hosts are
  CORS-exempt by Chrome's own rules).

## Deliverable

An `expandEmbeds()` pass that runs after the initial render (content script and
playground), replacing each unexpanded placeholder with the rendered target
content, with the failure/limit behavior specified below. No manifest changes,
no CLI changes, no new dependencies.

## Architecture (prescriptive)

1. **Collect**: query `.geml-transclusion-unexpanded[data-src]` in the rendered
   tree. `render.js` stays as is — the placeholder (with its link) is both the
   loading state and the degradation state.
2. **Resolve** the target: split `data-src` into doc path + optional `#fragment`;
   resolve the doc path against the **document URL** (for nested embeds: against
   the *source* URL of the level above). Enforce the confinement policy *before*
   any I/O:
   - `http(s)`: **same-origin only** in this phase. Cross-origin is out of scope
     (see Non-goals) even where `ACAO` would permit it.
   - `file:`: target must stay within the **directory tree of the current
     document** (path-prefix check after normalization; reject `..` escapes).
   - Violations degrade per step 7 — never a silent skip.
3. **Fetch text**:
   - `http(s)` same-origin: page-context `fetch()` is sufficient.
   - `file:`: page-context fetch is impossible (unique origins). Route:
     content script → `chrome.runtime.sendMessage` → bg → **offscreen document**
     performs the read (XHR/fetch in extension context; works when the user has
     enabled *Allow access to file URLs*) → text returns by message. Follow the
     existing d2/graphviz offscreen protocol in `src/bg.js`/`src/offscreen.js`.
   - Cap the response at **2 MB** per target and **32 expansions** per page;
     beyond either, degrade per step 7 with a note naming the cap.
4. **Parse** the fetched text with the bundled parser, as a complete document.
   Because the *whole source document* is parsed, `{{key}}` interpolation runs
   against the **source's own `=== meta`** — S4's first rule is satisfied for
   free. Do not thread `resolveDoc`; nested embeds inside the fetched doc simply
   become placeholders again (handled by recursion in step 8).
5. **Select** the fragment: no fragment → whole document body (S2). A block id →
   that block. A **heading id → its whole section** — identical semantics to
   `geml get` (through the next same-or-higher heading). If the bundle exports
   the section-slicing helper the CLI uses, reuse it; otherwise implement the
   equivalent and add the parity fixture in Acceptance (5) so the two cannot
   drift. Missing id → degrade per step 7.
6. **Render in place** with the viewer's own `renderBlock` (`src/render.js`):
   render the selected block(s) into the placeholder container, then swap the
   class `geml-transclusion-unexpanded` → `geml-transclusion-expanded` (keep
   `geml-transclusion` and `data-src` — that is the S3 provenance wrapper).
   Two correctness rules while rendering embedded content:
   - **S9 / DOM ids**: embedded blocks MUST NOT contribute `id=` attributes to
     the host DOM (anchor namespace stays the host's). Render with ids
     suppressed or emitted as `data-embed-id` instead.
   - **S4 / rebasing**: after rendering, rewrite in the embedded subtree —
     relative `href`/`src` values against the **source doc's URL**, and
     fragment-only references (`#x`) whose target is **not inside the rendered
     slice** to `<sourceURL>#x`. Fragment refs to ids inside the slice may stay
     local only if step 6's id suppression keeps them meaningful; otherwise
     point them at the source too — never at a host `#x`.
   - Post-render enrichments (KaTeX, mermaid, charts) must run on the new
     subtree the same way they run on the host document.
7. **Degrade loudly** (S7): on any failure — confinement violation, fetch error,
   parse failure, missing id, size/count cap, cycle, depth — keep the existing
   link and append a visible note (`span.geml-transclusion-note` with a short
   reason). Never remove the placeholder, never leave it looking successful,
   never log-only.
8. **Recurse** into placeholders created by step 6, carrying:
   - a **cycle set** of normalized `absoluteURL#fragment` currently being
     expanded — a repeat is a cycle → degrade with reason `cycle` (S5);
   - a **depth counter**, cap **8** → degrade with reason `depth` (S5).
9. **Playground**: the same pass must run there (`playground.build.mjs` shares
   the sources); targets resolve against the playground's document model — at
   minimum, do not regress it, and enable expansion where its in-memory files
   make that trivial.

## Explicitly out of scope (do not build)

- Plan B (iframe embedding) — separate task.
- Cross-origin http(s) expansion, even with `ACAO` (follow-up decision).
- Any change to CLI, parser semantics, `manifest.json`, or the sync `resolveDoc` hook.
- `shift-headings=` / heading-level remapping (S10 is still open upstream).
- Editing through an embed (S8: `get`/`set` semantics untouched).
- Spinners/skeleton UI — the placeholder link IS the loading state.

## Acceptance (all must pass; serve fixtures over `http://127.0.0.1` with
`.geml` sent as `text/plain` — note `python -m http.server` alone sends
`application/octet-stream` and the page will download instead of render)

1. **Happy path**: host embeds `sibling.geml#sec` (heading id whose section
   contains a nested note + table) → placeholder is replaced; the section's
   text, the nested blocks, and the S3 wrapper (`geml-transclusion-expanded`,
   `data-src`) are all present.
2. **Section parity**: the same fixture through `geml get sibling.geml '#sec'`
   and through the viewer expansion select the **same block set** (fixture
   includes a following same-level heading to prove the boundary).
3. **Missing id**: `#nope` → link preserved + visible note; nothing disappears.
4. **Cycle**: `a.geml` embeds `b.geml#x`, `b.geml` embeds `a.geml#y` → both
   pages finish rendering with a `cycle` note; no hang, no stack overflow.
5. **Depth**: a 9-deep chain → 8 levels expanded, the 9th shows the `depth` note.
6. **Rebase**: source section contains `![img](img/pic.png)` and `[t](#outside)`
   (target outside the slice) → rendered `src` resolves relative to the
   *source* doc; the link points at `<source>.geml#outside`, not the host.
7. **S9**: host and embedded content both declare `{#dup}` → host anchor `#dup`
   still targets the host's block; embedded subtree contributes no duplicate
   DOM id; no runtime duplicate-id complaint.
8. **`{{key}}`**: source meta defines `k = "SRC"`; host meta defines `k = "HOST"`;
   embedded paragraph `{{k}}` renders **SRC** (S4).
9. **file://**: two files in one directory, *Allow access to file URLs* ON →
   expands (via offscreen); toggle OFF → link + note, not blank. A target
   reached only via `..` from the document's directory → confinement note.
10. **Caps**: a 3 MB target and a 40-embed page each degrade with the cap note.
11. `npm run build` green; existing viewer tests pass; no manifest diff.

## Context for the implementer (Chinese notes)

围绕这个任务的完整背景（四个断点的实测记录、CORS 的账、方案 A/B 对比、为什么不能接
同步 `resolveDoc` 钩子）在 outreach 仓库 `track-b/upstream/FOLLOWUP.md` §12。
心智模型一句话：**`=== embed` 之于 GEML ≈ `<img>` 之于 HTML**——占位 + 第二次请求 +
就地渲染；与 img 的三个差异（要读文本所以受 CORS 约束、按源文档上下文渲染、可递归）
分别对应上面的步骤 2–3、4/6、8。
