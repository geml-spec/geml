//! The value tree (§3.2) and its JSON.
//!
//! A value is JSON's domain within I-JSON's limits: a map never holds a key
//! twice, no string holds a lone surrogate, a number is a finite binary64.
//! Maps keep the order their keys were written in; the conformance projection
//! sorts them by UTF-16 code unit when it prints them.

use crate::bounds::DATA_DEPTH;
use crate::num::es_string;
use crate::uni::cmp_utf16;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}

impl Value {
    /// The text a reference to this value says (§5.2): a string as itself, a
    /// number as ECMAScript prints it, a boolean or null as its keyword.
    pub fn scalar_text(&self) -> Option<String> {
        match self {
            Value::Null => Some("null".into()),
            Value::Bool(b) => Some(b.to_string()),
            Value::Number(n) => Some(es_string(*n)),
            Value::String(s) => Some(s.clone()),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

/// JSON-escape a string the way `JSON.stringify` does.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Serialize with map keys in the order they were written.
pub fn to_json(v: &Value) -> String {
    let mut out = String::new();
    write_value(v, false, &mut out);
    out
}

/// Serialize with every map's keys sorted by UTF-16 code unit — the
/// conformance projection's `canonicalJson`.
pub fn canonical(v: &Value) -> String {
    let mut out = String::new();
    write_value(v, true, &mut out);
    out
}

fn write_value(v: &Value, sorted: bool, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if n.is_finite() {
                out.push_str(&es_string(*n))
            } else {
                out.push_str("null")
            }
        }
        Value::String(s) => out.push_str(&quote(s)),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(x, sorted, out);
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut entries: Vec<&(String, Value)> = m.iter().collect();
            if sorted {
                entries.sort_by(|a, b| cmp_utf16(&a.0, &b.0));
            }
            out.push('{');
            for (i, (k, x)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&quote(k));
                out.push(':');
                write_value(x, sorted, out);
            }
            out.push('}');
        }
    }
}

/// Why a body is not one I-JSON value, and on which line (0-based, within the
/// text that was parsed).
#[derive(Debug, PartialEq)]
pub struct JsonError {
    pub line: usize,
    pub message: String,
}

/// Parse exactly one I-JSON value from `text` (RFC 8259 grammar, RFC 7493
/// limits).
pub fn parse(text: &str) -> Result<Value, JsonError> {
    parse_as(text, true)
}

/// Whether `text` is one JSON value by RFC 8259's grammar, whatever I-JSON's
/// limits say of it: what tells a value the domain excludes from text that is
/// not JSON at all. The depth bound still holds, so a caller judges depth
/// first (`too_deep`).
pub fn is_json(text: &str) -> bool {
    parse_as(text, false).is_ok()
}

