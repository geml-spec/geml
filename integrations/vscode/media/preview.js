// The preview pane's page script. Parses and renders inside the webview so a
// keystroke costs one parse, not a process spawn — the CLI is still the source
// of truth for DIAGNOSTICS (the Problems panel), this only draws the document.
//
// Deliberately plain ES5-ish and hand-written: esbuild owns geml-webview.js, and
// mixing generated and hand-written code in one file makes the generated half
// look editable.
(function () {
  var api = acquireVsCodeApi();
  var noteEl = document.getElementById("note");
  var docEl = document.getElementById("doc");
  var pending = null;      // text that arrived before the bundle finished loading
  var lastText = null;
  var docs = {};           // neighbours the extension read for us; the page cannot
  var skipped = [];        // the ones it would not read, and why
  var nextReq = 1;         // translation requests, answered by the extension
  var waiting = {};        // request id -> resolve
  var docUri = null;       // kept in saved state so a restored panel knows its document

  window.addEventListener("message", function (e) {
    var msg = e.data;
    if (!msg) return;
    if (msg.type === "render") {
      if (typeof msg.uri === "string") docUri = msg.uri;
      docs = msg.docs && typeof msg.docs === "object" ? msg.docs : {};
      skipped = Array.isArray(msg.skipped) ? msg.skipped : [];
      render(msg.text);
      return;
    }
    if (msg.type === "translations") {
      var pendingReq = waiting[msg.id];
      if (pendingReq) { delete waiting[msg.id]; pendingReq(msg.result); }
    }
  });

  function save(scroll) {
    api.setState({ text: lastText, scroll: scroll, uri: docUri });
  }

  // Diagrams carry their own colours, so they are the one thing CSS variables
  // cannot re-theme. VS Code stamps the kind on <body>; map it to a Mermaid
  // theme so a dark editor does not get a white diagram punched into the page.
  function mermaidTheme() {
    var c = document.body.classList;
    if (c.contains("vscode-high-contrast-light")) return "neutral";
    if (c.contains("vscode-high-contrast")) return "dark";
    if (c.contains("vscode-dark")) return "dark";
    return "default";
  }

  // The translator the renderer uses in this pane. Chrome's built-in Translator
  // is not here (this is Electron), so the extension asks the editor's language
  // model and answers with a map. A host that never answers must not wedge the
  // render, hence the timeout — the renderer then shows the source text plus a
  // note, which is what it does whenever a translator refuses.
  function translate(texts, target) {
    return new Promise(function (resolve) {
      var id = nextReq++;
      waiting[id] = resolve;
      api.postMessage({ type: "translate", id: id, target: target, texts: texts });
      setTimeout(function () {
        if (!waiting[id]) return;
        delete waiting[id];
        resolve({ why: "the editor did not answer in time" });
      }, 60000);
    });
  }

  function note(text, kind) {
    if (!text) { noteEl.textContent = ""; noteEl.hidden = true; return; }
    noteEl.textContent = text;
    noteEl.className = "geml-preview-note" + (kind === "error" ? " is-error" : "");
    noteEl.hidden = false;
  }

  function render(text) {
    lastText = text;
    if (!window.GEML) { pending = text; note("loading the renderer…"); return; }

    // Keep the reader where they were. A preview that jumps to the top on every
    // keystroke is worse than no preview.
    var y = window.scrollY;

    var model;
    try {
      model = GEML.parse(text);
    } catch (err) {
      // A parse that throws (not a diagnostic — an actual crash) leaves the last
      // good render on screen rather than blanking the pane mid-sentence.
      note("preview not updated: " + String(err), "error");
      return;
    }

    var diags = GEML.viewerDiagnostics(model.diagnostics || []);
    var errors = diags.filter(function (d) { return d.severity === "error"; });
    // One line, not a list: the Problems panel already itemises them, with
    // clickable lines this pane cannot offer.
    if (errors.length) {
      note(errors.length + (errors.length > 1 ? " errors" : " error") + " — see the Problems panel", "error");
    } else if (skipped.length) {
      // Say which neighbour was not read and why. Without this the renderer's
      // own note ("cannot resolve document …") reads as "the file is missing"
      // for a file that is merely too big, or open outside this folder.
      note("not read for the preview: " + skipped.join(", "));
    } else {
      note("");
    }

    try {
      // Emptied so the renderer does not ALSO draw its own diagnostics banner.
      // On a web page that banner is the only place a reader could learn the
      // document is broken; in the editor the Problems panel owns that, with
      // clickable lines, and a second full listing just pushes the document
      // down the pane. Suppressing the overlay does not change how any block
      // renders, so the pane still agrees with the published page.
      model.diagnostics = [];
      var rendered = GEML.renderDocument(model, document);
      docEl.textContent = "";
      docEl.appendChild(rendered);
      // Math, diagrams and same-document projections. Async, and failures here
      // must not take the already-visible document down with them.
      if (GEML.enhance) {
        GEML.enhance(docEl, { model: model, theme: mermaidTheme(), docs: docs, translate: translate }).catch(function (err) {
          note("rendered, but math/diagrams failed: " + String(err));
        });
      }
    } catch (err) {
      note("render failed: " + String(err), "error");
      return;
    }

    window.scrollTo(0, y);
    // Survives the webview being torn down while the panel is hidden.
    save(y);
  }

  // Debounced: setState structured-clones the whole document, and a scroll
  // gesture fires dozens of events. Saving on every one of them would copy a
  // 40 kB string dozens of times to remember one number.
  var scrollTimer = null;
  window.addEventListener("scroll", function () {
    if (lastText === null) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () { save(window.scrollY); }, 200);
  }, { passive: true });

  // The bundle is a classic script tag ahead of this one, so it is normally
  // ready by now; this is the belt for a slow disk.
  function whenReady() {
    if (window.GEML) {
      if (pending !== null) { var t = pending; pending = null; render(t); }
      return;
    }
    setTimeout(whenReady, 30);
  }

  var state = api.getState();
  if (state && typeof state.text === "string") {
    if (typeof state.uri === "string") docUri = state.uri;
    render(state.text);
    if (typeof state.scroll === "number") window.scrollTo(0, state.scroll);
  }
  whenReady();

  // Ask for the current buffer. The extension answers with `render`, which is
  // also what it sends on every edit — one path, no separate first-load branch.
  api.postMessage({ type: "ready" });
})();
