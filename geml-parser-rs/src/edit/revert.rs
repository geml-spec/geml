//! `revert`: ONE unit restored from a revision of the document's
//! `.gemlhistory` (geml-history/v1), leaving every other byte as it is —
//! spliced back when it exists on both sides, resurrected when the revision
//! had it and the document does not, removed when the document has it and
//! the revision did not. The revision is reconstructed and checked against
//! its recorded hash before any of its text reaches the document.

use crate::check::history::{read, Sidecar};
use crate::uni::nfd;

use super::add::anchor_span;
use super::lines::{newline_of, split_physical, to_lf, to_newline};
use super::select::Indexed;
use super::units::{addressed_units, Kind, Span};
use super::write::{errors_added, insert_fragment, normalize_block_id, refuse_write, reparse, splice_span};
use super::{refuse, Reason, Refusal};

pub struct RevertOptions<'a> {
    /// `0` (the tip), `-N` (N back), a revision id or prefix, or `changed`.
    pub rev: &'a str,
    pub head_only: bool,
    pub before: Option<&'a str>,
    pub after: Option<&'a str>,
    pub append: bool,
}

pub enum Reverted {
    Unchanged,
    Text(String),
}

/// The blocks and headings of a text by id, in document order, first
/// declaration winning — what the history's units are keyed by.
fn block_spans(ix: &Indexed, text: &str) -> Vec<(String, Span)> {
    let doc = reparse(ix, text);
    let mut out: Vec<(String, Span)> = Vec::new();
    for a in addressed_units(text, &doc) {
        if a.unit.kind == Kind::Prose {
            continue;
        }
        let Some(id) = &a.unit.id else { continue };
        if !out.iter().any(|(k, _)| nfd(k) == nfd(id)) {
            out.push((id.clone(), a.unit.span));
        }
    }
    out
}

fn span_of<'a>(spans: &'a [(String, Span)], id: &str) -> Option<&'a Span> {
    let key = nfd(id);
    spans.iter().find(|(k, _)| nfd(k) == key).map(|(_, s)| s)
}

fn slice(text: &str, span: Span, head_only: bool) -> String {
    let lines = split_physical(text);
    let end = if head_only { span.start + 1 } else { span.end }.min(lines.len());
    if span.start >= end {
        return String::new();
    }
    lines[span.start..end].concat()
}

/// A revision by selector: an offset `0` / `-N` along the chain, else an
/// id or prefix.
fn resolve_revision<'a>(h: &'a Sidecar, sel: &str) -> Result<&'a crate::check::history::Revision, String> {
    let offset = if sel == "0" {
        Some(0)
    } else {
        sel.strip_prefix('-').filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())).and_then(|n| n.parse::<usize>().ok())
    };
    if let Some(n) = offset {
        let chain = h.chain()?;
        return chain.get(n).copied().ok_or_else(|| format!("history: offset {sel} is out of range (only {} revision(s))", chain.len()));
    }
    h.select(sel)
}

