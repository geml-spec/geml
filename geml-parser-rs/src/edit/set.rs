//! `set`: one unit — or one part of it — replaced by the content. The
//! content adopts the target's id (naming an id on the command line IS the
//! instruction that the result carries it); the result is parsed before it
//! is written and refused when it would carry an error.

use crate::model::{Block, Item};

use super::coord::{model_block, plan_coord_edit, plan_coord_write, plan_meta_remove, plan_meta_write, NotPlanned, TreeEdit};
use super::get::{has_close_fence, narrow_to_intro, Part};
use super::lines::{split_physical, strip_eol, to_lf};
use super::md::{as_markdown, declares_id, id_in_place, relink};
use super::select::Indexed;
use super::selector::{parse_selector, CoordStep, Selector};
use super::units::{addressed_units, shortest_address, Kind, Unit};
use super::write::{content_shape, normalize_block_id, reparse, splice_span, Shape};
use super::{refuse, Reason, Refusal, Unsupported};

pub const NO_CONTENT: &str = "no replacement content (use --in FILE or pipe it on stdin)";

struct Target {
    unit: Unit,
    label: String,
}

/// The ONE unit `set` writes; a filter matching several is refused with the
/// addresses that would each name one.
fn resolve_target(ix: &Indexed, raw: &str) -> Result<Target, Refusal> {
    let (units, sel) = ix.select(raw, false)?;
    if units.len() > 1 {
        let opts = units
            .iter()
            .map(|u| {
                let a = ix.all.iter().find(|a| a.unit.span == u.span && a.unit.kind == u.kind).expect("a listed unit");
                format!("  {}  L{}-{}", shortest_address(a, &ix.all), u.span.start + 1, u.span.end)
            })
            .collect::<Vec<_>>()
            .join("\n");
        return refuse(Reason::AmbiguousAddress, format!("`{}` matches {} blocks — set writes ONE; address it uniquely:\n{opts}", raw.trim(), units.len()));
    }
    let unit = units.into_iter().next().expect("one match");
    let label = match (&unit.id, &sel) {
        (Some(id), Selector::Id { .. }) => format!("#{id}"),
        _ => format!("`{}`", raw.trim()),
    };
    Ok(Target { unit, label })
}

/// Whether the merged `#meta` view is what `base` names.
fn reserved_meta(ix: &Indexed, base: &str) -> bool {
    super::get::reserved_meta(ix, base).is_some()
}

/// A coordinate write's value: the content with one trailing newline dropped.
fn one_value(content: &str) -> String {
    content.strip_suffix("\r\n").or_else(|| content.strip_suffix('\n')).unwrap_or(content).to_string()
}

/// An edit beside or of the unit a coordinate names (GEP 0011): `add`
/// inserts an element beside a sequence's element, `delete` removes a member,
/// an element or a meta key — `#meta["k"]` is the key in the block that
/// defines it.
pub fn edit_coord(ix: &Indexed, raw: &str, edit: TreeEdit) -> Result<String, Refusal> {
    let Selector::Coord { base, path } = parse_selector(raw) else { unreachable!("called with a coordinate") };
    if reserved_meta(ix, &base) {
        if !matches!(edit, TreeEdit::Remove) {
            return refuse(
                Reason::BadAddress,
                format!("`{}`: a meta key has no order to insert beside — write a new key with `set '#meta[\"<key>\"]'`", raw.trim()),
            );
        }
        let [CoordStep::Key(key)] = path.as_slice() else {
            return refuse(Reason::BadAddress, format!("`{}`: a meta key is removed as `#meta[\"<key>\"]` — one quoted key, and nothing deeper", raw.trim()));
        };
        let Some(owner) = defining_meta(&ix.doc.children, key) else { return Ok(ix.text.to_string()) };
        let metas: Vec<&Unit> = ix.all.iter().filter(|a| a.unit.type_name.as_deref() == Some("meta")).map(|a| &a.unit).collect();
        let unit = metas[owner].clone();
        return write_body(ix, &unit, raw, |body| plan_meta_remove(key, body));
    }
    let (units, _) = ix.select(raw, true)?;
    let unit = units[0].clone();
    let Some(block) = model_block(&ix.doc.children, unit.span.start + 1) else {
        return refuse(Reason::BadAddress, format!("`{}`: a coordinate edits a unit inside a `data` block; `{}` has none", raw.trim(), unit.kind_name()));
    };
    let block = block.clone();
    write_body(ix, &unit, raw, |body| plan_coord_edit(&block, &path, &edit, body))
}

