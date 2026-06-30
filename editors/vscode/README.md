# GEML for VS Code

Syntax highlighting and **build-time reference checking** for [GEML](https://github.com/geml-spec/geml-spec)
(`.geml` / `.gemlhistory`) documents.

- **Highlighting** — typed-block fences and their type, attribute objects
  (`{#id .class key=val}`), headings, `%%` comments, and inline markup
  (`*em*`, `**strong**`, `` `code` ``, `$math$`, `[[#ref]]`, links, footnotes).
- **Diagnostics** — a dangling `[[#id]]`, a broken cross-reference, a duplicate
  id, or any parse error shows up in the Problems panel **as you type**. The same
  signal `geml check` gives in CI, so your editor never disagrees with the build.

## Requirements

The extension calls the GEML CLI; install it once:

```sh
npm install -g @geml/geml
```

If you'd rather not install it globally, set **`geml.check.path`** to
`npx @geml/geml`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `geml.check.enabled` | `true` | Run `geml check` and show diagnostics. |
| `geml.check.path` | `geml` | How to invoke the CLI (a path, or `npx @geml/geml`). |

## Build from source

```sh
cd editors/vscode
npm install
npm run compile          # → out/extension.js
# press F5 in VS Code to launch an Extension Development Host, or:
npx @vscode/vsce package # → geml-<version>.vsix, then "Install from VSIX…"
```

## License

MIT.
