//! Markdown reading (`Options::markdown`, a `.md` file) beyond the suite's
//! own cases: the link targets a `[text](#frag)` may name — GitHub's heading
//! anchors, HTML `<a id>`/`<a name>`/`<span id>` anchors, Obsidian block
//! markers — and how a destination is read. Each expected projection and
//! diagnostic list is the reference parser's (`geml-parser/dist/geml.js`
//! with `test/conformance/_project.mjs`); each edit outcome the reference
//! adapter's (`_edits-impl.mjs`).

use geml::json::{self, Value};

/// An outcome as the reference's adapter reports it, keys sorted, less what
/// is this crate's own: a refusal's wording, and a refusal's empty
/// diagnostics list (the reference leaves the member out).
fn normal(v: Value) -> String {
    let refused = v.get("refused").is_some();
    let v = match v {
        Value::Object(m) => Value::Object(
            m.into_iter().filter(|(k, x)| k != "message" && !(refused && k == "diagnostics" && matches!(x, Value::Array(a) if a.is_empty()))).collect(),
        ),
        other => other,
    };
    json::canonical(&v)
}

/// Run one edit case (the suite's `edits-*.json` shape) and compare its
/// outcome with the reference implementation's answer to the same case.
#[track_caller]
fn edit(case: &str, want: &str) {
    let got = json::parse(&geml::edit::run_json(case)).expect("run_json answers JSON");
    assert_eq!(normal(got), normal(json::parse(want).expect("want is JSON")), "\ncase: {case}");
}

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

/// GitHub's heading anchors: markup and closing hashes dropped, repeats numbered, a trailing `{…}` kept.
#[test]
fn github_heading_anchors() {
    parsed(
        r##"{"name":"markup in a heading","parse":"# Hello <em>World</em> ##\n\n[a](#hello-world) [b](#nope)\n","markdown":true}"##,
        r##"{"diagnostics":["unresolved-reference:error"],"project":"h1(\"Hello <em>World</em> ##\") link(\"#hello-world\" \"a\") \" \" link(\"#nope\" \"b\")"}"##,
    );
    parsed(
        r###"{"name":"closing hashes","parse":"## Title ##\n\n## Tight#\n\n## ##\n\n[a](#title) [b](#tight) [c](#tight-1)\n","markdown":true}"###,
        r###"{"diagnostics":["unresolved-reference:error"],"project":"h2(\"Title ##\") h2(\"Tight#\") h2(\"##\") link(\"#title\" \"a\") \" \" link(\"#tight\" \"b\") \" \" link(\"#tight-1\" \"c\")"}"###,
    );
    parsed(
        r##"{"name":"repeats","parse":"# A\n\n# A\n\n# A-1\n\n[a](#a) [b](#a-1) [c](#a-2) [d](#a-1-1) [e](#a-3)\n","markdown":true}"##,
        r##"{"diagnostics":["unresolved-reference:error","unresolved-reference:error"],"project":"h1(\"A\") h1(\"A\") h1(\"A-1\") link(\"#a\" \"a\") \" \" link(\"#a-1\" \"b\") \" \" link(\"#a-2\" \"c\") \" \" link(\"#a-1-1\" \"d\") \" \" link(\"#a-3\" \"e\")"}"##,
    );
    parsed(
        r##"{"name":"a trailing brace","parse":"# Name {#custom}\n\n[a](#custom) [b](#name-custom)\n","markdown":true}"##,
        r##"{"diagnostics":[],"project":"h1(\"Name\") link(\"#custom\" \"a\") \" \" link(\"#name-custom\" \"b\")"}"##,
    );
    parsed(
        r##"{"name":"inline kinds","parse":"# Use `code`, $x$, [link](https://e.com), *em* and ![img](p.png)\n\n[a](#use-code-x-link-em-and-) [b](#nope)\n","markdown":true}"##,
        r##"{"diagnostics":["unresolved-reference:error"],"project":"h1(\"Use \" code(\"code\") \", \" math(\"x\") \", \" link(\"https://e.com\" \"link\") \", \" em(\"em\") \" and \" img(\"p.png\")) link(\"#use-code-x-link-em-and-\" \"a\") \" \" link(\"#nope\" \"b\")"}"##,
    );
    parsed(
        r##"{"name":"tags left open","parse":"# a <b c < d > e</x\n\n[x](#a-b-c--d--e) [y](#nope)\n","markdown":true}"##,
        r##"{"diagnostics":["unresolved-reference:error","unresolved-reference:error"],"project":"h1(\"a <b c < d > e</x\") link(\"#a-b-c--d--e\" \"x\") \" \" link(\"#nope\" \"y\")"}"##,
    );
    parsed(
        r#"{"name":"setext headings","parse":"Title\n=====\n\nSub\n---\n\n[a](#title) [b](#sub)\n","markdown":true}"#,
        r##"{"diagnostics":[],"project":"h1(\"Title\") h2(\"Sub\") link(\"#title\" \"a\") \" \" link(\"#sub\" \"b\")"}"##,
    );
}

