//! GEML → Markdown projection, the `to md` export. Lossy by nature — Markdown
//! has no typed-block primitive — so each construct lands on the nearest GFM
//! shape (headings, fenced code, blockquotes for `note`, pipe tables, `$$`
//! math, YAML frontmatter for `meta`, footnote definitions), and each loss is
//! noted so a caller knows the conversion was not faithful.
//!
//! An export is a snapshot, and a snapshot carries content: an `embed`, and an
//! inline projection `![[…]]`, stand here as the text they project — read
//! from this document, or through the host from another — rather than as a
//! link to it. What cannot be read is a link, so the target stays findable.

use std::cell::Cell as Counter;
use std::collections::BTreeSet;

use crate::bounds::{CHAIN_DEPTH, EMBED_TOTAL};
use crate::host::Host;
use crate::json::{quote, to_json, Value};
use crate::model::{Align, Block, Document, Inline, Item, List, Mode, Paragraph, Table};
use crate::num::es_string;
use crate::uni::nfd;

use super::coord::{pretty_json, project_coord, Shape};
use super::get::{slice_unit, Part};
use super::lines::split_physical;
use super::select::Indexed;
use super::selector::{parse_coord_path, CoordStep};
use super::units::{addressed_units, Kind, Unit};

struct Ctx<'a> {
    notes: BTreeSet<String>,
    shift: usize,
    /// Where this content was read from, for expanding what it projects;
    /// `None` for a coordinate's answer, which projects nothing further.
    here: Option<Here<'a>>,
}

/// The document a piece of the export was read from, and how many
/// expansions deep it stands.
#[derive(Clone)]
struct Here<'a> {
    ex: &'a Expander<'a>,
    at: String,
    text: String,
    depth: usize,
}

/// What every expansion of one export shares: the host other documents are
/// read through, and the budgets — expansions spent, chain hops followed.
struct Expander<'a> {
    host: Option<&'a dyn Host>,
    spent: Counter<usize>,
    hops: Counter<usize>,
}

fn esc_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '&') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn longest_backticks(v: &str) -> usize {
    let mut max = 0;
    let mut run = 0;
    for c in v.chars() {
        if c == '`' {
            run += 1;
            max = max.max(run);
        } else {
            run = 0;
        }
    }
    max
}

fn code_span(v: &str) -> String {
    let fence = "`".repeat(longest_backticks(v) + 1);
    let padded = v.starts_with('`') || v.ends_with('`') || (v.starts_with(' ') && v.ends_with(' ') && v.chars().any(|c| !c.is_whitespace()));
    let pad = if padded { " " } else { "" };
    format!("{fence}{pad}{v}{pad}{fence}")
}

fn math_text(v: &str) -> String {
    v.replace('<', "\\lt ")
}

fn md_dest(d: &str) -> String {
    d.replace(' ', "%20").replace('<', "%3C").replace('>', "%3E")
}

fn link_dest(href: &Option<String>, doc: &Option<String>, anchor: &Option<String>) -> String {
    if let Some(h) = href {
        return md_dest(h);
    }
    match (doc, anchor) {
        (Some(d), Some(a)) => md_dest(&format!("{d}#{a}")),
        (Some(d), None) => md_dest(d),
        (None, Some(a)) => md_dest(&format!("#{a}")),
        (None, None) => String::new(),
    }
}

