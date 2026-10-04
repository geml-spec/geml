//! `geml-media/v1`'s checks (§2–§8 of its profile): timelines and their
//! tracks, assets and their files, lines and their speakers, comps and their
//! layers and interactions, and the generation log's lineage.
//!
//! Two hashes the profile's §6 fixes to the byte: a prompt's text after its
//! projections are expanded — the first paragraph as plain text, a projection
//! replaced by its target's text by the same rule, recursively to GEML §9.3's
//! bound — and a comp's canonical text: one line for the comp, one per layer
//! and one per interaction in document order, `type #id key=value …` with the
//! keys sorted, an interaction's `a=`/`b=` carrying the point they resolve to
//! as `value@x,y`, joined by LF.

use std::collections::HashMap;
use std::rc::Rc;

use super::{addr, timeline, Out};
use crate::bounds::{CHAIN_DEPTH, EMBED_TOTAL, MEDIA_APART_PX, MEDIA_MAX_TIME};
use crate::host::{FileState, Host};
use crate::json::Value;
use crate::model::{Block, Document, Inline, Item};
use crate::resolve::{Found, Index, Resolver, Snap, Target};
use crate::sha256;
use crate::vocab::Level::{Error as E, Info as I, Warning as W};

const TRACK_KINDS: &[&str] = &["video", "audio", "prose"];

/// The kind a file's extension implies, read when an asset writes no `kind` (§3).
fn kind_of_path(src: &str) -> &'static str {
    let ext = src.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tif" | "tiff" | "avif" | "svg" => "image",
        "mp4" | "mov" | "webm" | "mkv" | "avi" | "m4v" => "video",
        "wav" | "mp3" | "m4a" | "aac" | "flac" | "ogg" | "opus" => "audio",
        "safetensors" | "ckpt" | "pt" | "onnx" | "gguf" => "model",
        _ => "other",
    }
}

/// An asset's kind: its `kind=`, or its extension's (§3).
fn asset_kind(s: &Snap) -> String {
    s.attr_text("kind").unwrap_or_else(|| kind_of_path(&s.attr_text("src").unwrap_or_default()).to_string())
}

fn num(s: &Snap, k: &str) -> Option<f64> {
    s.attrs.iter().find(|(x, _)| x == k).and_then(|(_, v)| match v {
        Value::Number(n) => Some(*n),
        Value::String(t) => crate::num::parse_bare_number(t),
        _ => None,
    })
}

