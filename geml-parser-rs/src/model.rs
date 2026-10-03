//! The document model: what a parse produces.

use crate::diag::Diagnostic;
use crate::json::Value;

#[derive(Debug, Default)]
pub struct Document {
    pub children: Vec<Item>,
    pub diagnostics: Vec<Diagnostic>,
    /// The merged `meta` namespace (§4), first definition winning.
    pub meta: Vec<(String, Value)>,
    /// How many `meta` blocks the document carries.
    pub meta_blocks: usize,
    /// The document's block ids, declared and derived, in document order.
    pub ids: Vec<String>,
    /// The `#…` addresses a listing gives (§4), in document order.
    pub addresses: Vec<String>,
    /// The prose addresses among them, without the `#`.
    pub prose: Vec<String>,
    /// The document's name: what its relative references resolve against.
    pub name: String,
    /// The vocabulary names its `profile` declares (§8.6).
    pub declared: Vec<String>,
    /// The declared vocabularies this processor recognized.
    pub profiles: Vec<String>,
    /// What those vocabularies' checks report, by address.
    pub profile_diagnostics: Vec<crate::vocab::ProfileDiagnostic>,
}

#[derive(Debug, Clone)]
pub enum Item {
    Paragraph(Paragraph),
    Heading(Heading),
    List(List),
    Hidden(Hidden),
    Block(Block),
}

impl Item {
    pub fn line(&self) -> usize {
        match self {
            Item::Paragraph(p) => p.line,
            Item::Heading(h) => h.line,
            Item::List(l) => l.line,
            Item::Hidden(h) => h.line,
            Item::Block(b) => b.line,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Paragraph {
    pub source: String,
    pub inlines: Vec<Inline>,
    pub line: usize,
}

#[derive(Debug, Clone)]
pub struct Heading {
    pub level: usize,
    /// The heading's text as written, before interpolation, attributes removed.
    pub text: String,
    pub inlines: Vec<Inline>,
    pub id: String,
    /// Whether the id was declared with `{#id}` rather than derived.
    pub declared: bool,
    pub classes: Vec<String>,
    pub attrs: Vec<(String, Value)>,
    pub line: usize,
}

#[derive(Debug, Clone)]
pub struct List {
    pub ordered: bool,
    pub start: f64,
    pub loose: bool,
    pub items: Vec<ListItem>,
    pub line: usize,
}

#[derive(Debug, Clone)]
pub struct ListItem {
    pub source: String,
    pub inlines: Vec<Inline>,
    pub checked: Option<bool>,
    pub children: Vec<List>,
    pub line: usize,
}

#[derive(Debug, Clone)]
pub struct Hidden {
    pub text: String,
    pub line: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Raw,
    Flow,
    /// Key–value, as `meta` holds it; serialized as `"data"` (§3).
    Data,
    /// Paragraphs and inline content only (GEP-0013): a vocabulary's prose type.
    Prose,
}

#[derive(Debug, Clone)]
pub struct Block {
    pub type_name: String,
    pub id: Option<String>,
    pub classes: Vec<String>,
    pub attrs: Vec<(String, Value)>,
    pub mode: Mode,
    pub raw: Vec<String>,
    pub children: Vec<Item>,
    /// A `meta` block's keys, in the order it defines them.
    pub data: Vec<(String, Value)>,
    /// A `data` block's parsed value.
    pub value: Option<Value>,
    /// The relation a `table` holds or a `view` publishes.
    pub table: Option<Table>,
    /// The opening fence's line.
    pub line: usize,
    /// The first and one-past-last line of the body (1-based).
    pub body_start: usize,
    pub body_end: usize,
    /// The closing fence's line, or the body's last line when it never closes.
    pub end: usize,
}

impl Block {
    pub fn attr(&self, key: &str) -> Option<&Value> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// An attribute as the text it carries: a string as itself, a number or a
    /// boolean as it prints.
    pub fn attr_text(&self, key: &str) -> Option<String> {
        self.attr(key).and_then(|v| v.scalar_text())
    }

    /// Whether the body holds anything but blank lines.
    pub fn has_body(&self) -> bool {
        match self.mode {
            Mode::Raw => self.raw.iter().any(|l| !l.trim().is_empty()),
            Mode::Flow | Mode::Prose => !self.children.is_empty(),
            Mode::Data => !self.data.is_empty(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Cell {
    pub text: String,
    pub num: Option<f64>,
}

impl Cell {
    pub fn text(s: impl Into<String>) -> Cell {
        let text = s.into();
        let num = crate::num::parse_bare_number(&text);
        Cell { text, num }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Table {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
    pub summary: Option<Vec<Cell>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Inline {
    Text(String),
    Emph(Vec<Inline>),
    Strong(Vec<Inline>),
    Strike(Vec<Inline>),
    Code(String),
    Math(String),
    Break,
    Image { src: String, alt: Vec<Inline> },
    Link { href: Option<String>, doc: Option<String>, anchor: Option<String>, children: Vec<Inline> },
    AutoRef { doc: Option<String>, anchor: String, value: Option<String> },
    Project { doc: Option<String>, anchor: String, value: Option<String> },
    Footnote(String),
}
