// Enough of the `vscode` module to load and exercise the extension's pure
// logic outside an extension host.
//
// The parts under test — the reference lexer, the block-at-a-line rule, the id
// whitelist — are ordinary functions that happen to speak in vscode.Range. They
// are also the parts with no CLI behind them to be right on their behalf, so
// they are exactly what wants a test. Everything that genuinely needs the editor
// (providers, webviews, commands) is not tested here and is not pretended to be.
//
// `vscode` is resolvable only inside VS Code, so it is injected into the module
// loader rather than installed.

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  isBefore(o) { return this.line < o.line || (this.line === o.line && this.character < o.character); }
  isAfter(o) { return o.isBefore(this); }
}

class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) { this.start = a; this.end = b; }
    else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
  contains(pos) {
    if (pos.line < this.start.line || pos.line > this.end.line) return false;
    if (pos.line === this.start.line && pos.character < this.start.character) return false;
    if (pos.line === this.end.line && pos.character > this.end.character) return false;
    return true;
  }
  get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
}

const vscode = {
  Position,
  Range,
  EndOfLine: { LF: 1, CRLF: 2 },
  Uri: { file: (p) => ({ scheme: "file", fsPath: p, toString: () => `file://${p}` }) },
  // Present so a module-level reference does not throw on load; no test calls it.
  window: { showWarningMessage() {}, showErrorMessage() {}, showInformationMessage() {} },
  workspace: {
    // Settings the test can steer — `geml.check.path` in particular, so a CLI
    // test can point at the repo's freshly built parser instead of needing one
    // installed globally.
    getConfiguration: (section) => ({
      get: (key, fallback) => {
        const full = section ? `${section}.${key}` : key;
        return Object.prototype.hasOwnProperty.call(settings, full) ? settings[full] : fallback;
      },
    }),
  },
};

const settings = {};
function setSetting(key, value) { settings[key] = value; }

/**
 * A TextDocument with the handful of members these functions touch.
 *
 * The default path is inside this directory rather than a made-up one, because
 * runCli spawns with the document's directory as cwd — and spawning into a
 * directory that does not exist fails with the same ENOENT as a missing binary.
 */
function makeDoc(text, opts = {}) {
  const lines = text.split("\n");
  return {
    uri: vscode.Uri.file(opts.path ?? require("node:path").join(__dirname, "doc.geml")),
    languageId: "geml",
    version: opts.version ?? 1,
    eol: opts.eol ?? vscode.EndOfLine.LF,
    lineCount: lines.length,
    lineAt: (n) => ({
      text: lines[n] ?? "",
      isEmptyOrWhitespace: (lines[n] ?? "").trim() === "",
    }),
    getText: () => text,
  };
}

/** Make `require("vscode")` resolve to the stub for everything loaded after. */
function install() {
  const Module = require("node:module");
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return vscode;
    return original.call(this, request, ...rest);
  };
}

module.exports = { vscode, makeDoc, install, setSetting, Position, Range };
