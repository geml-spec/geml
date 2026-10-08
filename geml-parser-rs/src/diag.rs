//! Diagnostics (Appendix A). The code and the severity are the contract; the
//! message is prose. Every code here is one the catalogue defines, and its
//! severity is the one the catalogue assigns.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostic {
    pub code: &'static str,
    pub severity: Severity,
    /// 1-based, in the normalized character stream (§0.5).
    pub line: usize,
    pub message: String,
}

/// The severity Appendix A assigns a code.
pub fn severity_of(code: &str) -> Severity {
    const WARNINGS: &[&str] = &[
        "unknown-block-type",
        "unknown-attribute",
        "stray-labeled-fence",
        "fence-like-line",
        "name-not-a-name",
        "heading-attrs-trailing-text",
        "heading-attrs-unclosed",
        "unchecked-cross-document-reference",
        "ignored-embed-body",
        "unrecognized-vocabulary",
        "unknown-meta-key",
        "duplicate-meta-key",
        "inexact-number",
        "unknown-table-format",
        "bad-embed-part",
        "ignored-table-delimiter",
        "ragged-table-row",
        "compute-non-numeric-cell",
        "compute-not-a-number",
        "shadowed-source-column",
        "unknown-diagram-format",
        "ignored-diagram-body",
        "code-graph-missing-src",
        "code-graph-unresolvable-document",
        "chart-unused-channel",
        "chart-summary-row-unavailable",
        "unknown-data-format",
        "data-format-no-engine",
        "unresolvable-code-source",
    ];
    if WARNINGS.contains(&code) {
        Severity::Warning
    } else {
        Severity::Error
    }
}

/// Where a parse collects what it has to say.
#[derive(Default, Debug)]
pub struct Diags {
    pub list: Vec<Diagnostic>,
}

impl Diags {
    pub fn push(&mut self, code: &'static str, line: usize, message: impl Into<String>) {
        self.list.push(Diagnostic { code, severity: severity_of(code), line, message: message.into() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severities_follow_the_catalogue() {
        assert_eq!(severity_of("duplicate-id"), Severity::Error);
        assert_eq!(severity_of("ragged-table-row"), Severity::Warning);
        assert_eq!(Severity::Error.as_str(), "error");
        assert_eq!(Severity::Warning.as_str(), "warning");
        let mut d = Diags::default();
        d.push("unknown-attribute", 3, "x");
        assert_eq!(d.list[0].severity, Severity::Warning);
        assert_eq!(d.list[0].line, 3);
    }
}
