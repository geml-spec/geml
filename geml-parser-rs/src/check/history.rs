//! `geml-history/v1`: a `.gemlhistory` sidecar read, verified, and any of its
//! revisions reconstructed (§5, §6, §8). Reconstruction starts from the nearest
//! keyframe at or newer than the target and applies reverse patches along the
//! `parent` chain; every result is checked against its recorded SHA-256.
//!
//! A block key is `#id` or an id-less block's derived key, which §4 leaves to
//! the implementation. Read here as the sidecars this repository carries spell
//! it: `@` and the first eight hex digits of the SHA-256 of the block's lines
//! joined by LF.

use std::collections::HashMap;

use crate::block::Scanner;
use crate::diag::Diags;
use crate::model::Item;
use crate::sha256;
use crate::vocab::Vocabulary;

#[derive(Debug, Clone, PartialEq)]
pub struct Revision {
    pub id: String,
    pub parent: Option<String>,
    pub author: Option<String>,
    pub summary: Option<String>,
    pub hash: String,
    pub newline: String,
    pub ops: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Keyframe {
    pub id: String,
    pub hash: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Default, Clone)]
pub struct Sidecar {
    pub current: Option<String>,
    pub history_of: Option<String>,
    pub declared: bool,
    pub revisions: Vec<Revision>,
    pub keyframes: Vec<Keyframe>,
    pub blobs: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
enum Key {
    Id(String),
    Hash(String),
}

#[derive(Debug, Clone, PartialEq)]
enum Anchor {
    Start,
    End,
    After(Key),
    Before(Key),
}

#[derive(Debug, Clone, PartialEq)]
enum Op {
    Delete(Key),
    Replace(Key, String),
    Insert(String, Anchor),
    Move(Key, Anchor),
}

fn key(s: &str) -> Result<Key, String> {
    if let Some(id) = s.strip_prefix('#') {
        Ok(Key::Id(id.to_string()))
    } else if let Some(h) = s.strip_prefix('@') {
        Ok(Key::Hash(h.to_string()))
    } else {
        Err(format!("`{s}` is not a block key"))
    }
}

fn anchor(words: &[&str]) -> Result<Anchor, String> {
    match words {
        ["at-start"] => Ok(Anchor::Start),
        ["at-end"] => Ok(Anchor::End),
        ["after", k] => Ok(Anchor::After(key(k)?)),
        ["before", k] => Ok(Anchor::Before(key(k)?)),
        _ => Err(format!("`{}` is not an anchor", words.join(" "))),
    }
}

fn blob(s: &str) -> Result<String, String> {
    s.strip_prefix("blob:").map(str::to_string).ok_or_else(|| format!("`{s}` is not `blob:<id>`"))
}

fn parse_op(line: &str) -> Result<Op, String> {
    let w: Vec<&str> = line.split_whitespace().collect();
    match w.as_slice() {
        ["delete", k] => Ok(Op::Delete(key(k)?)),
        ["replace", k, "<-", b] => Ok(Op::Replace(key(k)?, blob(b)?)),
        ["insert", "<-", b, rest @ ..] => Ok(Op::Insert(blob(b)?, anchor(rest)?)),
        ["move", k, rest @ ..] => Ok(Op::Move(key(k)?, anchor(rest)?)),
        _ => Err(format!("`{line}` is not a reverse-patch operation")),
    }
}

/// Read a sidecar's blocks.
pub fn read(text: &str) -> Sidecar {
    let doc = crate::parse(text);
    let mut s = Sidecar { declared: doc.declared.iter().any(|d| d == "geml-history/v1"), ..Default::default() };
    for (k, v) in &doc.meta {
        match k.as_str() {
            "current" => s.current = v.scalar_text(),
            "history-of" => s.history_of = v.scalar_text(),
            _ => {}
        }
    }
    for it in &doc.children {
        let Item::Block(b) = it else { continue };
        match b.type_name.as_str() {
            "history-revision" => s.revisions.push(Revision {
                id: b.attr_text("id").unwrap_or_default(),
                parent: b.attr_text("parent"),
                author: b.attr_text("author"),
                summary: b.attr_text("summary"),
                hash: b.attr_text("hash").unwrap_or_default(),
                newline: b.attr_text("newline").unwrap_or_else(|| "lf".into()),
                ops: b.raw.iter().filter(|l| !l.trim().is_empty()).cloned().collect(),
            }),
            "history-keyframe" => {
                s.keyframes.push(Keyframe { id: b.attr_text("id").unwrap_or_default(), hash: b.attr_text("hash").unwrap_or_default(), lines: b.raw.clone() })
            }
            "history-blob" => {
                if let Some(id) = &b.id {
                    s.blobs.insert(id.clone(), b.raw.clone());
                }
            }
            _ => {}
        }
    }
    s
}

/// `sha256:` and the hash of the version's bytes in its newline style.
pub fn content_hash(lines: &[String], newline: &str) -> String {
    let nl = if newline == "crlf" { "\r\n" } else { "\n" };
    format!("sha256:{}", sha256::hex(lines.join(nl).as_bytes()))
}

/// One top-level block of a version: its lines, its id, its derived key.
struct Seg {
    start: usize,
    end: usize,
    id: Option<String>,
    key: String,
}

/// The units a patch addresses (profile §4): each top-level typed block on its
/// own — to the line GEML §3 closes it on, a labeled fence included — and every
/// other run of lines no blank line divides: a paragraph and the list it runs
/// into are one unit, a list's blank-separated items several. A unit opened by
/// a heading with an explicit `{#id}` is keyed by it; a derived id is not a key.
fn segments(lines: &[String]) -> Vec<Seg> {
    let none = Vocabulary::default();
    let mut d = Diags::default();
    let items = Scanner::new(lines, &mut d, &none).scan_body(0, lines.len(), 0);
    let fences: Vec<(usize, usize, Option<String>)> = items
        .iter()
        .filter_map(|it| match it {
            Item::Block(b) => Some((b.line - 1, b.end - 1, b.id.clone())),
            _ => None,
        })
        .collect();
    let mut out = Vec::new();
    let mut fi = 0;
    let mut i = 0;
    let seg = |s: usize, e: usize, id: Option<String>| Seg { start: s, end: e, id, key: sha256::hex(lines[s..=e].join("\n").as_bytes())[..8].to_string() };
    while i < lines.len() {
        if fi < fences.len() && fences[fi].0 == i {
            let (s, e, id) = fences[fi].clone();
            out.push(seg(s, e, id));
            fi += 1;
            i = e + 1;
            continue;
        }
        if crate::block::is_blank(&lines[i]) {
            i += 1;
            continue;
        }
        let s = i;
        while i < lines.len() && !crate::block::is_blank(&lines[i]) && !(fi < fences.len() && fences[fi].0 == i) {
            i += 1;
        }
        let id = crate::block::parse_heading(&lines[s]).and_then(|h| h.attrs.and_then(|a| a.id));
        out.push(seg(s, i - 1, id));
    }
    out
}

/// A key's base and its `~n` occurrence (profile §4): `@3f9a1c2e~1` is the
/// second unit with that content key, counted in document order.
fn occurrence(s: &str) -> (&str, usize) {
    match s.rsplit_once('~') {
        Some((base, n)) if !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()) => (base, n.parse().unwrap_or(0)),
        _ => (s, 0),
    }
}

