//! Files a document names, read through the host (§3.2, §3.3, §6, §6.1,
//! §7.1), and transclusion chains across documents (§9.3).

use geml::host::MapHost;
use geml::{parse_with, Options};

fn host(files: &[(&str, &str)]) -> MapHost {
    let mut h = MapHost::default();
    for (k, v) in files {
        h.files.insert(k.to_string(), v.to_string());
    }
    h
}

fn read(h: &MapHost, name: &str, src: &str) -> geml::Document {
    parse_with(src, &Options { name: name.into(), host: Some(h), ..Default::default() })
}

fn codes(d: &geml::Document) -> Vec<String> {
    geml::diagnostic_codes(d)
}

fn messages(d: &geml::Document) -> Vec<String> {
    d.diagnostics.iter().map(|x| format!("{}: {}", x.code, x.message)).collect()
}

const CODE: &str = "fn one() {}\nfn two() {}\nfn three() {}\n";

#[test]
fn a_code_route_is_read_and_its_range_checked() {
    let h = host(&[("src/lib.rs", CODE), ("docs/near.rs", "x\n")]);
    let src = "=== code {src=../src/lib.rs#L2-3}\n===\n\n=== code {src=near.rs}\n===\n\n=== code {src=src/lib.rs#L1}\n===\n";
    assert!(codes(&read(&h, "docs/map.geml", src)).is_empty(), "{:?}", messages(&read(&h, "docs/map.geml", src)));
    let bad = "=== code {src=../src/lib.rs#L3-4}\n===\n\n=== code {src=gone.rs#L1}\n===\n\n=== code {src=../src/lib.rs#L9}\nkept body\n===\n\n=== code {src=\"https://x/a.rs#L99\"}\n===\n\n=== code {src=\"ftp://x/a.rs\"}\n===\n\n=== code {src=a.rs#L0}\n===\n";
    assert_eq!(
        messages(&read(&h, "docs/map.geml", bad)),
        vec![
            "bad-source-range: `src=../src/lib.rs#L3-4` names lines `../src/lib.rs` no longer has: it has 3",
            "unresolvable-code-source: `src=gone.rs#L1` could not be read, so it was not checked",
            "code-src-and-body: a code block carries both `src=` and an inline body; the body is kept",
            "bad-code-source: `src=ftp://x/a.rs` names a URL scheme a code source may not use",
            "bad-source-range: `#L0` is not `#L<start>[-<end>]` naming a non-empty range",
        ]
    );
    // Without a host a route is not read; its fragment is still checked.
    assert_eq!(codes(&geml::parse(bad)), vec!["code-src-and-body:error", "bad-code-source:error", "bad-source-range:error"]);
}

