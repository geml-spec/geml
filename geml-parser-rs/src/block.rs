//! Block structure (§2, §3, §3.1): typed blocks, headings, lists, paragraphs,
//! `%%` lines, and the ``` shield. Inline content is parsed later, once the
//! document's merged `meta` is known (§4's interpolation reads it).

use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};

use crate::attrs::{parse_attrs, read_object, read_quoted, type_bare, Attrs};
use crate::bounds::BLOCK_NESTING;
use crate::diag::Diags;
use crate::inline::verbatim_spans;
use crate::json::Value;
use crate::model::*;
use crate::registry;
use crate::uni::nfd;
use crate::vocab::Vocabulary;

pub fn is_blank(s: &str) -> bool {
    s.chars().all(|c| c == ' ' || c == '\t')
}

fn leading(s: &str, c: char) -> usize {
    s.chars().take_while(|x| *x == c).count()
}

fn skip_space(chars: &[char], mut i: usize) -> usize {
    while i < chars.len() && (chars[i] == ' ' || chars[i] == '\t') {
        i += 1;
    }
    i
}

#[derive(Debug, Clone, PartialEq)]
pub struct FenceOpen {
    pub len: usize,
    pub type_name: String,
    pub attrs: Attrs,
}

/// The open-fence production of §3.1 over one logical line.
pub fn parse_fence_open(line: &str) -> Option<FenceOpen> {
    let chars: Vec<char> = line.chars().collect();
    let len = leading(line, '=');
    if len < 3 {
        return None;
    }
    let mut i = skip_space(&chars, len);
    if i >= chars.len() || !chars[i].is_ascii_alphabetic() {
        return None;
    }
    let t0 = i;
    while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '-' || chars[i] == '_') {
        i += 1;
    }
    let type_name: String = chars[t0..i].iter().collect();
    i = skip_space(&chars, i);
    let mut attrs = Attrs::default();
    if i < chars.len() {
        if chars[i] != '{' {
            return None;
        }
        // §4, step 1: on a fence line the object runs to the LAST `}` of the
        // line, which only spaces and tabs may follow; a brace between is an
        // ordinary character.
        let close = chars.iter().rposition(|c| *c == '}').filter(|c| *c > i)?;
        if skip_space(&chars, close + 1) < chars.len() {
            return None;
        }
        attrs = read_object(&chars[i + 1..close]);
    }
    Some(FenceOpen { len, type_name, attrs })
}

/// A line shaped exactly like a labeled close, `=== #id`: the id it names.
pub fn labeled_close_id(line: &str) -> Option<String> {
    let chars: Vec<char> = line.chars().collect();
    let n = leading(line, '=');
    if n < 3 {
        return None;
    }
    let i = skip_space(&chars, n);
    if chars.get(i) != Some(&'#') {
        return None;
    }
    let rest: String = chars[i + 1..].iter().collect();
    let id = rest.trim_end_matches([' ', '\t']);
    if id.is_empty() || id.chars().any(char::is_whitespace) {
        return None;
    }
    Some(id.to_string())
}

fn is_close(line: &str, len: usize, id: Option<&str>) -> bool {
    let t = line.trim_end_matches([' ', '\t']);
    if t.len() == len && t.bytes().all(|b| b == b'=') {
        return true;
    }
    match (id, labeled_close_id(line)) {
        (Some(id), Some(l)) => nfd(&l) == nfd(id),
        _ => false,
    }
}

/// A line that begins with a `=` run and a type name but is no open fence
/// (Appendix A `fence-like-line`): reported when the name is registered, or
/// when the rest of the line carries attribute evidence.
fn fence_like(line: &str) -> bool {
    let chars: Vec<char> = line.chars().collect();
    let n = leading(line, '=');
    if n < 3 {
        return false;
    }
    let mut i = skip_space(&chars, n);
    if i >= chars.len() || !chars[i].is_ascii_alphabetic() {
        return false;
    }
    let t0 = i;
    while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '-' || chars[i] == '_') {
        i += 1;
    }
    let name: String = chars[t0..i].iter().collect();
    let rest: String = chars[i..].iter().collect();
    let evidence = rest.contains('{') || rest.contains('}') || rest.split_whitespace().any(|w| w.find('=').is_some_and(|p| p > 0));
    registry::is_known(&name) || evidence
}

