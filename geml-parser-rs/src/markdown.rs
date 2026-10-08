//! Markdown reading (`Options::markdown`): a `.md` file is parsed directly —
//! GEML's grammar is close enough to Markdown's that this keeps a round trip
//! byte-exact — and this module holds every place the two grammars disagree,
//! read the way Markdown reads it:
//!
//!  - `~~~` fences and indented code blocks are code, as ``` already is, and
//!    each code run is one code span, never inline-parsed;
//!  - `$$` math and HTML blocks hold no heading, fence or definition, and a
//!    `=== word` of a type this reader does not know is text;
//!  - a paragraph over a `===` or `---` underline is a setext heading;
//!  - `[^label]: …` defines a footnote, and a `[^x]` nothing defines is text;
//!  - a heading whose derived id is taken gets GitHub's suffix (`#notes-1`);
//!  - `{{…}}` is text — a template engine's, not a `meta` reference;
//!  - `[[name]]` / `![[name]]` are wikilinks, resolved by name;
//!  - a `[text](#frag)` may target an `<a id>`, `<a name>` or `<span id>`
//!    anchor, or GitHub's anchor for a heading — link targets, never addresses.
//!
//! The specification does not define Markdown; these are CommonMark's and
//! GitHub's rules, as the reference implementation reads them.

use std::collections::{HashMap, HashSet};

use unicode_general_category::{get_general_category, GeneralCategory};

use crate::block::{heading_level, list_item, parse_fence_open, parse_heading, HeadingLine};
use crate::model::Inline;
use crate::uni::{is_letter, is_mark, is_number, nfd};

fn indent(l: &str) -> usize {
    let mut n = 0;
    for c in l.chars() {
        match c {
            ' ' => n += 1,
            '\t' => n += 4 - (n % 4),
            _ => break,
        }
    }
    n
}

fn blank(l: Option<&String>) -> bool {
    l.map_or(true, |l| l.trim().is_empty())
}

/// Up to three spaces, then the rest of the line.
fn up_to_three(l: &str) -> Option<&str> {
    let n = l.bytes().take_while(|b| *b == b' ').count();
    (n <= 3).then(|| &l[n..])
}

/// `^ {0,3}(`{3,}|~{3,})(.*)$`: the fence run and what follows it.
pub fn fence_open(l: &str) -> Option<(char, usize, &str)> {
    let t = up_to_three(l)?;
    let c = t.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let n = t.chars().take_while(|x| *x == c).count();
    (n >= 3).then(|| (c, n, &t[n..]))
}

/// `^ {0,3}(`{3,}|~{3,})[ \t]*$`.
fn fence_close(l: &str) -> Option<(char, usize)> {
    let (c, n, rest) = fence_open(l)?;
    rest.chars().all(|x| x == ' ' || x == '\t').then_some((c, n))
}

/// `^---[ \t]*$` on the first line opens YAML front matter, closed by the
/// next `---` or `...` line: the index just past it, or 0 when there is none.
fn front_matter_end(lines: &[String]) -> usize {
    let dashes = |l: &str, pat: &str| l.strip_prefix(pat).is_some_and(|r| r.chars().all(|c| c == ' ' || c == '\t'));
    if !lines.first().is_some_and(|l| dashes(l, "---")) {
        return 0;
    }
    lines.iter().enumerate().skip(1).find(|(_, l)| dashes(l, "---") || dashes(l, "...")).map_or(0, |(k, _)| k + 1)
}

/// The lines CommonMark reads as code, as whole runs `[start, end)` — fence
/// lines included. A fence closes on a run of the same character at least as
/// long, alone on its line; unclosed, it shields nothing (one stray fence
/// emptying a listing is worse than the fault it would fix). An indented
/// block is four columns in, after a blank line or a heading, outside a list;
/// its trailing blank lines are not part of it.
pub fn code_runs(lines: &[String]) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let in_list = |k: usize| -> bool {
        for j in (0..k).rev() {
            let l = &lines[j];
            if l.trim().is_empty() || indent(l) >= 4 {
                continue;
            }
            return indent(l) > 0 || list_item(l).is_some();
        }
        false
    };
    let mut i = front_matter_end(lines);
    while i < lines.len() {
        let line = &lines[i];
        if let Some((c, n, info)) = fence_open(line) {
            if !(c == '`' && info.contains('`')) {
                let close = (i + 1..lines.len()).find(|j| fence_close(&lines[*j]).is_some_and(|(cc, nn)| cc == c && nn >= n));
                if let Some(close) = close {
                    runs.push((i, close + 1));
                    i = close + 1;
                    continue;
                }
            }
        }
        let prev = if i == 0 { None } else { lines.get(i - 1) };
        if !line.trim().is_empty() && indent(line) >= 4 && (i == 0 || blank(prev) || prev.is_some_and(|p| heading_level(p).is_some())) && !in_list(i) {
            let mut end = i + 1;
            while end < lines.len() && (lines[end].trim().is_empty() || indent(&lines[end]) >= 4) {
                end += 1;
            }
            while end > i + 1 && lines[end - 1].trim().is_empty() {
                end -= 1;
            }
            runs.push((i, end));
            i = end;
            continue;
        }
        i += 1;
    }
    runs
}

