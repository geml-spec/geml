//! Markdown → GEML, what `to geml` prints for a Markdown input. Markdown's
//! inline syntax is already a subset of GEML's (§5), so inline text passes
//! through; the work is mapping block constructs onto GEML's typed blocks:
//!
//!   YAML front matter       -> `=== meta`
//!   ``` / ~~~ fenced code   -> `=== code {lang=…}` (a diagram language: `=== diagram {format=…}`)
//!   `$$ … $$` math          -> `=== math`
//!   `> quote`               -> `=== note`
//!   `[^id]: text`           -> `=== note {#id}`
//!   GFM pipe table          -> `=== table`
//!   setext heading          -> ATX heading
//!   thematic break          -> dropped, with a note
//!
//! The specification does not define Markdown; these are the reference
//! implementation's rules. Whitespace is JavaScript's (`\s`, `trim`), as theirs.

use crate::uni::{is_letter, is_number};

/// JavaScript's `\s`.
fn ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn trim(s: &str) -> &str {
    s.trim_matches(ws)
}

fn blank(s: &str) -> bool {
    trim(s).is_empty()
}

/// `^\s*(=+)\s*$`: the `=` run alone on a line.
fn bare_eq_run(l: &str) -> Option<usize> {
    let t = trim(l);
    (!t.is_empty() && t.chars().all(|c| c == '=')).then(|| t.chars().count())
}

/// A fence longer than any `=` run alone on a body line, so the close stays
/// unambiguous and the body's own fences nest.
fn fence_for(body: &[String]) -> String {
    let max = body.iter().filter_map(|l| bare_eq_run(l)).fold(2, usize::max);
    "=".repeat((max + 1).max(3))
}

/// A typed block, with a `#type-N` id unless it has one or is `meta`.
fn emit_block(out: &mut Vec<String>, ids: &mut Vec<(String, usize)>, ty: &str, attrs: &str, body: Vec<String>) {
    let mut attrs = attrs.to_string();
    if ty != "meta" && !attrs.contains('#') {
        let n = match ids.iter_mut().find(|(t, _)| t == ty) {
            Some((_, n)) => {
                *n += 1;
                *n
            }
            None => {
                ids.push((ty.to_string(), 1));
                1
            }
        };
        let id = format!("#{ty}-{n}");
        attrs = match attrs.strip_prefix('{') {
            Some(rest) => format!("{{{id} {rest}"),
            None => format!("{{{id}}}"),
        };
    }
    let fence = fence_for(&body);
    out.push(if attrs.is_empty() { format!("{fence} {ty}") } else { format!("{fence} {ty} {attrs}") });
    out.extend(body);
    out.push(fence);
}

const DIAGRAM_LANGS: &[&str] = &["mermaid", "graphviz", "dot", "d2", "plantuml"];

/// `key: value` → `key=value`, quoting a value that would be re-tokenized.
fn meta_line(line: &str) -> Option<String> {
    let (key, rest) = yaml_key(line)?;
    let mut v = trim(rest).to_string();
    if v.is_empty() {
        return Some(format!("{key}=\"\""));
    }
    if (v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')) {
        let chars: Vec<char> = v.chars().collect();
        v = if chars.len() >= 2 { chars[1..chars.len() - 1].iter().collect() } else { String::new() };
    }
    let bare_safe = !v.is_empty() && !v.chars().any(|c| ws(c) || c == '"');
    Some(if bare_safe { format!("{key}={v}") } else { format!("{key}=\"{v}\"") })
}

/// `^([A-Za-z_][\w-]*)\s*:\s*(.*)$`: the key and what follows the colon.
fn yaml_key(line: &str) -> Option<(&str, &str)> {
    let first = line.chars().next().filter(|c| c.is_ascii_alphabetic() || *c == '_')?;
    let mut end = first.len_utf8();
    for c in line[end..].chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            end += c.len_utf8();
        } else {
            break;
        }
    }
    let rest = line[end..].trim_start_matches(ws).strip_prefix(':')?;
    Some((&line[..end], rest.trim_start_matches(ws)))
}

