//! The editing operations of §8.2(10): `list`, `find`, `get`, `check`, `to`,
//! `replace`, `set`, `add`, `delete`, `rename` and `revert`, written to the
//! conformance suite's `edits-*.json` cases.
//!
//! Each operation takes a document as text, names units by the addresses a
//! listing gives (§4), and either answers (an [`Outcome`]) or refuses with a
//! [`Refusal`] carrying one of Appendix A.6's eight reasons. An operation that
//! rewrites the document changes only the lines of the unit it names (§0.5
//! keeps line indices stable), so every other byte — line endings included —
//! comes back as it went in.

pub mod add;
pub mod case;
pub mod check;
pub mod coord;
pub mod delete;
pub mod find;
pub mod from_md;
pub mod get;
pub mod lines;
pub mod list;
pub mod md;
pub mod rename;
pub mod replace;
pub mod revert;
pub mod select;
pub mod selector;
pub mod serialize;
pub mod set;
pub mod to;
pub mod to_md;
pub mod units;
pub mod write;

use crate::diag::Diagnostic;

/// Why an operation wrote nothing: spec Appendix A.6.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    NoSuchUnit,
    AmbiguousAddress,
    BadAddress,
    BadContent,
    WouldDropUnit,
    BrokenResult,
    RenameRefused,
    RevertRefused,
}

impl Reason {
    /// The code as Appendix A.6 spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::NoSuchUnit => "no-such-unit",
            Reason::AmbiguousAddress => "ambiguous-address",
            Reason::BadAddress => "bad-address",
            Reason::BadContent => "bad-content",
            Reason::WouldDropUnit => "would-drop-unit",
            Reason::BrokenResult => "broken-result",
            Reason::RenameRefused => "rename-refused",
            Reason::RevertRefused => "revert-refused",
        }
    }
}

/// A refusal: the reason, this implementation's wording, and — for
/// `broken-result` — the diagnostics the rewritten document would carry.
#[derive(Clone, Debug)]
pub struct Refusal {
    pub reason: Reason,
    pub message: String,
    pub diagnostics: Vec<Diagnostic>,
}

impl Refusal {
    pub fn new(reason: Reason, message: impl Into<String>) -> Refusal {
        Refusal { reason, message: message.into(), diagnostics: Vec::new() }
    }
}

/// Shorthand for the one-line refusals.
pub(crate) fn refuse<T>(reason: Reason, message: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal::new(reason, message))
}

/// What an operation answers.
#[derive(Clone, Debug)]
pub enum Outcome {
    /// The rewritten document, byte for byte.
    Text(String),
    /// What `get` or `to` prints.
    Output(String),
    /// What `list` reports: one object per unit, as `geml list --json` prints them.
    Rows(crate::json::Value),
    /// What `find` reports: one object per unit hit.
    Hits(crate::json::Value),
    /// `check`: each diagnostic as `code:severity`.
    Diagnostics(Vec<String>),
    /// `revert`: the unit already matches the revision; nothing to write.
    Unchanged,
}

/// Why a case could not be run at all — distinct from a refusal, which is an
/// answer: the operation (or the document's language) is not implemented
/// here yet. A harness counts these as skipped, never as passed.
#[derive(Clone, Debug)]
pub struct Unsupported(pub String);

pub use case::{case_from_json, run, run_json, Case, Op};
