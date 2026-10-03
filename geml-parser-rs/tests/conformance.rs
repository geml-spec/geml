//! The conformance suite, run natively. This harness does what the suite's
//! `_runner.mjs` does: read `manifest.json`, run every case file, and check a
//! case's `want` and each optional field. This implementation declares every
//! capability the manifest names, so it runs every file and every case.

use std::path::PathBuf;

use geml::json::{self, Value};

fn suite_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../geml-parser/test/conformance")
}

fn read_json(name: &str) -> Value {
    let p = suite_dir().join(name);
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    json::parse(&text).unwrap_or_else(|e| panic!("{name}: {e:?}"))
}

fn base64(s: &str) -> Vec<u8> {
    const A: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        acc = (acc << 6) | A.find(c as char).expect("base64") as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

fn strs(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().map(|x| x.scalar_text().unwrap_or_default()).collect(),
        _ => panic!("expected an array"),
    }
}

#[test]
fn the_whole_suite() {
    let manifest = read_json("manifest.json");
    let Some(Value::Array(files)) = manifest.get("files") else { panic!("manifest.files") };
    let mut pass = 0;
    let mut fails: Vec<String> = Vec::new();
    for f in files {
        let file = f.get("file").and_then(|v| v.scalar_text()).expect("file");
        let Value::Array(cases) = read_json(&file) else { panic!("{file}: not an array") };
        for c in &cases {
            let name = c.get("name").and_then(|v| v.scalar_text()).unwrap_or_default();
            // A case of a file that needs `host` gives a file tree (`files`) and the
            // document to read (`main`); the tree's root is the resolution root.
            let doc = if let Some(Value::Object(files)) = c.get("files") {
                let mut h = geml::host::MapHost { complete: true, ..Default::default() };
                for (k, v) in files {
                    h.files.insert(k.clone(), v.scalar_text().expect("a file's text"));
                }
                let main = c.get("main").and_then(|v| v.scalar_text()).expect("main");
                let text = h.files[&main].clone();
                geml::parse_with(&text, &geml::Options { name: main, host: Some(&h), ..Default::default() })
            } else {
                match c.get("geml_base64") {
                    Some(b) => geml::parse_bytes(&base64(&b.scalar_text().unwrap())),
                    None => geml::parse(&c.get("geml").and_then(|v| v.scalar_text()).expect("geml")),
                }
            };
            let mut wrong: Vec<String> = Vec::new();
            let want = c.get("want").and_then(|v| v.scalar_text()).unwrap_or_default();
            let got = geml::project(&doc);
            if want != got {
                wrong.push(format!("want  {want}\n        got   {got}"));
            }
            if let Some(ids) = c.get("ids") {
                if strs(ids) != doc.ids {
                    wrong.push(format!("ids   {:?}\n        got   {:?}", strs(ids), doc.ids));
                }
            }
            if let Some(a) = c.get("addresses") {
                if strs(a) != doc.addresses {
                    wrong.push(format!("addresses {:?}\n        got   {:?}", strs(a), doc.addresses));
                }
            }
            if let Some(b) = c.get("blocks") {
                let wb = b.scalar_text().unwrap_or_default();
                let gb = geml::blocks_of(&doc);
                if wb != gb {
                    wrong.push(format!("blocks {wb}\n        got    {gb}"));
                }
            }
            if let Some(d) = c.get("diagnostics") {
                let mut w = strs(d);
                w.sort();
                let mut g = geml::diagnostic_codes(&doc);
                g.sort();
                if w != g {
                    wrong.push(format!(
                        "diagnostics {w:?}\n        got   {g:?}\n        ({:?})",
                        doc.diagnostics.iter().map(|x| &x.message).collect::<Vec<_>>()
                    ));
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
    eprintln!("\ngeml (Rust): {pass} case(s) passed, {} failed", fails.len());
    assert!(fails.is_empty(), "{} conformance case(s) failed", fails.len());
}