/// The plain text of a YAML scalar, as `to md` writes one.
fn yaml_scalar(v: &str) -> String {
    let v = trim(v);
    let n = v.chars().count();
    if n >= 2 && v.starts_with('"') && v.ends_with('"') {
        if let Ok(crate::json::Value::String(s)) = crate::json::parse(v) {
            return s;
        }
        return v[1..v.len() - 1].to_string();
    }
    if n >= 2 && v.starts_with('\'') && v.ends_with('\'') {
        return v[1..v.len() - 1].to_string();
    }
    v.to_string()
}

/// `<https://…>`, `<ftp://…>` and `<mailto:…>` → GEML links, outside
/// single-backtick code spans.
fn autolinks(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while !rest.is_empty() {
        // Split as `/(`[^`]*`)/` does: a backtick pair is kept whole.
        let (plain, code, after) = match rest.find('`') {
            Some(a) => match rest[a + 1..].find('`') {
                Some(b) => (&rest[..a], &rest[a..a + b + 2], &rest[a + b + 2..]),
                None => (rest, "", ""),
            },
            None => (rest, "", ""),
        };
        out.push_str(&autolink_plain(plain));
        out.push_str(code);
        rest = after;
    }
    out
}

fn autolink_plain(s: &str) -> String {
    let mut out = String::new();
    let mut i = 0;
    while let Some(off) = s[i..].find('<') {
        let at = i + off;
        out.push_str(&s[i..at]);
        let body = &s[at + 1..];
        let url_end = body.find(|c: char| c == '>' || ws(c));
        let link = url_end.filter(|e| body[*e..].starts_with('>') && *e > 0).and_then(|e| {
            let u = &body[..e];
            for scheme in ["http://", "https://", "ftp://"] {
                if u.starts_with(scheme) && u.len() > scheme.len() {
                    return Some((format!("[{u}]({u})"), e));
                }
            }
            u.strip_prefix("mailto:").filter(|m| !m.is_empty()).map(|m| (format!("[{m}](mailto:{m})"), e))
        });
        match link {
            Some((l, e)) => {
                out.push_str(&l);
                i = at + 1 + e + 1;
            }
            None => {
                out.push('<');
                i = at + 1;
            }
        }
    }
    out.push_str(&s[i..]);
    out
}

fn backtick_run(s: &[char], i: usize) -> usize {
    s[i..].iter().take_while(|c| **c == '`').count()
}

/// The next run of exactly `n` backticks after the opener at `i`.
fn code_span_close(s: &[char], i: usize, n: usize) -> Option<usize> {
    let mut k = i + n;
    while k < s.len() {
        if s[k] != '`' {
            k += 1;
            continue;
        }
        let r = backtick_run(s, k);
        if r == n {
            return Some(k);
        }
        k += r;
    }
    None
}

/// `\{\{\s*[A-Za-z_][A-Za-z0-9_-]*\s*\}\}` at `i`.
fn meta_ref_at(s: &[char], i: usize) -> bool {
    if s.get(i) != Some(&'{') || s.get(i + 1) != Some(&'{') {
        return false;
    }
    let mut k = i + 2;
    while k < s.len() && ws(s[k]) {
        k += 1;
    }
    if !s.get(k).is_some_and(|c| c.is_ascii_alphabetic() || *c == '_') {
        return false;
    }
    k += 1;
    while k < s.len() && (s[k].is_ascii_alphanumeric() || s[k] == '_' || s[k] == '-') {
        k += 1;
    }
    while k < s.len() && ws(s[k]) {
        k += 1;
    }
    s.get(k) == Some(&'}') && s.get(k + 1) == Some(&'}')
}

