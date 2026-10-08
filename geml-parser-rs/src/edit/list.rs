//! `list`: every addressable unit — address, kind, lines — as `geml list
//! --json` reports them.

use crate::json::Value;
use crate::model::{Block, Item};
use crate::uni::nfd;

use super::select::{inside_any, Indexed};
use super::units::{shortest_address, Kind};
use super::Refusal;

/// The ids of `.footnote` blocks, from one walk of the model.
fn footnote_ids(items: &[Item], out: &mut Vec<String>) {
    for it in items {
        match it {
            Item::Block(Block { id: Some(id), classes, children, .. }) => {
                if classes.iter().any(|c| c == "footnote") {
                    out.push(nfd(id));
                }
                footnote_ids(children, out);
            }
            Item::Block(b) => footnote_ids(&b.children, out),
            _ => {}
        }
    }
}

pub fn list(ix: &Indexed, within: Option<&str>) -> Result<Value, Refusal> {
    let scopes = match within {
        Some(w) => Some(ix.scopes(w)?),
        None => None,
    };
    // Which rows carry a type nothing registers: from the parse's own
    // `unknown-block-type` diagnostics, so the listing agrees with `check`.
    let unregistered: Vec<usize> = ix.doc.diagnostics.iter().filter(|d| d.code == "unknown-block-type").map(|d| d.line).collect();
    let mut footnotes = Vec::new();
    footnote_ids(&ix.doc.children, &mut footnotes);

    let mut rows = Vec::new();
    for a in &ix.all {
        let u = &a.unit;
        if let Some(s) = &scopes {
            if !inside_any(u, s) {
                continue;
            }
        }
        let mut row: Vec<(String, Value)> = vec![
            ("address".into(), Value::String(shortest_address(a, &ix.all))),
            ("kind".into(), Value::String(u.kind_name())),
            ("lines".into(), Value::Array(vec![Value::Number((u.span.start + 1) as f64), Value::Number(u.span.end as f64)])),
        ];
        match &u.id {
            None => row.push(("anon".into(), Value::Bool(true))),
            Some(id) => row.push(("id".into(), Value::String(id.clone()))),
        }
        if unregistered.contains(&(u.span.start + 1)) {
            row.push(("unknownType".into(), Value::Bool(true)));
        }
        if u.kind == Kind::Heading {
            row.push(("level".into(), Value::Number(u.level.unwrap_or(1) as f64)));
            row.push(("text".into(), Value::String(u.text.clone().unwrap_or_default())));
        }
        if u.id.as_deref().is_some_and(|id| footnotes.contains(&nfd(id))) {
            row.push(("footnote".into(), Value::Bool(true)));
        }
        rows.push(Value::Object(row));
    }
    Ok(Value::Array(rows))
}