fn find(segs: &[Seg], k: &Key) -> Option<usize> {
    let (base, nth) = occurrence(match k {
        Key::Id(s) | Key::Hash(s) => s,
    });
    segs.iter()
        .enumerate()
        .filter(|(_, s)| match k {
            Key::Id(_) => s.id.as_deref() == Some(base),
            Key::Hash(_) => s.key == base,
        })
        .nth(nth)
        .map(|(i, _)| i)
}

/// The unit a patch moves: a block's lines and the blank line after it. A
/// blob holds the same unit, so a removed block comes back with its separator.
fn unit_end(lines: &[String], s: &Seg) -> usize {
    let mut e = s.end + 1;
    while e < lines.len() && lines[e].trim().is_empty() {
        e += 1;
    }
    e
}

fn take(lines: &mut Vec<String>, s: &Seg) -> Vec<String> {
    let end = unit_end(lines, s);
    lines.drain(s.start..end).collect()
}

fn place(lines: &mut Vec<String>, a: &Anchor, unit: Vec<String>) -> Result<(), String> {
    let segs = segments(lines);
    let at = match a {
        Anchor::Start => 0,
        Anchor::End => lines.len(),
        Anchor::After(k) => {
            let i = find(&segs, k).ok_or_else(|| format!("no block {k:?} to insert after"))?;
            unit_end(lines, &segs[i])
        }
        Anchor::Before(k) => {
            let i = find(&segs, k).ok_or_else(|| format!("no block {k:?} to insert before"))?;
            segs[i].start
        }
    };
    lines.splice(at..at, unit);
    Ok(())
}

