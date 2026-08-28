# GEML for VS Code

The official [GEML](https://github.com/geml-spec/geml) editor for VS Code,
published by the GEML project — the maintainers of the format and its reference
parser.

Edit `.geml` / `.gemlhistory` documents the way you edit Markdown: a live
preview beside the source, an outline you can jump around, folding, highlighting,
and errors as you type.

**Needs the GEML CLI on your PATH** — `npm i -g @geml/geml`. Highlighting and
the preview work without it; everything else asks the CLI.

- **Preview** — `Ctrl+K V` (`⌘K V`) opens it to the side, `Ctrl+Shift+V` in
  place. Math renders through KaTeX, `format=mermaid` diagrams through Mermaid,
  and a same-document `=== embed` or `![[#id]]` shows the borrowed content
  inline. It follows your theme, and it uses the same renderer the browser
  viewer does, so the pane and the published page agree.
- **Outline** — every block, not just headings. `Ctrl+Shift+O` jumps by the very
  `#id` you would hand to `geml get`, and the breadcrumb bar shows where in the
  document you are. A table or a chart with no title of its own is listed under
  its address, which is its name.
- **Folding** — collapse any block or any heading's whole section.
- **Hover a reference** — `[[#budget]]` shows you the block it points at, from
  this document or another one. Hovering a block's own head shows its address and
  the `geml get` line that fetches it.
- **Go to definition** — `F12` or Ctrl+click on any reference jumps to its
  target, across documents included. Works on all four reference forms:
  `[[#id]]`, `[[doc.geml#id]]`, `[text](#id)`, `[text](doc.geml#id)`, plus
  `![[#id]]` and an embed's `src=`.
- **Rename an id** — `F2` on an id or on any reference to it renames the block
  and every reference in the document, in all of those forms. It is
  `geml rename` doing the work, so it is id-boundary safe (`#budget` is not
  touched inside `#budget-2`) and it **refuses** rather than leave the document
  broken. One consequence worth knowing: a document that already has an error
  cannot be renamed until that error is fixed — the guard permits none in the
  result.
- **Copy Block Address** / **Copy Reference to Block** — right-click, or the
  Command Palette. The address (`#budget`, `## Heading`, `=== table`) is what
  `geml get` and an agent take; the reference (`[[#budget]]`) is what you paste
  into prose.
- **Revert one block** — right-click → *Revert Block to a Past Revision…*. Pick
  from the document's `.gemlhistory` revisions and see the block **as it was** in
  whichever one you highlight, before committing to it. Only that block changes;
  the rest of the document is untouched, and the change lands in the editor's
  undo stack rather than being written behind your back. **Save a Revision**,
  right beneath it, creates the checkpoints there are to revert to — a document
  with no `.gemlhistory` has none yet.
- **Go to Symbol in Workspace** — `Ctrl+T` searches every `.geml` in the folder
  and answers with `file#address`. Note this searches block *content* as well as
  names, which for prose is the more useful of the two; address matches are
  listed first.
- **Highlighting** — typed-block fences and their type, attribute objects
  (`{#id .class key=val}`), headings, `%%` comments, and inline markup
  (`*em*`, `**strong**`, `` `code` ``, `$math$`, `[[#ref]]`, links, footnotes).
- **Diagnostics** — a dangling `[[#id]]`, a broken cross-reference, a duplicate
  id, or any parse error shows up in the Problems panel **as you type**. The same
  signal `geml check` gives in CI, so your editor never disagrees with the build.

Nothing in this extension parses GEML. The outline, the navigation and the
diagnostics come from `geml list --json` and `geml check --json`; renaming is
`geml rename`, reverting is `geml revert`, workspace search is `geml find`; and
the preview draws with the published renderer — so there is no second
implementation of the format here to drift away from the first one. The one
exception is a small lexer that locates the reference token under your cursor,
because no CLI verb answers "what is at line 12, column 30".

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
cd integrations/vscode
npm install
npm run compile          # → out/extension.js
npm test                 # compile + the lexer and CLI-contract suites
npm run build:webview    # → media/geml-webview.js, needed by the preview
# press F5 in VS Code to launch an Extension Development Host, or:
npx @vscode/vsce package # → geml-<version>.vsix, then "Install from VSIX…"
```

The preview's bundle is a build artifact, not a committed file: it is ~8 MB of
KaTeX and Mermaid, and `vscode:prepublish` rebuilds it before packaging. It is
built by `integrations/geml-viewer`, which owns the renderer and the bundler, so
there is one esbuild configuration for the browser viewer, the playground and
this pane rather than three that drift.

To work on the pane itself without launching an extension host, open
`media/smoke.html` over HTTP — it loads the same three files with the webview API
stubbed and a document that exercises one block of every type.

## License

MIT.
