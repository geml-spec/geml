//! A `yaml` engine for the subset §3.2 fixes: block mappings and sequences
//! nested by indentation (`- key: value` and `- - item` included), plain,
//! single- and double-quoted scalars, the `|`, `|-`, `>` and `>-` block
//! scalars, comments, a leading `---` and a trailing `...`, `[]` and `{}`; the
//! YAML 1.2 core schema for plain scalars. Everything outside the subset —
//! anchors, aliases, tags, other flow collections, `.inf`/`.nan`, a second
//! document, a tab in indentation — is a parse error, never a guess.

use crate::json::Value;

type R<T> = Result<T, (usize, String)>;

#[derive(Clone, Debug)]
struct Line {
    indent: usize,
    content: String,
    raw: String,
}

struct P {
    lines: Vec<Line>,
    pos: usize,
}

fn err<T>(line: usize, msg: &str) -> R<T> {
    Err((line, msg.to_string()))
}

fn significant(l: &Line) -> bool {
    !l.content.is_empty() && !l.content.starts_with('#')
}

/// Parse a `yaml` body into a value.
pub fn parse(text: &str) -> R<Value> {
    let mut lines = Vec::new();
    for (no, raw) in text.split('\n').enumerate() {
        let spaces = raw.chars().take_while(|c| *c == ' ').count();
        let rest = &raw[spaces..];
        let content = rest.trim_end_matches([' ', '\t']).to_string();
        if !content.is_empty() && rest.starts_with('\t') {
            return err(no, "a tab used for indentation is outside the subset");
        }
        let content = if content.trim_start_matches('\t').is_empty() { String::new() } else { content };
        lines.push(Line { indent: spaces, content, raw: raw.to_string() });
    }
    let mut p = P { lines, pos: 0 };
    p.document()
}

impl P {
    fn skip(&mut self) {
        while self.pos < self.lines.len() && !significant(&self.lines[self.pos]) {
            self.pos += 1;
        }
    }

    fn next_sig(&self, from: usize) -> Option<usize> {
        (from..self.lines.len()).find(|i| significant(&self.lines[*i]))
    }

    fn document(&mut self) -> R<Value> {
        self.skip();
        if self.pos < self.lines.len() && is_marker(&self.lines[self.pos].content, "---") {
            if self.lines[self.pos].indent != 0 || !self.lines[self.pos].content[3..].trim().is_empty() {
                return err(self.pos, "content on the document marker line is outside the subset");
            }
            self.pos += 1;
            self.skip();
        }
        let v = if self.pos >= self.lines.len() || is_marker(&self.lines[self.pos].content, "...") {
            Value::Null
        } else {
            let ind = self.lines[self.pos].indent;
            self.block(ind)?
        };
        self.skip();
        if self.pos < self.lines.len() {
            let c = &self.lines[self.pos].content;
            if is_marker(c, "...") {
                self.pos += 1;
                self.skip();
                if self.pos < self.lines.len() {
                    return err(self.pos, "content after `...` is outside the subset");
                }
            } else if is_marker(c, "---") {
                return err(self.pos, "a second document is outside the subset");
            } else {
                return err(self.pos, "unexpected content");
            }
        }
        Ok(v)
    }

    fn block(&mut self, ind: usize) -> R<Value> {
        let c = self.lines[self.pos].content.clone();
        if is_seq_item(&c) {
            self.seq(ind)
        } else if split_entry(&c).is_some() {
            self.map(ind)
        } else {
            let no = self.pos;
            let v = scalar(&c, no)?;
            self.pos += 1;
            self.no_deeper(ind, no)?;
            Ok(v)
        }
    }

    /// After a value written on one line, nothing may be indented under it.
    fn no_deeper(&self, ind: usize, no: usize) -> R<()> {
        match self.next_sig(self.pos) {
            Some(n) if self.lines[n].indent > ind => err(n, &format!("unexpected indentation under line {}", no + 1)),
            _ => Ok(()),
        }
    }

