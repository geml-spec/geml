//! Inline content (§5): phase 1 reads atoms left to right, phase 2 pairs
//! emphasis delimiters over the whole sequence by delimiter-run flanking (§5.3).

use std::collections::HashMap;

use crate::bounds::INLINE_NESTING;
use crate::diag::Diags;
use crate::json::Value;
use crate::model::Inline;
use crate::uni::{is_name, is_name_char, is_punct_or_symbol, is_ws};

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

/// Whether `t` has the shape of a reference target — `[doc]#id`, then steps
/// each a quoted string or a run of NAME characters — read only as far as it
/// keeps that shape. A target is built and parsed only once it has it, so
/// text that merely opens like a reference costs no more than its first wrong
/// character: a line of nested `[[` built a target as long as the line from
/// every one of them.
fn ref_shape(t: &[char]) -> bool {
    let start = t.iter().position(|c| !c.is_whitespace()).unwrap_or(t.len());
    let end = t.iter().rposition(|c| !c.is_whitespace()).map_or(start, |e| e + 1);
    let t = &t[start..end];
    let Some(hash) = t.iter().position(|c| matches!(c, '#' | '[' | ']') || c.is_whitespace()) else { return false };
    let id = t[hash + 1..].iter().take_while(|c| is_name_char(**c)).count();
    if t[hash] != '#' || id == 0 {
        return false;
    }
    let mut i = hash + 1 + id;
    while i < t.len() {
        if t[i] != '[' {
            return false;
        }
        i += 1;
        if t.get(i) == Some(&'"') {
            i += 1;
            while i < t.len() && t[i] != '"' {
                i += if t[i] == '\\' { 2 } else { 1 };
            }
            i += 1;
        } else {
            let n = t[i..].iter().take_while(|c| is_name_char(**c)).count();
            if n == 0 {
                return false;
            }
            i += n;
        }
        if t.get(i) != Some(&']') {
            return false;
        }
        i += 1;
    }
    true
}

/// The pieces phase 1 produces: literal text, which phase 2 scans for
/// delimiter runs, and atoms, which it never looks inside. An atom carries
/// how deep its tree goes.
enum Piece {
    Text(String),
    Atom { node: Inline, first: char, last: char, height: usize },
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
    let ends = if chars.contains(&'[') { Ends::of(&chars) } else { Ends::default() };
    parse_chars(&chars, ctx, false, 0, Window { ends: &ends, off: 0 }).0
}

