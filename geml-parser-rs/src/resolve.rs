//! The passes that run once the block structure is known: merged `meta`,
//! heading ids, inline content, data and table bodies, views, ids, addresses,
//! and every reference's resolution (§4, §5, §6). A cross-document reference
//! is resolved through the host when there is one, one level deep (§9.3): the
//! target is parsed for its ids and units, and its own references are not.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::bounds::CHAIN_DEPTH;
use crate::diag::Diags;
use crate::host::Host;
use crate::ids::derive_id;
use crate::inline::{parse_inline, scheme_of, split_anchor, InlineCtx, Step};
use crate::json::Value;
use crate::model::*;
use crate::table::Borrowed;
use crate::uni::nfd;
use crate::vocab::Vocabulary;

pub(crate) fn walk<'a>(items: &'a [Item], out: &mut Vec<&'a Item>) {
    for it in items {
        out.push(it);
        if let Item::Block(b) = it {
            walk(&b.children, out);
        }
    }
}

fn walk_mut(items: &mut [Item], f: &mut dyn FnMut(&mut Item)) {
    for it in items.iter_mut() {
        f(it);
        if let Item::Block(b) = it {
            walk_mut(&mut b.children, f);
        }
    }
}

fn blocks_mut(items: &mut [Item], f: &mut dyn FnMut(&mut Block)) {
    walk_mut(items, &mut |it| {
        if let Item::Block(b) = it {
            f(b)
        }
    });
}

fn list_items_mut(l: &mut List, f: &mut dyn FnMut(&mut ListItem)) {
    for it in l.items.iter_mut() {
        f(it);
        for c in it.children.iter_mut() {
            list_items_mut(c, f);
        }
    }
}

/// Every run of inline content: paragraphs, headings, list items.
fn inlines_mut(items: &mut [Item], f: &mut dyn FnMut(&mut Vec<Inline>, usize)) {
    walk_mut(items, &mut |it| match it {
        Item::Paragraph(p) => f(&mut p.inlines, p.line),
        Item::Heading(h) => f(&mut h.inlines, h.line),
        Item::List(l) => list_items_mut(l, &mut |li| f(&mut li.inlines, li.line)),
        _ => {}
    });
}

fn nodes_mut(nodes: &mut [Inline], f: &mut dyn FnMut(&mut Inline)) {
    for n in nodes.iter_mut() {
        f(n);
        match n {
            Inline::Emph(c) | Inline::Strong(c) | Inline::Strike(c) => nodes_mut(c, f),
            Inline::Link { children, .. } => nodes_mut(children, f),
            Inline::Image { alt, .. } => nodes_mut(alt, f),
            _ => {}
        }
    }
}

/// What the passes after the tree read of each typed block, in pre-order.
#[derive(Clone, Debug)]
pub struct Snap {
    pub type_name: String,
    pub id: Option<String>,
    pub classes: Vec<String>,
    pub attrs: Vec<(String, Value)>,
    pub table: Option<Table>,
    pub value: Option<Value>,
    pub line: usize,
    pub has_body: bool,
    /// The body holds exactly one non-empty paragraph and nothing else.
    pub one_paragraph: bool,
    pub raw_blank: bool,
    /// A prose type (GEP-0013): an inline-projection target like `text`.
    pub prose: bool,
    /// The inline content of each paragraph directly in the body.
    pub paras: Vec<Vec<Inline>>,
    /// The ids of the typed blocks directly in the body, in order.
    pub kids: Vec<Option<String>>,
    /// A flow body: the block's children were read as blocks.
    pub flow: bool,
    /// How many typed blocks the body holds at any depth — they follow this
    /// snap in pre-order, so a container's units are a slice of the snaps.
    pub descendants: usize,
}

fn count_blocks(items: &[Item]) -> usize {
    items
        .iter()
        .map(|it| match it {
            Item::Block(b) => 1 + count_blocks(&b.children),
            _ => 0,
        })
        .sum()
}

impl Snap {
    pub fn attr_text(&self, k: &str) -> Option<String> {
        self.attrs.iter().find(|(x, _)| x == k).and_then(|(_, v)| v.scalar_text())
    }
}

/// Every heading, in pre-order.
pub fn heads(items: &[Item]) -> Vec<HeadSnap> {
    let mut all = Vec::new();
    walk(items, &mut all);
    all.into_iter()
        .filter_map(|it| match it {
            Item::Heading(h) => Some(HeadSnap { id: h.id.clone(), level: h.level, attrs: h.attrs.clone() }),
            _ => None,
        })
        .collect()
}