    fn nested(&mut self, ind: usize, allow_same_seq: bool) -> R<Value> {
        match self.next_sig(self.pos) {
            Some(n) if self.lines[n].indent > ind => {
                self.pos = n;
                let i = self.lines[n].indent;
                self.block(i)
            }
            Some(n) if allow_same_seq && self.lines[n].indent == ind && is_seq_item(&self.lines[n].content) => {
                self.pos = n;
                self.seq(ind)
            }
            _ => Ok(Value::Null),
        }
    }

    fn seq(&mut self, ind: usize) -> R<Value> {
        let mut items = Vec::new();
        loop {
            self.skip();
            if self.pos >= self.lines.len() {
                break;
            }
            let l = self.lines[self.pos].clone();
            if l.indent < ind || !is_seq_item(&l.content) {
                if l.indent > ind {
                    return err(self.pos, "unexpected indentation");
                }
                break;
            }
            if l.indent > ind {
                return err(self.pos, "unexpected indentation");
            }
            let after = &l.content[1..];
            let gap = after.chars().take_while(|c| *c == ' ').count();
            let rest = after[gap..].to_string();
            if rest.is_empty() || rest.starts_with('#') {
                self.pos += 1;
                items.push(self.nested(ind, false)?);
            } else {
                let col = ind + 1 + gap;
                self.lines[self.pos] = Line { indent: col, content: rest, raw: l.raw.clone() };
                items.push(self.block(col)?);
            }
        }
        Ok(Value::Array(items))
    }

    fn map(&mut self, ind: usize) -> R<Value> {
        let mut m: Vec<(String, Value)> = Vec::new();
        loop {
            self.skip();
            if self.pos >= self.lines.len() {
                break;
            }
            let l = self.lines[self.pos].clone();
            if l.indent < ind {
                break;
            }
            if l.indent > ind {
                return err(self.pos, "unexpected indentation");
            }
            if is_marker(&l.content, "...") || is_marker(&l.content, "---") {
                break;
            }
            let no = self.pos;
            let Some((key, rest)) = split_entry(&l.content) else {
                return err(no, "expected `key: value`");
            };
            let key = key_text(&key, no)?;
            if m.iter().any(|(k, _)| *k == key) {
                return err(no, &format!("the key `{key}` occurs twice in one mapping"));
            }
            self.pos += 1;
            let rest = rest.trim().to_string();
            let v = if rest.is_empty() || rest.starts_with('#') {
                self.nested(ind, true)?
            } else if rest.starts_with('|') || rest.starts_with('>') {
                self.block_scalar(&rest, ind, no)?
            } else {
                let v = scalar(&rest, no)?;
                self.no_deeper(ind, no)?;
                v
            };
            m.push((key, v));
        }
        Ok(Value::Object(m))
    }

