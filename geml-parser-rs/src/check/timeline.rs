//! `geml-media/v1`'s time model (§3.2): where each cut of a `media` timeline
//! starts and how long it runs. The primary track — `primary=`, else the first
//! of `tracks=` — is sequential: cut *i* starts where cut *i-1* ended, less the
//! overlap its `transition-in` declares. Every other track is anchored: a cut
//! starts at its `over=` cut's start plus `offset=`, or at `at=`. A `media`
//! with no cuts and a `src=` is one source, a timeline of one cut.

use crate::json::Value;
use crate::model::{Block, Item};

/// One cut placed on its timeline, in seconds.
pub struct Placed {
    pub id: String,
    pub start: f64,
    pub duration: f64,
}

/// A number as ECMAScript's `Number()` reads a string: decimal, `0x`/`0o`/`0b`,
/// `Infinity`; the empty string is 0. `None` where it reads `NaN`.
pub fn js_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    let radix = |p: &str, r: u32| {
        (!p.is_empty() && p.chars().all(|c| c.is_digit(r))).then(|| p.chars().fold(0.0, |v, c| v * r as f64 + c.to_digit(r).unwrap_or(0) as f64))
    };
    if let Some(p) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return radix(p, 16);
    }
    if let Some(p) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        return radix(p, 8);
    }
    if let Some(p) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        return radix(p, 2);
    }
    let unsigned = t.strip_prefix(['+', '-']).unwrap_or(t);
    if unsigned == "Infinity" {
        return Some(if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY });
    }
    is_decimal(unsigned).then(|| t.parse().ok()).flatten()
}

/// `\d+(\.\d*)?|\.\d+`, then an optional exponent: a decimal literal, unsigned.
pub fn is_decimal(s: &str) -> bool {
    let (mant, exp) = match s.find(['e', 'E']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let (int, frac) = mant.split_once('.').map_or((mant, None), |(a, b)| (a, Some(b)));
    let digits = |x: &str| x.bytes().all(|b| b.is_ascii_digit());
    let mant_ok = digits(int) && frac.map_or(true, digits) && (!int.is_empty() || frac.is_some_and(|f| !f.is_empty()));
    let exp_ok = exp.map_or(true, |e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    mant_ok && exp_ok
}

/// The fields of `hh:mm:ss[:ff]`, where `tc` is one.
fn timecode_fields(tc: &str) -> Option<[f64; 4]> {
    let parts: Vec<&str> = tc.trim().split(':').collect();
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    let ok = matches!(parts.len(), 3 | 4)
        && digits(parts[0])
        && parts[1].len() == 2
        && digits(parts[1])
        && parts[2].len() == 2
        && digits(parts[2])
        && parts.get(3).map_or(true, |f| digits(f));
    let n = |x: &str| x.parse::<f64>().unwrap_or(f64::INFINITY);
    ok.then(|| [n(parts[0]), n(parts[1]), n(parts[2]), parts.get(3).map_or(0.0, |f| n(f))])
}

/// `hh:mm:ss[:ff]` in seconds. Frames need the timeline's `fps`; without one a
/// timecode that names a frame has no value.
pub fn timecode(tc: &str, fps: Option<f64>) -> Option<f64> {
    let [h, m, s, f] = timecode_fields(tc)?;
    let fps = fps.filter(|r| *r > 0.0);
    if f != 0.0 && fps.is_none() {
        return None;
    }
    Some(h * 3600.0 + m * 60.0 + s + fps.map_or(0.0, |r| f / r))
}

/// A number attribute as the layout reads it: a timecode is no number here,
/// and what does not read as a finite number is `dflt`.
fn number(v: Option<&Value>, dflt: Option<f64>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => Some(*n),
        Some(Value::String(s)) => {
            if timecode_fields(s).is_some() {
                return None;
            }
            js_number(s).filter(|n| n.is_finite()).or(dflt)
        }
        _ => dflt,
    }
}

/// A time attribute: a timecode at `fps`, or a number.
fn time(v: Option<&Value>, fps: Option<f64>) -> Option<f64> {
    match v {
        Some(Value::String(s)) if s.contains(':') => timecode(s, fps),
        _ => number(v, None),
    }
}

/// Every timeline in `items`, each `media` block one; a `media` holds its cuts,
/// so the walk does not go into one. `duration_of` is a source's intrinsic
/// length, where one is known.
pub fn layouts(items: &[Item], duration_of: &dyn Fn(&str) -> Option<f64>) -> Vec<Vec<Placed>> {
    let mut out = Vec::new();
    for it in items {
        let Item::Block(b) = it else { continue };
        if b.type_name == "media" {
            out.push(layout_one(b, duration_of));
        } else {
            out.extend(layouts(&b.children, duration_of));
        }
    }
    out
}

/// A timeline's cuts: the direct children of its body (profile §4). A cut inside
/// another block within the body is on no timeline.
fn cuts<'a>(items: &'a [Item], out: &mut Vec<&'a Block>) {
    for it in items {
        if let Item::Block(b) = it {
            if b.type_name == "media-clip" && b.id.is_some() {
                out.push(b);
            }
        }
    }
}

