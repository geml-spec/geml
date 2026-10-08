//! An EDN subset, for the `data` block's `edn` format (§3.2). The
//! specification reserves the name and defines no reading; this is the
//! reference implementation's reading, so a body reads the same here as there.
//!
//! In the subset, and how each kind reads:
//!   nil / true / false          -> null / boolean
//!   integers, floats            -> number
//!   strings                     -> string
//!   keywords  `:k`, `:ns/k`     -> the string WITH its colon, `":k"`
//!   vectors   `[…]`             -> array
//!   sets      `#{…}`            -> {"$set": [ … ]}
//!   maps      `{…}`             -> object
//!   `#uuid "…"`                 -> {"$uuid": "…"}
//!   `#inst "…"`                 -> {"$inst": "…"}
//!   `;` comments, `#_` discard, and commas as whitespace
//!
//! A keyword keeps its colon and a wrapper its `$` key so the reading stays
//! reversible; a string key beginning with `:` or `$` would collide with one,
//! and is refused. Lists, symbols, characters, bignums, ratios and other
//! tagged literals are refused by name.

use crate::bounds::DATA_DEPTH;
use crate::json::{quote, Value};
use crate::num::{es_string, NumberRead};

const WRAP_SET: &str = "$set";
const WRAP_UUID: &str = "$uuid";
const WRAP_INST: &str = "$inst";

/// Why a body is not EDN this reading has: the 0-based line it happened on,
/// or `None` when the value parsed but lies outside the value tree (a lone
/// surrogate), which is the block's to report.
#[derive(Debug, PartialEq)]
pub struct EdnError {
    pub line: Option<usize>,
    pub message: String,
}

fn is_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | ',')
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "*+!-_?$%&=<>:#.'/".contains(c)
}

struct Reader {
    text: Vec<char>,
    i: usize,
    depth: usize,
    /// Each number read: its 0-based line, literal and value.
    numbers: Vec<crate::num::NumberRead>,
}

type R<T> = Result<T, EdnError>;

impl Reader {
    fn line(&self, at: usize) -> usize {
        self.text[..at.min(self.text.len())].iter().filter(|c| **c == '\n').count()
    }

    fn refuse<T>(&self, what: impl Into<String>, at: usize) -> R<T> {
        Err(EdnError { line: Some(self.line(at)), message: what.into() })
    }

    fn peek(&self, k: usize) -> Option<char> {
        self.text.get(self.i + k).copied()
    }

    /// Whitespace, commas, `;` comments and `#_` discards, in one pass.
    fn skip(&mut self) -> R<()> {
        loop {
            while self.peek(0).is_some_and(is_space) {
                self.i += 1;
            }
            if self.peek(0) == Some(';') {
                while self.peek(0).is_some_and(|c| c != '\n') {
                    self.i += 1;
                }
                continue;
            }
            if self.peek(0) == Some('#') && self.peek(1) == Some('_') {
                self.i += 2;
                self.nest(|r| r.value())?;
                continue;
            }
            return Ok(());
        }
    }

    /// One level for each container being read, and for each `#_` discard.
    fn nest<T>(&mut self, read: impl FnOnce(&mut Reader) -> R<T>) -> R<T> {
        self.depth += 1;
        if self.depth > DATA_DEPTH {
            return self.refuse(format!("nesting deeper than {DATA_DEPTH} levels is outside the value tree"), self.i);
        }
        let out = read(self);
        self.depth -= 1;
        out
    }

    fn value(&mut self) -> R<Value> {
        self.skip()?;
        let Some(c) = self.peek(0) else { return self.refuse("the body ends where a value was expected", self.i) };
        match c {
            '{' => self.nest(|r| r.map()),
            '[' => self.nest(|r| r.vector()),
            '(' => self.refuse("a list `(…)` — this reading has vectors and sets, not lists", self.i),
            '"' => self.string().map(Value::String),
            '\\' => self.refuse("a character literal `\\x`", self.i),
            '#' if self.peek(1) == Some('{') => self.nest(|r| r.dispatch()),
            '#' => self.dispatch(),
            _ => self.atom(),
        }
    }

    fn map(&mut self) -> R<Value> {
        let open = self.i;
        self.i += 1;
        let mut out: Vec<(String, Value)> = Vec::new();
        loop {
            self.skip()?;
            match self.peek(0) {
                None => return self.refuse("a map that is never closed with `}`", open),
                Some('}') => {
                    self.i += 1;
                    return Ok(Value::Object(out));
                }
                _ => {}
            }
            let key_at = self.i;
            let was_string = self.peek(0) == Some('"');
            let key = self.value()?;
            let name = self.map_key(key, was_string, key_at)?;
            self.skip()?;
            if matches!(self.peek(0), None | Some('}')) {
                return self.refuse(format!("the map key `{name}` has no value"), key_at);
            }
            if out.iter().any(|(k, _)| *k == name) {
                return self.refuse(format!("the map has the key `{name}` twice"), key_at);
            }
            let v = self.value()?;
            out.push((name, v));
        }
    }

