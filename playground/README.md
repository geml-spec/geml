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

That regenerates `playground/playground.js`. It is committed so the folder hosts
with zero build step — re-run the command after changing the parser or renderer.

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
for f in playground/codemap/*.geml; do node geml-parser/dist/geml.js render "$f" -o "${f%.geml}.html"; done
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
