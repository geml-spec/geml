//! The document model read back from the JSON `to_json` writes: what `to`
//! takes as `json` input. Only this crate's own layout is read — the suite
//! leaves the model's JSON to each implementation, and compares it through its
//! projection — and anything that is not a document model is an error, never
//! a guess.

use crate::json::Value;
use crate::model::*;

type R<T> = Result<T, String>;

fn field<'a>(v: &'a Value, key: &str, what: &str) -> R<&'a Value> {
    v.get(key).ok_or_else(|| format!("{what} has no `{key}`"))
}

fn string(v: &Value, key: &str, what: &str) -> R<String> {
    match field(v, key, what)? {
        Value::String(s) => Ok(s.clone()),
        _ => Err(format!("{what}'s `{key}` is not a string")),
    }
}

fn opt_string(v: &Value, key: &str, what: &str) -> R<Option<String>> {
    match v.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{what}'s `{key}` is not a string")),
    }
}

fn array<'a>(v: &'a Value, key: &str, what: &str) -> R<&'a [Value]> {
    match field(v, key, what)? {
        Value::Array(a) => Ok(a),
        _ => Err(format!("{what}'s `{key}` is not an array")),
    }
}

fn number(v: &Value, key: &str, what: &str) -> R<f64> {
    match field(v, key, what)? {
        Value::Number(n) => Ok(*n),
        _ => Err(format!("{what}'s `{key}` is not a number")),
    }
}

fn boolean(v: &Value, key: &str, what: &str) -> R<bool> {
    match field(v, key, what)? {
        Value::Bool(b) => Ok(*b),
        _ => Err(format!("{what}'s `{key}` is not a boolean")),
    }
}

fn line(v: &Value) -> usize {
    match v.get("line") {
        Some(Value::Number(n)) if *n >= 0.0 => *n as usize,
        _ => 0,
    }
}

fn map(v: &Value, key: &str, what: &str) -> R<Vec<(String, Value)>> {
    match v.get(key) {
        None => Ok(Vec::new()),
        Some(Value::Object(m)) => Ok(m.clone()),
        Some(_) => Err(format!("{what}'s `{key}` is not an object")),
    }
}

fn strings(v: &Value, key: &str, what: &str) -> R<Vec<String>> {
    match v.get(key) {
        None => Ok(Vec::new()),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| match x {
                Value::String(s) => Ok(s.clone()),
                _ => Err(format!("{what}'s `{key}` holds a non-string")),
            })
            .collect(),
        Some(_) => Err(format!("{what}'s `{key}` is not an array")),
    }
}

fn inline(v: &Value) -> R<Inline> {
    let ty = string(v, "type", "an inline node")?;
    let what = format!("a `{ty}` node");
    let kids = |key: &str| -> R<Vec<Inline>> { array(v, key, &what)?.iter().map(inline).collect() };
    Ok(match ty.as_str() {
        "text" => Inline::Text(string(v, "value", &what)?),
        "emph" => Inline::Emph(kids("children")?),
        "strong" => Inline::Strong(kids("children")?),
        "strike" => Inline::Strike(kids("children")?),
        "code" => Inline::Code(string(v, "value", &what)?),
        "math" => Inline::Math(string(v, "value", &what)?),
        "break" => Inline::Break,
        "image" => Inline::Image { src: string(v, "src", &what)?, alt: kids("alt")? },
        "link" => Inline::Link {
            href: opt_string(v, "href", &what)?,
            doc: opt_string(v, "doc", &what)?,
            anchor: opt_string(v, "anchor", &what)?,
            children: kids("children")?,
        },
        "autoref" => Inline::AutoRef {
            doc: opt_string(v, "doc", &what)?,
            anchor: string(v, "anchor", &what)?,
            value: opt_string(v, "value", &what)?,
            base: opt_string(v, "base", &what)?,
        },
        "project" => Inline::Project {
            doc: opt_string(v, "doc", &what)?,
            anchor: string(v, "anchor", &what)?,
            value: opt_string(v, "value", &what)?,
            base: opt_string(v, "base", &what)?,
        },
        "footnote" => Inline::Footnote(string(v, "ref", &what)?),
        other => return Err(format!("`{other}` is not an inline node type")),
    })
}

fn inlines(v: &Value, what: &str) -> R<Vec<Inline>> {
    array(v, "inlines", what)?.iter().map(inline).collect()
}

fn list(v: &Value) -> R<List> {
    let what = "a list";
    let items = array(v, "items", what)?
        .iter()
        .map(|it| {
            let checked = match it.get("checked") {
                None => None,
                Some(Value::Bool(b)) => Some(*b),
                Some(_) => return Err("a list item's `checked` is not a boolean".to_string()),
            };
            let children = match it.get("children") {
                None => Vec::new(),
                Some(Value::Array(a)) => a.iter().map(list).collect::<R<Vec<_>>>()?,
                Some(_) => return Err("a list item's `children` is not an array".to_string()),
            };
            Ok(ListItem { source: String::new(), inlines: inlines(it, "a list item")?, checked, children, line: line(it) })
        })
        .collect::<R<Vec<_>>>()?;
    Ok(List { ordered: boolean(v, "ordered", what)?, start: number(v, "start", what)?, loose: boolean(v, "loose", what)?, items, line: line(v) })
}