fn starts_ci(s: &str, p: &str) -> bool {
    s.len() >= p.len() && s.is_char_boundary(p.len()) && s[..p.len()].eq_ignore_ascii_case(p)
}

const RAW_TAGS: &[&str] = &["script", "pre", "style", "textarea"];
const BLOCK_TAGS: &[&str] = &[
    "address",
    "article",
    "aside",
    "base",
    "basefont",
    "blockquote",
    "body",
    "caption",
    "center",
    "col",
    "colgroup",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "frame",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hr",
    "html",
    "iframe",
    "legend",
    "li",
    "link",
    "main",
    "menu",
    "menuitem",
    "nav",
    "noframes",
    "ol",
    "optgroup",
    "option",
    "p",
    "param",
    "search",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "track",
    "ul",
];

/// `<tag` (or `</tag`, with `close`) followed by what `follows` admits.
fn tag_named(t: &str, names: &[&str], close: bool, follows: &dyn Fn(&str) -> bool) -> bool {
    let Some(mut r) = t.strip_prefix('<') else { return false };
    if close {
        r = r.strip_prefix('/').unwrap_or(r);
    }
    names.iter().any(|n| starts_ci(r, n) && follows(&r[n.len()..]))
}

/// `^ {0,3}<(?:script|pre|style|textarea)(?:[ \t>]|$)`, case-insensitive.
fn html_raw_open(l: &str) -> bool {
    up_to_three(l).is_some_and(|t| tag_named(t, RAW_TAGS, false, &|r| r.is_empty() || r.starts_with([' ', '\t', '>'])))
}

/// `</(?:script|pre|style|textarea)>` anywhere, case-insensitive.
fn html_raw_close(l: &str) -> bool {
    let lower = l.to_ascii_lowercase();
    RAW_TAGS.iter().any(|t| lower.contains(&format!("</{t}>")))
}

/// `^ {0,3}</?(?:block tag)(?:[ \t]|/?>|$)`, case-insensitive.
fn html_block_tag(l: &str) -> bool {
    up_to_three(l).is_some_and(|t| tag_named(t, BLOCK_TAGS, true, &|r| r.is_empty() || r.starts_with([' ', '\t', '>']) || r.starts_with("/>")))
}

fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-'
}

/// A tag alone on its line: `^ {0,3}(<name attrs* \s* /?>|</name \s*>)[ \t]*$`.
fn html_lone_tag(l: &str) -> bool {
    let Some(t) = up_to_three(l) else { return false };
    let t = t.trim_end_matches([' ', '\t']);
    let chars: Vec<char> = t.chars().collect();
    if chars.first() != Some(&'<') || chars.last() != Some(&'>') {
        return false;
    }
    let mut i = 1;
    let closing = chars.get(1) == Some(&'/');
    if closing {
        i += 1;
    }
    if !chars.get(i).is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    while i < chars.len() && name_char(chars[i]) {
        i += 1;
    }
    let ws = |i: &mut usize| {
        while *i < chars.len() && (chars[*i] == ' ' || chars[*i] == '\t') {
            *i += 1;
        }
    };
    if closing {
        ws(&mut i);
        return i == chars.len() - 1;
    }
    loop {
        let before = i;
        ws(&mut i);
        let attr_start = chars.get(i).is_some_and(|c| c.is_ascii_alphabetic() || *c == '_' || *c == ':');
        if i == before || !attr_start {
            break;
        }
        i += 1;
        while i < chars.len() && (chars[i].is_ascii_alphanumeric() || matches!(chars[i], '_' | '.' | ':' | '-')) {
            i += 1;
        }
        let save = i;
        ws(&mut i);
        if chars.get(i) == Some(&'=') {
            i += 1;
            ws(&mut i);
            match chars.get(i) {
                Some('"') | Some('\'') => {
                    let q = chars[i];
                    match chars[i + 1..].iter().position(|c| *c == q) {
                        Some(p) => i += p + 2,
                        None => return false,
                    }
                }
                Some(c) if !c.is_whitespace() && !matches!(c, '"' | '\'' | '=' | '<' | '>' | '`') => {
                    while i < chars.len() && !chars[i].is_whitespace() && !matches!(chars[i], '"' | '\'' | '=' | '<' | '>' | '`') {
                        i += 1;
                    }
                }
                _ => return false,
            }
        } else {
            i = save;
        }
    }
    ws(&mut i);
    if chars.get(i) == Some(&'/') {
        i += 1;
    }
    i == chars.len() - 1
}

