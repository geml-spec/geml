//! Inline content (§5): phase 1 reads atoms left to right, phase 2 pairs
//! emphasis delimiters over the whole sequence by delimiter-run flanking (§5.3).

use crate::diag::Diags;
use crate::json::Value;
use crate::model::Inline;
use crate::uni::{is_name, is_name_char, is_punct_or_symbol, is_ws};

/// §9.2: inline nesting this processor admits.
pub const MAX_INLINE_DEPTH: usize = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpanKind {
    Code,
    Math,
}

/// Where a code span opened by a run of `n` backticks closes (§5.3(1)): the
/// next run of EXACTLY `n` backticks at or after `from`, CommonMark's rule. A
/// run of another length is content, which is how `` ``a`b`` `` carries a
/// backtick and why `` `a``b` `` is one span, not two.
fn code_close(chars: &[char], from: usize, n: usize) -> Option<usize> {
    let mut k = from;
    while k < chars.len() {
        if chars[k] != '`' {
            k += 1;
            continue;
        }
        let m = run_len(chars, k, '`');
        if m == n {
            return Some(k);
        }
        k += m;
    }
    None
}

fn run_len(chars: &[char], i: usize, c: char) -> usize {
    chars[i..].iter().take_while(|x| **x == c).count()
}

/// The verbatim atoms of phase 1 (§5.3(1)) — code spans and inline math — as
/// `(start, end, kind)` over `chars`, end exclusive. An escaped backtick or
/// dollar opens nothing, and a backtick inside math opens nothing.
pub fn verbatim_spans(chars: &[char]) -> Vec<(usize, usize, SpanKind)> {
    let mut spans = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '\\' if i + 1 < chars.len() && chars[i + 1].is_ascii_punctuation() => i += 2,
            '`' => {
                let n = run_len(chars, i, '`');
                match code_close(chars, i + n, n) {
                    Some(c) => {
                        spans.push((i, c + n, SpanKind::Code));
                        i = c + n;
                    }
                    None => i += n,
                }
            }
            // §5.3(1): a `$` directly followed by another, or with none after it,
            // opens nothing.
            '$' => match chars[i + 1..].iter().position(|c| *c == '$') {
                Some(p) if p > 0 => {
                    let j = i + 1 + p;
                    spans.push((i, j + 1, SpanKind::Math));
                    i = j + 1;
                }
                _ => i += 1,
            },
            _ => i += 1,
        }
    }
    spans
}

/// A parsed reference target: `[doc]#anchor`, the anchor carrying the id and
/// any coordinate exactly as written.
#[derive(Debug, Clone, PartialEq)]
pub struct RefTarget {
    pub doc: Option<String>,
    pub anchor: String,
}

/// Does `s` begin with a URL scheme (`[A-Za-z][A-Za-z0-9+.-]*:`) once the
/// characters U+0000–U+0020 a user agent would strip are removed (§9.5)?
pub fn scheme_of(s: &str) -> Option<String> {
    let t: String = s.chars().filter(|c| (*c as u32) > 0x20).collect();
    let mut chars = t.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let mut scheme = String::new();
    scheme.push(first);
    for c in chars {
        if c == ':' {
            return Some(scheme.to_ascii_lowercase());
        }
        if c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-' {
            scheme.push(c);
        } else {
            return None;
        }
    }
    None
}

/// §9.5: the destination a link or an image may carry in the model — the
/// destination itself, or "" when it names a scheme outside the allowlist.
/// An image may also be a `data:image/…` URL.
pub fn safe_dest(dest: &str, image: bool) -> String {
    match scheme_of(dest) {
        None => dest.to_string(),
        Some(s) if matches!(s.as_str(), "http" | "https" | "mailto" | "tel") => dest.to_string(),
        Some(s) if image && s == "data" => {
            let t: String = dest.chars().filter(|c| (*c as u32) > 0x20).collect::<String>().to_ascii_lowercase();
            if t.starts_with("data:image/") {
                dest.to_string()
            } else {
                String::new()
            }
        }
        Some(_) => String::new(),
    }
}

