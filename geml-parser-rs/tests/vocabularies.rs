//! Reading under a vocabulary (§8.6, GEP-0013), and references resolved
//! through a host (§5.2, §9.3).

use geml::host::MapHost;
use geml::{parse, parse_with, Options};

fn codes_of(d: &geml::Document) -> Vec<String> {
    let mut v = geml::diagnostic_codes(d);
    v.sort();
    v
}

fn codes(src: &str) -> Vec<String> {
    codes_of(&parse(src))
}

const MEDIA: &str = "=== meta\nprofile = \"geml-media/v1\"\n===\n\n";

#[test]
fn a_prose_body_holds_paragraphs_and_nothing_else() {
    let d =
        parse(&format!("{MEDIA}=== media-text {{#look .look}}\n**Silver** bob.\n\n=== note {{#x}}\n# not a heading\n- not a list\n%% not a comment\n===\n"));
    assert_eq!(geml::blocks_of(&d), "meta({\"profile\":\"geml-media/v1\"}) media-text#look.look[p(strong(\"Silver\") \" bob.\") p(\"=== note {#x}\\n# not a heading\\n- not a list\\n%% not a comment\")]");
    assert_eq!(d.addresses, vec!["#meta", "#look"]);
    assert!(geml::to_json(&d).contains("\"mode\":\"prose\""));
    // A prose type is an inline-projection target, as `text` is.
    let ok = parse(&format!("{MEDIA}=== media-text {{#look}}\nOne line.\n===\n\nSee ![[#look]]."));
    assert!(codes_of(&ok).is_empty(), "{:?}", codes_of(&ok));
    let raw = parse("=== media-text {#look}\nOne line.\n===\n\nSee ![[#look]].");
    assert_eq!(codes_of(&raw), vec!["inline-transclusion-not-inline:error", "unknown-block-type:warning"]);
}

#[test]
fn admission_licenses_names_and_body_modes() {
    // A flow container's blocks are addresses only under the declaration.
    let form = "==== form {#f handler=h}\n=== form-field {#email type=text pattern=\"x\"}\n===\n====\n";
    assert_eq!(parse(&format!("=== meta\nprofile = \"geml-form/v1\"\n===\n\n{form}")).addresses, vec!["#meta", "#f", "#email"]);
    assert_eq!(parse(form).addresses, vec!["#f"]);
    // Keys admitted on a core type; an open attribute space; a defined key elsewhere.
    assert!(codes("=== meta\nprofile = \"geml-codemap/v1\"\n===\n\n=== code {anchor=x name=y entry-via=z}\nx\n===").is_empty());
    assert_eq!(codes("=== code {anchor=x}\nx\n==="), vec!["unknown-attribute:warning"]);
    assert!(codes("=== meta\nprofile = \"geml-style/v1\"\n===\n\n=== style-rule {match=note anything=1}\n===").is_empty());
    assert_eq!(codes(&format!("{MEDIA}=== media-layer {{z=1 caption=c}}\n===")), vec!["unknown-attribute:warning"]);
    // Only a name this processor does not ship is unrecognized.
    assert_eq!(codes("=== meta\nprofile = \"geml-media/v1 acme/v1\"\n===\n"), vec!["unrecognized-vocabulary:warning"]);
    let off = parse_with(MEDIA, &Options { recognize: false, ..Default::default() });
    assert_eq!(codes_of(&off), vec!["unrecognized-vocabulary:warning"]);
    assert!(off.profiles.is_empty() && off.declared == vec!["geml-media/v1"]);
}

#[test]
fn a_meta_key_in_a_vocabularys_namespace() {
    assert_eq!(codes(&format!("{MEDIA}=== meta\nmedia-fps = 24\nfps = 24\ntitle = \"t\"\n===")), vec!["unknown-meta-key:warning"]);
    // geml-style/v1 keeps its meta open; a key with no prefix is the author's.
    assert!(codes("=== meta\nprofile = \"geml-style/v1\"\nstyle-anything = 1\n===").is_empty());
    assert!(codes("=== meta\nprofile = \"geml-history/v1\"\nhistory-of = \"a.geml\"\n===").is_empty());
}