/// HTML anchors: `<a id>`, `<a name>`, `<span id>`, attribute forms, and what code spans and comments hide.
#[test]
fn html_anchors() {
    parsed(
        r##"{"name":"anchor forms","parse":"<a id=\"x\"></a> <a name='y'></a> <span id=z>s</span> <A ID = \"w\"></A> <a href=\"#\" id=v/>\n\n[1](#x) [2](#y) [3](#z) [4](#w) [5](#v) [6](#q)\n","markdown":true}"##,
        r##"{"diagnostics":["unresolved-reference:error","unresolved-reference:error"],"project":"\"<a id=\\\"x\\\"></a> <a name='y'></a> <span id=z>s</span> <A ID = \\\"w\\\"></A> <a href=\\\"#\\\" id=v/>\" link(\"#x\" \"1\") \" \" link(\"#y\" \"2\") \" \" link(\"#z\" \"3\") \" \" link(\"#w\" \"4\") \" \" link(\"#v\" \"5\") \" \" link(\"#q\" \"6\")"}"##,
    );
    parsed(
        r#"{"name":"hidden by code and comments","parse":"`<a id=\"c\">` <!-- <a id=\"k\"> --> <a id=\"ok\">\n\n<!-- open\n<a id=\"in\">\nclose -->\n\n[1](#c) [2](#k) [3](#ok) [4](#in)\n","markdown":true}"#,
        r##"{"diagnostics":["unresolved-reference:error","unresolved-reference:error","unresolved-reference:error"],"project":"code(\"<a id=\\\"c\\\">\") \" <!-- <a id=\\\"k\\\"> --> <a id=\\\"ok\\\">\" \"<!-- open\\n<a id=\\\"in\\\">\\nclose -->\" link(\"#c\" \"1\") \" \" link(\"#k\" \"2\") \" \" link(\"#ok\" \"3\") \" \" link(\"#in\" \"4\")"}"##,
    );
    parsed(
        r#"{"name":"not anchors","parse":"<span>no id</span> <a<b id=\"lt\"> <abbr id=\"ab\"> <a id=\"\"> <a title=\"t\" id='q' x>\n\n[1](#lt) [2](#ab) [3](#q)\n","markdown":true}"#,
        r##"{"diagnostics":["unresolved-reference:error","unresolved-reference:error"],"project":"\"<span>no id</span> <a<b id=\\\"lt\\\"> <abbr id=\\\"ab\\\"> <a id=\\\"\\\"> <a title=\\\"t\\\" id='q' x>\" link(\"#lt\" \"1\") \" \" link(\"#ab\" \"2\") \" \" link(\"#q\" \"3\")"}"##,
    );
    parsed(
        r#"{"name":"a name on a span","parse":"<span name=\"sn\"></span> <span\tid=\"tab\">\n\n[1](#sn) [2](#tab)\n","markdown":true}"#,
        r##"{"diagnostics":["unresolved-reference:error"],"project":"\"<span name=\\\"sn\\\"></span> <span\\tid=\\\"tab\\\">\" link(\"#sn\" \"1\") \" \" link(\"#tab\" \"2\")"}"##,
    );
    parsed(
        r#"{"name":"backticks unclosed","parse":"`` <a id=\"u1\"> ` <a id=\"u2\">\n\n[1](#u1) [2](#u2)\n","markdown":true}"#,
        r##"{"diagnostics":[],"project":"\"`` <a id=\\\"u1\\\"> ` <a id=\\\"u2\\\">\" link(\"#u1\" \"1\") \" \" link(\"#u2\" \"2\")"}"##,
    );
    parsed(
        r#"{"name":"backslash in a line","parse":"\\` <a id=\"e1\"> `x`\n\n[1](#e1)\n","markdown":true}"#,
        r##"{"diagnostics":[],"project":"\"` <a id=\\\"e1\\\"> \" code(\"x\") link(\"#e1\" \"1\")"}"##,
    );
    parsed(
        r#"{"name":"inside a fence","parse":"```\n<a id=\"f\">\n```\n\n[1](#f)\n","markdown":true}"#,
        r##"{"diagnostics":["unresolved-reference:error"],"project":"code(\"```\\n<a id=\\\"f\\\">\\n```\") link(\"#f\" \"1\")"}"##,
    );
}

