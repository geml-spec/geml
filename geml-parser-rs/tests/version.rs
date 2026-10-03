//! The crate carries the reference parser's version with the major at 0:
//! parser 1.12.1 is crate 0.12.1. Both move in the parser's release commit.

#[test]
fn the_version_follows_the_reference_parser() {
    let pkg = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../geml-parser/package.json")).expect("geml-parser/package.json beside this crate");
    let key = "\"version\": \"";
    let at = pkg.find(key).expect("package.json has a version") + key.len();
    let parser = &pkg[at..at + pkg[at..].find('"').expect("a closing quote")];
    let (_, minor_patch) = parser.split_once('.').expect("major.minor.patch");
    assert_eq!(
        env!("CARGO_PKG_VERSION"),
        format!("0.{minor_patch}"),
        "Cargo.toml and Cargo.lock lag geml-parser {parser}: they move with every parser release"
    );
}
