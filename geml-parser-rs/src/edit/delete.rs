//! `delete`: every unit the addresses name, removed — each with the blank
//! line that separated it, so a delete undoes an add byte for byte. It is
//! idempotent: an address naming nothing is reported, not refused. A
//! reference left dangling is reported too, never a refusal (§8.2(10)).

use std::collections::BTreeSet;

use super::lines::{split_physical, strip_eol};
use super::select::Indexed;
use super::{Reason, Refusal};

pub struct Deleted {
    pub text: String,
    /// What was skipped or left dangling, as the CLI notes it.
    pub notes: Vec<String>,
}

pub fn delete(ix: &Indexed, addresses: &[String]) -> Result<Deleted, Refusal> {
    // GEP 0011: a coordinate removes a unit inside a block. It goes alone: two
    // in one sequence would each be counted against the other's removal.
    let coord = addresses.iter().find(|a| matches!(super::selector::parse_selector(a), super::selector::Selector::Coord { .. }));
    if let Some(c) = coord {
        if addresses.len() > 1 {
            return super::refuse(
                Reason::BadAddress,
                format!("`{}` removes a unit inside a block, and is deleted on its own — give it to `delete` alone", c.trim()),
            );
        }
        let text = super::set::edit_coord(ix, c, super::coord::TreeEdit::Remove)?;
        return Ok(Deleted { text, notes: Vec::new() });
    }
    let mut to_delete: BTreeSet<usize> = BTreeSet::new();
    let mut notes = Vec::new();
    let mut found = 0;
    for raw in addresses {
        let units = match ix.select(raw, false) {
            Ok((units, _)) => units,
            Err(r) if r.reason == Reason::NoSuchUnit => {
                notes.push(format!("skipped {}: no such block", address_label(raw)));
                continue;
            }
            Err(r) => return Err(r),
        };
        found += units.len();
        for u in units {
            to_delete.extend(u.span.start..u.span.end);
        }
    }
    if found == 0 {
        return Ok(Deleted { text: ix.text.to_string(), notes });
    }
    let lines = split_physical(ix.text);
    let blank = |i: usize| strip_eol(lines[i]).trim().is_empty();
    // Runs are the blocks' own lines; a separator taken must not fuse two.
    let runs = to_delete.clone();
    let mut extra: Vec<usize> = Vec::new();
    for s in 0..lines.len() {
        if !runs.contains(&s) || (s > 0 && runs.contains(&(s - 1))) {
            continue; // s starts a run
        }
        let kept = |mut i: i64, step: i64| -> i64 {
            while i >= 0 && (i as usize) < lines.len() && to_delete.contains(&(i as usize)) {
                i += step;
            }
            i
        };
        let prev = kept(s as i64, -1);
        let next = kept(s as i64, 1);
        let at_start = prev < 0;
        let at_end = next >= lines.len() as i64;
        if !at_end && blank(next as usize) && (at_start || blank(prev as usize)) {
            extra.push(next as usize);
        } else if at_end && !at_start && blank(prev as usize) {
            extra.push(prev as usize);
        }
    }
    to_delete.extend(extra);
    let text: String = lines.iter().enumerate().filter(|(i, _)| !to_delete.contains(i)).map(|(_, l)| *l).collect();
    Ok(Deleted { text, notes })
}

/// How a note names an address: ids as `#id`, anything else as typed.
fn address_label(raw: &str) -> String {
    let t = raw.trim();
    let bare = t.strip_prefix('#').unwrap_or(t);
    if !bare.is_empty() && bare.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        format!("#{bare}")
    } else {
        t.to_string()
    }
}
