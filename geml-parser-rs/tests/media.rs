//! `geml-media/v1` (§2–§8 of its profile): timelines, assets and their files,
//! lines, comps and their geometry, and the generation log's lineage across
//! documents.

use geml::host::MapHost;
use geml::{parse_with, Options};

const META: &str = "=== meta\nprofile = \"geml-media/v1\"\n===\n\n";

fn report(d: &geml::Document) -> Vec<String> {
    d.profile_diagnostics.iter().map(|x| format!("{} {} {}", x.level.as_str(), x.code, x.address)).collect()
}

fn found(src: &str) -> Vec<String> {
    report(&geml::parse(&format!("{META}{src}")))
}

fn sha(s: &str) -> String {
    geml::sha256::hex(s.as_bytes())
}

/// Each asset file of the library, and the text it holds. An asset's current
/// value is its file's hash (profile §6), so the library's hashes are the
/// hashes of these texts: `C2` in the fixture is `sha("C2")`, `card.png`'s.
const FILES: [(&str, &str); 9] = [
    ("card.png", "C2"),
    ("take.mp4", "T1"),
    ("plate.png", "P1"),
    ("key.png", "K1"),
    ("o.png", "O9"),
    ("n.png", "N1"),
    ("lr.png", "R1"),
    ("la.png", "LA"),
    ("lb.png", "LB"),
];