/// `^ {0,3}\$\$[ \t]*$`.
fn math_fence(l: &str) -> bool {
    up_to_three(l).and_then(|t| t.strip_prefix("$$")).is_some_and(|r| r.chars().all(|c| c == ' ' || c == '\t'))
}

/// The runs where no construct starts besides code: `$$` math (a `$$` line
/// opens, the next closes) and CommonMark's seven kinds of HTML block. An
/// unclosed raw kind shields nothing.
fn block_runs(lines: &[String]) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let until = |from: usize, test: &dyn Fn(&str) -> bool| -> Option<usize> { (from..lines.len()).find(|j| test(&lines[*j])).map(|j| j + 1) };
    let mut i = 0;
    while i < lines.len() {
        let l = &lines[i];
        let t = up_to_three(l);
        let after = |p: &str| t.is_some_and(|t| t.starts_with(p));
        let end = if math_fence(l) {
            until(i + 1, &math_fence)
        } else if html_raw_open(l) {
            until(i, &html_raw_close)
        } else if after("<!--") {
            until(i, &|x| x.contains("-->"))
        } else if after("<?") {
            until(i, &|x| x.contains("?>"))
        } else if after("<![CDATA[") {
            until(i, &|x| x.contains("]]>"))
        } else if t.is_some_and(|t| t.starts_with("<!") && t[2..].starts_with(|c: char| c.is_ascii_alphabetic())) {
            until(i, &|x| x.contains('>'))
        } else if html_block_tag(l) || (html_lone_tag(l) && (i == 0 || lines[i - 1].trim().is_empty())) {
            let mut j = i + 1;
            while j < lines.len() && !lines[j].trim().is_empty() {
                j += 1;
            }
            Some(j)
        } else {
            None
        };
        match end {
            Some(e) if e > i => {
                runs.push((i, e));
                i = e;
            }
            _ => i += 1,
        }
    }
    runs
}

/// `[^label]: text` at the start of a line: the label and the text.
pub fn footnote_def(l: &str) -> Option<(String, String)> {
    let r = l.strip_prefix("[^")?;
    let close = r.find(']')?;
    if close == 0 {
        return None;
    }
    let rest = r[close + 1..].strip_prefix(':')?;
    let rest = rest.strip_prefix([' ', '\t']).unwrap_or(rest);
    Some((r[..close].to_string(), rest.to_string()))
}

/// `^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$`.
fn thematic_break(l: &str) -> bool {
    let Some(t) = up_to_three(l) else { return false };
    let Some(c) = t.chars().next().filter(|c| matches!(c, '-' | '*' | '_')) else { return false };
    let mut n = 0;
    for x in t.chars() {
        if x == c {
            n += 1;
        } else if x != ' ' && x != '\t' {
            return false;
        }
    }
    n >= 3
}

fn quote_line(l: &str) -> bool {
    up_to_three(l).is_some_and(|t| t.starts_with('>'))
}

fn comment(l: &str) -> bool {
    l.trim_start_matches([' ', '\t']).starts_with("%%")
}

/// A line that opens a construct of its own, so it cannot continue a paragraph.
pub fn opens_block(l: &str) -> bool {
    heading_level(l).is_some()
        || fence_open(l).is_some()
        || footnote_def(l).is_some()
        || l.starts_with("===")
        || quote_line(l)
        || list_item(l).is_some()
        || thematic_break(l)
        || comment(l)
        || up_to_three(l).is_some_and(|t| t.starts_with('<'))
}