pub fn snapshot(items: &[Item]) -> Vec<Snap> {
    let mut all = Vec::new();
    walk(items, &mut all);
    all.into_iter()
        .filter_map(|it| match it {
            Item::Block(b) => Some(Snap {
                type_name: b.type_name.clone(),
                id: b.id.clone(),
                classes: b.classes.clone(),
                attrs: b.attrs.clone(),
                table: b.table.clone(),
                value: b.value.clone(),
                line: b.line,
                has_body: b.has_body(),
                one_paragraph: {
                    let kids: Vec<&Item> = b.children.iter().filter(|c| !matches!(c, Item::Hidden(_))).collect();
                    matches!(b.mode, Mode::Flow | Mode::Prose) && kids.len() == 1 && matches!(kids[0], Item::Paragraph(p) if !p.inlines.is_empty())
                },
                raw_blank: b.raw.iter().all(|l| l.trim().is_empty()),
                prose: b.mode == Mode::Prose,
                paras: b
                    .children
                    .iter()
                    .filter_map(|c| match c {
                        Item::Paragraph(p) => Some(p.inlines.clone()),
                        _ => None,
                    })
                    .collect(),
                kids: b
                    .children
                    .iter()
                    .filter_map(|c| match c {
                        Item::Block(k) => Some(k.id.clone()),
                        _ => None,
                    })
                    .collect(),
                flow: b.mode == Mode::Flow,
                descendants: count_blocks(&b.children),
            }),
            _ => None,
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Found {
    Block(usize),
    /// A heading, by its index in `Index::heads`.
    Heading(usize),
    Prose,
    Meta,
}

/// What the profile checks read of a heading: a character or a scene is often
/// one, with its attributes (`points=`) on the heading line.
#[derive(Clone, Debug)]
pub struct HeadSnap {
    pub id: String,
    pub level: usize,
    pub attrs: Vec<(String, Value)>,
}

#[derive(Debug, PartialEq)]
pub enum Coord {
    Leaf(String),
    Row(String),
    Column,
    Node,
    /// A form's field, by its `name=` (GEP-0008): what a reference to it says
    /// — its label, or its name when it has none. A control, not content, so
    /// it is never projected.
    Field(String),
    /// The block's units arrive at render time; nothing to check here.
    Deferred,
}

/// One document's addressable units, as reference resolution reads them.
#[derive(Debug, Default)]
pub struct Index {
    pub snaps: Vec<Snap>,
    pub heads: Vec<HeadSnap>,
    pub ids: HashMap<String, Found>,
    /// The prose addresses, each by its NFD key.
    pub prose: HashSet<String>,
    pub meta: Vec<(String, Value)>,
    pub meta_blocks: usize,
}

/// The id map of a tree: the ids in document order, each NFD key's unit, and
/// the collisions.
struct IdMap {
    ids: Vec<String>,
    map: HashMap<String, Found>,
    /// `(id, line, is a block)` for each later occurrence of a taken id.
    clashes: Vec<(String, usize, bool)>,
}

/// First occurrence wins, compared under NFD; the collisions are kept for the
/// caller to report.
fn id_map(children: &[Item]) -> IdMap {
    let mut ids = Vec::new();
    let mut map = HashMap::new();
    let mut clashes = Vec::new();
    let mut all = Vec::new();
    walk(children, &mut all);
    let mut bi = 0usize;
    let mut hi = 0usize;
    for it in all {
        let (id, found, line, is_block) = match it {
            Item::Block(b) => {
                let n = bi;
                bi += 1;
                match &b.id {
                    Some(id) => (id.clone(), Found::Block(n), b.line, true),
                    None => continue,
                }
            }
            Item::Heading(h) => {
                hi += 1;
                // §4: the empty string is no id, so a heading that derives
                // nothing has none and collides with nothing.
                if h.id.is_empty() {
                    continue;
                }
                (h.id.clone(), Found::Heading(hi - 1), h.line, false)
            }
            _ => continue,
        };
        let key = nfd(&id);
        if map.contains_key(&key) {
            clashes.push((id, line, is_block));
            continue;
        }
        map.insert(key, found);
        ids.push(id);
    }
    IdMap { ids, map, clashes }
}

impl Index {
    /// The index of a document parsed in its own right.
    pub fn of(doc: &Document) -> Index {
        let ids = id_map(&doc.children).map;
        Index {
            snaps: snapshot(&doc.children),
            heads: heads(&doc.children),
            ids,
            prose: doc.prose.iter().map(|p| nfd(p)).collect(),
            meta: doc.meta.clone(),
            meta_blocks: doc.meta_blocks,
        }
    }

    pub fn find(&self, id: &str) -> Option<Found> {
        let key = nfd(id);
        if let Some(f) = self.ids.get(&key) {
            return Some(*f);
        }
        if self.prose.contains(&key) {
            return Some(Found::Prose);
        }
        if key == "meta" && self.meta_blocks > 0 {
            return Some(Found::Meta);
        }
        None
    }

    /// The block a `Found` names, when it names one.
    pub fn block(&self, f: Found) -> Option<&Snap> {
        match f {
            Found::Block(i) => self.snaps.get(i),
            _ => None,
        }
    }

    fn tree(&self, mut v: &Value, steps: &[Step]) -> Result<Coord, String> {
        for s in steps {
            v = match (s, v) {
                (Step::Index(n), Value::Array(a)) => a.get(*n as usize).ok_or_else(|| format!("index {n} is past the end"))?,
                (Step::Key(k), Value::Object(_)) => v.get(k).ok_or_else(|| format!("no key \"{k}\""))?,
                _ => return Err("the value tree has no such node".into()),
            };
        }
        Ok(match v.scalar_text() {
            Some(t) => Coord::Leaf(t),
            None => Coord::Node,
        })
    }

    pub fn coord(&self, f: Found, steps: &[Step]) -> Result<Coord, String> {
        match f {
            Found::Heading(_) | Found::Prose => Err("a heading or prose has no inner units".into()),
            Found::Meta => self.meta_coord(steps),
            Found::Block(i) => {
                let s = &self.snaps[i];
                match s.type_name.as_str() {
                    "table" | "view" => match &s.table {
                        None => Ok(Coord::Deferred),
                        Some(t) => table_coord(t, steps),
                    },
                    "data" => match &s.value {
                        None => Ok(Coord::Deferred),
                        Some(v) => self.tree(v, steps),
                    },
                    "meta" => self.meta_coord(steps),
                    "embed" => {
                        Err(format!("an embed holds no units of its own; the coordinate resolves on its source, `{}`", s.attr_text("src").unwrap_or_default()))
                    }
                    "form" | "form-group" => self.form_coord(i, steps),
                    t => Err(format!("a `{t}` block has no inner units")),
                }
            }
        }
    }

    /// GEP-0008: a form's fields are its inner units, named by `name=`; a group
    /// adds structure, not a namespace, so a field inside a group is a field of
    /// the form and of the group alike. The answer is the field, and what a
    /// reference to it says is its label.
    fn form_coord(&self, i: usize, steps: &[Step]) -> Result<Coord, String> {
        let s = &self.snaps[i];
        let name = match steps.first() {
            Some(Step::Key(n) | Step::Word(n)) => n.as_str(),
            Some(Step::Index(_)) => return Err(format!("a `{}`'s fields are addressed by `name=`, as `[\"<name>\"]`, not by position", s.type_name)),
            None => return Err("a coordinate needs a step".into()),
        };
        if !s.flow {
            return Err(format!("this `{}` was not read as a form, so it has no fields to address; is `geml-form/v1` declared?", s.type_name));
        }
        let fields: Vec<&Snap> = self.snaps[i + 1..=i + s.descendants].iter().filter(|f| f.type_name == "form-field").collect();
        fn named(f: &Snap) -> Option<&str> {
            match f.attrs.iter().find(|(k, _)| k == "name") {
                Some((_, Value::String(n))) => Some(n.as_str()),
                _ => None,
            }
        }
        let Some(field) = fields.iter().find(|f| named(f) == Some(name)) else {
            let names: Vec<String> = fields.iter().filter_map(|f| named(f)).map(|n| format!("`{n}`")).collect();
            let have = if names.is_empty() { "it has no named field".to_string() } else { format!("its fields are {}", names.join(", ")) };
            return Err(format!("this `{}` has no field named `{name}`; {have}", s.type_name));
        };
        if steps.len() > 1 {
            return Err("a field carries no units inside it".into());
        }
        Ok(Coord::Field(field.attr_text("label").unwrap_or_else(|| name.to_string())))
    }

    fn meta_coord(&self, steps: &[Step]) -> Result<Coord, String> {
        match steps.first() {
            Some(Step::Key(k)) => match self.meta.iter().find(|(x, _)| x == k) {
                Some((_, v)) => self.tree(v, &steps[1..]),
                None => Err(format!("`meta` defines no key \"{k}\"")),
            },
            _ => Err("`#meta` is read by key".into()),
        }
    }
}

fn row_text(r: &[Cell]) -> String {
    r.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(", ")
}

fn table_coord(t: &Table, steps: &[Step]) -> Result<Coord, String> {
    let col = |name: &str| t.columns.iter().position(|c| c == name).ok_or_else(|| format!("no column \"{name}\""));
    match steps {
        [Step::Index(n)] => match (*n as usize).checked_sub(1).and_then(|i| t.rows.get(i)) {
            Some(r) => Ok(Coord::Row(row_text(r))),
            None => Err(format!("row {n} is past the last row")),
        },
        [Step::Index(n), Step::Key(c)] => {
            let r = (*n as usize).checked_sub(1).and_then(|i| t.rows.get(i)).ok_or_else(|| format!("row {n} is past the last row"))?;
            Ok(Coord::Leaf(r[col(c)?].text.clone()))
        }
        [Step::Word(w)] if w == "summary" => match &t.summary {
            Some(r) => Ok(Coord::Row(row_text(r))),
            None => Err("the block has no summary row".into()),
        },
        [Step::Word(w), Step::Key(c)] if w == "summary" => match &t.summary {
            Some(r) => Ok(Coord::Leaf(r[col(c)?].text.clone())),
            None => Err("the block has no summary row".into()),
        },
        [Step::Key(c)] => {
            col(c)?;
            Ok(Coord::Column)
        }
        _ => Err("a table is addressed by row, cell, column or summary".into()),
    }
}

pub fn is_geml_doc(doc: &str) -> bool {
    doc.to_ascii_lowercase().ends_with(".geml")
}

/// What resolving one reference found.
pub enum Target {
    /// Another document, and no host to read it with.
    NoHost,
    /// Another document the host could not read.
    Unreadable,
    /// Nothing answers the anchor; `cross` when it was in another document.
    Unresolved {
        message: String,
        cross: bool,
    },
    Hit {
        index: Rc<Index>,
        found: Found,
        coord: Option<Coord>,
        cross: bool,
    },
}

/// Documents a parse reads through its host, each parsed once.
pub struct Resolver<'a> {
    pub main: Rc<Index>,
    pub host: Option<&'a dyn Host>,
    /// The name of the document references are resolved from.
    pub name: String,
    cache: RefCell<HashMap<String, Option<Rc<Index>>>>,
    /// The cells the document has read into its relations from elsewhere (§9.2).
    pub budget: Rc<Borrowed>,
}

impl<'a> Resolver<'a> {
    pub fn new(main: Rc<Index>, host: Option<&'a dyn Host>, name: &str) -> Self {
        Resolver { main, host, name: name.to_string(), cache: RefCell::new(HashMap::new()), budget: Rc::default() }
    }

    /// The index of another document, parsed in its own right and without a
    /// host, so its own references are not followed (§9.3).
    pub fn document(&self, doc: &str) -> Result<Rc<Index>, Target> {
        let Some(host) = self.host else { return Err(Target::NoHost) };
        // §3.3: against this document's directory, then against the root.
        let key = crate::host::locate(host, &self.name, doc).or_else(|| crate::host::join(&self.name, doc)).unwrap_or_else(|| doc.to_string());
        if let Some(hit) = self.cache.borrow().get(&key) {
            return hit.clone().ok_or(Target::Unreadable);
        }
        let parsed = crate::host::read_from(host, &self.name, doc).map(|text| {
            let d = crate::parse_with(&text, &crate::Options { name: key.clone(), recognize: true, host: None, checks: false });
            Rc::new(Index::of(&d))
        });
        self.cache.borrow_mut().insert(key, parsed.clone());
        parsed.ok_or(Target::Unreadable)
    }

    /// The index of a document named by its root-relative path.
    pub fn document_at(&self, path: &str) -> Result<Rc<Index>, Target> {
        let depth = self.name.matches('/').count();
        let up = "../".repeat(depth);
        self.document(&format!("{up}{path}"))
    }

    /// Resolve `[doc]#anchor`.
    pub fn target(&self, doc: Option<&str>, anchor: &str) -> Target {
        let (index, cross) = match doc {
            None => (self.main.clone(), false),
            Some(d) => match self.document(d) {
                Ok(i) => (i, true),
                Err(t) => return t,
            },
        };
        let Some((id, steps)) = split_anchor(anchor) else {
            return Target::Unresolved { message: format!("`#{anchor}` is not a block address"), cross };
        };
        match index.find(&id) {
            None => Target::Unresolved { message: format!("`#{anchor}` names an id no block declares"), cross },
            Some(f) if steps.is_empty() => Target::Hit { index, found: f, coord: None, cross },
            Some(f) => match index.coord(f, &steps) {
                Ok(c) => Target::Hit { index, found: f, coord: Some(c), cross },
                Err(m) => Target::Unresolved { message: format!("`#{anchor}` does not resolve: {m}"), cross },
            },
        }
    }

    /// Report what a reference's resolution failed on; `Some` on a hit.
    fn report(&self, t: Target, what: &str, line: usize, diags: &mut Diags) -> Option<(Rc<Index>, Found, Option<Coord>)> {
        match t {
            Target::NoHost => {
                diags.push("unchecked-cross-document-reference", line, format!("{what} is in another document, and no document resolver was given"));
                None
            }
            Target::Unreadable => {
                diags.push("unresolvable-document", line, format!("{what} names a document that could not be read"));
                None
            }
            Target::Unresolved { message, cross } => {
                diags.push(if cross { "unresolved-cross-document-reference" } else { "unresolved-reference" }, line, message);
                None
            }
            Target::Hit { index, found, coord, .. } => Some((index, found, coord)),
        }
    }
}

/// What `finish` is told about the parse.
pub struct Ctx<'a> {
    pub vocab: &'a Vocabulary,
    pub declared: &'a [String],
    pub name: &'a str,
    pub host: Option<&'a dyn Host>,
}

/// The `profile` names the first `meta` definition declares (§4, §8.6).
pub fn declared_profiles(children: &[Item]) -> Vec<String> {
    let mut all = Vec::new();
    walk(children, &mut all);
    for it in all {
        if let Item::Block(b) = it {
            if b.type_name == "meta" {
                if let Some((_, v)) = b.data.iter().find(|(k, _)| k == "profile") {
                    return v.scalar_text().unwrap_or_default().split_whitespace().map(str::to_string).collect();
                }
            }
        }
    }
    Vec::new()
}

/// Run every pass and assemble the document.
pub fn finish(mut children: Vec<Item>, mut diags: Diags, cx: &Ctx) -> Document {
    // §4: the merged meta namespace, the first definition winning.
    let mut meta: Vec<(String, Value)> = Vec::new();
    let mut meta_blocks = 0;
    {
        let mut keys: HashSet<String> = HashSet::new();
        let mut all = Vec::new();
        walk(&children, &mut all);
        for it in all {
            if let Item::Block(b) = it {
                if b.type_name != "meta" {
                    continue;
                }
                meta_blocks += 1;
                for (k, v) in &b.data {
                    if !keys.insert(nfd(k)) {
                        diags.push("duplicate-meta-key", b.line, format!("`{k}` is already defined by an earlier `meta` block; the first definition is kept"));
                    } else {
                        meta.push((k.clone(), v.clone()));
                    }
                }
            }
        }
    }
    // §8.6.2 rule 3: a declared name this processor does not recognize.
    for name in cx.declared {
        if !cx.vocab.has(name) {
            diags.push("unrecognized-vocabulary", 1, format!("`{name}` is a vocabulary this processor does not recognize; it admits nothing"));
        }
    }
    // A key inside a recognized vocabulary's namespace that it does not define.
    for p in &cx.vocab.profiles {
        let Some(keys) = p.meta_keys else { continue };
        let prefix = p.prefix();
        for (k, _) in &meta {
            if k.starts_with(&prefix) && !keys.contains(&k.as_str()) {
                diags.push("unknown-meta-key", 1, format!("`{k}` lies in `{}`'s namespace, and the vocabulary defines no such key", p.name));
            }
        }
    }

    // §4: a heading without a declared id derives one from its text.
    walk_mut(&mut children, &mut |it| {
        if let Item::Heading(h) = it {
            if !h.declared {
                h.id = derive_id(&h.text);
            }
        }
    });

    // §5: inline content, with the merged meta for interpolation.
    walk_mut(&mut children, &mut |it| match it {
        Item::Paragraph(p) => p.inlines = parse_inline(&p.source, &mut InlineCtx::new(&meta, &mut diags, p.line)),
        Item::Heading(h) => h.inlines = parse_inline(&h.text, &mut InlineCtx::new(&meta, &mut diags, h.line)),
        Item::List(l) => list_items_mut(l, &mut |li| li.inlines = parse_inline(&li.source, &mut InlineCtx::new(&meta, &mut diags, li.line))),
        _ => {}
    });

    // §3.2 and §6: data values and table models; an unsafe embed is blanked.
    // §9.2: one budget for every relation the document reads from elsewhere.
    let budget = Rc::new(Borrowed::default());
    blocks_mut(&mut children, &mut |b| match b.type_name.as_str() {
        "data" => b.value = crate::data::read_data(b, &mut diags, cx.host.map(|h| (h, cx.name))),
        "table" => b.table = crate::table::read_table(b, &mut diags, cx.host.map(|h| (h, cx.name)), &budget),
        "embed" => {
            if let Some(src) = b.attr_text("src") {
                if !src.trim().is_empty() && crate::inline::safe_dest(&src, false).is_empty() {
                    diags.push("unsafe-embed-scheme", b.line, "the embed's `src=` names a URL scheme outside the allowlist; it is blanked");
                    for (k, v) in b.attrs.iter_mut() {
                        if k == "src" {
                            *v = Value::String(String::new());
                        }
                    }
                }
            }
        }
        _ => {}
    });

    // Ids: declared and derived, unique under NFD.
    let IdMap { ids, map: idmap, clashes } = id_map(&children);
    for (id, line, _) in clashes {
        diags.push("duplicate-id", line, format!("the id `{id}` is already taken; the first block keeps it"));
    }
    {
        let mut all = Vec::new();
        walk(&children, &mut all);
        for it in all {
            if let Item::Block(b) = it {
                if b.id.as_deref().map(nfd).as_deref() == Some("meta") && meta_blocks > 1 {
                    diags.push("reserved-id", b.line, "`#meta` names the merge of this document's several `meta` blocks; no block may declare it");
                }
            }
        }
    }

    // §6.1: views, evaluated through their sources.
    {
        let snaps = snapshot(&children);
        let pre = Rc::new(Index { snaps: snaps.clone(), heads: heads(&children), ids: idmap.clone(), prose: HashSet::new(), meta: meta.clone(), meta_blocks });
        let mut resolver = Resolver::new(pre, cx.host, cx.name);
        resolver.budget = budget.clone();
        let n = snaps.len();
        let mut v = Views {
            snaps: &snaps,
            resolver: &resolver,
            results: vec![None; n],
            state: vec![0; n],
            depth: vec![0; n],
            cyclic: vec![false; n],
            stack: Vec::new(),
        };
        for (i, s) in snaps.iter().enumerate() {
            if s.type_name == "view" {
                eval_chain(i, &mut v, &mut diags);
            }
        }
        let mut results = v.results;
        let mut bi = 0usize;
        blocks_mut(&mut children, &mut |b| {
            if b.type_name == "view" {
                b.table = results[bi].take();
            }
            bi += 1;
        });
    }

    // §4: addresses.
    let listing = crate::addresses::list(&children, meta_blocks, &|a: &str| idmap.contains_key(&nfd(a)));

    // §5: references.
    let prose = listing.prose.iter().map(|p| nfd(p)).collect();
    let index = Rc::new(Index { snaps: snapshot(&children), heads: heads(&children), ids: idmap, prose, meta: meta.clone(), meta_blocks });
    let mut resolver = Resolver::new(index.clone(), cx.host, cx.name);
    resolver.budget = budget;
    inlines_mut(&mut children, &mut |nodes, line| {
        nodes_mut(nodes, &mut |n| resolve_inline(n, line, &resolver, &mut diags));
    });
    for s in &index.snaps {
        check_block(s, &resolver, &mut diags);
    }
    // §9.3: transclusion chains, across documents through the host.
    crate::transclude::check(cx.name, &children, meta_blocks, cx.host, &mut diags);

    Document {
        children,
        diagnostics: diags.list,
        meta,
        meta_blocks,
        ids,
        addresses: listing.addresses,
        prose: listing.prose,
        name: cx.name.to_string(),
        declared: cx.declared.to_vec(),
        profiles: cx.vocab.profiles.iter().map(|p| p.name.to_string()).collect(),
        profile_diagnostics: Vec::new(),
    }
}

struct Views<'a, 'b> {
    snaps: &'a [Snap],
    resolver: &'a Resolver<'b>,
    results: Vec<Option<Table>>,
    state: Vec<u8>,
    /// How long the chain is that ends at each view (1 for a view over a table).
    depth: Vec<usize>,
    /// Whether a view's chain of sources meets a cycle.
    cyclic: Vec<bool>,
    stack: Vec<usize>,
}

/// What a view's source gives it: a relation — none yet when the renderer
/// reads a remote file — or an error, which leaves the view empty (§6.1).
enum Source {
    Relation(Option<Table>),
    Failed,
    /// Past the document's budget of borrowed cells (§9.2): the source's
    /// columns, no rows, and none of the view's attributes applied.
    Refused(Vec<String>),
}

/// A copy of `t` for the view on `line`, booked against the document's budget
/// before anything is copied (§9.2).
fn borrow_copy(t: Option<&Table>, line: usize, what: &str, budget: &Borrowed, diags: &mut Diags) -> Source {
    match t {
        None => Source::Relation(None),
        Some(t) if budget.take(t.columns.len().saturating_mul(t.rows.len()), line, what, diags) => Source::Relation(Some(t.clone())),
        Some(t) => Source::Refused(t.columns.clone()),
    }
}

/// What starting a view found: its source, or the view it sources from,
/// which has to be evaluated first.
enum Start {
    Ready(Source),
    Wait(usize),
}

/// Evaluate the view `first` and every view it waits on. A view whose source
/// is another view not yet evaluated waits on a stack rather than in a nested
/// call, so a chain of any length costs no call stack; §9.3's bound refuses
/// each view past it, as it is finished.
fn eval_chain(first: usize, v: &mut Views, diags: &mut Diags) {
    if v.state[first] == 2 {
        return;
    }
    let mut waiting: Vec<(usize, usize)> = Vec::new();
    let mut next = Some(first);
    loop {
        if let Some(i) = next.take() {
            match start_view(i, v, diags) {
                Start::Wait(j) => {
                    waiting.push((i, j));
                    next = Some(j);
                }
                Start::Ready(source) => finish_view(i, source, v, diags),
            }
            continue;
        }
        let Some((i, j)) = waiting.pop() else { break };
        let source = through(i, j, v, diags);
        finish_view(i, source, v, diags);
    }
}

/// The relation view `i` takes from the view `j` it sources, already
/// evaluated. A chain that meets a cycle, or runs past `CHAIN_DEPTH`, gives
/// none: each view on it is reported (§9.3).
fn through(i: usize, j: usize, v: &mut Views, diags: &mut Diags) -> Source {
    if v.cyclic[j] {
        v.cyclic[i] = true;
        diags.push("view-source-cycle", v.snaps[i].line, "this view's chain of sources meets a cycle");
        return Source::Failed;
    }
    v.depth[i] = v.depth[j] + 1;
    if v.depth[i] > CHAIN_DEPTH {
        diags.push("view-source-too-deep", v.snaps[i].line, format!("this chain of views is more than {CHAIN_DEPTH} long; it publishes no rows"));
        return Source::Failed;
    }
    borrow_copy(v.results[j].as_ref(), v.snaps[i].line, &format!("the view `{}`", v.snaps[i].id.clone().unwrap_or_default()), &v.resolver.budget, diags)
}

fn start_view(i: usize, v: &mut Views, diags: &mut Diags) -> Start {
    let snaps = v.snaps;
    let s = &snaps[i];
    v.state[i] = 1;
    v.stack.push(i);
    v.depth[i] = 1;
    let fail = |diags: &mut Diags, code: &'static str, message: String| {
        diags.push(code, s.line, message);
        Start::Ready(Source::Failed)
    };
    let mut source: Source = Source::Relation(None);
    let resolver = v.resolver;
    let budget = &resolver.budget;
    match s.attr_text("src") {
        None => return fail(diags, "view-missing-src", "a view carries no `src=`, so it has nothing to derive from".into()),
        Some(src) => {
            if s.has_body && !s.raw_blank {
                diags.push("view-src-and-body", s.line, "a view takes no body; its content is its source's");
            }
            if let Some(local) = src.strip_prefix('#') {
                match v.resolver.main.ids.get(&nfd(local)) {
                    Some(Found::Block(j)) => {
                        let j = *j;
                        match snaps[j].type_name.as_str() {
                            "table" => source = borrow_copy(snaps[j].table.as_ref(), s.line, &format!("`src={src}`"), budget, diags),
                            "view" => match v.state[j] {
                                1 => {
                                    let at = v.stack.iter().position(|x| *x == j).unwrap_or(0);
                                    let names: Vec<String> = v.stack[at..].iter().map(|k| format!("#{}", snaps[*k].id.clone().unwrap_or_default())).collect();
                                    v.cyclic[i] = true;
                                    return fail(diags, "view-source-cycle", format!("these views name each other as their source: {}", names.join(" → ")));
                                }
                                2 => return Start::Ready(through(i, j, v, diags)),
                                _ => return Start::Wait(j),
                            },
                            t => return fail(diags, "view-source-not-a-relation", format!("`src={src}` names a `{t}` block, which publishes no relation")),
                        }
                    }
                    Some(_) => return fail(diags, "view-source-not-a-relation", format!("`src={src}` names no table or view")),
                    None => return fail(diags, "unresolved-reference", format!("`src={src}` names an id no block declares")),
                }
            } else if let Some((doc, anchor)) = src.split_once('#').filter(|(d, _)| is_geml_doc(d)) {
                // A source in another document: its relation as that document
                // publishes it. With no host to read it by, it is unchecked and
                // the view has no relation yet; one that does not resolve is an error.
                let target = v.resolver.target(Some(doc), anchor);
                let unchecked = matches!(target, Target::NoHost);
                match v.resolver.report(target, &format!("`src={src}`"), s.line, diags) {
                    None if unchecked => {}
                    None => return Start::Ready(Source::Failed),
                    Some((index, found, _)) => match index.block(found) {
                        Some(t) if t.type_name == "table" || t.type_name == "view" => {
                            source = borrow_copy(t.table.as_ref(), s.line, &format!("`src={src}`"), budget, diags)
                        }
                        Some(t) => {
                            return fail(
                                diags,
                                "view-source-not-a-relation",
                                format!("`src={src}` names a `{}` block, which publishes no relation", t.type_name),
                            )
                        }
                        None => return fail(diags, "view-source-not-a-relation", format!("`src={src}` names no table or view")),
                    },
                }
            } else {
                // §6.1: a data file is read as a table's is — a local one now,
                // a remote one by the renderer.
                let what = format!("`src={src}`");
                if v.resolver.host.is_some() && budget.spent(s.line, &what, diags) {
                    return Start::Ready(Source::Refused(vec![]));
                }
                source = match crate::table::table_from_file("src", &src, v.resolver.host.map(|h| (h, v.resolver.name.as_str())), s.line, diags) {
                    Some(t) if !budget.take(t.columns.len().saturating_mul(t.rows.len()), s.line, &what, diags) => Source::Refused(t.columns),
                    t => Source::Relation(t),
                };
            }
        }
    }
    Start::Ready(source)
}

