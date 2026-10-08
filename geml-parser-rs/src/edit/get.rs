//! `get`: one unit's source, byte for byte — or a part of it: the `head`
//! line, the `body` between the fences (a section's lines after its
//! heading), or a section's `intro`, what it says before its first
//! subheading. `#meta` answers the merged metadata view rather than a span.

use crate::block::{labeled_close_id, parse_fence_open};
use crate::json::Value;
use crate::model::{Block, Item};
use crate::uni::nfd;

use super::lines::{split_physical, strip_eol, trim_space_tab_end};
use super::select::{inside_any, Indexed};
use super::selector::Selector;
use super::units::{Kind, Span, Unit};
use super::{refuse, Reason, Refusal, Unsupported};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    Whole,
    Head,
    Body,
    Intro,
}

impl Part {
    pub fn parse(s: Option<&str>) -> Option<Part> {
        match s {
            None | Some("whole") => Some(Part::Whole),
            Some("head") => Some(Part::Head),
            Some("body") => Some(Part::Body),
            Some("intro") => Some(Part::Intro),
            _ => None,
        }
    }

    pub fn flag(self) -> &'static str {
        match self {
            Part::Whole => "",
            Part::Head => "--head",
            Part::Body => "--body",
            Part::Intro => "--intro",
        }
    }
}

/// Whether the last line of a span closes the fence its first line opens:
/// an equal-length `=` run, or the labeled close `=== #id`.
pub fn has_close_fence(lines: &[&str], span: Span) -> bool {
    if span.end == 0 || span.end > lines.len() || span.start >= span.end {
        return false;
    }
    let Some(open) = parse_fence_open(strip_eol(lines[span.start])) else { return false };
    let last = trim_space_tab_end(strip_eol(lines[span.end - 1]));
    if last.chars().all(|c| c == '=') && last.len() == open.len {
        return true;
    }
    match (&open.attrs.id, labeled_close_id(last)) {
        (Some(id), Some(l)) => nfd(id) == nfd(&l),
        _ => false,
    }
}

/// The BODY span: a fenced block's lines between the fences; a section's
/// lines after the heading through its end, trailing blank lines included.
pub fn narrow_to_body(ix: &Indexed, lines: &[&str], span: Span) -> Span {
    let end = if has_close_fence(lines, span) { span.end - 1 } else { span.end };
    let start = span.start + head_lines(ix, span.start);
    Span { start, end: end.max(start) }
}

/// How many lines the head at `start` takes: one, save a Markdown setext
/// heading, whose text and underline are both its head.
pub fn head_lines(ix: &Indexed, start: usize) -> usize {
    ix.all.iter().find(|a| a.unit.kind == Kind::Heading && a.unit.span.start == start).map_or(1, |a| a.unit.head)
}

/// A section's intro: its body up to the first nested heading.
pub fn narrow_to_intro(ix: &Indexed, lines: &[&str], span: Span) -> Span {
    let body = narrow_to_body(ix, lines, span);
    let mut end = body.end;
    for a in &ix.all {
        let u = &a.unit;
        if u.kind == Kind::Heading && u.span.start > span.start && u.span.start < body.end {
            end = u.span.start;
            break;
        }
    }
    Span { start: body.start, end: end.max(body.start) }
}

/// The bytes of one unit, honouring the part.
pub fn slice_unit(ix: &Indexed, lines: &[&str], span: Span, part: Part) -> String {
    let s = match part {
        Part::Head => Span { start: span.start, end: span.start + head_lines(ix, span.start) },
        Part::Body => narrow_to_body(ix, lines, span),
        Part::Intro => narrow_to_intro(ix, lines, span),
        Part::Whole => span,
    };
    let end = s.end.min(lines.len());
    if s.start >= end {
        return String::new();
    }
    lines[s.start..end].concat()
}

/// A `meta` value as `geml get '#meta'` prints it.
fn meta_literal(v: &Value) -> String {
    match v {
        Value::String(s) => crate::json::quote(s),
        other => crate::json::to_json(other),
    }
}

/// The merged `meta` view (§4), when the address is the reserved `#meta`
/// and no block claims that id.
pub fn reserved_meta(ix: &Indexed, base: &str) -> Option<String> {
    if nfd(base.strip_prefix('#').unwrap_or(base)) != nfd("meta") {
        return None;
    }
    fn claims(items: &[Item]) -> bool {
        items.iter().any(|it| match it {
            Item::Block(Block { id: Some(id), children, .. }) => nfd(id) == nfd("meta") || claims(children),
            Item::Block(b) => claims(&b.children),
            Item::Heading(h) => nfd(&h.id) == nfd("meta"),
            _ => false,
        })
    }
    if claims(&ix.doc.children) || ix.doc.meta_blocks == 0 {
        return None;
    }
    Some(ix.doc.meta.iter().map(|(k, v)| format!("{k} = {}", meta_literal(v))).collect::<Vec<_>>().join("\n"))
}

