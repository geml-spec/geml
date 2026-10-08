//! Parsing beyond the suite's own cases: emphasis runs the delimiter
//! algorithm must pair, refuse or leave literal (the nesting bound
//! included), reference and coordinate forms that are not quite one, and
//! data bodies in each format. Each expected projection and diagnostic list
//! is the reference parser's (`geml-parser/dist/geml.js` with
//! `test/conformance/_project.mjs`).

use geml::json::{self, Value};

/// Parse one document — `markdown` as a `.md` file is read — and compare
/// its conformance projection and sorted diagnostic codes with the reference
/// parser's.
#[track_caller]
fn parsed(case: &str, want: &str) {
    let c = json::parse(case).expect("case is JSON");
    let text = c.get("parse").and_then(Value::scalar_text).expect("parse");
    let markdown = matches!(c.get("markdown"), Some(Value::Bool(true)));
    let mut host = geml::host::MapHost { complete: true, ..Default::default() };
    if let Some(Value::Object(fs)) = c.get("files") {
        for (k, v) in fs {
            host.files.insert(k.clone(), v.scalar_text().unwrap_or_default());
        }
    }
    let name = if markdown { "doc.md" } else { "doc.geml" };
    let doc = geml::parse_with(&text, &geml::Options { name: name.into(), host: Some(&host), markdown, ..Default::default() });
    let mut codes = geml::diagnostic_codes(&doc);
    codes.sort();
    let got = Value::Object(vec![
        ("project".into(), Value::String(geml::project(&doc))),
        ("diagnostics".into(), Value::Array(codes.into_iter().map(Value::String).collect())),
    ]);
    assert_eq!(json::canonical(&got), want, "\ncase: {case}");
}

