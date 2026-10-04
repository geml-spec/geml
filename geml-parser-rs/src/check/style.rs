//! `geml-style/v1` (its profile, §1–§10): a stylesheet's rules solved against
//! a corpus into the view model a host consumes, with the profile's
//! diagnostics. `check` is `geml style check <sheet> <corpus…>`;
//! `check_sheet_alone` runs the checks that need no corpus, as `geml check`
//! does on a stylesheet.
//!
//! Profile §3 and §10: a part name in a selector's first step is read as a
//! block type and reported `style-reserved-name`; a corpus node without an
//! address is named `[n]`, its position among the nodes a selector can match.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use super::Out;
use crate::bounds::{CHAIN_DEPTH, EMBED_TOTAL};
use crate::host::Host;
use crate::json::{quote, to_json, Value};
use crate::model::{Document, Item, Mode};
use crate::vocab::Level::{self, Error as E, Warning as W};
use crate::vocab::ProfileDiagnostic;

const CONTROL_STATES: &[&str] = &["hover", "focus", "invalid", "disabled", "checked"];
const PARTS: &[&str] = &["link", "image", "code-span", "strong", "emphasis"];
const INTERACTIONS: &[&str] = &["select", "toggle"];

/// The built-in words (§2.1): consumed by the profile, landing in `box`.
const BUILTIN: &[&str] = &[
    "width",
    "max-width",
    "min-width",
    "padding",
    "margin",
    "height",
    "max-height",
    "min-height",
    "sticky",
    "scroll",
    "hide-below",
    "font-size",
    "line-height",
    "font-family",
    "font-weight",
    "color",
    "background",
    "border",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
    "border-radius",
    "text-align",
    "gap",
    "item-align",
    "item-justify",
    "wrap",
    "axis",
    "anchor",
    "place",
    "visible",
    "grow",
    "fade-out",
    "fade-in",
    "underline",
    "view",
    "editable",
];

/// The words that mean something on a run of text (§2.1, *Inline parts*).
const PART_WORDS: &[&str] = &[
    "color",
    "background",
    "padding",
    "margin",
    "border",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
    "border-radius",
    "font-size",
    "line-height",
    "font-family",
    "width",
    "max-width",
    "visible",
    "underline",
];

const BORDER_SIDES: &[&str] = &["border-top", "border-right", "border-bottom", "border-left"];

/// A closed domain's check: `Some(domain)` when the value is outside it.
fn invalid(word: &str, v: &Value) -> Option<&'static str> {
    let t = v.scalar_text().unwrap_or_default();
    let one_of = |set: &[&str], d: &'static str| if set.contains(&t.as_str()) { None } else { Some(d) };
    match word {
        "axis" => one_of(&["row", "column"], "row | column"),
        "anchor" => one_of(&["flow", "parent", "viewport"], "flow | parent | viewport"),
        "place" => one_of(&["center", "top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"], "a place"),
        "scroll" => one_of(&["own", "page"], "own | page"),
        "sticky" => one_of(&["top", "right", "bottom", "left"], "top | right | bottom | left"),
        "visible" | "grow" | "wrap" | "editable" | "underline" => one_of(&["yes", "no"], "yes | no"),
        "view" => one_of(&["rendered", "source"], "rendered | source"),
        "hide-below" => match v {
            Value::Number(_) => None,
            _ => crate::num::parse_bare_number(&t).map_or(Some("a number"), |_| None),
        },
        "fade-out" => match crate::num::parse_bare_number(&t) {
            Some(n) if (0.0..=60.0).contains(&n) => None,
            _ => Some("a number of seconds, 0–60"),
        },
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Selectors (§3)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Simple {
    pub any: bool,
    pub ty: Option<String>,
    pub id: Option<String>,
    pub classes: Vec<String>,
    pub attrs: Vec<(String, Option<String>)>,
}

impl Simple {
    /// The conditions this step contributes to §4's arbitration.
    fn conditions(&self, prefix: &str, out: &mut Vec<String>) {
        if let Some(t) = &self.ty {
            out.push(format!("{prefix}t:{t}"));
        }
        if let Some(i) = &self.id {
            out.push(format!("{prefix}#{i}"));
        }
        for c in &self.classes {
            out.push(format!("{prefix}.{c}"));
        }
        for (k, v) in &self.attrs {
            out.push(match v {
                Some(v) => format!("{prefix}[{k}={v}]"),
                None => format!("{prefix}[{k}]"),
            });
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Branch {
    pub steps: Vec<Simple>,
    pub part: Option<String>,
}

/// Split on `sep` outside brackets and quotes.
fn split_outside(s: &str, sep: fn(char) -> bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    for c in s.chars() {
        if let Some(q) = quote {
            cur.push(c);
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => {
                quote = Some(c);
                cur.push(c);
            }
            '[' => {
                depth += 1;
                cur.push(c);
            }
            ']' => {
                depth -= 1;
                cur.push(c);
            }
            c if depth == 0 && sep(c) => out.push(std::mem::take(&mut cur)),
            c => cur.push(c),
        }
    }
    out.push(cur);
    out.into_iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

/// The zoned scan (§3): pseudo-classes and combinators looked for outside
/// brackets only, substring operators inside them only.
fn unsupported(s: &str) -> Option<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut depth = 0;
    let mut quote: Option<char> = None;
    for (i, &c) in chars.iter().enumerate() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '[' => depth += 1,
            ']' => depth -= 1,
            '>' | '+' | '~' if depth == 0 => return Some(format!("the `{c}` combinator")),
            ':' if depth == 0 => return Some("a pseudo-class".into()),
            '^' | '$' | '*' | '|' if depth > 0 && chars.get(i + 1) == Some(&'=') => return Some(format!("the `{c}=` substring match")),
            _ => {}
        }
    }
    None
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '-' || c == '_'
}

fn parse_simple(step: &str) -> Result<Simple, String> {
    if step == "*" {
        return Ok(Simple { any: true, ..Default::default() });
    }
    let chars: Vec<char> = step.chars().collect();
    let mut s = Simple::default();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let word = |i: usize| {
            let mut j = i;
            while j < chars.len() && is_word(chars[j]) {
                j += 1;
            }
            j
        };
        match c {
            '*' => return Err(format!("`*` inside `{step}`: the universal selector is a whole step only")),
            '#' | '.' => {
                let j = word(i + 1);
                if j == i + 1 {
                    return Err(format!("`{step}` has an empty `{c}`"));
                }
                let name: String = chars[i + 1..j].iter().collect();
                if c == '#' {
                    s.id = Some(name);
                } else {
                    s.classes.push(name);
                }
                i = j;
            }
            '[' => {
                let close = chars[i..].iter().position(|x| *x == ']').map(|p| i + p).ok_or_else(|| format!("`{step}` has an unclosed `[`"))?;
                let inner: String = chars[i + 1..close].iter().collect();
                match inner.split_once('=') {
                    Some((k, v)) => {
                        let v = v.trim();
                        let v = v
                            .strip_prefix('"')
                            .and_then(|x| x.strip_suffix('"'))
                            .or_else(|| v.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')))
                            .unwrap_or(v);
                        s.attrs.push((k.trim().to_string(), Some(v.to_string())));
                    }
                    None => s.attrs.push((inner.trim().to_string(), None)),
                }
                i = close + 1;
            }
            c if is_word(c) && i == 0 => {
                let j = word(i);
                s.ty = Some(chars[i..j].iter().collect());
                i = j;
            }
            _ => return Err(format!("`{step}` is not a simple selector")),
        }
    }
    Ok(s)
}

/// The part names a selector uses as a FIRST step (profile §3): each is read
/// as a block type, and the author is told what an inline part would need.
pub fn reserved_first_steps(s: &str) -> Vec<String> {
    split_outside(s, |c| c == ',')
        .into_iter()
        .filter_map(|b| split_outside(&b, char::is_whitespace).into_iter().next())
        .filter(|st| PARTS.contains(&st.as_str()))
        .collect()
}

/// Parse a `match=` (or a slot): its branches, or the construct it refuses.
pub fn parse_selector(s: &str) -> Result<Vec<Branch>, String> {
    if let Some(u) = unsupported(s) {
        return Err(u);
    }
    let mut branches = Vec::new();
    for b in split_outside(s, |c| c == ',') {
        let steps: Vec<String> = split_outside(&b, char::is_whitespace);
        let mut simple = Vec::new();
        let mut part = None;
        for (k, st) in steps.iter().enumerate() {
            let last = k + 1 == steps.len();
            if PARTS.contains(&st.as_str()) {
                // Profile §3: in the first step the name can only be a block
                // type (a part needs a block step before it); `reserved_first_steps`
                // says so with `style-reserved-name`.
                if simple.is_empty() {
                    simple.push(Simple { ty: Some(st.clone()), ..Default::default() });
                    continue;
                }
                if !last {
                    return Err(format!("the inline part `{st}` is not the last step"));
                }
                part = Some(st.clone());
                continue;
            }
            if let Some(p) = PARTS.iter().find(|p| st.starts_with(**p) && st[p.len()..].starts_with(['#', '.', '['])) {
                return Err(format!("the inline part `{p}` takes no filter"));
            }
            simple.push(parse_simple(st)?);
        }
        if simple.is_empty() {
            return Err("an empty selector".into());
        }
        branches.push(Branch { steps: simple, part });
    }
    if branches.is_empty() {
        return Err("an empty selector".into());
    }
    let parts = branches.iter().filter(|b| b.part.is_some()).count();
    if parts > 0 && parts < branches.len() {
        return Err("a selector mixes inline-part branches with block branches".into());
    }
    Ok(branches)
}

// ---------------------------------------------------------------------------
// The corpus as selectable nodes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Node {
    doc: String,
    address: String,
    ty: String,
    id: Option<String>,
    classes: Vec<String>,
    attrs: Vec<(String, String)>,
    /// Indices of the enclosing containers and sections, nearest first.
    ancestors: Vec<usize>,
    columns: Option<Vec<String>>,
    /// The inline parts it holds (§3): a part step matches only these.
    parts: Vec<&'static str>,
}

/// The part kinds a run of inlines holds, nested inlines included.
fn inline_parts(xs: &[crate::model::Inline], out: &mut Vec<&'static str>) {
    use crate::model::Inline as I;
    for x in xs {
        let (kind, kids): (Option<&'static str>, &[I]) = match x {
            I::Link { children, .. } => (Some("link"), children),
            I::Image { .. } => (Some("image"), &[]),
            I::Code(_) => (Some("code-span"), &[]),
            I::Strong(c) => (Some("strong"), c),
            I::Emph(c) => (Some("emphasis"), c),
            I::Strike(c) => (None, c),
            _ => (None, &[]),
        };
        if let Some(k) = kind {
            if !out.contains(&k) {
                out.push(k);
            }
        }
        inline_parts(kids, out);
    }
}

fn list_parts(l: &crate::model::List, out: &mut Vec<&'static str>) {
    for it in &l.items {
        inline_parts(&it.inlines, out);
        for c in &it.children {
            list_parts(c, out);
        }
    }
}

/// What an item holds: its own text, its lists, and the bodies of the flow
/// blocks nested in it.
fn item_parts(it: &Item, out: &mut Vec<&'static str>) {
    match it {
        Item::Paragraph(p) => inline_parts(&p.inlines, out),
        Item::Heading(h) => inline_parts(&h.inlines, out),
        Item::List(l) => list_parts(l, out),
        Item::Block(b) if b.mode == Mode::Flow => b.children.iter().for_each(|c| item_parts(c, out)),
        _ => {}
    }
}

fn parts_of(items: &[Item]) -> Vec<&'static str> {
    let mut out = Vec::new();
    items.iter().for_each(|it| item_parts(it, &mut out));
    out
}