/// Each run of white space holding a line break folded to one space:
/// projected content standing inside a sentence.
fn one_line(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.contains('\n') {
            out.push(' ');
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for c in s.chars() {
        if c.is_whitespace() {
            run.push(c);
            continue;
        }
        flush(&mut run, &mut out);
        out.push(c);
    }
    flush(&mut run, &mut out);
    out
}

fn inline(n: &Inline, ctx: &mut Ctx) -> String {
    match n {
        Inline::Text(t) => esc_text(t),
        Inline::Emph(c) => format!("*{}*", seq(c, ctx)),
        Inline::Strong(c) => format!("**{}**", seq(c, ctx)),
        Inline::Strike(c) => format!("~~{}~~", seq(c, ctx)),
        Inline::Code(v) => code_span(v),
        Inline::Math(v) => format!("${}$", math_text(v)),
        Inline::Break => "  \n".to_string(),
        Inline::Image { src, alt } => format!("![{}]({})", seq(alt, ctx), md_dest(src)),
        Inline::Link { href, doc, anchor, children } => format!("[{}]({})", seq(children, ctx), link_dest(href, doc, anchor)),
        // GEP 0011: a coordinate says its value and links to the block
        // holding it; `#meta` is no block, so its value stands as text.
        Inline::AutoRef { doc, anchor, value, base } => {
            if let (Some(v), None) = (value, base) {
                return esc_text(v);
            }
            let anchor = base.as_deref().unwrap_or(anchor);
            let target = match doc {
                Some(d) => format!("{d}#{anchor}"),
                None => format!("#{anchor}"),
            };
            let shown = value.clone().unwrap_or_else(|| target.clone());
            format!("[{}]({})", esc_text(&shown), md_dest(&target))
        }
        // The inline sibling of `=== embed`: the content stands here, on one
        // line, since it stands inside a sentence.
        Inline::Project { doc, anchor, value, .. } => {
            if let Some(v) = value {
                return esc_text(v);
            }
            let src = match doc {
                Some(d) => format!("{d}#{anchor}"),
                None => format!("#{anchor}"),
            };
            if let Some(got) = ctx.expand(&src, None, None) {
                if !got.trim().is_empty() {
                    ctx.notes.insert("inline projection expanded in place; the projection itself has no Markdown equivalent and is gone".to_string());
                    return one_line(got.trim());
                }
            }
            ctx.notes.insert("inline projection could not be resolved; emitted a link to the target instead".to_string());
            format!("[{}]({})", esc_text(&src), md_dest(&src))
        }
        Inline::Footnote(r) => format!("[^{r}]"),
    }
}

/// A code span whose delimiters stand alone on their lines projects as a
/// fenced block, the only faithful Markdown shape for it.
fn fenced_span(v: &str, before: &str, next: Option<&Inline>) -> bool {
    let opens = v.trim_start_matches([' ', '\t']).starts_with('\n');
    let closes = v.trim_end_matches([' ', '\t']).ends_with('\n');
    let line_start = before.rsplit('\n').next().is_some_and(|l| l.trim_matches([' ', '\t']).is_empty());
    let next_ok = match next {
        None => true,
        Some(Inline::Text(t)) => {
            let t = t.trim_start_matches([' ', '\t']);
            t.is_empty() || t.starts_with('\n')
        }
        _ => false,
    };
    opens && closes && line_start && next_ok
}

fn code_fence(v: &str) -> String {
    let f = "`".repeat((longest_backticks(v) + 1).max(3));
    format!("{f}{v}{f}")
}

fn seq(ns: &[Inline], ctx: &mut Ctx) -> String {
    let mut out = String::new();
    for (k, n) in ns.iter().enumerate() {
        let piece = match n {
            Inline::Code(v) if fenced_span(v, &out, ns.get(k + 1)) => code_fence(v),
            _ => inline(n, ctx),
        };
        out.push_str(&piece);
    }
    out
}

fn esc_pipe(s: &str) -> String {
    s.replace('|', "\\|")
}

fn sep(a: Option<Align>) -> &'static str {
    match a {
        Some(Align::Center) => ":--:",
        Some(Align::Right) => "---:",
        Some(Align::Left) => ":---",
        None => "---",
    }
}

/// A cell's inline content, with the two bytes that would break a GFM row
/// neutralised; a computed cell is its text.
fn cell_text(c: &crate::model::Cell, ctx: &mut Ctx) -> String {
    let md = match &c.inlines {
        Some(ns) => seq(ns, ctx),
        None => esc_text(&c.text),
    };
    esc_pipe(&md).replace('\n', " ")
}

