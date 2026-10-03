//! `geml-form/v1` reads the `form-*` family GEP-0008 defines. The diagnostics
//! below are GEP-0008's family diagnostics; the structural ones —
//! `form-child-outside-form`, `form-field-missing-name`, `form-duplicate-name`
//! — are the codes the profile's conformance file lists (its §1.1 carries them
//! with the family until the GEP lands). A field is named by `name=`, unique
//! within its form, and a coordinate addresses it by that name
//! (`#signup["email"]`, resolve.rs); its id, when it has one, is an ordinary
//! document-level id.

use super::{addr, Out};
use crate::diag::Diags;
use crate::json::Value;
use crate::model::{Block, Item};
use crate::vocab::Level;

const FIELD_TYPES: &[&str] = &["text", "textarea", "number", "date", "boolean", "select", "file"];

fn is_family(t: &str) -> bool {
    matches!(t, "form-field" | "form-group" | "form-options" | "form-note")
}

fn collect<'a>(items: &'a [Item], out: &mut Vec<&'a Block>) {
    for it in items {
        if let Item::Block(b) = it {
            if is_family(&b.type_name) {
                out.push(b);
            }
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
                out.push("form-field-has-body", Level::Warning, addr(name, b), "a form field's body is empty; its text lives in attributes");
            }
            if let Some(ty) = b.attr_text("type") {
                if !FIELD_TYPES.contains(&ty.as_str()) {
                    out.push(
                        "unknown-field-type",
                        Level::Warning,
                        addr(name, b),
                        format!("`type={ty}` is none of the seven field types; it renders as `text`"),
                    );
                }
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

/// `blocks`: the `form-*` blocks of one form, its groups' included.
fn check_form(name: &str, blocks: &[&Block], out: &mut Out) {
    let find = |id: &str| blocks.iter().find(|b| b.id.as_deref() == Some(id)).copied();
    let mut used: Vec<&str> = Vec::new();
    // A field's `#` attributes, and a group's label and description, name a
    // `form-*` block of the enclosing form (GEP-0008, *Fields are named*).
    for f in blocks.iter().filter(|b| b.type_name == "form-field" || b.type_name == "form-group") {
        if let Some(o) = f.attr_text("options").filter(|_| f.type_name == "form-field") {
            match o.strip_prefix('#').and_then(find) {
                Some(t) if t.type_name == "form-options" => used.push(t.id.as_deref().unwrap_or_default()),
                _ => out.push("options-not-form-options", Level::Error, addr(name, f), format!("`options={o}` names no `form-options` of this form")),
            }
        }
        for key in ["label", "description", "placeholder"] {
            let Some(v) = f.attr_text(key) else { continue };
            let Some(id) = v.strip_prefix('#') else { continue };
            match find(id) {
                Some(t) if t.type_name == "form-note" => used.push(t.id.as_deref().unwrap_or_default()),
                _ => out.push("note-not-form-note", Level::Error, addr(name, f), format!("`{key}={v}` names no `form-note` of this form")),
            }
        }
    }
    for b in blocks.iter().filter(|b| matches!(b.type_name.as_str(), "form-options" | "form-note")) {
        if !b.id.as_deref().is_some_and(|id| used.contains(&id)) {
            out.push("unused-form-block", Level::Warning, addr(name, b), format!("no field of this form points at this `{}`", b.type_name));
        }
    }
}