/// Obsidian block markers, and a destination read past `<…>` and a title.
#[test]
fn block_markers_and_destinations() {
    parsed(
        r#"{"name":"block markers","parse":"Para one ^blk-1\n\nx^no\n\n^solo\n\n```\nin code ^fenced\n```\n\n[1](#^blk-1) [2](#^no) [3](#^solo) [4](#^fenced)\n","markdown":true}"#,
        r##"{"diagnostics":["unresolved-reference:error","unresolved-reference:error","unresolved-reference:error","unresolved-reference:error"],"project":"\"Para one ^blk-1\" \"x^no\" \"^solo\" code(\"```\\nin code ^fenced\\n```\") link(\"#^blk-1\" \"1\") \" \" link(\"#^no\" \"2\") \" \" link(\"#^solo\" \"3\") \" \" link(\"#^fenced\" \"4\")"}"##,
    );
    parsed(
        r##"{"name":"destinations","parse":"# T\n\n[a](<#t>) [b](#t \"title\") [c](#t 't') [d](#t (t)) [e](#t junk) [f](<#t) [g](#t \"a\"b\")\n","markdown":true}"##,
        r##"{"diagnostics":["unresolvable-document:error","unresolved-reference:error","unresolved-reference:error"],"project":"h1(\"T\") link(\"#t\" \"a\") \" \" link(\"#t\" \"b\") \" \" link(\"#t\" \"c\") \" \" link(\"#t\" \"d\") \" \" link(\"#t junk\" \"e\") \" \" link(\"<#t\" \"f\") \" \" link(\"#t \\\"a\\\"b\\\"\" \"g\")"}"##,
    );
}

/// `check` over Markdown documents: the same targets, read through the edit layer.
#[test]
fn markdown_documents_checked() {
    edit(
        r##"{"name":"anchors resolve","geml":"# Hello <em>World</em>\n\n<a id=\"x\"></a>\n\n[a](#hello-world) [b](#x) [c](#gone)\n","file":"doc.md","op":{"verb":"check"}}"##,
        r#"{"diagnostics":["unresolved-reference:error"]}"#,
    );
    edit(
        r#"{"name":"footnotes and wikilinks","geml":"Text[^1] and [^none].\n\n[^1]: defined\n\n[[Other]] ![[Pic]]\n","file":"doc.md","op":{"verb":"check"}}"#,
        r#"{"diagnostics":[]}"#,
    );
}