/// Where a footnote definition opened at `i` ends (exclusive): GFM reads one
/// as a container that holds the lazy continuation of its first lines and,
/// past a blank line, whatever is indented four columns.
pub fn footnote_end(lines: &[String], i: usize) -> usize {
    let mut end = i + 1;
    for (j, l) in lines.iter().enumerate().skip(i + 1) {
        if l.trim().is_empty() {
            continue;
        }
        let indented = l.starts_with("    ") || up_to_three(l).is_some_and(|t| t.starts_with('\t'));
        if indented || (j == end && !opens_block(l)) {
            end = j + 1;
            continue;
        }
        break;
    }
    end
}

/// A setext heading: the heading its paragraph and underline make, and the
/// index just past the underline.
#[derive(Clone, Debug)]
pub struct Setext {
    pub heading: HeadingLine,
    /// The paragraph's lines, trimmed and joined: the heading as written.
    pub source: String,
    pub end: usize,
}

/// What the structure passes read, over one body's lines: the lines where no
/// construct starts, the code runs by their first line, and the setext
/// headings by the line their paragraph starts on.
#[derive(Default)]
pub struct Structure {
    pub shield: HashSet<usize>,
    pub code_at: HashMap<usize, usize>,
    pub setext: HashMap<usize, Setext>,
}

/// `^ {0,3}(=+|-+)[ \t]*$`: the heading level a setext underline gives.
fn setext_underline(l: &str) -> Option<usize> {
    let t = up_to_three(l)?;
    let c = t.chars().next().filter(|c| *c == '=' || *c == '-')?;
    let n = t.chars().take_while(|x| *x == c).count();
    t[n..].chars().all(|x| x == ' ' || x == '\t').then_some(if c == '=' { 1 } else { 2 })
}

/// The structure of `lines` read as Markdown. `known` says whether a fence's
/// type is one this reader knows; a `=== word` of any other type is text.
pub fn structure(lines: &[String], known: &dyn Fn(&str) -> bool) -> Structure {
    let mut st = Structure::default();
    let code = code_runs(lines);
    for (s, e) in &code {
        st.code_at.insert(*s, *e);
        st.shield.extend(*s..*e);
    }
    for (s, e) in block_runs(lines) {
        st.shield.extend(s..e);
    }
    let mut textual: HashSet<usize> = HashSet::new();
    for (k, l) in lines.iter().enumerate() {
        if st.shield.contains(&k) {
            continue;
        }
        if let Some(f) = fence_open_typed(l) {
            if !known(&f) {
                st.shield.insert(k);
                textual.insert(k);
            }
        }
    }
    let mut start: Option<usize> = None;
    let mut lazy = false;
    let mut k = front_matter_end(lines);
    while k < lines.len() {
        let l = &lines[k];
        if l.trim().is_empty() {
            start = None;
            lazy = false;
            k += 1;
            continue;
        }
        let under = if st.shield.contains(&k) { None } else { setext_underline(l) };
        if let (Some(level), Some(s)) = (under, start) {
            let text = lines[s..k].iter().map(|x| x.trim()).collect::<Vec<_>>().join(" ");
            if let Some(heading) = parse_heading(&format!("{} {text}", "#".repeat(level))) {
                st.setext.insert(s, Setext { heading, source: text, end: k + 1 });
            }
            start = None;
            k += 1;
            continue;
        }
        let plain = textual.contains(&k)
            || (!st.shield.contains(&k)
                && heading_level(l).is_none()
                && !l.starts_with("===")
                && fence_open(l).is_none()
                && footnote_def(l).is_none()
                && !comment(l)
                && !thematic_break(l));
        if !plain {
            start = None;
            lazy = false;
            k += 1;
            continue;
        }
        if list_item(l).is_some() || quote_line(l) {
            start = None;
            lazy = true;
            k += 1;
            continue;
        }
        if start.is_none() && !lazy {
            start = Some(k);
        }
        k += 1;
    }
    st
}

/// The type a `=== word …` line opens, by the open-fence shape alone.
fn fence_open_typed(l: &str) -> Option<String> {
    parse_fence_open(l).map(|f| f.type_name)
}

// ---------------------------------------------------------------------------
// Link targets: GitHub's heading anchors, HTML anchors, Obsidian block markers
// ---------------------------------------------------------------------------

