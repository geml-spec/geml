//! The type registry (§3): each type this specification defines, the body
//! mode it is read in, and the attribute keys it defines. `caption` and
//! `hidden` are valid on every typed block (§4).

use crate::model::Mode;

/// The types this specification registers.
pub const TYPES: &[&str] = &["code", "math", "table", "view", "data", "diagram", "embed", "note", "text", "meta"];

pub fn is_known(t: &str) -> bool {
    TYPES.contains(&t)
}

/// The body mode a type is read in. An unknown type keeps its body raw.
pub fn mode_of(t: &str) -> Mode {
    match t {
        "note" | "text" => Mode::Flow,
        "meta" => Mode::Data,
        _ => Mode::Raw,
    }
}

/// The attribute keys a known type defines, beside `caption` and `hidden`.
pub fn defined_attrs(t: &str) -> &'static [&'static str] {
    match t {
        "code" => &["lang", "src"],
        "table" => &["format", "header", "delim", "src"],
        "view" => &["src", "where", "order", "limit", "select", "compute", "summary", "by", "aggregate"],
        "data" => &["format", "src", "schema"],
        "diagram" => &["format", "data", "type", "x", "y", "series", "size", "rows", "src"],
        "embed" => &["src", "part"],
        _ => &[],
    }
}

pub fn defines_attr(t: &str, key: &str) -> bool {
    key == "caption" || key == "hidden" || defined_attrs(t).contains(&key)
}

/// Diagram formats with a renderer this processor knows of (§7). Any other
/// format is `unknown-diagram-format`.
pub const DIAGRAM_FORMATS: &[&str] = &["mermaid", "graphviz", "dot", "d2", "plantuml", "vega-lite", "geml-chart", "geml-code-graph"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry() {
        assert!(is_known("note") && !is_known("acme-chart"));
        assert_eq!(mode_of("text"), Mode::Flow);
        assert_eq!(mode_of("meta"), Mode::Data);
        assert_eq!(mode_of("acme"), Mode::Raw);
        assert!(defines_attr("code", "lang") && defines_attr("note", "caption") && defines_attr("math", "hidden"));
        assert!(!defines_attr("note", "flag") && !defines_attr("table", "compute"));
        assert!(defines_attr("view", "compute") && defines_attr("diagram", "series") && defines_attr("embed", "part"));
        assert!(defines_attr("data", "schema"));
    }
}