/// The byte offset of the bracket that opens level `DATA_DEPTH` + 1, read
/// off the text alone — strings skipped — so a tree too deep to keep is
/// refused before one is built.
pub fn too_deep(text: &str) -> Option<usize> {
    let s = text.as_bytes();
    let mut depth: i64 = 0;
    let mut i = 0;
    while i < s.len() {
        match s[i] {
            b'"' => {
                i += 1;
                while i < s.len() && s[i] != b'"' {
                    i += if s[i] == b'\\' { 2 } else { 1 };
                }
            }
            b'{' | b'[' => {
                depth += 1;
                if depth > DATA_DEPTH as i64 {
                    return Some(i);
                }
            }
            b'}' | b']' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    None
}

/// The number literals of a JSON text, with their byte offsets; strings are
/// skipped.
pub fn number_literals(text: &str) -> Vec<(usize, &str)> {
    let s = text.as_bytes();
    let digits = |mut k: usize| {
        let from = k;
        while k < s.len() && s[k].is_ascii_digit() {
            k += 1;
        }
        (k > from).then_some(k)
    };
    let mut out = Vec::new();
    let mut i = 0;
    while i < s.len() {
        match s[i] {
            b'"' => {
                i += 1;
                while i < s.len() && s[i] != b'"' {
                    i += if s[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            b'-' | b'0'..=b'9' => {
                let Some(mut k) = digits(if s[i] == b'-' { i + 1 } else { i }) else {
                    i += 1;
                    continue;
                };
                if s.get(k) == Some(&b'.') {
                    if let Some(f) = digits(k + 1) {
                        k = f;
                    }
                }
                if matches!(s.get(k), Some(b'e' | b'E')) {
                    let sign = usize::from(matches!(s.get(k + 1), Some(b'+' | b'-')));
                    if let Some(e) = digits(k + 1 + sign) {
                        k = e;
                    }
                }
                out.push((i, &text[i..k]));
                i = k;
            }
            _ => i += 1,
        }
    }
    out
}

fn parse_as(text: &str, strict: bool) -> Result<Value, JsonError> {
    let mut p = Parser { s: text.as_bytes(), text, i: 0, depth: 0, strict };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != p.s.len() {
        return Err(p.err("unexpected text after the value"));
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    text: &'a str,
    i: usize,
    depth: usize,
    /// I-JSON's limits apply: no name twice in one object, no lone
    /// surrogate, no number past binary64's range.
    strict: bool,
}

impl<'a> Parser<'a> {
    fn err(&self, msg: &str) -> JsonError {
        // Counted over bytes, so the count holds wherever `i` stands; a `str`
        // slice panics off a character boundary.
        let line = self.s[..self.i.min(self.s.len())].iter().filter(|b| **b == b'\n').count();
        JsonError { line, message: msg.to_string() }
    }

    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn value(&mut self) -> Result<Value, JsonError> {
        match self.s.get(self.i) {
            None => Err(self.err("expected a value")),
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(b't') => self.keyword("true", Value::Bool(true)),
            Some(b'f') => self.keyword("false", Value::Bool(false)),
            Some(b'n') => self.keyword("null", Value::Null),
            Some(c) if *c == b'-' || c.is_ascii_digit() => self.number(),
            Some(_) => Err(self.err("expected a value")),
        }
    }

    fn keyword(&mut self, word: &str, v: Value) -> Result<Value, JsonError> {
        if self.s[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(self.err("expected a value"))
        }
    }

    fn enter(&mut self) -> Result<(), JsonError> {
        self.depth += 1;
        if self.depth > DATA_DEPTH {
            return Err(self.err(&format!("a sequence or map inside {DATA_DEPTH} others is outside the value tree")));
        }
        Ok(())
    }

    fn object(&mut self) -> Result<Value, JsonError> {
        self.enter()?;
        self.i += 1;
        let mut m: Vec<(String, Value)> = Vec::new();
        self.ws();
        if self.s.get(self.i) == Some(&b'}') {
            self.i += 1;
            self.depth -= 1;
            return Ok(Value::Object(m));
        }
        loop {
            self.ws();
            if self.s.get(self.i) != Some(&b'"') {
                return Err(self.err("expected a member name"));
            }
            let k = self.string()?;
            if self.strict && m.iter().any(|(x, _)| *x == k) {
                return Err(self.err(&format!("the name {} occurs twice in one object", quote(&k))));
            }
            self.ws();
            if self.s.get(self.i) != Some(&b':') {
                return Err(self.err("expected `:`"));
            }
            self.i += 1;
            self.ws();
            let v = self.value()?;
            m.push((k, v));
            self.ws();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    self.depth -= 1;
                    return Ok(Value::Object(m));
                }
                _ => return Err(self.err("expected `,` or `}`")),
            }
        }
    }

    fn array(&mut self) -> Result<Value, JsonError> {
        self.enter()?;
        self.i += 1;
        let mut a = Vec::new();
        self.ws();
        if self.s.get(self.i) == Some(&b']') {
            self.i += 1;
            self.depth -= 1;
            return Ok(Value::Array(a));
        }
        loop {
            self.ws();
            a.push(self.value()?);
            self.ws();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    self.depth -= 1;
                    return Ok(Value::Array(a));
                }
                _ => return Err(self.err("expected `,` or `]`")),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        // Four hex digits, each one read on its own: `from_str_radix` on the
        // run also takes a leading `+`.
        let v = self.s.get(self.i..self.i + 4).and_then(|h| h.iter().try_fold(0, |v, d| (*d as char).to_digit(16).map(|d| v * 16 + d)));
        let Some(v) = v else { return Err(self.err("a \\u escape needs four hex digits")) };
        self.i += 4;
        Ok(v)
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.i += 1; // opening quote
        let mut out = String::new();
        loop {
            let Some(&c) = self.s.get(self.i) else {
                return Err(self.err("unterminated string"));
            };
            match c {
                b'"' => {
                    self.i += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.i += 1;
                    let Some(&e) = self.s.get(self.i) else {
                        return Err(self.err("unterminated string"));
                    };
                    // Every escape is one ASCII character; anything else is
                    // refused where it stands, never stepped into.
                    if !e.is_ascii() {
                        return Err(self.err("unknown escape"));
                    }
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            if (0xD800..0xDC00).contains(&hi) {
                                if self.s[self.i..].starts_with(b"\\u") {
                                    self.i += 2;
                                    let lo = self.hex4()?;
                                    if (0xDC00..0xE000).contains(&lo) {
                                        let cp = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
                                        out.push(char::from_u32(cp).expect("a surrogate pair is a scalar"));
                                        continue;
                                    }
                                }
                                if self.strict {
                                    return Err(self.err("a lone surrogate is not a character"));
                                }
                                out.push(char::REPLACEMENT_CHARACTER);
                                continue;
                            }
                            if (0xDC00..0xE000).contains(&hi) {
                                if self.strict {
                                    return Err(self.err("a lone surrogate is not a character"));
                                }
                                out.push(char::REPLACEMENT_CHARACTER);
                                continue;
                            }
                            out.push(char::from_u32(hi).expect("a BMP scalar"));
                        }
                        _ => return Err(self.err("unknown escape")),
                    }
                }
                c if c < 0x20 => return Err(self.err("a control character must be escaped")),
                _ => {
                    // Copy one UTF-8 scalar.
                    let rest = &self.text[self.i..];
                    let ch = rest.chars().next().expect("in bounds");
                    out.push(ch);
                    self.i += ch.len_utf8();
                }
            }
        }
    }

    fn number(&mut self) -> Result<Value, JsonError> {
        let start = self.i;
        if self.s[self.i] == b'-' {
            self.i += 1;
        }
        match self.s.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(c) if c.is_ascii_digit() => {
                while self.s.get(self.i).is_some_and(|c| c.is_ascii_digit()) {
                    self.i += 1;
                }
            }
            _ => return Err(self.err("bad number")),
        }
        if self.s.get(self.i) == Some(&b'.') {
            self.i += 1;
            let f = self.i;
            while self.s.get(self.i).is_some_and(|c| c.is_ascii_digit()) {
                self.i += 1;
            }
            if f == self.i {
                return Err(self.err("bad number"));
            }
        }
        if matches!(self.s.get(self.i), Some(b'e') | Some(b'E')) {
            self.i += 1;
            if matches!(self.s.get(self.i), Some(b'+') | Some(b'-')) {
                self.i += 1;
            }
            let e = self.i;
            while self.s.get(self.i).is_some_and(|c| c.is_ascii_digit()) {
                self.i += 1;
            }
            if e == self.i {
                return Err(self.err("bad number"));
            }
        }
        let v: f64 = self.text[start..self.i].parse().map_err(|_| self.err("bad number"))?;
        if self.strict && !v.is_finite() {
            return Err(self.err("a number past the range of binary64 has no value"));
        }
        Ok(Value::Number(v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_prints() {
        let v = parse(r#"{"b": 1, "10": [true, false, null, "x\u00e9\ud83d\ude00", 1.5e2, -0.5]}"#).unwrap();
        assert_eq!(canonical(&v), r#"{"10":[true,false,null,"xé😀",150,-0.5],"b":1}"#);
        assert_eq!(to_json(&v), r#"{"b":1,"10":[true,false,null,"xé😀",150,-0.5]}"#);
        assert_eq!(quote("a\"\\\n\r\t\u{8}\u{c}\u{1}é"), "\"a\\\"\\\\\\n\\r\\t\\b\\f\\u0001é\"");
        assert_eq!(to_json(&Value::Number(f64::NAN)), "null");
        assert_eq!(parse(r#""\/""#).unwrap(), Value::String("/".into()));
        assert_eq!(parse("[]").unwrap(), Value::Array(vec![]));
        assert_eq!(parse("{}").unwrap(), Value::Object(vec![]));
        assert_eq!(parse("0").unwrap(), Value::Number(0.0));
        assert_eq!(parse("\"\\b\\f\\r\\t\"").unwrap(), Value::String("\u{8}\u{c}\r\t".into()));
        assert!(parse("{\"a\":1 x}").is_err());
        assert!(parse("[1 x]").is_err());
    }

    #[test]
    fn keeps_i_json_limits() {
        for bad in [
            "",
            "{",
            "[1,]",
            "{\"a\":1,,}",
            "{\"a\" 1}",
            "{1:2}",
            "[1 2]",
            "\"abc",
            "\"\\x\"",
            "tru",
            "nul",
            "-",
            "01",
            "1.",
            "1e",
            "1e400",
            "[\"\\ud800\"]",
            "[\"\\udc00\"]",
            "[\"\\ud800\\u0041\"]",
            "\"\\u12\"",
            "\"\\u12zz\"",
            "{\"a\":1,\"a\":2}",
            "{\"a\":1,\"\\u0061\":2}",
            "\"\u{1}\"",
            "1 2",
            "\"\\",
            "@",
        ] {
            assert!(parse(bad).is_err(), "{bad:?} should fail");
        }
        let deep = "[".repeat(600) + &"]".repeat(600);
        assert!(parse(&deep).is_err());
        let e = parse("{\n\"a\": 1,\n\"a\": 2}").unwrap_err();
        assert_eq!(e.line, 2);
        assert_eq!(Value::Bool(true).scalar_text().as_deref(), Some("true"));
        assert_eq!(Value::Null.scalar_text().as_deref(), Some("null"));
        assert_eq!(Value::Array(vec![]).scalar_text(), None);
        assert!(Value::Null.get("x").is_none());
    }
}
