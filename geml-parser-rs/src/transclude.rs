//! §9.3's transclusion chains. An `embed` block and an inline projection
//! expand their target in place, and expansion is recursive: this follows
//! every chain from the document, through the host into other documents, and
//! reports `transclusion-cycle` where one returns to a document already being
//! expanded. Nothing is expanded into the model; the chains are only walked.
//!
//! The chain holds the document and each document a step entered. A step to a
//! target in the document it is made from enters nothing, so a local embed is
//! no cycle; such a step that returns to a target already on the path is one,
//! since following it would never end.

use std::collections::HashMap;
use std::rc::Rc;

use crate::diag::Diags;
use crate::host::{join, Host};
use crate::model::{Document, Inline, Item, List};
use crate::resolve::is_geml_doc;

/// How many steps one document's chains may take in all, and how deep one
/// chain may go: §9.3 fixes the depth at 16.
const BUDGET: usize = 10_000;
const MAX_DEPTH: usize = 16;

/// One transclusion written in a document: its line, what it names, and the
/// part of a heading's section an `embed` takes.
struct Step {
    line: usize,
    doc: Option<String>,
    anchor: Option<String>,
    part: Option<String>,
    /// An inline projection, which expands only what may stand in a
    /// sentence (§5.2): one paragraph of a `text` or prose block.
    inline: bool,
}

fn inline_steps(ns: &[Inline], line: usize, out: &mut Vec<Step>) {
    for n in ns {
        match n {
            Inline::Project { doc, anchor, .. } => out.push(Step { line, doc: doc.clone(), anchor: Some(anchor.clone()), part: None, inline: true }),
            Inline::Emph(c) | Inline::Strong(c) | Inline::Strike(c) => inline_steps(c, line, out),
            Inline::Link { children, .. } => inline_steps(children, line, out),
            _ => {}
        }
    }
}

fn list_steps(l: &List, out: &mut Vec<Step>) {
    for it in &l.items {
        inline_steps(&it.inlines, it.line, out);
        for c in &it.children {
            list_steps(c, out);
        }
    }
}

fn steps(items: &[Item], out: &mut Vec<Step>) {
    for it in items {
        match it {
            Item::Paragraph(p) => inline_steps(&p.inlines, p.line, out),
            Item::Heading(h) => inline_steps(&h.inlines, h.line, out),
            Item::List(l) => list_steps(l, out),
            Item::Hidden(_) => {}
            Item::Block(b) => {
                if b.type_name == "embed" {
                    if let Some(src) = b.attr_text("src").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                        let (d, a) = match src.split_once('#') {
                            Some((d, a)) => (d.to_string(), Some(a.to_string())),
                            None => (src, None),
                        };
                        out.push(Step { line: b.line, doc: (!d.is_empty()).then_some(d), anchor: a, part: b.attr_text("part"), inline: false });
                    }
                }
                steps(&b.children, out);
            }
        }
    }
}

/// What a target expands to: the whole document, a block, a heading's
/// section narrowed by `part=` (§3), or a stretch of prose. `None` for a
/// coordinate, which names a value, and for an address nothing answers.
pub(crate) fn content(doc: &Document, anchor: Option<&str>, part: Option<&str>) -> Option<Vec<Item>> {
    let Some(a) = anchor else { return Some(doc.children.clone()) };
    let (id, path) = crate::inline::split_anchor(a)?;
    if !path.is_empty() {
        return None;
    }
    let mut hit = find(&doc.children, &id).or_else(|| crate::addresses::prose_stretch(&doc.children, doc.meta_blocks, &id))?;
    if let (Some(Item::Heading(h)), Some(p)) = (hit.first(), part) {
        let sub = hit.iter().skip(1).position(|o| matches!(o, Item::Heading(x) if x.level > h.level)).map_or(hit.len(), |i| i + 1);
        hit = match p {
            "head" => hit[..1].to_vec(),
            "body" => hit[1..].to_vec(),
            "intro" => hit[1..sub].to_vec(),
            _ => hit,
        };
    }
    Some(hit)
}

/// Whether a projected target may stand in a sentence, and so is expanded.
fn sentence(items: &[Item]) -> bool {
    matches!(items, [Item::Block(b)] if (b.type_name == "text" || b.mode == crate::model::Mode::Prose) && matches!(b.children.as_slice(), [Item::Paragraph(_)]))
}

