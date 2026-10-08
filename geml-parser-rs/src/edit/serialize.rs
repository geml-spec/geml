//! GEML serializer: document model → GEML source, the canonical form `to
//! geml` prints. It does not reproduce the original bytes — whitespace,
//! attribute quoting and fence length are normalized — but what it emits
//! parses back to the same model.

use crate::diag::Diags;
use crate::inline::{parse_inline, InlineCtx};
use crate::json::{to_json, Value};
use crate::model::{Block, Inline, Item, List, Mode};
use crate::num::es_string;

use super::coord::pretty_json;

fn looks_typed(s: &str) -> bool {
    if s == "true" || s == "false" {
        return true;
    }
    let t = s.strip_prefix(['+', '-']).unwrap_or(s);
    if !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    // A decimal or exponent form that holds `.` or `e`.
    let (mant, exp) = match t.split_once(['e', 'E']) {
        Some((m, e)) => (m, Some(e)),
        None => (t, None),
    };
    let mant_ok = {
        let (a, b) = match mant.split_once('.') {
            Some((a, b)) => (a, Some(b)),
            None => (mant, None),
        };
        let digits = |x: &str| !x.is_empty() && x.chars().all(|c| c.is_ascii_digit());
        match b {
            Some(b) => (digits(a) && (b.is_empty() || digits(b))) || (a.is_empty() && digits(b)),
            None => digits(a),
        }
    };
    let exp_ok = exp.map_or(true, |e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && e.chars().all(|c| c.is_ascii_digit())
    });
    mant_ok && exp_ok && (mant.contains('.') || exp.is_some())
}

fn ser_attr_value(v: &Value) -> String {
    match v {
        Value::Bool(true) => String::new(),
        Value::Bool(false) => "false".to_string(),
        Value::Number(n) => es_string(*n),
        Value::String(s) => format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")),
        other => format!("\"{}\"", to_json(other).replace('\\', "\\\\").replace('"', "\\\"")),
    }
}

fn ser_attrs(id: Option<&str>, classes: &[String], attrs: &[(String, Value)]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(id) = id {
        parts.push(format!("#{id}"));
    }
    for c in classes {
        parts.push(format!(".{c}"));
    }
    for (k, v) in attrs {
        parts.push(if *v == Value::Bool(true) { k.clone() } else { format!("{k}={}", ser_attr_value(v)) });
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("{{{}}}", parts.join(" "))
    }
}

fn ser_data_value(v: &Value) -> String {
    match v {
        Value::Bool(_) | Value::Number(_) => to_json(v),
        Value::String(s) => {
            if looks_typed(s) || s.trim() != s {
                format!("\"{s}\"")
            } else {
                s.clone()
            }
        }
        other => to_json(other),
    }
}

