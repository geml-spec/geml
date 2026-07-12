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
- Host permissions are path-scoped to GEML URLs (`file:///*.geml*`,
  `*://*/*.geml*`): the extension can only run on URLs that point at a
  `.geml` / `.gemlhistory` file, on whatever site you open one. Even there,
  a page that is not actually a GEML document is left untouched.
- The extension has no accounts, no analytics, no ads, and no third-party
  services.

Questions or concerns: open an issue at
<https://github.com/geml-spec/geml-spec/issues>.