/// `indent "%%" [SP text]` (§3.1): the note's text.
pub fn comment_line(line: &str) -> Option<String> {
    let t = line.trim_start_matches([' ', '\t']);
    let rest = t.strip_prefix("%%")?;
    if rest.is_empty() {
        return Some(String::new());
    }
    rest.strip_prefix(' ').map(|s| s.to_string())
}

/// A heading line after its `#` run and the spaces that follow it.
pub fn heading_source(line: &str) -> String {
    line.trim_start_matches('#').trim_start_matches([' ', '\t']).to_string()
}

pub fn heading_level(line: &str) -> Option<usize> {
    let n = leading(line, '#');
    if !(1..=6).contains(&n) {
        return None;
    }
    match line[n..].chars().next() {
        Some(' ') | Some('\t') => Some(n),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ItemLine {
    pub col: usize,
    pub ordered: bool,
    pub start: f64,
    pub checked: Option<bool>,
    pub content: String,
}

pub fn indent_cols(line: &str) -> usize {
    let mut col = 0;
    for c in line.chars() {
        match c {
            ' ' => col += 1,
            '\t' => col += 4,
            _ => break,
        }
    }
    col
}

/// An item line (§2.2): indentation, a marker, a space, the content. The
/// separating space may be several, or a tab; none of it is content.
pub fn list_item(line: &str) -> Option<ItemLine> {
    let col = indent_cols(line);
    let t = line.trim_start_matches([' ', '\t']);
    let (ordered, start, after) = match t.as_bytes().first() {
        Some(b'-' | b'*') => (false, 1.0, &t[1..]),
        _ => {
            let d = t.bytes().take_while(|b| b.is_ascii_digit()).count();
            if d == 0 {
                return None;
            }
            (true, t[..d].parse::<f64>().unwrap_or(1.0), t[d..].strip_prefix('.')?)
        }
    };
    let rest = after.trim_start_matches([' ', '\t']);
    if rest.len() == after.len() {
        return None;
    }
    let (checked, content) = task_marker(rest);
    Some(ItemLine { col, ordered, start, checked, content: content.to_string() })
}

/// A task marker opening an item's first line — `[ ]`, `[x]` or `[X]`, alone
/// or followed by space — and the content after it.
fn task_marker(rest: &str) -> (Option<bool>, &str) {
    let b = rest.as_bytes();
    if b.len() >= 3 && b[0] == b'[' && b[2] == b']' && matches!(b[1], b' ' | b'x' | b'X') {
        let after = &rest[3..];
        let text = after.trim_start_matches([' ', '\t']);
        if after.is_empty() || text.len() < after.len() {
            return (Some(b[1] != b' '), text);
        }
    }
    (None, rest)
}

/// A ``` line that may open a shield: three or more backticks, then text with
/// no backtick (an info string).
fn backtick_open(line: &str) -> Option<usize> {
    let t = line.trim_start_matches([' ', '\t']);
    let n = leading(t, '`');
    if n >= 3 && !t[n..].contains('`') {
        Some(n)
    } else {
        None
    }
}

fn backtick_close(line: &str, n: usize) -> bool {
    let t = line.trim_matches([' ', '\t']);
    !t.is_empty() && t.bytes().all(|b| b == b'`') && t.len() >= n
}

/// The shield of one body (§3.1): a matched pair of ``` lines keeps the lines
/// between them from being constructs. Opened lazily, as the scan reaches the
/// opening line, so a pair never reaches across a block the scan consumed.
struct Shield {
    open: Option<usize>,
    close: usize,
    body_end: usize,
    /// For each opener length, the close the last search found, or `None`
    /// when none was left. The scan asks in line order, so a later opener of
    /// that length reuses the answer while it still lies ahead: a body of
    /// unmatched openers is one search per length, not one per line.
    found: HashMap<usize, Option<usize>>,
}

impl Shield {
    fn new(body_end: usize) -> Shield {
        Shield { open: None, close: 0, body_end, found: HashMap::new() }
    }

    fn shielded(&mut self, lines: &[String], j: usize) -> bool {
        if let Some(o) = self.open {
            if j > o && j < self.close {
                return true;
            }
            if j <= self.close {
                return false;
            }
        }
        if let Some(n) = backtick_open(&lines[j]) {
            let close = match self.found.get(&n) {
                Some(None) => None,
                Some(Some(k)) if *k > j => Some(*k),
                _ => {
                    let k = (j + 1..self.body_end).find(|k| backtick_close(&lines[*k], n));
                    self.found.insert(n, k);
                    k
                }
            };
            if let Some(k) = close {
                self.open = Some(j);
                self.close = k;
            }
        }
        false
    }
}

/// For each line taken as a continuation line of a fold that reached it: the
/// last line the fold takes in from there, and the last non-White_Space
/// character the fold gets from those lines. Built once, right to left.
struct Continuations {
    reach: Vec<usize>,
    tail: Vec<Option<char>>,
}

impl Continuations {
    fn of(lines: &[String]) -> Continuations {
        let n = lines.len();
        let mut c = Continuations { reach: vec![0; n], tail: vec![None; n] };
        for j in (0..n).rev() {
            let t = lines[j].trim();
            let goes_on = t.ends_with('\\') && j + 1 < n;
            let seg = t.strip_suffix('\\').map_or(t, str::trim_end);
            c.reach[j] = if goes_on { c.reach[j + 1] } else { j };
            c.tail[j] = if goes_on { c.tail[j + 1].or(seg.chars().last()) } else { seg.chars().last() };
        }
        c
    }
}

/// A heading line read into its parts.
#[derive(Debug, Clone, PartialEq)]
pub struct HeadingLine {
    pub level: usize,
    pub text: String,
    pub attrs: Option<Attrs>,
    pub issue: Option<(&'static str, String)>,
}

pub fn parse_heading(line: &str) -> Option<HeadingLine> {
    let level = heading_level(line)?;
    let chars: Vec<char> = line.chars().collect();
    let start = skip_space(&chars, level);
    let body = &chars[start..];
    let mut end = body.len();
    while end > 0 && (body[end - 1] == ' ' || body[end - 1] == '\t') {
        end -= 1;
    }
    let verbatim = verbatim_spans(&body[..end]);
    let mut held = vec![false; end];
    for (s, e, _) in &verbatim {
        held[*s..(*e).min(end)].fill(true);
    }
    let inside = |k: usize| held.get(k).copied().unwrap_or(false);
    let open = heading_object(&body[..end], &inside);
    let attrs = open.map(|k| read_object(&body[k + 1..end - 1]));
    let text_end = open.unwrap_or(end);
    let mut issue = None;
    if attrs.is_none() {
        for k in 0..body.len() {
            if body[k] != '{' || k == 0 || !(body[k - 1] == ' ' || body[k - 1] == '\t') || inside(k) {
                continue;
            }
            if !matches!(body.get(k + 1), Some('#') | Some('.')) {
                continue;
            }
            issue = Some(match parse_attrs(body, k) {
                Some(_) => {
                    ("heading-attrs-trailing-text", "the heading's attribute object is followed by more text, so it is not read as attributes".to_string())
                }
                None => ("heading-attrs-unclosed", "the heading's attribute object is never closed by `}`".to_string()),
            });
            break;
        }
    }
    let text: String = body[..text_end].iter().collect();
    let text = text.trim_end_matches([' ', '\t']).to_string();
    Some(HeadingLine { level, text, attrs, issue })
}

/// §4, step 1, on a heading line: the object is its trailing group. Read
/// leftwards from the final `}` — a `"` toggles a quoted span unless an odd run
/// of `\` precedes it — the nearest `{` outside a span, a code span and inline
/// math opens the object when whitespace, or the start of the text, precedes
/// it; a `}` met first, or a `{` glued to the text, means there is none.
fn heading_object(t: &[char], inside: &dyn Fn(usize) -> bool) -> Option<usize> {
    let last = t.len().checked_sub(1)?;
    if t[last] != '}' || inside(last) {
        return None;
    }
    let mut quoted = false;
    let mut k = last;
    while k > 0 {
        k -= 1;
        let c = t[k];
        if c == '"' {
            let run = t[..k].iter().rev().take_while(|x| **x == '\\').count();
            if run % 2 == 0 {
                quoted = !quoted;
            }
            continue;
        }
        if quoted || (c != '{' && c != '}') || inside(k) {
            continue;
        }
        if c == '}' {
            return None;
        }
        return (k == 0 || t[k - 1] == ' ' || t[k - 1] == '\t').then_some(k);
    }
    None
}

pub struct Scanner<'a> {
    pub lines: &'a [String],
    pub diags: &'a mut Diags,
    /// The vocabularies the document declares that this processor recognizes.
    pub vocab: &'a Vocabulary,
    /// Read the lines as Markdown (`Options::markdown`).
    pub markdown: bool,
    continuations: OnceCell<Continuations>,
}

impl<'a> Scanner<'a> {
    pub fn new(lines: &'a [String], diags: &'a mut Diags, vocab: &'a Vocabulary) -> Self {
        Scanner { lines, diags, vocab, markdown: false, continuations: OnceCell::new() }
    }

    /// Read the lines as Markdown.
    pub fn markdown(mut self, on: bool) -> Self {
        self.markdown = on;
        self
    }

    /// Fold a fence or heading line ending in `\` with the lines after it
    /// (§4): the logical line and how many physical lines it took.
    fn fold(&self, i: usize, end: usize) -> (String, usize) {
        let mut logical = self.lines[i].clone();
        let mut used = 1;
        while logical.ends_with('\\') && i + used < end {
            // §4: the backslash, the newline and the White_Space on either side
            // of them become one space.
            logical.pop();
            logical.truncate(logical.trim_end().len());
            logical.push(' ');
            logical.push_str(self.lines[i + used].trim());
            used += 1;
        }
        (logical, used)
    }

    fn try_fence(&self, i: usize, end: usize) -> Option<(FenceOpen, usize)> {
        let line = &self.lines[i];
        if !line.starts_with("===") {
            return None;
        }
        // A `===` line folds into an opening fence only when the folded line
        // ends in the `}` of an attribute object, or holds nothing after the
        // type. When neither can hold the fold is not built: every line asks,
        // and folding a run of 40,000 `=== x\` lines from each of them took
        // seconds.
        if line.ends_with('\\') && i + 1 < end {
            let c = self.continuations.get_or_init(|| Continuations::of(self.lines));
            if c.reach[i + 1] < end {
                let head = line[..line.len() - 1].trim_end();
                let rest = c.tail[i + 1];
                let bare = rest.is_none() && parse_fence_open(head).is_some_and(|f| f.attrs == Attrs::default());
                if rest.or(head.chars().last()) != Some('}') && !bare {
                    return None;
                }
            }
        }
        let (logical, used) = self.fold(i, end);
        parse_fence_open(&logical).map(|f| (f, used))
    }

    pub fn scan_body(&mut self, start: usize, end: usize, depth: usize) -> Vec<Item> {
        if self.markdown {
            return self.scan_markdown(start, end, depth);
        }
        // This loop recurses once per nested block (through typed_block), so it
        // holds only what that needs; every other construct is read by
        // scan_line, whose frame is gone before the recursion starts.
        let mut items = Vec::new();
        let mut sh = Shield::new(end);
        let mut i = start;
        while i < end {
            let shielded = sh.shielded(self.lines, i);
            if is_blank(&self.lines[i]) {
                i += 1;
                continue;
            }
            if !shielded {
                if let Some((fence, used)) = self.try_fence(i, end) {
                    let (block, next) = self.typed_block(i, used, fence, end, depth);
                    items.push(Item::Block(block));
                    i = next;
                    continue;
                }
            }
            i = self.scan_line(i, end, shielded, &mut sh, &mut items);
        }
        items
    }

    /// One construct that is not a typed block, at line `i`: a `%%` line, a
    /// heading, a list or a paragraph. The line after it.
    #[inline(never)]
    fn scan_line(&mut self, i: usize, end: usize, shielded: bool, sh: &mut Shield, items: &mut Vec<Item>) -> usize {
        let line = &self.lines[i];
        if !shielded {
            if let Some(text) = comment_line(line) {
                items.push(Item::Hidden(Hidden { text, line: i + 1 }));
                return i + 1;
            }
            if heading_level(line).is_some() {
                let (item, used) = self.heading_at(i, end);
                items.push(item);
                return i + used;
            }
            if list_item(line).is_some() {
                let (list, next) = self.list(i, end, sh);
                items.push(Item::List(list));
                return next;
            }
        }
        let (p, next) = self.paragraph(i, end, sh);
        items.push(Item::Paragraph(p));
        next
    }

    /// The ATX heading at 0-based line `i`, folded, and how many lines it
    /// took. Kept out of the scan loop's own frame: the loop recurses once per
    /// nested block, and what a heading needs is not needed on that stack.
    #[inline(never)]
    fn heading_at(&mut self, i: usize, end: usize) -> (Item, usize) {
        let (logical, used) = self.fold(i, end);
        let h = parse_heading(&logical).expect("a heading line");
        (self.heading_item(h, i, heading_source(&logical), 1), used)
    }

    /// A heading item from a heading line already read, at 0-based line `i`.
    fn heading_item(&mut self, h: HeadingLine, i: usize, source: String, head: usize) -> Item {
        if let Some((code, msg)) = h.issue.clone() {
            self.diags.push(code, i + 1, msg);
        }
        let (id, declared, classes, attrs) = match h.attrs {
            Some(a) => {
                for (code, msg) in &a.issues {
                    self.diags.push(code, i + 1, msg.clone());
                }
                let declared = a.id.is_some();
                (a.id.unwrap_or_default(), declared, a.classes, a.kv)
            }
            None => (String::new(), false, vec![], vec![]),
        };
        Item::Heading(Heading { level: h.level, text: h.text, inlines: vec![], id, declared, classes, attrs, line: i + 1, source, head })
    }

    /// One body read as Markdown (`crate::markdown`): the structure is worked
    /// out over the body's own lines first — code runs, the lines no construct
    /// starts on, setext headings — and the scan follows it.
    fn scan_markdown(&mut self, start: usize, end: usize, depth: usize) -> Vec<Item> {
        let vocab = self.vocab;
        let known = |t: &str| registry::is_known(t) || vocab.admits_type(t);
        let st = crate::markdown::structure(&self.lines[start..end], &known);
        let shielded = |j: usize| st.shield.contains(&(j - start));
        let mut items = Vec::new();
        let mut i = start;
        while i < end {
            let line = &self.lines[i];
            if is_blank(line) {
                i += 1;
                continue;
            }
            if let Some(run_end) = st.code_at.get(&(i - start)) {
                let run_end = start + run_end;
                items.push(Item::Paragraph(Paragraph { source: self.lines[i..run_end].join("\n"), inlines: vec![], line: i + 1, code: true }));
                i = run_end;
                continue;
            }
            if !shielded(i) {
                if let Some(text) = comment_line(line) {
                    items.push(Item::Hidden(Hidden { text, line: i + 1 }));
                    i += 1;
                    continue;
                }
                if let Some((fence, used)) = self.try_fence(i, end) {
                    let (block, next) = self.typed_block(i, used, fence, end, depth);
                    items.push(Item::Block(block));
                    i = next;
                    continue;
                }
            }
            if let Some(s) = st.setext.get(&(i - start)) {
                let item = self.heading_item(s.heading.clone(), i, s.source.clone(), s.end - (i - start));
                items.push(item);
                i = start + s.end;
                continue;
            }
            if !shielded(i) {
                if heading_level(line).is_some() {
                    let (item, used) = self.heading_at(i, end);
                    items.push(item);
                    i += used;
                    continue;
                }
                if list_item(line).is_some() {
                    let mut sh = Shield::new(end);
                    let (list, next) = self.list(i, end, &mut sh);
                    items.push(Item::List(list));
                    i = next;
                    continue;
                }
            }
            let mut j = i;
            while j < end {
                let l = &self.lines[j];
                if is_blank(l) || (j > i && (st.code_at.contains_key(&(j - start)) || st.setext.contains_key(&(j - start)))) {
                    break;
                }
                if j > i
                    && !shielded(j)
                    && (comment_line(l).is_some() || heading_level(l).is_some() || list_item(l).is_some() || self.try_fence(j, end).is_some())
                {
                    break;
                }
                if !shielded(j) {
                    self.note_text_line(j);
                }
                j += 1;
            }
            items.push(Item::Paragraph(Paragraph { source: self.lines[i..j].join("\n"), inlines: vec![], line: i + 1, code: false }));
            i = j;
        }
        items
    }

    fn note_text_line(&mut self, j: usize) {
        let line = &self.lines[j];
        if labeled_close_id(line).is_some() {
            self.diags.push("stray-labeled-fence", j + 1, "a labeled close fell through to paragraph text, closing nothing");
        } else if fence_like(line) {
            self.diags.push("fence-like-line", j + 1, "a line that begins like a fence is not one, and is read as paragraph text");
        }
    }

    fn paragraph(&mut self, i: usize, end: usize, sh: &mut Shield) -> (Paragraph, usize) {
        let mut j = i;
        let mut text: Vec<&str> = Vec::new();
        while j < end {
            let line = &self.lines[j];
            let shielded = sh.shielded(self.lines, j);
            if j > i {
                if is_blank(line) {
                    break;
                }
                if !shielded && (comment_line(line).is_some() || heading_level(line).is_some() || list_item(line).is_some() || self.try_fence(j, end).is_some())
                {
                    break;
                }
            }
            if !shielded {
                self.note_text_line(j);
            }
            text.push(line);
            j += 1;
        }
        (Paragraph { source: text.join("\n"), inlines: vec![], line: i + 1, code: false }, j)
    }

    fn typed_block(&mut self, i: usize, used: usize, fence: FenceOpen, end: usize, depth: usize) -> (Block, usize) {
        // The recursion runs through here: the block's head is read by
        // block_shell, and only the block and its body's range stay on the stack.
        let (mut block, next) = self.block_shell(i, used, fence, end, depth);
        let (body_start, body_end) = (block.body_start - 1, block.body_end - 1);
        match block.mode {
            Mode::Raw => block.raw = self.lines[body_start..body_end].to_vec(),
            Mode::Flow => block.children = self.scan_body(body_start, body_end, depth + 1),
            Mode::Data => block.data = self.meta_body(body_start, body_end),
            Mode::Prose => block.children = self.prose_body(body_start, body_end),
        }
        (block, next)
    }

    /// A typed block without its body: where it closes, its mode, its
    /// attributes checked against its type, and the line after it.
    #[inline(never)]
    fn block_shell(&mut self, i: usize, used: usize, fence: FenceOpen, end: usize, depth: usize) -> (Block, usize) {
        let body_start = i + used;
        let id = fence.attrs.id.clone();
        let close = (body_start..end).find(|j| is_close(&self.lines[*j], fence.len, id.as_deref()));
        let (body_end, next, last) = match close {
            Some(c) => (c, c + 1, c + 1),
            None => {
                self.diags.push("unterminated-block", i + 1, format!("the `{}` block is never closed", fence.type_name));
                (end, end, end.max(body_start))
            }
        };
        for (code, msg) in &fence.attrs.issues {
            self.diags.push(code, i + 1, msg.clone());
        }
        let t = fence.type_name.clone();
        // A type this specification registers keeps its own body mode; a type a
        // recognized vocabulary admits is read in the mode the vocabulary
        // declares for it (§8.6.1, GEP-0013); any other type is unknown.
        let core = registry::is_known(&t);
        let admitted = !core && self.vocab.admits_type(&t);
        if !core && !admitted {
            self.diags.push("unknown-block-type", i + 1, format!("`{t}` is not a registered block type; its body is kept raw"));
        } else {
            for (k, _) in &fence.attrs.kv {
                let defined = if core { registry::defines_attr(&t, k) } else { k == "caption" || k == "hidden" };
                if !defined && !self.vocab.admits_attr(&t, k) {
                    self.diags.push("unknown-attribute", i + 1, format!("`{t}` defines no attribute `{k}`"));
                }
            }
        }
        let mut mode = if admitted { self.vocab.mode_of(&t).unwrap_or(Mode::Raw) } else { registry::mode_of(&t) };
        if mode == Mode::Flow && depth + 1 > BLOCK_NESTING {
            self.diags.push("block-nesting-too-deep", i + 1, "typed blocks nest deeper than this processor admits; the body is kept raw");
            mode = Mode::Raw;
        }
        let block = Block {
            type_name: t,
            id,
            classes: fence.attrs.classes,
            attrs: fence.attrs.kv,
            mode,
            raw: vec![],
            children: vec![],
            data: vec![],
            value: None,
            table: None,
            line: i + 1,
            body_start: body_start + 1,
            body_end: body_end + 1,
            end: last,
        };
        (block, next)
    }

    /// A prose body (GEP-0013): paragraphs and nothing else. A fence, a
    /// heading, a list marker and a `%%` line are all text here, so the body
    /// holds no nested block and no address of its own.
    fn prose_body(&mut self, start: usize, end: usize) -> Vec<Item> {
        let mut items = Vec::new();
        let mut j = start;
        while j < end {
            if is_blank(&self.lines[j]) {
                j += 1;
                continue;
            }
            let s = j;
            while j < end && !is_blank(&self.lines[j]) {
                j += 1;
            }
            items.push(Item::Paragraph(Paragraph { source: self.lines[s..j].join("\n"), inlines: vec![], line: s + 1, code: false }));
        }
        items
    }

    /// A `meta` body: one `key = val` per line, typed as attribute values are.
    fn meta_body(&mut self, start: usize, end: usize) -> Vec<(String, Value)> {
        let mut out: Vec<(String, Value)> = Vec::new();
        let mut keys: HashSet<String> = HashSet::new();
        for j in start..end {
            let line = self.lines[j].trim();
            let Some((k, v)) = line.split_once('=') else { continue };
            let key = k.trim().to_string();
            let v = v.trim();
            let value = if v.starts_with('"') {
                let chars: Vec<char> = v.chars().collect();
                match read_quoted(&chars, 0) {
                    Some((s, _)) => Value::String(s),
                    None => Value::String(v.to_string()),
                }
            } else if v.chars().any(char::is_whitespace) {
                Value::String(v.to_string())
            } else {
                type_bare(v)
            };
            // A `key = value` body reads numbers too, and keeps §3.2's exactness rule.
            if let Value::Number(n) = value {
                if let Some(shown) = crate::num::inexact_number(v, n) {
                    self.diags.push("inexact-number", j + 1, crate::num::inexact_message(v, &shown));
                }
            }
            if !keys.insert(nfd(&key)) {
                self.diags.push("duplicate-meta-key", j + 1, format!("`{key}` is defined twice; the first definition is kept"));
                continue;
            }
            out.push((key, value));
        }
        out
    }

    fn list(&mut self, i: usize, end: usize, sh: &mut Shield) -> (List, usize) {
        struct Open {
            list: List,
            col: usize,
        }
        fn open(it: ItemLine, line: usize) -> Open {
            let col = it.col;
            let item = ListItem { source: it.content, inlines: vec![], checked: it.checked, children: vec![], line };
            Open { list: List { ordered: it.ordered, start: it.start, loose: false, items: vec![item], line }, col }
        }
        fn pop_attach(stack: &mut Vec<Open>) {
            let o = stack.pop().expect("a nested list");
            let parent = stack.last_mut().expect("its parent");
            parent.list.items.last_mut().expect("an item").children.push(o.list);
        }
        let mut stack: Vec<Open> = Vec::new();
        let mut j = i;
        let mut pending_blank = false;
        let mut can_continue = false;
        // A continuation line is indented past its OWN item's marker, which
        // need not stand where the list's first item does.
        let mut item_col = 0;
        let mut too_deep_reported = false;
        while j < end {
            let line = &self.lines[j];
            let shielded = sh.shielded(self.lines, j);
            if is_blank(line) {
                pending_blank = true;
                can_continue = false;
                j += 1;
                continue;
            }
            let item = if shielded { None } else { list_item(line) };
            if let Some(it) = item {
                let at = j + 1;
                item_col = it.col;
                if stack.is_empty() {
                    stack.push(open(it, at));
                } else {
                    while stack.len() > 1 && it.col < stack.last().expect("open").col {
                        pop_attach(&mut stack);
                    }
                    let top_col = stack.last().expect("open").col;
                    let top_ordered = stack.last().expect("open").list.ordered;
                    if it.col > top_col && stack.len() < BLOCK_NESTING {
                        stack.push(open(it, at));
                    } else if it.col > top_col || it.ordered == top_ordered {
                        if it.col > top_col && !too_deep_reported {
                            self.diags.push("list-nesting-too-deep", at, "lists nest deeper than this processor admits");
                            too_deep_reported = true;
                        }
                        let top = stack.last_mut().expect("open");
                        if pending_blank {
                            top.list.loose = true;
                        }
                        top.list.items.push(ListItem { source: it.content, inlines: vec![], checked: it.checked, children: vec![], line: at });
                    } else if stack.len() == 1 {
                        break;
                    } else {
                        pop_attach(&mut stack);
                        let mut o = open(it, at);
                        o.col = top_col;
                        stack.push(o);
                    }
                }
                pending_blank = false;
                can_continue = true;
                j += 1;
                continue;
            }
            if pending_blank || (!shielded && comment_line(line).is_some()) {
                break;
            }
            let top = stack.last_mut().expect("open");
            if can_continue && indent_cols(line) > item_col {
                let item = top.list.items.last_mut().expect("an item");
                item.source.push('\n');
                item.source.push_str(crate::uni::trim_js(line));
                j += 1;
                continue;
            }
            break;
        }
        while stack.len() > 1 {
            pop_attach(&mut stack);
        }
        (stack.pop().expect("a list").list, j)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fences() {
        let f = parse_fence_open("===note{#a}").unwrap();
        assert_eq!((f.len, f.type_name.as_str(), f.attrs.id.as_deref()), (3, "note", Some("a")));
        assert!(parse_fence_open("=== note").is_some());
        assert!(parse_fence_open("==== note {#a}  ").is_some());
        assert!(parse_fence_open("===9foo").is_none());
        assert!(parse_fence_open("=== embed src=#a").is_none());
        assert!(parse_fence_open("=== note {#a} x").is_none());
        assert!(parse_fence_open("=== note {#a").is_none());
        assert!(parse_fence_open("==").is_none());
        assert!(parse_fence_open("===").is_none());
        assert!(parse_fence_open("=== note:").is_none());
        assert_eq!(labeled_close_id("===#n1").as_deref(), Some("n1"));
        assert_eq!(labeled_close_id("=== #n1  ").as_deref(), Some("n1"));
        assert!(labeled_close_id("=== #").is_none());
        assert!(labeled_close_id("=== n1").is_none());
        assert!(labeled_close_id("== #n1").is_none());
        assert!(is_close("===  ", 3, None) && !is_close("====", 3, None) && is_close("====#a", 3, Some("a")));
        assert!(fence_like("=== embed src=#a") && fence_like("=== aaa}") && !fence_like("=== wall of text"));
        assert!(!fence_like("===") && !fence_like("== note") && !fence_like("=== 9"));
    }

    #[test]
    fn line_kinds() {
        assert_eq!(comment_line("  %% hi").as_deref(), Some("hi"));
        assert_eq!(comment_line("%%").as_deref(), Some(""));
        assert!(comment_line("%%x").is_none());
        assert_eq!(heading_level("## x"), Some(2));
        assert!(heading_level("#x").is_none() && heading_level("####### x").is_none() && heading_level("#").is_none());
        let it = list_item("\t12. [x] done").unwrap();
        assert_eq!((it.col, it.ordered, it.start, it.checked, it.content.as_str()), (4, true, 12.0, Some(true), "done"));
        assert!(list_item("-x").is_none() && list_item("1) x").is_none() && list_item("x").is_none());
        assert_eq!(list_item("* [ ] a").unwrap().checked, Some(false));
        assert_eq!(backtick_open("```md"), Some(3));
        assert!(backtick_open("``x").is_none() && backtick_open("```a`b").is_none());
        assert!(backtick_close("````", 3) && !backtick_close("``", 3) && !backtick_close("", 3));
    }

    #[test]
    fn heading_attrs() {
        let h = parse_heading("## Title {#sec}").unwrap();
        assert_eq!(h.text, "Title");
        assert_eq!(h.attrs.unwrap().id.as_deref(), Some("sec"));
        let h = parse_heading("## a {b} {#c}").unwrap();
        assert_eq!((h.text.as_str(), h.attrs.unwrap().id.as_deref()), ("a {b}", Some("c")));
        let h = parse_heading("## Title {#sec}aaa").unwrap();
        assert_eq!(h.issue.unwrap().0, "heading-attrs-trailing-text");
        let h = parse_heading("## Title {#sec").unwrap();
        assert_eq!(h.issue.unwrap().0, "heading-attrs-unclosed");
        let h = parse_heading("## Use `{#x}` here").unwrap();
        assert!(h.issue.is_none() && h.attrs.is_none());
        let h = parse_heading("## Sets {a, b}").unwrap();
        assert!(h.attrs.is_some());
    }
}
