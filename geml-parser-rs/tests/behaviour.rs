//! What the conformance suite does not pin: every diagnostic Appendix A
//! assigns, the resource bounds of §9.2, and the edges of each rule. Each test
//! reads a document and checks the codes and the model it yields.

use geml::json::{self, Value};

fn codes(src: &str) -> Vec<String> {
    let mut v = geml::diagnostic_codes(&geml::parse(src));
    v.sort();
    v
}

fn has(src: &str, code: &str) -> bool {
    codes(src).iter().any(|c| c.split(':').next() == Some(code))
}

fn proj(src: &str) -> String {
    geml::project(&geml::parse(src))
}

fn clean(src: &str) {
    assert_eq!(codes(src), Vec::<String>::new(), "{src:?}");
}

const T: &str = "=== table {#t format=csv header=1}\nId, N, S\na, 1, x\nb, 9, y\nc, 5, z\n===\n\n";

// ---------------------------------------------------------------------------
// meta, ids, vocabularies
// ---------------------------------------------------------------------------

#[test]
fn meta_merges_and_reports() {
    let d = geml::parse("=== meta\na = 1\na = 2\nb = hello world\nc = \"open\nd\n===\n\n=== meta\na = 3\n===\n");
    let mut c = geml::diagnostic_codes(&d);
    c.sort();
    assert_eq!(c, vec!["duplicate-meta-key:warning", "duplicate-meta-key:warning"]);
    assert_eq!(d.meta[0], ("a".into(), Value::Number(1.0)));
    assert_eq!(d.meta[1].1, Value::String("hello world".into()));
    assert_eq!(d.meta[2].1, Value::String("\"open".into()));
    assert_eq!(d.meta_blocks, 2);
    assert_eq!(codes("=== meta\nprofile = \"a/v1 b/v1\"\n===\n"), vec!["unrecognized-vocabulary:warning"; 2]);
    assert_eq!(codes("=== meta\nx = 1\n===\n\n=== meta\ny = 2\n===\n\n=== note {#meta}\nz\n===\n"), vec!["reserved-id:error"]);
    clean("=== meta {#meta}\nx = 1\n===\n\nSee [[#meta[\"x\"]]].\n");
    assert_eq!(proj("=== meta\nx = 1\nok = true\n===\n\n{{x}} {{ok}}"), r##""1 true""##);
}

#[test]
fn ids_collide_across_kinds() {
    assert_eq!(codes("## Alpha\n\n=== note {#alpha}\nx\n==="), vec!["duplicate-id:error"]);
    let d = geml::parse("=== note {#a}\nx\n===\n\n=== note {#a}\ny\n===\n");
    assert_eq!(d.ids, vec!["a"]);
    assert_eq!(geml::diagnostic_codes(&d), vec!["duplicate-id:error"]);
}

// ---------------------------------------------------------------------------
// references and coordinates
// ---------------------------------------------------------------------------

#[test]
fn references_resolve_or_say_why() {
    assert_eq!(codes("See [[#nope]]."), vec!["unresolved-reference:error"]);
    assert_eq!(codes("See [x](#nope)."), vec!["unresolved-reference:error"]);
    assert_eq!(codes("See [x](#a b)."), vec!["unresolved-reference:error"]);
    assert_eq!(codes(&format!("{T}See [x](#t[9]).")), vec!["unresolved-reference:error"]);
    clean(&format!("{T}See [x](#t[1]) and [y](#t) and [z](page.html) and [w](https://x.test)."));
    assert_eq!(codes("See [x](other.geml#a) and [[other.geml#b]] and ![[other.geml#c]]."), vec!["unchecked-cross-document-reference:warning"; 3]);
    clean("See [[notes.md#a]] and [x](notes.md#a).");
    assert_eq!(codes("A note[^n] and[^gone].\n\n=== note {#n}\nN\n==="), vec!["unresolved-footnote:error"]);
    assert_eq!(codes("![x](other.geml#a)"), vec!["media-target-is-document:error"]);
    assert_eq!(codes("{{nope}}"), vec!["unknown-metadata-reference:error"]);
}

#[test]
fn coordinates_on_every_kind_of_block() {
    let data = "=== data {#d}\n{\"a\": [1, {\"b\": null}], \"s\": \"x\"}\n===\n\n";
    assert_eq!(
        proj(&format!("{data}[[#d[\"a\"][1][\"b\"]]] [[#d[\"s\"]]] [[#d[\"a\"]]]")),
        r##"data({"a":[1,{"b":null}],"s":"x"}) ref("#d[\"a\"][1][\"b\"]" -> "null") " " ref("#d[\"s\"]" -> "x") " " ref("#d[\"a\"]")"##
    );
    for bad in ["[[#d[\"a\"][5]]]", "[[#d[\"zz\"]]]", "[[#d[summary]]]", "[[#d[\"s\"][0]]]"] {
        assert_eq!(codes(&format!("{data}{bad}")), vec!["unresolved-reference:error"], "{bad}");
    }
    // A block whose units arrive at render time, or did not parse, is not checked.
    clean("=== table {#e src=rows.csv}\n===\n\n[[#e[3][\"x\"]]]");
    assert_eq!(codes("=== data {#b}\n{,}\n===\n\n[[#b[\"x\"]]]"), vec!["data-parse:error"]);
    // Headings, prose, embeds and other blocks hold no units.
    assert_eq!(codes("# H {#h}\n\n[[#h[1]]]"), vec!["unresolved-reference:error"]);
    assert_eq!(codes("=== code {#c}\nx\n===\n\n[[#c[1]]]"), vec!["unresolved-reference:error"]);
    let d = geml::parse("=== embed {#e src=a.geml#t}\n===\n\n[[#e[1][\"x\"]]]");
    assert!(d.diagnostics.iter().any(|x| x.code == "unresolved-reference" && x.message.contains("a.geml#t")));
    assert_eq!(codes("=== note {#a}\nx\n===\n\np\n\n=== note {#b}\ny\n===\n\n[[#a-between-b[1]]]"), vec!["unresolved-reference:error"]);
    // #meta reads by key; a scalar has nothing under it.
    assert_eq!(codes("=== meta\nv = 1\n===\n\n[[#meta[1]]] [[#meta[\"w\"]]] [[#meta[\"v\"][0]]]"), vec!["unresolved-reference:error"; 3]);
    // Tables: rows, cells, summary, columns.
    assert_eq!(
        codes(&format!("{T}[[#t[0]]] [[#t[1][\"Q\"]]] [[#t[9][\"N\"]]] [[#t[summary]]] [[#t[summary][\"N\"]]] [[#t[\"N\"][1]]]")),
        vec!["unresolved-reference:error"; 6]
    );
    let v = "=== view {#v src=#t summary=\"N = sum(N)\"}\n===\n\n";
    assert!(proj(&format!("{T}{v}[[#v[summary]]]")).ends_with(r##"ref("#v[summary]" -> ", 15, ")"##));
    assert_eq!(codes(&format!("{T}{v}[[#v[summary][\"Q\"]]]")), vec!["unresolved-reference:error"]);
}

#[test]
fn inline_projections_hold_one_value_or_one_paragraph() {
    let text1 = "=== text {#p}\nOne *phrase*.\n===\n\n";
    clean(&format!("{text1}Say ![[#p]]."));
    assert_eq!(codes("=== text {#p}\nOne.\n\nTwo.\n===\n\nSay ![[#p]]."), vec!["inline-transclusion-not-inline:error"]);
    assert_eq!(codes("# H {#h}\n\nSay ![[#h]]."), vec!["inline-transclusion-not-inline:error"]);
    assert_eq!(codes(&format!("{T}Say ![[#t[\"N\"]]].")), vec!["inline-transclusion-not-inline:error"]);
    assert_eq!(proj(&format!("{T}Say ![[#t[2]]].")).rsplit(" \"Say \" ").next().unwrap(), r##"project("#t[2]" -> "b, 9, y") ".""##);
    assert_eq!(codes("Say ![[#nope]]."), vec!["unresolved-reference:error"]);
    assert_eq!(codes(&format!("{T}Say ![[#t[7]]].")), vec!["unresolved-reference:error"]);
}

// ---------------------------------------------------------------------------
// embed, data, code, diagrams
// ---------------------------------------------------------------------------

#[test]
fn embeds() {
    assert_eq!(codes("=== embed\n==="), vec!["embed-missing-src:error"]);
    assert_eq!(codes("=== embed {src=x.geml}\nbody\n==="), vec!["ignored-embed-body:warning", "unchecked-cross-document-reference:warning"]);
    assert_eq!(codes("=== embed {src=x.geml#a part=sideways}\n==="), vec!["bad-embed-part:warning", "unchecked-cross-document-reference:warning"]);
    clean("# H {#h}\n\n=== embed {src=#h part=head}\n===");
    assert_eq!(codes("=== embed {src=#nope}\n==="), vec!["unresolved-reference:error"]);
    assert_eq!(codes("=== embed {src=\"#a b\"}\n==="), vec!["unresolved-reference:error"]);
    assert_eq!(codes(&format!("{T}=== embed {{src=\"#t[\\\"N\\\"]\"}}\n===")), vec!["embed-target-not-projectable:error"]);
    assert_eq!(codes("=== data {#d}\n{\"a\": [1]}\n===\n\n=== embed {src=\"#d[\\\"a\\\"]\"}\n==="), vec!["embed-target-not-projectable:error"]);
    // A bare value keeps its quotes (§4 step 3): the fence opens, and names no `#d`.
    assert_eq!(codes("=== embed {src=#d[\"a\"]}\n==="), vec!["unresolved-reference:error"]);
    clean(&format!("{T}=== embed {{src=#t[1]}}\n==="));
    assert_eq!(codes(&format!("{T}=== embed {{src=#t[9]}}\n===")), vec!["unresolved-reference:error"]);
    assert_eq!(codes("=== embed {src=notes.md#a}\n==="), vec!["embed-target-not-geml:error"]);
    let d = geml::parse("=== embed {src=\"java\tscript:x\"}\n===");
    assert_eq!(geml::diagnostic_codes(&d), vec!["unsafe-embed-scheme:error"]);
    assert_eq!(geml::project(&d), r##"embed("")"##);
    assert_eq!(proj("=== embed {src=5}\n==="), r##"embed("")"##);
}

#[test]
fn data_blocks() {
    assert_eq!(codes("=== data {src=a.json}\n{}\n==="), vec!["data-src-and-body:error"]);
    assert_eq!(codes("=== data {src=a.txt}\n==="), vec!["bad-data-source:error"]);
    assert_eq!(codes("=== data {src=\"ftp://x/a.json\"}\n==="), vec!["unresolvable-data-source:error"]);
    clean("=== data {src=\"https://x/a.json\"}\n===\n\n=== data {src=log.jsonl#L2-9}\n===");
    assert_eq!(codes("=== data {format=edn}\n{}\n==="), vec!["data-format-no-engine:warning"]);
    assert_eq!(codes("=== data {format=xml}\n<a/>\n==="), vec!["unknown-data-format:warning"]);
    assert_eq!(codes("=== data {format=jsonl}\n1\nnope\n==="), vec!["data-parse:error"]);
    assert_eq!(codes("=== data\n==="), vec!["data-parse:error"]);
    let d = geml::parse("=== data {format=yaml}\na: [1]\n===");
    assert_eq!((d.diagnostics[0].code, d.diagnostics[0].line), ("data-parse", 2));
    assert_eq!(codes("=== data {schema=x}\n1\n==="), vec!["bad-data-schema:error"]);
    assert_eq!(codes("=== data {schema=#nope}\n1\n==="), vec!["unresolved-reference:error"]);
    clean("=== data {#s}\n{}\n===\n\n=== data {schema=#s}\n3\n===");
    // A schema in another document is reference-checked like any other: unchecked without a host.
    assert_eq!(codes("=== data {schema=s.geml}\n1\n===\n\n=== data {schema=s.geml#x}\n2\n==="), vec!["unchecked-cross-document-reference:warning"; 2]);
    assert_eq!(codes("=== data {schema=\"#a b\"}\n1\n==="), vec!["bad-data-schema:error"]);
}

#[test]
fn code_routes() {
    assert_eq!(codes("=== code {src=a.rs}\nx\n==="), vec!["code-src-and-body:error"]);
    assert_eq!(codes("=== code {src=\"javascript:x\"}\n==="), vec!["bad-code-source:error"]);
    assert_eq!(codes("=== code {src=a.rs#L5-3}\n==="), vec!["bad-source-range:error"]);
    clean("=== code {src=a.rs#L1-2 lang=rust}\n===\n\n=== code {src=\"https://x/a.rs\"}\n===\n\n=== code {src=a.rs}\n===");
}

#[test]
fn diagrams_and_charts() {
    assert_eq!(codes("=== diagram {format=acme}\nx\n==="), vec!["unknown-diagram-format:warning"]);
    assert_eq!(codes("=== diagram\nx\n==="), vec!["unknown-diagram-format:warning"]);
    clean("=== diagram {format=mermaid}\ngraph LR\n===");
    assert_eq!(codes("=== diagram {format=geml-code-graph}\nbody\n==="), vec!["code-graph-missing-src:warning", "ignored-diagram-body:warning"]);
    clean("=== diagram {format=geml-code-graph src=g.geml}\n===");
    let chart = |attrs: &str| codes(&format!("{T}=== diagram {{format=geml-chart {attrs}}}\n==="));
    assert_eq!(chart("data=#t type=bar x=Id y=N"), Vec::<String>::new());
    assert_eq!(chart("data=#t x=Id y=N"), vec!["chart-missing-type:error"]);
    assert_eq!(chart("data=#t type=donut x=Id y=N"), vec!["chart-unknown-type:error"]);
    assert_eq!(chart("data=#t type=bar x=Id y=N rows=some"), vec!["chart-unknown-rows-scope:error"]);
    assert_eq!(chart("data=#t type=bar"), vec!["chart-missing-channel:error", "chart-missing-channel:error"]);
    assert_eq!(chart("data=#t type=bar x=Id y=\",\""), vec!["chart-empty-channel:error"]);
    assert_eq!(chart("data=#t type=bar x=Id y=N size=N"), vec!["chart-unused-channel:warning"]);
    assert_eq!(chart("type=bar x=Id y=N"), vec!["chart-missing-data:error"]);
    assert_eq!(chart("data=#nope type=bar x=Id y=N"), vec!["unresolved-reference:error"]);
    assert_eq!(chart("data=rows.csv type=bar x=Id y=N"), Vec::<String>::new());
    assert_eq!(chart("data=#t type=bar x=Id y=Q"), vec!["chart-unknown-column:error"]);
    assert_eq!(chart("data=#t type=bar x=Id y=N rows=summary"), vec!["chart-missing-summary-row:error"]);
    assert_eq!(chart("data=#t type=bar x=Id y=N rows=all"), vec!["chart-summary-row-unavailable:warning"]);
    assert_eq!(chart("data=#t type=bar x=N y=S"), vec!["chart-non-numeric-value:error"]);
    assert_eq!(codes("=== note {#n}\nx\n===\n\n=== diagram {format=geml-chart data=#n type=bar x=a y=b}\n==="), vec!["chart-data-not-a-table:error"]);
    assert_eq!(codes("# H {#h}\n\n=== diagram {format=geml-chart data=#h type=bar x=a y=b}\n==="), vec!["chart-data-not-a-table:error"]);
    let recs = "=== data {#r}\n[{\"k\": \"a\", \"v\": 1}, {\"k\": \"b\", \"v\": 2, \"w\": [1]}]\n===\n\n";
    clean(&format!("{recs}=== diagram {{format=geml-chart data=#r type=line x=k y=v}}\n==="));
    assert_eq!(codes(&format!("{recs}=== diagram {{format=geml-chart data=#r type=line x=k y=w}}\n===")), vec!["chart-data-not-records:error"]);
    assert_eq!(codes("=== data {#r}\n[1, 2]\n===\n\n=== diagram {format=geml-chart data=#r type=line x=k y=v}\n==="), vec!["chart-data-not-records:error"]);
    assert_eq!(codes("=== data {#r}\n{,}\n===\n\n=== diagram {format=geml-chart data=#r type=line x=k y=v}\n==="), vec!["data-parse:error"]);
    assert_eq!(codes(&format!("{T}=== diagram {{format=geml-chart data=#t type=bar x=Id y=N}}\nbody\n===")), vec!["ignored-diagram-body:warning"]);
}

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------

#[test]
fn table_forms_and_their_errors() {
    assert_eq!(codes("=== table {src=a.csv format=csv}\na\n==="), vec!["table-src-and-body:error"]);
    assert_eq!(codes("=== table {src=#x}\n==="), vec!["table-source-is-block:error"]);
    assert_eq!(codes("=== table {format=xml}\n| a |\n==="), vec!["unknown-table-format:warning"]);
    assert_eq!(codes("=== table {delim=\";\"}\n| a |\n==="), vec!["ignored-table-delimiter:warning"]);
    let d = geml::parse("=== table {#t format=csv delim=ab header=1}\nA,B\n1,2\n===");
    assert_eq!(geml::diagnostic_codes(&d), vec!["bad-table-delimiter:error"]);
    assert_eq!(geml::project(&d), r##"table(["A","B"] ["1","2"])"##);
    assert_eq!(proj("=== table {format=tsv header=true}\nA\tB\n1\t2\n==="), r##"table(["A","B"] ["1","2"])"##);
    // A data form's first row is its header unless `header=0` says otherwise.
    assert_eq!(proj("=== table {format=csv}\nA,B\n1,2\n==="), r##"table(["A","B"] ["1","2"])"##);
    assert_eq!(proj("=== table {format=csv header=0}\n1,2\n==="), r##"table(["A","B"] ["1","2"])"##);
    assert_eq!(proj("=== table\n| a | b |\n| c | d |\n==="), r##"table(["A","B"] ["a","b"] ["c","d"])"##);
    assert_eq!(proj("=== table\n| H |\n| x |\n|---|\n| y |\n|---|\n==="), r##"table(["H"] ["x"] ["y"])"##);
    assert_eq!(proj("=== table\n===\n"), "table([])");
    assert_eq!(proj("=== table {src=rows.csv}\n==="), "block:table");
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

fn view(attrs: &str) -> (String, Vec<String>) {
    let d = geml::parse(&format!("{T}=== view {{#v src=#t {attrs}}}\n===\n"));
    let p = geml::project(&d);
    let mut c = geml::diagnostic_codes(&d);
    c.sort();
    (p.split(" view(").nth(1).map(|s| format!("view({s}")).unwrap_or(p), c)
}

#[test]
fn view_sources() {
    assert_eq!(codes("=== view\n==="), vec!["view-missing-src:error"]);
    assert_eq!(codes(&format!("{T}=== view {{src=#t}}\nbody\n===")), vec!["view-src-and-body:error"]);
    assert_eq!(codes("=== view {src=#nope}\n==="), vec!["unresolved-reference:error"]);
    assert_eq!(codes("=== note {#n}\nx\n===\n\n=== view {src=#n}\n==="), vec!["view-source-not-a-relation:error"]);
    assert_eq!(codes("# H {#h}\n\n=== view {src=#h}\n==="), vec!["view-source-not-a-relation:error"]);
    assert_eq!(codes("=== view {src=o.geml#t}\n==="), vec!["unchecked-cross-document-reference:warning"]);
    assert_eq!(proj("=== view {src=rows.csv}\n==="), "block:view");
    // Each view in the cycle is reported (Appendix A), and is empty (§6.1).
    let cyc = geml::parse("=== view {#a src=#b}\n===\n\n=== view {#b src=#a}\n===\n");
    assert_eq!(geml::diagnostic_codes(&cyc), vec!["view-source-cycle:error", "view-source-cycle:error"]);
    assert_eq!(geml::project(&cyc), "view([]) view([])");
    assert!(cyc.diagnostics[0].message.contains("#a") && cyc.diagnostics[0].message.contains("#b"));
    let mut deep = String::from(T);
    deep.push_str("=== view {#v0 src=#t}\n===\n\n");
    for i in 1..80 {
        deep.push_str(&format!("=== view {{#v{i} src=#v{}}}\n===\n\n", i - 1));
    }
    assert!(has(&deep, "view-source-too-deep"));
    // A chain inside the bound publishes the rows.
    assert_eq!(
        proj(&format!("{T}=== view {{#a src=#t where=\"N > 1\"}}\n===\n\n=== view {{#b src=#a order=\"N desc\"}}\n===\n")).rsplit(" view(").next().unwrap(),
        r##"["Id","N","S"] ["b","9","y"] ["c","5","z"])"##
    );
}

#[test]
fn view_compute() {
    assert_eq!(view("compute=\"no formula\"").1, vec!["bad-compute-formula:error"]);
    assert_eq!(view("compute=\"X = (N\"").1, vec!["compute-error:error"]);
    assert_eq!(view("compute=\"X = Q + 1\"").1, vec!["compute-error:error"]);
    assert_eq!(view("compute=\"X = Y; Y = N\"").1, vec!["compute-error:error"]);
    let (p, c) = view("compute=\"X = S + 1\"");
    assert_eq!(c, vec!["compute-non-numeric-cell:warning"; 3]);
    assert!(p.contains(r##"["a","1","x","1"]"##));
    let (p, c) = view("compute=\"X = N / 0; Z = 0 / 0\"");
    assert_eq!(c, vec!["compute-not-a-number:warning"; 6]);
    assert!(p.contains(r##"["a","1","x","-","-"]"##));
    let (p, c) = view("compute=\"N = N * 2\"");
    assert_eq!(c, vec!["shadowed-source-column:warning"]);
    assert!(p.contains(r##"["Id","N","S"] ["a","2","x"]"##));
    // An aggregate formula's dependents run in the second pass too.
    let (p, c) = view("compute=\"T = sum(N); U = N / T\" where=\"N > 1\"");
    assert!(c.is_empty(), "{c:?}");
    assert!(p.contains(r##"["b","9","y","14","0.642857142857"]"##), "{p}");
    assert_eq!(view("compute=\"T = sum(N)\" where=\"T > 1\"").1, vec!["circular-view-filter:error"]);
    assert_eq!(view("compute=\"T = sum(N)\" by=\"S\"").1, vec!["grouping-compute-aggregate:error"]);
    assert_eq!(view("compute=\"X = B * 10\"").0.split(' ').nth(1).unwrap(), r##"["a","1","x","10"]"##);
}

#[test]
fn view_where_order_limit_select() {
    assert_eq!(view("where=\"N >\"").1, vec!["view-where-error:error"]);
    assert_eq!(view("where=\"Q > 1\"").1, vec!["view-where-error:error"]);
    assert_eq!(view("where=\"S > 1\"").1, vec!["view-numeric-column-required:error"]);
    assert!(view("where=\"S = 'y' or S >= 'z'\"").0.contains(r##"["b","9","y"] ["c","5","z"]"##));
    // The direction is a last `asc` or `desc`; `N sideways` is a column name (§6.1).
    assert_eq!(view("order=\"N sideways\"").1, vec!["view-unknown-column:error"]);
    assert_eq!(view("order=\"'' desc\"").1, vec!["view-order-error:error"]);
    assert_eq!(view("order=\"Q\"").1, vec!["view-unknown-column:error"]);
    assert!(view("order=\"N desc\"").0.starts_with(r##"view(["Id","N","S"] ["b","9","y"] ["c","5","z"]"##));
    assert!(view("order=\"'S' desc\"").0.starts_with(r##"view(["Id","N","S"] ["c","5","z"]"##));
    for bad in ["limit=-1", "limit=1.5", "limit=x", "limit=true"] {
        assert_eq!(view(bad).1, vec!["view-limit-error:error"], "{bad}");
    }
    assert!(view("limit=\"1\"").0.ends_with(r##"["a","1","x"])"##));
    assert_eq!(view("select=\"X = N\"").1, vec!["view-select-expression:error"]);
    assert_eq!(view("select=\"Q, Id\"").1, vec!["view-unknown-column:error"]);
}

#[test]
fn view_groups() {
    assert_eq!(view("by=\"Q\"").1, vec!["view-unknown-column:error"]);
    assert_eq!(view("aggregate=\"C = count(N)\"").1, vec!["aggregate-without-by:error"]);
    assert_eq!(view("by=\"S\" aggregate=\"nonsense\"").1, vec!["bad-aggregate-entry:error"]);
    assert_eq!(view("by=\"S\" aggregate=\"C = count(\"").1, vec!["bad-aggregate-entry:error"]);
    assert_eq!(view("by=\"S\" aggregate=\"C = count(Q)\"").1, vec!["view-unknown-column:error"]);
    assert_eq!(view("by=\"S\" aggregate=\"C = N\"").1, vec!["aggregate-error:error"]);
    assert_eq!(view("by=\"S\" aggregate=\"C = avg(Id)\"").1, vec!["compute-not-a-number:warning"; 3]);
    let (p, c) = view("by=\"S\" aggregate=\"Top [%.1f] = max(N); Low = min(N); Mean = avg(N)\"");
    assert!(c.is_empty());
    assert!(p.contains(r##"["S","Top","Low","Mean"] ["x","1.0","1","1"]"##), "{p}");
}

#[test]
fn view_summary() {
    assert_eq!(view("summary=\"nonsense\"").1, vec!["bad-summary-entry:error"]);
    assert_eq!(view("summary=\"Q = sum(N)\"").1, vec!["summary-unknown-column:error"]);
    assert_eq!(view("select=\"Id\" summary=\"N = sum(N)\"").1, vec!["summary-projected-away:error"]);
    assert_eq!(view("summary=\"N = (sum(N)\"").1, vec!["summary-error:error"]);
    assert_eq!(view("summary=\"N = N + 1\"").1, vec!["summary-error:error"]);
    assert_eq!(view("summary=\"N = avg(S)\"").1, vec!["compute-not-a-number:warning"]);
    let (p, c) = view("select=\"Id, S\" summary=\"Id = 'All'; S = 2024\"");
    assert!(c.is_empty(), "{c:?}");
    assert!(p.ends_with(r##"summary ["All","2024"])"##), "{p}");
    // An entry's left side takes a name, never a letter, and the row stands (§6.1).
    let (p, c) = view("summary=\"C = 7.5\"");
    assert_eq!(c, vec!["summary-unknown-column:error"]);
    assert!(p.ends_with(r##"summary ["","",""])"##), "{p}");
    // Its right side reads a column by letter.
    let (p, _) = view("summary=\"N = count(A)\"");
    assert!(p.ends_with(r##"summary ["","3",""])"##), "{p}");
    assert!(view("summary=\"AAAAAAAAAAAAAAAA = 1\"").1 == vec!["summary-unknown-column:error"]);
}

// ---------------------------------------------------------------------------
// structure, bounds, inline edges
// ---------------------------------------------------------------------------

#[test]
fn structure_diagnostics() {
    assert_eq!(codes("=== embed src=#a\n==="), vec!["fence-like-line:warning"]);
    assert_eq!(codes("=== aaa}\ntext"), vec!["fence-like-line:warning"]);
    clean("=== wall of text\n");
    assert_eq!(codes("## T {#a}x"), vec!["heading-attrs-trailing-text:warning"]);
    assert_eq!(codes("## T {#a"), vec!["heading-attrs-unclosed:warning"]);
    assert_eq!(codes("## T {#a & b}"), vec!["name-not-a-name:warning"]);
    assert_eq!(codes("=== note {#a .x .x}\ny\n==="), vec!["duplicate-name:error"]);
    assert_eq!(proj("## T \\\n{#sec}\n\n[[#sec]]"), r##"h2("T") ref("#sec")"##);
    assert_eq!(proj("=== note {#a \\\nbroken\n\nx"), r##""=== note {#a " br "broken" "x""##);
}

#[test]
fn bounds_degrade_to_a_diagnostic() {
    // Blocks: fences one longer each, nested past the bound.
    let n = 260;
    let mut s = String::new();
    for i in 0..n {
        s.push_str(&format!("{} note\n", "=".repeat(3 + n - i)));
    }
    s.push_str("core\n");
    for i in (0..n).rev() {
        s.push_str(&format!("{}\n", "=".repeat(3 + n - i)));
    }
    assert!(has(&s, "block-nesting-too-deep"));
    // Lists.
    let list: String = (0..300).map(|i| format!("{}- x\n", " ".repeat(i))).collect();
    let d = geml::parse(&list);
    assert!(d.diagnostics.iter().any(|x| x.code == "list-nesting-too-deep"));
    // Inline: emphasis and image alt text.
    let deep = format!("{}x{}", "**".repeat(150), "**".repeat(150));
    assert!(has(&deep, "inline-nesting-too-deep"));
    let alt = format!("{}x{}", "![".repeat(150), "](i.png)".repeat(150));
    assert!(has(&alt, "inline-nesting-too-deep"));
    let label = format!("{}x{}", "[![".repeat(120), "](i.png)](x.geml)".repeat(120));
    assert!(has(&label, "inline-nesting-too-deep"));
}

#[test]
fn inline_edges() {
    assert_eq!(
        proj("[a](https://x.test){target=_blank} ![b](p.png){width=3} [c](d e)"),
        r##"link("https://x.test" "a") " " img("p.png") " " link("d e" "c")"##
    );
    assert_eq!(proj("[a [b](x.geml)](y.geml)"), r##"link("y.geml" "a [b](x.geml)")"##);
    assert_eq!(proj("[^not a name] [x](a\nb) [[#a\nb]] [open"), "\"[^not a name] [x](a\\nb) [[#a\\nb]] [open\"");
    assert_eq!(proj("a \\q b \\"), r##""a \\q b \\""##);
    assert_eq!(proj("$ lone and `` lone"), r##""$ lone and `` lone""##);
    assert_eq!(
        proj("[`]` x](y.geml) [$]$ x](z.geml) [\\] x](w.geml)"),
        r##"link("y.geml" code("]") " x") " " link("z.geml" math("]") " x") " " link("w.geml" "] x")"##
    );
    assert_eq!(proj("[[a#b]]"), r##"ref("a#b")"##);
    assert_eq!(proj("![a](b"), r##""![a](b""##);
    assert_eq!(proj("~x~ ~~y"), r##""~x~ ~~y""##);
    assert_eq!(proj("*a **b*"), r##""*a *" em("b")"##);
}

#[test]
fn lists_edges() {
    assert_eq!(proj("- a\n  - b\n  1. c"), r##"ul[li("a" ul[li("b")] ol[li("c")])]"##);
    assert_eq!(proj("  - a\n- b"), r##"ul[li("a") li("b")]"##);
    assert_eq!(proj("- a\n    - b\n  - c"), r##"ul[li("a" ul[li("b")] ul[li("c")])]"##);
    assert_eq!(proj("- a\n  - b\n\n- c"), r##"ul*[li("a" ul[li("b")]) li("c")]"##);
    assert_eq!(proj("0. zero\n1. one"), r##"ol[li("zero") li("one")]"##);
    assert_eq!(proj("```\n- a\n```\n"), "code(\"\\n- a\\n\")");
    assert_eq!(proj("- a\n  ```\n  - b\n  ```"), "ul[li(\"a\\n\" code(\"\\n- b\\n\"))]");
}

// ---------------------------------------------------------------------------
// the model as JSON, and the API
// ---------------------------------------------------------------------------

#[test]
fn the_model_as_json() {
    let src = "=== meta\nt = \"x\"\n===\n\n# H {#h}\n\n- [x] *a* **b** ~~c~~ `d` $e$ a\\\n  b ![i](i.png) [l](https://x) [m](#h) [n](o.geml#p) [[#h]] ![[#h]] [^h]\n\n%% note\n\n=== table {#t format=csv header=1}\nA\n1\n===\n\n=== view {#v src=#t summary=\"A = sum(A)\"}\n===\n\n=== data {#d}\n[1]\n===\n\n=== note {#n}\nbody\n===\n";
    let d = geml::parse(src);
    let j = json::parse(&geml::to_json(&d)).expect("the model is JSON");
    let kids = match j.get("children") {
        Some(Value::Array(a)) => a,
        _ => panic!("children"),
    };
    let kinds: Vec<String> = kids.iter().map(|k| k.get("kind").and_then(|v| v.scalar_text()).unwrap_or_default()).collect();
    assert_eq!(kinds, vec!["block", "heading", "list", "hidden", "block", "block", "block", "block"]);
    assert_eq!(kids[4].get("table").and_then(|t| t.get("columns")), Some(&Value::Array(vec![Value::String("A".into())])));
    assert!(kids[5].get("table").and_then(|t| t.get("summary")).is_some());
    assert_eq!(kids[6].get("value"), Some(&Value::Array(vec![Value::Number(1.0)])));
    assert_eq!(kids[0].get("mode").and_then(|v| v.scalar_text()).as_deref(), Some("data"));
    assert_eq!(kids[7].get("mode").and_then(|v| v.scalar_text()).as_deref(), Some("flow"));
    assert!(j.get("diagnostics").is_some() && j.get("meta").is_some());
    assert_eq!(j.get("ids"), Some(&Value::Array(["h", "t", "v", "d", "n"].iter().map(|s| Value::String(s.to_string())).collect())));
    assert!(geml::to_json(&d).contains("\"type\":\"footnote\""));
    assert_eq!(geml::decode(b"a\xffb"), "a\u{fffd}b");
    assert_eq!(geml::project(&geml::parse_bytes(b"\xef\xbb\xbfhi")), "\"hi\"");
    assert_eq!(geml::blocks_of(&geml::parse("%% x\n\n- a")), "hidden ul[li(\"a\")]");
    assert_eq!(d.children.iter().map(|i| i.line()).collect::<Vec<_>>(), vec![1, 5, 7, 10, 12, 17, 20, 24]);
}

#[test]
fn addresses_beside_headings() {
    let a = |s: &str| geml::parse(s).addresses;
    assert_eq!(a("# A\n\nlead\n\n## B\n\nx\n"), vec!["#a", "#a-before-b", "#b"]);
    assert_eq!(a("=== note {#n}\nx\n===\n\nprose\n\n# H\n"), vec!["#n", "#n-between-h", "#h"]);
    assert_eq!(a("## !!!\n\ntext\n\n=== note {#n}\nx\n===\n"), vec!["#n"]);
    assert_eq!(a("=== note {#a}\nx\n===\n\n%% only a note\n\n=== note {#b}\ny\n===\n"), vec!["#a", "#b"]);
    assert_eq!(a("## Same\n\n## Same\n"), vec!["#same"]);
    clean("# A\n\nlead\n\n## B\n\nSee [[#a-before-b]].\n");
}