/// Split a coordinate suffix into its bracket steps. `None` when the text is
/// not a sequence of `[integer]`, `["string"]` or `[word]` steps.
pub fn parse_steps(s: &str) -> Option<Vec<Step>> {
    let chars: Vec<char> = s.chars().collect();
    let mut steps = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '[' {
            return None;
        }
        i += 1;
        if chars.get(i) == Some(&'"') {
            let start = i;
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' {
                    i += 1;
                }
                i += 1;
            }
            if i >= chars.len() {
                return None;
            }
            let lit: String = chars[start..=i].iter().collect();
            let Ok(Value::String(k)) = crate::json::parse(&lit) else { return None };
            steps.push(Step::Key(k));
            i += 1;
        } else {
            let start = i;
            while i < chars.len() && chars[i] != ']' {
                i += 1;
            }
            let tok: String = chars[start..i].iter().collect();
            if !tok.is_empty() && tok.bytes().all(|b| b.is_ascii_digit()) {
                steps.push(Step::Index(tok.parse().ok()?));
            } else if is_name(&tok) {
                steps.push(Step::Word(tok));
            } else {
                return None;
            }
        }
        if chars.get(i) != Some(&']') {
            return None;
        }
        i += 1;
    }
    Some(steps)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Index(u64),
    Key(String),
    Word(String),
}

/// Split an anchor into its id and its coordinate steps.
pub fn split_anchor(anchor: &str) -> Option<(String, Vec<Step>)> {
    let cut = anchor.find('[').unwrap_or(anchor.len());
    let id = &anchor[..cut];
    if !is_name(id) {
        return None;
    }
    Some((id.to_string(), parse_steps(&anchor[cut..])?))
}

/// A reference target `[doc]#id[coordinate]` (§5.2), or `None` when the text
/// is not one. A document part never carries a URL scheme.
pub fn parse_ref_target(s: &str) -> Option<RefTarget> {
    let s = s.trim();
    let hash = s.find('#')?;
    let (doc, anchor) = (&s[..hash], &s[hash + 1..]);
    if doc.chars().any(|c| c.is_whitespace() || c == '[' || c == ']') || scheme_of(doc).is_some() {
        return None;
    }
    split_anchor(anchor)?;
    Some(RefTarget { doc: if doc.is_empty() { None } else { Some(doc.to_string()) }, anchor: anchor.to_string() })
}

/// The pieces phase 1 produces: literal text, which phase 2 scans for
/// delimiter runs, and atoms, which it never looks inside.
enum Piece {
    Text(String),
    Atom { node: Inline, first: char, last: char },
}

pub struct InlineCtx<'a> {
    pub meta: &'a [(String, Value)],
    pub diags: &'a mut Diags,
    pub line: usize,
    reported_depth: bool,
}

impl<'a> InlineCtx<'a> {
    pub fn new(meta: &'a [(String, Value)], diags: &'a mut Diags, line: usize) -> Self {
        InlineCtx { meta, diags, line, reported_depth: false }
    }

    fn too_deep(&mut self) {
        if !self.reported_depth {
            self.reported_depth = true;
            self.diags.push("inline-nesting-too-deep", self.line, "inline content nests deeper than this processor admits");
        }
    }
}

/// Parse a run of inline source text.
pub fn parse_inline(src: &str, ctx: &mut InlineCtx) -> Vec<Inline> {
    let chars: Vec<char> = src.chars().collect();
    parse_chars(&chars, ctx, false, 0)
}

fn parse_chars(chars: &[char], ctx: &mut InlineCtx, in_link: bool, depth: usize) -> Vec<Inline> {
    let pieces = phase1(chars, ctx, in_link, depth);
    let out = phase2(pieces, ctx);
    merge_text(out)
}

fn merge_text(v: Vec<Inline>) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::with_capacity(v.len());
    for n in v {
        if let Inline::Text(t) = &n {
            if t.is_empty() {
                continue;
            }
            if let Some(Inline::Text(prev)) = out.last_mut() {
                prev.push_str(t);
                continue;
            }
        }
        out.push(n);
    }
    out
}

/// The end of a bracketed label starting at `chars[i] == '['`: the index of
/// its matching `]`. Escapes and verbatim atoms are skipped, as phase 1 would
/// read them.
fn label_end(chars: &[char], i: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut k = i;
    while k < chars.len() {
        match chars[k] {
            '\\' if k + 1 < chars.len() && chars[k + 1].is_ascii_punctuation() => k += 2,
            '`' => {
                let n = run_len(chars, k, '`');
                k = match code_close(chars, k + n, n) {
                    Some(c) => c + n,
                    None => k + n,
                };
            }
            // Inline math is opaque here as in phase 1: a `$` before another
            // `$`, or with none after it, opens nothing (§5.3).
            '$' => {
                k = match chars[k + 1..].iter().position(|c| *c == '$') {
                    Some(p) if p > 0 => k + p + 2,
                    _ => k + 1,
                };
            }
            '[' => {
                depth += 1;
                k += 1;
            }
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(k);
                }
                k += 1;
            }
            _ => k += 1,
        }
    }
    None
}

