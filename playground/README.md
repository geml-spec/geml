# GEML playground

A zero-dependency, static web playground: edit GEML on the left, see it rendered
on the right, and watch the validity pill flip to red the moment a reference
breaks. It's the project's pitch in one link — the thing to put above the fold in
the README and at the top of a Show HN.

`index.html` + `playground.js` + `sample.geml` + `fonts/` are fully
self-contained (no CDN, no network). Everything renders for real: computed
tables, `geml-chart` (inline SVG), **math via bundled KaTeX**, and **diagrams via
bundled Mermaid**. Bundling both makes `playground.js` a few MB — the price of a
self-contained, offline showcase.

## Build

`playground.js` is bundled from the reference parser + the viewer's renderer:

```sh
cd ../geml-parser && npm install && npm run build   # parser must be built first
cd ../geml-viewer && npm install && npm run build:playground
```

That regenerates `playground/playground.js`. It is committed so the folder hosts
with zero build step — re-run the command after changing the parser or renderer.

## The code-graph demo data (`codemap/`)

The `geml-code-graph` section of `sample.geml` dogfoods: `codemap/` is this
repository's **own** codemap — one GEML document per source file of
`geml-parser` and `geml-viewer` plus a module index (two SCIP indexes merged
into one map) — and the `.html` next to each document is the CLI-rendered
page the module overview links into. Regenerate after parser or viewer
changes:

```sh
cd ../geml-parser && npx --yes @sourcegraph/scip-typescript index --output /tmp/geml-parser.scip
cd ../geml-viewer && npx --yes @sourcegraph/scip-typescript index --output /tmp/geml-viewer.scip
cd .. && rm -rf playground/codemap && node tools/geml-code-graph/build.mjs \
  --adapter scip --raw /tmp/geml-parser.scip --adapter scip --raw /tmp/geml-viewer.scip \
  --root . --out playground/codemap --build /tmp/cg-build --container file
node tools/geml-code-graph/verify.mjs playground/codemap
for f in playground/codemap/*.geml; do node geml-parser/dist/geml.js render "$f" -o "${f%.geml}.html"; done
```

## Host it (free)

Any static host works. GitHub Pages, from this folder:

1. Push the repo (the `playground/` folder is committed, build artifact included).
2. Repo **Settings → Pages → Deploy from a branch →** branch `main`, folder
   `/ (root)` (GitHub Pages branch deploys only offer `/` or `/docs`, not an
   arbitrary subfolder).
3. Your URL is then `https://geml-spec.github.io/geml/playground/` — drop it
   into the READMEs (there's a commented-out placeholder above the fold in both)
   and your launch posts.

For a shorter root URL (`https://geml-spec.github.io/geml/`), copy
`index.html` + `playground.js` into a top-level `/docs` folder and point Pages at
`/docs` instead.

Locally: `python -m http.server` in this folder, open `localhost:8000`.
