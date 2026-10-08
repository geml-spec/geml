//! What every rewrite shares: the guarded splice. The new bytes go in by
//! LINE between the untouched bytes before and after the unit (in the
//! document's own newline style), the result is parsed, and a result that
//! would carry an error is refused with those diagnostics — nothing is
//! written. A GEML document forgives nothing: a result with an error is a
//! broken result whether the edit caused it or the document already had it,
//! because "every reference resolves" is the contract its author opted into.

use crate::attrs::read_object;
use crate::block::{labeled_close_id, parse_fence_open};
use crate::diag::{Diagnostic, Severity};
use crate::model::{Document, Item, Mode};
use crate::uni::nfd;

use super::lines::{newline_of, split_physical, strip_eol, to_newline, trim_space_tab_end};
use super::select::Indexed;
use super::units::{addressed_units, Kind, Span};
use super::{refuse, Reason, Refusal};

/// The error-level diagnostics a rewritten document would carry, minus the
/// ones `exclude` names (a reference left dangling by a removal, which the
/// caller reports rather than refuses).
///
/// Outside GEML — someone's Markdown, which GEML is reading but whose author
/// made no promise about references — an error the document already had
/// blocks no unrelated edit: only what the edit introduced counts, by
/// message and by how many times it occurs, so a second copy of an old error
/// is still refused. A duplicate id is never forgiven.
pub fn errors_added(before: &Document, after: &Document, file: &str, exclude: &dyn Fn(&Diagnostic) -> bool) -> Vec<Diagnostic> {
    let errs = after.diagnostics.iter().filter(|d| d.severity == Severity::Error && !exclude(d));
    if file == "-" || file.ends_with(".geml") {
        return errs.cloned().collect();
    }
    let mut had: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for d in before.diagnostics.iter().filter(|d| d.severity == Severity::Error && d.code != "duplicate-id") {
        *had.entry(d.message.as_str()).or_default() += 1;
    }
    let mut seen: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    errs.filter(|d| {
        let n = seen.entry(d.message.as_str()).or_default();
        *n += 1;
        *n > had.get(d.message.as_str()).copied().unwrap_or(0)
    })
    .cloned()
    .collect()
}

/// A refusal over a broken result: `broken-result`, carrying the diagnostics.
pub fn refuse_write<T>(before: &Document, errs: Vec<Diagnostic>, verb: &str) -> Result<T, Refusal> {
    let first = &errs[0];
    let what = format!("{} (line {})", first.message, first.line);
    let had: Vec<String> = before.diagnostics.iter().filter(|d| d.severity == Severity::Error).map(error_key).collect();
    let predated = errs.iter().all(|d| had.contains(&error_key(d)));
    let message = if predated {
        format!("refused by an error the document ALREADY had, which this edit did not cause: {what}; not written — repair it first (`geml check` lists them), until then no write to this document can be validated")
    } else {
        format!("{verb}: {what}; not written")
    };
    Err(Refusal { reason: Reason::BrokenResult, message, diagnostics: errs })
}

fn error_key(d: &Diagnostic) -> String {
    format!("{}:{}", d.code, d.message)
}

/// Parse the way every verb parses its document: as `ix` was parsed.
pub fn reparse(ix: &Indexed, text: &str) -> Document {
    let opts = crate::Options { name: ix.file.to_string(), host: ix.host, markdown: crate::is_markdown_path(ix.file), ..Default::default() };
    crate::parse_with(text, &opts)
}

/// How many typed-block units a document holds.
pub fn count_block_units(text: &str, doc: &Document) -> usize {
    addressed_units(text, doc).iter().filter(|a| a.unit.kind == Kind::Block).count()
}

/// Whether the result still has a unit named `id`: in its ids, or as a
/// prose address — those are position-derived and never in `ids`.
fn survives(text: &str, doc: &Document, id: &str) -> bool {
    let key = nfd(id);
    doc.ids.iter().any(|x| nfd(x) == key) || addressed_units(text, doc).iter().any(|a| a.unit.id.as_deref().map(nfd) == Some(key.clone()))
}

