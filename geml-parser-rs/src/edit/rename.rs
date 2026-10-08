//! `rename`: an id and every reference to it rewritten — nothing else. The
//! rewrite is id-boundary safe (`#old` only where no id character follows),
//! skips raw and data bodies, and is refused when any OTHER id would change.

use crate::uni::nfd;

use super::lines::split_physical;
use super::select::Indexed;
use super::units::Kind;
use super::write::{body_range, errors_added, is_opaque_block, refuse_write, reparse};
use super::{refuse, Reason, Refusal};

fn is_id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Replace `#old` (and `[^old`) by `#new` where no id character follows.
fn rewrite_line(line: &str, old: &str, new: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let chars: Vec<char> = line.chars().collect();
    let old_chars: Vec<char> = old.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let marker = if chars[i] == '#' {
            Some(1)
        } else if chars[i] == '[' && i + 1 < chars.len() && chars[i + 1] == '^' {
            Some(2)
        } else {
            None
        };
        if let Some(m) = marker {
            let start = i + m;
            let end = start + old_chars.len();
            if end <= chars.len() && chars[start..end] == old_chars[..] && (end == chars.len() || !is_id_char(chars[end])) {
                out.extend(chars[i..start].iter());
                out.push_str(new);
                i = end;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn has_name(ids: &[String], n: &str) -> bool {
    let key = nfd(n);
    ids.iter().any(|x| nfd(x) == key)
}

pub fn rename(ix: &Indexed, raw_old: &str, raw_new: &str) -> Result<String, Refusal> {
    let old_id = raw_old.strip_prefix('#').unwrap_or(raw_old);
    let new_id = raw_new.strip_prefix('#').unwrap_or(raw_new);
    if old_id == new_id {
        return refuse(Reason::RenameRefused, "#old and #new are the same id — nothing to rename");
    }
    let before = &ix.doc;
    if !has_name(&before.ids, old_id) {
        return refuse(Reason::NoSuchUnit, format!("no block with id `{old_id}`"));
    }
    if has_name(&before.ids, new_id) {
        return refuse(Reason::RenameRefused, format!("id `{new_id}` already exists; not written"));
    }
    // Markdown has no way to name a heading apart from its text: its anchor
    // is the text, so it changes with the text and not otherwise.
    if crate::is_markdown_path(ix.file) {
        let heading = ix.all.iter().find(|a| a.unit.kind == Kind::Heading && a.unit.id.as_deref().map(nfd) == Some(nfd(old_id)));
        if let Some(h) = heading {
            if !super::md::declares_id(split_physical(ix.text).get(h.unit.span.start).copied().unwrap_or("")) {
                return refuse(
                    Reason::RenameRefused,
                    format!("in Markdown a heading's anchor is its text, so `#{old_id}` cannot be renamed apart from it — change the heading's text instead (geml set <file> '#{old_id}' --head), and the links to it follow"),
                );
            }
        }
    }

    // Raw and data bodies are opaque: a `#old` inside one is text.
    let lines = split_physical(ix.text);
    let mut protected = vec![false; lines.len()];
    for a in &ix.all {
        if a.unit.kind != Kind::Block {
            continue;
        }
        let Some(id) = &a.unit.id else { continue };
        if !is_opaque_block(before, id) {
            continue;
        }
        let br = body_range(&lines, a.unit.span);
        for p in protected.iter_mut().take(br.end.min(lines.len())).skip(br.start) {
            *p = true;
        }
    }
    let updated: String = lines.iter().enumerate().map(|(i, l)| if protected[i] { l.to_string() } else { rewrite_line(l, old_id, new_id) }).collect();

    let reparsed = reparse(ix, &updated);
    let errs = errors_added(before, &reparsed, ix.file, &|_| false);
    if !errs.is_empty() {
        return refuse_write(before, errs, "rename would break the document");
    }
    if !has_name(&reparsed.ids, new_id) {
        return refuse(Reason::BrokenResult, format!("rename did not produce #{new_id}; not written"));
    }
    if has_name(&reparsed.ids, old_id) {
        return refuse(Reason::BrokenResult, format!("#{old_id} still present after rename; not written"));
    }
    // Every OTHER id must be untouched.
    let mut others_before: Vec<&String> = before.ids.iter().filter(|x| x.as_str() != old_id).collect();
    let mut others_after: Vec<&String> = reparsed.ids.iter().filter(|x| x.as_str() != new_id).collect();
    others_before.sort();
    others_after.sort();
    if others_before != others_after {
        return refuse(Reason::RenameRefused, format!("rename would also change other ids sharing the `{old_id}` prefix (e.g. `#{old_id}…`); not written"));
    }
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::rewrite_line;

    #[test]
    fn boundary_safe() {
        assert_eq!(rewrite_line("see [[#a]] and #ab and {#a}", "a", "z"), "see [[#z]] and #ab and {#z}");
        assert_eq!(rewrite_line("[^a]: note [^ab]", "a", "z"), "[^z]: note [^ab]");
        assert_eq!(rewrite_line("=== #a", "a", "z"), "=== #z");
    }
}