fn host(docs: &[(&str, &str)]) -> MapHost {
    let mut h = MapHost::default();
    for (k, v) in docs {
        h.files.insert(k.to_string(), v.to_string());
    }
    h
}

fn with(h: &MapHost, name: &str, src: &str) -> geml::Document {
    parse_with(src, &Options { name: name.into(), host: Some(h), ..Default::default() })
}

const LIB: &str = "=== meta\nversion = \"2\"\n===\n\n=== table {#t format=csv header=1}\nA, B\n1, 2\n===\n\n=== text {#p}\nOne phrase.\n===\n\n=== data {#d}\n{\"k\": [7]}\n===\n\n# Section {#sec}\n\nprose\n";

#[test]
fn references_across_documents_resolve_through_the_host() {
    let h = host(&[("lib.geml", LIB)]);
    let d = with(&h, "doc.geml", "[[lib.geml#t[1][\"B\"]]] [[lib.geml#meta[\"version\"]]] ![[lib.geml#p]] ![[lib.geml#d[\"k\"][0]]] [x](lib.geml#sec) [y](lib.geml)\n\n=== embed {src=lib.geml#t[1]}\n===\n\n=== embed {src=lib.geml}\n===\n\n=== data {schema=lib.geml#d}\n1\n===\n\n=== data {schema=lib.geml}\n2\n===\n");
    assert!(codes_of(&d).is_empty(), "{:?}", d.diagnostics);
    assert!(geml::project(&d).starts_with(r##"ref("lib.geml#t[1][\"B\"]" -> "2") " " ref("lib.geml#meta[\"version\"]" -> "2") " " project("lib.geml#p") " " project("lib.geml#d[\"k\"][0]" -> "7")"##));
    let bad = with(&h, "doc.geml", "[[lib.geml#nope]] [[gone.geml#x]] ![[lib.geml#sec]] [z](gone.geml)\n\n=== embed {src=\"lib.geml#t[\\\"A\\\"]\"}\n===\n\n=== embed {src=gone.geml}\n===\n\n=== data {schema=gone.geml}\n1\n===\n\n=== data {schema=lib.geml#nope}\n1\n===\n");
    assert_eq!(
        codes_of(&bad),
        vec![
            "embed-target-not-projectable:error",
            "inline-transclusion-not-inline:error",
            "unresolvable-document:error",
            "unresolvable-document:error",
            "unresolvable-document:error",
            "unresolvable-document:error",
            "unresolved-cross-document-reference:error",
            "unresolved-cross-document-reference:error",
        ]
    );
}

#[test]
fn a_view_and_a_chart_read_another_documents_relation() {
    let h = host(&[("sub/lib.geml", LIB)]);
    let d = with(
        &h,
        "sub/doc.geml",
        "=== view {#v src=lib.geml#t compute=\"C = A + B\"}\n===\n\n=== diagram {format=geml-chart data=lib.geml#t type=bar x=A y=B}\n===\n",
    );
    assert!(codes_of(&d).is_empty(), "{:?}", d.diagnostics);
    assert_eq!(geml::project(&d), r##"view(["A","B","C"] ["1","2","3"]) block:diagram"##);
    let bad = with(&h, "sub/doc.geml", "=== view {src=lib.geml#p}\n===\n\n=== view {src=lib.geml#nope}\n===\n\n=== view {src=lib.geml#sec}\n===\n\n=== diagram {format=geml-chart data=lib.geml#p type=bar x=A y=B}\n===\n\n=== diagram {format=geml-code-graph src=missing.geml}\n===\n");
    assert_eq!(
        codes_of(&bad),
        vec![
            "chart-data-not-a-table:error",
            "code-graph-unresolvable-document:warning",
            "unresolved-cross-document-reference:error",
            "view-source-not-a-relation:error",
            "view-source-not-a-relation:error",
        ]
    );
    // A host that cannot reach above its root reads nothing there.
    let up = with(&h, "doc.geml", "[[../lib.geml#t]]");
    assert_eq!(codes_of(&up), vec!["unresolvable-document:error"]);
}