fn nodes_of(doc: &Document) -> Vec<Node> {
    let mut nodes = Vec::new();
    level(doc, &doc.children, &[], None, false, &mut nodes);
    nodes
}

/// One corpus document's nodes appended to `out`, its ancestors renumbered.
fn append_nodes(doc: &Document, out: &mut Vec<Node>) {
    let base = out.len();
    for mut n in nodes_of(doc) {
        n.ancestors = n.ancestors.iter().map(|a| a + base).collect();
        out.push(n);
    }
}

/// The paths of the GEML documents a document's `embed`s name, in document
/// order, nested ones included.
fn embedded_docs(items: &[Item], out: &mut Vec<String>) {
    for it in items {
        let Item::Block(b) = it else { continue };
        if b.type_name == "embed" {
            let src = b.attr_text("src").unwrap_or_default();
            let path = src.split_once('#').map_or(src.as_str(), |(p, _)| p);
            if !path.is_empty() && crate::resolve::is_geml_doc(path) {
                out.push(path.to_string());
            }
        }
        embedded_docs(&b.children, out);
    }
}

/// §3: the corpus is the documents given, in order, followed by each GEML
/// document an `embed` in the corpus names — whole, whatever the `embed`
/// selects — each once, in the order the `embed`s are met reading the corpus
/// in order. What the host cannot read joins nothing.
fn corpus_docs(corpus: &[&Document], host: Option<&dyn Host>) -> Vec<Document> {
    let Some(host) = host else { return Vec::new() };
    let mut names: Vec<String> = corpus.iter().map(|d| d.name.clone()).collect();
    let mut extra: Vec<Document> = Vec::new();
    let mut i = 0;
    while i < corpus.len() + extra.len() {
        let doc: &Document = if i < corpus.len() { corpus[i] } else { &extra[i - corpus.len()] };
        let from = doc.name.clone();
        let mut paths = Vec::new();
        embedded_docs(&doc.children, &mut paths);
        for p in paths {
            let (Some(name), Some(text)) = (crate::host::locate(host, &from, &p), crate::host::read_from(host, &from, &p)) else { continue };
            if names.contains(&name) {
                continue;
            }
            names.push(name.clone());
            extra.push(crate::parse_with(&text, &crate::Options { name, recognize: true, host: None, checks: false }));
        }
        i += 1;
    }
    extra
}

fn block_id(doc: &Document, b: &crate::model::Block) -> Option<String> {
    b.id.clone().or_else(|| if b.type_name == "meta" && doc.meta_blocks == 1 { Some("meta".into()) } else { None })
}

/// One container's content: blocks, headings with their sections, and the
/// prose between them, each a node whose ancestors are `outer`. Prose inside
/// a typed block's body (`inside`) is that block's content, not a node.
fn level(doc: &Document, items: &[Item], outer: &[usize], container: Option<&str>, inside: bool, nodes: &mut Vec<Node>) {
    let mut j = 0;
    let mut prev_anchor: Option<Option<String>> = None;
    while j < items.len() {
        match &items[j] {
            Item::Heading(h) => {
                let end = (j + 1..items.len()).find(|k| matches!(&items[*k], Item::Heading(o) if o.level <= h.level)).unwrap_or(items.len());
                nodes.push(Node {
                    doc: doc.name.clone(),
                    address: format!("#{}", h.id),
                    ty: "heading".into(),
                    id: Some(h.id.clone()),
                    classes: h.classes.clone(),
                    // The level is the line's structure (§3), so an author's
                    // `level=` does not override it.
                    attrs: h
                        .attrs
                        .iter()
                        .filter(|(k, _)| k != "level")
                        .map(|(k, v)| (k.clone(), v.scalar_text().unwrap_or_default()))
                        .chain(std::iter::once(("level".to_string(), h.level.to_string())))
                        .collect(),
                    ancestors: outer.to_vec(),
                    columns: None,
                    parts: parts_of(std::slice::from_ref(&items[j])),
                });
                let me = nodes.len() - 1;
                let mut inner = vec![me];
                inner.extend_from_slice(outer);
                level(doc, &items[j + 1..end], &inner, Some(&h.id), inside, nodes);
                prev_anchor = Some(Some(h.id.clone()));
                j = end;
                continue;
            }
            Item::Block(b) => {
                let id = block_id(doc, b);
                nodes.push(Node {
                    doc: doc.name.clone(),
                    address: id.as_ref().map(|i| format!("#{i}")).unwrap_or_else(|| format!("[{}]", nodes.len())),
                    ty: b.type_name.clone(),
                    id: id.clone(),
                    classes: b.classes.clone(),
                    attrs: b.attrs.iter().map(|(k, v)| (k.clone(), v.scalar_text().unwrap_or_default())).collect(),
                    ancestors: outer.to_vec(),
                    columns: b.table.as_ref().map(|t| t.columns.clone()),
                    parts: parts_of(std::slice::from_ref(&items[j])),
                });
                if b.mode == Mode::Flow {
                    let me = nodes.len() - 1;
                    let mut inner = vec![me];
                    inner.extend_from_slice(outer);
                    level(doc, &b.children, &inner, b.id.as_deref(), true, nodes);
                }
                prev_anchor = Some(id);
                j += 1;
                continue;
            }
            Item::Hidden(_) => {
                j += 1;
                continue;
            }
            _ => {}
        }
        // A stretch of prose: until the next block or heading.
        let start = j;
        while j < items.len() && !matches!(items[j], Item::Heading(_) | Item::Block(_)) {
            j += 1;
        }
        if inside {
            continue;
        }
        let next: Option<Option<String>> = match items.get(j) {
            Some(Item::Heading(h)) => Some(Some(h.id.clone())),
            Some(Item::Block(b)) => Some(block_id(doc, b)),
            _ => None,
        };
        let addr = match (&prev_anchor, &next) {
            (Some(Some(p)), Some(Some(n))) => Some(format!("{p}-between-{n}")),
            (None, Some(Some(n))) => container.map(|c| format!("{c}-before-{n}")),
            (Some(Some(p)), None) => container.map(|c| format!("{c}-after-{p}")),
            _ => None,
        }
        // A declared id shadows the derived address (§4 rule 2).
        .filter(|a| doc.prose.contains(a));
        nodes.push(Node {
            doc: doc.name.clone(),
            address: addr.as_ref().map(|a| format!("#{a}")).unwrap_or_else(|| format!("[{}]", nodes.len())),
            ty: "prose".into(),
            id: addr,
            classes: vec![],
            attrs: vec![],
            ancestors: outer.to_vec(),
            columns: None,
            parts: parts_of(&items[start..j]),
        });
    }
}