fn table_to_md(block: &Block, t: &Table, ctx: &mut Ctx) -> String {
    // A source that was read has columns even when no row survives (a view
    // filtered to nothing): the missing columns say it could not be read.
    if let Some(src) = block.attr_text("src") {
        if t.columns.is_empty() {
            ctx.notes.insert(format!("table from external source `{src}` could not be read; emitted header only"));
        }
    }
    let cols = &t.columns;
    let mut lines: Vec<String> = Vec::new();
    if let Some(cap) = block.attr_text("caption") {
        lines.push(format!("*{}*", esc_text(&cap)));
        lines.push(String::new());
    }
    lines.push(format!("| {} |", cols.iter().map(|c| esc_pipe(&esc_text(c))).collect::<Vec<_>>().join(" | ")));
    lines.push(format!("| {} |", (0..cols.len()).map(|i| sep(t.align_of(i))).collect::<Vec<_>>().join(" | ")));
    let row_md = |cells: &[crate::model::Cell], ctx: &mut Ctx| -> String {
        let mut out: Vec<String> = cells.iter().take(cols.len()).map(|c| cell_text(c, ctx)).collect();
        out.resize(cols.len(), String::new());
        format!("| {} |", out.join(" | "))
    };
    for row in &t.rows {
        lines.push(row_md(row, ctx));
    }
    if let Some(s) = &t.summary {
        lines.push(row_md(s, ctx));
    }
    lines.join("\n")
}

fn list_to_md(l: &List, indent: &str, ctx: &mut Ctx) -> String {
    let mut out: Vec<String> = Vec::new();
    let start = l.start as i64;
    for (k, item) in l.items.iter().enumerate() {
        let marker = if l.ordered { format!("{}. ", start + k as i64) } else { "- ".to_string() };
        let task = match item.checked {
            None => "",
            Some(true) => "[x] ",
            Some(false) => "[ ] ",
        };
        let text = seq(&item.inlines, ctx);
        let mut parts = text.split('\n');
        let head = parts.next().unwrap_or("");
        out.push(format!("{indent}{marker}{task}{head}"));
        let cont = format!("{indent}{}", " ".repeat(marker.len() + task.len()));
        for p in parts {
            out.push(format!("{cont}{p}"));
        }
        for child in &item.children {
            out.push(list_to_md(child, &format!("{indent}  "), ctx));
        }
        if l.loose && k + 1 < l.items.len() {
            out.push(String::new());
        }
    }
    out.join("\n")
}

fn fence(lang: &str, body: &[String]) -> String {
    let mut max = 2;
    for ln in body {
        let run = ln.trim().chars().take_while(|c| *c == '`').count();
        max = max.max(run);
    }
    let f = "`".repeat((max + 1).max(3));
    let info: String = lang.chars().filter(|c| !matches!(c, '`' | '\r' | '\n')).collect();
    let mut lines = vec![format!("{f}{info}")];
    lines.extend(body.iter().cloned());
    lines.push(f);
    lines.join("\n")
}

fn is_hidden(attrs: &[(String, Value)]) -> bool {
    attrs.iter().any(|(k, v)| k == "hidden" && *v == Value::Bool(true))
}