/// A literal `{{name}}` in Markdown prose is text; escaped to `\{{name}}` so
/// GEML does not read it as a `meta` reference — outside code spans, inline
/// math and characters already escaped.
fn esc_meta_refs(s: &str) -> String {
    if !s.contains("{{") {
        return s.to_string();
    }
    let s: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        if c == '\\' && i + 1 < s.len() {
            out.extend(&s[i..i + 2]);
            i += 2;
            continue;
        }
        if c == '`' {
            let n = backtick_run(&s, i);
            match code_span_close(&s, i, n) {
                Some(close) => {
                    out.extend(&s[i..close + n]);
                    i = close + n;
                }
                None => {
                    out.extend(&s[i..i + n]);
                    i += n;
                }
            }
            continue;
        }
        if c == '$' {
            if let Some(off) = s[i + 1..].iter().position(|x| *x == '$') {
                let close = i + 1 + off;
                if close > i + 1 {
                    out.extend(&s[i..=close]);
                    i = close + 1;
                    continue;
                }
            }
            out.push(c);
            i += 1;
            continue;
        }
        if c == '{' && meta_ref_at(&s, i) {
            out.push_str("\\{");
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// GitHub's anchor for a heading: backticks dropped, lower-cased, every
/// character but a letter, a number, whitespace, `_` and `-` removed,
/// trimmed, whitespace runs made `-`.
fn github_slug(text: &str) -> String {
    let kept: String = text.replace('`', "").to_lowercase().chars().filter(|c| is_letter(*c) || is_number(*c) || ws(*c) || *c == '_' || *c == '-').collect();
    let mut out = String::new();
    let mut gap = false;
    for c in trim(&kept).chars() {
        if ws(c) {
            gap = true;
            continue;
        }
        if gap {
            out.push('-');
            gap = false;
        }
        out.push(c);
    }
    out
}

/// `^(\s*)(`{3,}|~{3,})(.*)$`: the marker and the info after it.
fn fence(l: &str) -> Option<(String, &str)> {
    let t = l.trim_start_matches(ws);
    let c = t.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let n = t.chars().take_while(|x| *x == c).count();
    (n >= 3).then(|| (c.to_string().repeat(n), &t[n..]))
}

/// A closing fence: at most three columns in, the same marker, at least as
/// long, nothing but marker characters.
fn closes_fence(raw: &str, marker: &str) -> bool {
    let indent = raw.chars().take_while(|c| ws(*c)).count();
    let c = trim(raw);
    indent <= 3 && c.chars().count() >= marker.chars().count() && c.chars().next() == marker.chars().next() && c.chars().all(|x| x == '`' || x == '~')
}

/// `^=+\s*$` and `^-+\s*$`, at column 0.
fn underline(l: &str, c: char) -> bool {
    let n = l.chars().take_while(|x| *x == c).count();
    n > 0 && l.chars().skip(n).all(ws)
}

/// `^\s*([-*_])(\s*\1){2,}\s*$`.
fn thematic(l: &str) -> bool {
    let t = trim(l);
    let Some(c) = t.chars().next().filter(|c| matches!(c, '-' | '*' | '_')) else { return false };
    let mut n = 0;
    for x in t.chars() {
        if x == c {
            n += 1;
        } else if !ws(x) {
            return false;
        }
    }
    n >= 3
}

/// `^#\s+`.
fn h1_start(l: &str) -> bool {
    l.strip_prefix('#').is_some_and(|r| r.starts_with(ws))
}

/// `^(#{1,6})\s+(.*?)\s*$`: the level and the text.
fn atx(l: &str) -> Option<(usize, &str)> {
    let n = l.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&n) {
        return None;
    }
    let rest = &l[n..];
    if !rest.starts_with(ws) {
        return None;
    }
    Some((n, rest.trim_matches(ws)))
}

/// Whether the lines from `from` hold a level-1 heading outside fenced code.
fn has_level_one_heading(lines: &[String], from: usize) -> bool {
    let mut open: Option<String> = None;
    for k in from..lines.len() {
        let line = &lines[k];
        if let Some(m) = &open {
            if closes_fence(line, m) {
                open = None;
            }
            continue;
        }
        if let Some((m, _)) = fence(line) {
            open = Some(m);
            continue;
        }
        if h1_start(line) {
            return true;
        }
        if !blank(line) && !thematic(line) && lines.get(k + 1).is_some_and(|n| underline(n, '=')) {
            return true;
        }
    }
    false
}

/// `^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$`.
fn table_sep(l: &str) -> bool {
    let mut t = trim(l);
    if let Some(r) = t.strip_prefix('|') {
        t = r;
    }
    if let Some(r) = t.strip_suffix('|') {
        t = r;
    }
    t.split('|').all(|cell| {
        let c = trim(cell);
        let c = c.strip_prefix(':').unwrap_or(c);
        let c = c.strip_suffix(':').unwrap_or(c);
        !c.is_empty() && c.chars().all(|x| x == '-')
    })
}

/// `^\[\^([^\]]+)\]:\s?(.*)$`.
fn footnote(l: &str) -> Option<(&str, &str)> {
    let r = l.strip_prefix("[^")?;
    let close = r.find(']')?;
    if close == 0 {
        return None;
    }
    let rest = r[close + 1..].strip_prefix(':')?;
    let rest = match rest.chars().next() {
        Some(c) if ws(c) => &rest[c.len_utf8()..],
        _ => rest,
    };
    Some((&r[..close], rest))
}

/// The text with every single-backtick code span removed: `/`[^`]*`/g`.
fn without_code(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(a) = rest.find('`') {
        match rest[a + 1..].find('`') {
            Some(b) => {
                out.push_str(&rest[..a]);
                rest = &rest[a + b + 2..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

fn clip(s: &str) -> String {
    trim(s).chars().take(40).collect()
}

fn level(n: usize, promote: bool, notes: &mut Vec<String>) -> usize {
    if !promote {
        return n;
    }
    if n == 1 {
        notes.push("heading could not move above level 1 once the title was lifted into meta; kept at level 1".into());
    }
    n.saturating_sub(1).max(1)
}

/// The GEML a Markdown document converts to, and what the conversion noted.
pub fn md_to_geml(source: &str) -> (String, Vec<String>) {
    let lines: Vec<String> = source.replace("\r\n", "\n").replace('\r', "\n").split('\n').map(str::to_string).collect();
    let mut out: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let mut ids: Vec<(String, usize)> = Vec::new();
    let mut i = 0;

    let mut fm_title: Option<String> = None;
    if lines[0] == "---" {
        let mut j = 1;
        let mut meta = Vec::new();
        while j < lines.len() && lines[j] != "---" && lines[j] != "..." {
            match meta_line(&lines[j]) {
                Some(m) => meta.push(m),
                None if !blank(&lines[j]) => notes.push(format!("frontmatter line not converted: {}", lines[j])),
                None => {}
            }
            if let Some((key, v)) = yaml_key(&lines[j]) {
                if key == "title" && fm_title.is_none() {
                    fm_title = Some(trim(&yaml_scalar(v)).to_string());
                }
            }
            j += 1;
        }
        if j < lines.len() {
            emit_block(&mut out, &mut ids, "meta", "", meta);
            out.push(String::new());
            i = j + 1;
        } else {
            fm_title = None;
        }
    }

    // A front-matter title echoed by the first level-1 heading moves into
    // `meta` and the headings move up a level; so does a body with no
    // level-1 heading at all under a title.
    let mut promote = false;
    if let Some(t) = fm_title.as_deref().filter(|t| !t.is_empty()) {
        let mut k = i;
        while k < lines.len() && blank(&lines[k]) {
            k += 1;
        }
        let h1 = lines.get(k).and_then(|l| l.strip_prefix('#').filter(|r| r.starts_with(ws)).map(|r| trim(r).to_string()));
        let words = h1.as_deref().map(|w| trim(&unescape(w)).to_string());
        if h1.is_some() && words.as_deref() == Some(t) {
            promote = true;
            i = k + 1;
        } else if !has_level_one_heading(&lines, i) {
            promote = true;
        }
    }

    while i < lines.len() {
        let line = lines[i].clone();

        // A GEML block already here is GEML: copied through to its close, as
        // it stands. Read line by line, its last line over its close was a
        // setext heading, and the close was gone.
        if let Some(f) = crate::block::parse_fence_open(&line) {
            if let Some(close) = geml_close(&lines, i, f.len, f.attrs.id.as_deref()) {
                notes.push(format!("line {} opens a GEML fence and was kept as one (escape it as \\=== to keep it prose): {}", i + 1, clip(&line)));
                out.extend(lines[i..=close].iter().cloned());
                i = close + 1;
                continue;
            }
        }

        if let Some((marker, info)) = fence(&line) {
            let info = trim(info).split(ws).next().unwrap_or("").to_string();
            let mut body = Vec::new();
            let mut j = i + 1;
            while j < lines.len() && !closes_fence(&lines[j], &marker) {
                body.push(lines[j].clone());
                j += 1;
            }
            if DIAGRAM_LANGS.contains(&info.as_str()) {
                emit_block(&mut out, &mut ids, "diagram", &format!("{{format={info}}}"), body);
            } else {
                let attrs = if info.is_empty() { String::new() } else { format!("{{lang={info}}}") };
                emit_block(&mut out, &mut ids, "code", &attrs, body);
            }
            i = if j < lines.len() { j + 1 } else { j };
            continue;
        }

        if trim(&line) == "$$" {
            let mut body = Vec::new();
            let mut j = i + 1;
            while j < lines.len() && trim(&lines[j]) != "$$" {
                body.push(lines[j].clone());
                j += 1;
            }
            emit_block(&mut out, &mut ids, "math", "", body);
            i = if j < lines.len() { j + 1 } else { j };
            continue;
        }

        if !blank(&line) && !thematic(&line) && i + 1 < lines.len() {
            let next = &lines[i + 1];
            let lv = if underline(next, '=') {
                Some(1)
            } else if underline(next, '-') {
                Some(2)
            } else {
                None
            };
            if let Some(lv) = lv {
                let l = level(lv, promote, &mut notes);
                out.push(format!("{} {}", "#".repeat(l), esc_meta_refs(trim(&line))));
                i += 2;
                continue;
            }
        }

        if thematic(&line) {
            notes.push(format!("dropped thematic break at line {}", i + 1));
            i += 1;
            continue;
        }

        if let Some((id, first)) = footnote(&line) {
            let mut body = Vec::new();
            if !blank(first) {
                body.push(trim(first).to_string());
            }
            let mut j = i + 1;
            while j < lines.len() {
                let l = &lines[j];
                let lead = l.chars().take_while(|c| ws(*c)).count();
                if lead >= 2 && l.chars().nth(lead).is_some_and(|c| !ws(c)) {
                    body.push(l.trim_start_matches(ws).to_string());
                    j += 1;
                } else {
                    break;
                }
            }
            let body = body.iter().map(|l| esc_meta_refs(&autolinks(l))).collect();
            emit_block(&mut out, &mut ids, "note", &format!("{{#{}}}", trim(id)), body);
            i = j;
            continue;
        }

        if line.trim_start_matches(ws).starts_with('>') {
            let mut body = Vec::new();
            while i < lines.len() && lines[i].trim_start_matches(ws).starts_with('>') {
                let r = &lines[i].trim_start_matches(ws)[1..];
                let r = match r.chars().next() {
                    Some(c) if ws(c) => &r[c.len_utf8()..],
                    _ => r,
                };
                body.push(esc_meta_refs(r));
                i += 1;
            }
            emit_block(&mut out, &mut ids, "note", "", body);
            continue;
        }

        if line.contains('|') && i + 1 < lines.len() && table_sep(&lines[i + 1]) && !blank(&line) {
            let mut body = vec![line.clone(), lines[i + 1].clone()];
            let mut j = i + 2;
            while j < lines.len() && lines[j].contains('|') && !blank(&lines[j]) {
                body.push(lines[j].clone());
                j += 1;
            }
            emit_block(&mut out, &mut ids, "table", "", body);
            i = j;
            continue;
        }

        let heading = atx(&line);
        if let Some((n, text)) = heading {
            if text.contains('`') && !ends_with_braces(text) {
                let id = github_slug(text);
                if !id.is_empty() {
                    let l = level(n, promote, &mut notes);
                    out.push(format!("{} {} {{#{id}}}", "#".repeat(l), esc_meta_refs(text)));
                    i += 1;
                    continue;
                }
            }
        }

        let text0 = esc_meta_refs(&autolinks(&line));
        let text = match heading {
            Some((n, _)) if promote => format!("{}{}", "#".repeat(level(n, promote, &mut notes)), &text0[n..]),
            _ => text0,
        };
        if html_like(&without_code(&text)) {
            notes.push(format!("raw HTML kept as text at line {}: {}", i + 1, clip(&line)));
        }
        let lead = text.trim_start_matches(ws);
        let eqs = lead.chars().take_while(|c| *c == '=').count();
        if eqs >= 3 && lead[eqs..].chars().next().map_or(true, |c| c == ' ' || c == '\t') {
            notes.push(format!("line {} opens a GEML fence and was kept as one (escape it as \\=== to keep it prose): {}", i + 1, clip(&text)));
        } else if lead.starts_with("%%") {
            notes.push(format!("line {} is a GEML hidden line and was kept as one (escape it as \\%% to keep it prose): {}", i + 1, clip(&text)));
        }
        out.push(text);
        i += 1;
    }

    let mut geml = out.join("\n");
    if !geml.ends_with('\n') {
        geml.push('\n');
    }
    (geml, notes)
}

/// The line that closes the GEML block opened at `i`: a bare `=` run of its
/// fence's length, or a labeled close naming its id.
fn geml_close(lines: &[String], i: usize, len: usize, id: Option<&str>) -> Option<usize> {
    (i + 1..lines.len()).find(|j| {
        let l = lines[*j].trim_end_matches([' ', '\t']);
        (l.len() == len && l.bytes().all(|b| b == b'=')) || (id.is_some() && crate::block::labeled_close_id(l).as_deref() == id)
    })
}

/// `\{[^}]*\}\s*$`.
fn ends_with_braces(t: &str) -> bool {
    let t = t.trim_end_matches(ws);
    t.ends_with('}') && t.rfind('{').is_some_and(|o| !t[o + 1..t.len() - 1].contains('}'))
}

/// `/<[a-zA-Z/]/`.
fn html_like(s: &str) -> bool {
    s.as_bytes().windows(2).any(|w| w[0] == b'<' && (w[1].is_ascii_alphabetic() || w[1] == b'/'))
}

/// `\\([\\`*_[\]])` → the character.
fn unescape(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && chars.get(i + 1).is_some_and(|c| matches!(c, '\\' | '`' | '*' | '_' | '[' | ']')) {
            out.push(chars[i + 1]);
            i += 2;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geml(s: &str) -> String {
        md_to_geml(s).0
    }

    #[test]
    fn blocks() {
        assert_eq!(geml("# T\n\nIntro.\n"), "# T\n\nIntro.\n");
        assert_eq!(geml("```py\nx = 1\n```\n"), "=== code {#code-1 lang=py}\nx = 1\n===\n");
        assert_eq!(geml("~~~mermaid\ngraph\n~~~"), "=== diagram {#diagram-1 format=mermaid}\ngraph\n===\n");
        assert_eq!(geml("```\n===\n```"), "==== code {#code-1}\n===\n====\n");
        assert_eq!(geml("$$\nx\n$$"), "=== math {#math-1}\nx\n===\n");
        assert_eq!(geml("> a {{v}}\n> b"), "=== note {#note-1}\na \\{{v}}\nb\n===\n");
        assert_eq!(geml("[^n]: one\n  two\nafter"), "=== note {#n}\none\ntwo\n===\nafter\n");
        assert_eq!(geml("| a | b |\n|---|:-:|\n| 1 | 2 |\n"), "=== table {#table-1}\n| a | b |\n|---|:-:|\n| 1 | 2 |\n===\n");
        assert_eq!(geml("Title\n===\nSub\n---\n"), "# Title\n## Sub\n");
        let (g, notes) = md_to_geml("a\n\n***\n<div>x</div>\n=== note\n%% h\n");
        assert_eq!(g, "a\n\n<div>x</div>\n=== note\n%% h\n");
        assert_eq!(notes.len(), 4, "{notes:?}");
        assert_eq!(geml("## The `x` part\n"), "## The `x` part {#the-x-part}\n");
        assert_eq!(geml("see <https://a.b/c> and `<https://x>`"), "see [https://a.b/c](https://a.b/c) and `<https://x>`\n");
        assert_eq!(geml("<mailto:a@b.c>"), "[a@b.c](mailto:a@b.c)\n");
        assert_eq!(geml("`{{a}}` $x {{b}}$ \\{{c}} {{d}}"), "`{{a}}` $x {{b}}$ \\{{c}} \\{{d}}\n");
    }

    #[test]
    fn front_matter() {
        let (g, notes) = md_to_geml("---\ntitle: \"Doc\"\ntags:\n  - a\n---\n\n# Doc\n\n## Part\n");
        assert_eq!(g, "=== meta\ntitle=Doc\ntags=\"\"\n===\n\n\n# Part\n");
        assert_eq!(notes, vec!["frontmatter line not converted:   - a".to_string()]);
        let (g, _) = md_to_geml("---\ntitle: Doc\n---\n## Intro\n");
        assert_eq!(g, "=== meta\ntitle=Doc\n===\n\n# Intro\n");
        let (g, notes) = md_to_geml("---\ntitle: Doc\n---\n## Intro\n# Other\n");
        assert_eq!(g, "=== meta\ntitle=Doc\n===\n\n## Intro\n# Other\n");
        assert!(notes.is_empty());
        let (g, _) = md_to_geml("---\nx: 1\n");
        assert_eq!(g, "x: 1\n");
    }
}
