//! `add`: a fragment — one or more blocks, or prose — inserted at the end,
//! or before/after the ONE unit an anchor names. The content keeps its own
//! ids; a collision is a broken result.

use super::lines::split_physical;
use super::select::Indexed;
use super::units::Span;
use super::write::insert_fragment;
use super::{refuse, Reason, Refusal};

/// One address resolved to the ONE unit it names, for the verbs that anchor
/// on a unit. Every form a listing prints is accepted; a filter matching
/// several units is one match too many for an anchor.
pub fn anchor_span(ix: &Indexed, raw: &str) -> Result<Span, Refusal> {
    let (units, _) = match ix.select(raw, false) {
        Ok(x) => x,
        Err(mut r) => {
            let whereof = format!(" in {}", ix.whereof());
            if r.reason == Reason::NoSuchUnit && !r.message.contains(&whereof) {
                r.message.push_str(&whereof);
            }
            return Err(r);
        }
    };
    if units.len() > 1 {
        let list = units
            .iter()
            .map(|u| match &u.id {
                Some(id) => format!("  #{id}"),
                None => format!("  {} L{}-{}", u.kind_name(), u.span.start + 1, u.span.end),
            })
            .collect::<Vec<_>>()
            .join("\n");
        return refuse(
            Reason::AmbiguousAddress,
            format!("`{}` matches {} blocks — an anchor names ONE; address it uniquely:\n{list}", raw.trim(), units.len()),
        );
    }
    Ok(units[0].span)
}

pub struct AddOptions<'a> {
    pub append: bool,
    pub before: Option<&'a str>,
    pub after: Option<&'a str>,
}

pub fn add(ix: &Indexed, content: &str, o: &AddOptions) -> Result<String, Refusal> {
    if content.trim().is_empty() {
        return refuse(Reason::BadContent, "no content to add (use --in FILE or pipe it on stdin)");
    }
    // GEP 0011: an anchor inside a block puts a VALUE beside an element of a
    // sequence — the block's body changes, and nothing is added to the document.
    let anchor = if o.append { None } else { o.before.or(o.after) };
    if let Some(a) = anchor.filter(|a| matches!(super::selector::parse_selector(a), super::selector::Selector::Coord { .. })) {
        let value = content.strip_suffix("\r\n").or_else(|| content.strip_suffix('\n')).unwrap_or(content).to_string();
        return super::set::edit_coord(ix, a, super::coord::TreeEdit::Insert { value, before: o.before.is_some() });
    }
    let content = super::md::as_markdown(content, ix.file)?;
    let content = content.as_str();
    let at = if o.append {
        split_physical(ix.text).len()
    } else {
        let anchor = o.before.or(o.after).unwrap_or("");
        let span = anchor_span(ix, anchor)?;
        if o.before.is_some() {
            span.start
        } else {
            span.end
        }
    };
    insert_fragment(ix, at, content)
}