/// Splice `replacement` over the lines of `found`, re-parse, and refuse a
/// broken result. `guard_count`: the target must come back as exactly one
/// block spanning what went in (a fence in a body cannot close it early and
/// inject siblings). `id`: the target's id, which must survive.
#[allow(clippy::too_many_arguments)]
pub fn splice_span(
    ix: &Indexed,
    found: Span,
    replacement: &str,
    head_only: bool,
    guard_count: bool,
    id: Option<&str>,
    renamed_from: Option<&str>,
) -> Result<String, Refusal> {
    let source = ix.text;
    let before_doc = &ix.doc;
    let orig = split_physical(source);
    let span = if head_only { Span { start: found.start, end: found.start + super::get::head_lines(ix, found.start) } } else { found };
    let nl = newline_of(source);
    let mut inject = to_newline(replacement, nl);
    let last_line = span.end >= orig.len();
    if !inject.ends_with('\n') && !last_line {
        inject.push_str(nl);
    }
    let before: String = orig[..span.start.min(orig.len())].concat();
    let after: String = if span.end < orig.len() { orig[span.end..].concat() } else { String::new() };
    let updated = format!("{before}{inject}{after}");

    let reparsed = reparse(ix, &updated);
    if let Some(id) = id {
        if !survives(&updated, &reparsed, id) {
            return refuse(Reason::BadContent, format!("replacement removes id `{id}`; not written"));
        }
    }
    let dropped_ids: Vec<&String> =
        before_doc.ids.iter().filter(|x| Some(x.as_str()) != id && Some(x.as_str()) != renamed_from && !reparsed.ids.contains(x)).collect();
    // A reference left dangling BY THE REMOVAL is reported, not refused —
    // the rule `delete` set for a destructive edit.
    let collateral = |d: &Diagnostic| dropped_ids.iter().any(|x| d.message.contains(&format!("`#{x}`")) || d.message.contains(&format!("#{x}`")));
    let errs = errors_added(before_doc, &reparsed, ix.file, &collateral);
    if !errs.is_empty() {
        return refuse_write(before_doc, errs, "replacement would break the document");
    }
    if guard_count && reparsed.children.len() != before_doc.children.len() {
        let who = id.map(|i| format!("#{i}")).unwrap_or_else(|| "the target".to_string());
        return refuse(
            Reason::BadContent,
            format!("replacement changes the block count (a fence in the body closed {who} early and injected sibling block(s)?); not written"),
        );
    }
    if guard_count {
        let expected_end = span.start + split_physical(&inject).len();
        let target = addressed_units(&updated, &reparsed).into_iter().find(|a| {
            a.unit.kind == Kind::Block
                && a.unit.span.start == span.start
                && (id.is_none() || a.unit.id.is_none() || a.unit.id.as_deref().map(nfd) == id.map(nfd))
        });
        if target.as_ref().map(|t| t.unit.span.end) != Some(expected_end) {
            let who = id.map(|i| format!("#{i}")).unwrap_or_else(|| "the target".to_string());
            return refuse(
                Reason::BadContent,
                format!("replacement does not stay one block (a fence in the body closed {who} early and injected sibling block(s)?); not written"),
            );
        }
    }
    Ok(updated)
}

