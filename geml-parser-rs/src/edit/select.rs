//! Resolving a selector against a document: which units it names, or why
//! none. One path for every verb, so `get`, `set` and the listing agree.

use crate::model::Document;
use crate::uni::nfd;

use super::selector::{parse_selector, Selector};
use super::units::{addressed_units, match_line, match_type, Addressed, Kind, Span, Unit};
use super::{refuse, Reason, Refusal};

/// A document with its unit index, parsed once per operation.
pub struct Indexed<'a> {
    pub text: &'a str,
    pub file: &'a str,
    pub doc: Document,
    pub all: Vec<Addressed>,
    /// Where the other documents a reference may reach are read from — the
    /// same host every re-parse of a rewrite uses.
    pub host: Option<&'a dyn crate::host::Host>,
}

impl<'a> Indexed<'a> {
    pub fn new(text: &'a str, file: &'a str, doc: Document, host: Option<&'a dyn crate::host::Host>) -> Indexed<'a> {
        let all = addressed_units(text, &doc);
        Indexed { text, file, doc, all, host }
    }

    /// Where the document is, for messages.
    pub fn whereof(&self) -> &str {
        if self.file == "-" {
            "stdin"
        } else {
            self.file
        }
    }

    /// Every unit (not a prose run) carrying the id, by name equality (NFD).
    fn with_id(&self, id: &str) -> Vec<&Addressed> {
        let key = nfd(id);
        self.all.iter().filter(|a| a.unit.id.as_deref().map(nfd) == Some(key.clone())).collect()
    }

    /// `#id`, a bare id, or a pasted heading line, resolved to an id.
    pub fn resolve_selector(&self, raw: &str) -> Result<String, Refusal> {
        let bare = raw.strip_prefix('#').unwrap_or(raw);
        let hashes = raw.chars().take_while(|c| *c == '#').count();
        if hashes == 0 || hashes > 6 {
            return Ok(bare.to_string());
        }
        let want = raw[hashes..].trim_matches([' ', '\t']);
        if want.is_empty() {
            return Ok(bare.to_string());
        }
        // 1. The id is canonical and always wins.
        if self.all.iter().any(|a| a.unit.kind != Kind::Prose && a.unit.id.as_deref().map(nfd) == Some(nfd(bare))) {
            return Ok(bare.to_string());
        }
        let level = hashes;
        let heads: Vec<(&str, usize, &str)> = self
            .all
            .iter()
            .filter(|a| a.unit.kind == Kind::Heading)
            .filter_map(|a| Some((a.unit.id.as_deref()?, a.unit.level?, a.unit.text.as_deref()?)))
            .collect();
        // 2. The exact line — what the caller typed. Two headings can share
        //    it, which is as ambiguous as shared text below.
        let lines: Vec<&(&str, usize, &str)> = heads.iter().filter(|(_, l, t)| *l == level && *t == want).collect();
        if lines.len() == 1 {
            return Ok(lines[0].0.to_string());
        }
        if lines.len() > 1 {
            let list = lines.iter().map(|(id, l, _)| format!("  #{id}  (h{l})")).collect::<Vec<_>>().join("\n");
            return refuse(Reason::AmbiguousAddress, format!("`{raw}` matches {} headings — address one by its id:\n{list}", lines.len()));
        }
        // 3. The text alone: exact, then case-insensitive.
        let mut by_text: Vec<&(&str, usize, &str)> = heads.iter().filter(|(_, _, t)| *t == want).collect();
        if by_text.is_empty() {
            let lc = want.to_lowercase();
            by_text = heads.iter().filter(|(_, _, t)| t.to_lowercase() == lc).collect();
        }
        if by_text.len() == 1 {
            return Ok(by_text[0].0.to_string());
        }
        // 4. Shared text: the level disambiguates, else the candidates are listed.
        if by_text.len() > 1 {
            let at_level: Vec<&&(&str, usize, &str)> = by_text.iter().filter(|(_, l, _)| *l == level).collect();
            if at_level.len() == 1 {
                return Ok(at_level[0].0.to_string());
            }
            let list = by_text.iter().map(|(id, l, _)| format!("  #{id}  (h{l})")).collect::<Vec<_>>().join("\n");
            return refuse(Reason::AmbiguousAddress, format!("`{want}` matches {} headings — address one by its id:\n{list}", by_text.len()));
        }
        // Nothing matched. A lone `#` with no whitespace was almost certainly
        // meant as an id; let the caller's own `no block with id` stand.
        if level == 1 && !bare.chars().any(char::is_whitespace) {
            return Ok(bare.to_string());
        }
        refuse(Reason::NoSuchUnit, format!("no id or heading matches `{raw}` — run `geml get {}` to list every addressable id", self.whereof()))
    }

    /// The units a selector names: one for a key, 0..N for a filter. A
    /// coordinate is refused unless the caller takes one.
    pub fn select(&self, raw: &str, allow_coord: bool) -> Result<(Vec<Unit>, Selector), Refusal> {
        let sel = parse_selector(raw);
        let whereof = self.whereof();
        match &sel {
            Selector::List => {
                return refuse(Reason::BadAddress, format!("no selector given — run `geml get {whereof}` to list addressable blocks"));
            }
            Selector::Coord { base, .. } if !allow_coord => {
                return refuse(
                    Reason::BadAddress,
                    format!(
                        "`{}` addresses a unit INSIDE a block (GEP 0011), and this command takes a block address — write `{base}` for the whole block",
                        raw.trim()
                    ),
                );
            }
            Selector::Attr { keys, .. } if keys.is_empty() => {
                return refuse(
                    Reason::BadAddress,
                    format!("`{}` names no key — write one inside the braces, such as `{{#id}}`, `{{.warn}}` or `{{lang=py}}`, or drop them", raw.trim()),
                );
            }
            _ => {}
        }
        match &sel {
            Selector::Content { type_name, hex, nth } => {
                let hit = self.all.iter().find(|a| &a.hex == hex && a.nth == *nth);
                let Some(hit) = hit else {
                    let suffix = if *nth > 0 { format!("~{nth}") } else { String::new() };
                    return refuse(
                        Reason::NoSuchUnit,
                        format!("no block matching `@{hex}{suffix}` in {whereof} — a content address goes stale when the block's content changes; run `geml get {whereof}` to list every addressable block"),
                    );
                };
                if let Some(t) = type_name {
                    if hit.unit.type_name.as_deref() != Some(t) {
                        let found = hit.unit.type_name.clone().unwrap_or_else(|| hit.unit.kind_name());
                        return refuse(
                            Reason::BadAddress,
                            format!("`@{hex}` addresses a `{found}` block, not `{t}` — drop the type prefix to address it by content alone"),
                        );
                    }
                }
                Ok((vec![hit.unit.clone()], sel))
            }
            Selector::Line { from, to } => match match_line(*from, *to, &self.all) {
                Some(u) => Ok((vec![u.clone()], sel)),
                None => {
                    let span = if from == to { format!("L{from}") } else { format!("L{from}-{to}") };
                    refuse(
                        Reason::NoSuchUnit,
                        format!("no block contains {span} in {whereof} — a position selector names ONE block, so a range spanning two of them (or a line past the end) has no answer"),
                    )
                }
            },
            Selector::Type(t) => {
                let hits: Vec<Unit> = match_type(t, &self.all).into_iter().cloned().collect();
                if hits.is_empty() {
                    return refuse(Reason::NoSuchUnit, format!("no `{t}` block in {whereof} — run `geml get {whereof}` to list every addressable block"));
                }
                Ok((hits, sel))
            }
            Selector::Attr { type_name, id, content, classes, attrs, .. } => {
                let hits: Vec<Unit> = self
                    .all
                    .iter()
                    .filter(|a| {
                        let u = &a.unit;
                        type_name.as_ref().map_or(true, |t| u.type_name.as_deref() == Some(t))
                            && id.as_ref().map_or(true, |i| u.id.as_deref().map(nfd) == Some(nfd(i)))
                            && content.iter().all(|(h, n)| &a.hex == h && a.nth == *n)
                            && classes.iter().all(|c| u.classes.contains(c))
                            && attrs.iter().all(|(k, v)| u.attrs.iter().any(|(uk, uv)| uk == k && uv == v))
                    })
                    .map(|a| a.unit.clone())
                    .collect();
                if hits.is_empty() {
                    return refuse(
                        Reason::NoSuchUnit,
                        format!("no block matching `{}` in {whereof} — run `geml get {whereof}` to list every addressable block", raw.trim()),
                    );
                }
                Ok((hits, sel))
            }
            Selector::Id { .. } | Selector::Coord { .. } => {
                let r = match &sel {
                    Selector::Id { raw, .. } => raw.clone(),
                    Selector::Coord { base, .. } => base.clone(),
                    _ => unreachable!(),
                };
                let id = self.resolve_selector(&r)?;
                let hits = self.with_id(&id);
                // `#meta`, claimed by no block, is the document's `meta` block
                // when it has one — the address the listing prints for it —
                // and, when it has several, their merge, which no block
                // operation can act on.
                if hits.is_empty() && nfd(&id) == nfd("meta") {
                    let metas: Vec<&super::units::Addressed> =
                        self.all.iter().filter(|a| a.unit.kind == Kind::Block && a.unit.type_name.as_deref() == Some("meta")).collect();
                    if metas.len() == 1 {
                        return Ok((vec![metas[0].unit.clone()], sel));
                    }
                    if metas.len() > 1 {
                        let list = metas.iter().map(|a| format!("  {}", super::units::shortest_address(a, &self.all))).collect::<Vec<_>>().join("\n");
                        return refuse(
                            Reason::AmbiguousAddress,
                            format!(
                                "`#meta` names the merge of this document's {} `meta` blocks, and this names ONE block — address one of them:\n{list}",
                                metas.len()
                            ),
                        );
                    }
                }
                let Some(first) = hits.first() else {
                    return refuse(Reason::NoSuchUnit, format!("no block with id `{id}`"));
                };
                if let Selector::Id { type_name: Some(t), .. } = &sel {
                    if first.unit.type_name.as_deref() != Some(t) {
                        let why = match first.unit.kind {
                            Kind::Block => format!("addresses a `{}` block, not `{t}`", first.unit.type_name.clone().unwrap_or_default()),
                            _ => format!("addresses a {}, and `=== {t}` names a typed block", first.unit.kind_name()),
                        };
                        return refuse(Reason::BadAddress, format!("`#{id}` {why} — drop the type prefix to address it by id alone"));
                    }
                }
                Ok((vec![first.unit.clone()], sel))
            }
            Selector::List => unreachable!("refused above"),
        }
    }

    /// The spans a `within` selector names.
    pub fn scopes(&self, within: &str) -> Result<Vec<Span>, Refusal> {
        Ok(self.select(within, false)?.0.into_iter().map(|u| u.span).collect())
    }
}

/// Strictly inside one of the scopes: within it, and not the scope itself.
pub fn inside_any(u: &Unit, scopes: &[Span]) -> bool {
    scopes.iter().any(|s| u.span.start >= s.start && u.span.end <= s.end && (u.span.start != s.start || u.span.end != s.end))
}