    /// A map key, as the object key it becomes: a keyword keeps its colon, a
    /// string stays bare and so may not look like a keyword or a wrapper.
    fn map_key(&self, key: Value, was_string: bool, at: usize) -> R<String> {
        let Value::String(key) = key else {
            return self.refuse(format!("a map key that is {} — this reading has keyword and string keys", describe(&key)), at);
        };
        if !was_string {
            return Ok(key);
        }
        if key.starts_with(':') {
            return self.refuse(format!("the string key `\"{key}\"` — it would encode as the keyword `{key}` does"), at);
        }
        if key.starts_with('$') {
            return self.refuse(format!("the string key `\"{key}\"` — a leading `$` is reserved for {WRAP_UUID}/{WRAP_INST}/{WRAP_SET}"), at);
        }
        Ok(key)
    }

    fn vector(&mut self) -> R<Value> {
        let open = self.i;
        self.i += 1;
        let mut out = Vec::new();
        loop {
            self.skip()?;
            match self.peek(0) {
                None => return self.refuse("a vector that is never closed with `]`", open),
                Some(']') => {
                    self.i += 1;
                    return Ok(Value::Array(out));
                }
                _ => out.push(self.value()?),
            }
        }
    }

    fn string(&mut self) -> R<String> {
        let open = self.i;
        self.i += 1;
        // UTF-16 units, as an escape writes them: a `\u` pair makes one
        // character, and a lone surrogate is outside the value tree.
        let mut units: Vec<u16> = Vec::new();
        while let Some(c) = self.peek(0) {
            if c == '"' {
                self.i += 1;
                return String::from_utf16(&units)
                    .map_err(|_| EdnError { line: None, message: "a string holding a lone surrogate, which the value domain excludes (I-JSON)".into() });
            }
            if c == '\\' {
                let e = self.peek(1);
                self.i += 2;
                let simple = match e {
                    Some('n') => Some('\n'),
                    Some('t') => Some('\t'),
                    Some('r') => Some('\r'),
                    Some('"') => Some('"'),
                    Some('\\') => Some('\\'),
                    _ => None,
                };
                if let Some(s) = simple {
                    units.push(s as u16);
                    continue;
                }
                if e == Some('u') {
                    let hex: String = self.text[self.i.min(self.text.len())..(self.i + 4).min(self.text.len())].iter().collect();
                    if hex.len() != 4 || !hex.chars().all(|h| h.is_ascii_hexdigit()) {
                        return self.refuse("a `\\u` escape without four hex digits", self.i);
                    }
                    units.push(u16::from_str_radix(&hex, 16).expect("four hex digits"));
                    self.i += 4;
                    continue;
                }
                return self.refuse(format!("the string escape `\\{}`", e.map(String::from).unwrap_or_default()), self.i - 2);
            }
            let mut buf = [0u16; 2];
            units.extend_from_slice(c.encode_utf16(&mut buf));
            self.i += 1;
        }
        self.refuse("a string that is never closed", open)
    }

    /// `#{…}` a set, `#uuid`/`#inst` a tagged literal, anything else refused.
    fn dispatch(&mut self) -> R<Value> {
        let at = self.i;
        self.i += 1;
        if self.peek(0) == Some('{') {
            let open = self.i;
            self.i += 1;
            let mut members = Vec::new();
            loop {
                self.skip()?;
                match self.peek(0) {
                    None => return self.refuse("a set that is never closed with `}`", open),
                    Some('}') => {
                        self.i += 1;
                        return Ok(Value::Object(vec![(WRAP_SET.to_string(), Value::Array(members))]));
                    }
                    _ => members.push(self.value()?),
                }
            }
        }
        let mut j = self.i;
        while j < self.text.len() && is_name_char(self.text[j]) {
            j += 1;
        }
        let tag: String = self.text[self.i..j].iter().collect();
        self.i = j;
        if tag != "uuid" && tag != "inst" {
            return self.refuse(
                if tag.is_empty() {
                    "a `#` that begins no set and no tag".to_string()
                } else {
                    format!("the tagged literal `#{tag}` — this reading has `#uuid` and `#inst`")
                },
                at,
            );
        }
        self.skip()?;
        if self.peek(0) != Some('"') {
            return self.refuse(format!("`#{tag}` without a string after it"), at);
        }
        let s = self.string()?;
        let key = if tag == "uuid" { WRAP_UUID } else { WRAP_INST };
        Ok(Value::Object(vec![(key.to_string(), Value::String(s))]))
    }