/// A parenthesized destination starting at `chars[i] == '('`: its text and the
/// index after its `)`.
fn dest_end(chars: &[char], i: usize) -> Option<(String, usize)> {
    let mut depth = 0usize;
    let mut k = i;
    while k < chars.len() {
        match chars[k] {
            '\\' if k + 1 < chars.len() => k += 2,
            '(' => {
                depth += 1;
                k += 1;
            }
            ')' => {
                depth -= 1;
                if depth == 0 {
                    let s: String = chars[i + 1..k].iter().collect();
                    return Some((s.trim().to_string(), k + 1));
                }
                k += 1;
            }
            '\n' => return None,
            _ => k += 1,
        }
    }
    None
}

/// `[[target]]` starting at `chars[i] == '['`: the target text and the index
/// after the closing `]]`. Brackets nest and a quoted string is opaque, so a
/// coordinate's own brackets stay inside the target.
fn wiki_end(chars: &[char], i: usize) -> Option<(String, usize)> {
    let mut depth = 0usize;
    let mut k = i + 2;
    let mut quoted = false;
    while k < chars.len() {
        let c = chars[k];
        if quoted {
            if c == '\\' {
                k += 1;
            } else if c == '"' {
                quoted = false;
            }
            k += 1;
            continue;
        }
        match c {
            '"' => quoted = true,
            '[' => depth += 1,
            ']' => {
                if depth == 0 {
                    if chars.get(k + 1) == Some(&']') {
                        return Some((chars[i + 2..k].iter().collect(), k + 2));
                    }
                    return None;
                }
                depth -= 1;
            }
            '\n' => return None,
            _ => {}
        }
        k += 1;
    }
    None
}

/// An `{…}` attribute object directly after a link or an image: the index
/// after it, when there is one.
fn trailing_attrs(chars: &[char], k: usize) -> Option<usize> {
    if chars.get(k) != Some(&'{') {
        return None;
    }
    crate::attrs::parse_attrs(chars, k).map(|(_, e)| e)
}

/// `{{ key }}` at `chars[i]`: the key and the length matched.
fn interp_at(chars: &[char], i: usize) -> Option<(String, usize)> {
    if chars.get(i) != Some(&'{') || chars.get(i + 1) != Some(&'{') {
        return None;
    }
    let mut k = i + 2;
    while k < chars.len() && is_ws(chars[k]) {
        k += 1;
    }
    let ks = k;
    while k < chars.len() && is_name_char(chars[k]) {
        k += 1;
    }
    if k == ks {
        return None;
    }
    let key: String = chars[ks..k].iter().collect();
    while k < chars.len() && is_ws(chars[k]) {
        k += 1;
    }
    if chars.get(k) == Some(&'}') && chars.get(k + 1) == Some(&'}') {
        Some((key, k + 2 - i))
    } else {
        None
    }
}

/// Classify a link destination for the model: a scheme or a non-GEML path is
/// an `href`; `#id` and `doc.geml#id` are references.
fn link_node(dest: String, children: Vec<Inline>) -> Inline {
    if dest.is_empty() || scheme_of(&dest).is_some() {
        return Inline::Link { href: Some(dest), doc: None, anchor: None, children };
    }
    let (doc, anchor) = match dest.find('#') {
        Some(h) => (&dest[..h], Some(dest[h + 1..].to_string())),
        None => (dest.as_str(), None),
    };
    if doc.is_empty() || doc.to_ascii_lowercase().ends_with(".geml") {
        Inline::Link { href: None, doc: if doc.is_empty() { None } else { Some(doc.to_string()) }, anchor, children }
    } else {
        Inline::Link { href: Some(dest.clone()), doc: None, anchor: None, children }
    }
}

