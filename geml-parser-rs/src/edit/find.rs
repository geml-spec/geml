//! `find`: the units whose source contains a text, as addresses. Matched by
//! LINE, each line resolved to the innermost unit holding it — `grep`
//! composed with the `L` selector — so a hit names the block to edit, never
//! the chapter around it, and one unit is one hit however many of its lines
//! matched.

use crate::json::Value;

use super::lines::lf_lines;
use super::select::Indexed;
use super::units::{match_line, shortest_address};
use super::{Reason, Refusal};

pub struct FindOptions<'a> {
    pub sensitive: bool,
    pub with_line: bool,
    pub within: Option<&'a str>,
}

pub fn find(ix: &Indexed, pattern: &str, o: &FindOptions) -> Result<Value, Refusal> {
    let needle = if o.sensitive { pattern.to_string() } else { pattern.to_lowercase() };
    // `within`: a selector naming nothing means the file is simply not
    // searched; a malformed one is still refused.
    let scopes = match o.within {
        Some(w) => match ix.scopes(w) {
            Ok(s) => Some(s),
            Err(r) if r.reason == Reason::NoSuchUnit => return Ok(Value::Array(Vec::new())),
            Err(r) => return Err(r),
        },
        None => None,
    };
    let lines = lf_lines(ix.text);
    let mut seen: Vec<(usize, usize)> = Vec::new();
    let mut hits = Vec::new();
    for (i, raw) in lines.iter().enumerate() {
        let hay = if o.sensitive { raw.clone() } else { raw.to_lowercase() };
        if !hay.contains(&needle) {
            continue;
        }
        if let Some(s) = &scopes {
            if !s.iter().any(|s| i >= s.start && i < s.end) {
                continue;
            }
        }
        let Some(unit) = match_line(i + 1, i + 1, &ix.all) else { continue };
        let key = (unit.span.start, unit.span.end);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let a = ix.all.iter().find(|a| a.unit.span == unit.span && a.unit.kind == unit.kind).expect("a listed unit");
        let mut hit: Vec<(String, Value)> = vec![
            ("file".into(), Value::String(ix.file.to_string())),
            ("address".into(), Value::String(shortest_address(a, &ix.all))),
            ("kind".into(), Value::String(unit.kind_name())),
            ("lines".into(), Value::Array(vec![Value::Number((unit.span.start + 1) as f64), Value::Number(unit.span.end as f64)])),
        ];
        if o.with_line {
            hit.push(("line".into(), Value::String(raw.trim().to_string())));
        }
        hits.push(Value::Object(hit));
    }
    Ok(Value::Array(hits))
}