/// Derive view `i` from its source's relation, and record it.
fn finish_view(i: usize, source: Source, v: &mut Views, diags: &mut Diags) {
    let s = &v.snaps[i];
    let block = Block {
        type_name: s.type_name.clone(),
        id: s.id.clone(),
        classes: vec![],
        attrs: s.attrs.clone(),
        mode: Mode::Raw,
        raw: vec![],
        children: vec![],
        data: vec![],
        value: None,
        table: None,
        line: s.line,
        body_start: s.line + 1,
        body_end: s.line + 1,
        end: s.line,
    };
    let out = match source {
        Source::Failed => Some(Table { columns: vec![], rows: vec![], summary: None }),
        Source::Refused(columns) => Some(Table { columns, rows: vec![], summary: None }),
        Source::Relation(t) => t.map(|t| crate::view::derive(&block, Table { columns: t.columns, rows: t.rows, summary: None }, diags)),
    };
    v.stack.pop();
    v.state[i] = 2;
    v.results[i] = out;
}

/// Whether a resolved target may stand inside a sentence (§5.2): one paragraph
/// of a `text` block or a prose type, or a coordinate naming one value or a row.
fn inline_ok(index: &Index, found: Found, coord: &Option<Coord>) -> bool {
    match coord {
        None => matches!(index.block(found), Some(s) if (s.type_name == "text" || s.prose) && s.one_paragraph),
        Some(c) => matches!(c, Coord::Leaf(_) | Coord::Row(_) | Coord::Deferred),
    }
}