    fn block_scalar(&mut self, header: &str, ind: usize, no: usize) -> R<Value> {
        let mut chars = header.chars();
        let folded = chars.next() == Some('>');
        let mut chomp = ' ';
        let mut explicit: Option<usize> = None;
        let mut rest = String::new();
        for c in chars.by_ref() {
            match c {
                '-' | '+' if chomp == ' ' => chomp = c,
                '1'..='9' if explicit.is_none() => explicit = Some(c as usize - '0' as usize),
                _ => {
                    rest.push(c);
                    break;
                }
            }
        }
        rest.extend(chars);
        let rest = rest.trim();
        if !rest.is_empty() && !rest.starts_with('#') {
            return err(no, "unexpected text after a block scalar indicator");
        }
        // The content indentation: explicit, or the first non-blank line's.
        let mut ci = explicit.map(|e| ind + e);
        let mut k = self.pos;
        let mut body: Vec<String> = Vec::new();
        while k < self.lines.len() {
            let raw = &self.lines[k].raw;
            let blank = raw.trim().is_empty();
            let lead = raw.chars().take_while(|c| *c == ' ').count();
            if blank {
                body.push(String::new());
                k += 1;
                continue;
            }
            let want = match ci {
                Some(c) => c,
                None => {
                    if lead <= ind {
                        break;
                    }
                    ci = Some(lead);
                    lead
                }
            };
            if lead < want {
                break;
            }
            body.push(raw[want..].to_string());
            k += 1;
        }
        // Blank lines after the last content line belong to the chomping.
        let content_end = body.iter().rposition(|l| !l.is_empty()).map(|i| i + 1).unwrap_or(0);
        let trailing = body.len() - content_end;
        // Lines past the scalar that were only blank are not consumed by it
        // unless chomping keeps them.
        self.pos = if content_end == 0 { self.pos } else { k - trailing };
        let lines = &body[..content_end];
        let mut text = String::new();
        if folded {
            let mut prev_blank = false;
            let mut prev_more = false;
            for (i, l) in lines.iter().enumerate() {
                if l.is_empty() {
                    text.push('\n');
                    prev_blank = true;
                    continue;
                }
                let more = l.starts_with(' ') || l.starts_with('\t');
                if i > 0 && !prev_blank {
                    text.push(if more || prev_more { '\n' } else { ' ' });
                }
                text.push_str(l);
                prev_blank = false;
                prev_more = more;
            }
        } else {
            text = lines.join("\n");
        }
        match chomp {
            '-' => {}
            '+' => {
                if content_end > 0 {
                    text.push('\n');
                }
                for _ in 0..trailing {
                    text.push('\n');
                }
                self.pos = k;
            }
            _ => {
                if content_end > 0 {
                    text.push('\n');
                }
            }
        }
        Ok(Value::String(text))
    }
}

fn is_marker(c: &str, m: &str) -> bool {
    c == m || (c.starts_with(m) && c[m.len()..].starts_with([' ', '\t']))
}

fn is_seq_item(c: &str) -> bool {
    c == "-" || c.starts_with("- ") || c.starts_with("-\t")
}

/// Split `key: value` (the key possibly quoted). `None` when the line is not
/// a mapping entry.
fn split_entry(c: &str) -> Option<(String, String)> {
    let chars: Vec<char> = c.chars().collect();
    let key_end = if chars.first() == Some(&'"') || chars.first() == Some(&'\'') {
        let q = chars[0];
        let mut i = 1;
        while i < chars.len() {
            if q == '"' && chars[i] == '\\' {
                i += 2;
                continue;
            }
            if chars[i] == q {
                if q == '\'' && chars.get(i + 1) == Some(&'\'') {
                    i += 2;
                    continue;
                }
                break;
            }
            i += 1;
        }
        if i >= chars.len() {
            return None;
        }
        let mut j = i + 1;
        while j < chars.len() && chars[j] == ' ' {
            j += 1;
        }
        if chars.get(j) != Some(&':') {
            return None;
        }
        (i + 1, j)
    } else {
        let mut i = 0;
        loop {
            if i >= chars.len() {
                return None;
            }
            if chars[i] == ':' && (i + 1 == chars.len() || chars[i + 1] == ' ' || chars[i + 1] == '\t') {
                break;
            }
            if chars[i] == '#' && i > 0 && chars[i - 1] == ' ' {
                return None;
            }
            i += 1;
        }
        (i, i)
    };
    let (kend, colon) = key_end;
    let key: String = chars[..kend].iter().collect();
    if key.trim().is_empty() {
        return None;
    }
    let value: String = chars[colon + 1..].iter().collect();
    Some((key.trim_end().to_string(), value))
}

fn key_text(k: &str, no: usize) -> R<String> {
    if k.starts_with('"') || k.starts_with('\'') {
        match scalar(k, no)? {
            Value::String(s) => Ok(s),
            _ => unreachable!("a quoted scalar is a string"),
        }
    } else {
        if k.starts_with(['&', '*', '!', '?', '[', '{', '|', '>', '%', '@', '`']) {
            return err(no, "this key is outside the subset");
        }
        Ok(k.to_string())
    }
}

/// Strip a trailing ` # comment` from a plain scalar.
fn strip_comment(s: &str) -> &str {
    let b = s.as_bytes();
    for i in 1..b.len() {
        if b[i] == b'#' && (b[i - 1] == b' ' || b[i - 1] == b'\t') {
            return s[..i].trim_end();
        }
    }
    s
}

