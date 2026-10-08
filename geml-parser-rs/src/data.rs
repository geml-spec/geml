//! `data` (§3.2): a format engine reads the raw body into the block's value.

use crate::diag::Diags;
use crate::host::Host;
use crate::inline::scheme_of;
use crate::json::{self, Value};
use crate::model::Block;
use crate::route;

/// Why a format engine gave no value.
#[derive(Debug, PartialEq)]
pub enum Fail {
    /// The text does not parse; the line is 0-based within it.
    Parse(usize, String),
    /// The text parsed, but to a value outside the value tree (§3.2);
    /// reported on the block.
    Outside(String),
    /// A reserved format with no engine here.
    NoEngine,
    Unknown,
}

/// Read text under a data format (§3.2).
pub fn engine(format: &str, text: &str) -> Result<Value, Fail> {
    match format {
        "json" => json::parse(text).map_err(|e| Fail::Parse(e.line, format!("it is not one JSON value: {}", e.message))),
        "jsonl" => {
            let mut out = Vec::new();
            for (k, l) in text.split('\n').enumerate() {
                if l.trim().is_empty() {
                    continue;
                }
                out.push(json::parse(l).map_err(|e| Fail::Parse(k, format!("a line is not one JSON value: {}", e.message)))?);
            }
            Ok(Value::Array(out))
        }
        "yaml" => crate::yaml::parse(text).map_err(|(l, m)| Fail::Parse(l, format!("the yaml subset does not read it: {m}"))),
        // §3.2 reserves `edn` and defines no reading; this is the reference
        // implementation's (`crate::edn`).
        "edn" => crate::edn::parse(text).map_err(|e| match e.line {
            Some(l) => Fail::Parse(l, format!("it is not EDN this processor reads: {}", e.message)),
            None => Fail::Outside(e.message),
        }),
        "toml" => Err(Fail::NoEngine),
        _ => Err(Fail::Unknown),
    }
}

/// Read text under a data format, every failure kept: a `jsonl` body says
/// which of its lines are not JSON, each of them, where `engine` stops at the
/// first.
pub fn engine_each(format: &str, text: &str) -> Result<Value, Vec<Fail>> {
    if format != "jsonl" {
        return engine(format, text).map_err(|f| vec![f]);
    }
    let mut out = Vec::new();
    let mut fails = Vec::new();
    for (k, l) in text.split('\n').enumerate() {
        if l.trim().is_empty() {
            continue;
        }
        match json::parse(l) {
            Ok(v) => out.push(v),
            Err(e) => fails.push(Fail::Parse(k, format!("a line is not one JSON value: {}", e.message))),
        }
    }
    if fails.is_empty() {
        Ok(Value::Array(out))
    } else {
        Err(fails)
    }
}

/// §3.2's exactness rule over text an engine reads: each number literal that
/// binary64 does not read back as written — its 0-based line, the literal and
/// what it reads as. Only what the engine reads: a body that does not parse
/// has no numbers, save a `jsonl` body's lines that do.
pub fn inexact_numbers(format: &str, text: &str) -> Vec<(usize, String, String)> {
    let mut read: Vec<crate::num::NumberRead> = Vec::new();
    match format {
        "json" if json::parse(text).is_ok() => {
            for (off, lit) in json::number_literals(text) {
                if let Ok(v) = lit.parse::<f64>() {
                    read.push((text[..off].matches('\n').count(), lit.to_string(), v));
                }
            }
        }
        "jsonl" => {
            for (k, l) in text.split('\n').enumerate() {
                if l.trim().is_empty() || json::parse(l).is_err() {
                    continue;
                }
                for (_, lit) in json::number_literals(l) {
                    if let Ok(v) = lit.parse::<f64>() {
                        read.push((k, lit.to_string(), v));
                    }
                }
            }
        }
        "yaml" => read = crate::yaml::parse_numbers(text).map(|(_, nums)| nums).unwrap_or_default(),
        "edn" => read = crate::edn::parse_numbers(text).map(|(_, nums)| nums).unwrap_or_default(),
        _ => {}
    }
    read.into_iter().filter_map(|(line, lit, v)| crate::num::inexact_number(&lit, v).map(|shown| (line, lit, shown))).collect()
}