fn find(items: &[Item], id: &str) -> Option<Vec<Item>> {
    for (i, it) in items.iter().enumerate() {
        match it {
            Item::Block(b) if b.id.as_deref() == Some(id) => return Some(vec![it.clone()]),
            Item::Heading(h) if h.id == id => {
                let end = items[i + 1..].iter().position(|o| matches!(o, Item::Heading(x) if x.level <= h.level)).map_or(items.len(), |p| i + 1 + p);
                return Some(items[i..end].to_vec());
            }
            Item::Block(b) => {
                if let Some(hit) = find(&b.children, id) {
                    return Some(hit);
                }
            }
            _ => {}
        }
    }
    None
}

struct Walk<'a> {
    host: Option<&'a dyn Host>,
    docs: HashMap<String, Option<Rc<Document>>>,
    budget: usize,
    found: Vec<(usize, String)>,
}

impl Walk<'_> {
    /// A document by its root-relative name: the first document's own tree,
    /// or another read through the host and parsed once, host-free.
    fn load(&mut self, name: &str) -> Option<Rc<Document>> {
        if let Some(d) = self.docs.get(name) {
            return d.clone();
        }
        let d = self
            .host
            .and_then(|h| h.read("", name))
            .map(|text| Rc::new(crate::parse_with(&text, &crate::Options { name: name.to_string(), recognize: true, host: None, checks: false })));
        self.docs.insert(name.to_string(), d.clone());
        d
    }

    /// Follow every transclusion in `items`, which belong to the document
    /// `name`. `origin` is the line in the first document a chain started on.
    fn visit(&mut self, name: &str, items: &[Item], chain: &mut Vec<String>, path: &mut Vec<(String, String)>, origin: Option<usize>) {
        let mut found = Vec::new();
        steps(items, &mut found);
        for st in found {
            let at = origin.unwrap_or(st.line);
            let target = match &st.doc {
                None => name.to_string(),
                // §3.3: against the naming document's directory, then the root.
                Some(d) if is_geml_doc(d) => match self.host.and_then(|h| crate::host::locate(h, name, d)).or_else(|| join(name, d)) {
                    Some(t) => t,
                    None => continue,
                },
                Some(_) => continue,
            };
            // What the step expands; a step that expands nothing ends here.
            let items = self.load(&target).and_then(|d| content(&d, st.anchor.as_deref(), st.part.as_deref()));
            let Some(items) = items.filter(|it| !st.inline || sentence(it)) else { continue };
            let key = (target.clone(), st.anchor.clone().unwrap_or_default());
            let names = |chain: &[String]| chain.iter().chain(std::iter::once(&target)).cloned().collect::<Vec<_>>().join(" → ");
            if target != name && chain.contains(&target) {
                self.found.push((at, format!("expanding returns to `{target}`, which is already being expanded: {}", names(chain))));
                continue;
            }
            if path.contains(&key) {
                let shown = if key.1.is_empty() { target.clone() } else { format!("{target}#{}", key.1) };
                self.found.push((at, format!("expanding returns to `{shown}`, which is already being expanded")));
                continue;
            }
            if self.budget == 0 || path.len() >= MAX_DEPTH {
                continue;
            }
            self.budget -= 1;
            let entered = target != name;
            if entered {
                chain.push(target.clone());
            }
            path.push(key);
            self.visit(&target, &items, chain, path, Some(at));
            path.pop();
            if entered {
                chain.pop();
            }
        }
    }
}

/// Report every chain that returns to a document already being expanded,
/// once per line of the document it starts on.
pub fn check(name: &str, children: &[Item], meta_blocks: usize, host: Option<&dyn Host>, diags: &mut Diags) {
    let mut w = Walk { host, docs: HashMap::new(), budget: BUDGET, found: Vec::new() };
    let root = Rc::new(Document { children: children.to_vec(), name: name.to_string(), meta_blocks, ..Default::default() });
    w.docs.insert(name.to_string(), Some(root));
    w.visit(name, children, &mut vec![name.to_string()], &mut Vec::new(), None);
    let mut seen: Vec<(usize, String)> = Vec::new();
    for f in w.found {
        if !seen.contains(&f) {
            diags.push("transclusion-cycle", f.0, f.1.clone());
            seen.push(f);
        }
    }
}
