//! The conformance suite's projection (`_project.mjs`), over this crate's
//! model: what the native harness compares each case's `want` and `blocks`
//! against. Its grammar is the suite's; nothing here decides a parse.

use crate::json::{canonical, quote, Value};
use crate::model::*;
use crate::num::es_string;

fn merged(ns: &[Inline]) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::new();
    for n in ns {
        if let Inline::Text(t) = n {
            if t.is_empty() {
                continue;
            }
            if let Some(Inline::Text(prev)) = out.last_mut() {
                prev.push_str(t);
                continue;
            }
        }
        out.push(n.clone());
    }
    out
}

pub fn inl(ns: &[Inline]) -> String {
    merged(ns).iter().map(node).collect::<Vec<_>>().join(" ")
}

fn node(n: &Inline) -> String {
    match n {
        Inline::Text(t) => quote(t),
        Inline::Emph(c) => format!("em({})", inl(c)),
        Inline::Strong(c) => format!("strong({})", inl(c)),
        Inline::Strike(c) => format!("s({})", inl(c)),
        Inline::Code(v) => format!("code({})", quote(v)),
        Inline::Math(v) => format!("math({})", quote(v)),
        Inline::Break => "br".into(),
        Inline::Image { src, .. } => format!("img({})", quote(src)),
        Inline::Link { href, doc, anchor, children } => {
            let target = match href {
                Some(h) => h.clone(),
                None => format!("{}{}", doc.clone().unwrap_or_default(), anchor.as_ref().map(|a| format!("#{a}")).unwrap_or_default()),
            };
            format!("link({} {})", quote(&target), inl(children))
        }
        Inline::AutoRef { doc, anchor, value } | Inline::Project { doc, anchor, value } => {
            let name = if matches!(n, Inline::AutoRef { .. }) { "ref" } else { "project" };
            let t = quote(&format!("{}#{}", doc.clone().unwrap_or_default(), anchor));
            match value {
                None => format!("{name}({t})"),
                Some(v) => format!("{name}({t} -> {})", quote(v)),
            }
        }
        Inline::Footnote(r) => format!("fn({})", quote(r)),
    }
}

fn list(l: &List) -> String {
    let items: Vec<String> = l
        .items
        .iter()
        .map(|it| {
            let head = match it.checked {
                None => "li",
                Some(true) => "li[x]",
                Some(false) => "li[ ]",
            };
            let mut parts = vec![inl(&it.inlines)];
            parts.extend(it.children.iter().map(list));
            let body: Vec<String> = parts.into_iter().filter(|s| !s.is_empty()).collect();
            format!("{head}({})", body.join(" "))
        })
        .collect();
    let tag = if l.ordered { "ol" } else { "ul" };
    let flags =
        format!("{}{}", if l.loose { "*" } else { "" }, if l.start != 1.0 && l.start != 0.0 { format!("@{}", es_string(l.start)) } else { String::new() });
    format!("{tag}{flags}[{}]", items.join(" "))
}

fn strings(v: impl IntoIterator<Item = String>) -> String {
    canonical(&Value::Array(v.into_iter().map(Value::String).collect()))
}

fn project_block(it: &Item) -> String {
    match it {
        Item::Paragraph(p) => inl(&p.inlines),
        Item::Heading(h) => format!("h{}({})", h.level, inl(&h.inlines)),
        Item::List(l) => list(l),
        Item::Hidden(_) => "hidden".into(),
        Item::Block(b) => {
            if b.type_name == "embed" {
                let src = match b.attr("src") {
                    Some(Value::String(s)) => s.trim().to_string(),
                    _ => String::new(),
                };
                return format!("embed({})", quote(&src));
            }
            if b.type_name == "data" {
                if let Some(v) = &b.value {
                    return format!("data({})", canonical(v));
                }
            }
            if b.type_name == "table" || b.type_name == "view" {
                if let Some(t) = &b.table {
                    let mut rows = vec![strings(t.columns.iter().cloned())];
                    rows.extend(t.rows.iter().map(|r| strings(r.iter().map(|c| c.text.clone()))));
                    if let Some(s) = &t.summary {
                        rows.push(format!("summary {}", strings(s.iter().map(|c| c.text.clone()))));
                    }
                    return format!("{}({})", b.type_name, rows.join(" "));
                }
            }
            format!("block:{}", b.type_name)
        }
    }
}

/// The suite's `project(doc)`: every content block but a `meta`, in order.
pub fn project(d: &Document) -> String {
    d.children.iter().filter(|x| !matches!(x, Item::Block(b) if b.type_name == "meta")).map(project_block).collect::<Vec<_>>().join(" ")
}

fn tree_item(it: &Item) -> String {
    match it {
        Item::Paragraph(p) => format!("p({})", inl(&p.inlines)),
        Item::Heading(h) => format!("h{}#{}({})", h.level, h.id, inl(&h.inlines)),
        Item::List(l) => list(l),
        Item::Hidden(_) => "hidden".into(),
        Item::Block(b) => {
            let mut head = b.type_name.clone();
            if let Some(id) = &b.id {
                head.push('#');
                head.push_str(id);
            }
            for c in &b.classes {
                head.push('.');
                head.push_str(c);
            }
            if !b.attrs.is_empty() {
                head.push_str(&canonical(&Value::Object(b.attrs.clone())));
            }
            match b.mode {
                Mode::Data => format!("{head}({})", canonical(&Value::Object(b.data.clone()))),
                Mode::Raw => format!("{head}({})", quote(&b.raw.join("\n"))),
                Mode::Flow | Mode::Prose => format!("{head}[{}]", b.children.iter().map(tree_item).collect::<Vec<_>>().join(" ")),
            }
        }
    }
}

/// The suite's `blocksOf(doc)`: the block tree.
pub fn blocks_of(d: &Document) -> String {
    d.children.iter().map(tree_item).collect::<Vec<_>>().join(" ")
}
