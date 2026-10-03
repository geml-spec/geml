//! A small command line over the crate, reading from the file system.
//!
//!   geml-rs check <root> <file.geml>…           core and vocabulary diagnostics
//!   geml-rs style <root> <sheet> <corpus.geml>… the style view model, as JSON
//!   geml-rs history <sidecar> [live.geml]       verify a .gemlhistory
//!   geml-rs codemap <root> <file.geml>…         a codemap's dangling references
//!
//! Paths after `<root>` are root-relative; nothing outside the root is read.

use std::path::{Path, PathBuf};

use geml::host::{FileState, Host};

struct Fs {
    root: PathBuf,
}

impl Fs {
    fn path(&self, from: &str, rel: &str) -> Option<PathBuf> {
        let joined = geml::host::join(from, rel)?;
        let p = self.root.join(joined).canonicalize().ok()?;
        p.starts_with(self.root.canonicalize().ok()?).then_some(p)
    }
}

impl Host for Fs {
    fn read(&self, from: &str, rel: &str) -> Option<String> {
        std::fs::read(self.path(from, rel)?).ok().map(|b| geml::decode(&b))
    }

    fn file(&self, from: &str, rel: &str) -> Option<FileState> {
        let joined = geml::host::join(from, rel)?;
        let p = self.root.join(joined);
        match std::fs::read(&p) {
            Ok(b) => Some(FileState::Present(geml::sha256::hex(&b))),
            Err(_) => Some(FileState::Missing),
        }
    }
}

fn parse(fs: &Fs, name: &str) -> geml::Document {
    let text = geml::decode(&std::fs::read(fs.root.join(name)).unwrap_or_else(|e| panic!("{name}: {e}")));
    geml::parse_with(&text, &geml::Options { name: name.to_string(), recognize: true, host: Some(fs), checks: true })
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let usage = "usage: geml-rs check|style|codemap <root> <file>… | geml-rs history <sidecar> [live]";
    let cmd = a.get(1).map(String::as_str).unwrap_or("");
    let mut bad = false;
    match cmd {
        "check" | "codemap" | "style" if a.len() >= 4 => {
            let fs = Fs { root: PathBuf::from(&a[2]) };
            if cmd == "style" {
                let sheet = parse(&fs, &a[3]);
                let corpus: Vec<geml::Document> = a[4..].iter().map(|f| parse(&fs, f)).collect();
                let refs: Vec<&geml::Document> = corpus.iter().collect();
                let vm = geml::check::style::check(&sheet, &refs, &Default::default(), Some(&fs));
                println!("{}", vm.to_json());
                bad = vm.diagnostics.iter().any(|d| d.level == geml::vocab::Level::Error);
            }
            for f in &a[3..] {
                if cmd == "style" {
                    break;
                }
                let d = parse(&fs, f);
                if cmd == "codemap" {
                    let r = geml::check::codemap::verify(&d, Some(&fs));
                    for x in &r.dangling {
                        println!("{f}{} {}: {}", x.at, x.reference, x.why);
                    }
                    for p in &r.problems {
                        println!("{f}: {p}");
                    }
                    bad |= !r.ok();
                    continue;
                }
                for x in &d.diagnostics {
                    println!("{f}:{}: {} {}: {}", x.line, x.severity.as_str(), x.code, x.message);
                    bad |= x.severity == geml::Severity::Error;
                }
                for x in &d.profile_diagnostics {
                    println!("{}: {} {}: {}", x.address, x.level.as_str(), x.code, x.message);
                    bad |= x.level == geml::vocab::Level::Error;
                }
            }
        }
        "history" if a.len() >= 3 => {
            let s = geml::check::history::read(&std::fs::read_to_string(Path::new(&a[2])).expect("sidecar"));
            let live = a.get(3).map(|p| std::fs::read(p).expect("live file"));
            let v = s.verify(live.as_deref());
            for e in &v.errors {
                println!("error: {e}");
            }
            for w in &v.warnings {
                println!("warning: {w}");
            }
            println!("{} of {} revisions verified", v.verified, s.revisions.len());
            bad = !v.errors.is_empty();
        }
        _ => {
            eprintln!("{usage}");
            std::process::exit(2);
        }
    }
    std::process::exit(i32::from(bad));
}