fn typed_to_md(b: &Block, ctx: &mut Ctx) -> String {
    if is_hidden(&b.attrs) {
        ctx.notes.insert("`{hidden}` block(s) dropped (not part of the rendered output)".to_string());
        return String::new();
    }
    if matches!(b.mode, Mode::Flow | Mode::Prose) {
        if b.type_name == "note" && b.classes.iter().any(|c| c == "footnote") {
            if let Some(id) = &b.id {
                let text = b.children.iter().map(|c| item_to_md(c, ctx)).collect::<Vec<_>>().join(" ");
                let text = text.split('\n').filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
                return format!("[^{id}]: {}", text.trim());
            }
        }
        let inner = b.children.iter().map(|c| item_to_md(c, ctx)).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n");
        if b.type_name == "text" || b.mode == Mode::Prose {
            return inner;
        }
        return inner.split('\n').map(|l| if l.is_empty() { ">".to_string() } else { format!("> {l}") }).collect::<Vec<_>>().join("\n");
    }
    let raw = &b.raw;
    match b.type_name.as_str() {
        "code" => fence(&b.attr_text("lang").unwrap_or_default(), raw),
        "data" => {
            let fmt = b.attr_text("format").unwrap_or_else(|| "json".to_string());
            if raw.is_empty() {
                if let Some(v) = &b.value {
                    let body: Vec<String> = match (fmt.as_str(), v) {
                        ("jsonl", Value::Array(a)) => a.iter().map(to_json).collect(),
                        _ => pretty_json(v).split('\n').map(str::to_string).collect(),
                    };
                    ctx.notes
                        .insert(format!("data from external source `{}` inlined as its loaded value", b.attr_text("src").unwrap_or_else(|| "?".to_string())));
                    return fence(&fmt, &body);
                }
            }
            fence(&fmt, raw)
        }
        "math" => {
            let mut lines = vec!["$$".to_string()];
            lines.extend(raw.iter().map(|l| math_text(l)));
            lines.push("$$".to_string());
            lines.join("\n")
        }
        // A relation exports as the grid it renders; a remote source, or a view
        // over one, has no rows at build time (§3.3).
        "table" | "view" => match &b.table {
            Some(t) => table_to_md(b, t, ctx),
            // A local source the parse could not read is a table without rows,
            // and says so; a remote one, or a view over another block, is the
            // renderer's to load.
            None => match b.attr_text("src") {
                Some(src) if crate::inline::scheme_of(&src).is_none() && !(b.type_name == "view" && src.starts_with('#')) => {
                    table_to_md(b, &Table::default(), ctx)
                }
                src => format!("*External data {} — loaded at render time.*", code_span(&src.unwrap_or_default())),
            },
        },
        "diagram" => {
            let fmt = b.attr_text("format").unwrap_or_default();
            if fmt == "geml-chart" {
                ctx.notes.insert("`geml-chart` block(s) cannot render in Markdown; emitted a descriptor".to_string());
                let desc = ["type", "data", "x", "y", "series"].iter().filter_map(|k| b.attr_text(k).map(|v| format!("{k}={v}"))).collect::<Vec<_>>().join(" ");
                return fence("geml-chart", &[desc]);
            }
            fence(&fmt, raw)
        }
        // Markdown has no transclusion: the projection is resolved and its
        // content stands here. What is lost is the machinery, on purpose — a
        // marker that let a return trip put the `embed` back would re-evaluate
        // it over the top of whatever the export's reader edited.
        "embed" => {
            let target = b.attr_text("src").unwrap_or_default().trim().to_string();
            if !target.is_empty() {
                let shift = ctx.shift;
                if let Some(got) = ctx.expand(&target, Some(&b.attrs), Some(shift)) {
                    if !got.trim().is_empty() {
                        ctx.notes.insert("block transclusion expanded in place; the `embed` itself has no Markdown equivalent and is gone".to_string());
                        return got.trim_end().to_string();
                    }
                }
            }
            ctx.notes.insert("block transclusion could not be resolved; emitted a link to the target instead".to_string());
            if target.is_empty() {
                String::new()
            } else {
                format!("[{}]({})", esc_text(&target), md_dest(&target))
            }
        }
        other => {
            ctx.notes.insert(format!("unknown block type `{other}` emitted as a fenced code block"));
            fence(other, raw)
        }
    }
}

fn item_to_md(it: &Item, ctx: &mut Ctx) -> String {
    match it {
        Item::Heading(h) => {
            if is_hidden(&h.attrs) {
                ctx.notes.insert("hidden heading dropped".to_string());
                return String::new();
            }
            if h.declared {
                ctx.notes.insert("heading id/attributes dropped (Markdown has no attribute syntax)".to_string());
            }
            let level = h.level + ctx.shift;
            if level > 6 {
                ctx.notes.insert("heading deeper than level 6 after the title shift was clamped to level 6".to_string());
            }
            format!("{} {}", "#".repeat(level.min(6)), seq(&h.inlines, ctx))
        }
        Item::Paragraph(p) => seq(&p.inlines, ctx),
        Item::Hidden(_) => String::new(),
        Item::List(l) => list_to_md(l, "", ctx),
        Item::Block(b) => typed_to_md(b, ctx),
    }
}

/// A front-matter value: bare when it reads back as itself, quoted otherwise.
fn yaml_value(v: &Value) -> String {
    match v {
        Value::Bool(_) => to_json(v),
        Value::Number(n) => es_string(*n),
        Value::String(s) => {
            let bare = !s.is_empty() && s.trim() == s && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | '.' | ',' | '/' | '@' | '-'));
            if bare {
                s.clone()
            } else {
                quote(s)
            }
        }
        other => quote(&to_json(other)),
    }
}

