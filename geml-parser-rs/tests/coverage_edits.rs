//! The editing operations (§8.2(10)) beyond the suite's own cases: the
//! canonical serializer (`to geml`), the Markdown import, every selector
//! form and its refusals, `get`/`set` parts, the guarded splice, `rename`
//! and `revert` along their less travelled paths. Each expected answer is
//! the reference implementation's answer to the same case
//! (`geml-parser/test/conformance/_edits-impl.mjs`).

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

/// `to geml`: attribute values (bare, false, numbers, quoted) and data values that would read back typed.
#[test]
fn canonical_values_and_attributes() {
    edit(
        r#"{"name":"attribute values","geml":"=== code {#c .k lang=py n=3 on off=false q=\"a \\\"b\\\" c\" p=\"C:\\\\x\"}\nx\n===\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== code {#c .k lang=\"py\" n=3 on off=false q=\"a \\\"b\\\" c\" p=\"C:\\\\x\"}\nx\n===\n"}"#,
    );
    edit(
        r#"{"name":"data values","geml":"=== meta\nn = \"12\"\nf = \"1.5e3\"\nd = \".5\"\ne = \"2E+3\"\nx = \"1.2.3\"\nt = \"true\"\ns = \" pad \"\nw = word\nnum = 12\nb = false\n===\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== meta\nn = \"12\"\nf = \"1.5e3\"\nd = \".5\"\ne = \"2E+3\"\nx = 1.2.3\nt = \"true\"\ns = \" pad \"\nw = word\nnum = 12\nb = false\n===\n"}"#,
    );
    edit(
        r##"{"name":"heading attributes","geml":"# H {#h .c k=v}\n\n## Plain\n","op":{"verb":"to","to":"geml"}}"##,
        r##"{"output":"# H {#h .c k=\"v\"}\n\n## Plain {#plain}\n"}"##,
    );
    edit(r#"{"name":"hidden lines","geml":"%%\n\n%% a comment\n\nText.\n","op":{"verb":"to","to":"geml"}}"#, r#"{"output":"%%\n\n%% a comment\n\nText.\n"}"#);
}

/// `to geml`: every inline node, verbatim when it reads back, escaped when it would not.
#[test]
fn canonical_inlines() {
    edit(
        r#"{"name":"emphasis kinds and code","geml":"A *e* **s** ~~k~~ `c` ``a`b`` and $m$.\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"A *e* **s** ~~k~~ `c` ``a`b`` and $m$.\n"}"#,
    );
    edit(
        r#"{"name":"a break and an image","geml":"Line\\\nbreak ![alt *x*](p.png).\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"Line\\\nbreak ![alt *x*](p.png).\n"}"#,
    );
    edit(
        r##"{"name":"links of every shape","geml":"# H {#h}\n\n[l](#h) [d](o.geml#x) [o](o.geml) [u](https://e.com).\n","op":{"verb":"to","to":"geml"}}"##,
        r##"{"output":"# H {#h}\n\n[l](#h) [d](o.geml#x) [o](o.geml) [u](https://e.com).\n"}"##,
    );
    edit(
        r##"{"name":"references and projections","geml":"# H {#h}\n\n=== text {#p}\nP\n===\n\n[[#h]] [[o.geml#x]] ![[#p]] ![[o.geml#x]].\n","files":{"o.geml":"# X {#x}\n\n=== text {#x2}\nY\n===\n"},"op":{"verb":"to","to":"geml"}}"##,
        r##"{"output":"# H {#h}\n\n=== text {#p}\nP\n===\n\n[[#h]] [[o.geml#x]] ![[#p]] ![[o.geml#x]].\n"}"##,
    );
    edit(
        r#"{"name":"footnote reference","geml":"Claim.[^n]\n\n=== note {#n .footnote}\nN.\n===\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"Claim.[^n]\n\n=== note {#n .footnote}\nN.\n===\n"}"#,
    );
    edit(
        r#"{"name":"text that would read as markup","geml":"Literal \\*star\\* and \\[b\\] and \\`t\\` and \\~~s\\~~ and \\$d\\$.\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"Literal \\*star\\* and \\[b\\] and \\`t\\` and \\~\\~s\\~\\~ and \\$d\\$.\n"}"#,
    );
    edit(
        r#"{"name":"a literal meta reference","geml":"=== meta\ntitle = T\n===\n\nKeep \\{{ title }} and \\{{x}}.\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== meta\ntitle = T\n===\n\nKeep \\{{ title }} and \\{{x}}.\n"}"#,
    );
    edit(
        r#"{"name":"a meta reference after a backslash","geml":"=== meta\ntitle = T\n===\n\nPath C:\\\\\\{{ title }} here.\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== meta\ntitle = T\n===\n\nPath C:\\\\\\{{ title }} here.\n"}"#,
    );
    edit(r#"{"name":"a literal projection","geml":"Not \\![[#p]] here.\n","op":{"verb":"to","to":"geml"}}"#, r#"{"output":"Not \\![[#p]] here.\n"}"#);
    edit(
        r#"{"name":"projections of coordinates","geml":"=== meta\ntitle = T\n===\n\n=== table {#t format=csv header=1}\nA, B\n1, x\n===\n\nCell [[#t[1][\"B\"]]], ![[#t[1][\"A\"]]], ![[#t[1]]] and ![[#meta[\"title\"]]].\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== meta\ntitle = T\n===\n\n=== table {#t format=\"csv\" header=1}\nA, B\n1, x\n===\n\nCell [[#t[1][\"B\"]]], \\![[#t[1][\"A\"]]], \\![[#t[1]]] and \\![[#meta[\"title\"]]].\n"}"#,
    );
}

/// Each shape of answer an edit case gives: rows, hits, diagnostics, and a revert with nothing to write.
#[test]
fn answers_of_every_shape() {
    edit(
        r##"{"name":"list","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"list"}}"##,
        r##"{"rows":[{"address":"#intro","id":"intro","kind":"heading","level":1,"lines":[1,24],"text":"Intro"},{"address":"#intro-before-intro-2","id":"intro-before-intro-2","kind":"prose","lines":[3,3]},{"address":"#intro-2","id":"intro-2","kind":"heading","level":2,"lines":[5,24],"text":"Intro"},{"address":"#i3","id":"i3","kind":"heading","level":3,"lines":[7,24],"text":"INTRO"},{"address":"#n","id":"n","kind":"note","lines":[9,11]},{"address":"#c","id":"c","kind":"code","lines":[13,15]},{"address":"#t","id":"t","kind":"table","lines":[17,21]},{"address":"#i3-after-t","id":"i3-after-t","kind":"prose","lines":[23,23]}]}"##,
    );
    edit(
        r##"{"name":"list within","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"list","within":"#intro"}}"##,
        r##"{"rows":[{"address":"#intro-before-intro-2","id":"intro-before-intro-2","kind":"prose","lines":[3,3]},{"address":"#intro-2","id":"intro-2","kind":"heading","level":2,"lines":[5,24],"text":"Intro"},{"address":"#i3","id":"i3","kind":"heading","level":3,"lines":[7,24],"text":"INTRO"},{"address":"#n","id":"n","kind":"note","lines":[9,11]},{"address":"#c","id":"c","kind":"code","lines":[13,15]},{"address":"#t","id":"t","kind":"table","lines":[17,21]},{"address":"#i3-after-t","id":"i3-after-t","kind":"prose","lines":[23,23]}]}"##,
    );
    edit(
        r##"{"name":"find","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"find","pattern":"intro"}}"##,
        r##"{"hits":[{"address":"#intro","file":"doc.geml","kind":"heading","lines":[1,24]},{"address":"#intro-2","file":"doc.geml","kind":"heading","lines":[5,24]},{"address":"#i3","file":"doc.geml","kind":"heading","lines":[7,24]}]}"##,
    );
    edit(
        r##"{"name":"find with lines, case-sensitive","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"find","pattern":"Intro","case":true,"head":true}}"##,
        r###"{"hits":[{"address":"#intro","file":"doc.geml","kind":"heading","line":"# Intro {#intro}","lines":[1,24]},{"address":"#intro-2","file":"doc.geml","kind":"heading","line":"## Intro {#intro-2}","lines":[5,24]}]}"###,
    );
    edit(
        r#"{"name":"check","geml":"See [[#gone]].\n\n# A {#a}\n\n# B {#a}\n","op":{"verb":"check"}}"#,
        r#"{"diagnostics":["duplicate-id:error","unresolved-reference:error"]}"#,
    );
    edit(
        r##"{"name":"delete two at the end of a section","geml":"# A {#a}\n\nalpha\n\n=== note {#n}\nbeta\n===\n","op":{"verb":"delete","addresses":["#n"]}}"##,
        r##"{"text":"# A {#a}\n\nalpha\n"}"##,
    );
    edit(
        r##"{"name":"unchanged","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nsecond\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n","history":"# History of doc.geml\n\n=== meta\nprofile           = \"geml-history/v1\"\nhistory-of        = \"doc.geml\"\ngeml-version      = \"1.0\"\ncurrent           = \"20260101T000001Z-eb0c34a4\"\nkeyframe-interval = 10\n===\n\n# Committed-current mirror (always present):\n==== history-keyframe {id=\"20260101T000001Z-eb0c34a4\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\"}\n=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nsecond\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n====\n\n=== history-revision {id=\"20260101T000001Z-eb0c34a4\" parent=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v2\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\" newline=\"lf\"}\nreplace #alpha <- blob:b1\n===\n\n==== history-blob {#b1 lang=geml}\n=== note {#alpha}\nfirst\n===\n\n====\n\n=== history-revision {id=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v1\" hash=\"sha256:5b3ca2abb8f796509cc2b39048eac27745aeb78cf79f6646991a2194ebcd1a03\" newline=\"lf\"}\n===\n","op":{"verb":"revert","address":"#alpha","rev":"0"}}"##,
        r#"{"unchanged":true}"#,
    );
}

/// `to geml`: lists, data bodies, fences longer than a body's own, and prose lines escaped off structure.
#[test]
fn canonical_blocks() {
    edit(
        r#"{"name":"lists","geml":"- [ ] todo\n- [x] done\n  - child\n- a\n  continued\n\n7. seven\n8. eight\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"- [ ] todo\n- [x] done\n  - child\n- a\n  continued\n\n7. seven\n8. eight\n"}"#,
    );
    edit(r#"{"name":"loose list","geml":"- one\n\n- two\n","op":{"verb":"to","to":"geml"}}"#, r#"{"output":"- one\n\n- two\n"}"#);
    edit(
        r#"{"name":"json data","geml":"=== data {#d}\n{\"a\": [1, 2], \"b\": {\"c\": null}}\n===\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== data {#d}\n{\n  \"a\": [\n    1,\n    2\n  ],\n  \"b\": {\n    \"c\": null\n  }\n}\n===\n"}"#,
    );
    edit(
        r#"{"name":"jsonl data","geml":"=== data {#d format=jsonl}\n{\"a\":1}\n{\"a\":2}\n===\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== data {#d format=\"jsonl\"}\n{\"a\":1}\n{\"a\":2}\n===\n"}"#,
    );
    edit(
        r#"{"name":"yaml data","geml":"=== data {#d format=yaml}\na: 1\n===\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== data {#d format=\"yaml\"}\na: 1\n===\n"}"#,
    );
    edit(
        r#"{"name":"loaded data","geml":"=== data {#d src=d.json}\n===\n","files":{"d.json":"{\"a\": 1}"},"op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== data {#d src=\"d.json\"}\n===\n"}"#,
    );
    edit(
        r#"{"name":"a body holding a fence","geml":"==== code\n===\n=====x\n====\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"==== code\n===\n=====x\n====\n"}"#,
    );
    edit(
        r#"{"name":"prose that looks like structure","geml":"a\n\\- b\n\\## c\n\\%% d\n\\=== e\n\\1. f\n\\* g\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"a\n\\- b\n\\## c\n\\%% d\n\\=== e\n\\1. f\n\\* g\n"}"#,
    );
    edit(
        r#"{"name":"nested flow","geml":"=== note {#n}\n# Inside {#in}\n\n- x\n===\n","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== note {#n}\n# Inside {#in}\n\n- x\n===\n"}"#,
    );
}

/// Markdown → GEML: front matter, and the title lifted into `meta` with every heading moved up a level.
#[test]
fn markdown_import_front_matter() {
    edit(
        r#"{"name":"front matter values","geml":"---\ntitle: \"A \\q\"\nk: 'single'\nn: 3\nlist: [a, b]\n- odd\nbad line\n\n---\n\n# Body\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== meta\ntitle=\"A \\q\"\nk=single\nn=3\nlist=\"[a, b]\"\n===\n\n\n# Body\n"}"#,
    );
    edit(
        r#"{"name":"title echoed","geml":"---\ntitle: My_Title\n---\n\n# My\\_Title\n\n## Sub\n\n# Again\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== meta\ntitle=My_Title\n===\n\n\n# Sub\n\n# Again\n"}"#,
    );
    edit(
        r#"{"name":"title with no level-1 heading","geml":"---\ntitle: T\n---\n\n```\n# not a heading\n```\n\n## Sub\n\nPara\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== meta\ntitle=T\n===\n\n\n=== code {#code-1}\n# not a heading\n===\n\n# Sub\n\nPara\n"}"#,
    );
    edit(
        r#"{"name":"title with a setext level-1 heading","geml":"---\ntitle: T\n---\n\nOther\n=====\n\n## Sub\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== meta\ntitle=T\n===\n\n\n# Other\n\n## Sub\n"}"#,
    );
    edit(
        r#"{"name":"title with a later level-1 heading","geml":"---\ntitle: T\n---\n\nIntro.\n\n# Later\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== meta\ntitle=T\n===\n\n\nIntro.\n\n# Later\n"}"#,
    );
    edit(
        r#"{"name":"unterminated front matter","geml":"---\ntitle: x\nno end\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"title: x\nno end\n"}"#,
    );
    edit(
        r#"{"name":"dots close front matter","geml":"---\ntitle: T\n...\n\n# T\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== meta\ntitle=T\n===\n\n"}"#,
    );
}

/// Markdown → GEML: quotes, tables, fences, math, footnotes, GEML fences kept, headings with code.
#[test]
fn markdown_import_blocks() {
    edit(
        r#"{"name":"two quotes and two tables","geml":"> one\n>two\n\nmid\n\n> three\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n| c |\n| --- |\n| 3 |\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== note {#note-1}\none\ntwo\n===\n\nmid\n\n=== note {#note-2}\nthree\n===\n\n=== table {#table-1}\n| a | b |\n|:--|--:|\n| 1 | 2 |\n===\n\n=== table {#table-2}\n| c |\n| --- |\n| 3 |\n===\n"}"#,
    );
    edit(
        r#"{"name":"fences and diagrams","geml":"```js extra\nx\n```\n\n~~~mermaid\ngraph TD\n~~~\n\n```\nopen\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== code {#code-1 lang=js}\nx\n===\n\n=== diagram {#diagram-1 format=mermaid}\ngraph TD\n===\n\n=== code {#code-2}\nopen\n\n===\n"}"#,
    );
    edit(
        r#"{"name":"math","geml":"$$\na\n$$\n\n$$\nunclosed\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== math {#math-1}\na\n===\n\n=== math {#math-2}\nunclosed\n\n===\n"}"#,
    );
    edit(
        r#"{"name":"footnotes","geml":"Text[^1].\n\n[^1]: first\n  continued\n[^2]:tight\n[^]: none\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"Text[^1].\n\n=== note {#1}\nfirst\ncontinued\n===\n=== note {#2}\ntight\n===\n[^]: none\n"}"#,
    );
    edit(
        r#"{"name":"a GEML fence kept","geml":"=== note {#n}\nkept\n=== #n\n\n=== stray\n\n%% hidden\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== note {#n}\nkept\n=== #n\n\n=== stray\n\n%% hidden\n"}"#,
    );
    edit(
        r##"{"name":"headings with code","geml":"# Use `x` here\n## `{}` {#k}\n### `!`\n#### plain\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"##,
        r##"{"output":"# Use `x` here {#use-x-here}\n## `{}` {#k}\n### `!`\n#### plain\n"}"##,
    );
    edit(
        r#"{"name":"setext and thematic","geml":"Head\n----\n\n***\n\n- - -\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r###"{"output":"## Head\n\n\n"}"###,
    );
    edit(r#"{"name":"html","geml":"<div>x</div> and `<b>`\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#, r#"{"output":"<div>x</div> and `<b>`\n"}"#);
    edit(
        r##"{"name":"wide spaces","geml":"#　Wide\n\n indented\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"##,
        r##"{"output":"#　Wide\n\n indented\n"}"##,
    );
}

/// Markdown → GEML: autolinks and literal `{{name}}` text, outside code spans and math.
#[test]
fn markdown_import_inline_escapes() {
    edit(
        r#"{"name":"autolinks","geml":"See <https://a.b/c> and <mailto:x@y.z> and `<https://no>` and `unclosed <https://c.d>\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"See [https://a.b/c](https://a.b/c) and [x@y.z](mailto:x@y.z) and `<https://no>` and `unclosed [https://c.d](https://c.d)\n"}"#,
    );
    edit(
        r#"{"name":"meta-like text","geml":"{{ title }} `{{x}}` ``a ` {{y}}`` $a {{y}} b$ \\{{z}} {{ 9bad }} {{a b}} {{name} {{_ok-1 }}\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"\\{{ title }} `{{x}}` ``a ` {{y}}`` $a {{y}} b$ \\{{z}} {{ 9bad }} {{a b}} {{name} \\{{_ok-1 }}\n"}"#,
    );
    edit(
        r#"{"name":"dollars","geml":"$ {{w}} and $$ {{v}} and lone $\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"$ {{w}} and $$ {{v}} and lone $\n"}"#,
    );
    edit(
        r#"{"name":"unclosed code","geml":"``` `` {{q}}\nand ` {{r}}\n","file":"doc.md","op":{"verb":"to","to":"geml"}}"#,
        r#"{"output":"=== code {#code-1 lang=``}\nand ` {{r}}\n\n===\n"}"#,
    );
}

/// Selector forms resolved by `get`: pasted heading lines, content and line addresses, braces, and what none of them names.
#[test]
fn selector_forms() {
    edit(
        r##"{"name":"empty","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":""}}"##,
        r#"{"refused":"bad-address"}"#,
    );
    edit(
        r##"{"name":"a lone hash","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r########"{"name":"seven hashes","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"####### x"}}"########,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r###"{"name":"heading by text, any case, at its level","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"## intro"}}"###,
        r###"{"output":"## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n"}"###,
    );
    edit(
        r#####"{"name":"heading by text at no level","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#### intro"}}"#####,
        r#"{"refused":"ambiguous-address"}"#,
    );
    edit(
        r##"{"name":"heading line that matches nothing","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"# Missing words"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r###"{"name":"level-two line that matches nothing","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"## nomatch"}}"###,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"one hash and one word","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"# nospace"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"not hex","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"@zz"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"bad nth","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"@ab~x"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"nth past the end","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#intro-before-intro-2~2"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"content address of another type","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"=== code#intro-before-intro-2"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"content address of its type","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#intro-before-intro-2"}}"##,
        r#"{"output":"Text.\n"}"#,
    );
    edit(
        r##"{"name":"fence of a digit","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"=== 1abc"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"fence with junk","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"=== note junk"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"fence braces with junk","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"=== note {#n} junk"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"fence with a bad content address","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"=== note@zz"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"line not a number","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"Lx"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"line range not a number","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"L5-x"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"line zero","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"L0"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"line past the end","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"L999"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"lines across two units","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"L1-50"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"a line","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"L11"}}"##,
        r#"{"output":"=== note {#n .warn}\nN\n===\n"}"#,
    );
    edit(
        r##"{"name":"empty braces","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"{}"}}"##,
        r#"{"refused":"bad-address"}"#,
    );
    edit(
        r##"{"name":"fence content and class","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"=== note@ab12 {.warn}"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"content and class in braces","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"{#intro-before-intro-2 .warn}"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"class not on any block","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"{.zzz}"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"class","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"{.warn}"}}"##,
        r#"{"output":"=== note {#n .warn}\nN\n===\n"}"#,
    );
    edit(
        r##"{"name":"attribute","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"=== code {lang=py}"}}"##,
        r#"{"output":"=== code {#c lang=py}\nx\n===\n"}"#,
    );
    edit(
        r##"{"name":"braced id","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"{#n}"}}"##,
        r#"{"output":"=== note {#n .warn}\nN\n===\n"}"#,
    );
    edit(
        r##"{"name":"braced content","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"{#intro-before-intro-2}"}}"##,
        r#"{"output":"Text.\n"}"#,
    );
    edit(
        r##"{"name":"type with no block","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"=== nope"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"typed id of another type","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"=== code {#n}"}}"##,
        r#"{"refused":"bad-address"}"#,
    );
    edit(
        r##"{"name":"typed id of a heading","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"=== code {#intro}"}}"##,
        r#"{"refused":"bad-address"}"#,
    );
    edit(
        r##"{"name":"coordinate on braces","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"{.warn}[1]"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"bracket first","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"[1]"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"braced coordinate","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"{#t}[1]"}}"##,
        r#"{"output":"| 1 |\n"}"#,
    );
}

/// `get`: parts, `within` scopes, coordinates and the merged `#meta` view, and the refusals among them.
#[test]
fn get_parts_and_scopes() {
    edit(
        r##"{"name":"within a section","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"{.warn}","within":"#intro"}}"##,
        r#"{"output":"=== note {#n .warn}\nN\n===\n"}"#,
    );
    edit(
        r##"{"name":"within, nothing inside","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"=== note","within":"#c"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"within a coordinate","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"=== note","within":"#t[1]"}}"##,
        r#"{"refused":"bad-address"}"#,
    );
    edit(
        r##"{"name":"a coordinate within","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#t[1]","within":"#intro"}}"##,
        r#"{"refused":"bad-address"}"#,
    );
    edit(
        r##"{"name":"a coordinate with a part","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#t[1]","part":"body"}}"##,
        r#"{"refused":"bad-address"}"#,
    );
    edit(
        r##"{"name":"a coordinate on a heading","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#intro[1]"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"a coordinate on a note","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#n[1]"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"a cell","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#t[1][\"a\"]"}}"##,
        r#"{"output":"1\n"}"#,
    );
    edit(
        r##"{"name":"a cell past the end","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#t[5]"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"meta whole","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#meta"}}"##,
        r#"{"output":"title = \"Doc\"\n"}"#,
    );
    edit(
        r#"{"name":"meta typed","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"=== data {#meta}"}}"#,
        r#"{"refused":"bad-address"}"#,
    );
    edit(
        r#"{"name":"meta typed as meta","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"=== meta {#meta}"}}"#,
        r#"{"output":"title = \"Doc\"\n"}"#,
    );
    edit(
        r##"{"name":"meta key","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#meta[\"title\"]"}}"##,
        r#"{"output":"Doc\n"}"#,
    );
    edit(
        r##"{"name":"meta key missing","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#meta[\"nope\"]"}}"##,
        r#"{"refused":"no-such-unit"}"#,
    );
    edit(
        r##"{"name":"meta claimed by a block","geml":"=== note {#meta}\nmine\n===\n\n=== meta\nk = 1\n===\n","op":{"verb":"get","address":"#meta"}}"##,
        r#"{"output":"=== note {#meta}\nmine\n===\n"}"#,
    );
    edit(
        r##"{"name":"intro of a block","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#n","part":"intro"}}"##,
        r#"{"refused":"bad-address"}"#,
    );
    edit(
        r##"{"name":"intro of a section","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#intro","part":"intro"}}"##,
        r#"{"output":"\nText.\n\n"}"#,
    );
    edit(
        r##"{"name":"body of a labeled close","geml":"=== note {#lc}\nx\ny\n=== #lc\n","op":{"verb":"get","address":"#lc","part":"body"}}"##,
        r#"{"output":"x\ny\n"}"#,
    );
    edit(r##"{"name":"body of an empty block","geml":"=== note {#e}\n===\n","op":{"verb":"get","address":"#e","part":"body"}}"##, r#"{"output":""}"#);
    edit(
        r##"{"name":"head of a section","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"get","address":"#intro","part":"head"}}"##,
        r##"{"output":"# Intro {#intro}\n"}"##,
    );
}

/// `set`: parts it cannot take, empty content, coordinates on what holds none, and content that is no block.
#[test]
fn set_refusals() {
    edit(
        r##"{"name":"a coordinate with a part","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#t[1]","content":"x\n","part":"body"}}"##,
        r#"{"refused":"bad-address"}"#,
    );
    edit(
        r##"{"name":"a coordinate, empty","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#t[1][\"a\"]","content":"\n"}}"##,
        r#"{"refused":"bad-content"}"#,
    );
    edit(
        r##"{"name":"a coordinate on a heading","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#intro[1]","content":"x\n"}}"##,
        r#"{"refused":"bad-address"}"#,
    );
    edit(
        r##"{"name":"a meta key with a part","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#meta[\"title\"]","content":"x\n","part":"head"}}"##,
        r#"{"refused":"bad-address"}"#,
    );
    edit(
        r##"{"name":"a meta key, empty","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#meta[\"title\"]","content":"\n"}}"##,
        r#"{"refused":"bad-content"}"#,
    );
    edit(
        r##"{"name":"a meta path","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#meta[\"a\"][\"b\"]","content":"x\n"}}"##,
        r#"{"refused":"bad-address"}"#,
    );
    edit(
        r##"{"name":"content only hidden","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#n","content":"%% only\n"}}"##,
        r#"{"refused":"bad-content"}"#,
    );
    edit(
        r##"{"name":"content that is prose","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#n","content":"just prose\n"}}"##,
        r#"{"refused":"bad-content"}"#,
    );
    edit(
        r##"{"name":"content with two blocks","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#n","content":"=== note\na\n===\n\n=== note\nb\n===\n"}}"##,
        r#"{"refused":"bad-content"}"#,
    );
    edit(
        r##"{"name":"intro, empty","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#intro","content":"","part":"intro"}}"##,
        r#"{"refused":"bad-content"}"#,
    );
    edit(
        r##"{"name":"intro of a block","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#n","content":"x\n","part":"intro"}}"##,
        r#"{"refused":"bad-address"}"#,
    );
    edit(
        r##"{"name":"body, empty","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#n","content":"","part":"body"}}"##,
        r#"{"refused":"bad-content"}"#,
    );
    edit(
        r##"{"name":"several matches","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"=== note","content":"=== note\nz\n===\n"}}"##,
        r##"{"text":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n}\nz\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n"}"##,
    );
    edit(
        r##"{"name":"a coordinate","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#t[1][\"a\"]","content":"9\n"}}"##,
        r##"{"text":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 9 |\n===\n\nplain para\n"}"##,
    );
    edit(
        r##"{"name":"a meta key","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#meta[\"title\"]","content":"New\n"}}"##,
        r#"{"text":"=== meta\ntitle = \"New\"\n===\n\n# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n"}"#,
    );
    edit(
        r##"{"name":"a new meta key","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#meta[\"fresh\"]","content":"v\n"}}"##,
        r#"{"text":"=== meta\ntitle = \"Doc\"\nfresh = \"v\"\n===\n\n# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n"}"#,
    );
}

/// `set`: the id stamped into content across head forms, labeled closes renamed with it, bodies padded.
#[test]
fn set_writes() {
    edit(
        r##"{"name":"id after a quoted value","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#c","content":"=== code {lang=\"a\\\"#b\" #x}\ny\n===\n"}}"##,
        r##"{"text":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {lang=\"a\\\"#b\" #c}\ny\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n"}"##,
    );
    edit(
        r##"{"name":"empty braces","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#c","content":"=== code {}\ny\n===\n"}}"##,
        r##"{"text":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c}\ny\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n"}"##,
    );
    edit(
        r##"{"name":"no braces","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#c","content":"=== code\ny\n===\n"}}"##,
        r##"{"text":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c}\ny\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n"}"##,
    );
    edit(
        r##"{"name":"a labeled close","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#n","content":"=== note {#old}\nz\n=== #old\n"}}"##,
        r##"{"text":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n}\nz\n=== #n\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n"}"##,
    );
    edit(
        r####"{"name":"a heading with braces","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#i3","content":"### T {.k}\n"}}"####,
        r##"{"text":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### T {#i3 .k}\n"}"##,
    );
    edit(
        r##"{"name":"a fence with a stray brace","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#c","content":"=== code x}\ny\n===\n"}}"##,
        r#"{"refused":"bad-content"}"#,
    );
    edit(
        r##"{"name":"head only","geml":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .warn}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n","op":{"verb":"set","address":"#n","content":"=== note {#n .k}\n","part":"head"}}"##,
        r##"{"text":"# Intro {#intro}\n\nText.\n\n## Intro {#intro-2}\n\n### INTRO {#i3}\n\n=== note {#n .k}\nN\n===\n\n=== code {#c lang=py}\nx\n===\n\n=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\nplain para\n"}"##,
    );
    edit(
        r##"{"name":"body of a heading, no newline","geml":"# H {#h}\n\nold\n\n# Next {#nx}\n","op":{"verb":"set","address":"#h","content":"new","part":"body"}}"##,
        r##"{"text":"# H {#h}\n\nnew\n\n# Next {#nx}\n"}"##,
    );
    edit(
        r##"{"name":"body of the last heading, no newline","geml":"# H {#h}","op":{"verb":"set","address":"#h","content":"new\n","part":"body"}}"##,
        r##"{"text":"# H {#h}\n\nnew\n"}"##,
    );
    edit(
        r##"{"name":"intro, padded","geml":"# H {#h}\nold\n## Sub {#s}\n","op":{"verb":"set","address":"#h","content":"new","part":"intro"}}"##,
        r##"{"text":"# H {#h}\n\nnew\n\n## Sub {#s}\n"}"##,
    );
    edit(
        r##"{"name":"body closing the block early","geml":"=== note {#n}\nx\n===\n\n=== note {#m}\ny\n===\n","op":{"verb":"set","address":"#n","content":"a\n===\n\nb\n","part":"body"}}"##,
        r#"{"refused":"bad-content"}"#,
    );
    edit(
        r##"{"name":"body opening a nested block","geml":"=== note {#n}\nx\n===\n","op":{"verb":"set","address":"#n","content":"==== code\nz\n","part":"body"}}"##,
        r#"{"diagnostics":["unterminated-block:error"],"refused":"broken-result"}"#,
    );
    edit(
        r##"{"name":"a heading in Markdown takes its new anchor","geml":"# Old\n\nSee [x](#old).\n","file":"doc.md","op":{"verb":"set","address":"#old","content":"# New\n"}}"##,
        r##"{"text":"# New\n"}"##,
    );
}

/// `rename` of headings and labeled-close blocks, and `add` at the edges of a document.
#[test]
fn rename_and_add() {
    edit(
        r##"{"name":"rename a heading","geml":"# H {#h}\n\nSee [[#h]].\n","op":{"verb":"rename","old":"#h","new":"#h2"}}"##,
        r##"{"text":"# H {#h2}\n\nSee [[#h2]].\n"}"##,
    );
    edit(
        r##"{"name":"rename a labeled close","geml":"=== note {#n}\nx\n=== #n\n\nSee [[#n]].\n","op":{"verb":"rename","old":"#n","new":"#m"}}"##,
        r#"{"text":"=== note {#m}\nx\n=== #m\n\nSee [[#m]].\n"}"#,
    );
    edit(
        r##"{"name":"rename into an inner brace","geml":"# T {#t}\n\n## X {a {b}}\n","op":{"verb":"rename","old":"#t","new":"#u"}}"##,
        r##"{"text":"# T {#u}\n\n## X {a {b}}\n"}"##,
    );
    edit(
        r##"{"name":"rename a code block","geml":"=== code {#c}\n[[#c]]\n===\n\nSee [[#c]].\n","op":{"verb":"rename","old":"#c","new":"#d"}}"##,
        r#"{"text":"=== code {#d}\n[[#c]]\n===\n\nSee [[#d]].\n"}"#,
    );
    edit(r#"{"name":"add to a document with no final newline","geml":"x","op":{"verb":"add","content":"y\n","append":true}}"#, r#"{"text":"x\n\ny\n"}"#);
    edit(
        r##"{"name":"add an unclosed fence","geml":"=== note {#a}\nx\n===\n\n=== note {#b}\ny\n===\n","op":{"verb":"add","content":"=== code\nz\n","before":"#b"}}"##,
        r#"{"refused":"would-drop-unit"}"#,
    );
    edit(
        r##"{"name":"add before a heading line","geml":"# A {#a}\n\n# B {#b}\n","op":{"verb":"add","content":"mid\n","before":"# B"}}"##,
        r##"{"text":"# A {#a}\n\nmid\n\n# B {#b}\n"}"##,
    );
}

/// `list`: the shortest address of each unit — repeated prose, a shared id, one or several metas, anonymous blocks.
#[test]
fn listing_addresses() {
    edit(
        r#"{"name":"repeated prose","geml":"Same words.\n\nSame words.\n\nOther.\n","op":{"verb":"list"}}"#,
        r#"{"rows":[{"address":"@b0b6f860","anon":true,"kind":"prose","lines":[1,5]}]}"#,
    );
    edit(
        r##"{"name":"a shared id","geml":"# A {#x}\n\n=== note {#x}\nN\n===\n","op":{"verb":"list"}}"##,
        r##"{"rows":[{"address":"#x","id":"x","kind":"heading","level":1,"lines":[1,6],"text":"A"},{"address":"=== note","id":"x","kind":"note","lines":[3,5]}]}"##,
    );
    edit(
        r#"{"name":"one meta and anonymous blocks","geml":"=== meta\nk = 1\n===\n\n=== code\na\n===\n\n=== code\nb\n===\n\n=== math\nx\n===\n","op":{"verb":"list"}}"#,
        r##"{"rows":[{"address":"#meta","anon":true,"kind":"meta","lines":[1,3]},{"address":"=== code@c906da89","anon":true,"kind":"code","lines":[5,7]},{"address":"=== code@e64568fe","anon":true,"kind":"code","lines":[9,11]},{"address":"=== math","anon":true,"kind":"math","lines":[13,15]}]}"##,
    );
    edit(
        r#"{"name":"two metas","geml":"=== meta\nk = 1\n===\n\n=== meta\nj = 2\n===\n","op":{"verb":"list"}}"#,
        r#"{"rows":[{"address":"=== meta@841f629b","anon":true,"kind":"meta","lines":[1,3]},{"address":"=== meta@d711f7b0","anon":true,"kind":"meta","lines":[5,7]}]}"#,
    );
    edit(
        r#"{"name":"blank lines inside a block","geml":"=== code {#c}\n\n\nx\n\n\n===\n\n\n\n","op":{"verb":"list"}}"#,
        r##"{"rows":[{"address":"#c","id":"c","kind":"code","lines":[1,7]}]}"##,
    );
    edit(
        r##"{"name":"a section of blank lines","geml":"# A {#a}\n\n\n\n# B {#b}\n","op":{"verb":"list"}}"##,
        r##"{"rows":[{"address":"#a","id":"a","kind":"heading","level":1,"lines":[1,4],"text":"A"},{"address":"#b","id":"b","kind":"heading","level":1,"lines":[5,6],"text":"B"}]}"##,
    );
}

/// Edits in a Markdown document: errors it already had block nothing, a second copy of one does; content is Markdown.
#[test]
fn markdown_edits() {
    edit(
        r##"{"name":"an old error blocks nothing","geml":"# A\n\n[x](#gone)\n\n# B\n\nold\n","file":"doc.md","op":{"verb":"set","address":"#b","content":"new\n","part":"body"}}"##,
        r##"{"text":"# A\n\n[x](#gone)\n\n# B\n\nnew\n"}"##,
    );
    edit(
        r##"{"name":"a second copy of an old error","geml":"# A\n\n[x](#gone)\n\n# B\n\nold\n","file":"doc.md","op":{"verb":"set","address":"#b","content":"[y](#gone)\n","part":"body"}}"##,
        r#"{"diagnostics":["unresolved-reference:error"],"refused":"broken-result"}"#,
    );
    edit(
        r##"{"name":"a duplicate id is never forgiven","geml":"# A {#a}\n\n# B {#b}\n","file":"doc.md","op":{"verb":"add","content":"# C {#a}\n","append":true}}"##,
        r##"{"text":"# A {#a}\n\n# B {#b}\n\n# C\n"}"##,
    );
    edit(
        r##"{"name":"set a heading's intro","geml":"# A\n\nold\n\n## Sub\n\nx\n","file":"doc.md","op":{"verb":"set","address":"#a","content":"new `code` and ``a`b``\n","part":"intro"}}"##,
        r##"{"text":"# A\n\nnew `code` and ``a`b``\n\n## Sub\n\nx\n"}"##,
    );
    edit(
        r##"{"name":"set a heading with GEML content","geml":"# A\n\nold\n\n# B\n","file":"doc.md","op":{"verb":"set","address":"#a","content":"# A {#a}\n\n=== note\nx\n===\n"}}"##,
        r##"{"text":"# A\n\n> x\n# B\n"}"##,
    );
    edit(
        r##"{"name":"set a heading keeping its anchor","geml":"# A\n\nold\n\n# B\n","file":"doc.md","op":{"verb":"set","address":"#a","content":"# A\n\nnew\n"}}"##,
        r##"{"text":"# A\n\nnew\n# B\n"}"##,
    );
    edit(
        r##"{"name":"set a heading with a declared id","geml":"# A {#keep}\n\nSee [x](#keep).\n","file":"doc.md","op":{"verb":"set","address":"#keep","content":"# New\n"}}"##,
        r##"{"text":"# New {#keep}\n"}"##,
    );
    edit(
        r##"{"name":"set prose","geml":"# A\n\nold words\n","file":"doc.md","op":{"verb":"set","address":"L3","content":"new words\n"}}"##,
        r#"{"refused":"bad-content"}"#,
    );
    edit(
        r##"{"name":"add a footnote-like line","geml":"# A\n\nText.\n","file":"doc.md","op":{"verb":"add","content":"[^1]: note\n","append":true}}"##,
        r##"{"text":"# A\n\nText.\n\n[^1]: note\n"}"##,
    );
    edit(
        r##"{"name":"add with CRLF","geml":"# A\r\n\r\nText.\r\n","file":"doc.md","op":{"verb":"add","content":"More.","append":true}}"##,
        r##"{"text":"# A\r\n\r\nText.\r\n\r\nMore.\r\n"}"##,
    );
    edit(
        r##"{"name":"rename a heading's anchor","geml":"# A\n\nSee [x](#a) and [y](#a \"t\").\n","file":"doc.md","op":{"verb":"rename","old":"#a","new":"#b"}}"##,
        r#"{"refused":"rename-refused"}"#,
    );
    edit(
        r##"{"name":"replace in a Markdown document","geml":"# A\n\nold `old` text\n","file":"doc.md","op":{"verb":"replace","old":"old","new":"new"}}"##,
        r##"{"text":"# A\n\nnew `new` text\n"}"##,
    );
}

/// `revert`: revisions by id, resurrection placed by its neighbours or by hand, and removals refused.
#[test]
fn revert_paths() {
    edit(
        r##"{"name":"a revision by id","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nthird\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n","history":"# History of doc.geml\n\n=== meta\nprofile           = \"geml-history/v1\"\nhistory-of        = \"doc.geml\"\ngeml-version      = \"1.0\"\ncurrent           = \"20260101T000001Z-eb0c34a4\"\nkeyframe-interval = 10\n===\n\n# Committed-current mirror (always present):\n==== history-keyframe {id=\"20260101T000001Z-eb0c34a4\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\"}\n=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nsecond\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n====\n\n=== history-revision {id=\"20260101T000001Z-eb0c34a4\" parent=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v2\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\" newline=\"lf\"}\nreplace #alpha <- blob:b1\n===\n\n==== history-blob {#b1 lang=geml}\n=== note {#alpha}\nfirst\n===\n\n====\n\n=== history-revision {id=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v1\" hash=\"sha256:5b3ca2abb8f796509cc2b39048eac27745aeb78cf79f6646991a2194ebcd1a03\" newline=\"lf\"}\n===\n","op":{"verb":"revert","address":"#alpha","rev":"20260101T000000Z-5b3ca2ab"}}"##,
        r#"{"text":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nfirst\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n"}"#,
    );
    edit(
        r##"{"name":"a revision by prefix","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nthird\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n","history":"# History of doc.geml\n\n=== meta\nprofile           = \"geml-history/v1\"\nhistory-of        = \"doc.geml\"\ngeml-version      = \"1.0\"\ncurrent           = \"20260101T000001Z-eb0c34a4\"\nkeyframe-interval = 10\n===\n\n# Committed-current mirror (always present):\n==== history-keyframe {id=\"20260101T000001Z-eb0c34a4\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\"}\n=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nsecond\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n====\n\n=== history-revision {id=\"20260101T000001Z-eb0c34a4\" parent=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v2\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\" newline=\"lf\"}\nreplace #alpha <- blob:b1\n===\n\n==== history-blob {#b1 lang=geml}\n=== note {#alpha}\nfirst\n===\n\n====\n\n=== history-revision {id=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v1\" hash=\"sha256:5b3ca2abb8f796509cc2b39048eac27745aeb78cf79f6646991a2194ebcd1a03\" newline=\"lf\"}\n===\n","op":{"verb":"revert","address":"#alpha","rev":"20260101T000000Z"}}"##,
        r#"{"text":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nfirst\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n"}"#,
    );
    edit(
        r##"{"name":"a revision that is not there","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nthird\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n","history":"# History of doc.geml\n\n=== meta\nprofile           = \"geml-history/v1\"\nhistory-of        = \"doc.geml\"\ngeml-version      = \"1.0\"\ncurrent           = \"20260101T000001Z-eb0c34a4\"\nkeyframe-interval = 10\n===\n\n# Committed-current mirror (always present):\n==== history-keyframe {id=\"20260101T000001Z-eb0c34a4\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\"}\n=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nsecond\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n====\n\n=== history-revision {id=\"20260101T000001Z-eb0c34a4\" parent=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v2\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\" newline=\"lf\"}\nreplace #alpha <- blob:b1\n===\n\n==== history-blob {#b1 lang=geml}\n=== note {#alpha}\nfirst\n===\n\n====\n\n=== history-revision {id=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v1\" hash=\"sha256:5b3ca2abb8f796509cc2b39048eac27745aeb78cf79f6646991a2194ebcd1a03\" newline=\"lf\"}\n===\n","op":{"verb":"revert","address":"#alpha","rev":"nope"}}"##,
        r#"{"refused":"revert-refused"}"#,
    );
    edit(
        r##"{"name":"an offset past the chain","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nthird\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n","history":"# History of doc.geml\n\n=== meta\nprofile           = \"geml-history/v1\"\nhistory-of        = \"doc.geml\"\ngeml-version      = \"1.0\"\ncurrent           = \"20260101T000001Z-eb0c34a4\"\nkeyframe-interval = 10\n===\n\n# Committed-current mirror (always present):\n==== history-keyframe {id=\"20260101T000001Z-eb0c34a4\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\"}\n=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nsecond\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n====\n\n=== history-revision {id=\"20260101T000001Z-eb0c34a4\" parent=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v2\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\" newline=\"lf\"}\nreplace #alpha <- blob:b1\n===\n\n==== history-blob {#b1 lang=geml}\n=== note {#alpha}\nfirst\n===\n\n====\n\n=== history-revision {id=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v1\" hash=\"sha256:5b3ca2abb8f796509cc2b39048eac27745aeb78cf79f6646991a2194ebcd1a03\" newline=\"lf\"}\n===\n","op":{"verb":"revert","address":"#alpha","rev":"-9"}}"##,
        r#"{"refused":"revert-refused"}"#,
    );
    edit(
        r##"{"name":"resurrect at the end","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nthird\n===\n\nBetween alpha and beta.\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n","history":"# History of doc.geml\n\n=== meta\nprofile           = \"geml-history/v1\"\nhistory-of        = \"doc.geml\"\ngeml-version      = \"1.0\"\ncurrent           = \"20260101T000001Z-eb0c34a4\"\nkeyframe-interval = 10\n===\n\n# Committed-current mirror (always present):\n==== history-keyframe {id=\"20260101T000001Z-eb0c34a4\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\"}\n=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nsecond\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n====\n\n=== history-revision {id=\"20260101T000001Z-eb0c34a4\" parent=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v2\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\" newline=\"lf\"}\nreplace #alpha <- blob:b1\n===\n\n==== history-blob {#b1 lang=geml}\n=== note {#alpha}\nfirst\n===\n\n====\n\n=== history-revision {id=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v1\" hash=\"sha256:5b3ca2abb8f796509cc2b39048eac27745aeb78cf79f6646991a2194ebcd1a03\" newline=\"lf\"}\n===\n","op":{"verb":"revert","address":"#beta","rev":"0","append":true}}"##,
        r#"{"text":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nthird\n===\n\nBetween alpha and beta.\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n=== note {#beta}\nsee [[#alpha]]\n===\n"}"#,
    );
    edit(
        r##"{"name":"resurrect after","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nthird\n===\n\nBetween alpha and beta.\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n","history":"# History of doc.geml\n\n=== meta\nprofile           = \"geml-history/v1\"\nhistory-of        = \"doc.geml\"\ngeml-version      = \"1.0\"\ncurrent           = \"20260101T000001Z-eb0c34a4\"\nkeyframe-interval = 10\n===\n\n# Committed-current mirror (always present):\n==== history-keyframe {id=\"20260101T000001Z-eb0c34a4\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\"}\n=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nsecond\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n====\n\n=== history-revision {id=\"20260101T000001Z-eb0c34a4\" parent=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v2\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\" newline=\"lf\"}\nreplace #alpha <- blob:b1\n===\n\n==== history-blob {#b1 lang=geml}\n=== note {#alpha}\nfirst\n===\n\n====\n\n=== history-revision {id=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v1\" hash=\"sha256:5b3ca2abb8f796509cc2b39048eac27745aeb78cf79f6646991a2194ebcd1a03\" newline=\"lf\"}\n===\n","op":{"verb":"revert","address":"#beta","rev":"0","after":"#intro"}}"##,
        r#"{"text":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nthird\n===\n\nBetween alpha and beta.\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n=== note {#beta}\nsee [[#alpha]]\n===\n"}"#,
    );
    edit(
        r##"{"name":"resurrect before a later neighbour","geml":"=== note {#alpha}\nsecond\n===\n\n## Other {#other}\n\ntail\n","history":"# History of doc.geml\n\n=== meta\nprofile           = \"geml-history/v1\"\nhistory-of        = \"doc.geml\"\ngeml-version      = \"1.0\"\ncurrent           = \"20260101T000001Z-eb0c34a4\"\nkeyframe-interval = 10\n===\n\n# Committed-current mirror (always present):\n==== history-keyframe {id=\"20260101T000001Z-eb0c34a4\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\"}\n=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nsecond\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n====\n\n=== history-revision {id=\"20260101T000001Z-eb0c34a4\" parent=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v2\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\" newline=\"lf\"}\nreplace #alpha <- blob:b1\n===\n\n==== history-blob {#b1 lang=geml}\n=== note {#alpha}\nfirst\n===\n\n====\n\n=== history-revision {id=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v1\" hash=\"sha256:5b3ca2abb8f796509cc2b39048eac27745aeb78cf79f6646991a2194ebcd1a03\" newline=\"lf\"}\n===\n","op":{"verb":"revert","address":"#intro","rev":"0"}}"##,
        r#"{"diagnostics":["duplicate-id:error","duplicate-id:error"],"refused":"broken-result"}"#,
    );
    edit(
        r##"{"name":"resurrect with no neighbour","geml":"Nothing here.\n","history":"# History of doc.geml\n\n=== meta\nprofile           = \"geml-history/v1\"\nhistory-of        = \"doc.geml\"\ngeml-version      = \"1.0\"\ncurrent           = \"20260101T000001Z-eb0c34a4\"\nkeyframe-interval = 10\n===\n\n# Committed-current mirror (always present):\n==== history-keyframe {id=\"20260101T000001Z-eb0c34a4\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\"}\n=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nsecond\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n====\n\n=== history-revision {id=\"20260101T000001Z-eb0c34a4\" parent=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v2\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\" newline=\"lf\"}\nreplace #alpha <- blob:b1\n===\n\n==== history-blob {#b1 lang=geml}\n=== note {#alpha}\nfirst\n===\n\n====\n\n=== history-revision {id=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v1\" hash=\"sha256:5b3ca2abb8f796509cc2b39048eac27745aeb78cf79f6646991a2194ebcd1a03\" newline=\"lf\"}\n===\n","op":{"verb":"revert","address":"#alpha","rev":"0"}}"##,
        r#"{"text":"Nothing here.\n\n=== note {#alpha}\nsecond\n===\n"}"#,
    );
    edit(
        r##"{"name":"remove: looks renamed from","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nthird\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snip lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n","history":"# History of doc.geml\n\n=== meta\nprofile           = \"geml-history/v1\"\nhistory-of        = \"doc.geml\"\ngeml-version      = \"1.0\"\ncurrent           = \"20260101T000001Z-eb0c34a4\"\nkeyframe-interval = 10\n===\n\n# Committed-current mirror (always present):\n==== history-keyframe {id=\"20260101T000001Z-eb0c34a4\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\"}\n=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nsecond\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n====\n\n=== history-revision {id=\"20260101T000001Z-eb0c34a4\" parent=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v2\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\" newline=\"lf\"}\nreplace #alpha <- blob:b1\n===\n\n==== history-blob {#b1 lang=geml}\n=== note {#alpha}\nfirst\n===\n\n====\n\n=== history-revision {id=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v1\" hash=\"sha256:5b3ca2abb8f796509cc2b39048eac27745aeb78cf79f6646991a2194ebcd1a03\" newline=\"lf\"}\n===\n","op":{"verb":"revert","address":"#snip","rev":"0"}}"##,
        r#"{"refused":"revert-refused"}"#,
    );
    edit(
        r##"{"name":"remove: would break a reference","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nthird\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n=== note {#gamma}\nx\n===\n\nSee [[#gamma]].\n","history":"# History of doc.geml\n\n=== meta\nprofile           = \"geml-history/v1\"\nhistory-of        = \"doc.geml\"\ngeml-version      = \"1.0\"\ncurrent           = \"20260101T000001Z-eb0c34a4\"\nkeyframe-interval = 10\n===\n\n# Committed-current mirror (always present):\n==== history-keyframe {id=\"20260101T000001Z-eb0c34a4\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\"}\n=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nsecond\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n====\n\n=== history-revision {id=\"20260101T000001Z-eb0c34a4\" parent=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v2\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\" newline=\"lf\"}\nreplace #alpha <- blob:b1\n===\n\n==== history-blob {#b1 lang=geml}\n=== note {#alpha}\nfirst\n===\n\n====\n\n=== history-revision {id=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v1\" hash=\"sha256:5b3ca2abb8f796509cc2b39048eac27745aeb78cf79f6646991a2194ebcd1a03\" newline=\"lf\"}\n===\n","op":{"verb":"revert","address":"#gamma","rev":"0"}}"##,
        r#"{"diagnostics":["unresolved-reference:error"],"refused":"broken-result"}"#,
    );
    edit(
        r##"{"name":"changed: absent from every revision","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nthird\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n=== note {#gamma}\nx\n===\n","history":"# History of doc.geml\n\n=== meta\nprofile           = \"geml-history/v1\"\nhistory-of        = \"doc.geml\"\ngeml-version      = \"1.0\"\ncurrent           = \"20260101T000001Z-eb0c34a4\"\nkeyframe-interval = 10\n===\n\n# Committed-current mirror (always present):\n==== history-keyframe {id=\"20260101T000001Z-eb0c34a4\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\"}\n=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nsecond\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n====\n\n=== history-revision {id=\"20260101T000001Z-eb0c34a4\" parent=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v2\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\" newline=\"lf\"}\nreplace #alpha <- blob:b1\n===\n\n==== history-blob {#b1 lang=geml}\n=== note {#alpha}\nfirst\n===\n\n====\n\n=== history-revision {id=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v1\" hash=\"sha256:5b3ca2abb8f796509cc2b39048eac27745aeb78cf79f6646991a2194ebcd1a03\" newline=\"lf\"}\n===\n","op":{"verb":"revert","address":"#gamma","rev":"changed"}}"##,
        r#"{"refused":"revert-refused"}"#,
    );
    edit(
        r##"{"name":"head of a heading","geml":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nthird\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Changed {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n","history":"# History of doc.geml\n\n=== meta\nprofile           = \"geml-history/v1\"\nhistory-of        = \"doc.geml\"\ngeml-version      = \"1.0\"\ncurrent           = \"20260101T000001Z-eb0c34a4\"\nkeyframe-interval = 10\n===\n\n# Committed-current mirror (always present):\n==== history-keyframe {id=\"20260101T000001Z-eb0c34a4\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\"}\n=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nsecond\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n\n====\n\n=== history-revision {id=\"20260101T000001Z-eb0c34a4\" parent=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v2\" hash=\"sha256:eb0c34a459d72ac2ece5c518bd1c847a45c385ee7276ca0a9453a8680f774d9e\" newline=\"lf\"}\nreplace #alpha <- blob:b1\n===\n\n==== history-blob {#b1 lang=geml}\n=== note {#alpha}\nfirst\n===\n\n====\n\n=== history-revision {id=\"20260101T000000Z-5b3ca2ab\" author=\"suite\" summary=\"v1\" hash=\"sha256:5b3ca2abb8f796509cc2b39048eac27745aeb78cf79f6646991a2194ebcd1a03\" newline=\"lf\"}\n===\n","op":{"verb":"revert","address":"#sub","rev":"0","head":true}}"##,
        r#"{"text":"=== meta\ntitle = \"Doc\"\n===\n\n# Intro {#intro}\n\nOpening words.\n\n=== note {#alpha}\nthird\n===\n\nBetween alpha and beta.\n\n=== note {#beta}\nsee [[#alpha]]\n===\n\n## Sub {#sub}\n\nunder sub\n\n=== code {#snippet lang=py}\nprint(1)\n===\n\n### Deep {#deep}\n\ndeepest\n\n## Other {#other}\n\ntail\n"}"#,
    );
}