fn step_matches(s: &Simple, n: &Node) -> bool {
    if s.any {
        return true;
    }
    s.ty.as_ref().map_or(true, |t| *t == n.ty)
        && s.id.as_ref().map_or(true, |i| n.id.as_deref() == Some(i.as_str()))
        && s.classes.iter().all(|c| n.classes.contains(c))
        && s.attrs.iter().all(|(k, v)| n.attrs.iter().any(|(nk, nv)| nk == k && v.as_ref().map_or(true, |v| v == nv)))
}

fn branch_matches(b: &Branch, nodes: &[Node], i: usize) -> bool {
    let n = &nodes[i];
    let (last, before) = b.steps.split_last().expect("a step");
    if !step_matches(last, n) {
        return false;
    }
    let mut want = before.iter().rev();
    let mut cur = want.next();
    for a in &n.ancestors {
        match cur {
            None => break,
            Some(s) if step_matches(s, &nodes[*a]) => cur = want.next(),
            _ => {}
        }
    }
    cur.is_none()
}

fn conditions(b: &Branch) -> Vec<String> {
    let mut c = Vec::new();
    let (last, before) = b.steps.split_last().expect("a step");
    last.conditions("", &mut c);
    for s in before {
        s.conditions("^", &mut c);
    }
    c
}

// ---------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct StyleBlock {
    ty: String,
    id: Option<String>,
    attrs: Vec<(String, Value)>,
    layer: u8,
    order: usize,
    /// Its position among the `style-rule` blocks as loaded, from 0.
    rule_no: usize,
    doc: String,
}

impl StyleBlock {
    fn get(&self, k: &str) -> Option<&Value> {
        self.attrs.iter().find(|(x, _)| x == k).map(|(_, v)| v)
    }

    fn text(&self, k: &str) -> Option<String> {
        self.get(k).and_then(|v| v.scalar_text())
    }

    fn label(&self) -> String {
        self.id.as_ref().map(|i| format!("#{i}")).unwrap_or_else(|| format!("[{}]", self.rule_no))
    }
}

/// What an `embed` takes in, by the document, the anchor and the part.
type Pick = (String, Option<String>, Option<String>);

struct Loader<'a> {
    host: Option<&'a dyn Host>,
    out: Vec<ProfileDiagnostic>,
    order: usize,
    rules: usize,
    /// Expansions so far, against `EMBED_TOTAL`, and whether its running
    /// out has been said.
    spent: usize,
    told: bool,
    /// Each document an `embed` names, parsed once; the stretches of prose
    /// each document's addresses name; and what each pick takes in.
    parsed: HashMap<String, Rc<Document>>,
    prose: HashMap<String, crate::transclude::Prose>,
    picks: HashMap<Pick, Option<Rc<Vec<Item>>>>,
}

impl Loader<'_> {
    fn diag(&mut self, code: &'static str, level: Level, at: String, msg: String) {
        self.out.push(ProfileDiagnostic { code, level, address: at, message: msg });
    }

    /// `{{key}}` in an attribute (§1.2): one pass, per file; a value that is
    /// exactly one token keeps the token's type.
    fn tokens(&mut self, v: &Value, meta: &[(String, Value)], at: &str) -> Value {
        let Value::String(s) = v else { return v.clone() };
        let chars: Vec<char> = s.chars().collect();
        let mut out = String::new();
        let mut i = 0;
        let mut only: Option<Value> = None;
        let mut pieces = 0;
        while i < chars.len() {
            if chars[i] == '{' && chars.get(i + 1) == Some(&'{') {
                if let Some(close) = (i + 2..chars.len().saturating_sub(1)).find(|k| chars[*k] == '}' && chars[*k + 1] == '}') {
                    let key: String = chars[i + 2..close].iter().collect::<String>().trim().to_string();
                    match meta.iter().find(|(k, _)| *k == key) {
                        Some((_, val)) => {
                            out.push_str(&val.scalar_text().unwrap_or_default());
                            only = Some(val.clone());
                        }
                        None => {
                            self.diag("style-unknown-token", E, at.to_string(), format!("`{{{{{key}}}}}` names no key of this stylesheet's `meta`"));
                            out.extend(&chars[i..close + 2]);
                        }
                    }
                    pieces += 1;
                    i = close + 2;
                    continue;
                }
            }
            out.push(chars[i]);
            pieces += 2;
            i += 1;
        }
        match only {
            Some(v) if pieces == 1 => v,
            _ => Value::String(out),
        }
    }

    /// A stylesheet file's style blocks in document order, wherever they stand
    /// — inside another block's body included — and its `embed`s expanded
    /// where they stand, into the same layer (§1.1).
    fn items(&mut self, file: &Document, items: &[Item], layer: u8, chain: &mut Vec<String>, blocks: &mut Vec<StyleBlock>) {
        for it in items {
            let Item::Block(b) = it else { continue };
            if b.type_name.starts_with("style-") {
                let at = format!("{}{}", file.name, b.id.as_ref().map(|i| format!("#{i}")).unwrap_or_default());
                let attrs = b.attrs.iter().map(|(k, v)| (k.clone(), self.tokens(v, &file.meta, &at))).collect();
                let rule_no = self.rules;
                if b.type_name == "style-rule" {
                    self.rules += 1;
                }
                blocks.push(StyleBlock { ty: b.type_name.clone(), id: b.id.clone(), attrs, layer, order: self.order, rule_no, doc: file.name.clone() });
                self.order += 1;
            } else if b.type_name == "embed" {
                let src = b.attr_text("src").unwrap_or_default();
                self.embed(file, &src, b.attr_text("part").as_deref(), layer, chain, blocks);
            } else {
                self.items(file, &b.children, layer, chain, blocks);
            }
        }
    }

    /// One `embed` of a stylesheet file — written, or §1.1's implicit
    /// `default-style` — expanded into the same layer. It selects what the
    /// core's `embed` selects (GEML §9.3); a bare `#id` names a target in
    /// `from` itself. A whole file brings its own `default-style` first, and
    /// never its `#sitemap`. A cycle is a file already on the chain, or a
    /// target of one file already being expanded.
    fn embed(&mut self, from: &Document, src: &str, part: Option<&str>, layer: u8, chain: &mut Vec<String>, blocks: &mut Vec<StyleBlock>) {
        let at = format!("{} (embed {src})", from.name);
        let say = |me: &mut Self, why: String| me.diag("style-embed-not-expanded", W, at.clone(), format!("`embed` of `{src}` contributed no rules: {why}"));
        if src.is_empty() {
            return say(self, "no `src=`".into());
        }
        if chain.len() > CHAIN_DEPTH {
            return say(self, format!("nesting deeper than {CHAIN_DEPTH}"));
        }
        // Said once: past the budget every remaining embed is skipped, and one
        // line per skipped site would be thousands.
        if self.spent >= EMBED_TOTAL {
            if !self.told {
                self.told = true;
                say(self, format!("expansion budget spent ({EMBED_TOTAL} expansions); this and later embeds were not expanded"));
            }
            return;
        }
        self.spent += 1;
        let (path, anchor) = match src.split_once('#') {
            Some((p, a)) => (p, Some(a)),
            None => (src, None),
        };
        let parsed;
        let (key, doc): (String, &Document) = if path.is_empty() {
            (format!("{}#{}", from.name, anchor.unwrap_or("")), from)
        } else {
            let Some(host) = self.host else { return say(self, "the caller supplied no document resolver".into()) };
            let Some(name) = crate::host::locate(host, &from.name, path) else {
                return say(self, format!("cannot resolve `{path}`"));
            };
            parsed = match self.parsed.get(&name) {
                Some(d) => d.clone(),
                None => {
                    let Some(text) = crate::host::read_from(host, &from.name, path) else {
                        return say(self, format!("cannot resolve `{path}`"));
                    };
                    let d = Rc::new(crate::parse_with(&text, &crate::Options { name: name.clone(), recognize: true, host: None, checks: false }));
                    self.parsed.insert(name.clone(), d.clone());
                    d
                }
            };
            (name, &*parsed)
        };
        if chain.contains(&key) {
            return say(self, format!("`{src}` is already being expanded (cycle)"));
        }
        let Some(picked) = self.pick(doc, anchor, part) else {
            return say(self, format!("`#{}` is not in it", anchor.unwrap_or("")));
        };
        let mut picked = (*picked).clone();
        let whole = anchor.is_none() && !path.is_empty();
        let implicit = if whole { doc.meta.iter().find(|(k, _)| k == "default-style").and_then(|(_, v)| v.scalar_text()) } else { None };
        if anchor.is_none() {
            picked.retain(|it| !matches!(it, Item::Block(b) if b.type_name == "meta"));
        }
        if picked.is_empty() && implicit.is_none() {
            return say(self, if anchor.is_none() { "the target is empty".into() } else { format!("`#{}` holds no blocks", anchor.unwrap_or("")) });
        }
        chain.push(key);
        if let Some(ds) = implicit {
            self.embed(doc, &ds, None, layer, chain, blocks);
        }
        self.items(doc, &picked, layer, chain, blocks);
        chain.pop();
    }

    /// What an `embed` of `anchor` and `part` in `doc` takes in, worked out
    /// once per document, anchor and part.
    fn pick(&mut self, doc: &Document, anchor: Option<&str>, part: Option<&str>) -> Option<Rc<Vec<Item>>> {
        let key = (doc.name.clone(), anchor.map(str::to_string), part.map(str::to_string));
        if let Some(hit) = self.picks.get(&key) {
            return hit.clone();
        }
        let prose = self.prose.entry(doc.name.clone()).or_default();
        let hit = crate::transclude::content(doc, anchor, part, prose).map(Rc::new);
        self.picks.insert(key, hit.clone());
        hit
    }
}