/// Which `meta` block (by document order) first defines the key, if any.
fn defining_meta(items: &[Item], key: &str) -> Option<usize> {
    let owner = meta_owner(items, key);
    let mut metas = Vec::new();
    fn walk<'a>(items: &'a [Item], out: &mut Vec<&'a Block>) {
        for it in items {
            if let Item::Block(b) = it {
                if b.type_name == "meta" {
                    out.push(b);
                }
                walk(&b.children, out);
            }
        }
    }
    walk(items, &mut metas);
    metas.get(owner).filter(|b| b.data.iter().any(|(k, _)| k == key)).map(|_| owner)
}

/// Which `meta` block (by document order) first defines the key; 0 when none.
fn meta_owner(items: &[Item], key: &str) -> usize {
    fn walk<'a>(items: &'a [Item], out: &mut Vec<&'a Block>) {
        for it in items {
            if let Item::Block(b) = it {
                if b.type_name == "meta" {
                    out.push(b);
                }
                walk(&b.children, out);
            }
        }
    }
    let mut metas = Vec::new();
    walk(items, &mut metas);
    metas.iter().position(|b| b.data.iter().any(|(k, _)| k == key)).unwrap_or(0)
}

/// Rewrite a block's body by a plan over its lines (terminators stripped),
/// keeping its head and close lines, and splice it back guarded.
fn write_body(ix: &Indexed, unit: &Unit, raw: &str, plan: impl FnOnce(&[String]) -> Result<Vec<String>, NotPlanned>) -> Result<String, Refusal> {
    let lines = split_physical(ix.text);
    let span = unit.span;
    let close = has_close_fence(&lines, span);
    let body_end = if close { span.end - 1 } else { span.end };
    let body: Vec<String> = lines[(span.start + 1).min(body_end)..body_end].iter().map(|l| strip_eol(l).to_string()).collect();
    let planned = match plan(&body) {
        Ok(b) => b,
        // Content the value tree cannot hold: the block would carry `data-parse`.
        Err(NotPlanned::Broken(why)) => {
            let line = span.start + 1;
            let mut r = Refusal::new(Reason::BrokenResult, format!("replacement would break the document: {why} (line {line}); not written"));
            r.diagnostics.push(crate::diag::Diagnostic { code: "data-parse", severity: crate::diag::Severity::Error, line, message: why });
            return Err(r);
        }
        Err(NotPlanned::Address(why)) => return refuse(Reason::BadAddress, format!("`{}`: {why}", raw.trim())),
        Err(NotPlanned::Missing(why)) => return refuse(Reason::NoSuchUnit, format!("`{}`: {why}", raw.trim())),
        // Nothing there to delete: nothing is written.
        Err(NotPlanned::Absent) => return Ok(ix.text.to_string()),
    };
    let mut head = lines.get(span.start).copied().unwrap_or("").to_string();
    if !head.is_empty() && !head.ends_with('\n') && !head.ends_with('\r') {
        head.push('\n');
    }
    // Every line carries its own terminator, so a body whose last line is
    // empty keeps it: a coordinate write may not move a byte it was not asked to.
    let ends_in_newline = body_end > 0 && lines.get(body_end - 1).is_some_and(|l| l.ends_with('\n') || l.ends_with('\r'));
    let mut new_body: String = planned.iter().map(|l| format!("{l}\n")).collect();
    if !ends_in_newline && new_body.ends_with('\n') {
        new_body.pop();
    }
    let replacement = if close { format!("{head}{new_body}{}", lines[span.end - 1]) } else { format!("{head}{new_body}") };
    splice_span(ix, span, &replacement, false, close, unit.id.as_deref(), None)
}

