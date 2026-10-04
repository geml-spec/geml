//! A second, independent implementation of GEML 1.0, written from the
//! specification (`spec/GEML-spec.md`) and its conformance suite
//! (`geml-parser/test/conformance/`), and from nothing else.
//!
//! ```
//! let doc = geml::parse("# Title {#t}\n\nSee [[#t]].\n");
//! assert_eq!(geml::project(&doc), r##"h1("Title") "See " ref("#t") ".""##);
//! assert!(doc.diagnostics.is_empty());
//! ```

pub mod addresses;
pub mod attrs;
pub mod block;
pub mod bounds;
pub mod check;
pub mod data;
pub mod diag;
pub mod expr;
pub mod host;
pub mod ids;
pub mod inline;
pub mod json;
pub mod model;
pub mod normalize;
pub mod num;
pub mod project;
pub mod registry;
pub mod resolve;
pub mod route;
pub mod sha256;
pub mod table;
pub mod to_json;
pub mod transclude;
pub mod uni;
pub mod view;
pub mod vocab;
pub mod yaml;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use diag::{Diagnostic, Severity};
pub use model::Document;

/// How a document is read.
pub struct Options<'a> {
    /// The document's name, root-relative: what its relative references
    /// resolve against, and what its profile diagnostics' addresses carry.
    pub name: String,
    /// Recognize the vocabularies this processor ships (§8.6.2). Off, every
    /// declared name is `unrecognized-vocabulary` and admits nothing.
    pub recognize: bool,
    /// Where other documents and files are read from; without one, nothing
    /// outside the document is resolved.
    pub host: Option<&'a dyn host::Host>,
    /// Run the recognized vocabularies' own checks (`profile_diagnostics`).
    pub checks: bool,
}

impl Default for Options<'_> {
    fn default() -> Self {
        Options { name: "document.geml".into(), recognize: true, host: None, checks: true }
    }
}

/// Parse a document given as text (already decoded), recognizing the
/// vocabularies this processor ships and resolving nothing outside it.
pub fn parse(text: &str) -> Document {
    parse_with(text, &Options::default())
}

/// Parse a document with options: its name, a host, which vocabularies.
pub fn parse_with(text: &str, opts: &Options) -> Document {
    let norm = normalize::normalize(text);
    let lines = normalize::lines(&norm);
    // A document is read under the vocabularies its own `meta` declares, so
    // the declaration is read first, and the body modes it grants after.
    let none = vocab::Vocabulary::default();
    let mut diags = diag::Diags::default();
    let mut children = block::Scanner::new(&lines, &mut diags, &none).scan_body(0, lines.len(), 0);
    let declared = resolve::declared_profiles(&children);
    let vocab = vocab::Vocabulary::of(&declared, opts.recognize);
    if !vocab.profiles.is_empty() {
        diags = diag::Diags::default();
        children = block::Scanner::new(&lines, &mut diags, &vocab).scan_body(0, lines.len(), 0);
    }
    // GEP-0008's structural rule is a diagnostic of the parse, as the reference
    // parser reports it; the rest of the family's checks report by address below.
    if vocab.has("geml-form/v1") {
        check::form::structure(&children, None, &mut diags);
    }
    let cx = resolve::Ctx { vocab: &vocab, declared: &declared, name: &opts.name, host: opts.host };
    let mut doc = resolve::finish(children, diags, &cx);
    if opts.checks && !doc.profiles.is_empty() {
        doc.profile_diagnostics = check::run(&doc, opts.host);
    }
    doc
}

/// Parse a document given as bytes, decoding UTF-8 as §0.1 requires.
pub fn parse_bytes(bytes: &[u8]) -> Document {
    parse(&normalize::decode(bytes))
}

/// §0.1's decoding on its own.
pub fn decode(bytes: &[u8]) -> String {
    normalize::decode(bytes)
}

/// The conformance projection of a document.
pub fn project(doc: &Document) -> String {
    project::project(doc)
}

/// The conformance block tree of a document.
pub fn blocks_of(doc: &Document) -> String {
    project::blocks_of(doc)
}

/// The document model as JSON.
pub fn to_json(doc: &Document) -> String {
    to_json::document(doc)
}

/// `code:severity` for each diagnostic.
pub fn diagnostic_codes(doc: &Document) -> Vec<String> {
    doc.diagnostics.iter().map(|d| format!("{}:{}", d.code, d.severity.as_str())).collect()
}