/// Insert a fragment at physical line `at` with one blank separator on each
/// side that has adjacent content; refuse a broken result, and a fragment
/// that makes an existing unit vanish.
pub fn insert_fragment(ix: &Indexed, at: usize, fragment: &str) -> Result<String, Refusal> {
    let source = ix.text;
    let lines = split_physical(source);
    let at = at.min(lines.len());
    let nl = newline_of(source);
    let mut before: Vec<String> = lines[..at].iter().map(|s| s.to_string()).collect();
    let after: Vec<&str> = lines[at..].to_vec();
    if let Some(last) = before.last_mut() {
        if !last.ends_with('\n') && !last.ends_with('\r') {
            last.push_str(nl);
        }
    }
    let mut frag = to_newline(fragment, nl);
    if !frag.ends_with('\n') {
        frag.push_str(nl);
    }
    let blank = |s: &str| strip_eol(s).trim().is_empty();
    let sep_before = if before.last().is_some_and(|l| !blank(l)) { nl } else { "" };
    let sep_after = if after.first().is_some_and(|l| !blank(l)) { nl } else { "" };
    let updated = format!("{}{sep_before}{frag}{sep_after}{}", before.concat(), after.concat());

    let reparsed = reparse(ix, &updated);
    let errs = errors_added(&ix.doc, &reparsed, ix.file, &|_| false);
    if !errs.is_empty() {
        return refuse_write(&ix.doc, errs, "adding the content would break the document");
    }
    if let Some(dropped) = ix.doc.ids.iter().find(|x| !reparsed.ids.contains(x)) {
        return refuse(Reason::WouldDropUnit, format!("adding the content would drop block `#{dropped}`; not written"));
    }
    Ok(updated)
}

/// The shape of set's content: nothing, prose only, one block (or one
/// section), or more than one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Empty,
    Prose,
    Single,
    Multi,
}

pub fn content_shape(content: &str) -> Shape {
    let doc = crate::parse(content);
    let bs = &doc.children;
    let (mut blocks, mut prose, mut i) = (0, 0, 0);
    while i < bs.len() {
        match &bs[i] {
            Item::Heading(h) => {
                let level = h.level;
                i += 1;
                while i < bs.len() && !matches!(&bs[i], Item::Heading(x) if x.level <= level) {
                    i += 1;
                }
                blocks += 1;
            }
            Item::Block(_) => {
                i += 1;
                blocks += 1;
            }
            Item::Paragraph(_) | Item::List(_) | Item::Hidden(_) => {
                i += 1;
                if !matches!(&bs[i - 1], Item::Hidden(_)) {
                    prose += 1;
                }
            }
        }
    }
    if blocks == 0 {
        return if prose == 0 { Shape::Empty } else { Shape::Prose };
    }
    if blocks + prose == 1 {
        Shape::Single
    } else {
        Shape::Multi
    }
}

/// Rewrite the id inside a `{…}` attribute object to `#new_id`, keeping the
/// braces and every other byte; insert `#new_id` first when none is there.
fn rewrite_braces(braces: &str, new_id: &str) -> String {
    let inner: Vec<char> = braces[1..braces.len() - 1].chars().collect();
    let a = read_object(&inner);
    if let Some(id) = a.id {
        // The id token sits at a token boundary (`{` or whitespace), never
        // inside a quoted value.
        let chars: Vec<char> = braces.chars().collect();
        let mut i = 1;
        let mut in_quote = false;
        while i < chars.len() {
            let c = chars[i];
            if in_quote {
                if c == '\\' {
                    i += 1;
                } else if c == '"' {
                    in_quote = false;
                }
            } else if c == '"' {
                in_quote = true;
            } else if c == '#' && (chars[i - 1] == '{' || chars[i - 1].is_whitespace()) {
                let mut j = i + 1;
                if id.is_empty() {
                    if j < chars.len() && (chars[j].is_whitespace() || chars[j] == '}') {
                        let head: String = chars[..i].iter().collect();
                        let tail: String = chars[j..].iter().collect();
                        return format!("{head}#{new_id}{tail}");
                    }
                } else {
                    while j < chars.len() && !chars[j].is_whitespace() && chars[j] != '}' {
                        j += 1;
                    }
                    let head: String = chars[..i].iter().collect();
                    let tail: String = chars[j..].iter().collect();
                    return format!("{head}#{new_id}{tail}");
                }
            }
            i += 1;
        }
        return braces.to_string();
    }
    let inner: String = inner.iter().collect();
    let inner = inner.trim_start_matches([' ', '\t']);
    if inner.is_empty() {
        format!("{{#{new_id}}}")
    } else {
        format!("{{#{new_id} {inner}}}")
    }
}