pub fn revert(ix: &Indexed, raw_id: &str, history: Option<&str>, o: &RevertOptions) -> Result<Reverted, Refusal> {
    let id = raw_id.strip_prefix('#').unwrap_or(raw_id);
    let source = ix.text;
    let nl = newline_of(source);
    let Some(sidecar_text) = history else {
        return refuse(Reason::RevertRefused, format!("history: no `.gemlhistory` sidecar for {}", ix.whereof()));
    };
    let h = read(sidecar_text);
    let cur_spans = block_spans(ix, source);
    let cur_full = span_of(&cur_spans, id).copied();
    let cur_block = cur_full.map(|s| slice(source, s, o.head_only));
    let pick = |text: &str| -> Option<String> { span_of(&block_spans(ix, text), id).map(|s| slice(text, *s, o.head_only)) };

    // The source revision: a position, or — `changed` — the first revision
    // whose copy of the unit differs from the document's.
    let target: (String, String) = if o.rev == "changed" {
        let current = cur_block.as_deref().map(to_lf).unwrap_or_default();
        let chain = h.chain().map_err(|m| Refusal::new(Reason::RevertRefused, m))?;
        let mut found = None;
        for r in chain {
            let text = h.reconstruct(&r.id).map_err(|m| Refusal::new(Reason::RevertRefused, m))?;
            if let Some(b) = pick(&text) {
                if to_lf(&b) != current {
                    found = Some((r.id.clone(), text));
                    break;
                }
            }
        }
        match found {
            Some(t) => t,
            None => return refuse(Reason::RevertRefused, format!("no earlier revision changes `{id}`")),
        }
    } else {
        let r = resolve_revision(&h, o.rev).map_err(|m| Refusal::new(Reason::RevertRefused, m))?;
        let text = h.reconstruct(&r.id).map_err(|m| Refusal::new(Reason::RevertRefused, m))?;
        (r.id.clone(), text)
    };
    let (target_id, target_text) = target;
    let old_block = pick(&target_text);

    if cur_block.is_none() && old_block.is_none() {
        return refuse(Reason::RevertRefused, format!("`{id}` exists in neither the document nor {target_id} (try --rev changed)"));
    }
    // Both present: SPLICE (undo set).
    if let (Some(cur), Some(old)) = (&cur_block, &old_block) {
        if to_lf(old) == to_lf(cur) {
            return Ok(Reverted::Unchanged);
        }
        let replacement = to_newline(old, nl);
        let span = cur_full.expect("present");
        return Ok(Reverted::Text(splice_span(ix, span, &replacement, o.head_only, false, Some(id), None)?));
    }
    if o.head_only {
        return refuse(Reason::BadAddress, "--head only applies when the block exists in both the document and the target revision");
    }
    let cmp = |text: &str| normalize_block_id(&to_lf(text), "__cmp__");

    // Absent now, present at R: RESURRECT (undo delete).
    if let Some(old) = &old_block {
        let key = cmp(old);
        for (cid, cs) in &cur_spans {
            if nfd(cid) == nfd(id) {
                continue;
            }
            if cmp(&slice(source, *cs, false)) == key {
                return refuse(Reason::RevertRefused, format!("#{id} looks renamed to #{cid}; use 'rename #{cid} #{id}' to undo the rename"));
            }
        }
        let lines = split_physical(source);
        let at = if o.append {
            lines.len()
        } else if let Some(b) = o.before {
            anchor_span(ix, b)?.start
        } else if let Some(a) = o.after {
            anchor_span(ix, a)?.end
        } else {
            // The neighbours it had in the revision: the nearest earlier one
            // still here, else the nearest later one, else the end.
            let rev_spans = block_spans(ix, &target_text);
            let idx = rev_spans.iter().position(|(k, _)| nfd(k) == nfd(id)).unwrap_or(0);
            let mut at = None;
            for (k, _) in rev_spans[..idx].iter().rev() {
                if let Some(s) = span_of(&cur_spans, k) {
                    at = Some(s.end);
                    break;
                }
            }
            if at.is_none() {
                for (k, _) in &rev_spans[idx + 1..] {
                    if let Some(s) = span_of(&cur_spans, k) {
                        at = Some(s.start);
                        break;
                    }
                }
            }
            at.unwrap_or(lines.len())
        };
        let fragment = to_newline(old, nl);
        return Ok(Reverted::Text(insert_fragment(ix, at, &fragment)?));
    }

    // Present now, absent at R: REMOVE (undo add).
    let cur = cur_block.as_deref().expect("present");
    let key = cmp(cur);
    for (rid, rs) in block_spans(ix, &target_text) {
        if nfd(&rid) == nfd(id) {
            continue;
        }
        if cmp(&slice(&target_text, rs, false)) == key {
            return refuse(Reason::RevertRefused, format!("#{id} looks renamed from #{rid}; revert would delete it — use 'rename #{id} #{rid}'"));
        }
    }
    let span = cur_full.expect("present");
    let lines = split_physical(source);
    let updated: String = lines.iter().enumerate().filter(|(i, _)| *i < span.start || *i >= span.end).map(|(_, l)| *l).collect();
    let reparsed = reparse(ix, &updated);
    let errs = errors_added(&ix.doc, &reparsed, ix.file, &|_| false);
    if !errs.is_empty() {
        return refuse_write(&ix.doc, errs, &format!("removing #{id} would break the document"));
    }
    if let Some(dropped) = ix.doc.ids.iter().find(|x| nfd(x) != nfd(id) && !reparsed.ids.contains(x)) {
        return refuse(Reason::WouldDropUnit, format!("removing #{id} would drop block `#{dropped}`; not written"));
    }
    Ok(Reverted::Text(updated))
}
