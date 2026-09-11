# GEML playground

A zero-dependency, static web playground: edit GEML on the left, see it rendered
on the right, and watch the validity pill flip to red the moment a reference
breaks. It's the project's pitch in one link — the thing to put above the fold in
the README and at the top of a Show HN.

`index.html` + `playground.js` + the chapter files + `fonts/` are fully
self-contained (no CDN, no network). Everything renders for real: derived views,
`geml-chart` (inline SVG), **math via bundled KaTeX**, and **diagrams via
bundled Mermaid**. Bundling both makes `playground.js` a few MB — the price of a
self-contained, offline showcase.

## The seven chapters

The tour is seven real `.geml` files sitting in this folder. The chapter bar
loads one into the editor; `#ch=<slug>` in the URL selects one directly.

| slug | file | what it shows |
|---|---|---|
| `basics` | `ch01-basics.geml` | meta interpolation, flow prose, `note`, lists, footnotes, `[[#id]]` |
| `relation` | `ch02-relation.geml` | `table` holds facts · `view` derives: `where` `order` `limit` `select` `by` `aggregate` `compute` `summary`, and a view reading a view |
| `coordinates` | `ch03-coordinates.geml` | `#id[2]["Q1"]`, `#id["Q1"]`, `#id[summary][…]`, a `data` value tree, `#meta["key"]` |
| `data` | `ch04-data.geml` | `format=json` / `jsonl` / `yaml`, and a chart bound to the jsonl by reference |
| `visual` | `ch05-visual.geml` | charts by reference, KaTeX, Mermaid, and the repository's own codemap |
| `reuse` | `ch06-reuse.geml` | `![[#id]]` inline projection, block embeds, a cross-file chain, `part=head` |
| `projection` | `ch07-projection.geml` | GEP-0010 language projection of `ch07-source.geml`, four axes side by side |

`sample.geml` is the **eighth** entry and writes none of that content: it is an
index that transcludes the seven, so the same files serve the chapter editor and
the single-page tour that the READMEs link to as a raw file. Changing a chapter
changes the tour — there is no second copy to update.

Every one of them is `geml check`-clean; CI would catch it if one were not.

## Build

`playground.js` is bundled from the reference parser + the viewer's renderer:

```sh
cd ../geml-parser && npm install && npm run build   # parser must be built first
cd ../integrations/geml-viewer && npm install && npm run build:playground
```

That writes `playground/playground.js` and copies KaTeX's fonts beside it.
Neither is committed — CI builds them and Deploy Pages serves what it built, so
nothing here can fall behind the parser it bundles. The price is this page: a
fresh checkout has no bundle until you run the command above.

## The page-layout demo (`style-demo/`)

The seven chapters show what a GEML *document* is. `style-demo/` shows what the
**layout layer** (`geml-style/v1`) can do with one: it is a 1:1 replica of a
GitHub blob page — top bar, repository nav, file tree, breadcrumb, commit row,
Preview/Code/Blame, four dropdown menus — reading a real document from this
repository, `docs/PUBLISHING.geml`.

**Open `style-demo/page.geml`** — the document itself, served over HTTP, with
[`geml-viewer`](../integrations/geml-viewer) installed. The opening note tells
you what you are looking at, then fades.

There is no `index.html` here on purpose. What is being demonstrated is that a
`.geml` file *is* the page; wrapping it in a host page would demonstrate the
host instead. Without the viewer a browser shows the source, which is the right
default: the file is text, and nothing has claimed otherwise.

| file | what it holds |
|---|---|
| `style-demo/page.geml` | 13 lines: **an assembly sheet** — one `embed` for the template, one for the document being read |
| `style-demo/template.geml` | **the page template**, and only content: top bar, repository nav, file tree, breadcrumb, commit row and toolbars, written as lists of inline links, plus the search and branch fields |
| `style-demo/_index/index.geml` | the style entry (profile §1.1) — names the stylesheet beside it |
| `style-demo/_index/github.style.geml` | **only layout**: frames, slots, built-in words, three states. Not one word of GitHub's text |
| `style-demo/icons/*.svg` | 40 octicons, referenced from the content by path |

The split is the point. Every string you can read on the page comes from
`template.geml` or the document it reads; every colour and length comes from
`github.style.geml`; the viewer knows about neither.

`page.geml` is that short because `template.geml` is a **template**, and saying
so took no new mechanism: an `embed` brings a document into the corpus, and the
stylesheet's `slots=` can already reach a block in any document there. So the
27 frames pick the template's blocks out of it one by one, and pointing the page
at a different document is one `src=`:

```geml
=== embed {#template src="template.geml"}
===
=== embed {#doc src="../../docs/PUBLISHING.geml"}
===
```

Writing those blocks straight into `page.geml` still works — that is what this
demo did until it was split — so "write the page directly" and "use a template"
are the same mechanism seen from two ends, not two features.

Both files check clean:

```sh
node ../geml-parser/dist/geml.js check style-demo/page.geml --root ..
cd style-demo && node ../../geml-parser/dist/geml.js style check \
  _index/github.style.geml page.geml ../../docs/PUBLISHING.geml \
  --components=tree,segments,code-graph
```

`--root ..` is needed because the page's `embed` points *up* at
`docs/PUBLISHING.geml` rather than keeping a copy — a copy would drift, and the
document is the one being demonstrated. That same upward reference is why this
page wants a server at the **repository root**: over `file://` the viewer
confines a document's fetches to its own directory, so the embed degrades to a
link and the article does not appear.

## The code-graph demo data (`codemap/`)

The `geml-code-graph` section of `ch05-visual.geml` dogfoods: `codemap/` is this
repository's **own** codemap — one GEML document per source file of
`geml-parser` and `geml-viewer` plus a module index (two SCIP indexes merged
into one map) — and the `.html` next to each document is the CLI-rendered
page the module overview links into. Regenerate after parser or viewer
changes:

```sh
cd ../geml-parser && npx --yes @sourcegraph/scip-typescript index --output /tmp/geml-parser.scip
cd ../integrations/geml-viewer && npx --yes @sourcegraph/scip-typescript index --output /tmp/geml-viewer.scip
cd .. && rm -rf playground/codemap && node geml-parser/dist/geml.js codemap build \
  --adapter scip --raw /tmp/geml-parser.scip --adapter scip --raw /tmp/geml-viewer.scip \
  --root . --out playground/codemap --build /tmp/cg-build --container file
node geml-parser/dist/geml.js codemap verify playground/codemap
node geml-parser/dist/geml.js codemap render playground/codemap   # every doc -> sibling .html
```

## Host it (free)

Any static host works. GitHub Pages, from this folder:

1. Push the repo (the `playground/` folder is committed, build artifact included).
2. Repo **Settings → Pages → Deploy from a branch →** branch `main`, folder
   `/ (root)` (GitHub Pages branch deploys only offer `/` or `/docs`, not an
   arbitrary subfolder).
3. Your URL is then `https://geml-spec.github.io/geml/playground/` — drop it
   into the READMEs and your launch posts.

For a shorter root URL (`https://geml-spec.github.io/geml/`), copy
`index.html` + `playground.js` into a top-level `/docs` folder and point Pages at
`/docs` instead.

Locally: `python -m http.server` in this folder, open `localhost:8000`.

For the page-layout demo, serve the **repository root** instead —
`python -m http.server` one level up, then open
`localhost:8000/playground/style-demo/page.geml` with the viewer installed. That
document reads `docs/PUBLISHING.geml`, which sits outside this folder. On GitHub
Pages it already works: Pages serves the repository root, so
`…/geml/playground/style-demo/page.geml` resolves.