    /// nil, a boolean, a number, a keyword — or a refusal naming what it was.
    fn atom(&mut self) -> R<Value> {
        let at = self.i;
        let mut j = self.i;
        while j < self.text.len() && is_name_char(self.text[j]) {
            j += 1;
        }
        let t: String = self.text[self.i..j].iter().collect();
        self.i = j;
        if t.is_empty() {
            return self.refuse(format!("the character `{}` begins no value this reading has", self.text[at]), at);
        }
        match t.as_str() {
            "nil" => return Ok(Value::Null),
            "true" => return Ok(Value::Bool(true)),
            "false" => return Ok(Value::Bool(false)),
            _ => {}
        }
        if t.starts_with(':') {
            if t == ":" {
                return self.refuse("a bare `:` with no name after it", at);
            }
            return Ok(Value::String(t));
        }
        if bignum(&t) {
            return self.refuse(format!("the arbitrary-precision literal `{t}` — a JSON number cannot hold it"), at);
        }
        if ratio(&t) {
            return self.refuse(format!("the ratio `{t}` — a JSON number cannot hold it"), at);
        }
        if number(&t) {
            return match t.parse::<f64>() {
                Ok(n) if n.is_finite() => {
                    self.numbers.push((self.line(at), t.clone(), n));
                    Ok(Value::Number(n))
                }
                _ => self.refuse(format!("the number `{t}` is not finite"), at),
            };
        }
        self.refuse(format!("the symbol `{t}` — this reading has keywords, not symbols"), at)
    }
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn unsigned(t: &str) -> &str {
    t.strip_prefix(['+', '-']).unwrap_or(t)
}

/// `^[+-]?\d+[NM]$` or `^[+-]?\d*\.\d+M$`.
fn bignum(t: &str) -> bool {
    let u = unsigned(t);
    if let Some(d) = u.strip_suffix('N').or_else(|| u.strip_suffix('M')) {
        if digits(d) {
            return true;
        }
    }
    u.strip_suffix('M').and_then(|d| d.split_once('.')).is_some_and(|(a, b)| (a.is_empty() || digits(a)) && digits(b))
}

/// `^[+-]?\d+\/\d+$`.
fn ratio(t: &str) -> bool {
    unsigned(t).split_once('/').is_some_and(|(a, b)| digits(a) && digits(b))
}

/// `^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`.
fn number(t: &str) -> bool {
    let u = unsigned(t);
    let (mant, exp) = match u.find(['e', 'E']) {
        Some(p) => (&u[..p], Some(&u[p + 1..])),
        None => (u, None),
    };
    let mant_ok = match mant.split_once('.') {
        Some((a, b)) => (digits(a) && (b.is_empty() || digits(b))) || (a.is_empty() && digits(b)),
        None => digits(mant),
    };
    mant_ok && exp.map_or(true, |e| digits(unsigned(e)))
}

fn describe(v: &Value) -> String {
    match v {
        Value::Null => "nil".to_string(),
        Value::Array(_) => "a vector".to_string(),
        Value::Object(_) => "a set or a tagged literal".to_string(),
        Value::Bool(b) => format!("the boolean `{b}`"),
        Value::Number(n) => format!("the number `{}`", es_string(*n)),
        Value::String(s) => format!("the string `{s}`"),
    }
}

/// One EDN datum, as the value tree §3.2 has. A second datum after the first
/// is refused: a `data` block holds one value.
pub fn parse(text: &str) -> Result<Value, EdnError> {
    parse_numbers(text).map(|(v, _)| v)
}

/// One EDN datum, with each number read — its 0-based line, literal and value.
pub fn parse_numbers(text: &str) -> Result<(Value, Vec<NumberRead>), EdnError> {
    let mut r = Reader { text: text.chars().collect(), i: 0, depth: 0, numbers: Vec::new() };
    let value = r.value()?;
    r.skip()?;
    if r.i < r.text.len() {
        return r.refuse("a second value after the first — a `data` block holds one", r.i);
    }
    Ok((value, r.numbers))
}

fn wrapped<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    match v {
        Value::Object(m) if m.len() == 1 && m[0].0 == key => Some(&m[0].1),
        _ => None,
    }
}