/// The head forms set rewrites: `=== type …{…}?…` and `## text …{…}?…`,
/// split as (lead, ws, braces, trailing ws).
fn split_head(head: &str) -> Option<(String, String, Option<String>, String)> {
    let trail_len = head.len() - trim_space_tab_end(head).len();
    let body = &head[..head.len() - trail_len];
    let trail = head[head.len() - trail_len..].to_string();
    let is_fence = parse_fence_open(body).is_some() || {
        let run = body.chars().take_while(|c| *c == '=').count();
        run >= 3 && body[run..].trim_start_matches([' ', '\t']).chars().next().is_some_and(|c| c.is_ascii_alphabetic())
    };
    let is_heading = {
        let hashes = body.chars().take_while(|c| *c == '#').count();
        (1..=6).contains(&hashes) && body[hashes..].starts_with([' ', '\t'])
    };
    if !is_fence && !is_heading {
        return None;
    }
    // A brace tail: the object runs to the LAST `}` of the line for a fence;
    // for a heading, a `{…}` with no inner brace.
    if body.ends_with('}') {
        if let Some(open) = body.rfind('{') {
            let braces = &body[open..];
            if is_heading && braces[1..braces.len() - 1].contains('{') {
                return Some((body.to_string(), String::new(), None, trail));
            }
            let lead_all = &body[..open];
            let lead = trim_space_tab_end(lead_all);
            let ws = lead_all[lead.len()..].to_string();
            return Some((lead.to_string(), ws, Some(braces.to_string()), trail));
        }
    }
    Some((body.to_string(), String::new(), None, trail))
}

/// Rewrite the HEAD id of the first block in `block_src` to `new_id`, across
/// every head form; only the id changes. A labeled close `=== #old` is
/// renamed with it. Content with no head comes back as it was.
pub fn normalize_block_id(block_src: &str, new_id: &str) -> String {
    let mut lines: Vec<String> = split_physical(block_src).iter().map(|s| s.to_string()).collect();
    let hi = lines.iter().position(|l| {
        let t = strip_eol(l);
        !(t.trim().is_empty() || t.trim_start_matches([' ', '\t']).starts_with("%%"))
    });
    let Some(hi) = hi else { return block_src.to_string() };
    let head_text = strip_eol(&lines[hi]).to_string();
    let Some((lead, ws, braces, trail)) = split_head(&head_text) else { return block_src.to_string() };
    let term = lines[hi][head_text.len()..].to_string();
    let rebuilt = match &braces {
        Some(b) => format!("{lead}{ws}{}{trail}", rewrite_braces(b, new_id)),
        None => format!("{lead} {{#{new_id}}}{ws}{trail}"),
    };
    lines[hi] = format!("{rebuilt}{term}");

    // A fence carrying an id may close with `=== #old`: rename that too.
    if let Some(open) = parse_fence_open(&head_text) {
        if let Some(old_id) = open.attrs.id.filter(|i| !i.is_empty()) {
            for line in lines.iter_mut().skip(hi + 1) {
                let ct = strip_eol(line).to_string();
                let trimmed = trim_space_tab_end(&ct);
                if !trimmed.is_empty() && trimmed.chars().all(|c| c == '=') && trimmed.len() == open.len {
                    break;
                }
                if let Some(l) = labeled_close_id(&ct) {
                    if l == old_id {
                        let run = ct.chars().take_while(|c| *c == '=').count();
                        let after_run = &ct[run..];
                        let ws_len = after_run.len() - after_run.trim_start_matches([' ', '\t']).len();
                        let prefix = &ct[..run + ws_len + 1]; // through the `#`
                        let tail_ws = trim_space_tab_end(&ct).len();
                        let term = line[ct.len()..].to_string();
                        *line = format!("{prefix}{new_id}{}{term}", &ct[tail_ws..]);
                        break;
                    }
                }
            }
        }
    }
    lines.concat()
}

