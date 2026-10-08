//! What writing into a Markdown document adds to the verbs: content written
//! in GEML lands as Markdown, a Markdown heading's anchor is its text (so a
//! heading whose text changes takes the anchor of the new text, and the links
//! to it follow), and such an anchor cannot be renamed apart from the text.
//! These are the reference implementation's rules; the specification does not
//! define Markdown.

use crate::attrs::read_object;

use super::lines::{newline_of, split_physical, strip_eol, to_newline};
use super::select::Indexed;
use super::units::{addressed_units, Span};
use super::{refuse, Reason, Refusal};

/// JavaScript's `\s`.
fn ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `^[ ]{0,3}(`{3,}|~{3,})`: a Markdown fence's run.
fn fence_run(line: &str) -> Option<String> {
    let n = line.bytes().take_while(|b| *b == b' ').count();
    if n > 3 {
        return None;
    }
    let t = &line[n..];
    let c = t.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let len = t.chars().take_while(|x| *x == c).count();
    (len >= 3).then(|| c.to_string().repeat(len))
}

/// Whether `line` closes the fence `open` was: the bare run of the same
/// character, at least as long.
fn closes(open: &str, line: &str) -> bool {
    fence_run(line).is_some_and(|r| r.starts_with(&open[..1]) && r.len() >= open.len() && line.trim() == r)
}

/// The attribute object ending a heading line, when there is one — `{#x}`,
/// `{.c}`, `{key=v}` — and not `{a, b}` in a heading about sets.
fn heading_attr_object(line: &str) -> Option<String> {
    let inner = trailing_braces(strip_eol(line))?.trim().to_string();
    let keyed = || {
        let mut cs = inner.chars();
        cs.next().is_some_and(|c| c.is_ascii_alphabetic()) && {
            let rest: String = cs.collect();
            let k = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').count();
            rest[k..].starts_with('=')
        }
    };
    (inner.starts_with('#') || inner.starts_with('.') || keyed()).then_some(inner)
}

/// `\{([^{}]*)\}[ \t]*$`: what the last brace group of a line holds.
fn trailing_braces(line: &str) -> Option<&str> {
    let t = line.trim_end_matches([' ', '\t']);
    let body = t.strip_suffix('}')?;
    let open = body.rfind(['{', '}'])?;
    (body.as_bytes()[open] == b'{').then(|| &body[open + 1..])
}

/// Is this content GEML rather than Markdown? Only syntax Markdown cannot
/// mean counts: a typed-block fence, or an attribute object ending a heading
/// line. What Markdown's own fences hold is code; `[[…]]`, `{{…}}` and `%%`
/// have Markdown meanings of their own.
pub fn geml_syntax_in(text: &str) -> bool {
    let mut fence: Option<String> = None;
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(open) = &fence {
            if closes(open, line) {
                fence = None;
            }
            continue;
        }
        if let Some(run) = fence_run(line) {
            fence = Some(run);
            continue;
        }
        let n = line.bytes().take_while(|b| *b == b' ').count();
        if n <= 3 {
            let t = &line[n..];
            let eq = t.bytes().take_while(|b| *b == b'=').count();
            if eq >= 3 && t[eq..].trim_start_matches([' ', '\t']).starts_with(|c: char| c.is_ascii_alphabetic()) {
                return true;
            }
            let hashes = t.bytes().take_while(|b| *b == b'#').count();
            if (1..=6).contains(&hashes) && t[hashes..].starts_with([' ', '\t']) && heading_attr_object(line).is_some() {
                return true;
            }
        }
    }
    false
}

