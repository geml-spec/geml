//! Selector TEXT, decided by lexis alone — never by a document: `#id`, a
//! pasted heading line, `=== type`, `@<hex>` (and `=== type@<hex>`), `L27` /
//! `L27-58`, an attribute filter in braces, and a coordinate `#fy[2]["Q1"]`
//! (GEP 0011). The forms are the ones a listing prints, so every address it
//! prints pastes straight back.

use crate::attrs::{read_object, Attrs};
use crate::json::Value;

#[derive(Clone, Debug, PartialEq)]
pub enum CoordStep {
    Index(usize),
    Key(String),
    Word(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Selector {
    /// No selector: the empty filter, which lists.
    List,
    /// `#id` / `id` / `## Heading` — resolved against the document by the
    /// caller. `type_name` is the prefix of `=== note {#id}`: a CHECK.
    Id { raw: String, type_name: Option<String> },
    /// `=== type` — every block of the type.
    Type(String),
    /// `@<hex>[~n]`, with or without a type prefix.
    Content { type_name: Option<String>, hex: String, nth: usize },
    /// `L<n>` / `L<n>-<m>` — the smallest unit holding the range.
    Line { from: usize, to: usize },
    /// `=== code {lang=py}`, `{.warn}`, … — every key must hold.
    Attr { type_name: Option<String>, id: Option<String>, content: Vec<(String, usize)>, classes: Vec<String>, attrs: Vec<(String, Value)>, keys: Vec<String> },
    /// A unit INSIDE a block: its base id form, then the bracket path.
    Coord { base: String, path: Vec<CoordStep> },
}

fn is_hex(c: char) -> bool {
    c.is_ascii_hexdigit()
}

/// `@<hex>` with an optional `~n`: the hex (lowercased) and n.
fn bare_at(s: &str) -> Option<(String, usize)> {
    let rest = s.strip_prefix('@')?;
    let hex_len = rest.chars().take_while(|c| is_hex(*c)).count();
    if hex_len == 0 {
        return None;
    }
    let hex = rest[..hex_len].to_ascii_lowercase();
    let tail = &rest[hex_len..];
    if tail.is_empty() {
        return Some((hex, 0));
    }
    let n = tail.strip_prefix('~')?;
    if n.is_empty() || !n.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((hex, n.parse().ok()?))
}

fn skip_space_tab(s: &str) -> &str {
    s.trim_start_matches([' ', '\t'])
}

/// `=== type`, `=== type@<hex>`, `=== type {…}`, `=== type@<hex> {…}`.
fn fence_sel(s: &str) -> Option<(String, Option<String>, Option<String>)> {
    let run = s.chars().take_while(|c| *c == '=').count();
    if run < 3 {
        return None;
    }
    let rest = skip_space_tab(&s[run..]);
    let mut chars = rest.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let type_len = 1 + rest[1..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').count();
    let type_name = rest[..type_len].to_string();
    let mut rest = skip_space_tab(&rest[type_len..]);
    let mut at = None;
    if rest.starts_with('@') {
        let len = rest.chars().take_while(|c| !c.is_whitespace() && *c != '{').count();
        let token = &rest[..len];
        bare_at(token)?;
        at = Some(token.to_string());
        rest = skip_space_tab(&rest[len..]);
    }
    let mut braces = None;
    if !rest.is_empty() {
        if !rest.starts_with('{') {
            return None;
        }
        let close = rest.rfind('}')?;
        if !skip_space_tab(&rest[close + 1..]).is_empty() {
            return None;
        }
        braces = Some(rest[..=close].to_string());
    }
    Some((type_name, at, braces))
}

/// `L27` / `L27-58`.
fn bare_line(s: &str) -> Option<(usize, usize)> {
    let rest = s.strip_prefix(['L', 'l'])?;
    let (a, b) = match rest.split_once('-') {
        Some((a, b)) => (a, Some(b)),
        None => (rest, None),
    };
    if a.is_empty() || !a.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let from: usize = a.parse().ok()?;
    let to = match b {
        Some(b) => {
            if b.is_empty() || !b.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            b.parse().ok()?
        }
        None => from,
    };
    Some((from, to))
}

/// One `[…]` step after another; `None` when the tail is not a path.
pub fn parse_coord_path(tail: &str) -> Option<Vec<CoordStep>> {
    let mut path = Vec::new();
    let mut rest = tail;
    while !rest.is_empty() {
        let inner = skip_space_tab(rest.strip_prefix('[')?);
        let (step, after) = if let Some(q) = inner.strip_prefix('"') {
            let end = q.find('"')?;
            (CoordStep::Key(q[..end].to_string()), &q[end + 1..])
        } else {
            let digits = inner.chars().take_while(|c| c.is_ascii_digit()).count();
            if digits > 0 {
                (CoordStep::Index(inner[..digits].parse().ok()?), &inner[digits..])
            } else {
                let first = inner.chars().next()?;
                if !first.is_ascii_alphabetic() {
                    return None;
                }
                let len = 1 + inner[1..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').count();
                (CoordStep::Word(inner[..len].to_string()), &inner[len..])
            }
        };
        let after = skip_space_tab(after);
        rest = after.strip_prefix(']')?.trim_start();
        path.push(step);
    }
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Split on White_Space outside double quotes, keeping the quotes.
fn tokenize(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if in_quote && ch == '\\' && i + 1 < chars.len() && (chars[i + 1] == '"' || chars[i + 1] == '\\') {
            cur.push(ch);
            cur.push(chars[i + 1]);
            i += 1;
        } else if ch == '"' {
            in_quote = !in_quote;
            cur.push(ch);
        } else if !in_quote && crate::uni::is_ws(ch) {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(ch);
        }
        i += 1;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn inner_of(braces: &str) -> &str {
    braces.trim().strip_prefix('{').and_then(|s| s.strip_suffix('}')).unwrap_or(braces)
}

fn attrs_of(braces: &str) -> Attrs {
    let chars: Vec<char> = inner_of(braces).chars().collect();
    read_object(&chars)
}

/// A braced key, with or without a type in front: `{#id}` is `#id` written
/// long, `{@<hex>}` is `@<hex>`; anything else is an attribute filter.
fn key_form(braces: &str, type_name: Option<String>, outer_at: Option<String>) -> Selector {
    let tokens = tokenize(inner_of(braces));
    let keys: Vec<String> = match &outer_at {
        Some(at) => std::iter::once(at.clone()).chain(tokens).collect(),
        None => tokens,
    };
    let a = attrs_of(braces);
    if keys.len() == 1 {
        if let Some(id) = &a.id {
            return Selector::Id { raw: format!("#{id}"), type_name };
        }
        if let Some((hex, nth)) = bare_at(inner_of(braces).trim()) {
            return Selector::Content { type_name, hex, nth };
        }
    }
    let mut content = Vec::new();
    let mut rest = Vec::new();
    for k in &keys {
        match bare_at(k) {
            Some(c) => content.push(c),
            None => rest.push(k.clone()),
        }
    }
    let a = attrs_of(&format!("{{{}}}", rest.join(" ")));
    Selector::Attr { type_name, id: a.id, content, classes: a.classes, attrs: a.kv, keys }
}

fn braced(s: &str) -> bool {
    s.starts_with('{') && s.ends_with('}')
}

/// Parse selector text.
pub fn parse_selector(raw: &str) -> Selector {
    let s = raw.trim();
    if s.is_empty() {
        return Selector::List;
    }
    if let Some((hex, nth)) = bare_at(s) {
        return Selector::Content { type_name: None, hex, nth };
    }
    if let Some((type_name, at, braces)) = fence_sel(s) {
        if let Some(b) = braces {
            return key_form(&b, Some(type_name), at);
        }
        if let Some(at) = at {
            let (hex, nth) = bare_at(&at).expect("checked by fence_sel");
            return Selector::Content { type_name: Some(type_name), hex, nth };
        }
        return Selector::Type(type_name);
    }
    if let Some((from, to)) = bare_line(s) {
        // Reject rather than clamp: `L0` and `L10-5` are typos.
        if from >= 1 && to >= from {
            return Selector::Line { from, to };
        }
    }
    if let Some(bracket) = s.find('[') {
        if bracket > 0 {
            if let Some(path) = parse_coord_path(&s[bracket..]) {
                let head = s[..bracket].trim_end();
                if braced(head) {
                    if let Selector::Id { raw, .. } = key_form(head, None, None) {
                        return Selector::Coord { base: raw, path };
                    }
                }
                return Selector::Coord { base: head.to_string(), path };
            }
        }
    }
    if braced(s) {
        return key_form(s, None, None);
    }
    Selector::Id { raw: s.to_string(), type_name: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forms() {
        assert_eq!(parse_selector(""), Selector::List);
        assert_eq!(parse_selector("#a"), Selector::Id { raw: "#a".into(), type_name: None });
        assert_eq!(parse_selector("a"), Selector::Id { raw: "a".into(), type_name: None });
        assert_eq!(parse_selector("## Sub"), Selector::Id { raw: "## Sub".into(), type_name: None });
        assert_eq!(parse_selector("=== note"), Selector::Type("note".into()));
        assert_eq!(parse_selector("@AbCd~2"), Selector::Content { type_name: None, hex: "abcd".into(), nth: 2 });
        assert_eq!(parse_selector("=== note@ab12"), Selector::Content { type_name: Some("note".into()), hex: "ab12".into(), nth: 0 });
        assert_eq!(parse_selector("=== note {#x}"), Selector::Id { raw: "#x".into(), type_name: Some("note".into()) });
        assert_eq!(parse_selector("{@ab12}"), Selector::Content { type_name: None, hex: "ab12".into(), nth: 0 });
        assert_eq!(parse_selector("L27-58"), Selector::Line { from: 27, to: 58 });
        assert_eq!(parse_selector("l5"), Selector::Line { from: 5, to: 5 });
        assert_eq!(parse_selector("L10-5"), Selector::Id { raw: "L10-5".into(), type_name: None });
        match parse_selector("=== code {lang=py}") {
            Selector::Attr { type_name, classes, attrs, keys, .. } => {
                assert_eq!(type_name.as_deref(), Some("code"));
                assert!(classes.is_empty());
                assert_eq!(attrs.len(), 1);
                assert_eq!(keys, vec!["lang=py"]);
            }
            other => panic!("{other:?}"),
        }
        match parse_selector("{.warn #x}") {
            Selector::Attr { id, classes, keys, .. } => {
                assert_eq!(id.as_deref(), Some("x"));
                assert_eq!(classes, vec!["warn"]);
                assert_eq!(keys.len(), 2);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(parse_selector("#fy[2][\"Q1\"]"), Selector::Coord { base: "#fy".into(), path: vec![CoordStep::Index(2), CoordStep::Key("Q1".into())] });
        assert_eq!(parse_selector("{#fy}[summary]"), Selector::Coord { base: "#fy".into(), path: vec![CoordStep::Word("summary".into())] });
        assert_eq!(parse_selector("{}"), Selector::Attr { type_name: None, id: None, content: vec![], classes: vec![], attrs: vec![], keys: vec![] });
    }

    #[test]
    fn tokenizer_keeps_quoted_space() {
        assert_eq!(tokenize("a \"b c\" d"), vec!["a", "\"b c\"", "d"]);
        assert_eq!(tokenize("k=\"x\\\"y\""), vec!["k=\"x\\\"y\""]);
    }
}
