# website

[geml-spec.github.io](https://geml-spec.github.io/) is its own repository,
[`geml-spec/geml-spec.github.io`](https://github.com/geml-spec/geml-spec.github.io).
It copies nothing from here: it links to the specification, the profiles, the
guides, the GEPs and the changelog in this repository. A few of the files it
serves are made from this repository's code, and this folder is where they are
made:

| file in the site | made from |
|---|---|
| `public/playground/playground.js`, `fonts/` | the parser and the viewer's renderer, bundled by `integrations/chrome-geml-viewer/playground.build.mjs` |
| `public/playground/codemap/` | the parser's and the viewer's own call graph |
| `public/logo/` | `docs/assets/logo/` |
| `public/favicon.ico` | `docs/assets/logo/geml.ico` |

`update.mjs` writes them into a checkout of the site, then runs `geml check`
over every demo document the site ships. The `website` workflow
(`.github/workflows/website.yml`) runs it on every change to `main` that can
alter them, then commits and pushes the result to the site, which deploys it.

By hand, with the site checked out beside this repository:

```sh
(cd geml-parser && npm ci && npm run build)
(cd integrations/chrome-geml-viewer && npm ci)
node integrations/website/update.mjs ../geml-spec.github.io
```

The workflow's push needs a deploy key: generate a key pair, add the public key
to `geml-spec/geml-spec.github.io` (*Settings → Deploy keys*, with write access),
and store the private key in this repository as the secret `SITE_DEPLOY_KEY`.