/// Emphasis: openers of another kind skipped, the rule of three, runs spent unevenly, and leftovers literal.
#[test]
fn emphasis_runs() {
    parsed(r#"{"name":"crossed kinds","parse":"*a _b* c_\n"}"#, r#"{"diagnostics":[],"project":"em(\"a _b\") \" c_\""}"#);
    parsed(r#"{"name":"strong over emphasis","parse":"***a** b*\n"}"#, r#"{"diagnostics":[],"project":"em(strong(\"a\") \" b\")"}"#);
    parsed(r#"{"name":"emphasis over strong","parse":"**a *b***\n"}"#, r#"{"diagnostics":[],"project":"strong(\"a \" em(\"b\"))"}"#);
    parsed(r#"{"name":"rule of three","parse":"*a**b*\n"}"#, r#"{"diagnostics":[],"project":"em(\"a**b\")"}"#);
    parsed(r#"{"name":"intraword underscore","parse":"snake_case_name and _x_y_\n"}"#, r#"{"diagnostics":[],"project":"\"snake_case_name and _x_y_\""}"#);
    parsed(r#"{"name":"closers with no opener","parse":"a* b* c**\n"}"#, r#"{"diagnostics":[],"project":"\"a* b* c**\""}"#);
    parsed(r#"{"name":"an opener bottom reused","parse":"*a _b _c d* e*\n"}"#, r#"{"diagnostics":[],"project":"em(\"a _b _c d\") \" e*\""}"#);
    parsed(r#"{"name":"strike and stars","parse":"~~a *b~~ c*\n"}"#, r#"{"diagnostics":[],"project":"s(\"a *b\") \" c*\""}"#);
    parsed(r#"{"name":"leftover delimiters","parse":"****a*\n"}"#, r#"{"diagnostics":[],"project":"\"***\" em(\"a\")"}"#);
    parsed(r#"{"name":"single tilde","parse":"~a~ and ~~b~\n"}"#, r#"{"diagnostics":[],"project":"\"~a~ and ~~b~\""}"#);
}

/// Emphasis nested past the bound: the pair that would exceed it, and every later one reaching below it, is literal.
#[test]
fn emphasis_nesting_bound() {
    parsed(
        r#"{"name":"mixed kinds past the bound","parse":"*a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b *a _b x b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a* b_ a*\n"}"#,
        r#"{"diagnostics":[],"project":"em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b \" em(\"a _b x b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\") \" b_ a\")"}"#,
    );
    parsed(
        r#"{"name":"at the bound","parse":"*a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a *a x a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a* a*\n"}"#,
        r#"{"diagnostics":[],"project":"em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a \" em(\"a x a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\") \" a\")"}"#,
    );
}

/// References and coordinates that are not quite one: steps that are not a path, names that are not names.
#[test]
fn reference_forms() {
    parsed(r#"{"name":"unclosed forms","parse":"[[#t[1] and [[#t and ![[#t[1]\n"}"#, r#"{"diagnostics":[],"project":"\"[[#t[1] and [[#t and ![[#t[1]\""}"#);
    parsed(
        r#"{"name":"wikilinks in Markdown","parse":"[[a] ![[b] [[c]]] ![[d]]x [[]]\n","markdown":true}"#,
        r#"{"diagnostics":[],"project":"\"[[a] ![[b] [[c]]] ![[d]]x [[]]\""}"#,
    );
    parsed(
        r#"{"name":"math spans","parse":"$a$ and $ b $ and $c and `$d$` and \\$e$\n"}"#,
        r#"{"diagnostics":[],"project":"math(\"a\") \" and \" math(\" b \") \" and \" math(\"c and `\") \"d\" math(\"` and \\\\\") \"e$\""}"#,
    );
}

/// Data bodies in each format: JSON lines (blank lines skipped, a bad line placed), YAML, EDN, TOML and an unknown format.
#[test]
fn data_formats() {
    parsed(
        r#"{"name":"jsonl","parse":"=== data {#d format=jsonl}\n{\"a\": 1}\n\n{\"a\": 2}\n===\n"}"#,
        r#"{"diagnostics":[],"project":"data([{\"a\":1},{\"a\":2}])"}"#,
    );
    parsed(
        r#"{"name":"jsonl with a bad line","parse":"=== data {#d format=jsonl}\n{\"a\": 1}\nnope\n===\n"}"#,
        r#"{"diagnostics":["data-parse:error"],"project":"block:data"}"#,
    );
    parsed(r#"{"name":"json that is not","parse":"=== data {#d}\n{nope\n===\n"}"#, r#"{"diagnostics":["data-parse:error"],"project":"block:data"}"#);
    parsed(r#"{"name":"yaml","parse":"=== data {#d format=yaml}\na: 1\nb: [x, y]\n===\n"}"#, r#"{"diagnostics":["data-parse:error"],"project":"block:data"}"#);
    parsed(r#"{"name":"yaml that is not","parse":"=== data {#d format=yaml}\na: [\n===\n"}"#, r#"{"diagnostics":["data-parse:error"],"project":"block:data"}"#);
    parsed(r#"{"name":"edn","parse":"=== data {#d format=edn}\n{:a 1 :b [2 3]}\n===\n"}"#, r#"{"diagnostics":[],"project":"data({\":a\":1,\":b\":[2,3]})"}"#);
    parsed(r#"{"name":"edn that is not","parse":"=== data {#d format=edn}\n{:a\n===\n"}"#, r#"{"diagnostics":["data-parse:error"],"project":"block:data"}"#);
    parsed(
        r#"{"name":"edn outside the value tree","parse":"=== data {#d format=edn}\n#{1 2}\n===\n"}"#,
        r#"{"diagnostics":[],"project":"data({\"$set\":[1,2]})"}"#,
    );
    parsed(
        r#"{"name":"toml","parse":"=== data {#d format=toml}\na = 1\n===\n"}"#,
        r#"{"diagnostics":["data-format-no-engine:warning"],"project":"block:data"}"#,
    );
    parsed(r#"{"name":"unknown","parse":"=== data {#d format=ini}\na=1\n===\n"}"#, r#"{"diagnostics":["unknown-data-format:warning"],"project":"block:data"}"#);
}
