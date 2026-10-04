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
        // A boundary case is large by design — a million cells, a value tree
        // two hundred deep — and the conformance test parses it whole; its
        // prefixes would cost the square of its length and add nothing.
        for c in cases.iter().filter(|c| c.get("bound").is_none()) {
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

fn codes(src: &str) -> Vec<String> {
    geml::diagnostic_codes(&geml::parse(src))
}

/// Round 6: a JSON escape is one ASCII character. A backslash before a
/// multibyte character — in a coordinate step, a `json` body, a `jsonl` line —
/// is an unknown escape, refused where it stands and never stepped into.
#[test]
fn a_json_escape_never_splits_a_character() {
    assert!(json::parse("\"\\é\"").is_err());
    assert_eq!(json::parse("[\n\"\\é\"]").unwrap_err().line, 1);
    assert_eq!(geml::project(&geml::parse("[[#a[\"\\é\"]]]\n")), r#""[[#a[\"\\é\"]]]""#);
    assert_eq!(codes("=== data\n\"\\é\"\n===\n"), ["data-parse:error"]);
    assert_eq!(codes("=== data {format=jsonl}\n1\n\"\\é\"\n===\n"), ["data-parse:error"]);
}

/// Round 6: a `\u` escape is four hex digits, in a `json` body and in a
/// `yaml` double-quoted scalar alike; a sign is not a digit.
#[test]
fn a_unicode_escape_is_hex_digits_only() {
    assert!(json::parse("\"\\u+041\"").is_err());
    assert_eq!(json::parse("\"\\u0041\"").unwrap(), Value::String("A".into()));
    assert_eq!(codes("=== data\n\"\\u+041\"\n===\n"), ["data-parse:error"]);
    assert_eq!(codes("=== data {format=yaml}\na: \"\\u+041\"\n===\n"), ["data-parse:error"]);
    assert_eq!(codes("=== data {format=yaml}\na: \"\\x+4\"\n===\n"), ["data-parse:error"]);
    assert!(codes("=== data {format=yaml}\na: \"\\u0041\\x41\"\n===\n").is_empty());
}

/// Round 6: a `[printf]` precision is clamped to 100 digits, as the reference
/// clamps it, before any arithmetic on it; one past what `usize` holds is 100
/// too. Unclamped, `%.18446744073709551615e` overflowed and `%.100000000f`
/// asked for gigabytes.
#[test]
fn a_printf_precision_is_clamped_to_100() {
    use geml::num::format_printf;
    let t = Instant::now();
    let hundred = "0".repeat(100);
    assert_eq!(format_printf("%.18446744073709551615e", 1.0), format!("1.{hundred}e+00"));
    assert_eq!(format_printf("%.18446744073709551616e", 1.0), format!("1.{hundred}e+00"));
    assert_eq!(format_printf("%.18446744073709551615g", 1.0), "1");
    assert_eq!(format_printf("%.100000000f", 2.0), format!("2.{hundred}"));
    assert_eq!(format_printf("%.150g", 0.00012345), "0.00012344999999999999203137424075293893110938370227813720703125");
    let d = geml::parse("=== table {#t format=csv header=1}\nA\n1\n===\n\n=== view {src=#t compute=\"C [%.18446744073709551615g] = A\"}\n===\n");
    assert!(d.diagnostics.is_empty());
    assert!(t.elapsed() < Duration::from_secs(10), "took {:?}", t.elapsed());
}

/// Round 6: `yaml` collections nest at most `data-depth` deep (§3.2, §9.2);
/// deeper is a `data-parse` refusal on the line that goes too deep, not
/// a stack overflow. `- - - … x` on one line nests without limit in the
/// grammar.
#[test]
fn yaml_nesting_is_bounded_at_data_depth() {
    use geml::bounds::DATA_DEPTH as D;
    let seq = |n: usize| format!("=== data {{format=yaml}}\n{}x\n===\n", "- ".repeat(n));
    assert!(codes(&seq(D)).is_empty());
    let d = geml::parse(&seq(D + 1));
    assert_eq!(geml::diagnostic_codes(&d), ["data-parse:error"]);
    assert_eq!(d.diagnostics[0].line, 2);
    // The map on line 2 + D is the one inside D others.
    let map: String = (0..D + 5).map(|i| format!("{}k{i}:\n", " ".repeat(i))).collect();
    let d = geml::parse(&format!("=== data {{format=yaml}}\n{map}===\n"));
    assert_eq!((geml::diagnostic_codes(&d), d.diagnostics[0].line), (vec!["data-parse:error".to_string()], 2 + D));
    let t = Instant::now();
    assert_eq!(codes(&seq(20_000)), ["data-parse:error"]);
    assert!(t.elapsed() < Duration::from_secs(10), "took {:?}", t.elapsed());
}

/// Round 6: a formula or a condition nests at most `MAX_EXPR_DEPTH` deep — a
/// parenthesis, a unary `-`, a `not` — and deeper is the one diagnostic the
/// reference gives, under the attribute's own code. A long flat run, `1+1+…`
/// or `a or b or …`, is no nesting at all: it is read and evaluated as a list.
#[test]
fn expression_nesting_is_bounded_and_runs_are_flat() {
    use geml::expr::MAX_EXPR_DEPTH as D;
    let view = |attr: String| format!("=== table {{#t format=csv header=1}}\nA\n1\n2\n===\n\n=== view {{src=#t {attr}}}\n===\n");
    let t = Instant::now();
    for (attr, code) in [
        (format!("compute=\"C = {}1\"", "-".repeat(50_000)), "compute-error:error"),
        (format!("compute=\"C = {}1{}\"", "(".repeat(50_000), ")".repeat(50_000)), "compute-error:error"),
        (format!("summary=\"A = {}sum(A)\"", "-".repeat(D + 1)), "summary-error:error"),
        (format!("where=\"{}A = 1\"", "not ".repeat(50_000)), "view-where-error:error"),
        (format!("where=\"{}A = 1{}\"", "(".repeat(D + 1), ")".repeat(D + 1)), "view-where-error:error"),
    ] {
        assert_eq!(codes(&view(attr.clone())), [code], "{}", &attr[..40]);
    }
    // At the bound itself, each is read.
    assert!(codes(&view(format!("compute=\"C = {}1\"", "-".repeat(D)))).is_empty());
    assert!(codes(&view(format!("compute=\"C = {}1{}\"", "(".repeat(D), ")".repeat(D)))).is_empty());
    assert!(codes(&view(format!("where=\"{}A = 1\"", "not ".repeat(D)))).is_empty());
    let d = geml::parse(&view(format!("compute=\"C = 1{}\" where=\"A = 9{}\"", "+1".repeat(100_000), " or A = 2".repeat(100_000))));
    assert!(d.diagnostics.is_empty());
    assert_eq!(geml::project(&d), r#"table(["A"] ["1"] ["2"]) view(["A","C"] ["2","100001"])"#);
    assert!(t.elapsed() < Duration::from_secs(10), "took {:?}", t.elapsed());
}

/// Round 6: views that source each other forward wait on a stack, not in
/// nested calls, so a chain of any length is evaluated without overflowing;
/// §9.3 refuses every view more than 16 deep and resolves the rest.
#[test]
fn a_view_chain_of_any_length_is_bounded_at_16() {
    let n = 4_000;
    let mut src: String = (0..n).map(|i| format!("=== view {{#v{i} src=#v{}}}\n===\n\n", i + 1)).collect();
    src.push_str(&format!("=== table {{#v{n} format=csv header=1}}\nA\n1\n===\n"));
    let t = Instant::now();
    let d = geml::parse(&src);
    assert!(d.diagnostics.iter().all(|x| x.code == "view-source-too-deep"));
    assert_eq!(d.diagnostics.len(), n - 16);
    assert!(geml::project(&d).ends_with(r#"view(["A"] ["1"]) table(["A"] ["1"])"#));
    assert!(t.elapsed() < Duration::from_secs(20), "took {:?}", t.elapsed());
}

/// Round 6: a transclusion chain's every step costs a lookup, not a fresh
/// selection of its target: what each step takes in is worked out once. A
/// hundred embeds of a section from inside the section it embeds took ten
/// seconds, all of them inside the chain budget.
#[test]
fn a_transclusion_step_reads_its_target_once() {
    let k = 60;
    let src = format!("# a\n\n{}# b\n\n{}", "=== embed {src=#b}\n===\n\n".repeat(k), "=== embed {src=#a}\n===\n\n".repeat(k));
    let t = Instant::now();
    let d = geml::parse(&src);
    assert!(t.elapsed() < Duration::from_secs(10), "took {:?}", t.elapsed());
    // Every embed starts a chain that returns to its own section, as the
    // reference reports it.
    assert!(d.diagnostics.iter().all(|x| x.code == "transclusion-cycle"));
    assert_eq!(d.diagnostics.len(), 2 * k);
}

/// Round 6: every prose address of a document, and the stretch it names, is
/// worked out in one walk the first time an embed asks; the listing keeps
/// its addresses in a set. Each embed of a name no block declares rebuilt the
/// whole listing, by list membership.
#[test]
fn prose_addresses_are_listed_once() {
    let n = 1_500;
    let mut src: String = (0..n).map(|i| format!("=== note {{#b{i}}}\n===\n\np\n\n")).collect();
    src.extend((0..n).map(|i| format!("=== embed {{src=#nope{i}}}\n===\n\n")));
    let t = Instant::now();
    let d = geml::parse(&src);
    assert!(t.elapsed() < Duration::from_secs(10), "took {:?}", t.elapsed());
    assert_eq!(d.diagnostics.len(), n);
    assert_eq!(d.addresses.len(), 2 * n - 1);
}

/// Round 6: a reference that names no id is checked against the prose
/// addresses by one lookup of its NFD key, not a scan that normalizes each.
#[test]
fn an_unresolved_reference_is_one_lookup() {
    let n = 5_000;
    let mut src: String = (0..n).map(|i| format!("=== note {{#b{i}}}\n===\n\np\n\n")).collect();
    src.push_str(&"[[#nope]] ".repeat(n));
    let t = Instant::now();
    let d = geml::parse(&src);
    assert!(t.elapsed() < Duration::from_secs(10), "took {:?}", t.elapsed());
    assert_eq!(d.diagnostics.len(), n);
    assert!(geml::parse("=== note {#a}\n===\n\np\n\n=== note {#b}\n===\n\n[[#a-between-b]]\n").diagnostics.is_empty());
}

/// Round 6: a key `meta` defines twice is found by a set of NFD keys, within
/// one block and across blocks.
#[test]
fn duplicate_meta_keys_are_found_by_a_set() {
    let n = 8_000;
    let keys: String = (0..n).map(|i| format!("k{i} = 1\n")).collect();
    let t = Instant::now();
    let d = geml::parse(&format!("=== meta\n{keys}k0 = 2\n===\n\n=== meta\n{keys}===\n"));
    assert!(t.elapsed() < Duration::from_secs(10), "took {:?}", t.elapsed());
    assert_eq!(d.diagnostics.len(), n + 1);
    assert!(d.diagnostics.iter().all(|x| x.code == "duplicate-meta-key"));
    assert_eq!(codes("=== meta\ne\u{301} = 1\n\u{e9} = 2\n===\n"), ["duplicate-meta-key:warning"]);
}

/// Round 6: where every bracket, parenthesis and brace closes is worked out
/// once for the whole run of inline text, and a `[[…]]` target is parsed
/// only once it has a reference's shape, so an opener whose closer exists but
/// never pairs costs a lookup, not a scan to the end; a footnote's `]` is
/// sought only past its NAME.
#[test]
fn inline_openers_cost_a_lookup() {
    let n = 50_000;
    for (label, src) in [
        ("nested `[[`", format!("{}]]", "[[".repeat(n))),
        ("balanced brackets", format!("{}{}", "[".repeat(n), "]".repeat(n))),
        ("`[[#a` that never closes", format!("{}{}", "[[#a".repeat(n), "]]".repeat(n))),
        ("footnote openers", "[^".repeat(n)),
        ("image openers", format!("{}]", "![".repeat(n))),
        ("links each opening an attribute object", "[a](b){".repeat(n)),
        ("destinations that never close", format!("{}]", "[a](".repeat(n))),
    ] {
        let t = Instant::now();
        let d = geml::parse(&src);
        let _ = geml::project(&d);
        assert!(t.elapsed() < Duration::from_secs(10), "{label} took {:?}", t.elapsed());
    }
    // What the lookups find is what a scan finds.
    let d = geml::parse("[a `]` b](x){.c title=\"}\"} [[#t[\"]]\"]]] [^n] ![i [j](k)](m) [p](q\\)r)\n");
    assert_eq!(geml::project(&d), r##"link("x" "a " code("]") " b") " " ref("#t[\"]]\"]") " " fn("n") " " img("m") " " link("q\\)r" "p")"##);
}

fn height(ns: &[geml::model::Inline]) -> usize {
    use geml::model::Inline::*;
    ns.iter()
        .map(|n| match n {
            Emph(c) | Strong(c) | Strike(c) | Link { children: c, .. } | Image { alt: c, .. } => 1 + height(c),
            _ => 0,
        })
        .max()
        .unwrap_or(0)
}

/// Round 6: inline nesting is bounded through every kind of node at once —
/// emphasis inside an image's alt counts the image — so alts that each hold
/// their own stack of emphasis cannot build a tree thirty times the bound. A
/// pair refused as too deep keeps its contents' depth, so the pairs around it
/// are refused too, without regathering what lies between.
#[test]
fn inline_nesting_counts_every_node() {
    use geml::bounds::INLINE_NESTING as D;
    let paragraph = |d: &geml::Document| -> usize {
        let geml::model::Item::Paragraph(p) = &d.children[0] else { panic!() };
        height(&p.inlines)
    };
    let mut src = "x".to_string();
    for _ in 0..30 {
        src = format!("![{}{src}{}](u)", "*a ".repeat(60), " a*".repeat(60));
    }
    let t = Instant::now();
    let d = geml::parse(&src);
    assert!(paragraph(&d) <= D + 1, "{}", paragraph(&d));
    assert_eq!(geml::diagnostic_codes(&d), ["inline-nesting-too-deep:error"]);
    let _ = (geml::project(&d), geml::blocks_of(&d), geml::to_json(&d));
    assert_eq!(paragraph(&geml::parse(&format!("{}{}", "*a ".repeat(1_000), "a* ".repeat(1_000)))), D);
    let d = geml::parse(&format!("{}{}", "*a ".repeat(100_000), "a* ".repeat(100_000)));
    assert_eq!(paragraph(&d), D);
    let _ = (geml::project(&d), geml::blocks_of(&d));
    assert!(t.elapsed() < Duration::from_secs(10), "took {:?}", t.elapsed());
}

/// Round 6: three scans that asked about each line or character by walking
/// the rest of the input. A `=== x\` line is no fence, yet each one folded the
/// rest of a run of them to find out; each unmatched ``` opener searched to the
/// end of its body for a close; and a heading's id asked every code span about
/// every character. Each is one pass now.
#[test]
fn block_scanning_stays_linear() {
    let timed = |label: &str, src: String| {
        let t = Instant::now();
        let d = geml::parse(&src);
        eprintln!("{label}: {:?}", t.elapsed());
        assert!(t.elapsed() < Duration::from_secs(5), "{label} took {:?}", t.elapsed());
        d
    };
    timed("40 000 `=== x\\` lines", "=== x\\\n".repeat(40_000));
    timed("40 000 unmatched ``` openers", "```a\n".repeat(40_000));
    let d = timed("a heading of 40 000 code spans", format!("# {}x\n", "`a` ".repeat(40_000)));
    assert_eq!(d.ids, ["x"]);
}

/// Round 6: `table-cells` bounds one relation, and a document can hold any
/// number — twenty `=== view {src=#t limit=1}` lines over one million-cell
/// table copied it twenty times, and a `table {src=big.csv}` repeated read the
/// file once per block. Every relation read from elsewhere spends from one
/// budget per document, refused before the copy or the read once it is spent.
#[test]
fn views_and_data_files_share_one_budget_of_borrowed_cells() {
    use geml::bounds::BORROWED_CELLS;
    let width = 1000;
    let header: Vec<String> = (0..width).map(|i| format!("c{i}")).collect();
    let row = vec!["v"; width].join(",");
    let csv = format!("{}\n{}", header.join(","), vec![row.as_str(); 1000].join("\n"));
    let fit = BORROWED_CELLS / (width * 1000);
    let n = fit + 6;
    let refused = |d: &geml::Document| d.diagnostics.iter().filter(|x| x.code == "table-too-large" && x.message.contains("read from elsewhere")).count();
    let rows = |d: &geml::Document, ty: &str| -> Vec<usize> {
        d.children
            .iter()
            .filter_map(|it| match it {
                geml::model::Item::Block(b) if b.type_name == ty => Some(b.table.as_ref().map_or(0, |t| t.rows.len())),
                _ => None,
            })
            .collect()
    };

    let t = Instant::now();
    let views: String = (0..n).map(|i| format!("=== view {{#v{i} src=#t limit=1}}\n===\n\n")).collect();
    let d = geml::parse(&format!("=== table {{#t format=csv header=1}}\n{csv}\n===\n\n{views}"));
    assert_eq!(refused(&d), n - fit, "every view past the budget is refused");
    let want: Vec<usize> = std::iter::repeat(1).take(fit).chain(std::iter::repeat(0).take(n - fit)).collect();
    assert_eq!(rows(&d, "view"), want);

    let mut h = geml::host::MapHost::default();
    h.files.insert("big.csv".into(), csv.clone());
    let tables: String = (0..n).map(|i| format!("=== table {{#f{i} src=big.csv format=csv}}\n===\n\n")).collect();
    let d = geml::parse_with(&tables, &geml::Options { name: "doc.geml".into(), host: Some(&h), ..Default::default() });
    assert_eq!(refused(&d), n - fit, "every data file past the budget is refused");
    let want: Vec<usize> = std::iter::repeat(1000).take(fit).chain(std::iter::repeat(0).take(n - fit)).collect();
    assert_eq!(rows(&d, "table"), want);
    assert!(t.elapsed() < Duration::from_secs(30), "took {:?}", t.elapsed());
}

/// Round 6 (§6.1 column lists): a quote opens a name only at the start of an
/// entry, and the split keeps a flag to say so rather than trimming the entry
/// at every quote, which is quadratic in a `select=` of quotes.
#[test]
fn a_column_list_of_quotes_splits_in_linear_time() {
    let q = "'".repeat(200_000);
    let t = Instant::now();
    let d = geml::parse(&format!("=== table {{#t format=csv header=1}}\nN\n1\n===\n\n=== view {{#v src=#t select=\"N{q}\" order=\"N{q}\"}}\n===\n"));
    assert!(d.diagnostics.iter().any(|x| x.code == "view-unknown-column"));
    assert!(t.elapsed() < Duration::from_secs(2), "took {:?}", t.elapsed());
}