/// One scalar written on one line.
fn scalar(s: &str, no: usize) -> R<Value> {
    let s = s.trim();
    match s.chars().next() {
        Some('"') => {
            let (v, rest) = double_quoted(s, no)?;
            after_quoted(&rest, no)?;
            Ok(Value::String(v))
        }
        Some('\'') => {
            let chars: Vec<char> = s.chars().collect();
            let mut out = String::new();
            let mut i = 1;
            loop {
                if i >= chars.len() {
                    return err(no, "unterminated single-quoted scalar");
                }
                if chars[i] == '\'' {
                    if chars.get(i + 1) == Some(&'\'') {
                        out.push('\'');
                        i += 2;
                        continue;
                    }
                    break;
                }
                out.push(chars[i]);
                i += 1;
            }
            let rest: String = chars[i + 1..].iter().collect();
            after_quoted(&rest, no)?;
            Ok(Value::String(out))
        }
        _ => {
            let p = strip_comment(s);
            if p == "[]" {
                return Ok(Value::Array(vec![]));
            }
            if p == "{}" {
                return Ok(Value::Object(vec![]));
            }
            if p.starts_with(['[', '{']) {
                return err(no, "a flow collection other than [] and {} is outside the subset");
            }
            if p.starts_with('&') || p.starts_with('*') {
                return err(no, "anchors and aliases are outside the subset");
            }
            if p.starts_with('!') {
                return err(no, "tags are outside the subset");
            }
            if p.starts_with(['|', '>', '%', '@', '`', '?']) || is_seq_item(p) {
                return err(no, "this scalar is outside the subset");
            }
            if p.contains(": ") || p.ends_with(':') {
                return err(no, "a mapping is not allowed in this position");
            }
            core_schema(p, no)
        }
    }
}

fn after_quoted(rest: &str, no: usize) -> R<()> {
    let r = rest.trim();
    if r.is_empty() || r.starts_with('#') {
        Ok(())
    } else {
        err(no, "unexpected text after a quoted scalar")
    }
}

fn double_quoted(s: &str, no: usize) -> R<(String, String)> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 1;
    let hex = |chars: &[char], i: usize, n: usize| -> R<u32> {
        let h: String = chars.get(i..i + n).ok_or((no, "a short escape".to_string()))?.iter().collect();
        u32::from_str_radix(&h, 16).map_err(|_| (no, "a bad hex escape".to_string()))
    };
    loop {
        let Some(&c) = chars.get(i) else { return err(no, "unterminated double-quoted scalar") };
        match c {
            '"' => break,
            '\\' => {
                let Some(&e) = chars.get(i + 1) else { return err(no, "unterminated double-quoted scalar") };
                i += 2;
                match e {
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    '/' => out.push('/'),
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'r' => out.push('\r'),
                    'b' => out.push('\u{8}'),
                    'f' => out.push('\u{c}'),
                    '0' => out.push('\0'),
                    'a' => out.push('\u{7}'),
                    'e' => out.push('\u{1b}'),
                    'v' => out.push('\u{b}'),
                    ' ' => out.push(' '),
                    'x' | 'u' | 'U' => {
                        let n = match e {
                            'x' => 2,
                            'u' => 4,
                            _ => 8,
                        };
                        let v = hex(&chars, i, n)?;
                        i += n;
                        if (0xD800..0xE000).contains(&v) {
                            // A pair spelled as two \u escapes is one character.
                            if (0xD800..0xDC00).contains(&v) && chars.get(i) == Some(&'\\') && chars.get(i + 1) == Some(&'u') {
                                let lo = hex(&chars, i + 2, 4)?;
                                if (0xDC00..0xE000).contains(&lo) {
                                    i += 6;
                                    out.push(char::from_u32(0x10000 + ((v - 0xD800) << 10) + (lo - 0xDC00)).expect("a pair"));
                                    continue;
                                }
                            }
                            return err(no, "a lone surrogate is not a character");
                        }
                        match char::from_u32(v) {
                            Some(ch) => out.push(ch),
                            None => return err(no, "an escape past U+10FFFF"),
                        }
                    }
                    _ => return err(no, "an unknown escape"),
                }
                continue;
            }
            c => out.push(c),
        }
        i += 1;
    }
    Ok((out, chars[i + 1..].iter().collect()))
}

