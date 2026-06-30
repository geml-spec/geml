# GEML for Obsidian

Render [GEML](https://github.com/geml-spec/geml-spec) inside Obsidian, using the
reference parser and the viewer's renderer (the same code path as the web
playground). Obsidian users already think in `[[wikilinks]]`, so GEML's
build-time-checked references feel native.

Two entry points:

1. **`` ```geml `` code blocks** in any note — embed a typed-block document,
   a computed table, or a `geml-chart` (inline SVG) right in your vault, with a
   diagnostics banner if a reference is broken.
2. **`.geml` files** — open one and read it rendered.

(Math and Mermaid diagrams fall back to labelled placeholders; tables,
`geml-chart`, and diagnostics — the point — render with no network.)

## Install (manual)

The reference parser must be built once, then bundle the plugin:

```sh
cd ../../geml-parser && npm install && npm run build
cd ../editors/obsidian && npm install && npm run build   # → main.js
```

Copy `manifest.json` and `main.js` into your vault at
`.obsidian/plugins/geml/`, then enable **GEML** in *Settings → Community plugins*.

## Status

Built against the documented Obsidian plugin API; the rendering core is shared
with (and tested via) the reference viewer. Not yet submitted to the community
plugin store.

## License

MIT.