pub fn set(ix: &Indexed, raw: &str, part: Part, content: &str) -> Result<Result<String, Unsupported>, Refusal> {
    let sel = parse_selector(raw);
    if let Selector::Coord { base, path } = &sel {
        // GEP 0011: ONE unit inside a block, planned as a new body for that
        // block and put back through the guarded splice `--body` uses, so a
        // coordinate write cannot reach past the block it names.
        if reserved_meta(ix, base) {
            if part != Part::Whole {
                return refuse(Reason::BadAddress, format!("{} names part of a block, and `#meta` names a merged view rather than one block", part.flag()));
            }
            let [CoordStep::Key(key)] = path.as_slice() else {
                return refuse(
                    Reason::BadAddress,
                    format!("`{}`: a meta key is written as `#meta[\"<key>\"]` — one quoted key, and nothing deeper", raw.trim()),
                );
            };
            let value = one_value(content);
            if value.is_empty() {
                return refuse(Reason::BadContent, NO_CONTENT);
            }
            // The block that defines the key first owns it (§4); a new key
            // goes into the first `meta` block.
            let owner = meta_owner(&ix.doc.children, key);
            let metas: Vec<&Unit> = ix.all.iter().filter(|a| a.unit.type_name.as_deref() == Some("meta")).map(|a| &a.unit).collect();
            let Some(unit) = metas.get(owner).copied() else {
                return refuse(Reason::NoSuchUnit, format!("`{}`: this document has no `meta` block to write into", raw.trim()));
            };
            let unit = unit.clone();
            return write_body(ix, &unit, raw, |body| plan_meta_write(key, &value, body).map_err(NotPlanned::from)).map(Ok);
        }
        if part != Part::Whole {
            return refuse(Reason::BadAddress, format!("{} names part of a BLOCK, and a coordinate already names a unit inside one", part.flag()));
        }
        let (units, _) = ix.select(raw, true)?;
        let unit = units[0].clone();
        let value = one_value(content);
        if value.is_empty() {
            return refuse(Reason::BadContent, NO_CONTENT);
        }
        let Some(block) = model_block(&ix.doc.children, unit.span.start + 1) else {
            return refuse(
                Reason::BadAddress,
                format!("`{}`: a coordinate writes a unit inside a table or a `data` block; `{}` has none", raw.trim(), unit.kind_name()),
            );
        };
        let block = block.clone();
        return write_body(ix, &unit, raw, |body| plan_coord_write(&block, path, &value, body)).map(Ok);
    }

    let target = resolve_target(ix, raw)?;
    match part {
        Part::Intro => return set_intro(ix, &target, content).map(Ok),
        Part::Body => return set_body(ix, &target, content).map(Ok),
        Part::Whole | Part::Head => {}
    }
    let head_only = part == Part::Head;
    if content.is_empty() {
        return refuse(Reason::BadContent, NO_CONTENT);
    }
    // Default mode wants exactly ONE block: pure prose has no head to carry
    // the id (unless the target itself is a prose run); several blocks are
    // `add`'s job. `--head` takes a lone head line and skips the shape check.
    let target_is_prose = target.unit.kind == Kind::Prose;
    if !head_only {
        match content_shape(content) {
            Shape::Empty => return refuse(Reason::BadContent, NO_CONTENT),
            Shape::Prose if !target_is_prose => {
                return refuse(Reason::BadContent, format!("content is prose, not a block — use --body to set the body of {}", target.label));
            }
            Shape::Multi => return refuse(Reason::BadContent, "set replaces ONE block, but the content has multiple blocks (use add)"),
            _ => {}
        }
    }
    // A heading or prose in a `.md` is Markdown, and so is what replaces it.
    let converted = if target.unit.kind != Kind::Block { as_markdown(content, ix.file)? } else { content.to_string() };
    let content = converted.as_str();
    let md = crate::is_markdown_path(ix.file);
    // Content that ALREADY resolves to the target's id needs no stamp: the
    // judge is the parser, never a second copy of the slug rule — in a `.md`,
    // the content in place, since a heading's anchor there depends on the
    // headings above it.
    let carries = target.unit.id.is_some()
        && ({
            let own = reparse(ix, content);
            addressed_units(content, &own).first().and_then(|a| a.unit.id.clone()) == target.unit.id
        } || (md && id_in_place(ix, target.unit.span, content) == target.unit.id));
    // A Markdown heading's anchor is its text: one that does not declare an
    // id takes the anchor its new text derives, and the links follow it.
    let lines = split_physical(ix.text);
    if md && target.unit.kind == Kind::Heading && !carries && !declares_id(lines.get(target.unit.span.start).copied().unwrap_or("")) {
        if let Some(old) = target.unit.id.as_deref() {
            if let Some(new) = id_in_place(ix, target.unit.span, content).filter(|n| !n.is_empty() && n != old) {
                let (doc_text, _) = relink(ix.text, old, &new);
                let (own, _) = relink(content, old, &new);
                let relinked = Indexed::new(&doc_text, ix.file, reparse(ix, &doc_text), ix.host);
                return splice_span(&relinked, target.unit.span, &own, head_only, false, Some(&new), Some(old)).map(Ok);
            }
        }
    }
    let stamp = target.unit.id.is_some() && !carries && target.unit.kind != Kind::Prose;
    let replacement = if stamp { normalize_block_id(content, target.unit.id.as_deref().unwrap_or_default()) } else { content.to_string() };
    let updated = splice_span(ix, target.unit.span, &replacement, head_only, false, target.unit.id.as_deref(), None)?;
    Ok(Ok(updated))
}