#[test]
fn timelines_and_their_tracks() {
    let src = r##"=== media-asset {#bg src=bg.png sha256=a1}
===

=== media-asset {#take src=take.mp4 sha256=a2}
===

=== media-asset {#vo src=vo.wav sha256=a3 duration=3}
===

=== media-asset {#lora src=style.safetensors sha256=a4}
===

=== media-asset {#notes src=notes.txt sha256=a5}
===

=== media-text {#l1 .line speaker=#hero}
Hello.
===

# Hero {#hero}

==== media {#tl tracks="v:video a:audio s:prose x:smell y"}
=== media-clip {#c1 track=v src=#bg}
===

=== media-clip {#c2 track=v src=#bg duration=2}
===

=== media-clip {#c3 track=a src=#bg duration=1}
===

=== media-clip {#c4 track=s src=#l1}
===

=== media-clip {#c5 src=#vo}
===

=== media-clip {#c6 track=z src=#vo}
===

=== media-clip {#c7 track=v}
===

=== media-clip {#c8 track=v src=#nope}
===

=== media-clip {#c9 track=v src=#take}
===

=== media-clip {#c10 track=a src=#vo}
===

=== media-clip {#c11 track=v src=#lora}
===

=== media-clip {#c12 track=y src=#notes}
===

=== media-clip {#c13 track=v src=#hero}
===

=== media-clip {#c14 track=s src=#l1 duration=2}
===

=== media-clip {#c15 track=v src=#take out=3}
===
====

=== media-clip {#loose track=v src=#bg}
===
"##;
    assert_eq!(
        found(src),
        vec![
            "error media-track-kind-unknown document.geml#tl",
            "error media-track-kind-missing document.geml#tl",
            "error media-duration-required document.geml#c1",
            "error media-src-not-asset document.geml#c3",
            "error media-duration-required document.geml#c4",
            "error media-track-missing document.geml#c5",
            "warning media-track-undeclared document.geml#c6",
            "error media-src-unresolved document.geml#c7",
            "error media-src-unresolved document.geml#c8",
            "error media-duration-required document.geml#c9",
            "error media-src-not-asset document.geml#c11",
            "error media-src-unresolved document.geml#c13",
            "error media-clip-unassembled document.geml#loose",
        ]
    );
}

#[test]
fn a_timeline_is_a_body_or_a_source() {
    let src = r##"=== meta
tracks = "v:video"
===

=== media-asset {#take src=take.mp4 sha256=a2}
===

=== media-asset {#still src=still.jpg sha256=a3}
===

=== media-text {#t}
Words.
===

# Heading {#h}

==== media {#both src=#take}
=== media-clip {track=v src=#take duration=1}
===
====

=== media {#empty}
===

=== media {#short src=#take}
===

=== media {#long src=#take duration=5}
===

=== media {#image src=#still}
===

=== media {#text src=#t}
===

=== media {#gone src=#nope}
===

=== media {#head src=#h}
===
"##;
    assert_eq!(
        found(src),
        vec![
            "error media-shape-ambiguous document.geml#both",
            "error media-shape-empty document.geml#empty",
            "error media-duration-required document.geml#short",
            "error media-duration-required document.geml#image",
            "error media-src-not-asset document.geml#text",
            "error media-src-unresolved document.geml#gone",
            "error media-src-unresolved document.geml#head",
        ]
    );
}

#[test]
fn assets_their_files_and_lines() {
    let src = r##"# Hero {#hero}

=== media-asset {#bg src=bg.png sha256=AA}
===

=== media-asset {#take src=take.mp4 sha256=BB}
===

=== media-asset {#vo src=vo.wav sha256=CC of=#nobody}
===

=== media-asset {#raw src=raw.mov of=#hero}
===

=== media-text {#a .line}
No speaker.
===

=== media-text {#b .line speaker=#nobody to=#nobody}
Nobody to nobody.
===

=== media-text {#c .line speaker=#hero to=#hero}
Fine.
===

=== media-text {#d}
Not a line.
===
"##;
    let mut h = MapHost { complete: true, ..Default::default() };
    h.hashes.insert("bg.png".into(), "aa".into());
    h.hashes.insert("take.mp4".into(), "ff".into());
    let d = parse_with(&format!("{META}{src}"), &Options { host: Some(&h), ..Default::default() });
    assert_eq!(
        report(&d),
        vec![
            "error media-hash-mismatch document.geml#take",
            "warning media-file-missing document.geml#vo",
            "error media-of-unresolved document.geml#vo",
            "warning media-asset-unhashed document.geml#raw",
            "warning media-file-missing document.geml#raw",
            "error media-line-no-speaker document.geml#a",
            "error media-speaker-unresolved document.geml#b",
            "error media-speaker-unresolved document.geml#b",
        ]
    );
    // A host that cannot look at files skips the file checks.
    assert_eq!(found(src).len(), 5);
}

const STANDS: &str = r##"# Hero {#hero points="hand"}

=== media-asset {#plate-img src=plate.png sha256=p}
===

=== media-asset {#stand-a src=a.png sha256=a points="hand:10,20 eye:5,5" of=#hero}
===

=== media-asset {#stand-b src=b.png sha256=b size=100x200 points="hand:30,40"}
===

=== media-asset {#stand-c src=c.png sha256=c points="hand:1,1"}
===

=== media-asset {#clip src=take.mp4 sha256=t}
===
"##;

#[test]
fn a_comp_places_its_layers_by_their_points() {
    let src = format!(
        r##"{STANDS}
===== media-comp {{#k1 shot=s1 size=1080x1920}}
=== media-layer {{#plate src=#plate-img}}
===

=== media-layer {{#a src=#stand-a x=100 y=200}}
===

=== media-layer {{#b src=#stand-b w=50}}
===

=== media-layer {{#c src=#stand-c flip=h}}
===

=== media-layer {{#d src=#stand-c}}
===

=== media-layer {{#e src=#stand-b x=5}}
===

=== media-layer {{#g src=#stand-b y=3}}
===

=== media-layer {{#crop src=#stand-b xywh="pixel:5,5,50,50" w=25 flip=h dx=1 dy=2}}
===

=== media-interaction {{#i1 a=#a:hand b=#b:hand kind=contact}}
===

=== media-interaction {{#i2 a=#a:eye b=#b:hand kind=gaze}}
===

=== media-interaction {{#i3 a=#a:hand b=#b:hand kind=hug}}
===

=== media-interaction {{#i4 a=hand b=#b:hand kind=contact}}
===

=== media-interaction {{#i5 a=#zz:hand b=#b:hand kind=contact}}
===

=== media-interaction {{#i6 a=#a:knee b=#b:hand kind=contact}}
===

=== media-interaction {{#i7 a=#a:hand b=#a:eye kind=contact}}
===

=== media-interaction {{#i8 a=#c:hand b=#d:hand kind=contact}}
===

=== media-interaction {{#i9 a=#a:hand b=#c:hand kind=contact}}
===

=== media-interaction {{#i10 a=#a:hand b=#e:hand kind=contact}}
===

=== media-interaction {{#i11 a=#a:hand b=#g:hand kind=gaze}}
===

=== media-interaction {{#i12 a=#a:hand b=#crop:hand kind=contact}}
===

=== media-interaction {{#i13 a=#crop:hand b=#a:hand kind=gaze}}
===
=====
"##
    );
    assert_eq!(
        found(&src),
        vec![
            "error media-interaction-point-undeclared document.geml#i2",
            "warning media-interaction-apart document.geml#i2",
            "error media-interaction-unresolved document.geml#i3",
            "error media-interaction-unresolved document.geml#i4",
            "error media-interaction-unresolved document.geml#i5",
            "error media-interaction-unresolved document.geml#i6",
            "error media-interaction-point-undeclared document.geml#i7",
            "error media-interaction-same-layer document.geml#i7",
            "error media-asset-size-required document.geml#i8",
            "error media-asset-size-required document.geml#i9",
            "error media-layer-position-conflict document.geml#e",
            "error media-layer-position-conflict document.geml#g",
        ]
    );
    // #i12 places the cropped, mirrored, scaled stand so its hand meets #a's;
    // #i13 then finds the two points level, so nothing is apart.
}

#[test]
fn a_comp_and_its_layers_are_assembled() {
    let src = format!(
        r##"{STANDS}
==== media-comp {{#k1 shot=s1}}
=== media-layer {{#v src=#clip}}
===

=== media-layer {{#none}}
===

=== media-layer {{#gone src=#nope}}
===
====

=== media-comp {{#k2 shot=s1 size=10x10}}
===

=== media-comp {{#k3 shot=s1 size=10x10 at=2}}
===

=== media-comp {{#k4 shot=s1 size=10x10 at=2}}
===

=== media-layer {{#out src=#stand-a}}
===

=== media-interaction {{#lost a=#a:hand b=#b:hand kind=contact}}
===
"##
    );
    assert_eq!(
        found(&src),
        vec![
            "error media-comp-size-missing document.geml#k1",
            "error media-layer-not-image document.geml#v",
            "error media-src-unresolved document.geml#none",
            "error media-src-unresolved document.geml#gone",
            "error media-comp-empty document.geml#k2",
            "error media-comp-empty document.geml#k3",
            "error media-comp-empty document.geml#k4",
            "error media-layer-unassembled document.geml#out",
            "error media-interaction-unassembled document.geml#lost",
            "error media-comp-at-duplicate document.geml#k2",
            "error media-comp-at-duplicate document.geml#k4",
        ]
    );
}

/// A library whose log records how each asset was made, and an episode in
/// another directory that cuts from it.
fn library(look: &str, w: u32) -> String {
    let mut text = library_with_tokens(look, w);
    // Every hash token, as an attribute value and as a JSON string.
    for t in ["C1", "C2", "T1", "P1", "K0", "K1", "O1", "O9", "N1", "R1", "LA", "LB"] {
        text = text
            .replace(&format!("sha256={t} "), &format!("sha256={} ", sha(t)))
            .replace(&format!("sha256={t}}}"), &format!("sha256={}}}", sha(t)))
            .replace(&format!("\"{t}\""), &format!("\"{}\"", sha(t)));
    }
    text
}

fn library_with_tokens(look: &str, w: u32) -> String {
    let look_hash = sha("Silver bob.");
    let prompt_hash = sha("Hero: Silver bob.");
    // The comp as the log recorded it: #l2 at w=5 is a quarter of the card's
    // 20 px, so its hand (10,20) lands at (2.5,5) and moves to meet #l1's.
    // Profile §6: the interaction line carries the points its ends resolve to,
    // as the asset's `points=` gives them.
    let comp_hash = sha("media-comp #k1 shot=s1 size=10x10\nmedia-layer #l1 src=#card\nmedia-layer #l2 src=#card w=5\nmedia-interaction #i1 a=#l1:hand@10,20 b=#l2:hand@10,20 kind=contact");
    format!(
        r##"=== meta
profile = "geml-media/v1"
===

# Hero {{#hero}}

=== media-text {{#look .look}}
{look}
===

=== media-text {{#prompt}}
Hero: ![[#look]]
===

=== media-asset {{#card src=card.png sha256=C2 size=20x40 points="hand:10,20"}}
===

=== media-asset {{#take src=take.mp4 sha256=T1 duration=4}}
===

=== media-asset {{#plate src=plate.png sha256=P1}}
===

=== media-asset {{#key src=key.png sha256=K1}}
===

=== media-asset {{#orphan src=o.png sha256=O9}}
===

=== media-asset {{#nohash src=n.png}}
===

=== media-asset {{#lookref src=lr.png sha256=R1}}
===

=== media-asset {{#loop-a src=la.png sha256=LA}}
===

=== media-asset {{#loop-b src=lb.png sha256=LB}}
===

==== media-comp {{#k1 shot=s1 size=10x10}}
=== media-layer {{#l1 src=#card}}
===

=== media-layer {{#l2 src=#card w={w}}}
===

=== media-interaction {{#i1 a=#l1:hand b=#l2:hand kind=contact}}
===
====

=== data {{#gen-log .gen-log format=jsonl}}
{{"output": "#card", "output-sha256": "C1", "model": "m", "mode": "t2i", "prompt": "#prompt", "prompt-sha256": "{prompt_hash}", "at": "2026-01-01T00:00:00Z"}}
{{"output": "#card", "output-sha256": "C2", "model": "m", "mode": "t2i", "prompt": "#prompt", "prompt-sha256": "{prompt_hash}", "prompt-refs": [{{"ref": "#look", "sha256": "{look_hash}"}}], "at": "2026-01-02T00:00:00Z"}}
{{"output": "#card", "output-sha256": "C2", "model": "m", "mode": "t2i", "at": "2026-01-01T12:00:00Z"}}
{{"output": "#take", "output-sha256": "T1", "model": "m", "mode": "i2v", "inputs": [{{"ref": "#card", "sha256": "C2"}}], "at": "2026-01-03T00:00:00Z"}}
{{"output": "#plate", "output-sha256": "P1", "model": "m", "mode": "t2i", "inputs": [{{"ref": "#key", "sha256": "K0"}}], "at": "2026-01-03T00:00:00Z"}}
{{"output": "#key", "output-sha256": "K1", "model": "m", "mode": "composite", "prompt": "#k1", "prompt-sha256": "{comp_hash}", "at": "2026-01-03T00:00:00Z"}}
{{"output": "#orphan", "output-sha256": "O1", "model": "m", "mode": "t2i", "at": "2026-01-03T00:00:00Z"}}
{{"output": "#nohash", "output-sha256": "N1", "model": "m", "mode": "t2i", "at": "2026-01-03T00:00:00Z"}}
{{"output": "#lookref", "output-sha256": "R1", "model": "m", "mode": "t2i", "prompt-refs": [{{"ref": "#look", "sha256": "{look_hash}"}}, {{"ref": "#look"}}], "at": "2026-01-03T00:00:00Z"}}
{{"output": "#loop-a", "output-sha256": "LA", "model": "m", "mode": "other", "inputs": [{{"ref": "#loop-b", "sha256": "LB"}}, {{"note": "no ref"}}], "at": "2026-01-03T00:00:00Z"}}
{{"output": "#loop-b", "output-sha256": "LB", "model": "m", "mode": "other", "inputs": [{{"ref": "#loop-a", "sha256": "LA"}}, {{"ref": "#look", "sha256": "x"}}], "at": "2026-01-03T00:00:00Z"}}
{{"output": null, "model": "m", "mode": "t2i", "at": "2026-01-03T00:00:00Z", "error": "refused"}}
===
"##
    )
}

const EPISODE: &str = r##"=== meta
profile = "geml-media/v1"
===

==== media {#tl tracks="v:video"}
=== media-clip {#c1 track=v src=../lib/library.geml#take}
===

=== media-clip {#c2 track=v src=../lib/library.geml#plate duration=1}
===

=== media-clip {#c3 track=v src=../lib/library.geml#key duration=1}
===

=== media-clip {#c4 track=v src=../gone.geml#take}
===
====
"##;

fn run(look: &str, w: u32) -> (Vec<String>, Vec<String>) {
    let mut h = MapHost::default();
    h.files.insert("lib/library.geml".into(), library(look, w));
    for (name, text) in FILES {
        h.files.insert(format!("lib/{name}"), text.into());
    }
    let lib = parse_with(&library(look, w), &Options { name: "lib/library.geml".into(), host: Some(&h), ..Default::default() });
    let ep = parse_with(EPISODE, &Options { name: "ep/cut.geml".into(), host: Some(&h), ..Default::default() });
    (report(&lib), ep.profile_diagnostics.iter().map(|x| format!("{} {} {}: {}", x.level.as_str(), x.code, x.address, x.message)).collect())
}

#[test]
fn lineage_follows_the_entry_that_made_the_current_bytes() {
    let (lib, ep) = run("Silver bob.", 5);
    assert_eq!(
        lib,
        vec![
            "warning media-asset-unhashed lib/library.geml#nohash",
            "info media-orphan-record lib/library.geml#orphan",
            "warning media-stale-generation lib/library.geml#plate"
        ]
    );
    assert_eq!(
        ep,
        vec![
            "error media-src-unresolved ep/cut.geml#c4: `src=../gone.geml#take` names no block",
            "warning media-stale-clip ep/cut.geml#c2: `src=../lib/library.geml#plate` is a stale output: input #key changed",
        ]
    );
}

#[test]
fn an_edit_upstream_makes_everything_downstream_stale() {
    let (lib, ep) = run("Silver bob, now short.", 4);
    assert_eq!(
        lib,
        vec![
            "warning media-asset-unhashed lib/library.geml#nohash",
            "warning media-stale-generation lib/library.geml#card",
            "warning media-stale-generation lib/library.geml#key",
            "warning media-stale-generation lib/library.geml#lookref",
            "info media-orphan-record lib/library.geml#orphan",
            "warning media-stale-generation lib/library.geml#plate",
            "warning media-stale-generation lib/library.geml#take",
            // A layer reads its stand as a cut reads its take.
            "warning media-stale-clip lib/library.geml#l1",
            "warning media-stale-clip lib/library.geml#l2",
        ]
    );
    assert_eq!(
        ep,
        vec![
            "error media-src-unresolved ep/cut.geml#c4: `src=../gone.geml#take` names no block",
            "warning media-stale-clip ep/cut.geml#c1: `src=../lib/library.geml#take` is a stale output: the prompt #prompt changed, which #card was made from",
            "warning media-stale-clip ep/cut.geml#c2: `src=../lib/library.geml#plate` is a stale output: input #key changed",
            "warning media-stale-clip ep/cut.geml#c3: `src=../lib/library.geml#key` is a stale output: the prompt #k1 changed",
        ]
    );
}

#[test]
fn the_log_has_a_shape() {
    let src = r##"=== media-text {#t}
Words.
===

=== data {.gen-log format=jsonl}
{"output": "#t", "output-sha256": "x", "model": "m", "mode": "t2i", "at": "2026"}
{"output": "#nope", "output-sha256": "x", "model": "m", "mode": "t2i", "at": "2026"}
{"output": "other.geml#x", "output-sha256": "x", "model": "m", "mode": "t2i", "at": "2026"}
{"output": "#t", "prompt": "#t"}
{"output": null}
===

=== data {.gen-log}
{"not": "an array"}
===
"##;
    assert_eq!(
        found(src),
        vec![
            "error media-gen-output-not-asset document.geml (line 9)[0]",
            "error media-gen-output-not-asset document.geml (line 9)[1]",
            "error media-gen-schema document.geml (line 9)[3]",
            "error media-gen-schema document.geml (line 9)[3]",
            "error media-gen-schema document.geml (line 9)[3]",
            "error media-gen-schema document.geml (line 9)[3]",
            "error media-gen-schema document.geml (line 9)[3]",
            "error media-gen-output-not-asset document.geml (line 9)[3]",
            "error media-gen-schema document.geml (line 9)[4]",
            "error media-gen-schema document.geml (line 9)[4]",
            "error media-gen-schema document.geml (line 9)[4]",
        ]
    );
}

#[test]
fn a_prompt_is_hashed_as_the_text_the_model_saw() {
    // Profile §6: markup dropped; an image, a hard break, a footnote and an
    // auto-reference without a coordinate contribute nothing; an auto-reference
    // to a coordinate its value; a projection the projected block's text — here
    // or in another document — and a coordinate projection, which projects no
    // block, nothing.
    let saw = "Em strong gone code x link   projected  Silver bob. Far text. notenext";
    let far = "Far text.";
    let src = format!(
        r##"=== meta
profile = "geml-media/v1"
===

# Hero {{#hero}}

=== data {{#d}}
{{"k": "projected"}}
===

=== media-text {{#look .look points="hand"}}
Silver bob.
===

=== media-text {{#p}}
*Em* **strong** ~~gone~~ `code` $x$ [link](#look) ![alt](i.png) [[#look]] [[#d["k"]]] ![[#d["k"]]] ![[#look]] ![[far.geml#t]] note[^n]\
next
===

=== media-text {{#said .line speaker=hero}}
A bare id is read as `#hero`.
===

=== media-asset {{#card src=card.png sha256=C1}}
===

=== media-asset {{#far-card src=fc.png sha256=F1}}
===

=== media-asset {{#stand src=s.png sha256=S1 size=10x10 points="hand:1,1" of=#look}}
===

==== media-comp {{#k shot=s size=10x10}}
=== media-layer {{#l1 src=#stand x="2" xywh=1,2,3}}
===

=== media-layer {{#l2 src=#stand w=5}}
===

=== media-interaction {{#i a=#l1:hand b=#l2:hand kind=contact}}
===
====

=== media {{#m src=#meta}}
===

=== data {{#log .gen-log format=jsonl}}
{{"output": "#card", "output-sha256": "C1", "model": "m", "mode": "t2i", "prompt": "#p", "prompt-sha256": "{}", "at": "2026"}}
{{"output": "#far-card", "output-sha256": "F1", "model": "m", "mode": "t2i", "prompt": "far.geml#t", "prompt-sha256": "{}", "at": "2026"}}
===
"##,
        sha(saw),
        sha(far)
    );
    let mut h = MapHost::default();
    h.files.insert("far.geml".into(), format!("{META}=== media-text {{#t}}\n{far}\n===\n"));
    let d = parse_with(&src, &Options { host: Some(&h), ..Default::default() });
    let got: Vec<String> = d.profile_diagnostics.iter().map(|x| format!("{} {}: {}", x.code, x.address, x.message)).collect();
    assert_eq!(got, vec!["media-src-unresolved document.geml#m: `src=#meta` names no block"]);
}

/// Round 6 (profile §6): a projection whose target is already being expanded
/// gives nothing, and every expansion counts against one budget for the whole
/// prompt. A block projecting itself three times was 3^16 expansions, and a
/// block projecting the next one four times, sixteen deep, spelled out 4^16
/// characters; both are now a few hundred expansions.
#[test]
fn a_prompt_expands_within_a_budget() {
    let t = std::time::Instant::now();
    // The asset's file is there, so it has a current value to judge (profile §6).
    let mut h = MapHost::default();
    h.files.insert("a.png".into(), "abc".into());
    let found = |src: &str| report(&parse_with(&format!("{META}{src}"), &Options { host: Some(&h), ..Default::default() }));
    let gen = |prompt: &str, blocks: &str| {
        let a = sha("abc");
        format!("{blocks}\n=== media-asset {{#a src=a.png sha256={a}}}\n===\n\n=== data {{.gen-log}}\n[{{\"output\": \"#a\", \"output-sha256\": \"{a}\", \"model\": \"m\", \"mode\": \"m\", \"at\": \"2026\", \"prompt\": \"{prompt}\", \"prompt-sha256\": \"{}\"}}]\n===\n", sha("a  b"))
    };
    assert!(!found(&gen("#p", "=== text {#p}\na ![[#p]] b\n===\n")).iter().any(|d| d.contains("stale")));
    let diamond: String = (0..16).map(|i| format!("=== text {{#p{i}}}\n{}\n===\n\n", vec![format!("![[#p{}]]", i + 1); 4].join(" "))).collect();
    let d = found(&gen("#p0", &format!("{diamond}=== text {{#p16}}\nx\n===\n")));
    assert!(d.iter().any(|d| d.contains("media-stale-generation")), "{d:?}");
    assert!(t.elapsed() < std::time::Duration::from_secs(10), "took {:?}", t.elapsed());
}