/// The nodes of one nesting level — `depth` links and images in — and how
/// deep their trees go.
fn parse_chars(chars: &[char], ctx: &mut InlineCtx, in_link: bool, depth: usize, w: Window) -> (Vec<Inline>, usize) {
    let pieces = phase1(chars, ctx, in_link, depth, w);
    let (out, height) = phase2(pieces, ctx, depth);
    (merge_text(out), height)
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

const NONE: u32 = u32::MAX;

/// Where each bracketed construct closes, for a scan starting at every index
/// at once (§5.3): built right to left in one pass over the whole run of
/// inline text, and read through an offset by every nesting level. Scanning
/// forward from each opener cost a pass to the end of the text for each one
/// whose closer exists but never pairs: a line of `[[`, `![` or `[a](b){`
/// took the square of its length.
#[derive(Default)]
struct Ends {
    /// The `]` a link's text or an image's alt closes at: the first `]` the
    /// scan from here meets at depth zero, escapes, code spans and inline math
    /// passed over as phase 1 reads them.
    label: Vec<u32>,
    /// The `]` a reference's target closes at: quoted strings opaque, a line
    /// break outside them ending the scan.
    wiki: Vec<u32>,
    /// The `)` a destination closes at: a `\` passes over what follows it, a
    /// line break ends the scan.
    paren: Vec<u32>,
    /// The `}` an attribute object closes at: the first outside a quoted span
    /// (§4, step 1).
    attr: Vec<u32>,
}

impl Ends {
    fn of(chars: &[char]) -> Ends {
        let n = chars.len();
        let mut e = Ends { label: vec![NONE; n + 2], wiki: vec![NONE; n + 2], paren: vec![NONE; n + 2], attr: vec![NONE; n + 2] };
        // The same scans begun inside a quoted span.
        let mut wiki_q = vec![NONE; n + 2];
        let mut attr_q = vec![NONE; n + 2];
        // Past the nearest index: the start of the nearest run of each length
        // of backticks, the run itself whole, and the nearest `$`.
        let mut runs: HashMap<usize, usize> = HashMap::new();
        let mut run = 0usize;
        let mut dollar: Option<usize> = None;
        let then = |v: &[u32], j: u32| if j == NONE { NONE } else { v[j as usize + 1] };
        for k in (0..n).rev() {
            let c = chars[k];
            let next = chars.get(k + 1).copied();
            run = if c == '`' { run + 1 } else { 0 };
            e.label[k] = match c {
                '\\' if next.is_some_and(|x| x.is_ascii_punctuation()) => e.label[k + 2],
                '`' => match runs.get(&run) {
                    Some(close) => e.label[close + run],
                    None => e.label[k + run],
                },
                '$' => match dollar {
                    Some(m) if m > k + 1 => e.label[m + 1],
                    _ => e.label[k + 1],
                },
                '[' => then(&e.label, e.label[k + 1]),
                ']' => k as u32,
                _ => e.label[k + 1],
            };
            if c == '`' && (k == 0 || chars[k - 1] != '`') {
                runs.insert(run, k);
            }
            if c == '$' {
                dollar = Some(k);
            }
            wiki_q[k] = match c {
                '\\' => wiki_q.get(k + 2).copied().unwrap_or(NONE),
                '"' => k as u32,
                _ => wiki_q[k + 1],
            };
            e.wiki[k] = match c {
                '"' => then(&e.wiki, wiki_q[k + 1]),
                '[' => then(&e.wiki, e.wiki[k + 1]),
                ']' => k as u32,
                '\n' => NONE,
                _ => e.wiki[k + 1],
            };
            e.paren[k] = match c {
                '\\' if next.is_some() => e.paren[k + 2],
                '(' => then(&e.paren, e.paren[k + 1]),
                ')' => k as u32,
                '\n' => NONE,
                _ => e.paren[k + 1],
            };
            attr_q[k] = match c {
                '\\' if matches!(next, Some('"' | '\\')) => attr_q[k + 2],
                '"' => e.attr[k + 1],
                _ => attr_q[k + 1],
            };
            e.attr[k] = match c {
                '"' => attr_q[k + 1],
                '}' => k as u32,
                _ => e.attr[k + 1],
            };
        }
        e
    }
}

/// One nesting level's text: a window into the run the `Ends` were built
/// over, starting `off` characters in.
#[derive(Clone, Copy)]
struct Window<'a> {
    ends: &'a Ends,
    off: usize,
}

impl Window<'_> {
    /// Where the scan of `ends` from `from` (an index into `chars`, this
    /// window) closes, when it closes inside the window.
    fn close(&self, ends: &[u32], chars: &[char], from: usize) -> Option<usize> {
        let j = *ends.get(self.off + from)?;
        (j != NONE && (j as usize) < self.off + chars.len()).then(|| j as usize - self.off)
    }

    /// The `]` that closes the label opened at `chars[i] == '['`.
    fn label_end(&self, chars: &[char], i: usize) -> Option<usize> {
        self.close(&self.ends.label, chars, i + 1)
    }

    /// A parenthesized destination starting at `chars[i] == '('`: its text and
    /// the index after its `)`.
    fn dest_end(&self, chars: &[char], i: usize) -> Option<(String, usize)> {
        let k = self.close(&self.ends.paren, chars, i + 1)?;
        let s: String = chars[i + 1..k].iter().collect();
        Some((s.trim().to_string(), k + 1))
    }

    /// `[[target]]` starting at `chars[i] == '['`: the reference it writes
    /// and the index after the closing `]]`. Brackets nest and a quoted string
    /// is opaque, so a coordinate's own brackets stay inside the target.
    fn wiki_ref(&self, chars: &[char], i: usize) -> Option<(RefTarget, usize)> {
        let k = self.close(&self.ends.wiki, chars, i + 2)?;
        if chars.get(k + 1) != Some(&']') || !ref_shape(&chars[i + 2..k]) {
            return None;
        }
        Some((parse_ref_target(&chars[i + 2..k].iter().collect::<String>())?, k + 2))
    }

    /// An `{…}` attribute object directly after a link or an image: the index
    /// after it, when there is one.
    fn trailing_attrs(&self, chars: &[char], k: usize) -> Option<usize> {
        if chars.get(k) != Some(&'{') {
            return None;
        }
        self.close(&self.ends.attr, chars, k + 1).map(|e| e + 1)
    }
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