fn phase1(chars: &[char], ctx: &mut InlineCtx, in_link: bool, depth: usize) -> Vec<Piece> {
    let mut out: Vec<Piece> = Vec::new();
    let mut buf = String::new();
    let n = chars.len();
    let mut i = 0;
    // Whether a `]]` lies at or after each index — built the first time a
    // `[[` is met. Where none does, no `[[` can close, so it is text without a
    // scan: a line of `[[`s would otherwise cost a scan to its end for each.
    // The same for a link's or an image's label and a single `]`.
    let mut ahead: Option<(Vec<bool>, Vec<bool>)> = None;
    let mut scan = |at: usize, pair: bool| -> bool {
        let (one, two) = ahead.get_or_insert_with(|| {
            let mut one = vec![false; n + 1];
            let mut two = vec![false; n + 1];
            for k in (0..n).rev() {
                one[k] = chars[k] == ']' || one[k + 1];
                two[k] = (chars[k] == ']' && chars.get(k + 1) == Some(&']')) || two[k + 1];
            }
            (one, two)
        });
        if pair {
            two[at.min(n)]
        } else {
            one[at.min(n)]
        }
    };
    macro_rules! atom {
        ($node:expr, $first:expr, $last:expr) => {{
            if !buf.is_empty() {
                out.push(Piece::Text(std::mem::take(&mut buf)));
            }
            out.push(Piece::Atom { node: $node, first: $first, last: $last });
        }};
    }
    while i < n {
        let c = chars[i];
        match c {
            '\\' => {
                if chars.get(i + 1) == Some(&'\n') {
                    atom!(Inline::Break, '\\', '\n');
                    i += 2;
                } else if let Some(e) = chars.get(i + 1).filter(|e| e.is_ascii_punctuation()) {
                    let e = *e;
                    atom!(Inline::Text(e.to_string()), '\\', e);
                    i += 2;
                } else {
                    buf.push('\\');
                    i += 1;
                }
            }
            '`' => {
                let r = run_len(chars, i, '`');
                match code_close(chars, i + r, r) {
                    Some(close) => {
                        atom!(Inline::Code(chars[i + r..close].iter().collect()), '`', '`');
                        i = close + r;
                    }
                    None => {
                        buf.extend(&chars[i..i + r]);
                        i += r;
                    }
                }
            }
            // §5.3(1): math has at least one character; a `$` directly followed
            // by another, or with none after it, is literal and scanning resumes
            // after it.
            '$' => match chars[i + 1..].iter().position(|c| *c == '$') {
                Some(p) if p > 0 => {
                    let j = i + 1 + p;
                    atom!(Inline::Math(chars[i + 1..j].iter().collect()), '$', '$');
                    i = j + 1;
                }
                _ => {
                    buf.push('$');
                    i += 1;
                }
            },
            '{' => match interp_at(chars, i) {
                Some((key, len)) => {
                    match ctx.meta.iter().find(|(k, _)| *k == key) {
                        Some((_, v)) => {
                            let text = v.scalar_text().unwrap_or_default();
                            atom!(Inline::Text(text), '{', '}');
                        }
                        None => {
                            ctx.diags.push("unknown-metadata-reference", ctx.line, format!("`{{{{{key}}}}}` names a key no `=== meta` block defines"));
                            buf.extend(&chars[i..i + len]);
                        }
                    }
                    i += len;
                }
                None => {
                    buf.push('{');
                    i += 1;
                }
            },
            '!' if chars.get(i + 1) == Some(&'[') => {
                if chars.get(i + 2) == Some(&'[') && scan(i + 3, true) {
                    if let Some((t, end)) = wiki_end(chars, i + 1) {
                        if let Some(rt) = parse_ref_target(&t) {
                            atom!(Inline::Project { doc: rt.doc, anchor: rt.anchor, value: None }, '!', ']');
                            i = end;
                            continue;
                        }
                    }
                }
                if let Some(le) = if scan(i + 2, false) { label_end(chars, i + 1) } else { None } {
                    if chars.get(le + 1) == Some(&'(') {
                        if let Some((dest, after)) = dest_end(chars, le + 1) {
                            let alt = if depth + 1 > MAX_INLINE_DEPTH {
                                ctx.too_deep();
                                vec![Inline::Text(chars[i + 2..le].iter().collect())]
                            } else {
                                parse_chars(&chars[i + 2..le], ctx, in_link, depth + 1)
                            };
                            let (end, last) = match trailing_attrs(chars, after) {
                                Some(e) => (e, '}'),
                                None => (after, ')'),
                            };
                            atom!(Inline::Image { src: safe_dest(&dest, true), alt }, '!', last);
                            i = end;
                            continue;
                        }
                    }
                }
                buf.push('!');
                i += 1;
            }
            '[' => {
                if !in_link && chars.get(i + 1) == Some(&'[') && scan(i + 2, true) {
                    if let Some((t, end)) = wiki_end(chars, i) {
                        if let Some(rt) = parse_ref_target(&t) {
                            atom!(Inline::AutoRef { doc: rt.doc, anchor: rt.anchor, value: None }, '[', ']');
                            i = end;
                            continue;
                        }
                    }
                }
                if chars.get(i + 1) == Some(&'^') {
                    if let Some(p) = chars[i + 2..].iter().position(|c| *c == ']') {
                        let id: String = chars[i + 2..i + 2 + p].iter().collect();
                        if is_name(&id) {
                            atom!(Inline::Footnote(id), '[', ']');
                            i = i + 3 + p;
                            continue;
                        }
                    }
                }
                if !in_link && scan(i + 1, false) {
                    if let Some(le) = label_end(chars, i) {
                        if chars.get(le + 1) == Some(&'(') {
                            if let Some((dest, after)) = dest_end(chars, le + 1) {
                                let label = if depth + 1 > MAX_INLINE_DEPTH {
                                    ctx.too_deep();
                                    vec![Inline::Text(chars[i + 1..le].iter().collect())]
                                } else {
                                    parse_chars(&chars[i + 1..le], ctx, true, depth + 1)
                                };
                                let (end, last) = match trailing_attrs(chars, after) {
                                    Some(e) => (e, '}'),
                                    None => (after, ')'),
                                };
                                atom!(link_node(safe_dest(&dest, false), label), '[', last);
                                i = end;
                                continue;
                            }
                        }
                    }
                }
                buf.push('[');
                i += 1;
            }
            _ => {
                buf.push(c);
                i += 1;
            }
        }
    }
    if !buf.is_empty() {
        out.push(Piece::Text(buf));
    }
    out
}

