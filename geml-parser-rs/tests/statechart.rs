//! `spec/profiles/geml-statechart/checks.json`: the checks of the profile's §3,
//! each case a document, the files beside it, and the sorted `severity:code`
//! list the checks report.

use std::path::PathBuf;

use geml::json::{self, Value};

#[test]
fn every_statechart_check_case_is_reproduced() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../spec/profiles/geml-statechart/checks.json");
    let f = json::parse(&std::fs::read_to_string(path).unwrap()).unwrap();
    let Some(Value::Array(cases)) = f.get("cases") else { panic!("cases") };
    let mut fails = Vec::new();
    for c in cases {
        let name = c.get("name").and_then(|v| v.scalar_text()).unwrap();
        let src = c.get("geml").and_then(|v| v.scalar_text()).unwrap();
        let mut host = geml::host::MapHost { complete: true, ..Default::default() };
        host.files.insert("case.geml".into(), src.clone());
        if let Some(Value::Object(files)) = c.get("files") {
            for (p, t) in files {
                host.files.insert(p.clone(), t.scalar_text().unwrap());
            }
        }
        let d = geml::parse_with(&src, &geml::Options { name: "case.geml".into(), host: Some(&host), ..Default::default() });
        let mut got: Vec<String> = d.profile_diagnostics.iter().map(|p| format!("{}:{}", p.level.as_str(), p.code)).collect();
        got.sort();
        let mut want: Vec<String> = match c.get("codes") {
            Some(Value::Array(a)) => a.iter().map(|x| x.scalar_text().unwrap()).collect(),
            _ => panic!("{name}: codes"),
        };
        want.sort();
        if got != want {
            let said: Vec<String> = d.profile_diagnostics.iter().map(|p| format!("{} {}", p.code, p.message)).collect();
            fails.push(format!("{name}\n    want {want:?}\n    got  {got:?}\n    {said:#?}"));
        }
    }
    for f in &fails {
        eprintln!("{f}");
    }
    eprintln!("statechart checks: {} case(s), {} failing", cases.len(), fails.len());
    assert!(fails.is_empty());
}

fn codes(body: &str, attrs: &str) -> Vec<String> {
    let src = format!("=== meta\nprofile = \"geml-statechart/v1\"\n===\n\n=== diagram {{#m format=geml-statechart{attrs}}}\n{body}\n===\n");
    let mut c: Vec<String> = geml::parse(&src).profile_diagnostics.iter().map(|p| format!("{}:{}", p.level.as_str(), p.code)).collect();
    c.sort();
    c
}

/// With no host, a definition or a guard in another document cannot be read:
/// it is not checked, and nothing is reported against it.
#[test]
fn another_document_without_a_host_is_not_checked() {
    assert_eq!(codes("", " data=other.geml#d"), Vec::<String>::new());
    let guard = r#"{ "initial": "a", "states": { "a": {}, "b": { "final": true } }, "transitions": [ { "from": "a", "to": "b", "guard": "other.geml#g" } ] }"#;
    assert_eq!(codes(guard, ""), Vec::<String>::new());
}

/// §4's shapes the case file leaves out: an enum or a const beside a `type`
/// it does not fit, a const that is not a scalar, `properties` that is not an
/// object, a schema under `items`, and the annotations.
#[test]
fn the_subset_checks_each_shape() {
    let g = |schema: &str| {
        codes(
            &format!(
                r#"{{ "initial": "a", "states": {{ "a": {{}}, "b": {{ "final": true }} }}, "vars": {{ "v": {{ "default": 1 }} }}, "transitions": [ {{ "from": "a", "to": "b", "guard": {schema} }} ] }}"#
            ),
            "",
        )
    };
    let e = vec!["error:statechart-guard".to_string()];
    assert_eq!(g(r#"{ "properties": { "v": { "type": "integer", "enum": [1, 2.5] } } }"#), e);
    assert_eq!(g(r#"{ "properties": { "v": { "const": [1] } } }"#), e);
    assert_eq!(g(r#"{ "properties": [] }"#), e);
    assert_eq!(g(r#"{ "properties": { "v": { "type": "array", "items": { "minimum": 1 } } } }"#), e);
    assert_eq!(
        g(
            r#"{ "title": "t", "description": "d", "default": {}, "examples": [], "type": "object", "additionalProperties": false, "properties": { "v": { "type": "integer", "enum": [1, 2], "const": 1 } }, "required": ["v"] }"#
        ),
        Vec::<String>::new()
    );
    assert_eq!(g(r#"{ "oneOf": [ { "required": ["v"] }, { "properties": { "v": { "type": "null", "const": null } } } ] }"#), Vec::<String>::new());
}
