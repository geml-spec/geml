//! `geml-style/v1`: selectors (§3), arbitration and layers (§4), states,
//! screens and frames (§2.2–§2.4), tokens and embeds (§1.1, §1.2), and the view
//! model (§10).

use geml::check::style::{check, parse_selector, Registries, ViewModel};
use geml::host::MapHost;
use geml::{parse_with, Document, Options};

const META: &str = "=== meta\nprofile = \"geml-style/v1\"\n===\n\n";

fn doc(name: &str, src: &str) -> Document {
    parse_with(src, &Options { name: name.into(), ..Default::default() })
}

fn sheet(src: &str) -> Document {
    doc("site.style.geml", &format!("{META}{src}"))
}

const CORPUS: &str = r##"# Guide {#guide .wide}

Intro prose.

==== note {#tip .warn level=2}
Inside the **tip**.

=== code {#snippet lang=rust}
fn main() {}
===
====

=== table {#calls format=csv}
from, to
a, b
===

## Part {#part}

=== code {lang=sh}
ls
===

Closing words.
"##;

fn corpus() -> Document {
    doc("docs/guide.geml", CORPUS)
}

fn solve(src: &str) -> ViewModel {
    solve_with(src, &Registries::default(), None)
}

fn solve_with(src: &str, reg: &Registries, host: Option<&MapHost>) -> ViewModel {
    let c = corpus();
    check(&sheet(src), &[&c], reg, host.map(|h| h as &dyn geml::host::Host))
}

fn diags(vm: &ViewModel) -> Vec<String> {
    vm.diagnostics.iter().map(|d| format!("{} {} {}", d.level.as_str(), d.code, d.address)).collect()
}

fn targets(vm: &ViewModel) -> Vec<String> {
    vm.bindings.iter().map(|b| format!("{}{}{}", b.doc, b.block, b.part.as_ref().map(|p| format!(" {p}")).unwrap_or_default())).collect()
}

#[test]
fn selectors_take_the_subset_the_grammar_admits() {
    let ok = parse_selector("note.warn#tip[level=2][lang], heading code, *, table[title=\"a > b: c\"] link").unwrap_err();
    assert_eq!(ok, "a selector mixes inline-part branches with block branches");
    let b = parse_selector("note.warn#tip[level=\"2\"][lang], heading code").unwrap();
    assert_eq!(b.len(), 2);
    assert_eq!(
        (b[0].steps[0].ty.as_deref(), b[0].steps[0].id.as_deref(), b[0].steps[0].classes.clone()),
        (Some("note"), Some("tip"), vec!["warn".to_string()])
    );
    assert_eq!(b[0].steps[0].attrs, vec![("level".to_string(), Some("2".to_string())), ("lang".to_string(), None)]);
    assert_eq!(b[1].steps.len(), 2);
    assert!(parse_selector("*").unwrap()[0].steps[0].any);
    assert_eq!(parse_selector("table[title='a > b'] link").unwrap()[0].part.as_deref(), Some("link"));
    for (s, why) in [
        ("note > code", "the `>` combinator"),
        ("note + code", "the `+` combinator"),
        ("note ~ code", "the `~` combinator"),
        ("note:hover", "a pseudo-class"),
        ("note[k^=v]", "the `^=` substring match"),
        ("note[k*=v]", "the `*=` substring match"),
        ("no*te", "`*` inside `no*te`: the universal selector is a whole step only"),
        ("note#", "`note#` has an empty `#`"),
        ("note[k", "`note[k` has an unclosed `[`"),
        ("note!", "`note!` is not a simple selector"),
        ("note link.x", "the inline part `link` takes no filter"),
        (" , ", "an empty selector"),
    ] {
        assert_eq!(parse_selector(s).unwrap_err(), why, "{s}");
    }
}

#[test]
fn rules_bind_to_the_blocks_they_match() {
    let vm = solve("=== style-rule {match=\"heading\" color=red}\n===\n\n=== style-rule {match=\"note code\" padding=4}\n===\n\n=== style-rule {match=prose font-size=14}\n===\n\n=== style-rule {match=\"heading#guide code[lang=sh]\" margin=2}\n===\n\n=== style-rule {match=\"note strong\" color=blue}\n===\n");
    assert_eq!(diags(&vm), Vec::<String>::new());
    assert_eq!(
        targets(&vm),
        vec![
            // Profile §10: node order, a part right after its node. The prose
            // inside `#tip`'s body is that block's content, not a node (§3).
            "docs/guide.geml#guide",
            "docs/guide.geml#guide-before-tip",
            "docs/guide.geml#tip strong",
            "docs/guide.geml#snippet",
            "docs/guide.geml#part",
            "docs/guide.geml[6]",
            // Prose after an anonymous block has no address (§4); profile §10
            // names it `[n]`, its position among the nodes a selector can match.
            "docs/guide.geml[7]",
        ]
    );
}

#[test]
fn the_rule_with_more_conditions_wins_and_equal_ones_conflict() {
    let vm = solve(concat!(
        "=== style-rule {#base match=code color=gray padding=1}\n===\n\n",
        "=== style-rule {#lang match=\"code[lang=rust]\" color=green}\n===\n\n",
        "=== style-rule {#twin match=\"code[lang=rust]\" color=teal}\n===\n\n",
        "=== style-rule {#by-id match=\"#snippet\" padding=2}\n===\n\n",
        "=== style-rule {#all match=\"code\" border=\"1px solid\"}\n===\n\n",
        "=== style-rule {#side match=\"code\" border-top=\"2px solid\"}\n===\n",
    ));
    let snippet = vm.bindings.iter().find(|b| b.block == "#snippet").unwrap();
    assert_eq!(snippet.rules, vec!["#base", "#lang", "#twin", "#by-id", "#all", "#side"]);
    assert_eq!(
        diags(&vm),
        vec![
            "warning style-ambiguous-rule docs/guide.geml#snippet",
            "warning style-ambiguous-rule docs/guide.geml#snippet",
            "warning style-ambiguous-rule docs/guide.geml#snippet",
            "warning style-ambiguous-rule docs/guide.geml[6]",
        ]
    );
    let m: Vec<&str> = vm.diagnostics.iter().map(|d| d.message.as_str()).collect();
    assert_eq!(
        m[0],
        "#lang and #twin have one selector and both set `color`: delete one, or add a condition that tells them apart; #lang is written first and keeps it"
    );
    assert_eq!(m[1], "#base and #by-id both set `padding` and neither's conditions contain the other's: write a rule with the union of both; #base is written first and keeps it");
    assert_eq!(m[2], "#all sets `border` and #side sets `border-top`: a shorthand and one of its sides in one layer, where the result would depend on which lands last; the word written first stays");
    // §4: a contested word carries the first-written rule's value — #lang's
    // green over #twin's (both beat #base), #base's padding over #by-id's —
    // and of `border` / `border-top` the word written first stays.
    let words: Vec<(&str, Option<String>)> = snippet.box_.iter().map(|(k, v)| (k.as_str(), v.scalar_text())).collect();
    assert_eq!(words, vec![("color", Some("green".into())), ("padding", Some("1".into())), ("border", Some("1px solid".into()))]);
}

#[test]
fn when_makes_variants_and_exclusive_ones_never_meet() {
    let vm = solve(concat!(
        "=== style-state {#mode match=\"table#calls\" on=select value-from=to}\n===\n\n",
        "=== style-state {#open match=heading on=toggle init-value=true type=flag}\n===\n\n",
        "=== style-rule {#a match=\"#calls\" color=red}\n===\n\n",
        "=== style-rule {#b match=\"#calls\" when=\"$mode=x\" color=blue}\n===\n\n",
        "=== style-rule {#c match=\"#calls\" when=\"$mode=y\" color=green}\n===\n\n",
        "=== style-rule {#d match=\"#calls\" when=\"$open=1\" color=black}\n===\n\n",
        "=== style-rule {#e match=\"#calls\" when=\"@hover, $mode=x\" background=white}\n===\n\n",
        "=== style-rule {#f match=\"table#calls\" when=\"$open=1\" color=pink}\n===\n",
    ));
    let calls = vm.bindings.iter().find(|b| b.block == "#calls").unwrap();
    let whens: Vec<String> = calls.variants.iter().map(|v| v.when.iter().map(|(k, x)| format!("{k}={x}")).collect::<Vec<_>>().join("&")).collect();
    // §4 step 2: #d and #f share their `when`, and #f's type step makes it
    // the holder. Step 3: #b and #c cannot both hold; each can hold with #f and
    // neither is comparable to it, so the `$open=1` set, written later, loses
    // `color` — reported once for that set and word — and, left with no word,
    // is no variant. #e sets nothing the others set.
    assert_eq!(whens, vec!["mode=x", "mode=y", "@hover=true&mode=x"]);
    assert_eq!(diags(&vm), vec!["warning style-ambiguous-rule docs/guide.geml#calls"]);
    let variant = |s: &str, v: &str| calls.variants.iter().find(|x| x.when == vec![(s.to_string(), v.to_string())]).unwrap();
    assert_eq!(variant("mode", "x").box_[0].1.scalar_text().as_deref(), Some("blue"));
    assert_eq!(variant("mode", "y").box_[0].1.scalar_text().as_deref(), Some("green"));
}

#[test]
fn words_split_into_box_and_params_and_params_need_a_receiver() {
    let vm = solve(concat!(
        "=== style-rule {match=\"#calls\" component=graph depth=2 color=red}\n===\n\n",
        "=== style-rule {match=\"#tip\" depth=3 show=all}\n===\n\n",
        "=== style-rule {match=\"note strong\" color=red axis=row}\n===\n",
    ));
    let calls = vm.bindings.iter().find(|b| b.block == "#calls").unwrap();
    assert_eq!(calls.params.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), vec!["component", "depth"]);
    assert_eq!(calls.box_.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), vec!["color"]);
    // A block-only word on a part rule is reported once, on the rule (§2.1).
    assert_eq!(diags(&vm), vec!["warning style-unknown-attribute site.style.geml ([2])", "warning style-unknown-attribute docs/guide.geml#tip"]);
    assert_eq!(vm.diagnostics[0].message, "`axis` means nothing on an inline part, and is dropped");
    assert_eq!(vm.diagnostics[1].message, "[1] set `depth` with no `component=` or `handler=` to receive it");
}

#[test]
fn a_part_name_in_the_first_step_is_read_as_a_block_type() {
    // Profile §3: a part needs a block step before it, so in the first step the
    // name can only be a type; the author is told what a part would need.
    let vm = solve("=== style-rule {#r match=link color=red}\n===\n\n=== style-state {#s match=image on=select}\n===\n");
    assert_eq!(
        diags(&vm),
        vec![
            "warning style-reserved-name site.style.geml#s",
            "warning style-unmatched-producer site.style.geml#s",
            "warning style-reserved-name site.style.geml#r",
            "warning style-unmatched-rule site.style.geml#r",
        ]
    );
    assert_eq!(vm.diagnostics[2].message, "`link` is read as a block type here; the inline part of that name needs a block step before it (`text#nav link`)");
}

#[test]
fn states_declare_what_feeds_them() {
    let vm = solve(concat!(
        "=== style-state {#hover match=heading on=select}\n===\n\n",
        "=== style-state {#a match=\"#calls\" on=select value-from=nope colour=1}\n===\n\n",
        "=== style-state {#b match=\"#nothing\" on=drag}\n===\n\n",
        "=== style-state {#c}\n===\n\n",
        "=== style-state {#d match=\"note > code\" on=toggle}\n===\n",
    ));
    assert_eq!(
        diags(&vm),
        vec![
            "warning style-unknown-attribute site.style.geml#a",
            "error style-unknown-value-source site.style.geml#a",
            "error style-unknown-interaction site.style.geml#b",
            "warning style-unmatched-producer site.style.geml#b",
            "error style-missing-attribute site.style.geml#c",
            "error style-missing-attribute site.style.geml#c",
            "error style-selector-unsupported site.style.geml#d",
        ]
    );
    assert_eq!(vm.states.iter().map(|s| s.ty.as_str()).collect::<Vec<_>>(), vec!["block-ref"; 5]);
}

#[test]
fn screens_and_frames_form_a_graph() {
    let mut frames = String::new();
    // A chain of seventeen frames under one screen is one too deep.
    for i in 0..17 {
        frames += &format!("=== style-frame {{#f{i} slots=\"#f{}\"}}\n===\n\n", i + 1);
    }
    frames += "=== style-frame {#f17 slots=heading}\n===\n\n";
    let vm = solve(&format!(
        "{frames}=== style-screen {{#deep slots=\"#f0\"}}\n===\n\n=== style-screen {{#home slots=\"$sel, $gone, #deep, #nope, note > code, note link, #loop-a, table#none\" axis=row knob=1}}\n===\n\n=== style-screen {{#bare}}\n===\n\n=== style-frame {{#loop-a slots=\"#loop-b\"}}\n===\n\n=== style-frame {{#loop-b slots=\"#loop-a\" component=pane knob=1}}\n===\n\n=== style-frame {{#spare slots=prose}}\n===\n\n=== style-state {{#sel match=heading on=select}}\n===\n"
    ));
    assert_eq!(
        diags(&vm),
        vec![
            "error style-unknown-state site.style.geml#home",
            "error style-screen-nested site.style.geml#home",
            "error style-unknown-frame site.style.geml#home",
            "error style-selector-unsupported site.style.geml#home",
            "error style-selector-unsupported site.style.geml#home",
            "warning style-unmatched-rule site.style.geml#home",
            "warning style-unknown-attribute site.style.geml#home",
            "error style-missing-attribute site.style.geml#bare",
            "error style-frame-too-deep site.style.geml#deep",
            "warning style-unused-frame site.style.geml#spare",
            "error style-frame-cycle site.style.geml",
        ]
    );
    assert_eq!(vm.diagnostics.last().unwrap().message, "frames nest in a cycle: #loop-a → #loop-b → #loop-a");
    let home = vm.screens.iter().find(|s| s.id == "home").unwrap();
    assert_eq!(home.axis, "row");
    assert_eq!(home.slots.len(), 6);
}

#[test]
fn registries_are_declared_as_json() {
    assert_eq!(Registries::from_json("  ").unwrap(), Registries::default());
    assert_eq!(Registries::from_json(r#"{"handlers": ["open"]}"#).unwrap(), Registries { components: None, handlers: Some(vec!["open".into()]) });
    assert_eq!(Registries::from_json("{").unwrap_err(), "the registries are not JSON: expected a member name");
    assert_eq!(Registries::from_json(r#"{"components": "graph"}"#).unwrap_err(), "`components` is not an array");
    assert_eq!(Registries::from_json(r#"{"components": [1]}"#).unwrap_err(), "`components` holds a non-string");
}

#[test]
fn a_rule_names_only_what_the_sheet_declares() {
    let reg = Registries::from_json(r#"{"components": ["graph"], "handlers": ["open"]}"#).unwrap();
    let vm = solve_with(
        concat!(
            "=== style-screen {#home slots=heading}\n===\n\n",
            "=== style-rule {match=heading show=$nope screen=\"home away\" component=chart handler=close}\n===\n\n",
            "=== style-rule {match=heading when=\"$ghost=1\"}\n===\n\n",
            "=== style-rule {match=heading when=\"sel\"}\n===\n\n",
            "=== style-rule {match=heading when=\"@pressed\"}\n===\n\n",
            "=== style-rule {color=red}\n===\n\n",
            "=== style-rule {match=\"heading:first\"}\n===\n\n",
            "=== style-rule {match=\"#nowhere\"}\n===\n\n",
            "=== style-rule {match=heading component=graph handler=open axis=sideways fade-out=90 hide-below=wide}\n===\n",
        ),
        &reg,
        None,
    );
    assert_eq!(
        diags(&vm),
        vec![
            "error style-invalid-value site.style.geml ([7])",
            "error style-invalid-value site.style.geml ([7])",
            "error style-invalid-value site.style.geml ([7])",
            "error style-unknown-state site.style.geml ([0])",
            "error style-unknown-screen site.style.geml ([0])",
            "warning style-unknown-component site.style.geml ([0])",
            "warning style-unknown-handler site.style.geml ([0])",
            "error style-unknown-state site.style.geml ([1])",
            "error style-invalid-value site.style.geml ([2])",
            "error style-invalid-value site.style.geml ([3])",
            "error style-missing-attribute site.style.geml ([4])",
            "error style-selector-unsupported site.style.geml ([5])",
            "warning style-unmatched-rule site.style.geml ([6])",
        ]
    );
    // A screen-qualified rule binds on its screen only.
    assert!(vm.bindings.iter().all(|b| !b.rules.contains(&"[0]".to_string())));
    assert!(vm.screens[0].bindings.iter().any(|b| b.rules.contains(&"[0]".to_string())));
}

#[test]
fn every_closed_domain_is_checked() {
    let bad = "axis=x anchor=x place=x scroll=x sticky=x visible=x view=x hide-below=x fade-out=x";
    let good = "axis=row anchor=flow place=center scroll=own sticky=top visible=yes view=source hide-below=600 fade-out=3";
    let vm = solve(&format!("=== style-rule {{match=heading {bad}}}\n===\n\n=== style-rule {{match=heading {good}}}\n===\n"));
    let invalid: Vec<&str> = vm.diagnostics.iter().filter(|d| d.code == "style-invalid-value").map(|d| d.message.as_str()).collect();
    assert_eq!(invalid.len(), 9, "{invalid:?}");
    assert_eq!(invalid[0], "`axis=x` is outside its domain (row | column)");
}

#[test]
fn tokens_come_from_the_sheets_meta() {
    let vm = check(
        &doc("site.style.geml", "=== meta\nprofile = \"geml-style/v1\"\naccent = \"#c00\"\nwide = 960\n===\n\n=== style-rule {match=heading color=\"{{accent}}\" max-width=\"{{wide}}\" border=\"1px solid {{accent}}\" margin=\"{{ missing }}\" padding=\"{{unclosed\"}\n===\n"),
        &[&corpus()],
        &Registries::default(),
        None,
    );
    assert_eq!(diags(&vm), vec!["error style-unknown-token site.style.geml"]);
    let b = &vm.bindings[0].box_;
    assert_eq!(
        geml::json::to_json(&geml::json::Value::Object(b.clone())),
        r##"{"color":"#c00","max-width":960,"border":"1px solid #c00","margin":"{{ missing }}","padding":"{{unclosed"}"##
    );
}

fn files(pairs: &[(&str, &str)]) -> MapHost {
    let mut h = MapHost::default();
    for (k, v) in pairs {
        h.files.insert(k.to_string(), v.to_string());
    }
    h
}

#[test]
fn layers_let_the_entry_override_its_template_and_the_default() {
    let base = format!("{META}=== style-rule {{match=heading color=gray padding=1 margin=1}}\n===\n");
    let tpl = format!("{META}=== style-rule {{#t match=heading color=blue padding=2}}\n===\n\n=== style-rule {{#other match=code}}\n===\n");
    let h = files(&[("base.style.geml", &base), ("tpl.style.geml", &tpl), ("docs/guide.geml", CORPUS)]);
    let entry = doc(
        "site.style.geml",
        "=== meta\nprofile = \"geml-style/v1\"\ndefault-style = \"base.style.geml\"\n===\n\n=== table {#sitemap format=csv}\ndocument, template\ndocs/guide.geml, tpl.style.geml#t\nother.geml, tpl.style.geml\n===\n\n=== style-rule {#mine match=heading color=red}\n===\n",
    );
    let c = corpus();
    let vm = check(&entry, &[&c], &Registries::default(), Some(&h));
    assert_eq!(diags(&vm), Vec::<String>::new());
    let g = vm.bindings.iter().find(|b| b.block == "#guide").unwrap();
    assert_eq!(geml::json::to_json(&geml::json::Value::Object(g.box_.clone())), r#"{"color":"red","padding":2,"margin":1}"#);
    assert_eq!(g.rules, vec!["[0]", "#t", "#mine"]);
    // Two corpus documents: no single entry document, so no sitemap layer.
    let other = doc("other.geml", "# Other\n");
    let vm = check(&entry, &[&c, &other], &Registries::default(), Some(&h));
    assert_eq!(vm.bindings.iter().find(|b| b.block == "#guide").unwrap().rules, vec!["[0]", "#mine"]);
}

#[test]
fn an_embed_that_contributes_nothing_says_so() {
    let looped = format!("{META}=== embed {{src=site.style.geml}}\n===\n");
    // Nothing but `meta`: a whole file selects what is not `meta` (§1.1).
    let empty = META.to_string();
    let src = "=== embed {src=loop.style.geml}\n===\n\n=== embed {src=empty.style.geml}\n===\n\n=== embed {src=gone.style.geml}\n===\n";
    let site = format!("{META}{src}");
    let h = files(&[("loop.style.geml", &looped), ("empty.style.geml", &empty), ("site.style.geml", &site)]);
    let vm = solve_with(src, &Registries::default(), Some(&h));
    let m: Vec<String> = vm.diagnostics.iter().map(|d| format!("{}: {}", d.address, d.message)).collect();
    assert_eq!(
        m,
        vec![
            // The entry is on the chain from the start, so embedding it back is a cycle.
            "loop.style.geml (embed site.style.geml): `embed` of `site.style.geml` contributed no rules: `site.style.geml` is already being expanded (cycle)",
            "site.style.geml (embed empty.style.geml): `embed` of `empty.style.geml` contributed no rules: the target is empty",
            "site.style.geml (embed gone.style.geml): `embed` of `gone.style.geml` contributed no rules: cannot resolve `gone.style.geml`",
        ]
    );
    let alone = solve(src);
    assert_eq!(
        diags(&alone),
        vec![
            "warning style-embed-not-expanded site.style.geml (embed loop.style.geml)",
            "warning style-embed-not-expanded site.style.geml (embed empty.style.geml)",
            "warning style-embed-not-expanded site.style.geml (embed gone.style.geml)",
        ]
    );
    // `geml check` on the sheet alone leaves embeds to `geml style check`.
    let d = geml::parse(&format!("{META}{src}=== style-rule {{match=heading on=1 axis=up}}\n===\n"));
    let codes: Vec<&str> = d.profile_diagnostics.iter().map(|x| x.code).collect();
    assert_eq!(codes, vec!["style-invalid-value"]);
}

#[test]
fn the_corpus_takes_in_what_its_documents_embed() {
    let part = "# Appendix {#appendix}\n\n=== code {#tail}\nx\n===\n\n# Other {#other}\n\n=== code {#elsewhere}\ny\n===\n";
    let h = files(&[("docs/part.geml", part), ("docs/whole.geml", "=== code {#w}\nw\n===\n")]);
    let main = doc("docs/main.geml", "=== embed {src=part.geml#appendix}\n===\n\n=== embed {src=whole.geml}\n===\n\n=== embed {src=pic.png}\n===\n\n=== embed {src=gone.geml}\n===\n\n=== embed {src=#local}\n===\n");
    let s = sheet("=== style-rule {match=code color=red}\n===\n");
    let vm = check(&s, &[&main], &Registries::default(), Some(&h));
    // §3: a document joins whole, whatever block or section the `embed` selects.
    assert_eq!(targets(&vm), vec!["docs/part.geml#tail", "docs/part.geml#elsewhere", "docs/whole.geml#w"]);
}

#[test]
fn the_view_model_is_one_json_shape() {
    let vm = solve(concat!(
        "=== style-state {#sel match=\"table#calls\" on=select value-from=to init-value=1}\n===\n\n",
        "=== style-screen {#home slots=\"#body, $sel\" component=shell}\n===\n\n",
        "=== style-frame {#body slots=\"table#calls\" axis=row}\n===\n\n",
        "=== style-rule {match=\"table#calls\" component=graph when=\"$sel=a\" color=red}\n===\n\n",
        "=== style-rule {match=\"#part\" screen=home color=blue}\n===\n\n",
        "=== style-rule {match=\"#tip strong\" color=green}\n===\n",
    ));
    assert_eq!(
        vm.to_json(),
        concat!(
            r##"{"states":[{"id":"sel","type":"block-ref","on":"select","valueFrom":"to","initValue":"1"}],"##,
            r##""screens":[{"id":"home","axis":"column","component":"shell","params":{},"box":{},"variants":[],"slots":[{"kind":"frame","frame":"body"},{"kind":"state","state":"sel"}],"##,
            r##""bindings":[{"doc":"docs/guide.geml","block":"#tip","part":"strong","rules":["[2]"],"params":{},"box":{"color":"green"},"variants":[]},"##,
            r##"{"doc":"docs/guide.geml","block":"#calls","rules":["[0]"],"params":{},"box":{},"variants":[{"when":{"sel":"a"},"box":{"color":"red"},"params":{"component":"graph"}}]},"##,
            r##"{"doc":"docs/guide.geml","block":"#part","rules":["[1]"],"params":{},"box":{"color":"blue"},"variants":[]}]}],"##,
            r##""frames":[{"id":"body","axis":"row","params":{},"box":{},"variants":[],"slots":[{"kind":"blocks","selector":"table#calls","blocks":[{"doc":"docs/guide.geml","block":"#calls"}]}]}],"##,
            r##""bindings":[{"doc":"docs/guide.geml","block":"#tip","part":"strong","rules":["[2]"],"params":{},"box":{"color":"green"},"variants":[]},"##,
            r##"{"doc":"docs/guide.geml","block":"#calls","rules":["[0]"],"params":{},"box":{},"variants":[{"when":{"sel":"a"},"box":{"color":"red"},"params":{"component":"graph"}}]}],"##,
            r##""diagnostics":[]}"##,
        )
    );
}