/// JavaScript's `\s`, which these rules were written against.
fn js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// CommonMark's optional closing sequence (`## Title ##`) is not part of the
/// heading's text: a `#` run the text is separated from, or the whole text.
fn without_closing_hashes(s: &str) -> &str {
    let k = s.trim_end_matches('#').len();
    if k == s.len() || (k > 0 && !s[..k].ends_with([' ', '\t'])) {
        return s;
    }
    s[..k].trim_end_matches([' ', '\t'])
}

/// A text run as a renderer leaves it: every HTML tag removed — `<`, an
/// optional `/`, a letter, up to the next `>` with no `<` between — and any
/// `<` or `>` left over dropped too.
fn without_markup(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            '>' => {}
            '<' => {
                let mut j = i + 1;
                if c.get(j) == Some(&'/') {
                    j += 1;
                }
                if c.get(j).is_some_and(|x| x.is_ascii_alphabetic()) {
                    let mut k = j + 1;
                    while k < c.len() && c[k] != '<' && c[k] != '>' {
                        k += 1;
                    }
                    if c.get(k) == Some(&'>') {
                        i = k;
                    }
                }
            }
            x => out.push(x),
        }
        i += 1;
    }
    out
}

/// What a reader sees of a heading: code and math as written, a link's or an
/// emphasis's text, no markup; an image, a reference or a footnote nothing.
fn rendered_text(inlines: &[Inline]) -> String {
    let mut out = String::new();
    for n in inlines {
        match n {
            Inline::Text(t) => out.push_str(&without_markup(t)),
            Inline::Code(v) | Inline::Math(v) => out.push_str(v),
            Inline::Emph(c) | Inline::Strong(c) | Inline::Strike(c) | Inline::Link { children: c, .. } => out.push_str(&rendered_text(c)),
            _ => {}
        }
    }
    out
}

/// The anchors GitHub gives a document's headings, in document order:
/// github-slugger over the rendered text — lower-cased; every character but a
/// letter, a mark, a number, connector punctuation, a space or `-` deleted;
/// each space a `-` — and a repeated one `-1`, `-2`, … by its own count. Each
/// heading is `(source, text, inlines)`: the line after its `#` run (a
/// trailing `{…}` included — GitHub prints it), its text, its inlines.
pub fn github_anchors(headings: &[(String, String, Vec<Inline>)]) -> HashSet<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out = HashSet::new();
    for (source, text, inlines) in headings {
        let shown = without_closing_hashes(source.trim_end_matches([' ', '\t']));
        let rendered = if shown == text {
            rendered_text(inlines)
        } else {
            let mut d = crate::diag::Diags::default();
            let mut cx = crate::inline::InlineCtx::new(&[], &mut d, 1);
            cx.markdown = true;
            rendered_text(&crate::inline::parse_inline(shown, &mut cx))
        };
        let base: String = rendered
            .to_lowercase()
            .chars()
            .filter(|c| {
                is_letter(*c) || is_mark(*c) || is_number(*c) || *c == ' ' || *c == '-' || get_general_category(*c) == GeneralCategory::ConnectorPunctuation
            })
            .map(|c| if c == ' ' { '-' } else { c })
            .collect();
        if base.is_empty() {
            continue;
        }
        let mut anchor = base.clone();
        while seen.contains_key(&anchor) {
            let n = seen[&base] + 1;
            seen.insert(base.clone(), n);
            anchor = format!("{base}-{n}");
        }
        seen.insert(anchor.clone(), 0);
        out.insert(nfd(&anchor));
    }
    out
}