/// The YAML 1.2 core schema for a plain scalar.
fn core_schema(p: &str, no: usize) -> R<Value> {
    match p {
        "" | "~" | "null" | "Null" | "NULL" => return Ok(Value::Null),
        "true" | "True" | "TRUE" => return Ok(Value::Bool(true)),
        "false" | "False" | "FALSE" => return Ok(Value::Bool(false)),
        _ => {}
    }
    let lower = p.to_ascii_lowercase();
    let t = lower.trim_start_matches(['+', '-']);
    if t == ".inf" || t == ".nan" {
        return err(no, ".inf and .nan are outside this value domain");
    }
    let num = |v: f64| -> R<Value> {
        if v.is_finite() {
            Ok(Value::Number(v))
        } else {
            err(no, "a number past the range of binary64 has no value")
        }
    };
    if let Some(h) = p.strip_prefix("0x") {
        if !h.is_empty() && h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return num(h.bytes().fold(0f64, |a, b| a * 16.0 + (b as char).to_digit(16).unwrap() as f64));
        }
    }
    if let Some(o) = p.strip_prefix("0o") {
        if !o.is_empty() && o.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
            return num(o.bytes().fold(0f64, |a, b| a * 8.0 + (b - b'0') as f64));
        }
    }
    if is_core_number(p) {
        return num(p.parse::<f64>().map_err(|_| (no, "a bad number".to_string()))?);
    }
    Ok(Value::String(p.to_string()))
}

