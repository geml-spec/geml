//! §8.1: every input is parseable, and §9.2: no input may overflow the stack,
//! abort, or fail to produce a model. Each conformance input is cut at every
//! character and parsed; a set of hostile inputs must parse quickly.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use geml::json::{self, Value};

fn inputs() -> Vec<String> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../geml-parser/test/conformance");
    let manifest = json::parse(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    let Some(Value::Array(files)) = manifest.get("files") else { panic!() };
    let mut out = Vec::new();
    for f in files {
        let name = f.get("file").and_then(|v| v.scalar_text()).unwrap();
        let Value::Array(cases) = json::parse(&std::fs::read_to_string(dir.join(name)).unwrap()).unwrap() else { panic!() };
        for c in cases {
            if let Some(g) = c.get("geml").and_then(|v| v.scalar_text()) {
                out.push(g);
            }
        }
    }
    out
}

#[test]
fn every_prefix_of_every_case_parses() {
    let mut n = 0;
    for src in inputs() {
        let chars: Vec<char> = src.chars().collect();
        for k in 0..=chars.len() {
            let s: String = chars[..k].iter().collect();
            let d = geml::parse(&s);
            let _ = geml::to_json(&d);
            let _ = geml::blocks_of(&d);
            n += 1;
        }
    }
    assert!(n > 10_000, "{n} prefixes");
}

fn quick(label: &str, src: String) {
    let t = Instant::now();
    let d = geml::parse(&src);
    let _ = geml::to_json(&d);
    let _ = geml::project(&d);
    assert!(t.elapsed() < Duration::from_secs(10), "{label} took {:?}", t.elapsed());
}

#[test]
fn hostile_inputs_parse_quickly() {
    quick("20 000-deep link labels", format!("{}x{}", "[".repeat(20_000), "](y)".repeat(20_000)));
    quick("20 000-deep image alts", format!("{}x{}", "![".repeat(20_000), "](i.png)".repeat(20_000)));
    quick("100 000 stars", "*".repeat(100_000));
    quick("alternating runs", "*a **b ".repeat(20_000));
    quick("50 000 openers then closers", format!("{}x{}", "*".repeat(50_000), "*".repeat(50_000)));
    quick("tildes", "~~a ".repeat(30_000));
    quick("backticks", "` ``".repeat(5_000));
    quick("dollars", "$".repeat(50_000));
    quick("brackets", "[[".repeat(20_000));
    quick("interpolations", "{{ ".repeat(20_000));
    quick("unclosed fences", "=== note\n".repeat(2_000));
    quick("deep lists", (0..2_000).map(|i| format!("{}- x\n", " ".repeat(i))).collect());
    quick("wide attribute object", format!("=== note {{{}}}\nx\n===\n", (0..5_000).map(|i| format!("k{i}=v")).collect::<Vec<_>>().join(" ")));
    quick("many headings", "## Same\n\n".repeat(3_000));
    quick(
        "a long table",
        format!(
            "=== table {{#t format=csv header=1}}\nA,B\n{}===\n\n=== view {{src=#t order=\"A desc\" compute=\"C = A / sum(B)\" summary=\"A = sum(A)\"}}\n===\n",
            "1,2\n".repeat(5_000)
        ),
    );
    quick("deep json", format!("=== data\n{}{}\n===\n", "[".repeat(5_000), "]".repeat(5_000)));
    quick("deep yaml", format!("=== data {{format=yaml}}\n{}\n===\n", (0..300).map(|i| format!("{}k{i}:", " ".repeat(i))).collect::<Vec<_>>().join("\n")));
}