#[test]
fn a_data_route_is_the_blocks_value() {
    let h = host(&[
        ("data/log.jsonl", "{\"n\": 1}\n{\"n\": 2}\n{\"n\": 3}\n"),
        ("data/conf.yml", "name: geml\nyes: no\n"),
        ("data/one.json", "{\"k\": [7]}"),
        ("data/broken.jsonl", "{\"n\": 1}\nnot json\n"),
        ("data/raw.json", "a = 1\n"),
    ]);
    let src = "=== data {#log src=data/log.jsonl#L2-3}\n===\n\n=== data {#conf src=data/conf.yml}\n===\n\n=== data {#one src=data/one.json}\n===\n\n[[#log[0][\"n\"]]] [[#conf[\"yes\"]]] [[#one[\"k\"][0]]]\n\n=== diagram {format=geml-chart data=#log type=bar x=n y=n}\n===\n";
    let d = read(&h, "doc.geml", src);
    assert!(codes(&d).is_empty(), "{:?}", messages(&d));
    assert_eq!(
        geml::project(&d),
        r##"data([{"n":2},{"n":3}]) data({"name":"geml","yes":"no"}) data({"k":[7]}) ref("#log[0][\"n\"]" -> "2") " " ref("#conf[\"yes\"]" -> "no") " " ref("#one[\"k\"][0]" -> "7") block:diagram"##
    );
    let bad = "=== data {src=data/broken.jsonl}\n===\n\n=== data {src=data/log.jsonl#L3-5}\n===\n\n=== data {src=data/gone.json}\n===\n\n=== data {src=data/raw.json format=toml}\n===\n\n=== data {src=data/raw.json format=csv}\n===\n\n=== data {src=data/log.jsonl#L2-}\n===\n\n=== data {src=\"https://x/a.json\"}\n===\n";
    assert_eq!(
        messages(&read(&h, "doc.geml", bad)),
        vec![
            "data-parse: `data/broken.jsonl` does not parse at line 2: a line is not one JSON value: expected a value",
            "bad-source-range: `src=data/log.jsonl#L3-5` names lines `data/log.jsonl` no longer has: it has 3",
            "unresolvable-data-source: `src=data/gone.json` could not be read",
            "data-format-no-engine: `format=toml` is reserved, and this processor ships no engine for it; the body is kept raw",
            "unknown-data-format: `format=csv` is not a data format; the body is kept raw",
            "bad-source-range: `#L2-` is not `#L<start>[-<end>]` naming a non-empty range",
        ]
    );
    // A broken body names its own line in the document.
    let body = geml::parse("=== data {format=jsonl}\n{}\nnope\n===\n");
    assert_eq!((body.diagnostics[0].code, body.diagnostics[0].line), ("data-parse", 3));
    // A file's faults are the block's, every bad jsonl line of it.
    let h = host(&[("r.jsonl", "{\"a\":1}\nbad\nworse\n")]);
    let ext = read(&h, "doc.geml", "# T\n\n=== data {#d src=r.jsonl}\n===\n\nAfter.\n");
    assert_eq!(ext.diagnostics.iter().map(|d| (d.code, d.line)).collect::<Vec<_>>(), vec![("data-parse", 3), ("data-parse", 3)]);
}

#[test]
fn a_table_or_view_data_file_must_exist() {
    let h = host(&[("rows.csv", "a,b\n1,2\n")]);
    let ok = "=== table {#t src=rows.csv format=csv}\n===\n\n=== view {#v src=rows.csv}\n===\n\n=== table {src=\"https://x/rows.csv\" format=csv}\n===\n";
    assert!(codes(&read(&h, "doc.geml", ok)).is_empty(), "{:?}", messages(&read(&h, "doc.geml", ok)));
    let bad = "=== table {src=gone.csv format=csv}\n===\n\n=== view {src=gone.tsv}\n===\n\n=== table {src=\"ftp://x/rows.csv\" format=csv}\n===\n\n=== view {src=\"ftp://x/rows.csv\"}\n===\n";
    assert_eq!(
        messages(&read(&h, "doc.geml", bad)),
        // A table's file is read when its model is built, a view's when the
        // view derives, so the table's diagnostics come first.
        vec![
            "unresolvable-table-source: `src=gone.csv` could not be read",
            "unresolvable-table-source: `src=ftp://x/rows.csv` names a URL scheme a table source may not use",
            "unresolvable-table-source: `src=gone.tsv` could not be read",
            "unresolvable-table-source: `src=ftp://x/rows.csv` names a URL scheme a table source may not use",
        ]
    );
    // A refused scheme needs no host; existence does.
    assert_eq!(codes(&geml::parse(bad)), vec!["unresolvable-table-source:error", "unresolvable-table-source:error"]);
}

