//! `geml-history/v1` sidecars: the one this repository keeps for the
//! specification, and small ones built here whose every version is written out
//! by hand, so a reverse patch is checked against the content it must produce.

use std::path::PathBuf;

use geml::check::history::{content_hash, read, Sidecar};

#[test]
fn the_specification_sidecar_verifies() {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../spec/in_geml_format/GEML-spec.gemlhistory");
    let s = read(&std::fs::read_to_string(p).unwrap());
    let v = s.verify(None);
    for e in v.errors.iter().take(8) {
        eprintln!("error: {e}");
    }
    assert!(v.errors.is_empty());
    assert_eq!(v.verified, s.revisions.len());
}

fn own(lines: &[&str]) -> Vec<String> {
    lines.iter().map(|s| s.to_string()).collect()
}

/// An id-less unit's derived key.
fn k(lines: &[&str]) -> String {
    format!("@{}", &geml::sha256::hex(lines.join("\n").as_bytes())[..8])
}

struct R<'a> {
    id: &'a str,
    parent: Option<&'a str>,
    lines: &'a [&'a str],
    ops: Vec<String>,
    crlf: bool,
}

fn rev<'a>(id: &'a str, parent: Option<&'a str>, lines: &'a [&'a str], ops: &[&str]) -> R<'a> {
    R { id, parent, lines, ops: ops.iter().map(|s| s.to_string()).collect(), crlf: false }
}

fn hash(r: &R) -> String {
    content_hash(&own(r.lines), if r.crlf { "crlf" } else { "lf" })
}

fn sidecar(current: Option<&str>, revs: &[R], keyframes: &[&str], blobs: &[(&str, &[&str])]) -> String {
    let mut s = String::from("=== meta\nprofile = \"geml-history/v1\"\nhistory-of = \"doc.geml\"\n");
    if let Some(c) = current {
        s += &format!("current = \"{c}\"\n");
    }
    s += "===\n\n";
    for kf in keyframes {
        let r = revs.iter().find(|r| r.id == *kf).unwrap();
        s += &format!("==== history-keyframe {{id=\"{}\" hash=\"{}\"}}\n{}\n====\n\n", r.id, hash(r), r.lines.join("\n"));
    }
    for r in revs {
        let parent = r.parent.map(|p| format!(" parent=\"{p}\"")).unwrap_or_default();
        let nl = if r.crlf { " newline=crlf" } else { "" };
        s += &format!("=== history-revision {{id=\"{}\"{parent} hash=\"{}\"{nl}}}\n{}\n===\n\n", r.id, hash(r), r.ops.join("\n"));
    }
    for (id, lines) in blobs {
        s += &format!("==== history-blob {{#{id}}}\n{}\n====\n\n", lines.join("\n"));
    }
    s
}

const V1: &[&str] = &["# T", "", "Para one.", "", "=== note {#n}", "x", "==="];
const V2: &[&str] = &["# T", "", "Para one.", "", "=== note {#n}", "y", "===", ""];
const V3: &[&str] = &["# T", "", "Intro.", "", "Para one.", "", "=== note {#n}", "y", "===", "", "New para."];
const V4: &[&str] = &["# T", "", "Para one.", "", "Intro.", "", "=== note {#n}", "y", "===", "", "New para."];
const V5: &[&str] = &["# T", "", "Para one.", "", "=== note {#n}", "y", "===", "", "New para."];
const NOTE_X: &[&str] = &["=== note {#n}", "x", "==="];
const INTRO: &[&str] = &["Intro.", ""];

fn chain() -> Vec<R<'static>> {
    let para = k(&["Para one."]);
    let intro = k(&["Intro."]);
    let new = k(&["New para."]);
    vec![
        rev("t5-ee55", Some("t4-dd44"), V5, &[&format!("insert <- blob:b2 after {para}")]),
        rev("t4-dd44", Some("t3-cc33"), V4, &[&format!("move {intro} before {para}")]),
        rev("t3-cc33", Some("t2-bb22"), V3, &[&format!("delete {intro}"), &format!("delete {new}")]),
        R { crlf: true, ..rev("t2-bb22", Some("t1-aa11"), V2, &["replace #n <- blob:b1"]) },
        rev("t1-aa11", None, V1, &[]),
    ]
}

fn good() -> Sidecar {
    read(&sidecar(Some("t5-ee55"), &chain(), &["t5-ee55", "t2-bb22"], &[("b1", NOTE_X), ("b2", INTRO)]))
}

