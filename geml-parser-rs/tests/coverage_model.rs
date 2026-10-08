//! Paths only this crate defines, asserted on its own outcomes rather than
//! the reference's: an edit case given as malformed JSON, an operation this
//! crate does not run, and the document model read back from this crate's
//! own JSON (`to` from `json`) — a layout the suite leaves to each
//! implementation, so the reference has no answer to compare with.

use geml::json::{self, Value};

fn run(case: Value) -> Value {
    json::parse(&geml::edit::run_json(&json::to_json(&case))).expect("run_json answers JSON")
}

fn obj(fields: &[(&str, Value)]) -> Value {
    Value::Object(fields.iter().map(|(k, v)| (k.to_string(), v.clone())).collect())
}

fn s(text: &str) -> Value {
    Value::String(text.to_string())
}

/// `to <out>` of `text`, read as the format its file name says.
fn convert(text: &str, file: &str, out: &str) -> Value {
    run(obj(&[("geml", s(text)), ("file", s(file)), ("op", obj(&[("verb", s("to")), ("to", s(out))]))]))
}

fn output(v: &Value) -> String {
    v.get("output").and_then(Value::scalar_text).unwrap_or_else(|| panic!("an output: {}", json::to_json(v)))
}

fn refused(v: &Value) -> String {
    v.get("refused").and_then(Value::scalar_text).unwrap_or_else(|| panic!("a refusal: {}", json::to_json(v)))
}

/// A case that is not one is an `error`, never a guess.
#[test]
fn malformed_cases_are_errors() {
    for bad in [
        "not json",
        "[]",
        r#"{"op": {"verb": "list"}}"#,
        r#"{"geml": "x"}"#,
        r#"{"geml": "x", "op": {}}"#,
        r#"{"geml": "x", "files": {"a.geml": [1]}, "op": {"verb": "list"}}"#,
    ] {
        let v = json::parse(&geml::edit::run_json(bad)).expect("JSON");
        assert!(v.get("error").is_some(), "{bad}: {}", json::to_json(&v));
    }
}

/// An operation this crate does not run is `unsupported`, which a harness
/// counts as skipped — never as an answer.
#[test]
fn unsupported_operations() {
    let v = run(obj(&[("geml", s("x\n")), ("op", obj(&[("verb", s("frobnicate"))]))]));
    assert!(v.get("unsupported").is_some(), "{}", json::to_json(&v));
    let v = convert("x\n", "doc.geml", "html");
    assert!(v.get("unsupported").is_some(), "{}", json::to_json(&v));
}

/// Every field an op can carry is read from the case: a `delete` of several
/// addresses, a `find` with every flag, a `revert` with every option.
#[test]
fn every_op_field_is_read() {
    let doc = "# A {#a}\n\nalpha Beta\n\n=== note {#n}\nbeta\n===\n\n=== note {#m}\ngamma\n===\n";
    let delete = |addresses: Vec<Value>| run(obj(&[("geml", s(doc)), ("op", obj(&[("verb", s("delete")), ("addresses", Value::Array(addresses))]))]));
    assert_eq!(delete(vec![s("#m")]).get("text").and_then(Value::scalar_text).as_deref(), Some("# A {#a}\n\nalpha Beta\n\n=== note {#n}\nbeta\n===\n"));
    // An address given as a number is read as its text.
    assert_eq!(delete(vec![s("#m"), Value::Number(3.0)]), delete(vec![s("#m"), s("3")]));
    let v = run(obj(&[
        ("geml", s(doc)),
        ("op", obj(&[("verb", s("find")), ("pattern", s("Beta")), ("case", Value::Bool(true)), ("head", Value::Bool(true)), ("within", s("#a"))])),
    ]));
    let Some(Value::Array(hits)) = v.get("hits") else { panic!("hits: {}", json::to_json(&v)) };
    assert_eq!(hits.len(), 1, "only the case-sensitive hit inside #a");
    let v = run(obj(&[
        ("geml", s(doc)),
        ("op", obj(&[("verb", s("revert")), ("address", s("#n")), ("rev", s("0")), ("before", s("#a")), ("after", s("#a")), ("append", Value::Bool(true))])),
    ]));
    assert_eq!(refused(&v), "revert-refused", "no sidecar");
}

