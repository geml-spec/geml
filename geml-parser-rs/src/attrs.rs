//! The attribute object `{#id .class key=val flag}` (§3.1, §4).

use crate::json::Value;
use crate::num::parse_bare_number;
use crate::uni::{is_name, nfd};

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Attrs {
    pub id: Option<String>,
    pub classes: Vec<String>,
    pub kv: Vec<(String, Value)>,
    /// `(code, message)` for each problem the object itself carries.
    pub issues: Vec<(&'static str, String)>,
}

/// §4's value typing: a quoted value is a string, `true`/`false` a boolean, a
/// bare word of `number` shape a number, any other bare word a string.
pub fn type_bare(word: &str) -> Value {
    match word {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        _ => match parse_bare_number(word) {
            Some(n) => Value::Number(n),
            None => Value::String(word.to_string()),
        },
    }
}

/// Read a quoted string starting at `chars[i] == '"'`. Only `\"` and `\\` are
/// escapes; any other backslash is itself. Returns the string and the index
/// after the closing quote, or `None` when it never closes.
pub fn read_quoted(chars: &[char], mut i: usize) -> Option<(String, usize)> {
    i += 1;
    let mut out = String::new();
    while i < chars.len() {
        match chars[i] {
            '"' => return Some((out, i + 1)),
            '\\' if i + 1 < chars.len() && (chars[i + 1] == '"' || chars[i + 1] == '\\') => {
                out.push(chars[i + 1]);
                i += 2;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    None
}

/// §4, reading an attribute object, step 2: the items of the text between its
/// braces. White_Space separates them except inside a quoted span — a `"`
/// anywhere opens one, the next `"` that `\` does not escape closes it, and one
/// left open runs to the end.
fn items(inner: &[char]) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut i = 0;
    while i < inner.len() {
        let c = inner[i];
        if quoted && c == '\\' && i + 1 < inner.len() && (inner[i + 1] == '"' || inner[i + 1] == '\\') {
            cur.push(c);
            cur.push(inner[i + 1]);
            i += 2;
            continue;
        }
        if c == '"' {
            quoted = !quoted;
            cur.push(c);
        } else if !quoted && c.is_whitespace() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(c);
        }
        i += 1;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// §4, step 3: a value that begins and ends with `"` is a quoted string — the
/// text between, `\"` read as `"` and `\\` as `\`; any other value is a bare
/// word, verbatim, typed as §4 types bare words.
fn value_of(v: &str) -> Value {
    let cs: Vec<char> = v.chars().collect();
    if cs.len() >= 2 && cs[0] == '"' && cs[cs.len() - 1] == '"' {
        let inner = &cs[1..cs.len() - 1];
        let mut out = String::new();
        let mut i = 0;
        while i < inner.len() {
            if inner[i] == '\\' && i + 1 < inner.len() && (inner[i + 1] == '"' || inner[i + 1] == '\\') {
                out.push(inner[i + 1]);
                i += 2;
            } else {
                out.push(inner[i]);
                i += 1;
            }
        }
        return Value::String(out);
    }
    type_bare(v)
}

/// Read the text between an attribute object's braces (§4, steps 2 and 3). An
/// id begins with `#` and a class with `.`; an item with `=` after its first
/// character is `key=value`, split at its first `=`; any other is a flag. Of two
/// ids, or two items naming one key, the first is read. A name that is not a
/// NAME is still read and is reported once for the id read, each class and each
/// key read; a NAME written twice is reported once.
pub fn read_object(inner: &[char]) -> Attrs {
    let mut a = Attrs::default();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut reported: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut stored: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut note_name = |a: &mut Attrs, name: &str| {
        let key = nfd(name);
        if !seen.insert(key.clone()) && reported.insert(key) {
            a.issues.push(("duplicate-name", format!("`{name}` is written more than once in one attribute object")));
        }
    };
    for item in items(inner) {
        if let Some(id) = item.strip_prefix('#') {
            if a.id.is_none() {
                if !is_name(id) {
                    a.issues.push(("name-not-a-name", format!("the id `{id}` is not a NAME")));
                }
                a.id = Some(id.to_string());
            }
        } else if let Some(class) = item.strip_prefix('.') {
            if !is_name(class) {
                a.issues.push(("name-not-a-name", format!("the class `{class}` is not a NAME")));
            }
            note_name(&mut a, class);
            a.classes.push(class.to_string());
        } else {
            let (key, value) = match item.find('=').filter(|e| *e > 0) {
                Some(e) => (item[..e].to_string(), value_of(&item[e + 1..])),
                None => (item.clone(), Value::Bool(true)),
            };
            note_name(&mut a, &key);
            if stored.insert(nfd(&key)) {
                if !is_name(&key) {
                    a.issues.push(("name-not-a-name", format!("the attribute key `{key}` is not a NAME")));
                }
                a.kv.push((key, value));
            }
        }
    }
    // §4: the empty string is never an id. `{#}` reads as if no id were written
    // (its `name-not-a-name` warning stands: what was written is not a NAME).
    if a.id.as_deref() == Some("") {
        a.id = None;
    }
    a
}

/// An attribute object starting at `chars[start] == '{'` that closes at the
/// first `}` outside a quoted span — the object after a link or an image (§4,
/// step 1). Returns the object and the index just past its `}`, or `None` when
/// no such `}` closes it.
pub fn parse_attrs(chars: &[char], start: usize) -> Option<(Attrs, usize)> {
    debug_assert_eq!(chars.get(start), Some(&'{'));
    let mut quoted = false;
    let mut k = start + 1;
    while k < chars.len() {
        let c = chars[k];
        if quoted && c == '\\' && k + 1 < chars.len() && (chars[k + 1] == '"' || chars[k + 1] == '\\') {
            k += 2;
            continue;
        }
        if c == '"' {
            quoted = !quoted;
        } else if !quoted && c == '}' {
            return Some((read_object(&chars[start + 1..k]), k + 1));
        }
        k += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Option<(Attrs, usize)> {
        let c: Vec<char> = s.chars().collect();
        parse_attrs(&c, 0)
    }

    #[test]
    fn reads_every_item_kind() {
        let (a, end) = p("{#n .a .b caption=\"Hi there\" n=3 t=true f=false flag word=bare}rest").unwrap();
        assert_eq!(end, 63);
        assert_eq!(a.id.as_deref(), Some("n"));
        assert_eq!(a.classes, vec!["a", "b"]);
        assert_eq!(a.kv[0], ("caption".into(), Value::String("Hi there".into())));
        assert_eq!(a.kv[1], ("n".into(), Value::Number(3.0)));
        assert_eq!(a.kv[2].1, Value::Bool(true));
        assert_eq!(a.kv[3].1, Value::Bool(false));
        assert_eq!(a.kv[4], ("flag".into(), Value::Bool(true)));
        assert_eq!(a.kv[5].1, Value::String("bare".into()));
        assert!(a.issues.is_empty());
    }

    #[test]
    fn quoted_values_escape_only_quote_and_backslash() {
        let (a, _) = p(r#"{caption="say \"hi\" \\ \n ok"}"#).unwrap();
        assert_eq!(a.kv[0].1, Value::String("say \"hi\" \\ \\n ok".into()));
        assert_eq!(read_quoted(&['"', 'a'], 0), None);
    }

    #[test]
    fn problems_are_reported_not_fatal() {
        let (a, _) = p("{#a & b}").unwrap();
        assert_eq!(a.id.as_deref(), Some("a"));
        assert_eq!(a.issues.iter().filter(|i| i.0 == "name-not-a-name").count(), 1);
        let (a, _) = p("{.link link=http://x link}").unwrap();
        assert_eq!(a.issues, vec![("duplicate-name", "`link` is written more than once in one attribute object".to_string())]);
        assert_eq!(a.kv.len(), 1);
        let (a, _) = p("{#a .a}").unwrap();
        assert!(a.issues.is_empty());
        // Of two ids the first is read; only the id read is checked.
        let (a, _) = p("{#a #b #?}").unwrap();
        assert_eq!(a.id.as_deref(), Some("a"));
        assert!(a.issues.is_empty());
        let (a, _) = p("{#? #b}").unwrap();
        assert_eq!(a.id.as_deref(), Some("?"));
        assert_eq!(a.issues.len(), 1);
        let (a, _) = p("{.? =x}").unwrap();
        assert_eq!(a.issues.len(), 2);
        assert!(p("{#a").is_none());
        assert!(p("{a=\"x}").is_none());
        // The object closes at the first `}` outside a quoted span (§4 step 1).
        assert_eq!(p("{a{b}").map(|(a, end)| (a.kv.len(), end)), Some((1, 5)));
        assert_eq!(p("{\"x\"}").map(|(a, _)| a.issues.len()), Some(1));
        assert!(p("{").is_none());
    }

    #[test]
    fn typing() {
        assert_eq!(type_bare("1.2.3"), Value::String("1.2.3".into()));
        assert_eq!(type_bare("+5"), Value::Number(5.0));
        assert_eq!(type_bare("5."), Value::Number(5.0));
        assert_eq!(type_bare("0x1f"), Value::String("0x1f".into()));
    }
}
