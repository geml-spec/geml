//! The fixed bounds: GEML §9.2 and geml-media §8.1 each state every value once,
//! in a table of fixed bounds, and this crate's constants follow the tables.
//! The core table is read from the specification's GEML copy by this parser.

use geml::bounds::*;
use geml::model::{Block, Item};

fn spec(path: &str) -> String {
    std::fs::read_to_string(format!("{}/../spec/{path}", env!("CARGO_MANIFEST_DIR"))).expect("the specification beside this crate")
}

fn find<'a>(items: &'a [Item], id: &str) -> Option<&'a Block> {
    items.iter().find_map(|it| match it {
        Item::Block(b) if b.id.as_deref() == Some(id) => Some(b),
        Item::Block(b) => find(&b.children, id),
        _ => None,
    })
}

fn number(text: &str) -> f64 {
    let lead: String = text.chars().take_while(|c| c.is_ascii_digit() || *c == ',' || *c == '.').filter(|c| *c != ',').collect();
    lead.parse().unwrap_or_else(|_| panic!("`{text}` is not a value"))
}

/// The table of a Markdown text whose header is `| Name | Value |`, as name → value.
fn markdown_table(text: &str) -> Vec<(String, f64)> {
    let mut lines = text.lines().skip_while(|l| !l.starts_with("| Name | Value |")).skip(2);
    std::iter::from_fn(|| lines.next())
        .take_while(|l| l.starts_with("| `"))
        .map(|l| {
            let cells: Vec<&str> = l.split('|').map(str::trim).collect();
            (cells[1].trim_matches('`').to_string(), number(cells[2]))
        })
        .collect()
}

#[test]
fn the_core_table_is_this_crates() {
    let doc = geml::parse(&spec("in_geml_format/GEML-spec.geml"));
    let table = find(&doc.children, "fixed-bounds").and_then(|b| b.table.as_ref()).expect("a table block #fixed-bounds");
    let read: Vec<(String, f64)> = table.rows.iter().map(|r| (r[0].text.trim_matches('`').to_string(), number(&r[1].text))).collect();
    assert_eq!(read, markdown_table(&spec("GEML-spec.md")), "the GEML copy and the Markdown specification disagree");
    let value = |name: &str| read.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("no `{name}` in §9.2's table")).1;
    assert_eq!(read.len(), 4, "§9.2 names a bound this crate does not know");
    assert_eq!(CHAIN_DEPTH as f64, value("chain-depth"));
    assert_eq!(DATA_DEPTH as f64, value("data-depth"));
    assert_eq!(TABLE_CELLS as f64, value("table-cells"));
    assert!(BLOCK_NESTING as f64 >= value("nesting-floor") && INLINE_NESTING as f64 >= value("nesting-floor"));
}

#[test]
fn the_media_table_is_this_crates() {
    let read = markdown_table(&spec("profiles/geml-media/geml-media-profile.md"));
    assert_eq!(read, [("max-time".to_string(), MEDIA_MAX_TIME), ("apart-tolerance".to_string(), MEDIA_APART_PX)]);
}
