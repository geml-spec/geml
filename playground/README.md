# GEML playground

A zero-dependency, static web playground: edit GEML on the left, see it rendered
on the right, and watch the validity pill flip to red the moment a reference
breaks. It's the project's pitch in one link — the thing to put above the fold in
the README and at the top of a Show HN.

`index.html` + `playground.js` are fully self-contained (no CDN, no network).
Tables, computed columns, and `geml-chart` (inline SVG) all render; math and
mermaid degrade to labelled placeholders (the bundle deliberately omits KaTeX and
Mermaid to stay ~130 KB).

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
2. Repo **Settings → Pages →** deploy from a branch, folder `/playground` (or
   copy the two files to `/docs`).
3. Your URL: `https://<user-or-org>.github.io/<repo>/` — drop it into the
   READMEs (there's a commented-out placeholder above the fold in both) and your
   launch posts.

Locally: `python -m http.server` in this folder, open `localhost:8000`.
