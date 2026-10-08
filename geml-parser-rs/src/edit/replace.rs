//! `replace`: a LITERAL swap, checked and reported. Every occurrence inside
//! the scope (the document, or the units a selector names); an id is not
//! text and is never changed; a result that would carry an error is refused.

use super::lines::split_physical;
use super::select::Indexed;
use super::write::{errors_added, refuse_write, reparse};
use super::{refuse, Reason, Refusal};

pub fn replace(ix: &Indexed, old: &str, new: &str, within: Option<&str>) -> Result<String, Refusal> {
    let source = ix.text;
    let whereof = ix.whereof();
    let lines = split_physical(source);
    let mut line_start = Vec::with_capacity(lines.len());
    let mut at = 0;
    for l in &lines {
        line_start.push(at);
        at += l.len();
    }
    let scopes: Vec<(usize, usize)> = match within {
        None => vec![(0, source.len())],
        Some(w) => ix
            .select(w, false)?
            .0
            .into_iter()
            .map(|u| {
                let from = line_start.get(u.span.start).copied().unwrap_or(source.len());
                let to = if u.span.end >= line_start.len() { source.len() } else { line_start[u.span.end] };
                (from, to)
            })
            .collect(),
    };
    let mut hits: Vec<usize> = Vec::new();
    if !old.is_empty() {
        for (from, to) in &scopes {
            let mut pos = *from;
            while let Some(i) = source[pos..].find(old) {
                let hit = pos + i;
                if hit + old.len() > *to {
                    break;
                }
                hits.push(hit);
                pos = hit + old.len();
            }
        }
    }
    hits.sort_unstable();
    hits.dedup();
    if hits.is_empty() {
        let scope = match within {
            None => whereof.to_string(),
            Some(w) => format!("`{w}` of {whereof}"),
        };
        return refuse(Reason::NoSuchUnit, format!("`{old}` does not occur in {scope} — nothing written"));
    }
    let mut updated = source.to_string();
    for &h in hits.iter().rev() {
        updated.replace_range(h..h + old.len(), new);
    }

    // An id is not text to be swapped.
    let before = &ix.doc;
    let after = reparse(ix, &updated);
    let gone: Vec<&String> = before.ids.iter().filter(|x| !after.ids.contains(x)).collect();
    let fresh: Vec<&String> = after.ids.iter().filter(|x| !before.ids.contains(x)).collect();
    if let (Some(g), Some(n)) = (gone.first(), fresh.first()) {
        return refuse(
            Reason::BadContent,
            format!("that would rename `#{g}` to `#{n}` — an id is not text: use `geml rename {whereof} '#{g}' '#{n}'`, which fixes every reference too"),
        );
    }
    let errs = errors_added(before, &after, ix.file, &|_| false);
    if !errs.is_empty() {
        return refuse_write(before, errs, "the replacement would break the document");
    }
    Ok(updated)
}