/// The line with every code span blanked to spaces; a backslash keeps the
/// character after it.
fn outside_code_spans(l: &str) -> String {
    let c: Vec<char> = l.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '\\' && i + 1 < c.len() {
            out.extend(&c[i..i + 2]);
            i += 2;
            continue;
        }
        if c[i] == '`' {
            let n = c[i..].iter().take_while(|x| **x == '`').count();
            let mut k = i + n;
            let mut close = None;
            while k < c.len() {
                if c[k] != '`' {
                    k += 1;
                    continue;
                }
                let r = c[k..].iter().take_while(|x| **x == '`').count();
                if r == n {
                    close = Some(k);
                    break;
                }
                k += r;
            }
            match close {
                Some(k) => {
                    out.extend(std::iter::repeat(' ').take(k + n - i));
                    i = k + n;
                }
                None => {
                    out.extend(&c[i..i + n]);
                    i += n;
                }
            }
            continue;
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// The attributes of a tag from `at` on: `\s+name(\s*=\s*value)?`, names
/// lower-cased, reading stopping at the first thing that is not one.
fn html_attributes(tag: &[char], mut at: usize) -> Vec<(String, String)> {
    let mut out = Vec::new();
    loop {
        let s = at;
        while at < tag.len() && js_ws(tag[at]) {
            at += 1;
        }
        if at == s {
            break;
        }
        let n0 = at;
        while at < tag.len() && !js_ws(tag[at]) && !matches!(tag[at], '"' | '\'' | '<' | '>' | '/' | '=') {
            at += 1;
        }
        if at == n0 {
            break;
        }
        let name: String = tag[n0..at].iter().collect::<String>().to_ascii_lowercase();
        let mut value = String::new();
        let mut k = at;
        while k < tag.len() && js_ws(tag[k]) {
            k += 1;
        }
        if tag.get(k) == Some(&'=') {
            k += 1;
            while k < tag.len() && js_ws(tag[k]) {
                k += 1;
            }
            match tag.get(k) {
                Some(q @ ('"' | '\'')) => {
                    if let Some(p) = tag[k + 1..].iter().position(|x| x == q) {
                        value = tag[k + 1..k + 1 + p].iter().collect();
                        at = k + 2 + p;
                    }
                }
                Some(x) if !js_ws(*x) && !matches!(x, '"' | '\'' | '=' | '<' | '>' | '`') => {
                    let v0 = k;
                    while k < tag.len() && !js_ws(tag[k]) && !matches!(tag[k], '"' | '\'' | '=' | '<' | '>' | '`') {
                        k += 1;
                    }
                    value = tag[v0..k].iter().collect();
                    at = k;
                }
                _ => {}
            }
        }
        out.push((name, value));
    }
    out
}

/// The `<a id>`, `<a name>` and `<span id>` anchors of a document — outside
/// code, code spans and comments — by NFD key: link targets, never ids.
pub fn html_anchors(lines: &[String]) -> HashSet<String> {
    let shielded: HashSet<usize> = code_runs(lines).into_iter().flat_map(|(s, e)| s..e).collect();
    let mut out = HashSet::new();
    let mut in_comment = false;
    for (k, l) in lines.iter().enumerate() {
        if shielded.contains(&k) || (!in_comment && !l.contains('<')) {
            continue;
        }
        let line = outside_code_spans(l);
        let mut s = String::new();
        let mut i = 0;
        loop {
            let pat = if in_comment { "-->" } else { "<!--" };
            let at = line[i..].find(pat).map(|p| i + p);
            if !in_comment {
                s.push_str(&line[i..at.unwrap_or(line.len())]);
            }
            let Some(at) = at else { break };
            i = at + pat.len();
            in_comment = !in_comment;
        }
        let c: Vec<char> = s.chars().collect();
        let mut i = 0;
        while i < c.len() {
            if c[i] != '<' {
                i += 1;
                continue;
            }
            let name_len = if c.get(i + 1).is_some_and(|x| x.eq_ignore_ascii_case(&'a')) && c.get(i + 2).is_some_and(|x| js_ws(*x) || *x == '/' || *x == '>') {
                1
            } else if c.len() >= i + 5
                && c[i + 1..i + 5].iter().collect::<String>().eq_ignore_ascii_case("span")
                && c.get(i + 5).is_some_and(|x| js_ws(*x) || *x == '/' || *x == '>')
            {
                4
            } else {
                i += 1;
                continue;
            };
            let Some(close) = c[i + 1..].iter().position(|x| *x == '<' || *x == '>').map(|p| i + 1 + p) else { break };
            if c[close] == '<' {
                i = close;
                continue;
            }
            let tag = &c[i..=close];
            for (name, value) in html_attributes(tag, name_len + 1) {
                if (name == "id" || (name_len == 1 && name == "name")) && !value.is_empty() {
                    out.insert(nfd(&value));
                }
            }
            i = close + 1;
        }
    }
    out
}

/// Obsidian's block markers: a line ending in ` ^id`, outside code.
pub fn block_markers(lines: &[String]) -> HashSet<String> {
    let shielded: HashSet<usize> = code_runs(lines).into_iter().flat_map(|(s, e)| s..e).collect();
    let mut out = HashSet::new();
    for (k, l) in lines.iter().enumerate() {
        if shielded.contains(&k) {
            continue;
        }
        let t = l.trim_end_matches([' ', '\t']);
        let id_len = t.chars().rev().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').count();
        if id_len == 0 {
            continue;
        }
        let head = &t[..t.len() - id_len];
        if let Some(before) = head.strip_suffix('^') {
            if before.is_empty() || before.chars().last().is_some_and(js_ws) {
                out.insert(t[t.len() - id_len..].to_string());
            }
        }
    }
    out
}

/// A Markdown link's destination: `<…>` unwrapped, and a title after it —
/// `"…"`, `'…'` or `(…)` — dropped, since only the destination is a target.
pub fn link_destination(content: &str) -> String {
    let d = content.trim_matches(js_ws);
    if let Some(r) = d.strip_prefix('<') {
        if let Some(end) = r.find('>') {
            return r[..end].to_string();
        }
    }
    if let Some(p) = d.find(js_ws) {
        let (dest, rest) = (&d[..p], d[p..].trim_start_matches(js_ws));
        let titled = |o: char, c: char, inner_bad: &dyn Fn(char) -> bool| {
            rest.len() >= 2 && rest.starts_with(o) && rest.ends_with(c) && !rest[1..rest.len() - 1].chars().any(inner_bad)
        };
        if titled('"', '"', &|x| x == '"') || titled('\'', '\'', &|x| x == '\'') || titled('(', ')', &|x| x == '(' || x == ')') {
            return dest.to_string();
        }
    }
    d.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ls(s: &str) -> Vec<String> {
        s.split('\n').map(str::to_string).collect()
    }

    #[test]
    fn code() {
        assert_eq!(code_runs(&ls("a\n\n```\nx\n```\n\n~~~~\ny\n~~~\n~~~~\nz")), vec![(2, 5), (6, 10)]);
        assert_eq!(code_runs(&ls("```\nunclosed")), vec![]);
        assert_eq!(code_runs(&ls("p\n\n    code\n    more\n\nafter")), vec![(2, 4)]);
        assert_eq!(code_runs(&ls("- item\n\n    continued")), vec![]);
        assert_eq!(code_runs(&ls("# H\n    code")), vec![(1, 2)]);
        assert_eq!(code_runs(&ls("---\n    yaml: x\n---\n")), vec![]);
        assert_eq!(code_runs(&ls("``` a`b\n```")), vec![]);
    }

    #[test]
    fn blocks() {
        assert_eq!(block_runs(&ls("$$\nx\n$$\n<!-- c\n-->\n<div>\n## not\n\nafter")), vec![(0, 3), (3, 5), (5, 7)]);
        assert_eq!(block_runs(&ls("<pre>\n# x\n</pre>")), vec![(0, 3)]);
        assert_eq!(block_runs(&ls("<?php\n?>\n<!DOCTYPE html>\n<![CDATA[\n]]>")), vec![(0, 2), (2, 3), (3, 5)]);
        assert_eq!(block_runs(&ls("\n<span id=\"x\">\ntext\n\nmore")), vec![(1, 3)]);
        assert_eq!(block_runs(&ls("text\n<span>")), vec![]);
        assert!(html_lone_tag("<a id='x' name=y data-z>") && html_lone_tag("</a>") && html_lone_tag("<br/>"));
        assert!(!html_lone_tag("<a> text") && !html_lone_tag("<1>") && !html_lone_tag("<a id='x>"));
    }

    #[test]
    fn setext_and_footnotes() {
        let st = structure(&ls("Title\n=====\n\nSub\nline\n---\n\n- item\nlazy\n---"), &|_| true);
        assert_eq!(st.setext[&0].heading.text, "Title");
        assert_eq!((st.setext[&0].heading.level, st.setext[&0].end), (1, 2));
        assert_eq!((st.setext[&3].heading.text.as_str(), st.setext[&3].heading.level), ("Sub line", 2));
        assert_eq!(st.setext.len(), 2);
        let st = structure(&ls("=== wonder\n=== note\n==="), &|t| t == "note");
        assert!(st.shield.contains(&0) && !st.shield.contains(&1));
        assert_eq!(footnote_def("[^a]: text"), Some(("a".into(), "text".into())));
        assert_eq!(footnote_def("[^]: x"), None);
        assert_eq!(footnote_end(&ls("[^a]: one\ntwo\n\n    three\n\nafter"), 0), 4);
        assert_eq!(footnote_end(&ls("[^a]: one\n# h"), 0), 1);
        assert!(thematic_break("* * *") && !thematic_break("**x"));
    }
}
