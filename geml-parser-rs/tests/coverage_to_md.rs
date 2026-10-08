//! The Markdown export (`to md`, §8.2(10)) beyond the suite's own cases:
//! every inline and block shape it projects, and the expansion of what a
//! document embeds — from itself, through the host from other documents, by
//! coordinate, along chains — with the budgets and refusals that bound it.
//! Each expected answer is the reference implementation's answer to the same
//! case (`geml-parser/test/conformance/_edits-impl.mjs`).

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

/// Inline shapes: links by href, anchor and document, images, strike, math, breaks, code spans and footnote references.
#[test]
fn inline_shapes() {
    edit(
        r#"{"name":"strike math break","geml":"Some ~~gone~~ and $a<b$ here\\\nnext line.\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"Some ~~gone~~ and $a\\lt b$ here  \nnext line.\n"}"#,
    );
    edit(
        r#"{"name":"code spans that need padding","geml":"A `` a`b `` span, `` `x `` one, `  y  ` and ` ` spaces.\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"A ``  a`b  `` span, ``  `x  `` one, `   y   ` and ` ` spaces.\n"}"#,
    );
    edit(
        r#"{"name":"footnote reference and definition","geml":"Claim.[^n1]\n\n=== note {#n1 .footnote}\nThe *source*.\n\nMore.\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"Claim.[^n1]\n\n[^n1]: The *source*. More.\n"}"#,
    );
    edit(
        r#"{"name":"footnote note without an id is a quote","geml":"=== note {.footnote}\nNo id.\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"> No id.\n"}"#,
    );
    edit(
        r#"{"name":"escaped specials","geml":"A \\*star\\*, a \\_low\\_, [brackets] and <angle> & amp.\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"A \\*star\\*, a \\_low\\_, \\[brackets\\] and \\<angle> \\& amp.\n"}"#,
    );
}