fn layout_one(media: &Block, duration_of: &dyn Fn(&str) -> Option<f64>) -> Vec<Placed> {
    let fps = media.attr("fps").and_then(|v| match v {
        Value::Number(n) => Some(*n),
        v => v.scalar_text().and_then(|s| js_number(&s)),
    });
    let fps = fps.filter(|r| *r != 0.0 && !r.is_nan());
    let mut own = Vec::new();
    cuts(&media.children, &mut own);
    let text = |b: &Block, k: &str| b.attr_text(k);

    // No body and a `src=`: a single source. A body is anything but `%%` lines (§2).
    if !media.children.iter().any(|it| !matches!(it, Item::Hidden(_))) {
        if let Some(src) = text(media, "src") {
            let in_pt = time(media.attr("in"), fps).unwrap_or(0.0);
            let len = match (time(media.attr("out"), fps), number(media.attr("duration"), None), duration_of(&src)) {
                (Some(out), _, _) => (out - in_pt).max(0.0),
                (None, Some(d), _) => d,
                (None, None, Some(intrinsic)) => (intrinsic - in_pt).max(0.0),
                _ => 0.0,
            };
            return vec![Placed { id: media.id.clone().unwrap_or_default(), start: 0.0, duration: len }];
        }
    }

    let tracks: Vec<String> =
        text(media, "tracks").unwrap_or_default().split_whitespace().filter_map(|e| e.find(':').filter(|i| *i > 0).map(|i| e[..i].to_string())).collect();
    let primary = text(media, "primary").or_else(|| tracks.first().cloned()).unwrap_or_default();
    let length = |b: &Block| -> f64 {
        let speed = number(b.attr("speed"), Some(1.0)).unwrap_or(1.0);
        let speed = if speed == 0.0 { 1.0 } else { speed };
        let in_pt = time(b.attr("in"), fps).unwrap_or(0.0);
        match (time(b.attr("out"), fps), number(b.attr("duration"), None)) {
            (Some(out), _) => ((out - in_pt) / speed).max(0.0),
            (None, Some(d)) => d / speed,
            (None, None) => duration_of(&text(b, "src").unwrap_or_default()).map_or(0.0, |i| ((i - in_pt) / speed).max(0.0)),
        }
    };

    let mut placed: Vec<Placed> = Vec::new();
    let mut cursor = 0.0;
    for b in own.iter().filter(|b| text(b, "track").unwrap_or_default() == primary) {
        let len = length(b);
        let overlap = match text(b, "transition-in").as_deref() {
            Some("dissolve" | "crossfade") => number(b.attr("transition-duration"), Some(0.0)).unwrap_or(0.0),
            _ => 0.0,
        };
        let start = if placed.is_empty() { 0.0 } else { (cursor - overlap).max(0.0) };
        cursor = start + len;
        placed.push(Placed { id: b.id.clone().unwrap_or_default(), start, duration: len });
    }
    for b in own.iter().filter(|b| text(b, "track").unwrap_or_default() != primary) {
        let len = length(b);
        let start = match number(b.attr("at"), None) {
            Some(at) => at,
            None => {
                let over = text(b, "over").unwrap_or_default();
                let over = over.strip_prefix('#').unwrap_or(&over);
                let Some(anchor) = placed.iter().find(|p| p.id == over) else { continue };
                anchor.start + number(b.attr("offset"), Some(0.0)).unwrap_or(0.0)
            }
        };
        placed.push(Placed { id: b.id.clone().unwrap_or_default(), start, duration: len });
    }
    placed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_and_timecodes() {
        assert_eq!(js_number(" 0x10 "), Some(16.0));
        assert_eq!(js_number(""), Some(0.0));
        assert_eq!(js_number("1e3"), Some(1000.0));
        assert_eq!(js_number(".5"), Some(0.5));
        assert_eq!(js_number("5."), Some(5.0));
        assert_eq!(js_number("-Infinity"), Some(f64::NEG_INFINITY));
        assert_eq!(js_number("inf"), None);
        assert_eq!(js_number("1_0"), None);
        assert_eq!(js_number("-0x10"), None);
        assert_eq!(timecode("24:00:01:00", None), Some(86_401.0));
        assert_eq!(timecode("00:00:01:12", Some(24.0)), Some(1.5));
        assert_eq!(timecode("00:00:01:12", None), None);
        assert_eq!(timecode("0:0:01", None), None);
        assert!(is_decimal("1.5e-3") && !is_decimal("1e") && !is_decimal(".") && !is_decimal(""));
    }

    fn placed(src: &str) -> Vec<(String, f64, f64)> {
        let doc = crate::parse(&format!("=== meta\nprofile = \"geml-media/v1\"\n===\n{src}"));
        let intrinsic = |r: &str| (r == "#long").then_some(30.0);
        layouts(&doc.children, &intrinsic).into_iter().flatten().map(|p| (p.id, p.start, p.duration)).collect()
    }

    #[test]
    fn cuts_are_placed_as_the_time_model_says() {
        // One source: `out`, else `duration`, else the source's own length.
        assert_eq!(placed("=== media {#m src=#x in=2 out=\"00:00:05\"}\n===\n"), [("m".into(), 0.0, 3.0)]);
        assert_eq!(placed("=== media {#m src=#x duration=4}\n===\n"), [("m".into(), 0.0, 4.0)]);
        assert_eq!(placed("=== media {#m src=#long in=10}\n===\n"), [("m".into(), 0.0, 20.0)]);
        assert_eq!(placed("=== media {#m src=#x}\n===\n"), [("m".into(), 0.0, 0.0)]);
        // The primary track in order, a dissolve borrowing from the cut before;
        // `speed=0` reads as 1. Other tracks anchored, `at=` over any anchor,
        // and a cut whose anchor is no primary cut is left out.
        let src = r#"
==== media {#tl tracks="v:video a:audio" fps=25}
=== media-clip {#c1 track=v src=#x out=10}
===
=== media-clip {#c2 track=v src=#long in=0:00:01:00 transition-in=dissolve transition-duration=2 speed=0}
===
=== media-clip {#c3 track=v src=#x duration=8 speed=2}
===
=== media-clip {#s1 track=a src=#x over=#c2 offset=1 duration=3}
===
=== media-clip {#s2 track=a src=#x at=40 duration=1}
===
=== media-clip {#s3 track=a src=#x over=#nope duration=1}
===
====
"#;
        assert_eq!(
            placed(src),
            [("c1".into(), 0.0, 10.0), ("c2".into(), 8.0, 29.0), ("c3".into(), 37.0, 4.0), ("s1".into(), 9.0, 3.0), ("s2".into(), 40.0, 1.0)]
        );
    }

    #[test]
    fn a_timeline_is_its_body_and_its_cuts_are_direct_children() {
        // A cut inside another block within the body is on no timeline (profile §4).
        let nested = "===== media {#tl tracks=\"v:video\"}\n=== media-clip {#c1 track=v src=#x duration=2}\n===\n==== note {#n}\n=== media-clip {#c2 track=v src=#x duration=5}\n===\n====\n=====\n";
        assert_eq!(placed(nested), [("c1".into(), 0.0, 2.0)]);
        // A body with no cut is an assembly, `src=` or not; a `%%` line is no body (§2).
        assert_eq!(placed("==== media {#m src=#long}\nA note.\n====\n"), []);
        assert_eq!(placed("=== media {#m src=#long}\n%% a comment\n===\n"), [("m".into(), 0.0, 30.0)]);
    }
}
