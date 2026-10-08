//! Every addressable unit of a document, in document order, with the line
//! span it occupies and its content address (§4): typed blocks (with or
//! without an id), headings with their whole section, and the stretches of
//! prose between them (GEP-0010). The one index a listing and every selector
//! work from, so `get`, `set` and the listing cannot disagree about what
//! exists.
//!
//! Spans come from the parsed model, not from a second scan of the text: a
//! block knows its fence lines, a heading its line, and a section runs to
//! the next heading of its level or shallower (or its container's end). §0.5
//! keeps those line numbers valid on the original text.

use std::collections::HashSet;

use crate::json::Value;
use crate::model::{Document, Item, Mode};
use crate::uni::nfd;

use super::lines::lf_lines;

/// A half-open range of 0-based line indices.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Block,
    Heading,
    Prose,
    /// A Markdown footnote definition, `[^label]: …`.
    Footnote,
}

#[derive(Clone, Debug)]
pub struct Unit {
    pub span: Span,
    pub kind: Kind,
    /// A typed block's type.
    pub type_name: Option<String>,
    pub id: Option<String>,
    /// A heading's level and text.
    pub level: Option<usize>,
    pub text: Option<String>,
    pub classes: Vec<String>,
    pub attrs: Vec<(String, Value)>,
    /// A flow block's body: the lines between its fences. Only a flow body
    /// holds units of its own.
    pub body: Option<Span>,
    /// How many lines a heading's head takes: one, or a setext heading's
    /// text and underline.
    pub head: usize,
}

impl Unit {
    /// The kind a listing prints: a block's type, else `heading` or `prose`.
    pub fn kind_name(&self) -> String {
        match self.kind {
            Kind::Block => self.type_name.clone().unwrap_or_else(|| "block".to_string()),
            Kind::Heading => "heading".to_string(),
            Kind::Prose => "prose".to_string(),
            Kind::Footnote => "footnote".to_string(),
        }
    }

    fn empty(span: Span, kind: Kind) -> Unit {
        Unit { span, kind, type_name: None, id: None, level: None, text: None, classes: Vec::new(), attrs: Vec::new(), body: None, head: 1 }
    }
}

/// A unit with its content address: the first eight hex digits of the
/// SHA-256 of its own source text (LF-normalized), and `nth` — which of the
/// byte-identical units it is, in document order.
#[derive(Clone, Debug)]
pub struct Addressed {
    pub unit: Unit,
    pub hex: String,
    pub nth: usize,
}

impl Addressed {
    /// `@<hex>`, with `~n` for a later byte-identical twin.
    pub fn content_address(&self) -> String {
        if self.nth == 0 {
            format!("@{}", self.hex)
        } else {
            format!("@{}~{}", self.hex, self.nth)
        }
    }
}

/// The addressable units of `text`, whose model is `doc`.
pub fn addressed_units(text: &str, doc: &Document) -> Vec<Addressed> {
    let lines = lf_lines(text);
    let mut units: Vec<Unit> = Vec::new();
    collect(&doc.children, lines.len(), &mut units);
    if doc.markdown {
        footnote_units(&doc.children, 0, lines.len(), &lines, &mut units);
        // Back into document order, a container before what it holds: the
        // prose runs below read the units as a nesting.
        units.sort_by(|a, b| a.span.start.cmp(&b.span.start).then(b.span.end.cmp(&a.span.end)));
    }

    // GEP-0010: prose runs join the index, trimmed to the prose itself so a
    // run is the lines `get` prints and not the blank lines framing it.
    let declared: HashSet<String> = units.iter().filter_map(|u| u.id.as_deref().map(nfd)).collect();
    for run in prose_runs(&units, &lines) {
        let (mut s, mut e) = (run.span.start, run.span.end.min(lines.len()));
        while s < e && lines[s].trim().is_empty() {
            s += 1;
        }
        while e > s && lines[e - 1].trim().is_empty() {
            e -= 1;
        }
        if e <= s {
            continue;
        }
        // An explicit id always wins: a real block called `#intro-before-setup`
        // shadows the run that would otherwise carry that name.
        let id = run.id.filter(|id| !declared.contains(&nfd(id)));
        let mut u = Unit::empty(Span { start: s, end: e }, Kind::Prose);
        u.id = id;
        units.push(u);
    }
    units.sort_by(|a, b| a.span.start.cmp(&b.span.start).then(a.span.end.cmp(&b.span.end)));

    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    units
        .into_iter()
        .map(|unit| {
            let end = unit.span.end.min(lines.len());
            let own = lines[unit.span.start.min(end)..end].join("\n");
            let hex = crate::sha256::hex(own.as_bytes())[..8].to_string();
            let nth = *seen.get(&hex).unwrap_or(&0);
            seen.insert(hex.clone(), nth + 1);
            Addressed { unit, hex, nth }
        })
        .collect()
}

