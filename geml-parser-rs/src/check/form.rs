//! `geml-form/v1` reads the `form-*` family GEP-0008 defines. Every code here
//! is in the profile's conformance file, which carries GEP-0008's diagnostics
//! with the family until the GEP lands (its §1.1). The structural ones —
//! `form-child-outside-form`, `form-field-missing-name`, `form-duplicate-name`
//! — are diagnostics of the parse; the rest need a field's values or its whole
//! form and are the vocabulary's checks, as is the profile's §5 value warning,
//! `form-constraint-unreadable`. A field is named by `name=`, unique within its
//! form, and a coordinate addresses it by that name (`#signup["email"]`,
//! resolve.rs); its id, when it has one, is an ordinary document-level id.

use super::{addr, Out};
use crate::diag::Diags;
use crate::json::Value;
use crate::model::{Block, Item};
use crate::vocab::Level;

const FIELD_TYPES: &[&str] = &["text", "textarea", "number", "date", "boolean", "select", "file"];

fn is_family(t: &str) -> bool {
    matches!(t, "form-field" | "form-group" | "form-options" | "form-note")
}

/// The blocks of a form's body, its groups' included. Not only the `form-*`
/// ones: an `options=` naming a `table` of the same form says it names a table.
fn collect<'a>(items: &'a [Item], out: &mut Vec<&'a Block>) {
    for it in items {
        if let Item::Block(b) = it {
            out.push(b);
            if b.type_name == "form-group" {
                collect(&b.children, out);
            }
        }
    }
}

/// GEP-0008's structural rules, diagnostics of the parse like the reference
/// parser's: every `form-*` block is meaningful only inside a `form` — a field
/// sits in a form or in a group; a group, an options list and a note sit
/// directly in a form; groups do not nest — and every field carries a `name=`
/// no other field of its form carries. `parent` is the type of the block whose
/// body holds `items`.
pub fn structure(items: &[Item], parent: Option<&str>, diags: &mut Diags) {
    let mut names = Vec::new();
    structure_in(items, parent, &mut names, diags);
}

/// `names`: the field names of the enclosing form so far. A group adds
/// structure, not a namespace, so it passes its form's list down; a form
/// starts a fresh one.
fn structure_in(items: &[Item], parent: Option<&str>, names: &mut Vec<String>, diags: &mut Diags) {
    for it in items {
        let Item::Block(b) = it else { continue };
        let t = b.type_name.as_str();
        if is_family(t) {
            let placed = match t {
                "form-field" => matches!(parent, Some("form") | Some("form-group")),
                _ => parent == Some("form"),
            };
            if !placed {
                let belongs = match t {
                    "form-field" => "a field belongs directly in a `form`, or in a `form-group` inside one",
                    "form-group" => "a group belongs directly in a `form`, and groups do not nest",
                    _ => "it belongs directly in a `form`",
                };
                let whence = match parent {
                    Some(p) => format!("sits in a `{p}`"),
                    None => "lies outside any `form`".to_string(),
                };
                diags.push("form-child-outside-form", b.line, format!("`{t}` {whence}; {belongs} (GEP-0008)"));
            } else if t == "form-field" {
                // The name is the key the handler receives and the step a
                // coordinate addresses the field by; only a string is one.
                match b.attr("name") {
                    Some(Value::String(n)) if !n.is_empty() => {
                        if names.contains(n) {
                            diags.push(
                                "form-duplicate-name",
                                b.line,
                                format!("two fields of this form are named `{n}`; a name is unique within its form (GEP-0008)"),
                            );
                        } else {
                            names.push(n.clone());
                        }
                    }
                    _ => diags.push(
                        "form-field-missing-name",
                        b.line,
                        "a `form-field` needs `name=` — the key its handler receives, unique within the form (GEP-0008)",
                    ),
                }
            }
        }
        if t == "form" {
            let mut inner = Vec::new();
            structure_in(&b.children, Some(t), &mut inner, diags);
        } else {
            structure_in(&b.children, Some(t), names, diags);
        }
    }
}

pub fn check(name: &str, children: &[Item], out: &mut Out) {
    walk(name, children, out);
}

fn walk(name: &str, items: &[Item], out: &mut Out) {
    for it in items {
        let Item::Block(b) = it else { continue };
        let t = b.type_name.as_str();
        if t == "form-field" {
            if b.has_body() {
                out.push(
                    "form-field-has-body",
                    Level::Warning,
                    addr(name, b),
                    "a form field's body is empty; its text lives in attributes, and this body is not rendered (GEP-0008)",
                );
            }
            if let Some(ty) = b.attr_text("type") {
                if !FIELD_TYPES.contains(&ty.as_str()) {
                    out.push(
                        "form-unknown-field-type",
                        Level::Warning,
                        addr(name, b),
                        format!("`type={ty}` is none of the seven field types; it renders as `text` (GEP-0008)"),
                    );
                }
            }
            for why in unreadable(b) {
                out.push(
                    "form-constraint-unreadable",
                    Level::Warning,
                    addr(name, b),
                    format!("{why}; a constraint is declared, never evaluated, and a handler may not read this one (geml-form §5)"),
                );
            }
        }
        if t == "form" {
            let mut blocks = Vec::new();
            collect(&b.children, &mut blocks);
            check_form(name, &blocks, out);
        }
        walk(name, &b.children, out);
    }
}