// ---------------------------------------------------------------------------
// Phase 2: delimiter runs (§5.3)
// ---------------------------------------------------------------------------

enum El {
    Node(Inline, usize),
    Delim { ch: char, count: usize, orig: usize, can_open: bool, can_close: bool },
}

struct Cell {
    el: El,
    prev: Option<usize>,
    next: Option<usize>,
    live: bool,
}

fn flanking(prev: char, next: char) -> (bool, bool) {
    let left = !is_ws(next) && (!is_punct_or_symbol(next) || is_ws(prev) || is_punct_or_symbol(prev));
    let right = !is_ws(prev) && (!is_punct_or_symbol(prev) || is_ws(next) || is_punct_or_symbol(next));
    (left, right)
}

fn depth_of(n: &Inline) -> usize {
    match n {
        Inline::Emph(c) | Inline::Strong(c) | Inline::Strike(c) => 1 + c.iter().map(depth_of).max().unwrap_or(0),
        _ => 0,
    }
}

fn phase2(pieces: Vec<Piece>, ctx: &mut InlineCtx) -> Vec<Inline> {
    // Flatten into elements, finding delimiter runs in literal text.
    let mut els: Vec<El> = Vec::new();
    let edges: Vec<(char, char)> = pieces
        .iter()
        .map(|p| match p {
            Piece::Text(t) => (t.chars().next().unwrap_or(' '), t.chars().last().unwrap_or(' ')),
            Piece::Atom { first, last, .. } => (*first, *last),
        })
        .collect();
    let count = pieces.len();
    for (pi, p) in pieces.into_iter().enumerate() {
        match p {
            Piece::Atom { node, .. } => {
                let d = depth_of(&node);
                els.push(El::Node(node, d));
            }
            Piece::Text(t) => {
                let before = if pi == 0 { ' ' } else { edges[pi - 1].1 };
                let after = if pi + 1 == count { ' ' } else { edges[pi + 1].0 };
                let cs: Vec<char> = t.chars().collect();
                let mut text = String::new();
                let mut k = 0;
                while k < cs.len() {
                    let c = cs[k];
                    if c == '*' || c == '~' {
                        let r = run_len(&cs, k, c);
                        if c == '~' && r < 2 {
                            text.push('~');
                            k += 1;
                            continue;
                        }
                        let prev = if k == 0 { before } else { cs[k - 1] };
                        let next = if k + r >= cs.len() { after } else { cs[k + r] };
                        let (can_open, can_close) = flanking(prev, next);
                        if !text.is_empty() {
                            els.push(El::Node(Inline::Text(std::mem::take(&mut text)), 0));
                        }
                        els.push(El::Delim { ch: c, count: r, orig: r, can_open, can_close });
                        k += r;
                    } else {
                        text.push(c);
                        k += 1;
                    }
                }
                if !text.is_empty() {
                    els.push(El::Node(Inline::Text(text), 0));
                }
            }
        }
    }
    process_emphasis(els, ctx)
}