/// Documents whose model JSON is read back below: every item kind, every
/// inline node, every body mode.
const DOCS: &[&str] = &[
    "=== meta\ntitle = Doc\nn = 3\n===\n\n# Tiny {#tiny .c k=v}\n\nA *word* **bold** ~~gone~~ `x` $m$ [here](#tiny), [d](o.geml#x), [o](o.geml), [u](https://e.com), ![alt](p.png), [[#n]], [[o.geml#x]], ![[o.geml#x]] and[^f].\nnext\\\nline\n\n- a\n- [x] b\n  - c\n- [ ] d\n\n3. three\n\n4. four\n\n%% note\n\n%%\n\n=== note {#n}\nbody\n===\n\n=== note {#f .footnote}\nThe note.\n===\n\n=== text {#p}\nProjected.\n===\n\n=== code {lang=sh}\nls\n===\n",
    "=== table {#t format=csv header=1}\nA, B\n1, x\n===\n\nCell [[#t[1][\"B\"]]] and ![[#t[1][\"A\"]]].\n\n=== data {#d}\n{\"a\": [1, 2]}\n===\n\n=== view {#v src=#t}\n===\n",
    "=== meta\nprofile = geml-media/v1\n===\n\n=== media-text {#mt .look}\nA *look*, in prose.\n\nSecond paragraph.\n===\n",
];

/// A document's model JSON reads back to the document: GEML written from it
/// is the canonical GEML of the text, and every other output is made from
/// that GEML read again.
#[test]
fn model_json_reads_back() {
    for doc in DOCS {
        let model = output(&convert(doc, "doc.geml", "json"));
        let canonical = output(&convert(doc, "doc.geml", "geml"));
        assert_eq!(output(&convert(&model, "doc.json", "geml")), canonical, "{doc}");
        assert_eq!(output(&convert(&model, "doc.json", "md")), output(&convert(&canonical, "doc.geml", "md")), "{doc}");
        assert_eq!(children(convert(&model, "doc.json", "json")), children(convert(&canonical, "doc.geml", "json")), "{doc}");
    }
    // Markdown in, JSON and Markdown out: through the GEML it converts to.
    let md = "# Title\n\nSome *text*.\n";
    let geml = output(&convert(md, "doc.md", "geml"));
    assert_eq!(children(convert(md, "doc.md", "json")), children(convert(&geml, "doc.geml", "json")));
    assert_eq!(output(&convert(md, "doc.md", "md")), output(&convert(&geml, "doc.geml", "md")));
}

/// A model's content, without what names the document it was read as.
fn children(v: Value) -> Option<Value> {
    json::parse(&output(&v)).expect("model JSON").get("children").cloned()
}

/// What a model may leave out — `attrs`, `classes`, `children`, `checked`, a
/// usable `line` — reads as absent, and a projection's fields are kept.
#[test]
fn a_sparse_model_reads() {
    let model = r#"{"children": [
        {"kind": "list", "ordered": false, "start": 1, "loose": false, "line": -1, "items": [
            {"inlines": [{"type": "text", "value": "a"}], "checked": false, "children": [
                {"kind": "list", "ordered": true, "start": 2, "loose": false, "items": [{"inlines": [{"type": "text", "value": "b"}]}]}
            ]}
        ]},
        {"kind": "block", "type": "note", "mode": "flow", "line": "x", "children": [
            {"kind": "paragraph", "inlines": [{"type": "project", "anchor": "p", "value": "v", "base": "p"}, {"type": "autoref", "doc": "o.geml", "anchor": "x"}]}
        ]},
        {"kind": "block", "type": "code", "mode": "raw", "raw": ["x"]}
    ]}"#;
    let got = output(&convert(model, "doc.json", "geml"));
    let want = "- [ ] a\n  2. b\n\n=== note\n![[#p]][[o.geml#x]]\n===\n\n=== code\nx\n===\n";
    assert_eq!(geml::project(&geml::parse(&got)), geml::project(&geml::parse(want)), "{got}");
}