/// Where the document's title lives: the merged meta `title`; `echo` when
/// the first visible heading is a level-1 heading reading exactly that.
fn doc_title(doc: &Document) -> (Option<String>, bool) {
    let title = doc.children.iter().find_map(|it| match it {
        Item::Block(b) if b.type_name == "meta" && b.mode == Mode::Data => b.data.iter().find(|(k, _)| k == "title").map(|(_, v)| match v {
            Value::String(s) => Some(s.trim().to_string()),
            _ => None,
        }),
        _ => None,
    });
    let Some(Some(title)) = title else { return (None, false) };
    if title.is_empty() {
        return (None, false);
    }
    let first = doc.children.iter().find_map(|it| match it {
        Item::Heading(h) if !is_hidden(&h.attrs) => Some(h),
        _ => None,
    });
    let echo = first.is_some_and(|h| h.level == 1 && h.text.trim() == title);
    (Some(title), echo)
}

/// The export of a document read from nothing but itself: what it embeds
/// is a link.
pub fn to_md(doc: &Document) -> (String, Vec<String>) {
    render(doc, false, None, None)
}

/// The export, `embedded` for content going into another Markdown document:
/// no title of its own, no front matter, headings where they are.
pub fn to_md_with(doc: &Document, embedded: bool) -> (String, Vec<String>) {
    render(doc, embedded, None, None)
}

/// The export of `doc`, whose source is `text` at `file`, expanding what it
/// embeds through `host`.
pub fn to_md_from(doc: &Document, file: &str, text: &str, host: Option<&dyn Host>) -> (String, Vec<String>) {
    let ex = Expander { host, spent: Counter::new(0), hops: Counter::new(0) };
    render(doc, false, None, Some(Here { ex: &ex, at: file.to_string(), text: text.to_string(), depth: 0 }))
}

/// `embedded`: content going into another Markdown document — no title of its
/// own and no front matter, its headings `shift` levels down as its host's are.
fn render(doc: &Document, embedded: bool, shift: Option<usize>, here: Option<Here>) -> (String, Vec<String>) {
    let (title, echo) = if embedded { (None, false) } else { doc_title(doc) };
    let shift = shift.unwrap_or(if title.is_some() && !echo { 1 } else { 0 });
    let mut ctx = Ctx { notes: BTreeSet::new(), shift, here };
    let mut metas: Vec<(String, Value)> = Vec::new();
    let mut parts: Vec<String> = Vec::new();
    for it in &doc.children {
        if let Item::Block(b) = it {
            if b.type_name == "meta" && b.mode == Mode::Data {
                for (k, v) in &b.data {
                    match metas.iter_mut().find(|(mk, _)| mk == k) {
                        Some((_, mv)) => *mv = v.clone(),
                        None => metas.push((k.clone(), v.clone())),
                    }
                }
                continue;
            }
        }
        let md = item_to_md(it, &mut ctx);
        if !md.is_empty() {
            parts.push(md);
        }
    }
    let fm = if metas.is_empty() || embedded {
        String::new()
    } else {
        let mut lines = vec!["---".to_string()];
        lines.extend(metas.iter().map(|(k, v)| format!("{k}: {}", yaml_value(v))));
        lines.push("---".to_string());
        lines.join("\n")
    };
    let mut body_parts: Vec<String> = Vec::new();
    if let Some(t) = &title {
        if !echo {
            body_parts.push(format!("# {}", esc_text(t)));
        }
    }
    body_parts.extend(parts);
    let body = body_parts.join("\n\n");
    let md = if fm.is_empty() { format!("{body}\n") } else { format!("{fm}\n\n{body}\n") };
    (md, ctx.notes.into_iter().collect())
}

impl Ctx<'_> {
    /// What `target` projects, as Markdown standing in this content; `None`
    /// when it cannot be read — no host, an unreachable document, a chain too
    /// long, a cycle, the budget spent.
    fn expand(&mut self, target: &str, attrs: Option<&[(String, Value)]>, shift: Option<usize>) -> Option<String> {
        let here = self.here.clone()?;
        let mut notes = Vec::new();
        let out = here.ex.expand(&here, target, attrs, shift.unwrap_or(0), &mut notes);
        self.notes.extend(notes);
        out
    }
}

/// A document's text, at its path, read as that path says (`.md` as Markdown).
struct Doc<'h> {
    path: String,
    text: String,
    host: Option<&'h dyn Host>,
}