fn resolve_inline(n: &mut Inline, line: usize, r: &Resolver, diags: &mut Diags) {
    let projecting = matches!(n, Inline::Project { .. });
    match n {
        Inline::AutoRef { doc, anchor, value } | Inline::Project { doc, anchor, value } => {
            if doc.as_deref().is_some_and(|d| !is_geml_doc(d)) {
                return;
            }
            let what = format!("`{}#{anchor}`", doc.clone().unwrap_or_default());
            match r.report(r.target(doc.as_deref(), anchor), &what, line, diags) {
                Some((_, _, Some(Coord::Leaf(t) | Coord::Row(t)))) => *value = Some(t),
                // A field has no inline projection; a reference to it still
                // says its label (GEP-0008).
                Some((_, _, Some(Coord::Field(t)))) if !projecting => *value = Some(t),
                _ => {}
            }
        }
        _ => {}
    }
    // Projections: what may stand inside a sentence (§5.2).
    if let Inline::Project { doc, anchor, .. } = n {
        if doc.as_deref().map_or(true, is_geml_doc) {
            if let Target::Hit { index, found, coord, .. } = r.target(doc.as_deref(), anchor) {
                if !inline_ok(&index, found, &coord) {
                    let what = format!("`![[{}#{anchor}]]`", doc.clone().unwrap_or_default());
                    let why = if matches!(coord, Some(Coord::Field(_))) {
                        format!("{what} names a form field — a control, not content; reference it with `[[…]]`, which says its label")
                    } else {
                        format!("{what} names content that cannot stand inside a sentence; use `=== embed`")
                    };
                    diags.push("inline-transclusion-not-inline", line, why);
                }
            }
        }
    }
    match n {
        Inline::Link { href: None, doc, anchor, .. } => match (doc.as_deref(), anchor.as_deref()) {
            (Some(d), Some(a)) if is_geml_doc(d) => {
                r.report(r.target(Some(d), a), &format!("`{d}#{a}`"), line, diags);
            }
            (Some(d), None) if is_geml_doc(d) => {
                if let Err(t) = r.document(d) {
                    r.report(t, &format!("`{d}`"), line, diags);
                }
            }
            (None, Some(a)) => {
                r.report(r.target(None, a), &format!("`#{a}`"), line, diags);
            }
            _ => {}
        },
        Inline::Footnote(id) if !r.main.ids.contains_key(&nfd(id)) => {
            diags.push("unresolved-footnote", line, format!("`[^{id}]` names an id no block declares"));
        }
        Inline::Image { src, .. } => {
            let path = src.split('#').next().unwrap_or("");
            if is_geml_doc(path) {
                diags.push("media-target-is-document", line, format!("`{src}` is a GEML document; block content is embedded with `=== embed`"));
            }
        }
        _ => {}
    }
}