/// GEML content headed for a `.md` lands as Markdown, converted as `to md`
/// converts a document, so the file stays the Markdown it was. What the
/// conversion would lose — a table whose rows are not in the content — is
/// refused rather than written empty. Markdown content lands verbatim.
pub fn as_markdown(text: &str, file: &str) -> Result<String, Refusal> {
    if !crate::is_markdown_path(file) || !geml_syntax_in(text) {
        return Ok(text.to_string());
    }
    let (md, notes) = super::to_md::to_md_with(&crate::parse(text), true);
    if let Some(lost) = notes.iter().find(|n| n.contains("could not be read")) {
        return refuse(
            Reason::BadContent,
            format!("the content is GEML, and converting it to Markdown for {file} would lose data ({lost}) — write that part in Markdown"),
        );
    }
    // The blank lines around the content separate it from its neighbours.
    let mut lead = 0;
    loop {
        let rest = &text[lead..];
        let sp = rest.len() - rest.trim_start_matches([' ', '\t']).len();
        let r = &rest[sp..];
        let nl = if r.starts_with("\r\n") {
            2
        } else if r.starts_with('\n') {
            1
        } else {
            0
        };
        if nl == 0 {
            break;
        }
        lead += sp + nl;
    }
    let mut end = text.len();
    loop {
        let t = text[..end].trim_end_matches([' ', '\t']);
        let Some(cut) = t.strip_suffix('\n') else { break };
        end = cut.strip_suffix('\r').unwrap_or(cut).len();
    }
    let trail = &text[end.max(lead)..];
    let trail = if trail.is_empty() { "\n" } else { trail };
    Ok(format!("{}{}{trail}", &text[..lead], md.trim_end_matches('\n')))
}

/// Does a heading line declare its id with an attribute object (`## T {#x}`)?
pub fn declares_id(line: &str) -> bool {
    trailing_braces(strip_eol(line)).is_some_and(|inner| {
        let chars: Vec<char> = inner.chars().collect();
        read_object(&chars).id.is_some()
    })
}

/// The id the unit at `span` would carry with `text` spliced in its place:
/// in Markdown a heading's anchor depends on the headings above it.
pub fn id_in_place(ix: &Indexed, span: Span, text: &str) -> Option<String> {
    let lines = split_physical(ix.text);
    let nl = newline_of(ix.text);
    let mut frag = to_newline(text, nl);
    if !frag.ends_with('\n') {
        frag.push_str(nl);
    }
    let trial = format!("{}{frag}{}", lines[..span.start.min(lines.len())].concat(), lines[span.end.min(lines.len())..].concat());
    let doc = super::write::reparse(ix, &trial);
    addressed_units(&trial, &doc).into_iter().find(|a| a.unit.span.start == span.start).and_then(|a| a.unit.id)
}

/// The index of the next run of exactly `n` backticks after the opener at `i`.
fn code_span_close(s: &[char], i: usize, n: usize) -> Option<usize> {
    let mut k = i + n;
    while k < s.len() {
        if s[k] != '`' {
            k += 1;
            continue;
        }
        let r = s[k..].iter().take_while(|c| **c == '`').count();
        if r == n {
            return Some(k);
        }
        k += r;
    }
    None
}