impl Sidecar {
    fn blob(&self, id: &str) -> Result<&Vec<String>, String> {
        self.blobs.get(id).ok_or_else(|| format!("blob:{id} names no history-blob"))
    }

    /// Apply one revision's reverse patch: its content becomes its parent's.
    fn apply(&self, mut lines: Vec<String>, ops: &[String]) -> Result<Vec<String>, String> {
        for raw in ops {
            match parse_op(raw)? {
                Op::Delete(k) => {
                    let segs = segments(&lines);
                    let i = find(&segs, &k).ok_or_else(|| format!("`{raw}`: no such block"))?;
                    take(&mut lines, &segs[i]);
                }
                Op::Replace(k, b) => {
                    let segs = segments(&lines);
                    let i = find(&segs, &k).ok_or_else(|| format!("`{raw}`: no such block"))?;
                    let body = self.blob(&b)?.clone();
                    let end = unit_end(&lines, &segs[i]);
                    lines.splice(segs[i].start..end, body);
                }
                Op::Insert(b, a) => {
                    let body = self.blob(&b)?.clone();
                    place(&mut lines, &a, body).map_err(|m| format!("`{raw}`: {m}"))?;
                }
                Op::Move(k, a) => {
                    let segs = segments(&lines);
                    let i = find(&segs, &k).ok_or_else(|| format!("`{raw}`: no such block"))?;
                    let unit = take(&mut lines, &segs[i]);
                    place(&mut lines, &a, unit).map_err(|m| format!("`{raw}`: {m}"))?;
                }
            }
        }
        Ok(lines)
    }

    fn by_id(&self, id: &str) -> Option<&Revision> {
        self.revisions.iter().find(|r| r.id == id)
    }

    /// The revision a selector names: an id, or any unambiguous prefix of one.
    pub fn select(&self, sel: &str) -> Result<&Revision, String> {
        if let Some(r) = self.by_id(sel) {
            return Ok(r);
        }
        let hits: Vec<&Revision> =
            self.revisions.iter().filter(|r| r.id.starts_with(sel) || r.id.split('-').nth(1).is_some_and(|s| s.starts_with(sel))).collect();
        match hits.as_slice() {
            [r] => Ok(r),
            [] => Err(format!("no revision `{sel}`")),
            _ => Err(format!("`{sel}` names {} revisions", hits.len())),
        }
    }

    /// The chain from the current revision back to the root.
    pub fn chain(&self) -> Result<Vec<&Revision>, String> {
        let cur = match &self.current {
            Some(c) => c.clone(),
            None => self.keyframes.first().map(|k| k.id.clone()).ok_or("the sidecar names no current revision")?,
        };
        let mut out = Vec::new();
        let mut at = Some(cur);
        while let Some(id) = at {
            let r = self.by_id(&id).ok_or_else(|| format!("the chain names `{id}`, and no revision carries that id"))?;
            if out.len() > self.revisions.len() {
                return Err("the parent chain loops".into());
            }
            out.push(r);
            at = r.parent.clone();
        }
        Ok(out)
    }