#[test]
fn a_chart_data_file_is_a_table_or_a_record_source() {
    // A local `.csv` is read at build time (§7.1), so its columns are checked.
    let h = host(&[
        ("rows.csv", "x,y\na,1\n"),
        ("recs.json", "[{\"x\": \"a\", \"y\": 1}, {\"x\": \"b\", \"y\": 2}]"),
        ("recs.jsonl", "{\"x\": \"a\", \"y\": \"one\"}\n"),
        ("flat.json", "{\"x\": 1}"),
        ("partial.json", "[{\"x\": \"a\"}]"),
        ("broken.jsonl", "{\n"),
    ]);
    let chart = |data: &str, y: &str| format!("=== diagram {{format=geml-chart data=\"{data}\" type=bar x=x y={y}}}\n===\n");
    let ok = [chart("rows.csv", "y"), chart("recs.json", "y"), chart("https://x/rows.csv", "y")].concat();
    assert!(codes(&read(&h, "doc.geml", &ok)).is_empty(), "{:?}", messages(&read(&h, "doc.geml", &ok)));
    let bad = [
        chart("gone.csv", "y"),
        chart("recs.json", "z"),
        chart("recs.jsonl", "y"),
        chart("flat.json", "y"),
        chart("partial.json", "y"),
        chart("broken.jsonl", "y"),
        chart("https://x/recs.json", "y"),
        chart("ftp://x/rows.csv", "y"),
        chart("rows.xml", "y"),
    ]
    .concat();
    assert_eq!(
        messages(&read(&h, "doc.geml", &bad)),
        vec![
            "unresolvable-table-source: `data=gone.csv` could not be read",
            "chart-data-not-records: record 1 lacks a scalar `z`",
            "chart-non-numeric-value: row 1 of `y` is not a number",
            "chart-data-not-records: `data=flat.json` is not a non-empty array of records",
            "chart-data-not-records: record 1 lacks a scalar `y`",
            "data-parse: `broken.jsonl` does not parse at line 1: a line is not one JSON value: expected a member name",
            "bad-data-source: `data=https://x/recs.json` is a remote record file; a remote record source is read through a `data` block, which defers",
            "unresolvable-table-source: `data=ftp://x/rows.csv` names a URL scheme a table source may not use",
            "unresolvable-table-source: `data=rows.xml` could not be read",
        ]
    );
    // A record source's rows answer `rows=` as a table's do.
    let all = "=== diagram {format=geml-chart data=recs.json type=bar x=x y=y rows=summary}\n===\n";
    assert_eq!(codes(&read(&h, "doc.geml", all)), vec!["chart-missing-summary-row:error"]);
    assert!(codes(&geml::parse(&chart("rows.csv", "y"))).is_empty());
}

fn cycles(h: &MapHost, name: &str, src: &str) -> Vec<String> {
    read(h, name, src).diagnostics.iter().filter(|d| d.code == "transclusion-cycle").map(|d| format!("{}: {}", d.line, d.message)).collect()
}

#[test]
fn a_chain_that_returns_to_a_document_is_a_cycle() {
    let h = host(&[
        ("a.geml", "=== embed {src=b.geml}\n===\n"),
        ("b.geml", "# B {#b}\n\n=== embed {src=a.geml#gone}\n===\n\n=== embed {src=a.geml}\n===\n"),
        ("sub/c.geml", "=== embed {src=../d.geml#d}\n===\n\n=== text {#c}\nC\n===\n"),
        ("d.geml", "=== text {#d}\nD ![[sub/c.geml#c]]\n===\n"),
        ("e.geml", "=== embed {src=f.geml#safe}\n===\n"),
        ("f.geml", "=== text {#safe}\nNothing comes back.\n===\n"),
    ]);
    assert_eq!(
        cycles(&h, "a.geml", "=== embed {src=b.geml}\n===\n"),
        vec!["1: expanding returns to `a.geml`, which is already being expanded: a.geml → b.geml → a.geml"]
    );
    // A chain that returns to another document already being expanded is a
    // cycle, as §9.3 counts them: by document, whatever the target there.
    assert_eq!(
        cycles(&h, "top.geml", "Intro.\n\n=== embed {src=sub/c.geml}\n===\n"),
        vec!["3: expanding returns to `sub/c.geml`, which is already being expanded: top.geml → sub/c.geml → d.geml → sub/c.geml"]
    );
    assert!(cycles(&h, "top.geml", "=== embed {src=e.geml}\n===\n\n=== embed {src=e.geml}\n===\n").is_empty());
    // A target nothing answers, an unreadable document, a coordinate and
    // another file type each end a chain: none of them expands.
    assert!(cycles(&h, "top.geml", "=== embed {src=gone.geml}\n===\n\n=== embed {src=pic.png}\n===\n\n=== embed {src=b.geml#b[1]}\n===\n").is_empty());
    assert!(cycles(&MapHost::default(), "top.geml", "=== embed {src=b.geml}\n===\n").is_empty());
    assert!(cycles(&h, "top.geml", "=== embed {src=../up.geml}\n===\n").is_empty(), "a path above the root reads nothing");
}

