//! `geml-codemap/v1` §5: every edge-table cell and meta `entry` reference
//! resolves, across documents through the host.

use geml::check::codemap::{verify, Dangling};
use geml::host::MapHost;
use geml::{parse_with, Options};

const MAP: &str = "=== meta\nprofile = \"geml-codemap/v1\"\nentry = \"#main b.geml#helper\"\n===\n\n=== code {#main anchor=main}\nfn main\n===\n\n=== table {#calls format=csv}\nfrom, to\n#main, b.geml#helper\n#main, #gone\n#main, b.geml#nope\n#main, c.geml#x\n#main.part, #main\nnot-a-ref, #main\n, #main\n===\n\n=== table {#api-calls format=csv}\nfrom, to\n#main, GET /x\n===\n\n=== table {#other format=csv}\nfrom, to\nanything, at all\n===\n";

fn host() -> MapHost {
    let mut h = MapHost::default();
    h.files.insert("src/b.geml".into(), "=== code {#helper anchor=helper}\nfn helper\n===\n".into());
    h
}

fn d(at: &str, reference: &str, why: &str) -> Dangling {
    Dangling { at: at.into(), reference: reference.into(), why: why.into() }
}

#[test]
fn every_reference_in_an_edge_table_resolves() {
    let h = host();
    let doc = parse_with(MAP, &Options { name: "src/a.geml".into(), host: Some(&h), ..Default::default() });
    let r = verify(&doc, Some(&h));
    assert_eq!(
        r.dangling,
        vec![
            d("#calls[6][\"from\"]", "not-a-ref", "not a reference"),
            d("#calls[2][\"to\"]", "#gone", "`#gone` names an id no block declares"),
            d("#calls[3][\"to\"]", "b.geml#nope", "`#nope` names an id no block declares"),
            d("#calls[4][\"to\"]", "c.geml#x", "the document could not be read"),
        ]
    );
    assert!(r.unchecked.is_empty() && r.problems.is_empty() && !r.ok());
}

#[test]
fn without_a_host_cross_document_edges_go_unchecked() {
    let doc = geml::parse(MAP);
    let r = verify(&doc, None);
    assert_eq!(r.unchecked, vec!["b.geml#helper", "b.geml#helper", "b.geml#nope", "c.geml#x"]);
    assert_eq!(r.dangling.len(), 2);
    assert_eq!(
        r.to_json(),
        r##"{"ok":false,"dangling":[{"at":"#calls[6][\"from\"]","reference":"not-a-ref","why":"not a reference"},{"at":"#calls[2][\"to\"]","reference":"#gone","why":"`#gone` names an id no block declares"}],"unchecked":["b.geml#helper","b.geml#helper","b.geml#nope","c.geml#x"],"problems":[]}"##
    );
}

#[test]
fn a_codemap_document_carries_one_meta_and_the_declaration() {
    let r = verify(&geml::parse("=== code {#main}\nx\n===\n"), None);
    assert_eq!(r.problems, vec!["a codemap document carries exactly one `meta` block; this one carries 0", "`profile = \"geml-codemap/v1\"` is required"]);
    let ok = verify(&geml::parse("=== meta\nprofile = \"geml-codemap/v1\"\n===\n\n=== table {#calls format=csv}\nedge\n#nope\n===\n"), None);
    assert_eq!(ok.dangling.len(), 0, "a column that holds no references is not read");
    assert!(ok.ok());
}