/// Blocks and headings of one container, in document order; a flow block's
/// body is walked too, so a nested unit registers its own span (spans
/// overlap by design: a section contains its blocks, each still addressable).
fn collect(items: &[Item], container_end: usize, out: &mut Vec<Unit>) {
    for (k, it) in items.iter().enumerate() {
        match it {
            Item::Block(b) => {
                let flow = b.mode == Mode::Flow;
                let mut u = Unit::empty(Span { start: b.line - 1, end: b.end }, Kind::Block);
                u.type_name = Some(b.type_name.clone());
                u.id = b.id.clone();
                u.classes = b.classes.clone();
                u.attrs = b.attrs.clone();
                if flow {
                    u.body = Some(Span { start: b.body_start - 1, end: b.body_end - 1 });
                }
                out.push(u);
                if flow {
                    collect(&b.children, b.body_end - 1, out);
                }
            }
            Item::Heading(h) => {
                // A section runs to the next sibling heading of the same or a
                // shallower level, else to its container's end — blank lines
                // included, as the span `set` replaces.
                let end = items[k + 1..]
                    .iter()
                    .find_map(|o| match o {
                        Item::Heading(x) if x.level <= h.level => Some(x.line - 1),
                        _ => None,
                    })
                    .unwrap_or(container_end);
                let mut u = Unit::empty(Span { start: h.line - 1, end }, Kind::Heading);
                u.id = if h.id.is_empty() { None } else { Some(h.id.clone()) };
                u.level = Some(h.level);
                u.text = Some(h.text.trim_matches([' ', '\t']).to_string());
                u.classes = h.classes.clone();
                u.attrs = h.attrs.clone();
                u.head = h.head.max(1);
                out.push(u);
            }
            Item::Paragraph(_) | Item::List(_) | Item::Hidden(_) => {}
        }
    }
}

/// Markdown's footnote definitions, as units: `[^label]: …` on a line no
/// block or heading holds, outside code, running as GFM reads one — its lazy
/// lines, then whatever is indented past a blank line. The parse keeps the
/// definition as prose; only the address walk makes it a unit.
fn footnote_units(items: &[Item], start: usize, end: usize, lines: &[String], out: &mut Vec<Unit>) {
    let end = end.min(lines.len());
    let slice = &lines[start.min(end)..end];
    let st = crate::markdown::structure(slice, &crate::registry::is_known);
    let mut held: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    for it in items {
        match it {
            Item::Block(b) => {
                held.insert(b.line - 1, b.end);
                if b.mode == Mode::Flow {
                    footnote_units(&b.children, b.body_start - 1, b.body_end - 1, lines, out);
                }
            }
            Item::Heading(h) => {
                held.insert(h.line - 1, h.line - 1 + h.head.max(1));
            }
            _ => {}
        }
    }
    let mut i = start;
    while i < end {
        if let Some(&to) = held.get(&i) {
            i = to.max(i + 1);
            continue;
        }
        if !st.shield.contains(&(i - start)) {
            if let Some((label, _)) = crate::markdown::footnote_def(&lines[i]) {
                let to = start + crate::markdown::footnote_end(slice, i - start);
                let mut u = Unit::empty(Span { start: i, end: to }, Kind::Footnote);
                u.id = Some(label.trim().to_string());
                out.push(u);
                i = to;
                continue;
            }
        }
        i += 1;
    }
}

struct Run {
    span: Span,
    id: Option<String>,
}

/// A `%%` line: not content, so a gap of nothing else is no run.
fn is_hidden(line: &str) -> bool {
    line.trim_start_matches([' ', '\t']).starts_with("%%")
}

