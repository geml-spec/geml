# GEML for Android Studio and other IntelliJ IDEs

Editor support for `.geml` and `.gemlhistory` documents in Android Studio,
IntelliJ IDEA, PyCharm and the rest of the IntelliJ family.

It is the same idea as [the VS Code extension](../vscode): **nothing here parses
GEML.** Highlighting is a lexer, and every structural answer — the block index,
the diagnostics — comes from the reference parser, so the editor can never
disagree with what `geml check` says in CI.

## What it does

| | |
|---|---|
| Syntax highlighting | fences, block types, headings, attributes, inline markup, `%%` comments |
| Diagnostics | `geml check --json` on the buffer as you type, into the editor and Problems |
| Preview | the viewer's renderer in a split pane, with KaTeX and Mermaid |
| Structure view | every addressable block, labelled with the address `geml get` takes |
| Folding | per block and per heading section, on the spans the CLI reports |
| Copy Block Address / Copy Reference | right-click in the editor |
| Go to definition | Ctrl+click or F12 on a reference, same document or across documents |
| Hover | over a reference, what it points at; over a block head, how to address it |
| Rename an id | Shift+F6 — `geml rename` updates every reference form, or refuses |
| Revert a block | right-click — restore one block from `.gemlhistory`, into the undo stack |
| Save a revision | right-click — append the document to its `.gemlhistory` |
| Find a block | Tools \| Find GEML Block…, or the GEML tab in Search Everywhere |

## Installing it

1. Install [Node](https://nodejs.org) — the only prerequisite. The parser itself
   ships inside the plugin, so there is no `npm i -g` and no PATH to set.
2. `Settings | Plugins | ⚙ | Install Plugin from Disk…`, and pick the zip from
   `build/distributions/`.

If Node lives somewhere unusual, or you would rather the plugin answered from
your own build of the CLI, both are in `Settings | Tools | GEML`.

## Building it

The plugin carries two things built by other packages in this repository, so
build those first:

```sh
cd ../../geml-parser && npm install && npm run build
npm --prefix ../geml-viewer run build:vscode
```

Then:

```sh
gradle buildPlugin          # -> build/distributions/geml-intellij-<version>.zip
gradle runIde               # a sandbox IDE with the plugin loaded
```

`runIde` starts IntelliJ IDEA Community. To debug in Android Studio instead,
uncomment the `ideDir` line at the bottom of `build.gradle.kts`.

The build targets IntelliJ IDEA Community 2024.2 — the platform Android Studio
Ladybug is built on — with no upper bound, because a hand-installed plugin
should not stop loading after an IDE update. Nothing in it touches an Android
API. Lower `sinceBuild` if you need an older Studio.

## What it deliberately does not do

- **No language server.** JetBrains' LSP API is
  [not available in Android Studio](https://plugins.jetbrains.com/docs/intellij/language-server-protocol.html),
  which is the IDE this plugin exists for, so the platform's own extension
  points do the work instead.
- **No translated projection.** The VS Code preview can borrow that editor's
  language model to translate a document as it renders. Nothing in Android
  Studio offers a third-party plugin an equivalent, so the pane answers the
  renderer's translation request with a refusal and shows the source.
- **No cross-document transclusion in the preview.** The pane renders a
  same-document projection; a block embedded from a neighbouring file keeps its
  target link and the renderer's note.

## How it fits together

```
GemlLexer ──────────── colours, and nothing else
GemlCli ────────────── the bundled parser, over GeneralCommandLine
  └─ GemlIndex ─────── `geml list --json` + `geml check --json`, cached per edit
       ├─ GemlAnnotator ────── diagnostics, and the pass that fills the cache
       ├─ GemlStructureView ── the block tree
       ├─ GemlFoldingBuilder ─ fold regions
       ├─ GemlCopyActions ──── addresses onto the clipboard
       ├─ GemlRenameHandler ── `geml rename`, applied as one command
       ├─ GemlHistoryActions ─ `geml history save` / `geml revert`
       └─ GemlSearchEverywhere  `geml find`, a Search Everywhere tab
GemlRefs ───────────── what reference is under the caret, for navigation
  └─ GemlNavigation ── go-to-definition and hover, both offset-based
GemlPreviewEditor ──── JCEF + integrations/geml-viewer's bundle, unchanged
```

The preview reuses `integrations/vscode/media/preview.js` verbatim. It talks to
its host through VS Code's small `acquireVsCodeApi()` interface, and
`GemlPreviewPage` shims that onto JCEF's query channel rather than forking the
file — so there is one page script and one renderer for both editors.