impl Doc<'_> {
    fn parse(&self, vocab: Option<&[String]>, text: &str) -> Document {
        let opts = crate::Options { name: self.path.clone(), host: self.host, markdown: crate::is_markdown_path(&self.path), ..Default::default() };
        crate::parse_under(text, &opts, vocab)
    }

    /// The whole document, and the vocabularies its `meta` declares — which a
    /// slice of it, carrying no `meta` of its own, is read under.
    fn index(&self) -> (Document, Vec<String>) {
        let doc = self.parse(None, &self.text);
        let vocab = crate::resolve::declared_profiles(&doc.children);
        (doc, vocab)
    }
}

/// Where a chain ended: a unit, the document holding it and its text.
struct End {
    doc: String,
    text: String,
    unit: Unit,
}

struct Hop {
    doc: String,
    text: String,
    units: Vec<Unit>,
}

impl Expander<'_> {
    fn expand(&self, here: &Here, target: &str, attrs: Option<&[(String, Value)]>, shift: usize, notes: &mut Vec<String>) -> Option<String> {
        if here.depth >= CHAIN_DEPTH {
            return None;
        }
        let spent = self.spent.get();
        self.spent.set(spent + 1);
        if spent >= EMBED_TOTAL {
            if spent == EMBED_TOTAL {
                notes.push(format!("expansion budget spent ({EMBED_TOTAL} expansions); later embeds are links"));
            }
            return None;
        }
        // GEP 0010: `part=` narrows a heading's section as `get` does.
        let asked = attrs.and_then(|a| a.iter().find(|(k, _)| k == "part")).and_then(|(_, v)| match v {
            Value::String(s) => Some(s.trim().to_string()),
            _ => None,
        });
        let part = match asked.as_deref() {
            Some("head") => Part::Head,
            Some("body") => Part::Body,
            Some("intro") => Part::Intro,
            _ => Part::Whole,
        };
        let (doc_path, frag) = match target.find('#') {
            Some(h) => (&target[..h], &target[h + 1..]),
            None => (target, ""),
        };
        // §5.2: a coordinate names a unit with no span of its own, so it is
        // answered from the model — a row as a one-row table under its
        // header, a value as a paragraph.
        if frag.contains('[') {
            if crate::inline::scheme_of(doc_path).is_some() {
                return None;
            }
            let d = if doc_path.is_empty() {
                Doc { path: here.at.clone(), text: here.text.clone(), host: self.host }
            } else {
                let rel = crate::host::join(&here.at, doc_path)?;
                let text = self.read_confined(&rel)?;
                Doc { path: rel, text, host: self.host }
            };
            let (_, vocab) = d.index();
            let model = d.parse(Some(&vocab), &d.text);
            let picked = embed_coordinate(&model.children, frag)?;
            let (md, n) = render(&Document { children: picked, ..Default::default() }, true, Some(shift), None);
            notes.extend(n);
            let md = md.trim();
            return (!md.is_empty()).then(|| md.to_string());
        }
        // `src=#id` names a block in this document.
        if target.starts_with('#') {
            let d = Doc { path: here.at.clone(), text: here.text.clone(), host: self.host };
            let (doc, vocab) = d.index();
            let ix = Indexed::new(&d.text, &d.path, doc, self.host);
            let (units, _) = ix.select(target, false).ok()?;
            return self.render_units(here, &ix, &vocab, &units, part, shift, notes);
        }
        let hop = self.one_hop(&here.at, target)?;
        let mut ends: Vec<End> = Vec::new();
        for u in hop.units {
            ends.extend(self.view_resolve(&hop.doc, &hop.text, u, 0, &[])?);
        }
        let mut out: Vec<String> = Vec::new();
        for e in ends {
            let d = Doc { path: e.doc, text: e.text, host: self.host };
            let (doc, vocab) = d.index();
            let ix = Indexed::new(&d.text, &d.path, doc, self.host);
            if let Some(one) = self.render_units(here, &ix, &vocab, &[e.unit], part, shift, notes) {
                out.push(one);
            }
        }
        (!out.is_empty()).then(|| out.join("\n\n"))
    }

    /// Each unit's slice, parsed under the vocabularies of the document it
    /// was cut from and exported as borrowed content — its own embeds
    /// expanded one level deeper.
    #[allow(clippy::too_many_arguments)]
    fn render_units(&self, here: &Here, ix: &Indexed, vocab: &[String], units: &[Unit], part: Part, shift: usize, notes: &mut Vec<String>) -> Option<String> {
        let lines = split_physical(ix.text);
        let d = Doc { path: ix.file.to_string(), text: ix.text.to_string(), host: self.host };
        let mut whole: Option<Vec<Item>> = None;
        let mut out: Vec<String> = Vec::new();
        for u in units {
            let slice = slice_unit(ix, &lines, u.span, part);
            let mut sub = d.parse(Some(vocab), &slice);
            rehome(&mut sub.children, &mut || whole.get_or_insert_with(|| d.parse(Some(vocab), &d.text).children).clone());
            let next = Here { ex: here.ex, at: d.path.clone(), text: d.text.clone(), depth: here.depth + 1 };
            let (md, n) = render(&sub, true, Some(shift), Some(next));
            notes.extend(n);
            let md = md.trim();
            if !md.is_empty() {
                out.push(md.to_string());
            }
        }
        (!out.is_empty()).then(|| out.join("\n\n"))
    }

    /// The text of a document a chain names: a `.geml` file the host holds.
    fn read_confined(&self, rel: &str) -> Option<String> {
        if !rel.to_ascii_lowercase().ends_with(".geml") {
            return None;
        }
        self.host?.read("", rel)
    }

    /// One hop: the target document and what the fragment names in it — with
    /// no fragment, the document's top-level units, `meta` aside.
    fn one_hop(&self, file: &str, src: &str) -> Option<Hop> {
        let (doc_path, frag) = match src.find('#') {
            Some(h) => (&src[..h], Some(&src[h + 1..])),
            None => (src, None),
        };
        if crate::inline::scheme_of(doc_path).is_some() {
            return None;
        }
        let rel = crate::host::join(file, doc_path)?;
        let text = self.read_confined(&rel)?;
        let d = Doc { path: rel, text, host: self.host };
        let (doc, _) = d.index();
        let units = match frag {
            None => {
                let every: Vec<Unit> = addressed_units(&d.text, &doc).into_iter().map(|a| a.unit).collect();
                // A heading's unit spans its section: only the outermost
                // units, or a section's blocks would come twice.
                let inside = |k: usize, u: &Unit| {
                    every.iter().enumerate().any(|(j, o)| {
                        j != k && o.span.start <= u.span.start && o.span.end >= u.span.end && (o.span.start < u.span.start || o.span.end > u.span.end)
                    })
                };
                let meta = |u: &Unit| u.kind == Kind::Block && u.type_name.as_deref() == Some("meta");
                every.iter().enumerate().filter(|(k, u)| !inside(*k, u) && !meta(u)).map(|(_, u)| u.clone()).collect()
            }
            Some(f) => {
                let ix = Indexed::new(&d.text, &d.path, doc, self.host);
                ix.select(&format!("#{f}"), false).ok()?.0
            }
        };
        Some(Hop { doc: d.path, text: d.text, units })
    }

    /// Where a unit leads: itself, or — an embed — what its `src=` reaches,
    /// followed hop by hop; `None` past `chain-depth`, past the budget, or
    /// on a cycle.
    fn view_resolve(&self, file: &str, text: &str, unit: Unit, depth: usize, seen: &[String]) -> Option<Vec<End>> {
        let src = match (&unit.kind, unit.type_name.as_deref()) {
            (Kind::Block, Some("embed")) => unit.attrs.iter().find(|(k, _)| k == "src").and_then(|(_, v)| match v {
                Value::String(s) => Some(s.clone()),
                _ => None,
            }),
            _ => None,
        };
        let Some(src) = src else {
            return Some(vec![End { doc: file.to_string(), text: text.to_string(), unit }]);
        };
        if depth >= CHAIN_DEPTH {
            return None;
        }
        let hops = self.hops.get() + 1;
        self.hops.set(hops);
        if hops > EMBED_TOTAL {
            return None;
        }
        let hop = self.one_hop(file, &src)?;
        let key = format!("{}#{}", hop.doc, hop.units.iter().map(|u| u.id.clone().unwrap_or_default()).collect::<Vec<_>>().join(","));
        if seen.contains(&key) {
            return None;
        }
        let mut next_seen = seen.to_vec();
        next_seen.push(key);
        let mut out = Vec::new();
        for u in hop.units {
            out.extend(self.view_resolve(&hop.doc, &hop.text, u, depth + 1, &next_seen)?);
        }
        Some(out)
    }
}