fn block(v: &Value) -> R<Block> {
    let type_name = string(v, "type", "a typed block")?;
    let what = format!("a `{type_name}` block");
    let mode = match string(v, "mode", &what)?.as_str() {
        "raw" => Mode::Raw,
        "flow" => Mode::Flow,
        "data" => Mode::Data,
        "prose" => Mode::Prose,
        other => return Err(format!("{what}'s mode `{other}` is not a body mode")),
    };
    let mut b = Block {
        type_name,
        id: opt_string(v, "id", &what)?,
        classes: strings(v, "classes", &what)?,
        attrs: map(v, "attrs", &what)?,
        mode,
        raw: vec![],
        children: vec![],
        data: vec![],
        value: v.get("value").cloned(),
        table: None,
        line: line(v),
        body_start: 0,
        body_end: 0,
        end: 0,
    };
    match mode {
        Mode::Raw => b.raw = strings(v, "raw", &what)?,
        Mode::Flow | Mode::Prose => b.children = items(array(v, "children", &what)?)?,
        Mode::Data => b.data = map(v, "data", &what)?,
    }
    Ok(b)
}

fn item(v: &Value) -> R<Item> {
    if !matches!(v, Value::Object(_)) {
        return Err("an item of `children` is not an object".to_string());
    }
    let kind = string(v, "kind", "an item")?;
    Ok(match kind.as_str() {
        "paragraph" => Item::Paragraph(Paragraph { source: String::new(), inlines: inlines(v, "a paragraph")?, line: line(v), code: false }),
        "heading" => {
            let what = "a heading";
            let level = number(v, "level", what)?;
            if !(1.0..=6.0).contains(&level) || level.fract() != 0.0 {
                return Err(format!("a heading's level {level} is not 1 to 6"));
            }
            Item::Heading(Heading {
                level: level as usize,
                text: String::new(),
                inlines: inlines(v, what)?,
                id: string(v, "id", what)?,
                declared: true,
                classes: strings(v, "classes", what)?,
                attrs: map(v, "attrs", what)?,
                line: line(v),
                source: String::new(),
                head: 1,
            })
        }
        "list" => Item::List(list(v)?),
        "hidden" => Item::Hidden(Hidden { text: string(v, "text", "a hidden line")?, line: line(v) }),
        "block" => Item::Block(block(v)?),
        other => return Err(format!("`{other}` is not an item kind")),
    })
}

fn items(a: &[Value]) -> R<Vec<Item>> {
    a.iter().map(item).collect()
}

/// A document model's content, read from its JSON, or why the JSON is not one.
pub fn document(text: &str) -> R<Vec<Item>> {
    let v = crate::json::parse(text).map_err(|e| format!("not JSON: {e:?}"))?;
    if !matches!(v, Value::Object(_)) {
        return Err("the JSON is not an object".to_string());
    }
    if let Some(k) = v.get("kind") {
        if k != &Value::String("document".into()) {
            return Err("the JSON's `kind` is not `document`".to_string());
        }
    }
    match v.get("children") {
        Some(Value::Array(a)) => items(a),
        Some(_) => Err("the JSON's `children` is not an array".to_string()),
        None => Err("the JSON has no `children`: it is not a document model".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let src = "=== meta\ntitle = Doc\n===\n\n# Tiny {#tiny .c k=v}\n\nA *word* [here](#tiny), `x` and [[#n]].\n\n- a\n- [x] b\n  - c\n\n%% note\n\n=== note {#n}\nbody\n===\n\n=== code {lang=sh}\nls\n===\n";
        let doc = crate::parse(src);
        let back = document(&crate::to_json(&doc)).expect("a model");
        let canon = crate::edit::serialize::serialize(&doc.children);
        assert_eq!(crate::edit::serialize::serialize(&back), canon);
    }

    #[test]
    fn refusals() {
        for bad in [
            "{}",
            "[]",
            "1",
            "{\"children\": 3}",
            "{\"kind\": \"x\", \"children\": []}",
            "{\"children\": [{\"kind\": \"nope\"}]}",
            "{\"children\": [7]}",
            "not json",
        ] {
            assert!(document(bad).is_err(), "{bad}");
        }
        assert!(document("{\"children\": []}").is_ok());
        let e = document("{\"children\": [{\"kind\": \"heading\", \"level\": 9, \"id\": \"x\", \"inlines\": []}]}").unwrap_err();
        assert!(e.contains("level"), "{e}");
        assert!(document("{\"children\": [{\"kind\": \"paragraph\", \"inlines\": [{\"type\": \"zap\"}]}]}").is_err());
        assert!(document("{\"children\": [{\"kind\": \"block\", \"type\": \"note\", \"mode\": \"odd\"}]}").is_err());
    }
}