/// Anything that is not this crate's model JSON is refused as `bad-content`,
/// whichever field is wrong.
#[test]
fn malformed_models_are_refused() {
    let para = |inline: &str| format!(r#"{{"children": [{{"kind": "paragraph", "inlines": [{inline}]}}]}}"#);
    let list = |fields: &str, item: &str| format!(r#"{{"children": [{{"kind": "list", {fields} "items": [{item}]}}]}}"#);
    let block = |fields: &str| format!(r#"{{"children": [{{"kind": "block", "type": "note", {fields}}}]}}"#);
    let ok_list = r#""ordered": false, "start": 1, "loose": false,"#;
    let ok_item = r#"{"inlines": []}"#;
    let bad: Vec<String> = vec![
        // Not a document at all.
        "not json".into(),
        "[]".into(),
        "{}".into(),
        r#"{"kind": "x", "children": []}"#.into(),
        r#"{"children": 3}"#.into(),
        r#"{"children": [7]}"#.into(),
        r#"{"children": [{"kind": "nope"}]}"#.into(),
        r#"{"children": [{"kind": 3}]}"#.into(),
        r#"{"children": [{"kind": "hidden"}]}"#.into(),
        r#"{"children": [{"kind": "heading", "level": 9, "id": "x", "inlines": []}]}"#.into(),
        r#"{"children": [{"kind": "heading", "level": 1.5, "id": "x", "inlines": []}]}"#.into(),
        r#"{"children": [{"kind": "heading", "level": "1", "id": "x", "inlines": []}]}"#.into(),
        r#"{"children": [{"kind": "paragraph", "inlines": 3}]}"#.into(),
        // Inline nodes.
        para(r#"{"type": "text", "value": 3}"#),
        para(r#"{"type": "link", "href": 3, "children": []}"#),
        para(r#"{"type": "emph", "children": 3}"#),
        para(r#"{"type": "image", "src": "p.png"}"#),
        para(r#"{"type": "project"}"#),
        para(r#"{"type": "autoref", "anchor": "a", "value": 1}"#),
        para(r#"{"type": "zap"}"#),
        para(r#"{"value": "no type"}"#),
        // Lists.
        list(r#""ordered": 1, "start": 1, "loose": false,"#, ok_item),
        list(r#""ordered": false, "start": "1", "loose": false,"#, ok_item),
        list(r#""ordered": false, "start": 1,"#, ok_item),
        list(ok_list, r#"{"inlines": [], "checked": "yes"}"#),
        list(ok_list, r#"{"inlines": [], "children": 3}"#),
        list(ok_list, r#"{"inlines": [], "children": [{"items": []}]}"#),
        list(ok_list, r#"{"checked": true}"#),
        // Blocks.
        block(r#""mode": "odd""#),
        block(r#""mode": 3"#),
        block(r#""mode": "flow", "attrs": []"#),
        block(r#""mode": "flow", "classes": "c", "children": []"#),
        block(r#""mode": "flow", "classes": [1], "children": []"#),
        block(r#""mode": "flow", "id": 3, "children": []"#),
        block(r#""mode": "flow""#),
        block(r#""mode": "raw", "raw": [1]"#),
        block(r#""mode": "data", "data": []"#),
    ];
    for b in &bad {
        let v = convert(b, "doc.json", "geml");
        assert_eq!(refused(&v), "bad-content", "{b}");
    }
}