/// A relation borrowed by itself loses what its `src=#id` named: the slice
/// holds the view but not the table it reads. Its model is taken from the
/// whole document instead, where `#id` resolves.
fn rehome(items: &mut [Item], whole: &mut dyn FnMut() -> Vec<Item>) {
    for it in items.iter_mut() {
        let Item::Block(b) = it else { continue };
        rehome(&mut b.children, whole);
        let Some(id) = b.id.clone() else { continue };
        let Some(t) = &b.table else { continue };
        let local = b.attr_text("src").is_some_and(|s| s.trim().starts_with('#'));
        if !t.columns.is_empty() || !local {
            continue;
        }
        let all = whole();
        if let Some(Some(same)) = declared_block(&all, &id) {
            if let Some(t) = &same.table {
                b.table = Some(t.clone());
            }
        }
    }
}

/// The first unit, in document order, declaring `id`: `Some(Some(block))`
/// for a block, `Some(None)` for a heading, `None` when nothing does.
fn declared_block<'d>(items: &'d [Item], id: &str) -> Option<Option<&'d Block>> {
    let key = nfd(id);
    for it in items {
        match it {
            Item::Heading(h) if nfd(&h.id) == key => return Some(None),
            Item::Block(b) => {
                if b.id.as_deref().map(nfd).as_deref() == Some(key.as_str()) {
                    return Some(Some(b));
                }
                if let Some(found) = declared_block(&b.children, id) {
                    return Some(found);
                }
            }
            _ => {}
        }
    }
    None
}