fn render(v: &Value, indent: &str) -> String {
    if let Some(Value::String(s)) = wrapped(v, WRAP_UUID) {
        return format!("#uuid {}", quote(s));
    }
    if let Some(Value::String(s)) = wrapped(v, WRAP_INST) {
        return format!("#inst {}", quote(s));
    }
    if let Some(members) = wrapped(v, WRAP_SET) {
        return match members {
            Value::Array(a) => format!("#{{{}}}", a.iter().map(|m| render(m, indent)).collect::<Vec<_>>().join(" ")),
            other => format!("#{{{}}}", render(other, indent)),
        };
    }
    match v {
        Value::Array(a) => format!("[{}]", a.iter().map(|m| render(m, indent)).collect::<Vec<_>>().join(" ")),
        Value::Object(m) if m.is_empty() => "{}".to_string(),
        Value::Object(m) => {
            let pad = format!("{indent} ");
            let lines: Vec<String> = m
                .iter()
                .map(|(k, val)| {
                    let key = if k.starts_with(':') { k.clone() } else { quote(k) };
                    let inner = format!("{pad}{}", " ".repeat(key.chars().count() + 1));
                    format!("{pad}{key} {}", render(val, &inner))
                })
                .collect();
            format!("{{{}}}", &lines.join("\n")[pad.len()..])
        }
        Value::Null => "nil".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => es_string(*n),
        Value::String(s) if s.starts_with(':') => s.clone(),
        Value::String(s) => quote(s),
    }
}

/// The value tree back to EDN text, laid out to be read: a map breaks one
/// entry per line and nests, vectors and sets stay inline. A coordinate write
/// into an `edn` body writes through this, so the body stays EDN.
pub fn serialize(v: &Value) -> Vec<String> {
    render(v, "").split('\n').map(str::to_string).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::to_json;

    fn ok(s: &str) -> String {
        to_json(&parse(s).unwrap_or_else(|e| panic!("{s}: {e:?}")))
    }

    fn err(s: &str) -> (Option<usize>, String) {
        let e = parse(s).expect_err(s);
        (e.line, e.message)
    }

    #[test]
    fn reads_the_subset() {
        assert_eq!(ok("{:a 1, :b [true nil \"x\"] \"k\" -2.5e1}"), r#"{":a":1,":b":[true,null,"x"],"k":-25}"#);
        assert_eq!(ok("#{1 2} ; comment\n"), r#"{"$set":[1,2]}"#);
        assert_eq!(ok("[#uuid \"u\" #inst \"t\" #_ :gone :ns/k]"), r#"[{"$uuid":"u"},{"$inst":"t"},":ns/k"]"#);
        assert_eq!(ok("\"a\\n\\t\\r\\\"\\\\\\u0041\\ud83d\\ude00\""), "\"a\\n\\t\\r\\\"\\\\A😀\"");
        assert_eq!(ok(".5"), "0.5");
        assert_eq!(ok("+5."), "5");
    }

    #[test]
    fn refuses_by_name() {
        for (s, want) in [
            ("(1 2)", "a list"),
            ("\\a", "a character literal"),
            ("42N", "arbitrary-precision"),
            ("1.5M", "arbitrary-precision"),
            ("1/3", "the ratio"),
            ("sym", "the symbol"),
            ("#foo \"x\"", "the tagged literal"),
            ("# x", "begins no set"),
            ("#uuid 1", "without a string"),
            (":", "a bare `:`"),
            ("{\":k\" 1}", "would encode as the keyword"),
            ("{\"$x\" 1}", "is reserved"),
            ("{1 2}", "keyword and string keys"),
            ("{:a}", "has no value"),
            ("{:a 1 :a 2}", "twice"),
            ("{:a 1", "never closed"),
            ("[1", "never closed"),
            ("#{1", "never closed"),
            ("\"x", "never closed"),
            ("\"\\q\"", "string escape"),
            ("\"\\u12\"", "four hex digits"),
            ("1 2", "a second value"),
            ("", "ends where a value"),
            ("@", "begins no value"),
            ("1e999", "not finite"),
        ] {
            assert!(err(s).1.contains(want), "{s}: {:?}", err(s));
        }
        assert_eq!(err("[1\n2\n(3)]").0, Some(2));
        assert_eq!(err("\"\\ud800\"").0, None);
        assert!(err(&"[".repeat(DATA_DEPTH + 1)).1.contains("nesting deeper"));
        assert!(err(&"#_".repeat(DATA_DEPTH + 1)).1.contains("nesting deeper"));
    }

    #[test]
    fn writes_back() {
        let v = parse("{:a 1 \"b\" [#uuid \"u\" #inst \"t\" #{:x}] :c {:d nil} :e {}}").unwrap();
        assert_eq!(serialize(&v).join("\n"), "{:a 1\n \"b\" [#uuid \"u\" #inst \"t\" #{:x}]\n :c {:d nil}\n :e {}}");
        assert_eq!(serialize(&Value::Object(vec![("$set".into(), Value::Bool(true))])), vec!["#{true}"]);
        assert_eq!(serialize(&Value::Bool(false)), vec!["false"]);
    }
}