const CHART_TYPES: &[&str] = &["bar", "line", "area", "pie", "scatter"];

fn check_block(s: &Snap, r: &Resolver, diags: &mut Diags) {
    let line = s.line;
    match s.type_name.as_str() {
        "embed" => {
            if s.has_body && !s.raw_blank {
                diags.push("ignored-embed-body", line, "an embed's content lives in `src=`; its body is ignored");
            }
            if let Some(part) = s.attr_text("part") {
                if !matches!(part.as_str(), "whole" | "head" | "body" | "intro") {
                    diags.push("bad-embed-part", line, format!("`part={part}` is not whole, head, body or intro; the whole target stands"));
                }
            }
            let Some(src) = s.attr_text("src") else {
                diags.push("embed-missing-src", line, "an embed carries no `src=`, so it names no content");
                return;
            };
            let src = src.trim().to_string();
            if src.is_empty() {
                return;
            }
            let (doc, anchor) = match src.split_once('#') {
                Some((d, a)) => (d, Some(a)),
                None => (src.as_str(), None),
            };
            if !doc.is_empty() && !is_geml_doc(doc) {
                diags.push("embed-target-not-geml", line, format!("`src={src}` is not a `.geml` document"));
                return;
            }
            let doc = if doc.is_empty() { None } else { Some(doc) };
            match anchor {
                None => {
                    if let Err(t) = r.document(doc.unwrap_or_default()) {
                        r.report(t, &format!("`src={src}`"), line, diags);
                    }
                }
                Some(a) => match r.report(r.target(doc, a), &format!("`src={src}`"), line, diags) {
                    Some((_, _, Some(Coord::Column | Coord::Node))) => {
                        diags.push("embed-target-not-projectable", line, format!("`src={src}` names many values, not one value or a whole row"));
                    }
                    Some((_, _, Some(Coord::Field(_)))) => {
                        diags.push(
                            "embed-target-not-projectable",
                            line,
                            format!("`src={src}` names a form field — a control, not content; reference it with `[[…]]`"),
                        );
                    }
                    _ => {}
                },
            }
        }
        "data" => {
            if let Some(schema) = s.attr_text("schema") {
                if let Some(local) = schema.strip_prefix('#').filter(|l| crate::uni::is_name(l)) {
                    if r.main.find(local).is_none() {
                        diags.push("unresolved-reference", line, format!("`schema={schema}` names an id no block declares"));
                    }
                } else if let Some((d, a)) = schema.split_once('#').filter(|(d, _)| is_geml_doc(d)) {
                    r.report(r.target(Some(d), a), &format!("`schema={schema}`"), line, diags);
                } else if is_geml_doc(&schema) {
                    if let Err(t) = r.document(&schema) {
                        r.report(t, &format!("`schema={schema}`"), line, diags);
                    }
                }
            }
        }
        "code" => {
            if let Some(src) = s.attr_text("src") {
                let body = s.has_body && !s.raw_blank;
                if body {
                    diags.push("code-src-and-body", line, "a code block carries both `src=` and an inline body; the body is kept");
                }
                check_code_route(&src, !body, r, line, diags);
            }
        }
        "diagram" => check_diagram(s, r, diags),
        _ => {}
    }
}