#[test]
fn every_reverse_patch_lands_on_the_version_written_out() {
    let s = good();
    assert!(s.declared && s.history_of.as_deref() == Some("doc.geml"));
    let v = s.verify(Some(V5.join("\n").as_bytes()));
    assert_eq!(v, geml::check::history::Verification { errors: vec![], warnings: vec![], verified: 5 });
    for (sel, want) in [("t5-ee55", V5), ("t4", V4), ("cc", V3), ("t1-aa11", V1)] {
        assert_eq!(s.reconstruct_lines(sel).unwrap(), own(want), "{sel}");
    }
    assert_eq!(s.reconstruct("t2").unwrap(), V2.join("\r\n"));
    assert_eq!(s.reconstruct("t1").unwrap(), V1.join("\n"));
    // A live file that differs is uncommitted work, not corruption.
    let v = s.verify(Some(b"edited"));
    assert!(v.errors.is_empty());
    assert_eq!(v.to_json(), r#"{"errors":[],"warnings":["the live file differs from the current revision t5-ee55 (uncommitted changes)"],"verified":5}"#);
}

#[test]
fn a_selector_names_one_revision() {
    let s = good();
    assert_eq!(s.select("t").unwrap_err(), "`t` names 5 revisions");
    assert_eq!(s.select("zz").unwrap_err(), "no revision `zz`");
    assert!(s.reconstruct("zz").is_err());
    assert_eq!(s.select("dd").unwrap().id, "t4-dd44");
}

#[test]
fn a_sidecar_with_no_current_starts_at_its_first_keyframe() {
    let revs = chain();
    let s = read(&sidecar(None, &revs[3..], &["t2-bb22"], &[("b1", NOTE_X)]));
    assert_eq!(s.verify(None).verified, 2);
    let none = read(&sidecar(None, &revs[3..], &[], &[("b1", NOTE_X)]));
    assert_eq!(none.verify(None).errors, vec!["the sidecar names no current revision"]);
    // Without any keyframe nothing is an entry point.
    let bare = read(&sidecar(Some("t2-bb22"), &revs[3..], &[], &[("b1", NOTE_X)]));
    assert_eq!(bare.verify(None).errors, vec!["no keyframe is at or newer than every revision"]);
    assert_eq!(bare.reconstruct("t1").unwrap_err(), "no keyframe at or newer than the revision");
}

#[test]
fn corruption_is_an_error() {
    let revs = chain();
    // A keyframe that does not hash, a revision whose content does not, a
    // keyframe naming no revision.
    let mut text = sidecar(Some("t2-bb22"), &revs[3..], &["t2-bb22"], &[("b1", NOTE_X)]);
    text = text.replacen("\nx\n===\n====", "\nz\n===\n====", 1).replacen("=== note {#n}\ny", "=== note {#n}\nq", 1);
    text += "==== history-keyframe {id=\"t9\" hash=\"sha256:00\"}\nx\n====\n";
    let v = read(&text).verify(None);
    assert_eq!(
        v.errors,
        vec![
            "keyframe t2-bb22 does not hash to its recorded value".to_string(),
            "keyframe t9 names no revision".to_string(),
            format!(
                "revision t2-bb22 reconstructs to {}, and records {}",
                content_hash(&own(&["# T", "", "Para one.", "", "=== note {#n}", "q", "===", ""]), "crlf"),
                hash(&revs[3])
            ),
            format!(
                "revision t1-aa11 reconstructs to {}, and records {}",
                content_hash(&own(&["# T", "", "Para one.", "", "=== note {#n}", "z", "==="]), "lf"),
                hash(&revs[4])
            ),
        ]
    );
    assert!(read(&text).reconstruct("t1").unwrap_err().starts_with("revision t1-aa11 reconstructs to"));
}

#[test]
fn a_broken_operation_names_its_revision() {
    let ops: &[(&str, &str)] = &[
        ("frob #n", "`frob #n` is not a reverse-patch operation"),
        ("delete n", "`n` is not a block key"),
        ("replace #n <- b1", "`b1` is not `blob:<id>`"),
        ("insert <- blob:b1 somewhere", "`somewhere` is not an anchor"),
        ("move #n after", "`after` is not an anchor"),
        ("replace #n <- blob:nope", "blob:nope names no history-blob"),
    ];
    for (op, why) in ops {
        let revs = [rev("t2", Some("t1"), V2, &[op]), rev("t1", None, V1, &[])];
        let v = read(&sidecar(Some("t2"), &revs, &["t2"], &[])).verify(None);
        assert_eq!(v.errors[0], format!("revision t2: {why}"), "{op}");
    }
    // An operation that parses and names nothing in the content.
    let missing: &[(&str, &str)] = &[
        ("delete #gone", "`delete #gone`: no such block"),
        ("replace @00000000 <- blob:b1", "`replace @00000000 <- blob:b1`: no such block"),
        ("move #gone at-start", "`move #gone at-start`: no such block"),
        ("move #n after #gone", "`move #n after #gone`: no block Id(\"gone\") to insert after"),
        ("insert <- blob:b1 before #gone", "`insert <- blob:b1 before #gone`: no block Id(\"gone\") to insert before"),
        ("insert <- blob:nope at-end", "blob:nope names no history-blob"),
    ];
    for (op, why) in missing {
        let revs = [rev("t2", Some("t1"), V2, &[op]), rev("t1", None, V1, &[])];
        let s = read(&sidecar(Some("t2"), &revs, &["t2"], &[("b1", NOTE_X)]));
        let v = s.verify(None);
        assert!(v.errors.contains(&format!("revision t2: {why}")), "{op}: {:?}", v.errors);
        assert_eq!(s.reconstruct("t1").unwrap_err(), format!("revision t2: {why}"));
    }
}

#[test]
fn the_heading_id_and_the_anchors_at_either_end() {
    // A unit opened by a heading with an explicit `{#id}` is addressed by it
    // (profile §4; a derived id is not a key); a unit with no blank line after
    // it carries none.
    let v2: &[&str] = &["# T {#top}", "", "Body.", "", "## Sub {#sub}", "", "More."];
    let v1: &[&str] = &["Lost.", "", "## Sub {#sub}", "", "Intro.", "", "More.", "# T {#top}", ""];
    let body = format!("delete {}", k(&["Body."]));
    let ops = [body.as_str(), "move #sub at-start", "move #top at-end", "insert <- blob:b2 after #sub", "insert <- blob:b1 at-start"];
    let revs = [rev("t2", Some("t1"), v2, &ops), rev("t1", None, v1, &[])];
    let s = read(&sidecar(Some("t2"), &revs, &["t2"], &[("b1", &["Lost.", ""]), ("b2", INTRO)]));
    assert_eq!(s.verify(None).verified, 2);
    assert_eq!(s.reconstruct_lines("t1").unwrap(), own(v1));
}

#[test]
fn a_repeated_unit_is_addressed_by_its_occurrence() {
    // Two identical paragraphs share a content key; `~1` names the second one
    // in document order (profile §4).
    let v2: &[&str] = &["Same.", "", "Same.", "", "End."];
    let v1: &[&str] = &["Same.", "", "End."];
    let op = format!("delete {}~1", k(&["Same."]));
    let revs = [rev("t2", Some("t1"), v2, &[op.as_str()]), rev("t1", None, v1, &[])];
    let s = read(&sidecar(Some("t2"), &revs, &["t2"], &[]));
    assert_eq!(s.verify(None).verified, 2);
    assert_eq!(s.reconstruct_lines("t1").unwrap(), own(v1));
}

#[test]
fn the_chain_is_checked_before_any_content() {
    // A loop, a parent that names no revision, a revision off the chain.
    let looped = [rev("a", Some("b"), V1, &[]), rev("b", Some("a"), V1, &[])];
    assert_eq!(read(&sidecar(Some("a"), &looped, &["a"], &[])).verify(None).errors, vec!["the parent chain loops"]);
    let dangling = [rev("a", Some("gone"), V1, &[])];
    assert_eq!(read(&sidecar(Some("a"), &dangling, &["a"], &[])).verify(None).errors, vec!["the chain names `gone`, and no revision carries that id"]);
    let off = [rev("a", None, V1, &[]), rev("stray", None, V1, &[])];
    let s = read(&sidecar(Some("a"), &off, &["a"], &[]));
    assert_eq!(s.verify(None).errors, vec!["revision stray is not on the parent chain from current"]);
    assert_eq!(s.reconstruct("stray").unwrap_err(), "the revision is not on the chain from current");
    // Undeclared, it still verifies, with a warning.
    let text = sidecar(Some("a"), &off[..1], &["a"], &[]).replace("profile = \"geml-history/v1\"\n", "");
    let v = read(&text).verify(None);
    assert_eq!((v.errors.len(), v.verified), (0, 1));
    assert_eq!(v.warnings, vec!["the sidecar does not declare `profile = \"geml-history/v1\"`"]);
}