/// The style blocks a stylesheet — or a style entry (§1.1) — contributes, by
/// layer: `default-style` 0, the `#sitemap` match 1, the entry's own rules 2.
fn load(sheet: &Document, doc_name: Option<&str>, loader: &mut Loader) -> Vec<StyleBlock> {
    let mut blocks = Vec::new();
    let mut chain = vec![sheet.name.clone()];
    let default = sheet.meta.iter().find(|(k, _)| k == "default-style").and_then(|(_, v)| v.scalar_text());
    if let Some(src) = &default {
        loader.embed(sheet, src, None, 0, &mut chain, &mut blocks);
    }
    if let Some(name) = doc_name {
        let mut all = Vec::new();
        crate::resolve::walk(&sheet.children, &mut all);
        for it in all {
            let Item::Block(b) = it else { continue };
            if b.type_name != "table" || b.id.as_deref() != Some("sitemap") {
                continue;
            }
            let Some(t) = &b.table else { continue };
            let (Some(dc), Some(tc)) = (t.columns.iter().position(|c| c == "document"), t.columns.iter().position(|c| c == "template")) else { continue };
            // The first row for the document; one naming the default stylesheet
            // again is not a second layer of it.
            if let Some(row) = t.rows.iter().find(|r| r[dc].text.trim() == name) {
                let src = row[tc].text.trim().to_string();
                if !src.is_empty() && Some(&src) != default.as_ref() {
                    loader.embed(sheet, &src, None, 1, &mut chain, &mut blocks);
                }
            }
        }
    }
    loader.items(sheet, &sheet.children, 2, &mut chain, &mut blocks);
    blocks
}