/// A `code` route (§3.3): a refused scheme is an error, a malformed or drifted
/// range is an error, and a file that cannot be read is a warning — the block
/// still names a region of code. A route is fetched only when it stands alone.
fn check_code_route(src: &str, fetch: bool, r: &Resolver, line: usize, diags: &mut Diags) {
    let remote = match scheme_of(src) {
        Some(sch) if sch == "http" || sch == "https" => true,
        Some(_) => {
            diags.push("bad-code-source", line, format!("`src={src}` names a URL scheme a code source may not use"));
            return;
        }
        None => false,
    };
    let route = match crate::route::parse(src) {
        Ok(rt) => rt,
        Err(f) => {
            diags.push("bad-source-range", line, format!("`#{f}` is not `#L<start>[-<end>]` naming a non-empty range"));
            return;
        }
    };
    let (Some(host), false, true) = (r.host, remote, fetch) else { return };
    match crate::route::read(host, &r.name, &route.path) {
        None => diags.push("unresolvable-code-source", line, format!("`src={src}` could not be read, so it was not checked")),
        Some(text) => {
            if let Err(n) = crate::route::window(&text, route.range) {
                diags.push("bad-source-range", line, format!("`src={src}` names lines `{}` no longer has: it has {n}", route.path));
            }
        }
    }
}