/// Report what an engine failed on. A parse failure is reported where `at`
/// places the failing line, with `what` naming the text.
fn report(fail: Fail, format: &str, line: usize, diags: &mut Diags, at: &dyn Fn(usize, String) -> (usize, String)) {
    match fail {
        Fail::Parse(l, m) => {
            let (n, msg) = at(l, m);
            diags.push("data-parse", n, msg)
        }
        Fail::Outside(m) => diags.push("data-parse", line, format!("the value is outside the value tree: {m}")),
        Fail::NoEngine => {
            diags.push("data-format-no-engine", line, format!("`format={format}` is reserved, and this processor ships no engine for it; the body is kept raw"))
        }
        Fail::Unknown => diags.push("unknown-data-format", line, format!("`format={format}` is not a data format; the body is kept raw")),
    }
}

/// Read a `data` block's value: its body under its `format=`, or, given a
/// host, the file its `src=` route names — the extension naming the format
/// unless `format=` is written (§3.2). `None` when there is no value: an
/// engine rejected it, the format has no engine here, or it arrives at render
/// time (an `http(s)` source, or no host to read a local one with).
pub fn read_data(b: &Block, diags: &mut Diags, host: Option<(&dyn Host, &str)>) -> Option<Value> {
    let line = b.line;
    if let Some(schema) = b.attr_text("schema") {
        let ok = match schema.find('#') {
            Some(0) => crate::uni::is_name(&schema[1..]),
            Some(h) => schema[..h].to_ascii_lowercase().ends_with(".geml") && crate::uni::is_name(&schema[h + 1..]),
            None => schema.to_ascii_lowercase().ends_with(".geml"),
        };
        if !ok {
            diags.push("bad-data-schema", line, format!("`schema={schema}` is neither `#id` nor `doc.geml[#id]`"));
        }
    }
    let has_body = b.has_body();
    let written = b.attr_text("format");
    if let Some(src) = b.attr_text("src") {
        if has_body {
            diags.push("data-src-and-body", line, "a data block carries both `src=` and an inline body; the body wins");
        } else {
            return read_source(&src, written.as_deref(), line, diags, host);
        }
    }
    let format = written.unwrap_or_else(|| "json".to_string());
    let text = b.raw.join("\n");
    let out = match engine_each(&format, &text) {
        Ok(v) => Some(v),
        Err(fails) => {
            for f in fails {
                report(f, &format, line, diags, &|l, m| (b.body_start + l, format!("the body does not parse: {m}")));
            }
            None
        }
    };
    for (l, lit, shown) in inexact_numbers(&format, &text) {
        diags.push("inexact-number", b.body_start + l, crate::num::inexact_message(&lit, &shown));
    }
    out
}

fn read_source(src: &str, written: Option<&str>, line: usize, diags: &mut Diags, host: Option<(&dyn Host, &str)>) -> Option<Value> {
    let remote = match scheme_of(src) {
        Some(s) if s == "http" || s == "https" => true,
        Some(_) => {
            diags.push("unresolvable-data-source", line, format!("`src={src}` names a URL scheme a data source may not use"));
            return None;
        }
        None => false,
    };
    let route = match route::parse(src) {
        Ok(r) => r,
        Err(f) => {
            diags.push("bad-source-range", line, format!("`#{f}` is not `#L<start>[-<end>]` naming a non-empty range"));
            return None;
        }
    };
    if remote {
        return None;
    }
    let Some(by_ext) = route::data_format(&route.path) else {
        diags.push("bad-data-source", line, format!("`src={src}` does not name a .json, .jsonl, .yaml or .yml file"));
        return None;
    };
    let (host, from) = host?;
    let Some(text) = route::read(host, from, &route.path) else {
        diags.push("unresolvable-data-source", line, format!("`src={src}` could not be read"));
        return None;
    };
    let Ok(body) = route::window(&text, route.range).map_err(|n| {
        diags.push("bad-source-range", line, format!("`src={src}` names lines `{}` no longer has: it has {n}", route.path));
    }) else {
        return None;
    };
    let format = written.unwrap_or(by_ext);
    let first = route.range.map_or(1, |(a, _)| a);
    let out = engine_each(format, &body)
        .map_err(|fails| {
            for f in fails {
                report(f, format, line, diags, &|l, m| (line, format!("`{}` does not parse at line {}: {m}", route.path, first + l)));
            }
        })
        .ok();
    // A file's lines are not this document's: what it holds is said on the block.
    for (_, lit, shown) in inexact_numbers(format, &body) {
        diags.push("inexact-number", line, crate::num::inexact_message(&lit, &shown));
    }
    out
}