fn phase1(chars: &[char], ctx: &mut InlineCtx, in_link: bool, depth: usize, w: Window) -> Vec<Piece> {
    let mut out: Vec<Piece> = Vec::new();
    let mut buf = String::new();
    let n = chars.len();
    let mut i = 0;
    macro_rules! atom {
        ($node:expr, $first:expr, $last:expr) => {
            atom!($node, $first, $last, 0)
        };
        ($node:expr, $first:expr, $last:expr, $height:expr) => {{
            if !buf.is_empty() {
                out.push(Piece::Text(std::mem::take(&mut buf)));
            }
            out.push(Piece::Atom { node: $node, first: $first, last: $last, height: $height });
        }};
    }
    // A link's text or an image's alt, one level further in: parsed, or text
    // past the bound.
    let label = |ctx: &mut InlineCtx, from: usize, to: usize, in_link: bool| -> (Vec<Inline>, usize) {
        if depth + 1 > INLINE_NESTING {
            ctx.too_deep();
            return (vec![Inline::Text(chars[from..to].iter().collect())], 0);
        }
        parse_chars(&chars[from..to], ctx, in_link, depth + 1, Window { ends: w.ends, off: w.off + from })
    };
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
                if chars.get(i + 2) == Some(&'[') {
                    if let Some((rt, end)) = w.wiki_ref(chars, i + 1) {
                        atom!(Inline::Project { doc: rt.doc, anchor: rt.anchor, value: None }, '!', ']');
                        i = end;
                        continue;
                    }
                }
                if let Some(le) = w.label_end(chars, i + 1) {
                    if chars.get(le + 1) == Some(&'(') {
                        if let Some((dest, after)) = w.dest_end(chars, le + 1) {
                            let (alt, height) = label(ctx, i + 2, le, in_link);
                            let (end, last) = match w.trailing_attrs(chars, after) {
                                Some(e) => (e, '}'),
                                None => (after, ')'),
                            };
                            atom!(Inline::Image { src: safe_dest(&dest, true), alt }, '!', last, height + 1);
                            i = end;
                            continue;
                        }
                    }
                }
                buf.push('!');
                i += 1;
            }
            '[' => {
                if !in_link && chars.get(i + 1) == Some(&'[') {
                    if let Some((rt, end)) = w.wiki_ref(chars, i) {
                        atom!(Inline::AutoRef { doc: rt.doc, anchor: rt.anchor, value: None }, '[', ']');
                        i = end;
                        continue;
                    }
                }
                if chars.get(i + 1) == Some(&'^') {
                    // A footnote's id is a NAME, so its `]` is the first
                    // character past the run of NAME characters.
                    let p = chars[i + 2..].iter().take_while(|c| is_name_char(**c)).count();
                    if p > 0 && chars.get(i + 2 + p) == Some(&']') {
                        atom!(Inline::Footnote(chars[i + 2..i + 2 + p].iter().collect()), '[', ']');
                        i = i + 3 + p;
                        continue;
                    }
                }
                if !in_link {
                    if let Some(le) = w.label_end(chars, i) {
                        if chars.get(le + 1) == Some(&'(') {
                            if let Some((dest, after)) = w.dest_end(chars, le + 1) {
                                let (children, height) = label(ctx, i + 1, le, true);
                                let (end, last) = match w.trailing_attrs(chars, after) {
                                    Some(e) => (e, '}'),
                                    None => (after, ')'),
                                };
                                atom!(link_node(safe_dest(&dest, false), children), '[', last, height + 1);
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

/// Pair the delimiter runs of one nesting level, `depth` links and images in;
/// the nodes, and how deep their trees go.
fn phase2(pieces: Vec<Piece>, ctx: &mut InlineCtx, depth: usize) -> (Vec<Inline>, usize) {
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
            Piece::Atom { node, height, .. } => els.push(El::Node(node, height)),
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
    process_emphasis(els, ctx, depth)
}

/// The emphasis pass (§5.3). A node carries how deep its tree goes; a pair
/// whose node would take the tree past `INLINE_NESTING`, counted from the
/// top of the run — `level` links and images in — stays literal.
/// The live entries of a delimiter stack, found below an index through links
/// that pass over the dead ones. An entry leaves the stack for good, so a run
/// of dead entries is walked once, not once by every closer searching across
/// it: closers refused as too deep would otherwise make each search longer.
struct Live {
    /// For each index, an index at or below it with no live entry between the
    /// two; `usize::MAX` when none lies at or below it.
    link: Vec<usize>,
}

impl Live {
    /// The highest stack index below `k` whose delimiter is still on the stack.
    fn below(&mut self, k: usize, stack: &[usize], on_stack: &[bool]) -> Option<usize> {
        let start = k.checked_sub(1)?;
        let mut x = start;
        let found = loop {
            if x == usize::MAX {
                break None;
            }
            let l = self.link[x];
            if l != x {
                x = l;
            } else if on_stack[stack[x]] {
                break Some(x);
            } else {
                self.link[x] = x.checked_sub(1).unwrap_or(usize::MAX);
            }
        };
        // Point the path walked straight at what it found.
        let to = found.unwrap_or(usize::MAX);
        let mut y = start;
        while y != to && y != usize::MAX {
            let next = self.link[y];
            self.link[y] = to;
            y = next;
        }
        found
    }
}

fn process_emphasis(els: Vec<El>, ctx: &mut InlineCtx, level: usize) -> (Vec<Inline>, usize) {
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
    let mut bottoms: HashMap<(char, bool, usize), usize> = HashMap::new();
    let mut live = Live { link: (0..stack.len()).collect() };
    // The highest stack index of an opener whose pair was refused as too deep.
    let mut too_deep: Option<usize> = None;
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
        while let Some(j) = live.below(k, &stack, &on_stack) {
            k = j;
            if bottom.is_some_and(|b| k <= b) {
                break;
            }
            let o = stack[k];
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
        if too_deep.is_some_and(|d| ok <= d) {
            // Refused as the gather below would refuse it, without gathering:
            // every delimiter still on the stack between turns literal, and
            // so does this closer.
            ctx.too_deep();
            let mut k = ci;
            while let Some(j) = live.below(k, &stack, &on_stack).filter(|j| *j > ok) {
                if let El::Delim { ch, count, .. } = cells[stack[j]].el {
                    cells[stack[j]].el = El::Node(Inline::Text(ch.to_string().repeat(count)), 0);
                }
                on_stack[stack[j]] = false;
                k = j;
            }
            on_stack[c] = false;
            ci += 1;
            continue;
        }
        let o = stack[ok];
        let ocount = match cells[o].el {
            El::Delim { count, .. } => count,
            _ => unreachable!(),
        };
        // `~~` spends two per side; `*` spends two when both runs can.
        let used = if cch == '~' || (ocount >= 2 && ccount >= 2) { 2 } else { 1 };
        // Gather the cells strictly between the opener and the closer.
        let mut children: Vec<Inline> = Vec::new();
        let mut heights: Vec<usize> = Vec::new();
        let mut cur = cells[o].next;
        while let Some(x) = cur {
            if x == c {
                break;
            }
            cells[x].live = false;
            match std::mem::replace(&mut cells[x].el, El::Node(Inline::Text(String::new()), 0)) {
                El::Node(node, d) => {
                    heights.push(d);
                    children.push(node);
                }
                El::Delim { ch, count, .. } => {
                    heights.push(0);
                    children.push(Inline::Text(ch.to_string().repeat(count)))
                }
            }
            on_stack[x] = false;
            cur = cells[x].next;
        }
        let depth = heights.iter().copied().max().unwrap_or(0);
        if level + depth + 1 > INLINE_NESTING {
            // Too deep: put the cells back as they were, each with its height,
            // and leave this closer literal. Every later closer that reaches
            // this opener or one below it spans the same cells, and is refused
            // above without gathering them again.
            ctx.too_deep();
            too_deep = Some(too_deep.map_or(ok, |d| d.max(ok)));
            let mut cur = cells[o].next;
            let mut kids = children.into_iter().zip(heights);
            while let Some(x) = cur {
                if x == c {
                    break;
                }
                let (node, h) = kids.next().expect("as many as were taken");
                cells[x].live = true;
                cells[x].el = El::Node(node, h);
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
    let mut height = 0;
    let mut cur = head;
    while let Some(x) = cur {
        if cells[x].live {
            match std::mem::replace(&mut cells[x].el, El::Node(Inline::Text(String::new()), 0)) {
                El::Node(node, h) => {
                    height = height.max(h);
                    out.push(node)
                }
                El::Delim { ch, count, .. } => {
                    if count > 0 {
                        out.push(Inline::Text(ch.to_string().repeat(count)))
                    }
                }
            }
        }
        cur = cells[x].next;
    }
    (out, height)
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