    /// Reconstruct a revision's content (its lines), verified against its hash.
    pub fn reconstruct_lines(&self, sel: &str) -> Result<Vec<String>, String> {
        let target = self.select(sel)?;
        let chain = self.chain()?;
        let t = chain.iter().position(|r| r.id == target.id).ok_or("the revision is not on the chain from current")?;
        let k = (0..=t).rev().find(|i| self.keyframes.iter().any(|kf| kf.id == chain[*i].id)).ok_or("no keyframe at or newer than the revision")?;
        let mut lines = self.keyframes.iter().find(|kf| kf.id == chain[k].id).expect("found above").lines.clone();
        for r in &chain[k..t] {
            lines = self.apply(lines, &r.ops).map_err(|m| format!("revision {}: {m}", r.id))?;
        }
        let h = content_hash(&lines, &target.newline);
        if h != target.hash {
            return Err(format!("revision {} reconstructs to {h}, and records {}", target.id, target.hash));
        }
        Ok(lines)
    }

    /// Reconstruct a revision as the bytes it was hashed as.
    pub fn reconstruct(&self, sel: &str) -> Result<String, String> {
        let r = self.select(sel)?;
        let nl = if r.newline == "crlf" { "\r\n" } else { "\n" };
        Ok(self.reconstruct_lines(sel)?.join(nl))
    }

    /// §8 and §9: corruption is an error; a live file that differs from the
    /// current revision is a warning (uncommitted changes).
    pub fn verify(&self, live: Option<&[u8]>) -> Verification {
        let mut v = Verification::default();
        if !self.declared {
            v.warnings.push("the sidecar does not declare `profile = \"geml-history/v1\"`".into());
        }
        let chain = match self.chain() {
            Ok(c) => c,
            Err(m) => {
                v.errors.push(m);
                return v;
            }
        };
        for r in &self.revisions {
            if !chain.iter().any(|c| c.id == r.id) {
                v.errors.push(format!("revision {} is not on the parent chain from current", r.id));
            }
            for op in &r.ops {
                match parse_op(op) {
                    Err(m) => v.errors.push(format!("revision {}: {m}", r.id)),
                    Ok(Op::Replace(_, b) | Op::Insert(b, _)) if !self.blobs.contains_key(&b) => {
                        v.errors.push(format!("revision {}: blob:{b} names no history-blob", r.id))
                    }
                    Ok(_) => {}
                }
            }
        }
        for kf in &self.keyframes {
            match self.by_id(&kf.id) {
                Some(r) if content_hash(&kf.lines, &r.newline) != kf.hash => v.errors.push(format!("keyframe {} does not hash to its recorded value", kf.id)),
                Some(_) => {}
                None => v.errors.push(format!("keyframe {} names no revision", kf.id)),
            }
        }
        // One walk down the chain: each step's content checked against its
        // recorded hash, then patched into its parent's. A keyframe met on the
        // way is an exact entry point, so a broken step only taints its segment.
        let mut content: Option<Vec<String>> = None;
        for r in &chain {
            if let Some(kf) = self.keyframes.iter().find(|k| k.id == r.id) {
                content = Some(kf.lines.clone());
            }
            let Some(lines) = content.take() else { continue };
            let h = content_hash(&lines, &r.newline);
            if h == r.hash {
                v.verified += 1;
            } else {
                v.errors.push(format!("revision {} reconstructs to {h}, and records {}", r.id, r.hash));
            }
            match self.apply(lines, &r.ops) {
                Ok(next) => content = Some(next),
                Err(m) => v.errors.push(format!("revision {}: {m}", r.id)),
            }
        }
        if v.verified < chain.len() && content.is_none() && v.errors.is_empty() {
            v.errors.push("no keyframe is at or newer than every revision".into());
        }
        if let (Some(live), Some(cur)) = (live, chain.first()) {
            let h = format!("sha256:{}", sha256::hex(live));
            if h != cur.hash {
                v.warnings.push(format!("the live file differs from the current revision {} (uncommitted changes)", cur.id));
            }
        }
        v
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct Verification {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    /// How many revisions reconstructed to their recorded hash.
    pub verified: usize,
}

impl Verification {
    /// `{"errors": [...], "warnings": [...], "verified": n}`.
    pub fn to_json(&self) -> String {
        use crate::json::{to_json, Value};
        let list = |v: &[String]| Value::Array(v.iter().cloned().map(Value::String).collect());
        to_json(&Value::Object(vec![
            ("errors".into(), list(&self.errors)),
            ("warnings".into(), list(&self.warnings)),
            ("verified".into(), Value::Number(self.verified as f64)),
        ]))
    }
}