/// Auto-references and inline projections: coordinates say their value, a projection's content stands in the sentence.
#[test]
fn references_and_projections() {
    edit(
        r##"{"name":"ref to a heading and another document","geml":"# H {#h}\n\nSee [[#h]] and [[o.geml#x]].\n","files":{"o.geml":"# X {#x}\n"},"op":{"verb":"to","to":"md"}}"##,
        r##"{"output":"# H\n\nSee [#h](#h) and [o.geml#x](o.geml#x).\n"}"##,
    );
    edit(
        r#"{"name":"ref to a cell and to meta","geml":"=== meta\ntitle = \"T\"\n===\n\n=== table {#t format=csv header=1}\nA, B\n1, x\n2, y\n===\n\nCell [[#t[1][\"B\"]]], title [[#meta[\"title\"]]], row [[#t[2]]], column [[#t[\"A\"]]].\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"---\ntitle: T\n---\n\n# T\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\nCell [x](#t), title T, row [2, y](#t), column [#t](#t).\n"}"#,
    );
    edit(
        r#"{"name":"projection of a cell","geml":"=== table {#t format=csv header=1}\nA, B\n1, x\n2, y\n===\n\nValue ![[#t[1][\"B\"]]] here.\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\nValue x here.\n"}"#,
    );
    edit(
        r#"{"name":"projection of a paragraph block","geml":"=== text {#p}\nPara one\nwraps here.\n===\n\nSays: ![[#p]].\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"Para one\nwraps here.\n\nSays: Para one wraps here..\n"}"#,
    );
    edit(r#"{"name":"projection of nothing","geml":"Says: ![[#gone]].\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"Says: [#gone](#gone).\n"}"#);
    edit(
        r#"{"name":"projection of an empty block","geml":"=== text {#e}\n===\n\nSays: ![[#e]].\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"Says: [#e](#e).\n"}"#,
    );
    edit(
        r#"{"name":"projection from another document","geml":"Says: ![[o.geml#x]] and ![[o.geml#nope]].\n","files":{"o.geml":"=== text {#x}\nOver *there*.\n===\n"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"Says: Over *there*. and [o.geml#nope](o.geml#nope).\n"}"#,
    );
    edit(
        r#"{"name":"projection of itself stops at the chain depth","geml":"=== note {#n}\nLoop ![[#n]].\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"> Loop > Loop > Loop > Loop > Loop > Loop > Loop > Loop > Loop > Loop > Loop > Loop > Loop > Loop > Loop > Loop > Loop [#n](#n).................\n"}"#,
    );
}

/// A code span whose delimiters stand alone on their lines exports as a fenced block; otherwise as a span.
#[test]
fn fenced_code_spans() {
    edit(r#"{"name":"alone","geml":"``\nlet x = 1;\n``\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"```\nlet x = 1;\n```\n"}"#);
    edit(
        r#"{"name":"followed by text on its line","geml":"``\nlet x = 1;\n`` tail\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"`\nlet x = 1;\n` tail\n"}"#,
    );
    edit(
        r#"{"name":"followed by a new line","geml":"``\nlet x = 1;\n``\nmore\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"```\nlet x = 1;\n```\nmore\n"}"#,
    );
    edit(r#"{"name":"followed by emphasis","geml":"``\nlet x = 1;\n``*em*\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"`\nlet x = 1;\n`*em*\n"}"#);
    edit(r#"{"name":"holding backticks","geml":"````\na ``` b\n````\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"````\na ``` b\n````\n"}"#);
    edit(r#"{"name":"not at a line start","geml":"lead ``\nx\n``\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"lead `\nx\n`\n"}"#);
}

/// Tables (caption, alignment, summary, computed cells, pipes) and lists (ordered, task, nested, loose, continued).
#[test]
fn tables_and_lists() {
    edit(
        r#"{"name":"caption and alignment","geml":"=== table {#t caption=\"The *grid*\"}\n| L | C | R | N |\n|:--|:-:|--:|---|\n| a | b | c | d \\| e |\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"*The \\*grid\\**\n\n| L | C | R | N |\n| :--- | :--: | ---: | --- |\n| a | b | c | d \\| e |\n"}"#,
    );
    edit(
        r#"{"name":"summary and computed cells","geml":"=== table {#t format=csv header=1}\nA, B\n1, x\n2, y\n===\n\n=== view {#v src=#t summary=\"A = 'Total'; B = count(B)\"}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n| Total | 2 |\n"}"#,
    );
    edit(
        r#"{"name":"view with a computed column","geml":"=== table {#t format=csv header=1}\nA, B\n1, 2\n3, 4\n===\n\n=== view {#v src=#t select=\"A, B, A + B as S\"}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n"}"#,
    );
    edit(r#"{"name":"unreadable local source","geml":"=== table {#t src=gone.csv}\n===\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"|  |\n|  |\n"}"#);
    edit(
        r#"{"name":"remote source","geml":"=== table {#t src=\"https://x.example/a.csv\"}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"*External data `https://x.example/a.csv` — loaded at render time.*\n"}"#,
    );
    edit(r#"{"name":"view over a local block","geml":"=== view {#v src=#nope}\n===\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"|  |\n|  |\n"}"#);
    edit(
        r#"{"name":"ordered task nested loose","geml":"3. one\n4. two\n   - [x] done\n   - [ ] todo\n\n5. three\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"3. one\n\n4. two\n  - [x] done\n  - [ ] todo\n\n5. three\n"}"#,
    );
    edit(
        r#"{"name":"item text over lines","geml":"- first line\n  continued here\n- second\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"- first line\n  continued here\n- second\n"}"#,
    );
}

/// Typed blocks: code fences around backticks, data inline and loaded, math, diagrams, unknown types, hidden blocks and headings.
#[test]
fn typed_blocks() {
    edit(
        r#"{"name":"code holding a fence","geml":"=== code {lang=md}\n```js\nx\n```\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"````md\n```js\nx\n```\n````\n"}"#,
    );
    edit(r#"{"name":"code with no lang","geml":"=== code\nplain\n===\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"```\nplain\n```\n"}"#);
    edit(r#"{"name":"data inline","geml":"=== data {#d format=yaml}\na: 1\n===\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"```yaml\na: 1\n```\n"}"#);
    edit(
        r#"{"name":"data loaded from json","geml":"=== data {#d src=d.json}\n===\n","files":{"d.json":"{\"a\": [1, 2], \"b\": {\"c\": true}}"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"```json\n{\n  \"a\": [\n    1,\n    2\n  ],\n  \"b\": {\n    \"c\": true\n  }\n}\n```\n"}"#,
    );
    edit(
        r#"{"name":"data loaded from jsonl","geml":"=== data {#d src=d.jsonl format=jsonl}\n===\n","files":{"d.jsonl":"{\"a\": 1}\n{\"a\": 2}\n"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"```jsonl\n{\"a\":1}\n{\"a\":2}\n```\n"}"#,
    );
    edit(r#"{"name":"data source unreadable","geml":"=== data {#d src=gone.json}\n===\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"```json\n```\n"}"#);
    edit(r#"{"name":"math","geml":"=== math\na < b\n===\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"$$\na \\lt  b\n$$\n"}"#);
    edit(
        r#"{"name":"diagram","geml":"=== diagram {format=mermaid}\ngraph TD; A-->B\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"```mermaid\ngraph TD; A-->B\n```\n"}"#,
    );
    edit(
        r#"{"name":"chart","geml":"=== diagram {format=geml-chart type=bar data=#t x=A y=B}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"```geml-chart\ntype=bar data=#t x=A y=B\n```\n"}"#,
    );
    edit(r#"{"name":"unknown type","geml":"=== widget {#w}\nraw body\n===\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"```widget\nraw body\n```\n"}"#);
    edit(
        r##"{"name":"hidden block and heading","geml":"# Shown\n\n## Gone {hidden}\n\n=== note {hidden}\nx\n===\n\n%% a comment\n\nEnd.\n","op":{"verb":"to","to":"md"}}"##,
        r##"{"output":"# Shown\n\nEnd.\n"}"##,
    );
    edit(r#"{"name":"note with paragraphs","geml":"=== note\nOne.\n\nTwo.\n===\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"> One.\n>\n> Two.\n"}"#);
}

/// Front matter: values bare or quoted, merged metas, and where the title goes — echoed, shifted, or clamped headings.
#[test]
fn front_matter_and_title() {
    edit(
        r#"{"name":"values of every kind","geml":"=== meta\ntitle = \"T\"\nn = 3\nok = true\ntags = [\"a\", \"b\"]\nwho = {name = \"x\"}\nodd = \"a: b\"\n===\n\nBody.\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"---\ntitle: T\nn: 3\nok: true\ntags: \"[\\\"a\\\", \\\"b\\\"]\"\nwho: \"{name = \\\"x\\\"}\"\nodd: \"a: b\"\n---\n\n# T\n\nBody.\n"}"#,
    );
    edit(
        r#"{"name":"merged metas","geml":"=== meta\ntitle = \"One\"\nk = 1\n===\n\n=== meta\nk = 2\n===\n\nBody.\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"---\ntitle: One\nk: 2\n---\n\n# One\n\nBody.\n"}"#,
    );
    edit(
        r#"{"name":"title echoed by the first heading","geml":"=== meta\ntitle = \"Same\"\n===\n\n# Same\n\n## Sub\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"---\ntitle: Same\n---\n\n# Same\n\n## Sub\n"}"#,
    );
    edit(
        r#"{"name":"empty title","geml":"=== meta\ntitle = \"\"\n===\n\n# H\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"---\ntitle: \"\"\n---\n\n# H\n"}"#,
    );
    edit(
        r#"{"name":"title not a string","geml":"=== meta\ntitle = 3\n===\n\n# H\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"---\ntitle: 3\n---\n\n# H\n"}"#,
    );
    edit(
        r#"{"name":"headings clamped after the shift","geml":"=== meta\ntitle = \"T\"\n===\n\n###### Deep {#d}\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"---\ntitle: T\n---\n\n# T\n\n###### Deep\n"}"#,
    );
}

/// Block embeds: from this document, by part, from another document, a whole document, and what cannot be read.
#[test]
fn block_embeds() {
    edit(
        r#"{"name":"a block here","geml":"=== text {#p}\nBorrowed.\n===\n\n=== embed {src=#p}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"Borrowed.\n\nBorrowed.\n"}"#,
    );
    edit(
        r##"{"name":"a section by part","geml":"# Sec {#s}\n\nIntro text.\n\n## Sub\n\nSub text.\n\n# Other\n\n=== embed {src=#s part=body}\n===\n\n=== embed {src=#s part=head}\n===\n\n=== embed {src=#s part=intro}\n===\n","op":{"verb":"to","to":"md"}}"##,
        r##"{"output":"# Sec\n\nIntro text.\n\n## Sub\n\nSub text.\n\n# Other\n\nIntro text.\n\n## Sub\n\nSub text.\n\n# Sec\n\nIntro text.\n"}"##,
    );
    edit(
        r#"{"name":"a block elsewhere","geml":"=== embed {src=o.geml#x}\n===\n","files":{"o.geml":"=== text {#x}\nFrom *o*.\n===\n"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"From *o*.\n"}"#,
    );
    edit(
        r##"{"name":"a whole document","geml":"# Top\n\n=== embed {src=o.geml}\n===\n","files":{"o.geml":"=== meta\ntitle = \"O\"\n===\n\n# O1\n\nPara.\n\n## O2\n\nMore.\n\n=== note\nN.\n===\n"},"op":{"verb":"to","to":"md"}}"##,
        r##"{"output":"# Top\n\n# O1\n\nPara.\n\n## O2\n\nMore.\n\n> N.\n"}"##,
    );
    edit(r#"{"name":"a missing block","geml":"=== embed {src=#gone}\n===\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"[#gone](#gone)\n"}"#);
    edit(r#"{"name":"an empty source","geml":"=== embed {src=\"\"}\n===\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"\n"}"#);
    edit(
        r#"{"name":"not a geml document","geml":"=== embed {src=x.txt}\n===\n","files":{"x.txt":"text"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"[x.txt](x.txt)\n"}"#,
    );
    edit(
        r#"{"name":"a remote document","geml":"=== embed {src=\"https://x.example/a.geml#b\"}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"[https://x.example/a.geml#b](https://x.example/a.geml#b)\n"}"#,
    );
    edit(
        r#"{"name":"a missing document","geml":"=== embed {src=gone.geml#b}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"[gone.geml#b](gone.geml#b)\n"}"#,
    );
    edit(
        r#"{"name":"above the root","geml":"=== embed {src=../up.geml#b}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"[../up.geml#b](../up.geml#b)\n"}"#,
    );
}

/// Embed chains: an embed of an embed is followed to its content, and a cycle or a dead end is a link.
#[test]
fn embed_chains() {
    edit(
        r#"{"name":"two hops","geml":"=== embed {src=a.geml#e}\n===\n","files":{"a.geml":"=== embed {#e src=b.geml#z}\n===\n","b.geml":"=== text {#z}\nEnd of chain.\n===\n"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"End of chain.\n"}"#,
    );
    edit(
        r#"{"name":"a chain to a whole document","geml":"=== embed {src=a.geml#e}\n===\n","files":{"a.geml":"=== embed {#e src=b.geml}\n===\n","b.geml":"First.\n\nSecond.\n"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"First.\n\nSecond.\n"}"#,
    );
    edit(
        r#"{"name":"a cycle","geml":"=== embed {src=a.geml#e}\n===\n","files":{"a.geml":"=== embed {#e src=b.geml#f}\n===\n","b.geml":"=== embed {#f src=a.geml#e}\n===\n"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"[a.geml#e](a.geml#e)\n"}"#,
    );
    edit(
        r#"{"name":"a chain into nothing","geml":"=== embed {src=a.geml#e}\n===\n","files":{"a.geml":"=== embed {#e src=b.geml#gone}\n===\n","b.geml":"x\n"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"[a.geml#e](a.geml#e)\n"}"#,
    );
    edit(
        r#"{"name":"a chain holding embeds","geml":"=== embed {src=a.geml#n}\n===\n","files":{"a.geml":"=== note {#n}\nOuter.\n\n=== embed {src=b.geml#z}\n===\n===\n","b.geml":"=== text {#z}\nInner.\n===\n"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"> Outer.\n>\n> Inner.\n"}"#,
    );
}

/// Embedded coordinates: a row is a one-row table under its header, a value a paragraph, anything else a link.
#[test]
fn embedded_coordinates() {
    edit(
        r#"{"name":"a row","geml":"=== table {#t format=csv header=1}\nA, B\n1, x\n2, y\n===\n\n=== embed {src=#t[2]}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n| A | B |\n| --- | --- |\n| 2 | y |\n"}"#,
    );
    edit(
        r#"{"name":"a value","geml":"=== table {#t format=csv header=1}\nA, B\n1, x\n2, y\n===\n\n=== embed {src=#t[1][\"B\"]}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\nx\n"}"#,
    );
    edit(
        r#"{"name":"a column","geml":"=== table {#t format=csv header=1}\nA, B\n1, x\n2, y\n===\n\n=== embed {src=#t[\"B\"]}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n[#t\\[\"B\"\\]](#t[\"B\"])\n"}"#,
    );
    edit(
        r#"{"name":"a row past the end","geml":"=== table {#t format=csv header=1}\nA, B\n1, x\n2, y\n===\n\n=== embed {src=#t[9]}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n[#t\\[9\\]](#t[9])\n"}"#,
    );
    edit(
        r#"{"name":"a summary row","geml":"=== table {#t format=csv header=1}\nA, B\n1, x\n2, y\n===\n\n=== view {#v src=#t summary=\"A = 'Total'\"}\n===\n\n=== embed {src=#v[summary]}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n| Total |  |\n\n| A | B |\n| --- | --- |\n| Total |  |\n"}"#,
    );
    edit(
        r#"{"name":"a data value","geml":"=== data {#d}\n{\"rows\": [{\"n\": 7}]}\n===\n\n=== embed {src=#d[\"rows\"][0][\"n\"]}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"```json\n{\"rows\": [{\"n\": 7}]}\n```\n\n7\n"}"#,
    );
    edit(
        r#"{"name":"a data subtree","geml":"=== data {#d}\n{\"rows\": [{\"n\": 7}]}\n===\n\n=== embed {src=#d[\"rows\"]}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"```json\n{\"rows\": [{\"n\": 7}]}\n```\n\n[#d\\[\"rows\"\\]](#d[\"rows\"])\n"}"#,
    );
    edit(r#"{"name":"a missing block","geml":"=== embed {src=#nope[1]}\n===\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"[#nope\\[1\\]](#nope[1])\n"}"#);
    edit(r#"{"name":"no block named","geml":"=== embed {src=#[1]}\n===\n","op":{"verb":"to","to":"md"}}"#, r#"{"output":"[#\\[1\\]](#[1])\n"}"#);
    edit(
        r#"{"name":"a row elsewhere","geml":"=== embed {src=o.geml#t[1]}\n===\n","files":{"o.geml":"=== table {#t format=csv header=1}\nA, B\n1, x\n2, y\n===\n\n"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"| A | B |\n| --- | --- |\n| 1 | x |\n"}"#,
    );
    edit(
        r#"{"name":"elsewhere, missing","geml":"=== embed {src=gone.geml#t[1]}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"[gone.geml#t\\[1\\]](gone.geml#t[1])\n"}"#,
    );
    edit(
        r#"{"name":"remote","geml":"=== embed {src=\"https://x.example/o.geml#t[1]\"}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"[https://x.example/o.geml#t\\[1\\]](https://x.example/o.geml#t[1])\n"}"#,
    );
    edit(
        r##"{"name":"a heading's coordinate","geml":"# H {#h}\n\n=== embed {src=#h[1]}\n===\n","op":{"verb":"to","to":"md"}}"##,
        r##"{"output":"# H\n\n[#h\\[1\\]](#h[1])\n"}"##,
    );
}

/// A borrowed view keeps the table its `src=#id` names, which the slice it was cut into does not hold.
#[test]
fn borrowed_views() {
    edit(
        r#"{"name":"a view here","geml":"=== table {#t format=csv header=1}\nA, B\n1, x\n2, y\n===\n\n=== view {#v src=#t where=\"A > 1\"}\n===\n\n=== embed {src=#v}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n| A | B |\n| --- | --- |\n| 2 | y |\n\n| A | B |\n| --- | --- |\n| 2 | y |\n"}"#,
    );
    edit(
        r#"{"name":"a view elsewhere","geml":"=== embed {src=o.geml#v}\n===\n","files":{"o.geml":"=== table {#t format=csv header=1}\nA, B\n1, x\n2, y\n===\n\n=== view {#v src=#t}\n===\n"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n"}"#,
    );
    edit(
        r#"{"name":"a view inside a borrowed note","geml":"=== embed {src=o.geml#n}\n===\n","files":{"o.geml":"=== table {#t format=csv header=1}\nA, B\n1, x\n2, y\n===\n\n=== note {#n}\n=== view {#v src=#t}\n===\n===\n"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"> | A | B |\n> | --- | --- |\n> | 1 | x |\n> | 2 | y |\n"}"#,
    );
}

/// The bounds on expansion: the budget of expansions, the chain depth, the hops along chains, and a `part=` that is no word.
#[test]
fn expansion_bounds() {
    edit(
        r#"{"name":"the expansion budget","geml":"=== text {#p}\nP\n===\n\n![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] ![[#p]] \n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"P\n\nP P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P P [#p](#p) [#p](#p) \n"}"#,
    );
    edit(
        r##"{"name":"a part that is a number","geml":"# S {#s}\n\nBody.\n\n=== embed {src=#s part=3}\n===\n","op":{"verb":"to","to":"md"}}"##,
        r##"{"output":"# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n# S\n\nBody.\n\n[#s](#s)\n"}"##,
    );
    edit(
        r#"{"name":"a chain past the depth","geml":"=== embed {src=c1.geml#e}\n===\n","files":{"c1.geml":"=== embed {#e src=c2.geml#e}\n===\n","c2.geml":"=== embed {#e src=c3.geml#e}\n===\n","c3.geml":"=== embed {#e src=c4.geml#e}\n===\n","c4.geml":"=== embed {#e src=c5.geml#e}\n===\n","c5.geml":"=== embed {#e src=c6.geml#e}\n===\n","c6.geml":"=== embed {#e src=c7.geml#e}\n===\n","c7.geml":"=== embed {#e src=c8.geml#e}\n===\n","c8.geml":"=== embed {#e src=c9.geml#e}\n===\n","c9.geml":"=== embed {#e src=c10.geml#e}\n===\n","c10.geml":"=== embed {#e src=c11.geml#e}\n===\n","c11.geml":"=== embed {#e src=c12.geml#e}\n===\n","c12.geml":"=== embed {#e src=c13.geml#e}\n===\n","c13.geml":"=== embed {#e src=c14.geml#e}\n===\n","c14.geml":"=== embed {#e src=c15.geml#e}\n===\n","c15.geml":"=== embed {#e src=c16.geml#e}\n===\n","c16.geml":"=== embed {#e src=c17.geml#e}\n===\n","c17.geml":"=== embed {#e src=c18.geml#e}\n===\n","c18.geml":"=== embed {#e src=c19.geml#e}\n===\n","c19.geml":"=== text {#e}\nEnd.\n===\n"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"[c1.geml#e](c1.geml#e)\n"}"#,
    );
    edit(
        r#"{"name":"hops past the budget","geml":"=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n=== embed {src=c1.geml#e}\n===\n\n","files":{"c1.geml":"=== embed {#e src=c2.geml#e}\n===\n","c2.geml":"=== embed {#e src=c3.geml#e}\n===\n","c3.geml":"=== embed {#e src=c4.geml#e}\n===\n","c4.geml":"=== embed {#e src=c5.geml#e}\n===\n","c5.geml":"=== embed {#e src=c6.geml#e}\n===\n","c6.geml":"=== embed {#e src=c7.geml#e}\n===\n","c7.geml":"=== embed {#e src=c8.geml#e}\n===\n","c8.geml":"=== embed {#e src=c9.geml#e}\n===\n","c9.geml":"=== embed {#e src=c10.geml#e}\n===\n","c10.geml":"=== embed {#e src=c11.geml#e}\n===\n","c11.geml":"=== embed {#e src=c12.geml#e}\n===\n","c12.geml":"=== embed {#e src=c13.geml#e}\n===\n","c13.geml":"=== embed {#e src=c14.geml#e}\n===\n","c14.geml":"=== embed {#e src=c15.geml#e}\n===\n","c15.geml":"=== text {#e}\nEnd.\n===\n"},"op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"End.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\nEnd.\n\n[c1.geml#e](c1.geml#e)\n\n[c1.geml#e](c1.geml#e)\n\n[c1.geml#e](c1.geml#e)\n\n[c1.geml#e](c1.geml#e)\n\n[c1.geml#e](c1.geml#e)\n\n[c1.geml#e](c1.geml#e)\n\n[c1.geml#e](c1.geml#e)\n\n[c1.geml#e](c1.geml#e)\n\n[c1.geml#e](c1.geml#e)\n"}"#,
    );
    edit(
        r#"{"name":"a borrowed section holding a table and a paragraph first","geml":"Lead paragraph.\n\n- item\n\n=== table {#t format=csv header=1}\nA, B\n1, x\n2, y\n===\n\n# S {#s}\n\n=== table {#t2}\n| a |\n|---|\n| 1 |\n===\n\n=== view {#v2 src=#t}\n===\n\n=== embed {src=#s}\n===\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"Lead paragraph.\n\n- item\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n# S\n\n| a |\n| --- |\n| 1 |\n\n| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n\n[#s](#s)\n"}"#,
    );
    edit(
        r#"{"name":"meta values from json","geml":"=== meta {format=json}\n{\"title\": \"T\", \"tags\": [\"a\", \"b\"], \"who\": {\"n\": 1}, \"none\": null}\n===\n\nBody.\n","op":{"verb":"to","to":"md"}}"#,
        r#"{"output":"Body.\n"}"#,
    );
}

/// The export from Markdown and from model JSON input.
#[test]
fn other_inputs() {
    edit(
        r##"{"name":"markdown to markdown","geml":"# Title\n\nSome *text* and `code`.\n\n- a\n- b\n","file":"doc.md","op":{"verb":"to","to":"md"}}"##,
        r##"{"output":"# Title\n\nSome *text* and `code`.\n\n- a\n- b\n"}"##,
    );
    edit(
        r##"{"name":"markdown to geml","geml":"# Title\n\n> quoted\n\n```js\nx\n```\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"##,
        r##"{"output":"# Title\n\n=== note {#note-1}\nquoted\n===\n\n=== code {#code-1 lang=js}\nx\n===\n"}"##,
    );
}