/// The lines between a block's fences (or after a heading), for the raw and
/// data bodies `rename` must not rewrite.
pub fn body_range(lines: &[&str], span: Span) -> Span {
    let Some(open) = parse_fence_open(strip_eol(lines.get(span.start).copied().unwrap_or(""))) else {
        return Span { start: span.start + 1, end: span.end };
    };
    let last = trim_space_tab_end(strip_eol(lines.get(span.end.wrapping_sub(1)).copied().unwrap_or("")));
    let plain = !last.is_empty() && last.chars().all(|c| c == '=') && last.len() == open.len;
    let labeled = match (&open.attrs.id, labeled_close_id(last)) {
        (Some(id), Some(l)) => nfd(id) == nfd(&l),
        _ => false,
    };
    Span { start: span.start + 1, end: if plain || labeled { span.end - 1 } else { span.end } }
}

/// Whether a line declares an id in a trailing `{…}`.
pub fn declares_id(line: &str) -> bool {
    let t = strip_eol(line);
    let t = trim_space_tab_end(t);
    if !t.ends_with('}') {
        return false;
    }
    let Some(open) = t.rfind('{') else { return false };
    let inner: Vec<char> = t[open + 1..t.len() - 1].chars().collect();
    if inner.contains(&'{') || inner.contains(&'}') {
        return false;
    }
    read_object(&inner).id.is_some()
}

/// Whether the model holds a block of raw or data mode with this id (whose
/// body a rewrite must leave alone).
pub fn is_opaque_block(doc: &Document, id: &str) -> bool {
    fn walk(items: &[Item], key: &str) -> bool {
        items.iter().any(|it| match it {
            Item::Block(b) => (b.id.as_deref().map(nfd) == Some(key.to_string()) && matches!(b.mode, Mode::Raw | Mode::Data)) || walk(&b.children, key),
            _ => false,
        })
    }
    walk(&doc.children, &nfd(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_the_target_id_onto_every_head_form() {
        assert_eq!(normalize_block_id("=== note {#zeta}\nx\n===\n", "alpha"), "=== note {#alpha}\nx\n===\n");
        assert_eq!(normalize_block_id("=== note\nx\n===\n", "alpha"), "=== note {#alpha}\nx\n===\n");
        assert_eq!(normalize_block_id("=== note {.warn lang=py}\nx\n===\n", "a"), "=== note {#a .warn lang=py}\nx\n===\n");
        assert_eq!(normalize_block_id("=== note {.warn #z}\nx\n===\n", "a"), "=== note {.warn #a}\nx\n===\n");
        assert_eq!(normalize_block_id("## Sub renamed\n", "sub"), "## Sub renamed {#sub}\n");
        assert_eq!(normalize_block_id("## Sub {#elsewhere}\r\n", "sub"), "## Sub {#sub}\r\n");
        assert_eq!(normalize_block_id("=== note {#old}\nx\n=== #old\n", "new"), "=== note {#new}\nx\n=== #new\n");
        assert_eq!(normalize_block_id("just prose\n", "a"), "just prose\n");
        assert_eq!(normalize_block_id("\n%% hidden\n=== note\nx\n===\n", "a"), "\n%% hidden\n=== note {#a}\nx\n===\n");
    }

    #[test]
    fn shapes() {
        assert_eq!(content_shape(""), Shape::Empty);
        assert_eq!(content_shape("just prose"), Shape::Prose);
        assert_eq!(content_shape("=== note {#a}\nx\n==="), Shape::Single);
        assert_eq!(content_shape("## H {#h}\n\ntext\n\n=== note {#a}\nx\n==="), Shape::Single);
        assert_eq!(content_shape("=== note {#a}\nx\n===\n\n=== note {#b}\ny\n==="), Shape::Multi);
        assert_eq!(content_shape("prose\n\n=== note {#a}\nx\n==="), Shape::Multi);
    }

    #[test]
    fn declared_ids() {
        assert!(declares_id("## T {#t}\n"));
        assert!(!declares_id("## T {.c}\n"));
        assert!(!declares_id("## T\n"));
    }
}
