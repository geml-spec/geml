//! `geml-codemap/v1` §5: the profile's verifier. The core treats a codemap's
//! table cells and meta values as opaque; this reads the edge tables cell by
//! cell, and the meta `entry` list, and reports every reference that dangles.
//! The profile defines no diagnostic codes — a dangling edge is a build
//! failure — so this returns a report rather than diagnostics.

use std::rc::Rc;

use crate::host::Host;
use crate::model::{Document, Item};
use crate::resolve::{Index, Resolver, Target};

#[derive(Debug, Clone, PartialEq)]
pub struct Dangling {
    /// Where the reference is written: `#calls[3]["to"]`, `#meta["entry"]`.
    pub at: String,
    pub reference: String,
    pub why: String,
}

#[derive(Debug, Default, PartialEq)]
pub struct Report {
    pub dangling: Vec<Dangling>,
    /// Cross-document references no host could check.
    pub unchecked: Vec<String>,
    /// Document-level rules broken (§2): one `meta` block, the declaration.
    pub problems: Vec<String>,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.dangling.is_empty() && self.problems.is_empty()
    }

    /// `{"ok", "dangling": [{at, reference, why}], "unchecked", "problems"}`.
    pub fn to_json(&self) -> String {
        use crate::json::{to_json, Value};
        let s = |x: &str| Value::String(x.to_string());
        let list = |v: &[String]| Value::Array(v.iter().map(|x| s(x)).collect());
        let dangling = self
            .dangling
            .iter()
            .map(|d| Value::Object(vec![("at".into(), s(&d.at)), ("reference".into(), s(&d.reference)), ("why".into(), s(&d.why))]))
            .collect();
        to_json(&Value::Object(vec![
            ("ok".into(), Value::Bool(self.ok())),
            ("dangling".into(), Value::Array(dangling)),
            ("unchecked".into(), list(&self.unchecked)),
            ("problems".into(), list(&self.problems)),
        ]))
    }
}

/// The edge tables (§4): which columns hold references, and whether a cell
/// that is not a reference (`file:line`) is tolerated.
const TABLES: &[(&str, &[&str], bool)] = &[
    ("calls", &["from", "to"], false),
    ("called-by", &["from", "to"], false),
    ("ref-by", &["from", "to"], false),
    ("unresolved", &["from"], false),
    ("api-calls", &["from", "to"], true),
    ("api-served-by", &["from", "to"], true),
];

/// Split `doc.geml#id[.member]` into its document and its id.
fn split(reference: &str) -> Option<(Option<&str>, &str)> {
    let (doc, rest) = reference.split_once('#')?;
    let id = rest.split('.').next().unwrap_or(rest);
    Some((if doc.is_empty() { None } else { Some(doc) }, id))
}

pub fn verify(doc: &Document, host: Option<&dyn Host>) -> Report {
    let mut r = Report::default();
    if doc.meta_blocks != 1 {
        r.problems.push(format!("a codemap document carries exactly one `meta` block; this one carries {}", doc.meta_blocks));
    }
    if !doc.declared.iter().any(|d| d == "geml-codemap/v1") {
        r.problems.push("`profile = \"geml-codemap/v1\"` is required".into());
    }
    let resolver = Resolver::new(Rc::new(Index::of(doc)), host, &doc.name);
    let check = |at: String, reference: &str, lenient: bool, r: &mut Report| {
        let reference = reference.trim();
        let Some((d, id)) = split(reference) else {
            if !lenient {
                r.dangling.push(Dangling { at, reference: reference.to_string(), why: "not a reference".into() });
            }
            return;
        };
        match resolver.target(d, id) {
            Target::Hit { .. } => {}
            Target::NoHost => r.unchecked.push(reference.to_string()),
            Target::Unreadable => r.dangling.push(Dangling { at, reference: reference.to_string(), why: "the document could not be read".into() }),
            Target::Unresolved { message, .. } => r.dangling.push(Dangling { at, reference: reference.to_string(), why: message }),
        }
    };
    if let Some((_, v)) = doc.meta.iter().find(|(k, _)| k == "entry") {
        for e in v.scalar_text().unwrap_or_default().split_whitespace() {
            check("#meta[\"entry\"]".into(), e, false, &mut r);
        }
    }
    let mut all = Vec::new();
    crate::resolve::walk(&doc.children, &mut all);
    for it in all {
        let Item::Block(b) = it else { continue };
        let Some((tid, cols, lenient)) = TABLES.iter().find(|(t, _, _)| b.type_name == "table" && b.id.as_deref() == Some(*t)) else { continue };
        let Some(t) = &b.table else { continue };
        for c in cols.iter() {
            let Some(ci) = t.columns.iter().position(|x| x == c) else { continue };
            for (ri, row) in t.rows.iter().enumerate() {
                let cell = row[ci].text.trim();
                if cell.is_empty() {
                    continue;
                }
                check(format!("#{tid}[{}][\"{c}\"]", ri + 1), cell, *lenient, &mut r);
            }
        }
    }
    r
}
