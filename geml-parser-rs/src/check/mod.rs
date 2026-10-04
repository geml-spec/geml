//! The checks each recognized vocabulary runs over a document (`spec/profiles/`).
//! They report by address, with a profile's three severities, and run only for
//! a vocabulary the document declares and this processor recognizes.

pub mod codemap;
pub mod form;
pub mod history;
pub mod media;
pub mod style;
pub mod timeline;

use crate::host::Host;
use crate::model::{Block, Document};
use crate::vocab::{Level, ProfileDiagnostic};

/// Where checks collect what they report.
#[derive(Default)]
pub struct Out {
    pub list: Vec<ProfileDiagnostic>,
}

impl Out {
    pub fn push(&mut self, code: &'static str, level: Level, address: String, message: impl Into<String>) {
        self.list.push(ProfileDiagnostic { code, level, address, message: message.into() });
    }
}

/// A block's address: `doc#id`, or the document alone for an anonymous block.
pub fn addr(name: &str, b: &Block) -> String {
    match &b.id {
        Some(id) => format!("{name}#{id}"),
        None => format!("{name} (line {})", b.line),
    }
}

/// Run the checks of every vocabulary the document declares and this
/// processor recognizes.
pub fn run(doc: &Document, host: Option<&dyn Host>) -> Vec<ProfileDiagnostic> {
    let mut out = Out::default();
    for p in &doc.profiles {
        match p.as_str() {
            "geml-form/v1" => form::check(&doc.name, &doc.children, &mut out),
            "geml-media/v1" => media::check(doc, host, &mut out),
            "geml-style/v1" => style::check_sheet_alone(doc, &mut out),
            _ => {}
        }
    }
    out.list
}
