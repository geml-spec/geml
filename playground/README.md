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

## Host it (free)

Any static host works. GitHub Pages, from this folder:

1. Push the repo (the `playground/` folder is committed, build artifact included).
2. Repo **Settings → Pages → Deploy from a branch →** branch `main`, folder
   `/ (root)` (GitHub Pages branch deploys only offer `/` or `/docs`, not an
   arbitrary subfolder).
3. Your URL is then `https://geml-spec.github.io/geml-spec/playground/` — drop it
   into the READMEs (there's a commented-out placeholder above the fold in both)
   and your launch posts.

For a shorter root URL (`https://geml-spec.github.io/geml-spec/`), copy
`index.html` + `playground.js` into a top-level `/docs` folder and point Pages at
`/docs` instead.

Locally: `python -m http.server` in this folder, open `localhost:8000`.