/// The prose runs between units, per container (GEP-0010). Containers are
/// headings and flow blocks; the document body is one too. A run is named
/// after its neighbours — `#prev-between-next`, `#container-before-next`,
/// `#container-after-prev` — when both names exist.
fn prose_runs(units: &[Unit], lines: &[String]) -> Vec<Run> {
    let meta_solo = units.iter().filter(|u| u.type_name.as_deref() == Some("meta")).count() == 1;
    // §4 rule 1: an id-less `meta` block is the anchor `meta` when it is the only one.
    let anchor_id = |u: &Unit| -> Option<String> {
        if u.id.is_some() {
            u.id.clone()
        } else if u.type_name.as_deref() == Some("meta") && meta_solo {
            Some("meta".to_string())
        } else {
            None
        }
    };

    // Which units each container holds directly: a stack over document order
    // nests headings and flow bodies correctly. Entry 0 is the document body.
    let mut containers: Vec<(Option<usize>, Vec<usize>)> = vec![(None, Vec::new())];
    let mut stack: Vec<usize> = Vec::new();
    for (i, u) in units.iter().enumerate() {
        while let Some(&top) = stack.last() {
            if u.span.start >= units[top].span.end {
                stack.pop();
            } else {
                break;
            }
        }
        let parent = stack.last().copied();
        match containers.iter_mut().find(|(c, _)| *c == parent) {
            Some((_, kids)) => kids.push(i),
            None => containers.push((parent, vec![i])),
        }
        if u.kind == Kind::Heading || u.body.is_some() {
            stack.push(i);
        }
    }

    let mut runs = Vec::new();
    for (container, kids) in &containers {
        let (body_start, body_end, container_id) = match container {
            None => (0, lines.len(), None),
            Some(c) => {
                let cu = &units[*c];
                let (s, e) = match cu.body {
                    Some(b) => (b.start, b.end),
                    None => (cu.span.start + cu.head, cu.span.end),
                };
                (s, e, cu.id.clone())
            }
        };
        let mut gaps: Vec<(usize, usize, Option<usize>, Option<usize>)> = Vec::new();
        let mut at = body_start;
        for (gi, &k) in kids.iter().enumerate() {
            let prev = if gi == 0 { None } else { Some(kids[gi - 1]) };
            gaps.push((at, units[k].span.start, prev, Some(k)));
            at = units[k].span.end;
        }
        gaps.push((at, body_end, kids.last().copied(), None));
        for (from, to, prev, next) in gaps {
            if to <= from {
                continue;
            }
            let upto = to.min(lines.len());
            if from >= upto || lines[from..upto].iter().all(|l| l.trim().is_empty() || is_hidden(l)) {
                continue;
            }
            let prev_id = prev.map(|p| anchor_id(&units[p]));
            let next_id = next.map(|n| anchor_id(&units[n]));
            let id = run_address(container_id.as_deref(), prev_id, next_id);
            runs.push(Run { span: Span { start: from, end: to }, id });
        }
    }
    runs
}

/// The name of a run from its neighbours; `None` for a neighbour means there
/// is none, `Some(None)` one without an id.
fn run_address(container: Option<&str>, prev: Option<Option<String>>, next: Option<Option<String>>) -> Option<String> {
    match (prev, next) {
        (Some(p), Some(n)) => match (p, n) {
            (Some(p), Some(n)) => Some(format!("{p}-between-{n}")),
            _ => None,
        },
        (None, Some(n)) => match (container, n) {
            (Some(c), Some(n)) => Some(format!("{c}-before-{n}")),
            _ => None,
        },
        (Some(p), None) => match (container, p) {
            (Some(c), Some(p)) => Some(format!("{c}-after-{p}")),
            _ => None,
        },
        // Neither: the container holds nothing but this run, so the run IS the
        // container — it needs no address of its own.
        (None, None) => None,
    }
}

/// §6.1 — the SHORTEST address that identifies this unit uniquely, which is
/// what the listing prints: `#id` when it has one (and is the first to
/// declare it); else the bare type when the document holds exactly one block
/// of it; else the content address.
pub fn shortest_address(a: &Addressed, all: &[Addressed]) -> String {
    let u = &a.unit;
    if let Some(id) = &u.id {
        let key = nfd(id);
        let first = all.iter().find(|x| x.unit.id.as_deref().map(nfd) == Some(key.clone()));
        if let Some(first) = first {
            if first.unit.span == u.span && first.unit.kind == u.kind {
                return format!("#{id}");
            }
        }
    }
    let Some(t) = &u.type_name else { return a.content_address() };
    let same_type = all.iter().filter(|x| x.unit.type_name.as_deref() == Some(t)).count();
    let meta_id = all.iter().any(|x| x.unit.id.as_deref() == Some("meta"));
    // `#meta` is the reserved id for the merged metadata view; with exactly one
    // `meta` block the view and the block are the same thing.
    if t == "meta" && same_type == 1 && !meta_id {
        return "#meta".to_string();
    }
    if same_type == 1 {
        return format!("=== {t}");
    }
    format!("=== {t}{}", a.content_address())
}

/// The smallest unit that fully contains the 1-based line range.
pub fn match_line(from: usize, to: usize, all: &[Addressed]) -> Option<&Unit> {
    let mut best: Option<&Unit> = None;
    for a in all {
        let start = a.unit.span.start + 1;
        let end = a.unit.span.end;
        if start > from || end < to {
            continue;
        }
        let size = end as i64 - start as i64;
        if best.map_or(true, |b| size < b.span.end as i64 - (b.span.start as i64 + 1)) {
            best = Some(&a.unit);
        }
    }
    best
}

/// Every block of the type, in document order — id-bearing ones included.
pub fn match_type<'a>(type_name: &str, all: &'a [Addressed]) -> Vec<&'a Unit> {
    all.iter().filter(|a| a.unit.type_name.as_deref() == Some(type_name)).map(|a| &a.unit).collect()
}

/// A unit's own source text: the lines of its span, LF-joined, as the
/// content address hashes them.
pub fn own_text(lines: &[String], span: Span) -> String {
    let end = span.end.min(lines.len());
    lines[span.start.min(end)..end].join("\n")
}
