# GEML Viewer

A Chrome (MV3) extension that renders `.geml` and `.gemlhistory` documents in the
browser — locally (`file://`) and on the web (`http(s)://`) — using the GEML
reference parser, so what you see matches the spec exactly.

## What it renders

- **Native blocks**: headings, paragraphs, lists, `note`/`aside` callouts, code,
  and inline markup (`*em*`, `**strong**`, `` `code` ``, `~~strike~~`, links,
  `[[#id]]` auto-references with the target's label, footnotes, media embeds).
- **Tables (§6)**: header, alignment, **computed columns** and the **summary
  row** (values already evaluated by the parser), and merged-cell `span`s.
- **Charts**: `diagram {format=geml-chart …}` is drawn as an inline SVG
  (bar / line / area / pie / scatter) straight from the table it references.
- **Math**: inline `$…$` and `=== math` via **KaTeX**.
- **Diagrams**: `format=mermaid` via **Mermaid**. `graphviz` / `d2` / `plantuml`
  are shown as labelled source blocks (no extra engines bundled).
- **Diagnostics**: GEML's build-time reference checking is surfaced as a banner —
  a dangling `#id`, a non-table chart `data=`, etc. show up instead of silently
  breaking. This is the part a generic text viewer can't give you.

## Build

The extension bundles the parser's compiled output, so build it first:

```sh
cd geml-parser && npm install && npm run build && cd ..
cd geml-viewer && npm install && npm run build
```

`npm run build` writes `dist/viewer.bundle.js` and copies KaTeX fonts to
`dist/fonts/`.

## Load in Chrome

1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this `geml-viewer/` directory.
3. To view local files, open the extension's **Details** and turn on
   **Allow access to file URLs**.
4. Open any `.geml` file (`file:///…/GEML-spec.geml`) or a raw `.geml` URL.

## How it works

```
.geml URL ─▶ content.js (guard: path ends .geml / plain-text page)
          ─▶ read original text (fetch, fallback to the page's <pre>)
          ─▶ parse()  [geml-parser core, bundled for the browser]
          ─▶ renderDocument(model, document)  [pure DOM, src/render.js]
          ─▶ replace the page + inject CSS
          ─▶ upgrade: KaTeX (math), Mermaid (diagrams), inline SVG (geml-chart)
```

- `src/render.js` is a pure model→DOM function (no KaTeX/Mermaid), so it is unit
  tested under linkedom (`npm test`). Math/mermaid become placeholder elements
  that `content.js` upgrades after injection.
- The parser's Node-only CLI/history paths never run in a page; the build
  neutralizes them (`alias node:* → src/node-stub.js`, `define process.argv → []`).
  The core `parse()` chain itself uses no Node APIs.

## Known limitations

- **Remote forced downloads**: if a server sends `.geml` with
  `Content-Disposition: attachment`, the browser downloads it and no content
  script runs. Most raw text URLs are fine.
- **Mermaid + strict page CSP**: on pages with a very strict CSP, Mermaid may be
  blocked; the diagram then falls back to its visible source text.
- **`graphviz` / `d2` / `plantuml`**: shown as source (rendering them would mean
  bundling large extra engines — out of scope, matching §7's "preserve the body"
  stance).
- **Cross-document references aren't verified**: the browser has no synchronous
  file resolver, so links to other `.geml`/`.md` files can't have their anchors
  checked. The parser's resulting "not checked (no document resolver)" warnings
  are a viewer limitation, not a document problem, so they are hidden. A real
  broken *internal* `#id` is still reported as an error.
- **KaTeX fonts**: served from `dist/fonts/` via `web_accessible_resources`; if
  math glyphs look off, re-run `npm run build` so the fonts are copied.

## Develop

```sh
npm test   # builds, then runs the linkedom renderer tests
```