#[test]
fn a_target_that_takes_itself_in_is_a_cycle() {
    let h = MapHost::default();
    // Local embeds are no cycle; a block whose body embeds itself is.
    assert!(cycles(&h, "a.geml", "=== text {#t}\nT\n===\n\n=== embed {src=#t}\n===\n\n=== embed {src=#t}\n===\n").is_empty());
    assert_eq!(
        cycles(&h, "a.geml", "==== note {#n}\n=== embed {src=#n}\n===\n====\n"),
        vec!["2: expanding returns to `a.geml#n`, which is already being expanded"]
    );
    // A target nested in another block is found where it sits.
    assert_eq!(cycles(&h, "a.geml", "===== note {#outer}\n==== note {#n}\n=== embed {src=#n}\n===\n====\n=====\n").len(), 1);
    assert_eq!(cycles(&h, "a.geml", "Text.\n\n=== embed {src=a.geml}\n===\n"), vec!["3: expanding returns to `a.geml`, which is already being expanded"]);
    // A one-paragraph text that projects itself.
    assert_eq!(cycles(&h, "a.geml", "=== text {#p}\nSee ![[#p]].\n===\n"), vec!["2: expanding returns to `a.geml#p`, which is already being expanded"]);
    // `part=` narrows a section: its head holds nothing, its body may.
    let sec = |part: &str| format!("# H {{#h}}\n\nLead.\n\n=== embed {{src=#h part={part}}}\n===\n\n## Sub {{#sub}}\n\nMore.\n");
    assert!(cycles(&h, "a.geml", &sec("head")).is_empty());
    assert_eq!(cycles(&h, "a.geml", &sec("body")).len(), 1);
    assert_eq!(cycles(&h, "a.geml", &sec("intro")).len(), 1);
    assert_eq!(cycles(&h, "a.geml", &sec("whole")).len(), 1);
    let below = "# H {#h}\n\nLead.\n\n## Sub {#sub}\n\n=== embed {src=#h part=intro}\n===\n";
    assert!(cycles(&h, "a.geml", below).is_empty(), "the intro stops at the first subheading");
    // A stretch of prose that embeds nothing, and one that projects back.
    let prose = "# H {#h}\n\nOne ![[#t]].\n\n=== text {#t}\nT ![[#h-before-t]]\n===\n\n=== embed {src=#h-before-t}\n===\n";
    assert!(cycles(&h, "a.geml", prose).is_empty(), "a projection of prose cannot stand in a sentence, so it is never expanded");
    let prose_embed = "# H {#h}\n\nOne ![[#t]].\n\n==== note {#t}\n=== embed {src=#h-before-t}\n===\n====\n\n=== embed {src=#h-before-t}\n===\n";
    assert_eq!(cycles(&h, "a.geml", prose_embed), Vec::<String>::new(), "a note is not text, so `![[#t]]` does not expand it");
}

#[test]
fn every_chain_ends() {
    // Seventy documents in a row, and a diamond embedded ten levels deep.
    let mut files: Vec<(String, String)> = (0..70).map(|i| (format!("d{i}.geml"), format!("=== embed {{src=d{}.geml}}\n===\n", i + 1))).collect();
    for i in 0..10 {
        files.push((format!("m{i}.geml"), format!("=== embed {{src=m{n}.geml}}\n===\n\n=== embed {{src=m{n}.geml}}\n===\n", n = i + 1)));
    }
    let refs: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    let h = host(&refs);
    assert!(cycles(&h, "top.geml", "=== embed {src=d0.geml}\n===\n\n=== embed {src=m0.geml}\n===\n").is_empty());
}