/// §5.2: what an embed of a coordinate stands for — a row as a one-row table
/// under the table's own header, a single value as a paragraph. A column, or
/// a value-tree node holding more nodes, selects nothing.
fn embed_coordinate(items: &[Item], frag: &str) -> Option<Vec<Item>> {
    let at = frag.find('[').filter(|at| *at > 0)?;
    let path = parse_coord_path(&frag[at..])?;
    let block = declared_block(items, &frag[..at])??;
    let hit = project_coord(block, &path).ok()?;
    match hit.shape {
        Shape::Row => {
            let t = block.table.as_ref()?;
            let cells = match path.as_slice() {
                [CoordStep::Index(n)] => t.rows.get(n.checked_sub(1)?)?.clone(),
                [CoordStep::Word(w)] if w == "summary" => t.summary.clone()?,
                _ => return None,
            };
            let row = Table { columns: t.columns.clone(), rows: vec![cells], summary: None, align: t.align.clone() };
            let one = Block {
                type_name: "table".into(),
                id: None,
                classes: vec![],
                attrs: vec![],
                raw: vec![],
                children: vec![],
                data: vec![],
                value: None,
                table: Some(row),
                ..block.clone()
            };
            Some(vec![Item::Block(one)])
        }
        Shape::Leaf => {
            Some(vec![Item::Paragraph(Paragraph { source: hit.text.clone(), inlines: vec![Inline::Text(hit.text)], line: block.line, code: false })])
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiny() {
        let doc = crate::parse("# Tiny {#tiny}\n\nA *word* here.\n\n=== note {#n}\nbody\n===\n");
        assert_eq!(to_md(&doc).0, "# Tiny\n\nA *word* here.\n\n> body\n");
    }

    #[test]
    fn frontmatter_title_and_table() {
        let doc = crate::parse("=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#i}\n\n=== table {#t}\n| a | b |\n|---|---|\n| 1 | x\\|y |\n===\n");
        let (md, _) = to_md(&doc);
        assert!(md.starts_with("---\ntitle: Doc\n---\n\n# Doc\n\n## Intro\n\n| a | b |\n| --- | --- |\n| 1 | x\\|y |\n"), "{md}");
    }

    #[test]
    fn folds_line_breaks_only() {
        assert_eq!(one_line("a\n  b c\t d\n"), "a b c\t d ");
        assert_eq!(one_line("  x  "), "  x  ");
    }
}