/// `](` `\s*` `#old` followed by whitespace or `)`, in prose: every one
/// rewritten to `#new`.
fn relink_prose(s: &[char], old: &[char], new: &str, count: &mut usize) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < s.len() {
        if s[i] == ']' && s.get(i + 1) == Some(&'(') {
            let mut k = i + 2;
            while k < s.len() && ws(s[k]) {
                k += 1;
            }
            let end = k + 1 + old.len();
            if s.get(k) == Some(&'#') && end <= s.len() && s[k + 1..end] == *old && s.get(end).is_some_and(|c| ws(*c) || *c == ')') {
                out.extend(&s[i..=k]);
                out.push_str(new);
                *count += 1;
                i = end;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

/// A reference definition `[label]: #old` at the start of a line.
fn relink_refdef(line: &str, old: &str, new: &str, count: &mut usize) -> String {
    let n = line.bytes().take_while(|b| *b == b' ').count();
    if n > 3 {
        return line.to_string();
    }
    let t = &line[n..];
    let Some(close) = t.strip_prefix('[').and_then(|r| r.find(']')) else { return line.to_string() };
    if close == 0 {
        return line.to_string();
    }
    let after = &t[close + 2..];
    let Some(rest) = after.strip_prefix(':') else { return line.to_string() };
    let sp = rest.len() - rest.trim_start_matches([' ', '\t']).len();
    let target = &rest[sp..];
    match target.strip_prefix('#').and_then(|x| x.strip_prefix(old)) {
        Some(tail) if tail.is_empty() || tail.starts_with(ws) => {
            *count += 1;
            let lead = line.len() - target.len();
            format!("{}#{new}{tail}", &line[..lead])
        }
        _ => line.to_string(),
    }
}

/// Point a Markdown document's links at `#new` where they pointed at `#old`:
/// an inline link's destination (a title may follow) and a reference
/// definition. Code — a fence, a code span — is left alone, and the fragment
/// must match whole. The text, and how many links moved.
pub fn relink(source: &str, old: &str, new: &str) -> (String, usize) {
    let old_chars: Vec<char> = old.chars().collect();
    let mut count = 0;
    let mut out = String::new();
    let mut fence: Option<String> = None;
    for raw in split_physical(source) {
        let line = strip_eol(raw);
        let eol = &raw[line.len()..];
        if let Some(open) = &fence {
            if closes(open, line) {
                fence = None;
            }
            out.push_str(raw);
            continue;
        }
        if let Some(run) = fence_run(line) {
            fence = Some(run);
            out.push_str(raw);
            continue;
        }
        let line = relink_refdef(line, old, new, &mut count);
        let s: Vec<char> = line.chars().collect();
        let mut j = 0;
        while j < s.len() {
            if s[j] != '`' {
                let next = s[j..].iter().position(|c| *c == '`').map_or(s.len(), |p| j + p);
                out.push_str(&relink_prose(&s[j..next], &old_chars, new, &mut count));
                j = next;
                continue;
            }
            let n = s[j..].iter().take_while(|c| **c == '`').count();
            match code_span_close(&s, j, n) {
                Some(close) => {
                    out.extend(&s[j..close + n]);
                    j = close + n;
                }
                None => {
                    out.extend(&s[j..j + n]);
                    j += n;
                }
            }
        }
        out.push_str(eol);
    }
    (out, count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geml_or_markdown() {
        assert!(geml_syntax_in("=== note\nx\n==="));
        assert!(geml_syntax_in("   === table {#t}\n"));
        assert!(geml_syntax_in("## T {#x}\n"));
        assert!(geml_syntax_in("## T {lang=en}\n"));
        assert!(!geml_syntax_in("## Sets {a, b}\n"));
        assert!(!geml_syntax_in("Title\n===\n"));
        assert!(!geml_syntax_in("```\n=== note\n```\n"));
        assert!(!geml_syntax_in("~~~~\n```\n=== note\n```\n~~~~\n"));
        assert!(!geml_syntax_in("[[x]] {{y}} %% z"));
    }

    #[test]
    fn conversion() {
        assert_eq!(as_markdown("\n\n=== note\nTip\n===\n\n\n", "a.md").unwrap(), "\n\n> Tip\n\n\n");
        assert_eq!(as_markdown("=== note\nTip\n===", "a.md").unwrap(), "> Tip\n");
        assert_eq!(as_markdown("=== note\nTip\n===", "a.geml").unwrap(), "=== note\nTip\n===");
        assert_eq!(as_markdown("plain *md*\n", "a.md").unwrap(), "plain *md*\n");
        assert_eq!(as_markdown("=== view {src=#t}\n===\n", "a.md").unwrap_err().reason, Reason::BadContent);
    }

    #[test]
    fn ids_and_links() {
        assert!(declares_id("## T {#x}\n") && !declares_id("## T {.c}") && !declares_id("## T"));
        let (t, n) = relink("See [a](#old) and [b]( #old \"t\") and [c](#old-x) and `[d](#old)`.\n[r]: #old\n```\n[e](#old)\n```\n", "old", "new");
        assert_eq!(t, "See [a](#new) and [b]( #new \"t\") and [c](#old-x) and `[d](#old)`.\n[r]: #new\n```\n[e](#old)\n```\n");
        assert_eq!(n, 3);
    }
}