// ---------------------------------------------------------------------------
// The view model (§10)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Variant {
    pub when: Vec<(String, String)>,
    pub box_: Vec<(String, Value)>,
    pub params: Vec<(String, Value)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Binding {
    pub doc: String,
    pub block: String,
    pub part: Option<String>,
    pub rules: Vec<String>,
    pub params: Vec<(String, Value)>,
    pub box_: Vec<(String, Value)>,
    pub variants: Vec<Variant>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Slot {
    Blocks { selector: String, blocks: Vec<(String, String)> },
    State(String),
    Frame(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct StateVm {
    pub id: String,
    pub ty: String,
    pub on: String,
    pub value_from: Option<String>,
    pub init_value: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContainerVm {
    pub id: String,
    pub axis: String,
    pub component: Option<String>,
    /// Its own words, with what the rules dressing it set laid over them (§2.1).
    pub params: Vec<(String, Value)>,
    pub box_: Vec<(String, Value)>,
    pub variants: Vec<Variant>,
    pub slots: Vec<Slot>,
    pub bindings: Vec<Binding>,
}

#[derive(Debug, Default)]
pub struct ViewModel {
    pub states: Vec<StateVm>,
    pub screens: Vec<ContainerVm>,
    pub frames: Vec<ContainerVm>,
    pub bindings: Vec<Binding>,
    pub diagnostics: Vec<ProfileDiagnostic>,
}

fn kv_json(m: &[(String, Value)]) -> String {
    to_json(&Value::Object(m.to_vec()))
}

fn binding_json(b: &Binding) -> String {
    let mut f = vec![format!("\"doc\":{}", quote(&b.doc)), format!("\"block\":{}", quote(&b.block))];
    if let Some(p) = &b.part {
        f.push(format!("\"part\":{}", quote(p)));
    }
    f.push(format!("\"rules\":[{}]", b.rules.iter().map(|r| quote(r)).collect::<Vec<_>>().join(",")));
    f.push(format!("\"params\":{}", kv_json(&b.params)));
    f.push(format!("\"box\":{}", kv_json(&b.box_)));
    f.push(format!("\"variants\":{}", variants_json(&b.variants)));
    format!("{{{}}}", f.join(","))
}

fn variants_json(vs: &[Variant]) -> String {
    let vs: Vec<String> = vs
        .iter()
        .map(|v| {
            let when: Vec<(String, Value)> = v.when.iter().map(|(k, x)| (k.clone(), Value::String(x.clone()))).collect();
            format!("{{\"when\":{},\"box\":{},\"params\":{}}}", kv_json(&when), kv_json(&v.box_), kv_json(&v.params))
        })
        .collect();
    format!("[{}]", vs.join(","))
}

fn slot_json(s: &Slot) -> String {
    match s {
        Slot::Blocks { selector, blocks } => format!(
            "{{\"kind\":\"blocks\",\"selector\":{},\"blocks\":[{}]}}",
            quote(selector),
            blocks.iter().map(|(d, b)| format!("{{\"doc\":{},\"block\":{}}}", quote(d), quote(b))).collect::<Vec<_>>().join(",")
        ),
        Slot::State(s) => format!("{{\"kind\":\"state\",\"state\":{}}}", quote(s)),
        Slot::Frame(f) => format!("{{\"kind\":\"frame\",\"frame\":{}}}", quote(f)),
    }
}

fn container_json(c: &ContainerVm, with_bindings: bool) -> String {
    let mut f = vec![format!("\"id\":{}", quote(&c.id)), format!("\"axis\":{}", quote(&c.axis))];
    if let Some(comp) = &c.component {
        f.push(format!("\"component\":{}", quote(comp)));
    }
    f.push(format!("\"params\":{}", kv_json(&c.params)));
    f.push(format!("\"box\":{}", kv_json(&c.box_)));
    f.push(format!("\"variants\":{}", variants_json(&c.variants)));
    f.push(format!("\"slots\":[{}]", c.slots.iter().map(slot_json).collect::<Vec<_>>().join(",")));
    if with_bindings {
        f.push(format!("\"bindings\":[{}]", c.bindings.iter().map(binding_json).collect::<Vec<_>>().join(",")));
    }
    format!("{{{}}}", f.join(","))
}

impl ViewModel {
    /// `geml style check --json`'s shape (§10).
    pub fn to_json(&self) -> String {
        let states: Vec<String> = self
            .states
            .iter()
            .map(|s| {
                let mut f = vec![format!("\"id\":{}", quote(&s.id)), format!("\"type\":{}", quote(&s.ty)), format!("\"on\":{}", quote(&s.on))];
                if let Some(v) = &s.value_from {
                    f.push(format!("\"valueFrom\":{}", quote(v)));
                }
                if let Some(v) = &s.init_value {
                    f.push(format!("\"initValue\":{}", quote(v)));
                }
                format!("{{{}}}", f.join(","))
            })
            .collect();
        let diags: Vec<String> = self
            .diagnostics
            .iter()
            .map(|d| {
                format!(
                    "{{\"severity\":{},\"code\":{},\"message\":{},\"rule\":{}}}",
                    quote(d.level.as_str()),
                    quote(d.code),
                    quote(&d.message),
                    quote(&d.address)
                )
            })
            .collect();
        format!(
            "{{\"states\":[{}],\"screens\":[{}],\"frames\":[{}],\"bindings\":[{}],\"diagnostics\":[{}]}}",
            states.join(","),
            self.screens.iter().map(|c| container_json(c, true)).collect::<Vec<_>>().join(","),
            self.frames.iter().map(|c| container_json(c, false)).collect::<Vec<_>>().join(","),
            self.bindings.iter().map(binding_json).collect::<Vec<_>>().join(","),
            diags.join(",")
        )
    }
}

/// The host's registries, when the caller declares them (§7).
#[derive(Default, Clone, Debug, PartialEq)]
pub struct Registries {
    pub components: Option<Vec<String>>,
    pub handlers: Option<Vec<String>>,
}

impl Registries {
    /// `{"components": [...], "handlers": [...]}`, either optional; an empty
    /// text declares neither.
    pub fn from_json(text: &str) -> Result<Registries, String> {
        if text.trim().is_empty() {
            return Ok(Registries::default());
        }
        let v = crate::json::parse(text).map_err(|e| format!("the registries are not JSON: {}", e.message))?;
        let names = |key: &str| -> Result<Option<Vec<String>>, String> {
            match v.get(key) {
                None => Ok(None),
                Some(Value::Array(a)) => a
                    .iter()
                    .map(|x| if let Value::String(s) = x { Ok(s.clone()) } else { Err(format!("`{key}` holds a non-string")) })
                    .collect::<Result<_, _>>()
                    .map(Some),
                Some(_) => Err(format!("`{key}` is not an array")),
            }
        };
        Ok(Registries { components: names("components")?, handlers: names("handlers")? })
    }
}

/// `$name` references in a value: `$sel`, `confidence=$conf`, `$sel.caption`.
fn state_refs(v: &str) -> Vec<String> {
    let chars: Vec<char> = v.chars().collect();
    let mut out = Vec::new();
    for (i, c) in chars.iter().enumerate() {
        if *c == '$' && (i == 0 || chars[i - 1] == '=' || chars[i - 1] == ' ' || chars[i - 1] == ',') {
            let name: String = chars[i + 1..].iter().take_while(|x| is_word(**x)).collect();
            if !name.is_empty() {
                out.push(name);
            }
        }
    }
    out
}

/// `when=`: `$state=value` terms and the five control states.
fn when_terms(v: &str) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for t in v.split(',').map(str::trim).filter(|t| !t.is_empty()) {
        if let Some(c) = t.strip_prefix('@') {
            if CONTROL_STATES.contains(&c) {
                out.push((format!("@{c}"), "true".to_string()));
                continue;
            }
            return Err(t.to_string());
        }
        match t.strip_prefix('$').and_then(|r| r.split_once('=')) {
            Some((s, val)) if !s.is_empty() => out.push((s.trim().to_string(), val.trim().to_string())),
            _ => return Err(t.to_string()),
        }
    }
    Ok(out)
}

/// Words and their values, as a binding's `params` and `box` hold them.
type Words = Vec<(String, Value)>;

/// What a rule binds to: a document, a block's address, an inline part.
type TargetKey = (String, String, Option<String>);

struct Contribution<'a> {
    rule: &'a StyleBlock,
    conds: Vec<String>,
    when: Vec<(String, String)>,
}

fn superset(a: &[String], b: &[String]) -> bool {
    a.len() > b.len() && b.iter().all(|x| a.contains(x))
}

fn exclusive(a: &[(String, String)], b: &[(String, String)]) -> bool {
    a.iter().any(|(s, v)| b.iter().any(|(t, w)| s == t && v != w))
}

const RULE_RESERVED: &[&str] = &["match", "screen", "when", "caption", "hidden"];
const RECEIVERS: &[&str] = &["component", "handler", "show", "filter"];

/// One rule's hit on a target: the conditions of its most specific matching
/// branch, its `when=` terms among them (§4: a `when=` term is one more
/// condition).
struct Hit<'a> {
    rule: &'a StyleBlock,
    conds: Vec<String>,
    when: Vec<(String, String)>,
}

/// The hits under one `when=` set, and after §4 step 2 the rule holding each
/// word: `(word, value, index of the holder in the hits)`.
struct Group {
    when: Vec<(String, String)>,
    key: Vec<(String, String)>,
    order: usize,
    members: Vec<usize>,
    words: Vec<(String, Value, usize)>,
}

impl Group {
    fn holder(&self, k: &str) -> Option<usize> {
        self.words.iter().find(|(w, _, _)| w == k).map(|(_, _, h)| *h)
    }

    fn remove(&mut self, k: &str) {
        self.words.retain(|(w, _, _)| w != k);
    }
}

/// Merge the contributions to one target into its binding (§4). Each step
/// is computed from the whole set at once, so the outcome never depends on
/// the order rules are looked at; source order decides only a contest that
/// is reported.
fn merge(target: (&str, &str, Option<&str>), cs: &[Contribution], receiver: bool, out: &mut Vec<ProfileDiagnostic>) -> Binding {
    let at = format!("{}{}", target.0, target.1);
    let part = target.2.is_some();
    // A rule hits once, with its most specific branch.
    let mut hits: Vec<Hit> = Vec::new();
    for c in cs {
        let mut conds: Vec<String> = Vec::new();
        for x in c.conds.iter().cloned().chain(c.when.iter().map(|(s, v)| format!("when:{s}={v}"))) {
            if !conds.contains(&x) {
                conds.push(x);
            }
        }
        match hits.iter_mut().find(|h| h.rule.order == c.rule.order) {
            Some(h) => {
                if superset(&conds, &h.conds) {
                    h.conds = conds;
                }
            }
            None => hits.push(Hit { rule: c.rule, conds, when: c.when.clone() }),
        }
    }
    hits.sort_by_key(|h| h.rule.order);
    let rules: Vec<String> = hits.iter().map(|h| h.rule.label()).collect();
    // The words a rule sets here: not the reserved names, and on an inline
    // part not a block-only built-in word (reported once, on the rule).
    // A closed-domain word outside its domain is dropped (§2.1): the rule does not set it.
    let sets = |h: &Hit, k: &str| -> bool {
        let block_only = part && BUILTIN.contains(&k) && !PART_WORDS.contains(&k);
        !(RULE_RESERVED.contains(&k) || block_only) && h.rule.get(k).is_some_and(|v| invalid(k, v).is_none())
    };
    let clash = |out: &mut Vec<ProfileDiagnostic>, a: &Hit, b: &Hit, k: &str| {
        let same = a.conds.len() == b.conds.len() && a.conds.iter().all(|x| b.conds.contains(x));
        out.push(ProfileDiagnostic {
            code: "style-ambiguous-rule",
            level: W,
            address: at.clone(),
            message: if same {
                format!(
                    "{} and {} have one selector and both set `{k}`: delete one, or add a condition that tells them apart; {} is written first and keeps it",
                    a.rule.label(),
                    b.rule.label(),
                    a.rule.label()
                )
            } else {
                format!(
                    "{} and {} both set `{k}` and neither's conditions contain the other's: write a rule with the union of both; {} is written first and keeps it",
                    a.rule.label(),
                    b.rule.label(),
                    a.rule.label()
                )
            },
        });
    };

    // Steps 1 and 2, per `when=` set and per word: only the highest layer
    // setting it takes part; of its rules, those no other's conditions
    // strictly contain are the maximal ones, and the first written of them
    // holds the word. Each other maximal rule lost to order alone.
    let mut groups: Vec<Group> = Vec::new();
    for (i, h) in hits.iter().enumerate() {
        let mut key = h.when.clone();
        key.sort();
        match groups.iter_mut().find(|g| g.key == key) {
            Some(g) => g.members.push(i),
            None => groups.push(Group { when: h.when.clone(), key, order: h.rule.order, members: vec![i], words: Vec::new() }),
        }
    }
    for g in &mut groups {
        let mut names: Vec<&str> = Vec::new();
        for &i in &g.members {
            for (k, _) in &hits[i].rule.attrs {
                if sets(&hits[i], k) && !names.contains(&k.as_str()) {
                    names.push(k);
                }
            }
        }
        for k in names {
            let setting: Vec<usize> = g.members.iter().copied().filter(|&i| sets(&hits[i], k)).collect();
            let top = setting.iter().map(|&i| hits[i].rule.layer).max().unwrap_or(0);
            let layer: Vec<usize> = setting.into_iter().filter(|&i| hits[i].rule.layer == top).collect();
            let maximal: Vec<usize> = layer.iter().copied().filter(|&i| !layer.iter().any(|&o| o != i && superset(&hits[o].conds, &hits[i].conds))).collect();
            let holder = *maximal.iter().min_by_key(|&&i| hits[i].rule.order).expect("a rule sets it");
            g.words.push((k.to_string(), hits[holder].rule.get(k).cloned().expect("set"), holder));
            for &m in &maximal {
                if m != holder {
                    clash(out, &hits[holder], &hits[m], k);
                }
            }
        }
    }

    // `border` and a side are two names, so the steps above never meet them.
    // Within one `when=` set and one layer, when one rule holds `border` and
    // another a side, the later-written rule's word is dropped — decided
    // between the holders, all at once, one report per word dropped.
    for g in &mut groups {
        let Some(short) = g.holder("border") else { continue };
        let mut drop: Vec<(&str, usize, &str, usize, &str)> = Vec::new();
        for side in BORDER_SIDES {
            let Some(one) = g.holder(side) else { continue };
            if hits[one].rule.order == hits[short].rule.order || hits[one].rule.layer != hits[short].rule.layer {
                continue;
            }
            if hits[short].rule.order < hits[one].rule.order {
                drop.push((side, short, "border", one, side));
            } else if !drop.iter().any(|d| d.0 == "border") {
                drop.push(("border", one, side, short, "border"));
            }
        }
        for (word, a, a_word, b, b_word) in drop {
            g.remove(word);
            out.push(ProfileDiagnostic {
                code: "style-ambiguous-rule",
                level: W,
                address: at.clone(),
                message: format!(
                    "{} sets `{a_word}` and {} sets `{b_word}`: a shorthand and one of its sides in one layer, where the result would depend on which lands last; the word written first stays",
                    hits[a].rule.label(),
                    hits[b].rule.label()
                ),
            });
        }
    }

    // Step 3, across `when=` sets that can hold together: the holders of step
    // 2 are compared pair by pair. A higher layer keeps the word; in one
    // layer, when neither condition set strictly contains the other, the set
    // whose holder was written later loses it. Losses are applied together.
    // (set, word, the holder that keeps it and the one that lost to order —
    // none when a layer decided, which is not reported).
    type Loss = (usize, String, Option<(usize, usize)>);
    let mut losses: Vec<Loss> = Vec::new();
    let mut lose = |g: usize, k: &str, by: Option<(usize, usize)>| match losses.iter_mut().find(|(x, w, _)| *x == g && w == k) {
        Some(e) => {
            if e.2.is_none() && by.is_some() {
                e.2 = by;
            }
        }
        None => losses.push((g, k.to_string(), by)),
    };
    for i in 0..groups.len() {
        for j in i + 1..groups.len() {
            if exclusive(&groups[i].when, &groups[j].when) {
                continue;
            }
            for (k, _, a) in &groups[i].words {
                let Some(b) = groups[j].holder(k) else { continue };
                let (ha, hb) = (&hits[*a], &hits[b]);
                if ha.rule.layer != hb.rule.layer {
                    lose(if ha.rule.layer > hb.rule.layer { j } else { i }, k, None);
                } else if superset(&ha.conds, &hb.conds) || superset(&hb.conds, &ha.conds) {
                    continue;
                } else if ha.rule.order <= hb.rule.order {
                    lose(j, k, Some((*a, b)));
                } else {
                    lose(i, k, Some((b, *a)));
                }
            }
        }
    }
    for (g, k, by) in losses {
        groups[g].remove(&k);
        if let Some((a, b)) = by {
            clash(out, &hits[a], &hits[b], &k);
        }
    }

    // Parameters need a receiver: one report per binding, naming the keys
    // and the rules that set them.
    let receiver = receiver || groups.iter().any(|g| g.holder("component").is_some() || g.holder("handler").is_some());
    if !receiver {
        let mut loose: Vec<&str> = Vec::new();
        let mut by: Vec<String> = Vec::new();
        for g in &groups {
            for (k, _, h) in &g.words {
                if !RECEIVERS.contains(&k.as_str()) && !BUILTIN.contains(&k.as_str()) && !loose.contains(&k.as_str()) {
                    loose.push(k);
                    let l = hits[*h].rule.label();
                    if !by.contains(&l) {
                        by.push(l);
                    }
                }
            }
        }
        if !loose.is_empty() {
            out.push(ProfileDiagnostic {
                code: "style-unknown-attribute",
                level: W,
                address: at.clone(),
                message: format!(
                    "{} set {} with no `component=` or `handler=` to receive it",
                    by.join(", "),
                    loose.iter().map(|k| format!("`{k}`")).collect::<Vec<_>>().join(", ")
                ),
            });
        }
    }

    let split = |g: &Group| -> (Words, Words) {
        let mut params = Vec::new();
        let mut boxw = Vec::new();
        for (k, v, _) in &g.words {
            if BUILTIN.contains(&k.as_str()) {
                boxw.push((k.clone(), v.clone()));
            } else {
                params.push((k.clone(), v.clone()));
            }
        }
        (params, boxw)
    };
    let (params, box_) = groups.iter().find(|g| g.when.is_empty()).map(split).unwrap_or_default();
    // A set that lost every word is no variant.
    let mut vs: Vec<&Group> = groups.iter().filter(|g| !g.when.is_empty() && !g.words.is_empty()).collect();
    vs.sort_by_key(|g| (g.when.len(), g.order));
    let variants = vs
        .into_iter()
        .map(|g| {
            let (p, b) = split(g);
            Variant { when: g.when.clone(), box_: b, params: p }
        })
        .collect();
    Binding { doc: target.0.to_string(), block: target.1.to_string(), part: target.2.map(str::to_string), rules, params, box_, variants }
}

/// Solve a stylesheet against a corpus (`geml style check`).
pub fn check(sheet: &Document, corpus: &[&Document], reg: &Registries, host: Option<&dyn Host>) -> ViewModel {
    let mut loader =
        Loader { host, out: Vec::new(), order: 0, rules: 0, spent: 0, told: false, parsed: HashMap::new(), prose: HashMap::new(), picks: HashMap::new() };
    let single_doc = if corpus.len() == 1 { Some(corpus[0].name.as_str()) } else { None };
    let blocks = load(sheet, single_doc, &mut loader);
    let mut out = loader.out;
    let mut d = |code: &'static str, level: Level, at: String, msg: String| out.push(ProfileDiagnostic { code, level, address: at, message: msg });

    // The corpus (§3): the documents given, then those their `embed`s name.
    // The stylesheet's own containers are not nodes; a rule reaches one only
    // by naming it (§2.1).
    let mut nodes: Vec<Node> = Vec::new();
    let extra = corpus_docs(corpus, host);
    for doc in corpus.iter().copied().chain(extra.iter()) {
        append_nodes(doc, &mut nodes);
    }
    let has_corpus = !corpus.is_empty();
    let states: Vec<&StyleBlock> = blocks.iter().filter(|b| b.ty == "style-state").collect();
    let screens: Vec<&StyleBlock> = blocks.iter().filter(|b| b.ty == "style-screen").collect();
    let frames: Vec<&StyleBlock> = blocks.iter().filter(|b| b.ty == "style-frame").collect();
    let declared = |s: &str| states.iter().any(|b| b.id.as_deref() == Some(s));
    let at = |b: &StyleBlock| format!("{}{}", b.doc, b.id.as_ref().map(|i| format!("#{i}")).unwrap_or_else(|| format!(" ({})", b.label())));

    // Closed-domain built-in words, on every style block.
    for b in &blocks {
        for (k, v) in &b.attrs {
            if let Some(dom) = invalid(k, v) {
                d("style-invalid-value", E, at(b), format!("`{k}={}` is outside its domain ({dom})", v.scalar_text().unwrap_or_default()));
            }
        }
    }

    // States (§2.2).
    let mut vm_states = Vec::new();
    for s in &states {
        let id = s.id.clone().unwrap_or_default();
        for (k, _) in &s.attrs {
            if !["match", "on", "type", "value-from", "init-value", "caption", "hidden"].contains(&k.as_str()) {
                d("style-unknown-attribute", W, at(s), format!("a `style-state` has no attribute `{k}`"));
            }
        }
        let on = s.text("on").unwrap_or_default();
        match s.text("on") {
            None => d("style-missing-attribute", E, at(s), "a `style-state` needs `on=`".into()),
            Some(o) if !INTERACTIONS.contains(&o.as_str()) => d("style-unknown-interaction", E, at(s), format!("`on={o}` is not select or toggle")),
            _ => {}
        }
        match s.text("match") {
            None => d("style-missing-attribute", E, at(s), "a `style-state` needs `match=`".into()),
            Some(m) => match parse_selector(&m) {
                Err(u) => d("style-selector-unsupported", E, at(s), format!("`match={m}`: {u}")),
                Ok(br) => {
                    for p in reserved_first_steps(&m) {
                        d(
                            "style-reserved-name",
                            W,
                            at(s),
                            format!("`{p}` is read as a block type here; the inline part of that name needs a block step before it (`text#nav {p}`)"),
                        );
                    }
                    let producers: Vec<usize> = (0..nodes.len()).filter(|i| br.iter().any(|b| branch_matches(b, &nodes, *i))).collect();
                    // A state a container produces: `match=` one bare `#id` naming a
                    // screen or a frame — clicking that region flips it.
                    let on_container = matches!(br.as_slice(), [b] if b.part.is_none() && matches!(b.steps.as_slice(), [st] if !st.any && st.ty.is_none() && st.classes.is_empty() && st.attrs.is_empty() && st.id.as_ref().is_some_and(|id| screens.iter().chain(frames.iter()).any(|c| c.id.as_ref() == Some(id)))));
                    if has_corpus && producers.is_empty() && !on_container {
                        d("style-unmatched-producer", W, at(s), format!("`match={m}` matched no block"));
                    }
                    if let Some(vf) = s.text("value-from") {
                        for p in &producers {
                            if let Some(cols) = &nodes[*p].columns {
                                if !cols.contains(&vf) {
                                    d(
                                        "style-unknown-value-source",
                                        E,
                                        at(s),
                                        format!("`value-from={vf}` is not a column of {}{}", nodes[*p].doc, nodes[*p].address),
                                    );
                                }
                            }
                        }
                    }
                }
            },
        }
        vm_states.push(StateVm {
            id,
            ty: s.text("type").unwrap_or_else(|| "block-ref".into()),
            on,
            value_from: s.text("value-from"),
            init_value: s.text("init-value"),
        });
    }

    // Screens and frames (§2.3, §2.4).
    let screen_set: HashSet<&str> = screens.iter().filter_map(|x| x.id.as_deref()).collect();
    let frame_set: HashSet<&str> = frames.iter().filter_map(|x| x.id.as_deref()).collect();
    let resolve_slots = |c: &StyleBlock, d: &mut dyn FnMut(&'static str, Level, String, String)| -> Vec<Slot> {
        let mut slots = Vec::new();
        let Some(spec) = c.text("slots") else {
            d("style-missing-attribute", E, at(c), format!("a `{}` needs `slots=`", c.ty));
            return slots;
        };
        for s in split_outside(&spec, |ch| ch == ',') {
            if let Some(st) = s.strip_prefix('$') {
                if !declared(st) {
                    d("style-unknown-state", E, at(c), format!("slot `{s}` names a state no `style-state` declares"));
                }
                slots.push(Slot::State(st.to_string()));
            } else if s.starts_with('#') && s[1..].chars().all(is_word) {
                let id = &s[1..];
                if screen_set.contains(id) {
                    d("style-screen-nested", E, at(c), format!("slot `{s}` names a `style-screen`; a page cannot be placed inside another"));
                } else if !frame_set.contains(id) {
                    d("style-unknown-frame", E, at(c), format!("slot `{s}` names no `style-frame`"));
                }
                slots.push(Slot::Frame(id.to_string()));
            } else {
                match parse_selector(&s) {
                    Err(u) => d("style-selector-unsupported", E, at(c), format!("slot `{s}`: {u}")),
                    Ok(br) if br.iter().any(|b| b.part.is_some()) => {
                        d("style-selector-unsupported", E, at(c), format!("slot `{s}` names an inline part; a part goes wherever its block goes"))
                    }
                    Ok(br) => {
                        let hits: Vec<(String, String)> = (0..nodes.len())
                            .filter(|i| br.iter().any(|b| branch_matches(b, &nodes, *i)))
                            .map(|i| (nodes[i].doc.clone(), nodes[i].address.clone()))
                            .collect();
                        if has_corpus && hits.is_empty() {
                            d("style-unmatched-rule", W, at(c), format!("slot `{s}` matched no block"));
                        }
                        slots.push(Slot::Blocks { selector: s.clone(), blocks: hits });
                    }
                }
            }
        }
        for (k, _) in &c.attrs {
            let known = ["slots", "axis", "component", "caption", "hidden"].contains(&k.as_str()) || BUILTIN.contains(&k.as_str());
            if !known && c.get("component").is_none() {
                d("style-unknown-attribute", W, at(c), format!("`{k}` on a `{}` with no `component=` has nothing to receive it", c.ty));
            }
        }
        slots
    };
    // A container's own words: built-in ones into its box (a value outside
    // its domain dropped), the others to its component when it names one.
    let container = |c: &StyleBlock, slots: Vec<Slot>| -> ContainerVm {
        let component = c.text("component");
        let mut box_ = Vec::new();
        let mut params = Vec::new();
        for (k, v) in &c.attrs {
            if ["slots", "axis", "component", "caption", "hidden"].contains(&k.as_str()) {
                continue;
            }
            if BUILTIN.contains(&k.as_str()) {
                if invalid(k, v).is_none() {
                    box_.push((k.clone(), v.clone()));
                }
            } else if component.is_some() {
                params.push((k.clone(), v.clone()));
            }
        }
        let axis = c.text("axis").filter(|a| a == "row" || a == "column").unwrap_or_else(|| "column".into());
        ContainerVm { id: c.id.clone().unwrap_or_default(), axis, component, params, box_, variants: vec![], slots, bindings: vec![] }
    };
    let mut vm_screens = Vec::new();
    for s in &screens {
        let slots = resolve_slots(s, &mut d);
        vm_screens.push(container(s, slots));
    }
    let mut vm_frames = Vec::new();
    for f in &frames {
        let slots = resolve_slots(f, &mut d);
        vm_frames.push(container(f, slots));
    }
    // The frame graph: cycles, depth, frames no slot places. An edge is a
    // slot naming a frame; a slot naming a screen is already an error. Both
    // walks are iterative and expand each frame once, so a chain of any length
    // or a diamond many levels deep is linear work, not a deep stack (§9.2).
    let frame_at: HashMap<&str, usize> = vm_frames.iter().enumerate().map(|(i, f)| (f.id.as_str(), i)).collect();
    let refs = |c: &ContainerVm| -> Vec<usize> {
        c.slots.iter().filter_map(|s| if let Slot::Frame(f) = s { frame_at.get(f.as_str()).copied() } else { None }).collect()
    };
    let edges: Vec<Vec<usize>> = vm_frames.iter().map(refs).collect();
    let id_of = |i: usize| vm_frames[i].id.as_str();
    // Cycles: each frame is expanded once, and a cycle is seen on the path
    // that reaches it — said once, from its least id round.
    let mut visited = vec![false; vm_frames.len()];
    let mut cycles: Vec<(usize, String)> = Vec::new();
    let drain = |stack: &mut Vec<(usize, Vec<usize>)>, visited: &mut [bool], cycles: &mut Vec<(usize, String)>| {
        while let Some((i, path)) = stack.pop() {
            if std::mem::replace(&mut visited[i], true) {
                continue;
            }
            for &n in &edges[i] {
                if let Some(at) = path.iter().position(|p| *p == n) {
                    let cyc = &path[at..];
                    let first = (0..cyc.len()).min_by(|a, b| id_of(cyc[*a]).cmp(id_of(cyc[*b]))).unwrap_or(0);
                    let rotated: Vec<usize> = cyc[first..].iter().chain(&cyc[..first]).copied().collect();
                    let chain = rotated.iter().chain(rotated.first()).map(|k| format!("#{}", id_of(*k))).collect::<Vec<_>>().join(" → ");
                    if !cycles.iter().any(|(_, c)| *c == chain) {
                        cycles.push((rotated[0], chain));
                    }
                    continue;
                }
                let mut next = path.clone();
                next.push(n);
                stack.push((n, next));
            }
        }
    };
    // From each screen first — that is the real depth — then any frame no
    // screen reaches, so a cycle hanging from nothing is still said.
    let mut stack: Vec<(usize, Vec<usize>)> = vm_screens.iter().flat_map(refs).map(|r| (r, vec![r])).collect();
    drain(&mut stack, &mut visited, &mut cycles);
    for i in 0..vm_frames.len() {
        if !visited[i] {
            stack.push((i, vec![i]));
            drain(&mut stack, &mut visited, &mut cycles);
        }
    }
    for (i, c) in cycles {
        d("style-frame-cycle", E, format!("{}#{}", sheet.name, id_of(i)), format!("frames nest in a cycle: {c}"));
    }
    // Depth, in one topological pass: a frame is one deeper than the deepest
    // frame that places it, and one no frame places is 1. A frame on a cycle
    // never comes free; the cycle is said above.
    let mut indeg = vec![0usize; vm_frames.len()];
    for e in &edges {
        for &r in e {
            indeg[r] += 1;
        }
    }
    let mut depth = vec![1usize; vm_frames.len()];
    let mut ready: Vec<usize> = (0..vm_frames.len()).filter(|i| indeg[*i] == 0).collect();
    while let Some(i) = ready.pop() {
        for &r in &edges[i] {
            depth[r] = depth[r].max(depth[i] + 1);
            indeg[r] -= 1;
            if indeg[r] == 0 {
                ready.push(r);
            }
        }
    }
    let deepest = (0..vm_frames.len()).filter(|i| depth[*i] > CHAIN_DEPTH).fold(None, |best: Option<usize>, i| match best {
        Some(b) if depth[b] >= depth[i] => Some(b),
        _ => Some(i),
    });
    if let Some(i) = deepest {
        d(
            "style-frame-too-deep",
            E,
            format!("{}#{}", sheet.name, id_of(i)),
            format!("frames nest {} deep at `#{}`; the bound is {CHAIN_DEPTH}", depth[i], id_of(i)),
        );
    }
    let placed: HashSet<&str> =
        vm_screens.iter().chain(vm_frames.iter()).flat_map(|c| &c.slots).filter_map(|s| if let Slot::Frame(f) = s { Some(f.as_str()) } else { None }).collect();
    for f in &vm_frames {
        if !placed.contains(f.id.as_str()) {
            d("style-unused-frame", W, format!("{}#{}", sheet.name, f.id), "no slot places this frame".into());
        }
    }

    // Rules (§2.1, §4).
    let screen_ids: Vec<String> = screens.iter().filter_map(|s| s.id.clone()).collect();
    struct Parsed<'a> {
        rule: &'a StyleBlock,
        branches: Vec<Branch>,
        screens: Vec<String>,
        when: Vec<(String, String)>,
    }
    let mut parsed = Vec::new();
    for r in blocks.iter().filter(|b| b.ty == "style-rule") {
        for (k, v) in &r.attrs {
            for st in state_refs(&v.scalar_text().unwrap_or_default()) {
                if k != "when" && !declared(&st) {
                    d("style-unknown-state", E, at(r), format!("`{k}=` references `${st}`, which no `style-state` declares"));
                }
            }
        }
        let when = match r.text("when") {
            None => vec![],
            Some(w) => match when_terms(&w) {
                Ok(t) => {
                    for (s, _) in &t {
                        if !s.starts_with('@') && !declared(s) {
                            d("style-unknown-state", E, at(r), format!("`when=` references `${s}`, which no `style-state` declares"));
                        }
                    }
                    t
                }
                Err(t) => {
                    d("style-invalid-value", E, at(r), format!("`when=` term `{t}` is neither `$state=value` nor a control state"));
                    vec![]
                }
            },
        };
        let scr: Vec<String> = r.text("screen").map(|s| s.split_whitespace().map(str::to_string).collect()).unwrap_or_default();
        for s in &scr {
            if !screen_ids.contains(s) {
                d("style-unknown-screen", E, at(r), format!("`screen={s}` names no `style-screen`"));
            }
        }
        if let (Some(c), Some(reg)) = (r.text("component"), &reg.components) {
            if !reg.contains(&c) {
                d("style-unknown-component", W, at(r), format!("`component={c}` is not in the declared registry; it renders inert"));
            }
        }
        if let (Some(h), Some(reg)) = (r.text("handler"), &reg.handlers) {
            if !reg.contains(&h) {
                d("style-unknown-handler", W, at(r), format!("`handler={h}` is not in the declared registry; it renders inert"));
            }
        }
        let Some(m) = r.text("match") else {
            d("style-missing-attribute", E, at(r), "a `style-rule` needs `match=`".into());
            continue;
        };
        match parse_selector(&m) {
            Err(u) => d("style-selector-unsupported", E, at(r), format!("`match={m}`: {u}")),
            Ok(branches) => {
                for p in reserved_first_steps(&m) {
                    d(
                        "style-reserved-name",
                        W,
                        at(r),
                        format!("`{p}` is read as a block type here; the inline part of that name needs a block step before it (`text#nav {p}`)"),
                    );
                }
                // §2.1: a block-only built-in word on a part rule is dropped,
                // and reported once, on the rule.
                if branches.first().is_some_and(|b| b.part.is_some()) {
                    for (k, _) in &r.attrs {
                        if BUILTIN.contains(&k.as_str()) && !PART_WORDS.contains(&k.as_str()) {
                            d("style-unknown-attribute", W, at(r), format!("`{k}` means nothing on an inline part, and is dropped"));
                        }
                    }
                }
                parsed.push(Parsed { rule: r, branches, screens: scr, when });
            }
        }
    }
    // A part step matches only a node holding an inline of its kind (§3).
    let hits_node = |b: &Branch, i: usize| branch_matches(b, &nodes, i) && b.part.as_ref().map_or(true, |p| nodes[i].parts.contains(&p.as_str()));
    let bind = |screen: Option<&str>, out: &mut Vec<ProfileDiagnostic>| -> Vec<Binding> {
        let mut targets: Vec<(TargetKey, usize, Vec<Contribution>)> = Vec::new();
        for p in &parsed {
            if let Some(s) = screen {
                if !p.screens.is_empty() && !p.screens.iter().any(|x| x == s) {
                    continue;
                }
            } else if !p.screens.is_empty() {
                continue;
            }
            for (i, n) in nodes.iter().enumerate() {
                for b in &p.branches {
                    if !hits_node(b, i) {
                        continue;
                    }
                    let mut conds = conditions(b);
                    if let Some(s) = screen {
                        if !p.screens.is_empty() {
                            conds.push(format!("screen:{s}"));
                        }
                    }
                    let key = (n.doc.clone(), n.address.clone(), b.part.clone());
                    let c = Contribution { rule: p.rule, conds, when: p.when.clone() };
                    match targets.iter_mut().find(|(k, _, _)| *k == key) {
                        Some((_, _, v)) => v.push(c),
                        None => targets.push((key, i, vec![c])),
                    }
                }
            }
        }
        // §10: corpus order, then node order; a node's parts right after it,
        // in the order §3 names them.
        let rank = |p: &Option<String>| p.as_ref().map_or(0, |p| 1 + PARTS.iter().position(|x| x == p).unwrap_or(PARTS.len()));
        targets.sort_by_key(|((_, _, part), i, _)| (*i, rank(part)));
        targets.iter().map(|((doc, block, part), _, cs)| merge((doc, block, part.as_deref()), cs, false, out)).collect()
    };
    let bindings = bind(None, &mut out);
    for s in vm_screens.iter_mut() {
        s.bindings = bind(Some(&s.id), &mut out);
    }
    // §2.1: a rule whose `match=` is one bare `#id` naming a screen or a frame
    // dresses it, merged by §4 as a binding's rules are, `screen=` taking no
    // part; what the merge sets replaces the container's own words.
    let names_container = |p: &Parsed, id: &str| matches!(p.branches.as_slice(), [b] if b.part.is_none() && matches!(b.steps.as_slice(), [st] if !st.any && st.ty.is_none() && st.classes.is_empty() && st.attrs.is_empty() && st.id.as_deref() == Some(id)));
    let sheet_name = sheet.name.clone();
    for c in vm_screens.iter_mut().chain(vm_frames.iter_mut()) {
        let cs: Vec<Contribution> = parsed
            .iter()
            .filter(|p| names_container(p, &c.id))
            .map(|p| Contribution { rule: p.rule, conds: conditions(&p.branches[0]), when: p.when.clone() })
            .collect();
        if cs.is_empty() {
            continue;
        }
        let dressed = merge((&sheet_name, &format!("#{}", c.id), None), &cs, c.component.is_some(), &mut out);
        for (k, v) in dressed.box_ {
            match c.box_.iter_mut().find(|(x, _)| *x == k) {
                Some(slot) => slot.1 = v,
                None => c.box_.push((k, v)),
            }
        }
        for (k, v) in dressed.params {
            if k == "component" {
                c.component = v.scalar_text();
                continue;
            }
            match c.params.iter_mut().find(|(x, _)| *x == k) {
                Some(slot) => slot.1 = v,
                None => c.params.push((k, v)),
            }
        }
        c.variants = dressed.variants;
    }
    let dresses = |p: &Parsed| vm_screens.iter().chain(vm_frames.iter()).any(|c| names_container(p, &c.id));
    if has_corpus {
        for p in &parsed {
            let hit = dresses(p) || (0..nodes.len()).any(|i| p.branches.iter().any(|b| hits_node(b, i)));
            if !hit {
                out.push(ProfileDiagnostic {
                    code: "style-unmatched-rule",
                    level: W,
                    address: at(p.rule),
                    message: format!("`match={}` matched no block in the corpus", p.rule.text("match").unwrap_or_default()),
                });
            }
        }
    }
    // Ambiguity reported once per pair, whichever screen found it.
    let mut seen: Vec<(String, String)> = Vec::new();
    out.retain(|x| {
        let k = (x.address.clone(), x.message.clone());
        if seen.contains(&k) {
            false
        } else {
            seen.push(k);
            true
        }
    });
    ViewModel { states: vm_states, screens: vm_screens, frames: vm_frames, bindings, diagnostics: out }
}

/// The checks a stylesheet carries on its own, with no corpus: what `geml
/// check` reports on a document declaring `geml-style/v1`.
pub fn check_sheet_alone(doc: &Document, out: &mut Out) {
    let vm = check(doc, &[], &Registries::default(), None);
    for d in vm.diagnostics {
        if d.code == "style-embed-not-expanded" {
            continue;
        }
        out.list.push(d);
    }
}