fn process_emphasis(els: Vec<El>, ctx: &mut InlineCtx) -> Vec<Inline> {
    let n = els.len();
    let mut cells: Vec<Cell> = els
        .into_iter()
        .enumerate()
        .map(|(i, el)| Cell { el, prev: if i == 0 { None } else { Some(i - 1) }, next: if i + 1 < n { Some(i + 1) } else { None }, live: true })
        .collect();
    let mut head = if n > 0 { Some(0) } else { None };
    // The delimiter stack, in document order, by cell index.
    let stack: Vec<usize> = (0..n).filter(|i| matches!(cells[*i].el, El::Delim { .. })).collect();
    let mut on_stack: Vec<bool> = vec![false; n];
    for i in &stack {
        on_stack[*i] = true;
    }
    let mut bottoms: std::collections::HashMap<(char, bool, usize), usize> = std::collections::HashMap::new();
    let mut ci = 0usize;
    while ci < stack.len() {
        let c = stack[ci];
        if !on_stack[c] {
            ci += 1;
            continue;
        }
        let (cch, ccount, corig, c_open, c_close) = match cells[c].el {
            El::Delim { ch, count, orig, can_open, can_close } => (ch, count, orig, can_open, can_close),
            _ => unreachable!(),
        };
        if !c_close {
            ci += 1;
            continue;
        }
        let key = (cch, c_open, corig % 3);
        let bottom = bottoms.get(&key).copied();
        let mut found: Option<usize> = None;
        let mut k = ci;
        while k > 0 {
            k -= 1;
            if bottom.is_some_and(|b| k <= b) {
                break;
            }
            let o = stack[k];
            if !on_stack[o] {
                continue;
            }
            if let El::Delim { ch, orig, can_open, can_close, .. } = cells[o].el {
                if ch != cch || !can_open {
                    continue;
                }
                let odd = (c_open || can_close) && corig % 3 != 0 && (orig + corig) % 3 == 0;
                if !odd {
                    found = Some(k);
                    break;
                }
            }
        }
        let Some(ok) = found else {
            // Every opener below this closer failed it: later closers of the
            // same kind need not look there again.
            if ci > 0 {
                bottoms.insert(key, ci - 1);
            }
            if !c_open {
                on_stack[c] = false;
            }
            ci += 1;
            continue;
        };
        let o = stack[ok];
        let ocount = match cells[o].el {
            El::Delim { count, .. } => count,
            _ => unreachable!(),
        };
        // `~~` spends two per side; `*` spends two when both runs can.
        let used = if cch == '~' || (ocount >= 2 && ccount >= 2) { 2 } else { 1 };
        // Gather the cells strictly between the opener and the closer.
        let mut children: Vec<Inline> = Vec::new();
        let mut depth = 0;
        let mut cur = cells[o].next;
        while let Some(x) = cur {
            if x == c {
                break;
            }
            cells[x].live = false;
            match std::mem::replace(&mut cells[x].el, El::Node(Inline::Text(String::new()), 0)) {
                El::Node(node, d) => {
                    depth = depth.max(d);
                    children.push(node);
                }
                El::Delim { ch, count, .. } => children.push(Inline::Text(ch.to_string().repeat(count))),
            }
            on_stack[x] = false;
            cur = cells[x].next;
        }
        if depth + 1 > MAX_INLINE_DEPTH {
            // Too deep: put the cells back as they were and leave this closer literal.
            ctx.too_deep();
            let mut cur = cells[o].next;
            let mut kids = children.into_iter();
            while let Some(x) = cur {
                if x == c {
                    break;
                }
                cells[x].live = true;
                cells[x].el = El::Node(kids.next().expect("as many as were taken"), 0);
                cur = cells[x].next;
            }
            on_stack[c] = false;
            ci += 1;
            continue;
        }
        let children = merge_text(children);
        let node = match (cch, used) {
            ('~', _) => Inline::Strike(children),
            (_, 2) => Inline::Strong(children),
            _ => Inline::Emph(children),
        };
        // Insert the new node between opener and closer.
        let new = cells.len();
        cells.push(Cell { el: El::Node(node, depth + 1), prev: Some(o), next: Some(c), live: true });
        on_stack.push(false);
        cells[o].next = Some(new);
        cells[c].prev = Some(new);
        // Spend the delimiters.
        let mut spend = |idx: usize| -> usize {
            if let El::Delim { count, .. } = &mut cells[idx].el {
                *count -= used;
                *count
            } else {
                0
            }
        };
        let orem = spend(o);
        let crem = spend(c);
        let remove = |cells: &mut Vec<Cell>, idx: usize, head: &mut Option<usize>| {
            let (p, nx) = (cells[idx].prev, cells[idx].next);
            if let Some(p) = p {
                cells[p].next = nx;
            } else {
                *head = nx;
            }
            if let Some(nx) = nx {
                cells[nx].prev = p;
            }
            cells[idx].live = false;
        };
        if orem == 0 {
            remove(&mut cells, o, &mut head);
            on_stack[o] = false;
        } else if cch == '~' && orem < 2 {
            on_stack[o] = false;
        }
        if crem == 0 {
            remove(&mut cells, c, &mut head);
            on_stack[c] = false;
            ci += 1;
        } else if cch == '~' && crem < 2 {
            on_stack[c] = false;
            ci += 1;
        }
    }
    // Read the list out.
    let mut out = Vec::new();
    let mut cur = head;
    while let Some(x) = cur {
        if cells[x].live {
            match std::mem::replace(&mut cells[x].el, El::Node(Inline::Text(String::new()), 0)) {
                El::Node(node, _) => out.push(node),
                El::Delim { ch, count, .. } => {
                    if count > 0 {
                        out.push(Inline::Text(ch.to_string().repeat(count)))
                    }
                }
            }
        }
        cur = cells[x].next;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans() {
        let c: Vec<char> = "a `b` $c$ \\` `x".chars().collect();
        let s = verbatim_spans(&c);
        assert_eq!(s, vec![(2, 5, SpanKind::Code), (6, 9, SpanKind::Math)]);
    }

    #[test]
    fn schemes() {
        assert_eq!(scheme_of("java\tscript:x").as_deref(), Some("javascript"));
        assert_eq!(scheme_of("HTTP://x").as_deref(), Some("http"));
        assert!(scheme_of("docs/a.geml").is_none() && scheme_of("#a:b").is_none() && scheme_of("").is_none() && scheme_of("abc").is_none());
        assert_eq!(safe_dest("javascript:alert(1)", false), "");
        assert_eq!(safe_dest("data:image/png;base64,x", true), "data:image/png;base64,x");
        assert_eq!(safe_dest("data:text/html,x", true), "");
        assert_eq!(safe_dest("tel:+1", false), "tel:+1");
    }

    #[test]
    fn targets() {
        assert_eq!(parse_ref_target("#fy[1][\"Q1\"]").unwrap().anchor, "fy[1][\"Q1\"]");
        assert_eq!(parse_ref_target("o.geml#p").unwrap().doc.as_deref(), Some("o.geml"));
        assert!(parse_ref_target("javascript:alert(1)#x").is_none());
        assert!(parse_ref_target("x").is_none());
        assert!(parse_ref_target("#").is_none());
        assert!(parse_ref_target("a b#x").is_none());
        assert!(parse_ref_target("#a[").is_none());
        assert!(parse_ref_target("#a[x y]").is_none());
        assert!(parse_ref_target("#a[\"x").is_none());
        assert!(parse_ref_target("#a[1]x").is_none());
        assert_eq!(parse_steps("[summary][\"a\\\"b\"][0]").unwrap(), vec![Step::Word("summary".into()), Step::Key("a\"b".into()), Step::Index(0)]);
        assert!(parse_steps("[\"\\x\"]").is_none());
    }
}