pub struct GetOptions<'a> {
    pub part: Part,
    pub within: Option<&'a str>,
}

pub fn get(ix: &Indexed, raw: &str, o: &GetOptions) -> Result<Result<String, Unsupported>, Refusal> {
    let sel = super::selector::parse_selector(raw);
    let whereof = ix.whereof();
    if sel == Selector::List {
        return refuse(Reason::BadAddress, format!("no selector given — run `geml get {whereof}` to list addressable blocks"));
    }
    if o.within.is_some() && matches!(sel, Selector::Coord { .. }) {
        return refuse(
            Reason::BadAddress,
            format!("--within narrows the blocks a selector matches, and `{}` is a coordinate naming one unit inside a block", raw.trim()),
        );
    }
    let meta_base = match &sel {
        Selector::Coord { base, .. } => base.as_str(),
        Selector::Id { raw, .. } => raw.as_str(),
        _ => "",
    };
    let metas = ix.all.iter().filter(|a| a.unit.kind == Kind::Block && a.unit.type_name.as_deref() == Some("meta")).count();
    // With one `meta` block, `#meta` is that block, and a part of it or a
    // `--within` narrowing is read from it like any block's.
    let single = metas == 1 && matches!(sel, Selector::Id { .. });
    let view = reserved_meta(ix, meta_base).filter(|_| !(single && (o.part != Part::Whole || o.within.is_some())));
    if let Some(view) = view {
        if o.part != Part::Whole {
            if matches!(sel, Selector::Id { .. }) {
                return refuse(
                    Reason::AmbiguousAddress,
                    format!("{} names part of ONE block, and `#meta` names the merge of this document's {metas} `meta` blocks — address one of them as `geml list` prints it", o.part.flag()),
                );
            }
            return refuse(Reason::BadAddress, format!("{} names part of a BLOCK, and a coordinate already names a unit inside one", o.part.flag()));
        }
        if o.within.is_some() {
            return refuse(Reason::BadAddress, "--within narrows the blocks a selector matches, and `#meta` names a merged view rather than a block");
        }
        if let Selector::Id { type_name: Some(t), .. } = &sel {
            if t != "meta" {
                return refuse(Reason::BadAddress, format!("`#meta` addresses the merged `meta` view, not `{t}` — drop the type prefix"));
            }
        }
        if let Selector::Coord { path, .. } = &sel {
            let merged = Value::Object(ix.doc.meta.clone());
            return match super::coord::project_value(&merged, path) {
                Ok(hit) => Ok(Ok(format!("{}\n", hit.text))),
                Err(why) => refuse(Reason::NoSuchUnit, format!("`{}`: {why}", raw.trim())),
            };
        }
        return Ok(Ok(format!("{view}\n")));
    }

    let (mut units, sel) = ix.select(raw, true)?;
    if let Some(w) = o.within {
        let scopes = ix.scopes(w)?;
        units.retain(|u| inside_any(u, &scopes));
        if units.is_empty() {
            return refuse(Reason::NoSuchUnit, format!("no block matching `{}` inside `{w}` in {whereof}", raw.trim()));
        }
    }
    if let Selector::Coord { path, .. } = &sel {
        if o.part != Part::Whole {
            return refuse(Reason::BadAddress, format!("{} names part of a BLOCK, and a coordinate already names a unit inside one", o.part.flag()));
        }
        // A coordinate is answered from the MODEL: the unit it names has no
        // span of the file to slice.
        let unit = &units[0];
        let Some(block) = super::coord::model_block(&ix.doc.children, unit.span.start + 1) else {
            return refuse(
                Reason::NoSuchUnit,
                format!("`{}`: a coordinate addresses a unit inside a table or a `data` block; `{}` has none", raw.trim(), unit.kind_name()),
            );
        };
        return match super::coord::project_coord(block, path) {
            Ok(hit) => Ok(Ok(format!("{}\n", hit.text))),
            Err(why) => refuse(Reason::NoSuchUnit, format!("`{}`: {why}", raw.trim())),
        };
    }
    let lines = split_physical(ix.text);
    for u in &units {
        if o.part == Part::Intro && u.kind != Kind::Heading {
            return refuse(
                Reason::BadAddress,
                format!("--intro names a heading's opening region, and `{raw}` is a `{}` block — use --body for a block's content", u.kind_name()),
            );
        }
    }
    let out: String = units.iter().map(|u: &Unit| slice_unit(ix, &lines, u.span, o.part)).collect();
    Ok(Ok(out))
}