fn records_table(recs: &[Value]) -> Table {
    let mut cols: Vec<String> = Vec::new();
    for r in recs {
        if let Value::Object(m) = r {
            for (k, _) in m {
                if !cols.contains(k) {
                    cols.push(k.clone());
                }
            }
        }
    }
    let rows = recs.iter().map(|r| cols.iter().map(|c| Cell::text(r.get(c).and_then(|v| v.scalar_text()).unwrap_or_default())).collect()).collect();
    Table { columns: cols, rows, summary: None }
}

fn check_diagram(s: &Snap, r: &Resolver, diags: &mut Diags) {
    let line = s.line;
    let format = s.attr_text("format").unwrap_or_default();
    if !crate::registry::DIAGRAM_FORMATS.contains(&format.as_str()) {
        diags.push("unknown-diagram-format", line, format!("no renderer is registered for `format={format}`; the body is kept"));
        return;
    }
    if (format == "geml-chart" || format == "geml-code-graph") && s.has_body && !s.raw_blank {
        diags.push("ignored-diagram-body", line, "this diagram is configured by its attributes; the body is ignored");
    }
    if format == "geml-code-graph" {
        match s.attr_text("src") {
            None => diags.push("code-graph-missing-src", line, "a `geml-code-graph` declares no `src=`"),
            Some(src) => {
                if r.host.is_some() && r.document(&src).is_err() {
                    diags.push("code-graph-unresolvable-document", line, format!("`src={src}` could not be read"));
                }
            }
        }
        return;
    }
    if format != "geml-chart" {
        return;
    }
    let ty = s.attr_text("type");
    match &ty {
        None => diags.push("chart-missing-type", line, "a `geml-chart` declares no `type`"),
        Some(t) if !CHART_TYPES.contains(&t.as_str()) => diags.push("chart-unknown-type", line, format!("`type={t}` is not bar, line, area, pie or scatter")),
        _ => {}
    }
    let rows = s.attr_text("rows").unwrap_or_else(|| "data".into());
    if !matches!(rows.as_str(), "data" | "all" | "summary") {
        diags.push("chart-unknown-rows-scope", line, format!("`rows={rows}` is not data, all or summary"));
    }
    for ch in ["x", "y"] {
        if s.attr_text(ch).is_none() {
            diags.push("chart-missing-channel", line, format!("the required channel `{ch}` is absent"));
        }
    }
    let ys: Vec<String> = s.attr_text("y").map(|y| y.split(',').map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect()).unwrap_or_default();
    if s.attr_text("y").is_some() && ys.is_empty() {
        diags.push("chart-empty-channel", line, "the `y` channel lists no columns");
    }
    if s.attr_text("size").is_some() && ty.as_deref() != Some("scatter") {
        diags.push("chart-unused-channel", line, "`size` is drawn by a scatter chart only; it is ignored");
    }
    let Some(data) = s.attr_text("data") else {
        diags.push("chart-missing-data", line, "a `geml-chart` declares no `data=`");
        return;
    };
    let named: Vec<String> = ["x", "series", "size"].iter().filter_map(|c| s.attr_text(c)).chain(ys.iter().cloned()).collect();
    let (doc, anchor) = match data.split_once('#') {
        Some((d, a)) if d.is_empty() || is_geml_doc(d) => (if d.is_empty() { None } else { Some(d) }, a),
        _ => {
            let Some(t) = chart_file(&data, &named, r, line, diags) else { return };
            check_columns(&t, &named, &ys, &rows, line, diags);
            return;
        }
    };
    let Some((index, found, _)) = r.report(r.target(doc, anchor), &format!("`data={data}`"), line, diags) else { return };
    let table = match index.block(found) {
        None => {
            diags.push("chart-data-not-a-table", line, format!("`data={data}` names no table or data block"));
            return;
        }
        Some(t) => match t.type_name.as_str() {
            "table" | "view" => t.table.clone(),
            "data" => match records(t.value.as_ref(), &named, &format!("`data={data}`"), line, diags) {
                Ok(t) => t,
                Err(()) => return,
            },
            t => {
                diags.push("chart-data-not-a-table", line, format!("`data={data}` names a `{t}` block, which is neither a table nor a data block"));
                return;
            }
        },
    };
    let Some(t) = table else { return };
    check_columns(&t, &named, &ys, &rows, line, diags);
}

