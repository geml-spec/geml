//! Each vocabulary's conformance file (`spec/profiles/*/conformance.json`): its
//! `codes` and `state` against this processor's registry, and each case's
//! addresses and core diagnostics in both readings — with the vocabulary
//! recognized ("declared"), and with the declaration absent ("undeclared").

use std::path::PathBuf;

use geml::json::{self, Value};

fn strs(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().map(|x| x.scalar_text().unwrap_or_default()).collect(),
        _ => panic!("expected an array"),
    }
}

/// The same document without its `profile` declaration.
fn undeclared(src: &str) -> String {
    src.lines().filter(|l| !l.trim_start().starts_with("profile")).collect::<Vec<_>>().join("\n") + "\n"
}

fn reading(src: &str) -> (Vec<String>, Vec<String>) {
    let d = geml::parse(src);
    let mut c = geml::diagnostic_codes(&d);
    c.sort();
    (d.addresses, c)
}

#[test]
fn every_vocabulary_reproduces_its_conformance_file() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../spec/profiles");
    let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.join("conformance.json").exists()).collect();
    names.sort();
    assert_eq!(names.len(), geml::vocab::PROFILES.len(), "one conformance file per vocabulary");
    let mut cases = 0;
    let mut fails = Vec::new();
    for d in names {
        let f = json::parse(&std::fs::read_to_string(d.join("conformance.json")).unwrap()).unwrap();
        let name = f.get("profile").and_then(|v| v.scalar_text()).unwrap();
        let p = geml::vocab::builtin(&name).unwrap_or_else(|| panic!("{name} is not in the registry"));
        assert_eq!(f.get("state").and_then(|v| v.scalar_text()).as_deref(), Some(p.state.as_str()), "{name}: state");
        let Some(Value::Object(codes)) = f.get("codes") else { panic!("{name}: codes") };
        let want: Vec<(String, String)> = codes.iter().map(|(k, v)| (k.clone(), v.scalar_text().unwrap())).collect();
        let have: Vec<(String, String)> = p.codes.iter().map(|(c, l)| (c.to_string(), l.as_str().to_string())).collect();
        assert_eq!(have, want, "{name}: codes and severities");
        let Some(Value::Array(cs)) = f.get("cases") else { panic!() };
        for c in cs {
            let label = c.get("name").and_then(|v| v.scalar_text()).unwrap();
            let src = c.get("geml").and_then(|v| v.scalar_text()).unwrap();
            let (a, d) = reading(&src);
            let (ua, ud) = reading(&undeclared(&src));
            let mut wd = strs(c.get("diagnostics").and_then(|x| x.get("declared")));
            wd.sort();
            let mut wu = strs(c.get("diagnostics").and_then(|x| x.get("undeclared")));
            wu.sort();
            let checks = [
                ("addresses, declared", strs(c.get("addresses").and_then(|x| x.get("declared"))), a),
                ("addresses, undeclared", strs(c.get("addresses").and_then(|x| x.get("undeclared"))), ua),
                ("diagnostics, declared", wd, d),
                ("diagnostics, undeclared", wu, ud),
            ];
            for (what, want, got) in checks {
                if want != got {
                    fails.push(format!("[{name}] {label}\n    {what}: want {want:?}\n    {what}: got  {got:?}"));
                }
            }
            cases += 1;
        }
    }
    for f in &fails {
        eprintln!("{f}");
    }
    eprintln!("profiles: {cases} case(s), {} failing reading(s)", fails.len());
    assert!(fails.is_empty());
}

/// `views` (geml-style §10): a stylesheet and a corpus, and the view model's
/// bindings, exactly and in order, with its diagnostics as a multiset.
#[test]
fn every_view_model_case_is_reproduced() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../spec/profiles");
    let mut fails = Vec::new();
    let mut n = 0;
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        let path = entry.path().join("conformance.json");
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let f = json::parse(&text).unwrap();
        let Some(Value::Array(views)) = f.get("views") else { continue };
        for v in views {
            let name = v.get("name").and_then(|x| x.scalar_text()).unwrap_or_default();
            // The case's file tree, read through a host confined to it (README).
            let Some(Value::Object(files)) = v.get("files") else { panic!("{name}: files") };
            let mut host = geml::host::MapHost { complete: true, ..Default::default() };
            for (p, t) in files {
                host.files.insert(p.clone(), t.scalar_text().unwrap());
            }
            let read = |p: &str| geml::parse_with(&host.files[p], &geml::Options { name: p.to_string(), host: Some(&host), ..Default::default() });
            let sheet = read(&v.get("sheet").and_then(|x| x.scalar_text()).unwrap());
            let docs: Vec<geml::Document> = strs(v.get("corpus")).iter().map(|p| read(p)).collect();
            let refs: Vec<&geml::Document> = docs.iter().collect();
            let vm = geml::check::style::check(&sheet, &refs, &Default::default(), Some(&host));
            let got = json::parse(&vm.to_json()).unwrap();
            for field in ["states", "screens", "frames", "bindings"] {
                let want = json::canonical(v.get(field).unwrap());
                let have = json::canonical(got.get(field).unwrap());
                if want != have {
                    fails.push(format!("[{name}] {field}\n    want {want}\n    got  {have}"));
                }
            }
            let mut wd = strs(v.get("diagnostics"));
            wd.sort();
            let mut gd: Vec<String> = vm.diagnostics.iter().map(|d| format!("{}:{}", d.code, d.level.as_str())).collect();
            gd.sort();
            if wd != gd {
                fails.push(format!("[{name}] diagnostics\n    want {wd:?}\n    got  {gd:?}"));
            }
            n += 1;
        }
    }
    for f in &fails {
        eprintln!("{f}");
    }
    eprintln!("views: {n} case(s), {} failing", fails.len());
    assert!(n > 0, "geml-style carries view-model cases");
    assert!(fails.is_empty());
}