fn blank(s: &str) -> bool {
    s.trim().is_empty()
}

/// The last real line of LF text ending in a newline.
fn last_real_line(b: &str) -> &str {
    let parts: Vec<&str> = b.split('\n').collect();
    if parts.len() >= 2 {
        parts[parts.len() - 2]
    } else {
        parts[0]
    }
}

fn set_intro(ix: &Indexed, target: &Target, content: &str) -> Result<String, Refusal> {
    if target.unit.kind != Kind::Heading {
        return refuse(
            Reason::BadAddress,
            format!(
                "--intro names a heading's opening region, and `{}` is a `{}` block — use --body for a block's content",
                target.label,
                target.unit.kind_name()
            ),
        );
    }
    let lines = split_physical(ix.text);
    let region = narrow_to_intro(ix, &lines, target.unit.span);
    if content.is_empty() {
        return refuse(Reason::BadContent, NO_CONTENT);
    }
    let mut body = to_lf(&as_markdown(content, ix.file)?);
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    // Give the opening its blank lines back: one blank separator on a side
    // whose neighbour is not blank, as `add` settles it.
    if !blank(body.split('\n').next().unwrap_or("")) {
        body.insert(0, '\n');
    }
    if region.end < lines.len() && !blank(last_real_line(&body)) {
        body.push('\n');
    }
    splice_span(ix, region, &body, false, false, target.unit.id.as_deref(), None)
}

fn set_body(ix: &Indexed, target: &Target, content: &str) -> Result<String, Refusal> {
    let found = target.unit.span;
    let lines = split_physical(ix.text);
    // A setext heading's head is its text and its underline.
    let head_line = lines[found.start.min(lines.len())..(found.start + super::get::head_lines(ix, found.start)).min(lines.len())].concat();
    let close = has_close_fence(&lines, found);
    if content.is_empty() {
        return refuse(Reason::BadContent, NO_CONTENT);
    }
    let mut head = head_line.to_string();
    if !head.is_empty() && !head.ends_with('\n') && !head.ends_with('\r') {
        head.push('\n');
    }
    let converted = if close { content.to_string() } else { as_markdown(content, ix.file)? };
    let mut b = to_lf(&converted);
    if close && !b.is_empty() && !b.ends_with('\n') {
        b.push('\n');
    }
    // A heading's body is everything under its line, blank separators
    // included; text typed by hand gets the same padding `--intro` gives.
    if !close && target.unit.kind == Kind::Heading && !b.is_empty() {
        if !b.ends_with('\n') {
            b.push('\n');
        }
        if !blank(b.split('\n').next().unwrap_or("")) {
            b.insert(0, '\n');
        }
        if found.end < lines.len() && !blank(last_real_line(&b)) {
            b.push('\n');
        }
    }
    let replacement = if close { format!("{head}{b}{}", lines[found.end - 1]) } else { format!("{head}{b}") };
    // A typed block must stay ONE block; a heading section may hold blocks.
    splice_span(ix, found, &replacement, false, close, target.unit.id.as_deref(), None)
}