/// A record array as a chart reads it (§7.1): `Ok(None)` when the value
/// arrives at render time, `Err` once a violation is reported.
fn records(value: Option<&Value>, named: &[String], what: &str, line: usize, diags: &mut Diags) -> Result<Option<Table>, ()> {
    match value {
        Some(Value::Array(recs)) if !recs.is_empty() && recs.iter().all(|r| matches!(r, Value::Object(_))) => {
            for (n, rec) in recs.iter().enumerate() {
                for c in named {
                    if !matches!(rec.get(c), Some(v) if v.scalar_text().is_some()) {
                        diags.push("chart-data-not-records", line, format!("record {} lacks a scalar `{c}`", n + 1));
                        return Err(());
                    }
                }
            }
            Ok(Some(records_table(recs)))
        }
        None => Ok(None),
        _ => {
            diags.push("chart-data-not-records", line, format!("{what} is not a non-empty array of records"));
            Err(())
        }
    }
}

/// A chart's `data=` file (§7.1): a `.csv`/`.tsv` file standing for a table —
/// a local one read at build time as a table's `src=` is (§6), a remote one
/// by the renderer; or a local `.json`/`.jsonl` record source, read here
/// through the host. The table a local source gives, when there is one.
fn chart_file(data: &str, named: &[String], r: &Resolver, line: usize, diags: &mut Diags) -> Option<Table> {
    let lower = data.to_ascii_lowercase();
    let records_file = lower.ends_with(".json") || lower.ends_with(".jsonl");
    if !records_file {
        // Any other file stands for a table and is read as a table's `src=` is
        // (§7.1): `tsv` by suffix, `csv` otherwise — a local one now, a remote
        // one by the renderer, the rest `unresolvable-table-source`.
        let what = format!("`data={data}`");
        if r.host.is_some() && r.budget.spent(line, &what, diags) {
            return None;
        }
        return crate::table::table_from_file("data", data, r.host.map(|h| (h, r.name.as_str())), line, diags).map(|t| r.budget.book(t, line, &what, diags));
    }
    match scheme_of(data) {
        Some(sch) if sch == "http" || sch == "https" => {
            diags.push(
                "bad-data-source",
                line,
                format!("`data={data}` is a remote record file; a remote record source is read through a `data` block, which defers"),
            );
            None
        }
        Some(_) => {
            diags.push("unresolvable-data-source", line, format!("`data={data}` names a URL scheme a chart source may not use"));
            None
        }
        None => {
            let host = r.host?;
            let Some(text) = crate::host::read_from(host, &r.name, data) else {
                diags.push("unresolvable-data-source", line, format!("`data={data}` could not be read"));
                return None;
            };
            let format = if lower.ends_with(".jsonl") { "jsonl" } else { "json" };
            match crate::data::engine(format, &text) {
                Ok(v) => records(Some(&v), named, &format!("`data={data}`"), line, diags).ok().flatten(),
                Err(crate::data::Fail::Parse(l, m)) => {
                    diags.push("data-parse", line, format!("`{data}` does not parse at line {}: {m}", l + 1));
                    None
                }
                Err(_) => None,
            }
        }
    }
}

/// The columns a chart names, the rows it asks for, and the values its `y`
/// channel draws.
fn check_columns(t: &Table, named: &[String], ys: &[String], rows: &str, line: usize, diags: &mut Diags) {
    for c in named {
        if !t.columns.contains(c) {
            diags.push("chart-unknown-column", line, format!("the chart names `{c}`, and the table has no such column"));
        }
    }
    match rows {
        "summary" if t.summary.is_none() => diags.push("chart-missing-summary-row", line, "`rows=summary` was asked for and the table has no summary row"),
        "all" if t.summary.is_none() => {
            diags.push("chart-summary-row-unavailable", line, "`rows=all` was asked for and the table has no summary row; the data rows are charted alone")
        }
        _ => {}
    }
    for y in ys {
        if let Some(i) = t.columns.iter().position(|c| c == y) {
            if let Some(row) = t.rows.iter().position(|row| !row[i].text.is_empty() && row[i].num.is_none()) {
                diags.push("chart-non-numeric-value", line, format!("row {} of `{y}` is not a number", row + 1));
            }
        }
    }
}