fn esc_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '`' | '*' | '~' | '$' | '[' | ']') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A literal `{{name}}` would be re-read as a metadata reference: escape it.
fn esc_meta_ref(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' && i + 1 < chars.len() && chars[i + 1] == '{' {
            // `{{` [ws] name [ws] `}}`
            let mut j = i + 2;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            let name_start = j;
            while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '-') {
                j += 1;
            }
            let mut k = j;
            while k < chars.len() && chars[k].is_whitespace() {
                k += 1;
            }
            if j > name_start && k + 1 < chars.len() && chars[k] == '}' && chars[k + 1] == '}' {
                let mut bs = 0;
                let mut b = out.len();
                while b > 0 && out.as_bytes()[b - 1] == b'\\' {
                    bs += 1;
                    b -= 1;
                }
                out.push_str(if bs % 2 == 1 { "\\\\{" } else { "\\{" });
                out.extend(chars[i + 1..=k + 1].iter());
                i = k + 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn longest_run(s: &str, ch: char) -> usize {
    let mut max = 0;
    let mut run = 0;
    for c in s.chars() {
        if c == ch {
            run += 1;
            max = max.max(run);
        } else {
            run = 0;
        }
    }
    max
}

fn link_dest(href: &Option<String>, doc: &Option<String>, anchor: &Option<String>) -> String {
    if let Some(h) = href {
        return h.clone();
    }
    match (doc, anchor) {
        (Some(d), Some(a)) => format!("{d}#{a}"),
        (Some(d), None) => d.clone(),
        (None, Some(a)) => format!("#{a}"),
        (None, None) => String::new(),
    }
}

fn ser_inline(n: &Inline, esc: bool) -> String {
    match n {
        Inline::Text(t) => esc_meta_ref(&if esc { esc_text(t) } else { t.clone() }),
        Inline::Emph(c) => format!("*{}*", ser_seq(c, esc)),
        Inline::Strong(c) => format!("**{}**", ser_seq(c, esc)),
        Inline::Strike(c) => format!("~~{}~~", ser_seq(c, esc)),
        Inline::Code(v) => {
            let f = "`".repeat(longest_run(v, '`') + 1);
            format!("{f}{v}{f}")
        }
        Inline::Math(v) => format!("${v}$"),
        Inline::Break => "\\\n".to_string(),
        Inline::Image { src, alt } => format!("![{}]({src})", ser_seq(alt, esc)),
        Inline::Link { href, doc, anchor, children } => format!("[{}]({})", ser_seq(children, esc), link_dest(href, doc, anchor)),
        Inline::AutoRef { doc, anchor, .. } => match doc {
            Some(d) => format!("[[{d}#{anchor}]]"),
            None => format!("[[#{anchor}]]"),
        },
        Inline::Project { doc, anchor, .. } => match doc {
            Some(d) => format!("![[{d}#{anchor}]]"),
            None => format!("![[#{anchor}]]"),
        },
        Inline::Footnote(r) => format!("[^{r}]"),
    }
}

fn ser_seq(ns: &[Inline], esc: bool) -> String {
    ns.iter().map(|n| ser_inline(n, esc)).collect()
}

fn reparses_to(text: &str, ns: &[Inline]) -> bool {
    let mut diags = Diags::default();
    let mut ctx = InlineCtx::new(&[], &mut diags, 1);
    parse_inline(text, &mut ctx) == ns
}

/// An inline sequence that re-parses to the same tree: verbatim when that
/// round-trips, escaped otherwise.
pub fn ser_inlines(ns: &[Inline]) -> String {
    let lazy = ser_seq(ns, false);
    if reparses_to(&lazy, ns) {
        return lazy;
    }
    let escaped = ser_seq(ns, true);
    if reparses_to(&escaped, ns) {
        return escaped;
    }
    escaped.replace("![[", "\\![[")
}

fn ser_list(list: &List, indent: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let start = list.start as i64;
    for (k, item) in list.items.iter().enumerate() {
        let marker = if list.ordered { format!("{}. ", start + k as i64) } else { "- ".to_string() };
        let task = match item.checked {
            None => "",
            Some(true) => "[x] ",
            Some(false) => "[ ] ",
        };
        let text = ser_inlines(&item.inlines);
        let mut parts = text.split('\n');
        let head = parts.next().unwrap_or("");
        out.push(format!("{indent}{marker}{task}{head}"));
        let cont_indent = format!("{indent}{}", " ".repeat(marker.len() + task.len()));
        for l in parts {
            out.push(format!("{cont_indent}{l}"));
        }
        for child in &item.children {
            out.push(ser_list(child, &format!("{indent}  ")));
        }
        if list.loose && k + 1 < list.items.len() {
            out.push(String::new());
        }
    }
    out.join("\n")
}

fn ser_typed_block(b: &Block) -> String {
    let fmt = b.attr_text("format").unwrap_or_else(|| "json".to_string());
    let body: Vec<String> = match b.mode {
        Mode::Flow | Mode::Prose => b.children.iter().map(ser_item).collect::<Vec<_>>().join("\n\n").split('\n').map(str::to_string).collect(),
        Mode::Data => b.data.iter().map(|(k, v)| format!("{k} = {}", ser_data_value(v))).collect(),
        Mode::Raw => {
            if let (true, Some(v), true) = (b.type_name == "data", b.value.as_ref(), b.attr("src").is_none() && (fmt == "json" || fmt == "jsonl")) {
                match (fmt.as_str(), v) {
                    ("jsonl", Value::Array(a)) => a.iter().map(to_json).collect(),
                    _ => pretty_json(v).split('\n').map(str::to_string).collect(),
                }
            } else {
                b.raw.clone()
            }
        }
    };
    let mut max_eq = 2;
    for ln in &body {
        let t = ln.trim_end_matches([' ', '\t']);
        if !t.is_empty() && t.chars().all(|c| c == '=') {
            max_eq = max_eq.max(t.len());
        }
    }
    let fence = "=".repeat((max_eq + 1).max(3));
    let attrs = ser_attrs(b.id.as_deref(), &b.classes, &b.attrs);
    let open = if attrs.is_empty() { format!("{fence} {}", b.type_name) } else { format!("{fence} {} {attrs}", b.type_name) };
    let mut lines = vec![open];
    lines.extend(body);
    lines.push(fence);
    lines.join("\n")
}

/// A paragraph line the scanner would read as structure keeps its escape.
fn starts_block(l: &str) -> bool {
    let run = l.chars().take_while(|c| *c == '=').count();
    if run >= 3 && l[run..].chars().next().map_or(true, |c| c == ' ' || c == '\t') {
        return true;
    }
    let hashes = l.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) && l[hashes..].starts_with([' ', '\t']) {
        return true;
    }
    if l.starts_with("%%") {
        return true;
    }
    let t = l.trim_start_matches([' ', '\t']);
    if let Some(rest) = t.strip_prefix(['-', '*']) {
        return rest.starts_with([' ', '\t']);
    }
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    digits > 0 && t[digits..].strip_prefix('.').is_some_and(|r| r.starts_with([' ', '\t']))
}

fn esc_block_starts(text: &str) -> String {
    text.split('\n').map(|l| if starts_block(l) { format!("\\{l}") } else { l.to_string() }).collect::<Vec<_>>().join("\n")
}

pub fn ser_item(it: &Item) -> String {
    match it {
        Item::Heading(h) => {
            let attrs = ser_attrs(Some(&h.id), &h.classes, &h.attrs);
            let text = ser_inlines(&h.inlines);
            if attrs.is_empty() {
                format!("{} {text}", "#".repeat(h.level))
            } else {
                format!("{} {text} {attrs}", "#".repeat(h.level))
            }
        }
        Item::Paragraph(p) => esc_block_starts(&ser_inlines(&p.inlines)),
        Item::Hidden(h) => {
            if h.text.is_empty() {
                "%%".to_string()
            } else {
                format!("%% {}", h.text)
            }
        }
        Item::List(l) => ser_list(l, ""),
        Item::Block(b) => ser_typed_block(b),
    }
}

/// The whole document, canonical.
pub fn serialize(items: &[Item]) -> String {
    format!("{}\n", items.iter().map(ser_item).collect::<Vec<_>>().join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_form() {
        let doc = crate::parse("# Tiny {#tiny}\n\nA *word* here.\n\n=== note {#n}\nbody\n===\n");
        assert_eq!(serialize(&doc.children), "# Tiny {#tiny}\n\nA *word* here.\n\n=== note {#n}\nbody\n===\n");
        let doc = crate::parse("=== meta\ntitle = \"Doc\"\nn = 1\n===\n\n- a\n- [x] b\n");
        assert_eq!(serialize(&doc.children), "=== meta\ntitle = Doc\nn = 1\n===\n\n- a\n- [x] b\n");
    }

    #[test]
    fn typed_guards() {
        assert!(looks_typed("12"));
        assert!(looks_typed("1.5e3"));
        assert!(looks_typed("true"));
        assert!(!looks_typed("abc"));
        assert!(!looks_typed("1.2.3"));
        assert_eq!(esc_meta_ref("see {{ title }} here"), "see \\{{ title }} here");
        assert!(starts_block("=== x"));
        assert!(starts_block("## h"));
        assert!(starts_block("- item"));
        assert!(starts_block("1. item"));
        assert!(!starts_block("plain"));
    }
}