/// `blocks`: the blocks of one form's body, its groups' included.
fn check_form(name: &str, blocks: &[&Block], out: &mut Out) {
    let find = |v: &str| v.strip_prefix('#').and_then(|id| blocks.iter().find(|b| b.id.as_deref() == Some(id)).copied());
    let named = |t: Option<&Block>| match t {
        Some(t) => format!("a `{}`", t.type_name),
        None => "nothing in this form".to_string(),
    };
    let mut used: Vec<&Block> = Vec::new();
    // A field's `#` attributes name a `form-*` block of the enclosing form
    // (GEP-0008, *Fields are named*): `options=` a `form-options`, a `#` in
    // `label=`, `description=` or `placeholder=` a `form-note`. The rule is the
    // field's; a group's text is text.
    for f in blocks.iter().filter(|b| b.type_name == "form-field") {
        if let Some(o) = f.attr_text("options") {
            match find(&o) {
                Some(t) if t.type_name == "form-options" => used.push(t),
                t => out.push(
                    "form-options-not-form-options",
                    Level::Error,
                    addr(name, f),
                    format!("`options={o}` names {}, not a `form-options` of this form (GEP-0008)", named(t)),
                ),
            }
        }
        for key in ["label", "description", "placeholder"] {
            let Some(Value::String(v)) = f.attr(key) else { continue };
            if !v.starts_with('#') {
                continue;
            }
            match find(v) {
                Some(t) if t.type_name == "form-note" => used.push(t),
                t => out.push(
                    "form-note-not-form-note",
                    Level::Error,
                    addr(name, f),
                    format!("`{key}={v}` names {}, not a `form-note` of this form (GEP-0008)", named(t)),
                ),
            }
        }
    }
    for b in blocks.iter().filter(|b| matches!(b.type_name.as_str(), "form-options" | "form-note")) {
        if !used.iter().any(|u| std::ptr::eq(*u, *b)) {
            out.push("form-unused-block", Level::Warning, addr(name, b), format!("no field of this form points at this `{}` (GEP-0008)", b.type_name));
        }
    }
}

/// A decimal number (the profile's §2: each value is a string, read by its
/// key). A value written as a number is one already; a quoted one is read by
/// the same grammar — `5`, `-0.5`, `.5`, `1e3` — and must be finite.
fn number(v: Option<&Value>) -> Option<f64> {
    let n = match v? {
        Value::Number(n) => *n,
        Value::String(s) if decimal(s) => s.parse::<f64>().ok()?,
        _ => return None,
    };
    n.is_finite().then_some(n)
}

/// `[+-]? (digits (. digits)? | . digits) ([eE] [+-]? digits)?`
fn decimal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let digits = |i: &mut usize| {
        let start = *i;
        while b.get(*i).is_some_and(u8::is_ascii_digit) {
            *i += 1;
        }
        *i > start
    };
    let int = digits(&mut i);
    if b.get(i) == Some(&b'.') {
        i += 1;
        if !digits(&mut i) {
            return false;
        }
    } else if !int {
        return false;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if !digits(&mut i) {
            return false;
        }
    }
    i == b.len()
}

/// An ISO-8601 calendar date, `YYYY-MM-DD`, of a day that exists.
fn iso_date(v: Option<&Value>) -> bool {
    let Some(Value::String(s)) = v else { return false };
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| -> Option<u32> {
        let part = &s[r];
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok()).flatten()
    };
    let (Some(y), Some(m), Some(d)) = (num(0..4), num(5..7), num(8..10)) else { return false };
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&d)
}

/// An ECMAScript regular expression, read with the `u` flag (the profile's §2).
fn pattern(v: Option<&Value>) -> bool {
    let text = match v {
        Some(Value::String(s)) => s.clone(),
        Some(n @ Value::Number(_)) => n.scalar_text().unwrap_or_default(),
        _ => return false,
    };
    regress::Regex::with_flags(&text, "u").is_ok()
}

/// The profile's §5 MAY: a constraint value unreadable in its key's own terms.
/// How `min=` and `max=` read depends on `type=` — a number on a `number`, a
/// date on a `date`, and nothing is judged on another type; the other three
/// keys read the same on any type. A value is only read, never evaluated
/// against anything (the profile's §3).
fn unreadable(f: &Block) -> Vec<String> {
    let mut out = Vec::new();
    let ty = f.attr_text("type");
    for key in ["min", "max"] {
        let Some(v) = f.attr(key) else { continue };
        match ty.as_deref() {
            Some("number") if number(Some(v)).is_none() => out.push(format!("`{key}=` on a `number` field is not a number")),
            Some("date") if !iso_date(Some(v)) => out.push(format!("`{key}=` on a `date` field is not an ISO-8601 date (YYYY-MM-DD)")),
            _ => {}
        }
    }
    if let Some(v) = f.attr("step") {
        if !number(Some(v)).is_some_and(|n| n > 0.0) {
            out.push("`step=` is not a positive number".to_string());
        }
    }
    if let Some(v) = f.attr("maxlength") {
        if !number(Some(v)).is_some_and(|n| n >= 0.0 && n.fract() == 0.0) {
            out.push("`maxlength=` is not a non-negative integer".to_string());
        }
    }
    if let Some(v) = f.attr("pattern") {
        if !pattern(Some(v)) {
            out.push("`pattern=` is not a valid regular expression".to_string());
        }
    }
    out
}
