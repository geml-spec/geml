//! `check`: the document's diagnostics, each as `code:severity`.

use crate::model::Document;

pub fn check(doc: &Document) -> Vec<String> {
    crate::diagnostic_codes(doc)
}