/// `WxH`.
fn size(s: &str) -> Option<(f64, f64)> {
    let (w, h) = s.split_once(['x', 'X'])?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

/// `x,y,w,h` (W3C Media Fragments' spatial dimension, pixels).
fn xywh(s: &str) -> Option<(f64, f64, f64, f64)> {
    let s = s.strip_prefix("pixel:").unwrap_or(s);
    let v: Vec<f64> = s.split(',').map(|p| p.trim().parse().ok()).collect::<Option<Vec<f64>>>()?;
    match v.as_slice() {
        [x, y, w, h] => Some((*x, *y, *w, *h)),
        _ => None,
    }
}

/// `name:x,y …` on an asset; bare names on a character or scene.
fn points(s: &str) -> Vec<(String, Option<(f64, f64)>)> {
    s.split_whitespace()
        .map(|p| match p.split_once(':') {
            Some((n, xy)) => {
                let c = xy.split_once(',').and_then(|(x, y)| Some((x.trim().parse().ok()?, y.trim().parse().ok()?)));
                (n.to_string(), c)
            }
            None => (p.to_string(), None),
        })
        .collect()
}

/// A reference as a profile attribute writes one: `#id`, `doc.geml#id`, or a
/// bare id meaning `#id`.
fn split_ref(r: &str) -> (Option<&str>, &str) {
    match r.split_once('#') {
        Some(("", id)) => (None, id),
        Some((d, id)) => (Some(d), id),
        None => (None, r),
    }
}

/// What a reference resolved to, for these checks.
enum Hit {
    /// No host to read another document with: the check is skipped.
    Unknown,
    Missing,
    Block(Rc<Index>, usize),
    Heading(Rc<Index>, usize),
    Other,
}

fn hit(r: &Resolver, reference: &str) -> Hit {
    let (d, id) = split_ref(reference.trim());
    match r.target(d, id) {
        Target::NoHost => Hit::Unknown,
        Target::Unreadable | Target::Unresolved { .. } => Hit::Missing,
        Target::Hit { index, found: Found::Block(i), .. } => Hit::Block(index, i),
        Target::Hit { index, found: Found::Heading(h), .. } => Hit::Heading(index, h),
        Target::Hit { .. } => Hit::Other,
    }
}

/// Plain text of inline content, a projection expanded by `expand`.
fn plain(ns: &[Inline], expand: &mut dyn FnMut(&Inline) -> Option<String>, out: &mut String) {
    for n in ns {
        match n {
            Inline::Text(t) | Inline::Code(t) | Inline::Math(t) => out.push_str(t),
            Inline::Emph(c) | Inline::Strong(c) | Inline::Strike(c) => plain(c, expand, out),
            Inline::Link { children, .. } => plain(children, expand, out),
            // Profile §6: an image, a hard break and a footnote contribute
            // nothing; an auto-reference only the value a coordinate gives it;
            // a projection its target's text, or nothing when it does not resolve.
            Inline::Image { .. } | Inline::Break => {}
            Inline::AutoRef { value, .. } => out.push_str(value.as_deref().unwrap_or_default()),
            Inline::Project { .. } => {
                if let Some(t) = expand(n) {
                    out.push_str(&t);
                }
            }
            Inline::Footnote(_) => {}
        }
    }
}

/// A block's first paragraph as plain text (profile §6).
fn block_text(s: &Snap, expand: &mut dyn FnMut(&Inline) -> Option<String>) -> String {
    let mut t = String::new();
    if let Some(p) = s.paras.first() {
        plain(p, expand, &mut t);
    }
    t
}

/// The text a prompt sends (profile §6): its first paragraph, each projection
/// replaced by the projected block's text by the same rule, recursively to
/// GEML §9.3's depth bound of 16.
fn prompt_text(r: &Resolver, index: &Rc<Index>, s: &Snap) -> String {
    let path: Vec<String> = s.id.iter().map(|id| format!("{}#{id}", r.name)).collect();
    prompt_text_at(r.host, index, &r.name, s, 0, &path, &mut 0)
}

/// Profile §6: the depth bound alone let a block projecting itself three
/// times run 3^16 expansions, and one projecting the next block four times,
/// sixteen deep, spell out 4^16 characters. A projection whose target is
/// already on the path is a cycle — the core reports it — and gives nothing;
/// and every expansion counts, `spent` against `EMBED_TOTAL` for the whole
/// prompt, after which a projection gives nothing: cut depth-first, in order.
fn prompt_text_at(host: Option<&dyn Host>, index: &Rc<Index>, name: &str, s: &Snap, depth: usize, path: &[String], spent: &mut usize) -> String {
    let mut expand = |n: &Inline| -> Option<String> {
        let Inline::Project { doc, anchor, .. } = n else { return None };
        let next = match doc {
            Some(d) => crate::host::join(name, d).unwrap_or_else(|| name.to_string()),
            None => name.to_string(),
        };
        let key = format!("{next}#{anchor}");
        if path.contains(&key) {
            return None;
        }
        *spent += 1;
        if *spent > EMBED_TOTAL {
            return None;
        }
        match Resolver::new(index.clone(), host, name).target(doc.as_deref(), anchor) {
            // A target past the depth bound is reached, and counted, but gives nothing.
            Target::Hit { index: ix, found: Found::Block(i), .. } if depth < CHAIN_DEPTH => {
                let deeper: Vec<String> = path.iter().cloned().chain([key]).collect();
                Some(prompt_text_at(host, &ix, &next, &ix.snaps[i], depth + 1, &deeper, spent))
            }
            _ => None,
        }
    };
    block_text(s, &mut expand)
}

fn canonical_line(type_name: &str, id: Option<&str>, attrs: &[(String, String)]) -> String {
    let mut a: Vec<&(String, String)> = attrs.iter().collect();
    a.sort();
    let mut line = type_name.to_string();
    if let Some(id) = id {
        line.push_str(&format!(" #{id}"));
    }
    for (k, v) in a {
        line.push_str(&format!(" {k}={v}"));
    }
    line
}

fn attr_line(s: &Snap) -> String {
    let attrs: Vec<(String, String)> = s.attrs.iter().map(|(k, v)| (k.clone(), v.scalar_text().unwrap_or_default())).collect();
    canonical_line(&s.type_name, s.id.as_deref(), &attrs)
}

/// One layer as an interaction places it.
#[derive(Clone)]
struct Layer {
    id: String,
    snap: Snap,
    asset: Option<Snap>,
    of_points: Option<Vec<String>>,
    x: f64,
    y: f64,
    placed: Option<String>,
}

impl Layer {
    /// The source width a point must be scaled or mirrored by.
    fn source_width(&self) -> Option<f64> {
        if let Some((_, _, w, _)) = self.snap.attr_text("xywh").as_deref().and_then(xywh) {
            return Some(w);
        }
        self.asset.as_ref().and_then(|a| a.attr_text("size")).as_deref().and_then(size).map(|(w, _)| w)
    }

    fn point(&self, name: &str) -> Option<(f64, f64)> {
        let a = self.asset.as_ref()?;
        points(&a.attr_text("points").unwrap_or_default()).into_iter().find(|(n, _)| n == name).and_then(|(_, c)| c)
    }

    /// Where a point of this layer lands on the canvas, given the layer's
    /// corner; `Err` when the source width it needs is unknown.
    fn on_canvas(&self, p: (f64, f64)) -> Result<(f64, f64), ()> {
        let (cx, cy) = self.snap.attr_text("xywh").as_deref().and_then(xywh).map(|(x, y, _, _)| (x, y)).unwrap_or((0.0, 0.0));
        let (mut px, py) = (p.0 - cx, p.1 - cy);
        let w = num(&self.snap, "w");
        let flip = self.snap.attr_text("flip").as_deref() == Some("h");
        let sw = if w.is_some() || flip { Some(self.source_width().ok_or(())?) } else { None };
        if flip {
            px = sw.unwrap_or(0.0) - px;
        }
        let s = match (w, sw) {
            (Some(w), Some(sw)) if sw != 0.0 => w / sw,
            _ => 1.0,
        };
        Ok((self.x + px * s + num(&self.snap, "dx").unwrap_or(0.0), self.y + py * s + num(&self.snap, "dy").unwrap_or(0.0)))
    }
}

/// The asset a log entry, a clip or an input names, keyed by where it lives.
fn asset_key(r: &Resolver, reference: &str) -> Option<(String, Snap)> {
    let (d, id) = split_ref(reference.trim());
    match hit(r, reference) {
        Hit::Block(ix, i) if ix.snaps[i].type_name == "media-asset" => {
            let doc = d.and_then(|d| crate::host::join(&r.name, d)).unwrap_or_else(|| r.name.clone());
            Some((format!("{doc}#{id}"), ix.snaps[i].clone()))
        }
        _ => None,
    }
}

pub fn check(doc: &Document, host: Option<&dyn Host>, out: &mut Out) {
    let index = Rc::new(Index::of(doc));
    let r = Resolver::new(index.clone(), host, &doc.name);
    let name = doc.name.as_str();
    let meta_tracks = doc.meta.iter().find(|(k, _)| k == "tracks").and_then(|(_, v)| v.scalar_text());
    walk(doc, &r, &doc.children, None, meta_tracks.as_deref(), out);
    let mut comps: Vec<(String, f64, String)> = Vec::new();
    collect_comps(name, &doc.children, &mut comps);
    for (i, (shot, at, a)) in comps.iter().enumerate() {
        if comps[..i].iter().any(|(s, t, _)| s == shot && t == at) {
            out.push("media-comp-at-duplicate", E, a.clone(), format!("another comp of shot `{shot}` is already at {at}s"));
        }
    }
    lineage(doc, &r, out);
    gains_and_times(doc, &r, out);
}

/// A time as a cut or an asset writes one (§3.2): seconds, or a timecode at
/// the timeline's `fps`.
fn time_of(v: Option<&Value>, fps: Option<f64>) -> Option<f64> {
    match v? {
        Value::Number(n) => Some(*n),
        Value::String(s) if s.contains(':') => timeline::timecode(s, fps),
        Value::String(s) => {
            let t = s.trim();
            timeline::is_decimal(t.strip_prefix(['+', '-']).unwrap_or(t)).then(|| t.parse().ok()).flatten()
        }
        _ => None,
    }
}

/// §4 and §3.2: a `gain` is decibels with the unit, since it is written into
/// the player's graph and ffmpeg's filtergraph; every time is finite and at most
/// `MEDIA_MAX_TIME`, and so is where a cut ends on its timeline — a timeline is
/// drawn and built in proportion to its length.
fn gains_and_times(doc: &Document, r: &Resolver, out: &mut Out) {
    let name = doc.name.as_str();
    let past = |t: Option<f64>| t.is_some_and(|t| !(t.is_finite() && t <= MEDIA_MAX_TIME));
    let too_long = |out: &mut Out, a: String, what: &str, t: f64| {
        let said = if t.is_finite() { format!("{t} s") } else { "not finite".into() };
        out.push("media-time-out-of-range", E, a, format!("{what} is {said}; a time is at most {MEDIA_MAX_TIME} s"));
    };
    let mut blocks = Vec::new();
    crate::resolve::walk(&doc.children, &mut blocks);
    for it in &blocks {
        if let Item::Block(b) = it {
            if b.type_name == "media-asset" {
                let d = time_of(b.attr("duration"), None);
                if past(d) {
                    too_long(out, addr(name, b), "`duration`", d.unwrap_or(f64::NAN));
                }
            }
        }
    }
    let mut reported: std::collections::HashSet<String> = std::collections::HashSet::new();
    fn visit(items: &[Item], fps: Option<f64>, f: &mut dyn FnMut(&Block, Option<f64>)) {
        for it in items {
            let Item::Block(b) = it else { continue };
            let own = if b.type_name == "media" { time_of(b.attr("fps"), None) } else { fps };
            f(b, own);
            visit(&b.children, own, f);
        }
    }
    visit(&doc.children, None, &mut |b, fps| {
        if !(b.type_name == "media-clip" || (b.type_name == "media" && b.attr("src").is_some())) {
            return;
        }
        if let Some(gain) = b.attr_text("gain") {
            if !is_decibels(gain.trim()) {
                out.push("media-gain-invalid", E, addr(name, b), format!("`gain={gain}` is not decibels (write `-14dB`)"));
            }
        }
        for k in ["in", "out", "duration", "offset", "at"] {
            let t = time_of(b.attr(k), fps);
            if past(t) {
                if let Some(id) = &b.id {
                    if reported.insert(id.clone()) {
                        too_long(out, addr(name, b), &format!("`{k}`"), t.unwrap_or(f64::NAN));
                    }
                }
            }
        }
    });
    let duration_of = |reference: &str| match hit(r, reference) {
        Hit::Block(ix, i) if ix.snaps[i].type_name == "media-asset" => {
            time_of(ix.snaps[i].attrs.iter().find(|(k, _)| k == "duration").map(|(_, v)| v), None).filter(|d| d.is_finite())
        }
        _ => None,
    };
    for tl in timeline::layouts(&doc.children, &duration_of) {
        for c in tl {
            let end = c.start + c.duration;
            if past(Some(end)) && reported.insert(c.id.clone()) {
                too_long(out, format!("{name}#{}", c.id), "where the cut ends on its timeline", end);
            }
        }
    }
}

/// `-?\d+(\.\d+)?\s*dB`, the unit in any case.
fn is_decibels(g: &str) -> bool {
    let Some(n) = g.len().checked_sub(2).filter(|n| g.is_char_boundary(*n) && g[*n..].eq_ignore_ascii_case("db")).map(|n| g[..n].trim_end()) else {
        return false;
    };
    let n = n.strip_prefix('-').unwrap_or(n);
    let (int, frac) = n.split_once('.').map_or((n, None), |(a, b)| (a, Some(b)));
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    digits(int) && frac.map_or(true, digits)
}

fn collect_comps(name: &str, items: &[Item], out: &mut Vec<(String, f64, String)>) {
    for it in items {
        if let Item::Block(b) = it {
            if b.type_name == "media-comp" {
                if let Some(shot) = b.attr_text("shot") {
                    let at = match b.attr("at") {
                        Some(Value::Number(n)) => *n,
                        _ => 0.0,
                    };
                    out.push((shot, at, addr(name, b)));
                }
            }
            collect_comps(name, &b.children, out);
        }
    }
}

fn walk(doc: &Document, r: &Resolver, items: &[Item], parent: Option<&Block>, meta_tracks: Option<&str>, out: &mut Out) {
    let name = doc.name.as_str();
    for it in items {
        let Item::Block(b) = it else { continue };
        let a = addr(name, b);
        match b.type_name.as_str() {
            "media" => media_block(doc, r, b, meta_tracks, out),
            "media-clip" if !matches!(parent, Some(p) if p.type_name == "media") => {
                out.push("media-clip-unassembled", E, a.clone(), "a `media-clip` sits outside any `media` timeline")
            }
            "media-layer" if !matches!(parent, Some(p) if p.type_name == "media-comp") => {
                out.push("media-layer-unassembled", E, a.clone(), "a `media-layer` sits outside any `media-comp`")
            }
            "media-interaction" if !matches!(parent, Some(p) if p.type_name == "media-comp") => {
                out.push("media-interaction-unassembled", E, a.clone(), "a `media-interaction` sits outside any `media-comp`")
            }
            "media-asset" => asset(r, b, &a, out),
            "media-comp" => comp(r, b, name, out),
            "media-text" if b.classes.iter().any(|c| c == "line") => {
                match b.attr_text("speaker") {
                    None => out.push("media-line-no-speaker", E, a.clone(), "a `.line` names no `speaker=`"),
                    Some(s) => {
                        if matches!(hit(r, &s), Hit::Missing) {
                            out.push("media-speaker-unresolved", E, a.clone(), format!("`speaker={s}` names no block"));
                        }
                    }
                }
                if let Some(t) = b.attr_text("to") {
                    if matches!(hit(r, &t), Hit::Missing) {
                        out.push("media-speaker-unresolved", E, a.clone(), format!("`to={t}` names no block"));
                    }
                }
            }
            _ => {}
        }
        walk(doc, r, &b.children, Some(b), meta_tracks, out);
    }
}

/// The track table: name → kind, and the problems with how it is written.
fn tracks(s: &str, a: &str, out: &mut Out) -> Vec<(String, String)> {
    let mut t = Vec::new();
    for e in s.split_whitespace() {
        match e.split_once(':') {
            Some((n, k)) if !k.is_empty() => {
                if !TRACK_KINDS.contains(&k) {
                    out.push("media-track-kind-unknown", E, a.to_string(), format!("track `{n}` has kind `{k}`, which is none of video, audio, prose"));
                }
                t.push((n.to_string(), k.to_string()));
            }
            _ => {
                out.push("media-track-kind-missing", E, a.to_string(), format!("track `{e}` names no kind"));
                t.push((e.trim_end_matches(':').to_string(), String::new()));
            }
        }
    }
    t
}

/// Whether a cut over `src` needs a `duration=` it does not have.
/// Whether a cut on `target` must say how long it is (profile §4): prose and a
/// still image have no intrinsic duration. A `video` or `audio` asset always
/// has one — its file's, whether its `duration=` states it or not.
fn duration_missing(target: &Snap, cut: &Block) -> bool {
    match target.type_name.as_str() {
        "media-text" => cut.attr("duration").is_none(),
        "media-asset" => {
            let kind = asset_kind(target);
            kind == "image" && cut.attr("duration").is_none()
        }
        _ => false,
    }
}

fn media_block(doc: &Document, r: &Resolver, m: &Block, meta_tracks: Option<&str>, out: &mut Out) {
    let a = addr(&doc.name, m);
    let body = m.has_body();
    let src = m.attr_text("src");
    match (body, &src) {
        (true, Some(_)) => out.push("media-shape-ambiguous", E, a.clone(), "a `media` block has both a body and a `src=`; it is one shape or the other"),
        (false, None) => out.push("media-shape-empty", E, a.clone(), "a `media` block has neither a body nor a `src=`"),
        _ => {}
    }
    if let (false, Some(s)) = (body, &src) {
        match hit(r, s) {
            Hit::Missing | Hit::Other | Hit::Heading(..) => out.push("media-src-unresolved", E, a.clone(), format!("`src={s}` names no block")),
            Hit::Block(ix, i) if ix.snaps[i].type_name != "media-asset" => {
                out.push("media-src-not-asset", E, a.clone(), format!("`src={s}` names a `{}`, not a `media-asset`", ix.snaps[i].type_name))
            }
            // A single source plays (§2): a video, an audio or a still, not a model or an `other`.
            Hit::Block(ix, i) if !matches!(asset_kind(&ix.snaps[i]).as_str(), "video" | "audio" | "image") => {
                out.push("media-src-not-asset", E, a.clone(), format!("`src={s}` names a `{}` asset, which does not play", asset_kind(&ix.snaps[i])))
            }
            Hit::Block(ix, i) => {
                if duration_missing(&ix.snaps[i], m) {
                    out.push("media-duration-required", E, a.clone(), format!("`src={s}` has no intrinsic duration, and this source gives none"));
                }
            }
            Hit::Unknown => {}
        }
    }
    let spec = m.attr_text("tracks").or_else(|| meta_tracks.map(str::to_string));
    let table = spec.as_deref().map(|t| tracks(t, &a, out)).unwrap_or_default();
    for it in &m.children {
        let Item::Block(c) = it else { continue };
        if c.type_name != "media-clip" {
            continue;
        }
        let ca = addr(&doc.name, c);
        let kind = match c.attr_text("track") {
            None => {
                out.push("media-track-missing", E, ca.clone(), "a cut names no `track=`");
                None
            }
            Some(t) => match table.iter().find(|(n, _)| *n == t) {
                Some((_, k)) => Some(k.clone()),
                None => {
                    out.push("media-track-undeclared", W, ca.clone(), format!("track `{t}` is not declared in this timeline's `tracks=`"));
                    None
                }
            },
        };
        let Some(s) = c.attr_text("src") else {
            out.push("media-src-unresolved", E, ca.clone(), "a cut names no `src=`");
            continue;
        };
        match hit(r, &s) {
            Hit::Unknown => {}
            Hit::Missing | Hit::Other | Hit::Heading(..) => out.push("media-src-unresolved", E, ca.clone(), format!("`src={s}` names no block")),
            Hit::Block(ix, i) => {
                let t = &ix.snaps[i];
                let fits = match kind.as_deref() {
                    Some("prose") => t.type_name == "media-text",
                    Some(k @ ("video" | "audio")) => {
                        t.type_name == "media-asset" && {
                            let ak = asset_kind(t);
                            if k == "audio" {
                                ak == "audio"
                            } else {
                                ak == "video" || ak == "image"
                            }
                        }
                    }
                    _ => true,
                };
                if !fits {
                    out.push("media-src-not-asset", E, ca.clone(), format!("`src={s}` does not fit a `{}` track", kind.unwrap_or_default()));
                } else if duration_missing(t, c) {
                    out.push("media-duration-required", E, ca.clone(), format!("`src={s}` has no intrinsic duration, and this cut gives no `duration=`"));
                }
            }
        }
    }
}

/// Whether an asset's `src=` is a file this checker opens. The file goes to a
/// player and to ffmpeg, which read a scheme (`concat:`, `http:`) as an
/// instruction (§3), so it is judged as a user agent reads it, C0 controls and
/// spaces removed (GEML §9.4): no scheme, no leading `/`, no backslash.
fn relative(src: &str) -> bool {
    let read: String = src.chars().filter(|c| *c > ' ').collect();
    let scheme = read.split_once(':').is_some_and(|(s, _)| {
        let mut cs = s.chars();
        cs.next().is_some_and(|c| c.is_ascii_alphabetic()) && cs.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    !(scheme || read.starts_with('/') || read.contains('\\'))
}

/// An asset's current value (§6): the SHA-256 of the bytes its file has now,
/// in lowercase hex. `None` when the file cannot be read — it is not there, or
/// its `src=` is not a relative path — and then its lineage is not checked.
fn current_value(host: Option<&dyn Host>, home: &str, s: &Snap) -> Option<String> {
    let src = s.attr_text("src").filter(|x| !x.is_empty())?;
    if !relative(&src) {
        return None;
    }
    match crate::host::file_from(host?, home, &src)? {
        FileState::Present(h) => Some(h.to_ascii_lowercase()),
        FileState::Missing => None,
    }
}

/// A recorded hash as it compares: hex digits without regard to case (§6).
fn hex(v: Option<String>) -> Option<String> {
    v.map(|h| h.to_ascii_lowercase())
}

fn asset(r: &Resolver, b: &Block, a: &str, out: &mut Out) {
    let declared = b.attr_text("sha256");
    let Some(src) = b.attr_text("src").filter(|s| !s.is_empty()) else {
        out.push("media-src-unresolved", E, a.to_string(), "a `media-asset` carries no `src=`");
        return;
    };
    // A file this checker would not open is neither found nor hashed.
    if !relative(&src) {
        out.push(
            "media-src-not-relative",
            E,
            a.to_string(),
            format!("`{src}` is not a relative path: a scheme, a leading `/` or a backslash is not handed to a player or to ffmpeg"),
        );
    } else {
        if declared.is_none() {
            out.push(
                "media-asset-unhashed",
                W,
                a.to_string(),
                "the asset carries no `sha256`, so whether its file is the one the library describes cannot be checked",
            );
        }
        if let Some(host) = r.host {
            match crate::host::file_from(host, &r.name, &src) {
                Some(FileState::Missing) => out.push("media-file-missing", W, a.to_string(), format!("`{src}` is not there")),
                Some(FileState::Present(h)) => {
                    if let Some(d) = &declared {
                        if !h.eq_ignore_ascii_case(d) {
                            out.push("media-hash-mismatch", E, a.to_string(), format!("`{src}` hashes to {h}, and the asset declares {d}"));
                        }
                    }
                }
                None => {}
            }
        }
    }
    if let Some(of) = b.attr_text("of") {
        if matches!(hit(r, &of), Hit::Missing) {
            out.push("media-of-unresolved", E, a.to_string(), format!("`of={of}` names no block"));
        }
    }
}

/// The points a character or scene declares: `points=` on its heading, or on
/// a `.look` `media-text` it is.
fn declared_points(r: &Resolver, of: &str) -> Option<Vec<String>> {
    let names = match hit(r, of) {
        Hit::Heading(ix, h) => ix.heads[h].attrs.iter().find(|(k, _)| k == "points").and_then(|(_, v)| v.scalar_text()),
        Hit::Block(ix, i) => ix.snaps[i].attr_text("points"),
        _ => None,
    }?;
    Some(points(&names).into_iter().map(|(n, _)| n).collect())
}

fn comp(r: &Resolver, k: &Block, name: &str, out: &mut Out) {
    let a = addr(name, k);
    if k.attr_text("size").as_deref().and_then(size).is_none() {
        out.push("media-comp-size-missing", E, a.clone(), "a `media-comp` carries no `size=WxH`");
    }
    let mut layers: Vec<Layer> = Vec::new();
    for it in &k.children {
        let Item::Block(l) = it else { continue };
        if l.type_name != "media-layer" {
            continue;
        }
        let la = addr(name, l);
        let snap = Snap {
            type_name: l.type_name.clone(),
            id: l.id.clone(),
            classes: l.classes.clone(),
            attrs: l.attrs.clone(),
            table: None,
            value: None,
            line: l.line,
            has_body: l.has_body(),
            one_paragraph: false,
            raw_blank: true,
            prose: false,
            paras: vec![],
            kids: vec![],
            flow: false,
            descendants: 0,
        };
        let mut asset = None;
        match l.attr_text("src") {
            None => out.push("media-src-unresolved", E, la.clone(), "a layer names no `src=`"),
            Some(s) => match hit(r, &s) {
                Hit::Unknown => {}
                Hit::Block(ix, i) => {
                    let t = &ix.snaps[i];
                    let image = t.type_name == "media-asset"
                        && asset_kind(t) == "image";
                    if !image {
                        out.push("media-layer-not-image", E, la.clone(), format!("`src={s}` is not an image asset"));
                    } else {
                        asset = Some(t.clone());
                    }
                }
                _ => out.push("media-src-unresolved", E, la.clone(), format!("`src={s}` names no block")),
            },
        }
        let of_points = asset.as_ref().and_then(|a| a.attr_text("of")).and_then(|of| declared_points(r, &of));
        layers.push(Layer {
            id: l.id.clone().unwrap_or_default(),
            x: num(&snap, "x").unwrap_or(0.0),
            y: num(&snap, "y").unwrap_or(0.0),
            snap,
            asset,
            of_points,
            placed: None,
        });
    }
    if layers.is_empty() {
        out.push("media-comp-empty", E, a.clone(), "a `media-comp` holds no layer");
    }
    for it in &k.children {
        let Item::Block(x) = it else { continue };
        if x.type_name != "media-interaction" {
            continue;
        }
        interaction(x, name, &mut layers, out);
    }
}

fn interaction(x: &Block, name: &str, layers: &mut [Layer], out: &mut Out) {
    let ia = addr(name, x);
    let kind = x.attr_text("kind").unwrap_or_default();
    if kind != "contact" && kind != "gaze" {
        out.push("media-interaction-unresolved", E, ia.clone(), format!("`kind={kind}` is neither contact nor gaze"));
        return;
    }
    let mut ends = Vec::new();
    for key in ["a", "b"] {
        let v = x.attr_text(key).unwrap_or_default();
        let parsed = v.strip_prefix('#').and_then(|r| r.split_once(':'));
        let Some((lid, point)) = parsed else {
            out.push("media-interaction-unresolved", E, ia.clone(), format!("`{key}={v}` is not `#layer:point`"));
            return;
        };
        let Some(li) = layers.iter().position(|l| l.id == lid) else {
            out.push("media-interaction-unresolved", E, ia.clone(), format!("`{key}={v}` names no layer of this comp"));
            return;
        };
        if layers[li].asset.is_some() && layers[li].point(point).is_none() {
            out.push("media-interaction-unresolved", E, ia.clone(), format!("`{key}={v}`: the layer's asset has no point `{point}`"));
            return;
        }
        if let Some(decl) = &layers[li].of_points {
            if !decl.iter().any(|d| d == point) {
                out.push(
                    "media-interaction-point-undeclared",
                    E,
                    ia.clone(),
                    format!("`{point}` is not among the points the layer's character or scene declares"),
                );
            }
        }
        ends.push((li, point.to_string()));
    }
    let ((la, pa), (lb, pb)) = (ends[0].clone(), ends[1].clone());
    if la == lb {
        out.push("media-interaction-same-layer", E, ia.clone(), "both ends of the interaction are on one layer");
        return;
    }
    let (Some(qa), Some(qb)) = (layers[la].point(&pa), layers[lb].point(&pb)) else { return };
    // The later layer moves toward the earlier one.
    let (fixed, fp, mover, mp) = if la < lb { (la, qa, lb, qb) } else { (lb, qb, la, qa) };
    let Ok(f) = layers[fixed].on_canvas(fp) else {
        out.push(
            "media-asset-size-required",
            E,
            ia.clone(),
            "a point must be scaled or mirrored, and neither `xywh` nor the asset's `size=` gives the source width",
        );
        return;
    };
    let Ok(m) = layers[mover].on_canvas(mp) else {
        out.push(
            "media-asset-size-required",
            E,
            ia.clone(),
            "a point must be scaled or mirrored, and neither `xywh` nor the asset's `size=` gives the source width",
        );
        return;
    };
    let mv = &mut layers[mover];
    match &mv.placed {
        None => {
            let writes_x = mv.snap.attrs.iter().any(|(k, _)| k == "x");
            let writes_y = mv.snap.attrs.iter().any(|(k, _)| k == "y");
            if (kind == "contact" && (writes_x || writes_y)) || (kind == "gaze" && writes_y) {
                out.push(
                    "media-layer-position-conflict",
                    E,
                    format!("{name}#{}", mv.id),
                    format!("the layer is placed by a {kind} interaction and also writes the coordinate it sets; use `dx`/`dy`"),
                );
            }
            if kind == "contact" {
                mv.x += f.0 - m.0;
            }
            mv.y += f.1 - m.1;
            mv.placed = Some(kind);
        }
        Some(_) => {
            let d = if kind == "gaze" { (f.1 - m.1).abs() } else { ((f.0 - m.0).powi(2) + (f.1 - m.1).powi(2)).sqrt() };
            if d > MEDIA_APART_PX {
                out.push("media-interaction-apart", W, ia, format!("the two points end up {d:.1} px apart"));
            }
        }
    }
}

/// A comp's canonical text (profile §6): one line for the comp, then one per
/// layer and one per interaction in document order, each `type #id key=value …`
/// with the keys sorted; an interaction's `a=` and `b=` carry the point they
/// resolve to — `#layer:point@x,y` as the asset's `points=` gives it, `@?` when
/// it does not resolve — joined by LF.
fn comp_text(r: &Resolver, index: &Index, s: &Snap) -> String {
    let mut lines = vec![attr_line(s)];
    let mut layers: Vec<Layer> = Vec::new();
    let mut interactions: Vec<&Snap> = Vec::new();
    for kid in s.kids.iter().flatten() {
        if let Some(Found::Block(i)) = index.find(kid) {
            let k = &index.snaps[i];
            match k.type_name.as_str() {
                "media-layer" => {
                    lines.push(attr_line(k));
                    let asset = k.attr_text("src").and_then(|src| match hit(r, &src) {
                        Hit::Block(ix, j) => Some(ix.snaps[j].clone()),
                        _ => None,
                    });
                    layers.push(Layer {
                        id: kid.clone(),
                        x: num(k, "x").unwrap_or(0.0),
                        y: num(k, "y").unwrap_or(0.0),
                        snap: k.clone(),
                        asset,
                        of_points: None,
                        placed: None,
                    });
                }
                "media-interaction" => interactions.push(k),
                _ => {}
            }
        }
    }
    for x in interactions {
        let attrs: Vec<(String, String)> = x
            .attrs
            .iter()
            .map(|(k, v)| {
                let v = v.scalar_text().unwrap_or_default();
                if k != "a" && k != "b" {
                    return (k.clone(), v);
                }
                let point =
                    v.strip_prefix('#').and_then(|rest| rest.split_once(':')).and_then(|(lid, p)| layers.iter().find(|l| l.id == lid).and_then(|l| l.point(p)));
                let at = match point {
                    Some((px, py)) => format!("@{},{}", crate::num::display(px), crate::num::display(py)),
                    None => "@?".to_string(),
                };
                (k.clone(), format!("{v}{at}"))
            })
            .collect();
        lines.push(canonical_line(&x.type_name, x.id.as_deref(), &attrs));
    }
    lines.join("\n")
}

/// The hash of what a prompt sent: a comp's canonical text, or any other
/// block's text with its projections expanded.
fn prompt_hash(r: &Resolver, reference: &str) -> Option<String> {
    let (d, _) = split_ref(reference.trim());
    match hit(r, reference) {
        Hit::Block(ix, i) => {
            let s = &ix.snaps[i];
            let text = if s.type_name == "media-comp" {
                comp_text(r, &ix, s)
            } else {
                let home = match d {
                    None => r.name.clone(),
                    Some(doc) => crate::host::join(&r.name, doc).unwrap_or_default(),
                };
                let rr = Resolver::new(ix.clone(), r.host, &home);
                prompt_text(&rr, &ix, s)
            };
            Some(sha256::hex(text.as_bytes()))
        }
        _ => None,
    }
}

struct Entry {
    index: usize,
    output: Option<String>,
    output_sha: Option<String>,
    at: String,
    value: Value,
}

/// The generation log a document carries: every `.gen-log` data block's
/// entries, in order.
fn log_of(index: &Index) -> Vec<Entry> {
    let mut entries = Vec::new();
    for s in &index.snaps {
        if s.type_name != "data" || !s.classes.iter().any(|c| c == "gen-log") {
            continue;
        }
        let Some(Value::Array(log)) = &s.value else { continue };
        for e in log {
            entries.push(Entry {
                index: entries.len(),
                output: match e.get("output") {
                    Some(Value::String(o)) => Some(o.clone()),
                    _ => None,
                },
                output_sha: hex(e.get("output-sha256").and_then(|v| v.scalar_text())),
                at: e.get("at").and_then(|v| v.scalar_text()).unwrap_or_default(),
                value: e.clone(),
            });
        }
    }
    entries
}

/// Lineage across documents: each asset is judged by the log of the document
/// it lives in, with that document's references resolved from where it is.
/// A document's index and its log's entries, once read.
type Logged = Option<(Rc<Index>, Rc<Vec<Entry>>)>;

struct Lineage<'a> {
    host: Option<&'a dyn Host>,
    docs: HashMap<String, Logged>,
    memo: HashMap<String, Option<String>>,
}

impl<'a> Lineage<'a> {
    fn doc(&mut self, name: &str, r: &Resolver) -> Logged {
        if let Some(d) = self.docs.get(name) {
            return d.clone();
        }
        let ix = if name == r.name { Some(r.main.clone()) } else { r.document_at(name).ok() };
        let d = ix.map(|ix| {
            let e = Rc::new(log_of(&ix));
            (ix, e)
        });
        self.docs.insert(name.to_string(), d.clone());
        d
    }

    /// An asset's current value (§6), the asset named by its key.
    fn value(&mut self, key: &str, r: &Resolver) -> Option<String> {
        let (home, id) = key.rsplit_once('#')?;
        let (ix, _) = self.doc(home, r)?;
        match ix.find(id) {
            Some(Found::Block(i)) => current_value(self.host, home, &ix.snaps[i]),
            _ => None,
        }
    }

    /// The entry that made an asset's current bytes, in its home document:
    /// none when the asset has no current value, or no entry matches it.
    fn current(&mut self, key: &str, r: &Resolver) -> Option<(Resolver<'a>, Rc<Vec<Entry>>, usize)> {
        let sha = self.value(key, r)?;
        let (home, _) = key.rsplit_once('#')?;
        let (ix, entries) = self.doc(home, r)?;
        let rr = Resolver::new(ix.clone(), self.host, home);
        let mut best: Option<&Entry> = None;
        for e in entries.iter() {
            let Some(o) = &e.output else { continue };
            if asset_key(&rr, o).map(|(k, _)| k).as_deref() != Some(key) || e.output_sha.as_deref() != Some(sha.as_str()) {
                continue;
            }
            if best.map_or(true, |b| b.at < e.at) {
                best = Some(e);
            }
        }
        let i = best?.index;
        Some((rr, entries, i))
    }

    /// Why an asset's current entry is stale, if it is: something it read
    /// changed, or something upstream of it is stale.
    fn stale(&mut self, key: &str, r: &Resolver, depth: usize) -> Option<String> {
        if let Some(v) = self.memo.get(key) {
            return v.clone();
        }
        self.memo.insert(key.to_string(), None);
        let (rr, entries, i) = self.current(key, r)?;
        let e = &entries[i];
        let mut why: Option<String> = None;
        if let Some(Value::Array(inputs)) = e.value.get("inputs") {
            for inp in inputs {
                let (Some(rf), Some(rec)) = (inp.get("ref").and_then(|v| v.scalar_text()), hex(inp.get("sha256").and_then(|v| v.scalar_text()))) else {
                    continue;
                };
                let Some((ik, _)) = asset_key(&rr, &rf) else { continue };
                // An input with no current value does not count as changed (§6).
                if self.value(&ik, &rr).is_some_and(|now| now != rec) {
                    why = Some(format!("input {rf} changed"));
                    break;
                }
                if depth < 64 {
                    if let Some(up) = self.stale(&ik, &rr, depth + 1) {
                        why = Some(format!("{up}, which {rf} was made from"));
                        break;
                    }
                }
            }
        }
        if why.is_none() {
            if let (Some(p), Some(rec)) = (e.value.get("prompt").and_then(|v| v.scalar_text()), hex(e.value.get("prompt-sha256").and_then(|v| v.scalar_text())))
            {
                if prompt_hash(&rr, &p).is_some_and(|h| h != rec) {
                    why = Some(format!("the prompt {p} changed"));
                }
            }
        }
        if why.is_none() {
            if let Some(Value::Array(refs)) = e.value.get("prompt-refs") {
                for pr in refs {
                    let (Some(rf), Some(rec)) = (pr.get("ref").and_then(|v| v.scalar_text()), hex(pr.get("sha256").and_then(|v| v.scalar_text()))) else {
                        continue;
                    };
                    if prompt_hash(&rr, &rf).is_some_and(|h| h != rec) {
                        why = Some(format!("{rf}, which the prompt projects, changed"));
                        break;
                    }
                }
            }
        }
        self.memo.insert(key.to_string(), why.clone());
        why
    }
}

fn lineage(doc: &Document, r: &Resolver, out: &mut Out) {
    let name = doc.name.as_str();
    // The log's own shape.
    let mut all = Vec::new();
    crate::resolve::walk(&doc.children, &mut all);
    for it in &all {
        let Item::Block(b) = it else { continue };
        if b.type_name != "data" || !b.classes.iter().any(|c| c == "gen-log") {
            continue;
        }
        let a = addr(name, b);
        let Some(Value::Array(log)) = &b.value else { continue };
        for (i, e) in log.iter().enumerate() {
            let at_name = format!("{a}[{i}]");
            let field = |k: &str| e.get(k);
            let mut missing: Vec<&str> = Vec::new();
            for k in ["output", "model", "mode", "at"] {
                if field(k).is_none() {
                    missing.push(k);
                }
            }
            let output = match field("output") {
                Some(Value::String(s)) => Some(s.clone()),
                _ => None,
            };
            if output.is_some() && field("output-sha256").is_none() {
                missing.push("output-sha256");
            }
            if field("prompt").is_some() && field("prompt-sha256").is_none() {
                missing.push("prompt-sha256");
            }
            for k in missing {
                out.push("media-gen-schema", E, at_name.clone(), format!("entry {i} has no `{k}`"));
            }
            if let Some(o) = &output {
                let ok = match hit(r, o) {
                    Hit::Unknown => true,
                    Hit::Block(ix, j) => ix.snaps[j].type_name == "media-asset",
                    _ => false,
                };
                if !ok {
                    out.push("media-gen-output-not-asset", E, at_name.clone(), format!("entry {i}'s `output` `{o}` names no `media-asset`"));
                }
            }
        }
    }
    let mut lin = Lineage { host: r.host, docs: HashMap::new(), memo: HashMap::new() };
    // Each asset this document's log produced: its current entry, or none.
    let entries = log_of(&r.main);
    let mut produced: Vec<String> = Vec::new();
    for e in &entries {
        if let Some((k, _)) = e.output.as_deref().and_then(|o| asset_key(r, o)) {
            if !produced.contains(&k) {
                produced.push(k);
            }
        }
    }
    produced.sort();
    for k in &produced {
        // An asset with no current value is no orphan: its lineage is not checked (§6).
        let valued = lin.value(k, r).is_some();
        if lin.current(k, r).is_none() {
            if valued {
                out.push(
                    "media-orphan-record",
                    I,
                    k.clone(),
                    "no log entry's `output-sha256` equals the asset's current value: its bytes have no recorded provenance",
                );
            }
        } else if let Some(why) = lin.stale(k, r, 0) {
            out.push("media-stale-generation", W, k.clone(), format!("the entry that made this asset is stale: {why}"));
        }
    }
    // A cut whose source is a stale output, wherever that output's log lives.
    for it in &all {
        let Item::Block(b) = it else { continue };
        if !matches!(b.type_name.as_str(), "media-clip" | "media" | "media-layer") {
            continue;
        }
        let Some(src) = b.attr_text("src") else { continue };
        let Some((key, _)) = asset_key(r, &src) else { continue };
        if let Some(why) = lin.stale(&key, r, 0) {
            out.push("media-stale-clip", W, addr(name, b), format!("`src={src}` is a stale output: {why}"));
        }
    }
}
