# GEML Viewer — Privacy Policy

**GEML Viewer collects no data.**

- No personal information, browsing history, page content, or usage telemetry
  is collected, stored, or transmitted — to the developer or to anyone else.
- All rendering happens locally in your browser. The extension parses the
  `.geml` / `.gemlhistory` document you opened and replaces the page with its
  rendered form; nothing leaves the machine.
- The only network requests the extension itself makes are for resources the
  document explicitly references (e.g. a table's `src="data.csv"`), fetched
  from the document's own location — the same requests the page could make
  itself. Fonts and all rendering engines are bundled inside the extension.
- One exception to "the same requests the page could make": a document opened
  from disk (`file://`) that embeds a sibling (`=== embed {src=other.geml#id}`)
  cannot read that file itself — Chrome treats a `file://` page as an opaque
  origin and refuses every cross-file read from it. The extension's background
  worker performs that read instead, and only when the target is a `file://`
  URL in the **same directory** as the open document and ends in `.geml`;
  anything else is refused. The text is handed back to the page and goes
  nowhere else.
- The `scripting` permission is used for exactly one thing: injecting the
  extension's own bundled mermaid renderer (`dist/mermaid.chunk.js`) into the
  tab when a document contains a mermaid diagram. It is loaded this way because
  a script import from the page would be blocked by the host site's
  Content-Security-Policy; no remote code is ever fetched or run.
- **Export snapshot** opens a page bundled inside the extension in a new tab,
  because the sites GEML is usually read on are sandboxed and cannot save a
  file. The Markdown is passed to that tab inside the extension and saved to
  your disk from there; no `downloads` permission is held and nothing is
  uploaded.
- Host permissions are path-scoped to GEML URLs (`file:///*.geml*`,
  `*://*/*.geml*`): the extension can only run on URLs that point at a
  `.geml` / `.gemlhistory` file, on whatever site you open one. Even there,
  a page that is not actually a GEML document is left untouched.
- The extension has no accounts, no analytics, no ads, and no third-party
  services.

Questions or concerns: open an issue at
<https://github.com/geml-spec/geml/issues>.
