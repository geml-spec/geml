//! The document model as JSON: the field names the conformance projection
//! (`_project.mjs`) reads, so a JavaScript harness can run the suite's own
//! projection over this implementation's output.

use crate::json::{quote, to_json, Value};
use crate::model::*;
use crate::num::es_string;

fn obj(fields: Vec<(&str, String)>) -> String {
    let body: Vec<String> = fields.into_iter().map(|(k, v)| format!("{}:{}", quote(k), v)).collect();
    format!("{{{}}}", body.join(","))
}

fn arr(items: impl IntoIterator<Item = String>) -> String {
    format!("[{}]", items.into_iter().collect::<Vec<_>>().join(","))
}

fn map(m: &[(String, Value)]) -> String {
    to_json(&Value::Object(m.to_vec()))
}

pub fn inline(n: &Inline) -> String {
    match n {
        Inline::Text(t) => obj(vec![("type", quote("text")), ("value", quote(t))]),
        Inline::Emph(c) => obj(vec![("type", quote("emph")), ("children", inlines(c))]),
        Inline::Strong(c) => obj(vec![("type", quote("strong")), ("children", inlines(c))]),
        Inline::Strike(c) => obj(vec![("type", quote("strike")), ("children", inlines(c))]),
        Inline::Code(v) => obj(vec![("type", quote("code")), ("value", quote(v))]),
        Inline::Math(v) => obj(vec![("type", quote("math")), ("value", quote(v))]),
        Inline::Break => obj(vec![("type", quote("break"))]),
        Inline::Image { src, alt } => obj(vec![("type", quote("image")), ("src", quote(src)), ("alt", inlines(alt))]),
        Inline::Link { href, doc, anchor, children } => {
            let mut f = vec![("type", quote("link"))];
            if let Some(h) = href {
                f.push(("href", quote(h)));
            }
            if let Some(d) = doc {
                f.push(("doc", quote(d)));
            }
            if let Some(a) = anchor {
                f.push(("anchor", quote(a)));
            }
            f.push(("children", inlines(children)));
            obj(f)
        }
        Inline::AutoRef { doc, anchor, value, base } | Inline::Project { doc, anchor, value, base } => {
            let ty = if matches!(n, Inline::AutoRef { .. }) { "autoref" } else { "project" };
            let mut f = vec![("type", quote(ty))];
            if let Some(d) = doc {
                f.push(("doc", quote(d)));
            }
            f.push(("anchor", quote(anchor)));
            if let Some(v) = value {
                f.push(("value", quote(v)));
            }
            if let Some(b) = base {
                f.push(("base", quote(b)));
            }
            obj(f)
        }
        Inline::Footnote(r) => obj(vec![("type", quote("footnote")), ("ref", quote(r))]),
    }
}

pub fn inlines(ns: &[Inline]) -> String {
    arr(ns.iter().map(inline))
}

fn list(l: &List) -> String {
    let items = l.items.iter().map(|it| {
        let mut f = vec![("inlines", inlines(&it.inlines))];
        if let Some(c) = it.checked {
            f.push(("checked", c.to_string()));
        }
        f.push(("children", arr(it.children.iter().map(list))));
        f.push(("line", it.line.to_string()));
        obj(f)
    });
    obj(vec![
        ("kind", quote("list")),
        ("ordered", l.ordered.to_string()),
        ("start", es_string(l.start)),
        ("loose", l.loose.to_string()),
        ("items", arr(items)),
        ("line", l.line.to_string()),
    ])
}

fn cells(r: &[Cell]) -> String {
    arr(r.iter().map(|c| {
        let mut f = vec![("text", quote(&c.text))];
        if let Some(n) = c.num {
            f.push(("value", es_string(n)));
        }
        obj(f)
    }))
}

fn table(t: &Table) -> String {
    let mut f = vec![("columns", arr(t.columns.iter().map(|c| quote(c)))), ("rows", arr(t.rows.iter().map(|r| cells(r))))];
    if let Some(s) = &t.summary {
        f.push(("summary", cells(s)));
    }
    obj(f)
}

pub fn item(it: &Item) -> String {
    match it {
        Item::Paragraph(p) => obj(vec![("kind", quote("paragraph")), ("inlines", inlines(&p.inlines)), ("line", p.line.to_string())]),
        Item::Heading(h) => obj(vec![
            ("kind", quote("heading")),
            ("level", h.level.to_string()),
            ("id", quote(&h.id)),
            ("classes", arr(h.classes.iter().map(|c| quote(c)))),
            ("attrs", map(&h.attrs)),
            ("inlines", inlines(&h.inlines)),
            ("line", h.line.to_string()),
        ]),
        Item::List(l) => list(l),
        Item::Hidden(h) => obj(vec![("kind", quote("hidden")), ("text", quote(&h.text)), ("line", h.line.to_string())]),
        Item::Block(b) => {
            let mut f = vec![("kind", quote("block")), ("type", quote(&b.type_name))];
            if let Some(id) = &b.id {
                f.push(("id", quote(id)));
            }
            f.push(("classes", arr(b.classes.iter().map(|c| quote(c)))));
            f.push(("attrs", map(&b.attrs)));
            f.push((
                "mode",
                quote(match b.mode {
                    Mode::Raw => "raw",
                    Mode::Flow => "flow",
                    Mode::Data => "data",
                    Mode::Prose => "prose",
                }),
            ));
            match b.mode {
                Mode::Raw => f.push(("raw", arr(b.raw.iter().map(|l| quote(l))))),
                Mode::Flow | Mode::Prose => f.push(("children", arr(b.children.iter().map(item)))),
                Mode::Data => f.push(("data", map(&b.data))),
            }
            if let Some(v) = &b.value {
                f.push(("value", to_json(v)));
            }
            if let Some(t) = &b.table {
                f.push(("table", table(t)));
            }
            f.push(("line", b.line.to_string()));
            obj(f)
        }
    }
}

/// The whole document: its content, diagnostics, merged meta, ids and
/// addresses.
pub fn document(d: &Document) -> String {
    obj(vec![
        ("kind", quote("document")),
        ("children", arr(d.children.iter().map(item))),
        (
            "diagnostics",
            arr(d.diagnostics.iter().map(|x| {
                obj(vec![("code", quote(x.code)), ("severity", quote(x.severity.as_str())), ("line", x.line.to_string()), ("message", quote(&x.message))])
            })),
        ),
        ("meta", map(&d.meta)),
        ("ids", arr(d.ids.iter().map(|i| quote(i)))),
        ("addresses", arr(d.addresses.iter().map(|i| quote(i)))),
        ("name", quote(&d.name)),
        ("profiles", arr(d.profiles.iter().map(|i| quote(i)))),
        (
            "profileDiagnostics",
            arr(d.profile_diagnostics.iter().map(|x| {
                obj(vec![("code", quote(x.code)), ("severity", quote(x.level.as_str())), ("address", quote(&x.address)), ("message", quote(&x.message))])
            })),
        ),
    ])
}