/// `[-+]? ( \.[0-9]+ | [0-9]+ ( \.[0-9]* )? ) ( [eE] [-+]? [0-9]+ )?`
fn is_core_number(p: &str) -> bool {
    crate::num::parse_bare_number(p).is_some() || {
        let b = p.as_bytes();
        // parse_bare_number refuses only out-of-range values of this shape.
        let digits = b.iter().filter(|c| c.is_ascii_digit()).count();
        digits > 0 && b.iter().all(|c| c.is_ascii_digit() || b"+-.eE".contains(c)) && p.parse::<f64>().is_ok_and(|v| v.is_infinite())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::canonical;

    fn ok(s: &str) -> String {
        canonical(&parse(s).unwrap_or_else(|e| panic!("{s:?}: {e:?}")))
    }

    fn bad(s: &str) {
        assert!(parse(s).is_err(), "{s:?} should fail");
    }

    #[test]
    fn subset() {
        assert_eq!(ok("name: geml\ntags:\n  - doc\n  - spec\nnested:\n  a: 1\n"), r#"{"name":"geml","nested":{"a":1},"tags":["doc","spec"]}"#);
        assert_eq!(ok("- k: 1\n  j: 2\n- - a\n  - b\n"), r#"[{"j":2,"k":1},["a","b"]]"#);
        assert_eq!(
            ok("a: plain text\nb: 'single ''quoted'''\nc: \"double \\\"quoted\\\"\"\n"),
            r#"{"a":"plain text","b":"single 'quoted'","c":"double \"quoted\""}"#
        );
        assert_eq!(
            ok("lit: |\n  one\n  two\nstrip: |-\n  one\nfold: >\n  one\n  two\nfoldstrip: >-\n  one\n"),
            r#"{"fold":"one two\n","foldstrip":"one","lit":"one\ntwo\n","strip":"one"}"#
        );
        assert_eq!(ok("---\n# a comment\na: 1 # trailing\n...\n"), r#"{"a":1}"#);
        assert_eq!(ok("s: []\nm: {}\n"), r#"{"m":{},"s":[]}"#);
        assert_eq!(
            ok("n1: null\nn2: ~\nn3:\nt: true\nf: false\ni: +80\nh: 0x1f\no: 0o17\nd: .5\ne: 1e3\n"),
            r#"{"d":0.5,"e":1000,"f":false,"h":31,"i":80,"n1":null,"n2":null,"n3":null,"o":15,"t":true}"#
        );
        assert_eq!(ok("- yes\n- no\n- on\n- off\n"), r#"["yes","no","on","off"]"#);
    }

    #[test]
    fn more_shapes() {
        assert_eq!(ok(""), "null");
        assert_eq!(ok("# only a comment\n"), "null");
        assert_eq!(ok("---\n...\n"), "null");
        assert_eq!(ok("just text"), r#""just text""#);
        assert_eq!(ok("key:\n- a\n- b\n"), r#"{"key":["a","b"]}"#);
        assert_eq!(ok("- \n  a: 1\n-\n- x\n"), r#"[{"a":1},null,"x"]"#);
        assert_eq!(ok("\"q k\": 1\n'p k': 2\n"), r#"{"p k":2,"q k":1}"#);
        assert_eq!(
            ok("a: \"\\u00e9\\ud83d\\ude00\\x41\\U0001F600\\t\\n\\r\\b\\f\\0\\a\\e\\v\\ \\/\\\\\"\n"),
            "{\"a\":\"é😀A😀\\t\\n\\r\\b\\f\\u0000\\u0007\\u001b\\u000b /\\\\\"}"
        );
        assert_eq!(ok("keep: |+\n  a\n\n\nnext: 1\n"), r#"{"keep":"a\n\n\n","next":1}"#);
        assert_eq!(ok("f: >\n  a\n\n  b\n    c\n  d\n"), r#"{"f":"a\nb\n  c\nd\n"}"#);
        assert_eq!(ok("e: |\nn: 1\n"), r#"{"e":"","n":1}"#);
        assert_eq!(ok("i: |2\n    x\n"), r#"{"i":"  x\n"}"#);
        assert_eq!(ok("u: http://x.y/z\nw: a:b\n"), r#"{"u":"http://x.y/z","w":"a:b"}"#);
        assert_eq!(
            ok("n: -0.5\nm: 007\nbig: 12345678901234567890\nl: Null\nT: TRUE\nF: False\n"),
            r#"{"F":false,"T":true,"big":12345678901234567000,"l":null,"m":7,"n":-0.5}"#
        );
        assert_eq!(ok("x: 0x\ny: 0o9\n"), r#"{"x":"0x","y":"0o9"}"#);
        assert_eq!(ok("a:\n  # c\n  b: 1\n"), r#"{"a":{"b":1}}"#);
        assert_eq!(ok("- a\n# c\n- b\n"), r#"["a","b"]"#);
    }

    #[test]
    fn outside_the_subset() {
        for s in [
            "a: &x 1\nb: *x\n",
            "a: !!str 1\n",
            "a: [1, 2]\n",
            "a: {b: 1}\n",
            "a: .inf\n",
            "a: -.nan\n",
            "a:\n\tb: 1\n",
            "a: 1\na: 2\n",
            "a: 1\n---\nb: 2\n",
            "a: 1\n...\nb: 2\n",
            "--- x\n",
            "a: b: c\n",
            "a: 1\n  b: 2\n",
            "- a\n  - b\n",
            "a: 'x\n",
            "a: \"x\n",
            "a: \"\\q\"\n",
            "a: \"\\ud800\"\n",
            "a: \"\\udc00\"\n",
            "a: \"\\uZZZZ\"\n",
            "a: \"\\u12\"\n",
            "a: \"x\" y\n",
            "a: 'x' y\n",
            "? k\n",
            "&a: 1\n",
            "a: 1e400\n",
            "a: | x\n",
            "a: @x\n",
            "- - a\n   - b\n",
            "a: 1\n b: 2\n",
            "a\nb\n",
            "x\n  y\n",
            "a: \"\\U00110000\"\n",
            "a:\n  - x\n b: 1\n",
            "a: \"\\\n",
            "a: x\n- b\n",
        ] {
            bad(s);
        }
        assert_eq!(parse("a: 1\na: 2\n").unwrap_err().0, 1);
    }
}
