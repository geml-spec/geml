//! The `edits` conformance cases (spec §8.2(10), §8.4), run natively. This
//! harness does what the suite's `_edits.mjs` does: read the manifest's
//! `edits` list, run every case, and compare the outcome with `want`. A case
//! this implementation cannot run yet is counted as skipped and listed — the
//! count must reach zero before the `edits` capability is declared.

use std::path::PathBuf;

use geml::edit::{case_from_json, run, Outcome};
use geml::json::{self, Value};

fn suite_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../geml-parser/test/conformance")
}

fn read_json(name: &str) -> Value {
    let p = suite_dir().join(name);
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    json::parse(&text).unwrap_or_else(|e| panic!("{name}: {e:?}"))
}

fn strs(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().map(|x| x.scalar_text().unwrap_or_default()).collect(),
        _ => Vec::new(),
    }
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

#[test]
fn the_edits_cases() {
    let manifest = read_json("manifest.json");
    let Some(Value::Array(files)) = manifest.get("edits") else { panic!("manifest.edits") };
    let mut pass = 0;
    let mut fails: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    // This crate declares every capability the manifest names — the optional
    // `markdown` included — so every file runs.
    for f in files {
        let file = f.get("file").and_then(|v| v.scalar_text()).expect("file");
        let Value::Array(cases) = read_json(&file) else { panic!("{file}: not an array") };
        for c in &cases {
            let name = c.get("name").and_then(|v| v.scalar_text()).unwrap_or_default();
            let case = case_from_json(c).unwrap_or_else(|e| panic!("[{file}] {name}: {e}"));
            let want = c.get("want").expect("want");
            let got = run(&case);
            let mut wrong: Vec<String> = Vec::new();
            match got {
                Ok(Err(u)) => {
                    skipped.push(format!("[{file}] {name} — {}", u.0));
                    continue;
                }
                Err(r) => {
                    let want_refused = want.get("refused").and_then(|v| v.scalar_text());
                    match want_refused {
                        Some(code) => {
                            if code != r.reason.as_str() {
                                wrong.push(format!("refused want {code}, got {}: {}", r.reason.as_str(), r.message));
                            }
                            if let Some(d) = want.get("diagnostics") {
                                let got: Vec<String> = r.diagnostics.iter().map(|d| format!("{}:{}", d.code, d.severity.as_str())).collect();
                                if sorted(strs(d)) != sorted(got.clone()) {
                                    wrong.push(format!("diagnostics want {:?}, got {got:?}", strs(d)));
                                }
                            }
                        }
                        None => wrong.push(format!("want an answer, got refused {}: {}", r.reason.as_str(), r.message)),
                    }
                }
                Ok(Ok(outcome)) => {
                    if let Some(code) = want.get("refused").and_then(|v| v.scalar_text()) {
                        wrong.push(format!("want refused {code}, got an answer"));
                    } else {
                        match (&outcome, want) {
                            (Outcome::Text(t), w) if w.get("text").is_some() => {
                                let want_t = w.get("text").and_then(|v| v.scalar_text()).unwrap_or_default();
                                if *t != want_t {
                                    wrong.push(format!("text want {want_t:?}\n        got  {t:?}"));
                                }
                            }
                            // `to json`: the model's JSON layout is each implementation's own,
                            // so the suite reads it through its projection. `wasm/edits.mjs`
                            // does exactly that, with the suite's `_project.mjs`; natively, with
                            // no reader of the model JSON, the output must carry the children
                            // `to_json` gives the case's document, and that document must
                            // project as the case says.
                            (Outcome::Output(t), w) if w.get("projection").is_some() || w.get("blocks").is_some() => {
                                let doc = geml::parse(&case.geml);
                                let children = |s: &str| json::parse(s).ok().and_then(|v| v.get("children").map(json::canonical));
                                let got_children = children(t);
                                if got_children.is_none() || got_children != children(&geml::to_json(&doc)) {
                                    wrong.push(format!("output is not the document's model: {t:?}"));
                                }
                                if let Some(p) = w.get("projection").and_then(|v| v.scalar_text()) {
                                    let got = geml::project(&doc);
                                    if got != p {
                                        wrong.push(format!("projection want {p:?}\n        got        {got:?}"));
                                    }
                                }
                                if let Some(b) = w.get("blocks").and_then(|v| v.scalar_text()) {
                                    let got = geml::blocks_of(&doc);
                                    if got != b {
                                        wrong.push(format!("blocks want {b:?}\n        got    {got:?}"));
                                    }
                                }
                            }
                            (Outcome::Output(t), w) if w.get("output").is_some() => {
                                let want_t = w.get("output").and_then(|v| v.scalar_text()).unwrap_or_default();
                                if *t != want_t {
                                    wrong.push(format!("output want {want_t:?}\n        got    {t:?}"));
                                }
                            }
                            (Outcome::Rows(r), w) if w.get("rows").is_some() => {
                                let (a, b) = (json::canonical(w.get("rows").unwrap()), json::canonical(r));
                                if a != b {
                                    wrong.push(format!("rows want {a}\n        got  {b}"));
                                }
                            }
                            (Outcome::Hits(r), w) if w.get("hits").is_some() => {
                                let (a, b) = (json::canonical(w.get("hits").unwrap()), json::canonical(r));
                                if a != b {
                                    wrong.push(format!("hits want {a}\n        got  {b}"));
                                }
                            }
                            (Outcome::Diagnostics(d), w) if w.get("diagnostics").is_some() => {
                                let want_d = sorted(strs(w.get("diagnostics").unwrap()));
                                if want_d != sorted(d.clone()) {
                                    wrong.push(format!("diagnostics want {want_d:?}, got {d:?}"));
                                }
                            }
                            (Outcome::Unchanged, w) if w.get("unchanged").is_some() => {}
                            (o, w) => wrong.push(format!("outcome {o:?} does not answer want {}", json::canonical(w))),
                        }
                    }
                }
            }
            if wrong.is_empty() {
                pass += 1;
            } else {
                fails.push(format!("FAIL [{file}] {name}\n        {}", wrong.join("\n        ")));
            }
        }
    }
    for f in &fails {
        eprintln!("{f}");
    }
    eprintln!("\ngeml (Rust) edits: {pass} case(s) passed, {} failed, {} skipped (not implemented yet)", fails.len(), skipped.len());
    for s in &skipped {
        eprintln!("  skipped {s}");
    }
    assert!(fails.is_empty(), "{} edit case(s) failed", fails.len());
}
