//! GEP 0011: a coordinate addresses a unit INSIDE a block — a table's rows,
//! cells and columns, or a node of a `data` block's value tree, or a `meta`
//! key. A coordinate has no span of the file, so it is answered from the
//! model; a write is planned as the block's new body, which the caller puts
//! back between the fences through the same guarded splice `set --body` uses.

use crate::json::{self, quote, to_json, Value};
use crate::model::{Block, Cell, Item, Mode, Table};
use crate::num::es_string;

use super::selector::CoordStep;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Leaf,
    Row,
    Column,
    Tree,
}

/// What a coordinate landed on: `text` is what `get` prints.
#[derive(Clone, Debug)]
pub struct Hit {
    pub text: String,
    pub json: Value,
    pub shape: Shape,
}

/// The typed block of the model whose opening fence is on `line` (1-based),
/// searched through flow bodies too.
pub fn model_block(items: &[Item], line: usize) -> Option<&Block> {
    for it in items {
        if let Item::Block(b) = it {
            if b.line == line {
                return Some(b);
            }
            if let Some(found) = model_block(&b.children, line) {
                return Some(found);
            }
        }
    }
    None
}

pub fn step_text(s: &CoordStep) -> String {
    match s {
        CoordStep::Index(n) => format!("[{n}]"),
        CoordStep::Word(w) => format!("[{w}]"),
        CoordStep::Key(k) => format!("[\"{k}\"]"),
    }
}

pub fn path_text(path: &[CoordStep]) -> String {
    path.iter().map(step_text).collect()
}

fn attr_str(block: &Block, key: &str) -> Option<String> {
    match block.attr(key) {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

fn delim_of(block: &Block) -> String {
    match attr_str(block, "delim") {
        Some(d) if d.chars().count() == 1 => d,
        _ => ",".to_string(),
    }
}

/// The one column namespace (§6): a header name, or the letter that IS the
/// name when the table has no header row.
fn column_index(table: &Table, name: &str) -> Option<usize> {
    if let Some(i) = table.columns.iter().position(|c| c == name) {
        return Some(i);
    }
    let mut chars = name.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii_uppercase() => {
            let i = (c as u8 - b'A') as usize;
            (i < table.columns.len()).then_some(i)
        }
        _ => None,
    }
}

fn cell_json(c: &Cell) -> Value {
    let mut f = vec![("text".to_string(), Value::String(c.text.clone()))];
    if let Some(n) = c.num {
        f.push(("value".to_string(), Value::Number(n)));
    }
    Value::Object(f)
}

pub fn escape_cell_pipes(text: &str) -> String {
    text.replace('|', "\\|")
}

/// A row printed back as one line, in the body form the block was written in.
fn row_text(block: &Block, cells: &[Cell]) -> String {
    let texts: Vec<&str> = cells.iter().map(|c| c.text.as_str()).collect();
    match attr_str(block, "format").as_deref() {
        Some("tsv") => texts.join("\t"),
        Some("csv") => texts.join(&format!("{} ", delim_of(block))),
        _ => format!("| {} |", texts.iter().map(|t| escape_cell_pipes(t)).collect::<Vec<_>>().join(" | ")),
    }
}

fn columns_list(table: &Table) -> String {
    table.columns.iter().map(|c| format!("`{c}`")).collect::<Vec<_>>().join(", ")
}

fn project_table(block: &Block, table: &Table, path: &[CoordStep]) -> Result<Hit, String> {
    let first = &path[0];
    let (cells, what_row): (&[Cell], String) = match first {
        CoordStep::Index(n) => {
            if *n < 1 {
                return Err(format!("a row index starts at 1 (the header is not a row), so `{}` addresses nothing", step_text(first)));
            }
            match table.rows.get(n - 1) {
                Some(r) => (r, format!("row {n}")),
                None => {
                    let rows = table.rows.len();
                    return Err(format!("this table has {rows} body row{}, so `{}` addresses nothing", if rows == 1 { "" } else { "s" }, step_text(first)));
                }
            }
        }
        CoordStep::Word(w) => {
            if w != "summary" {
                return Err(format!("`{}` is not a row this table has — `[summary]` is the only reserved row name (GEP 0011)", step_text(first)));
            }
            match &table.summary {
                Some(s) => (s, "the summary row".to_string()),
                None => return Err("this table has no `summary=` foot row, so `[summary]` addresses nothing".to_string()),
            }
        }
        CoordStep::Key(name) => {
            if path.len() > 1 {
                return Err(format!("a column takes no further step, so `{}` addresses nothing — write `[<row>][\"{name}\"]` for one cell", path_text(path)));
            }
            let Some(ci) = column_index(table, name) else {
                return Err(format!("this table has no column `{name}` (it has {})", columns_list(table)));
            };
            let column: Vec<&Cell> = table.rows.iter().filter_map(|r| r.get(ci)).collect();
            return Ok(Hit {
                text: column.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join("\n"),
                json: Value::Array(column.iter().map(|c| cell_json(c)).collect()),
                shape: Shape::Column,
            });
        }
    };
    if path.len() == 1 {
        return Ok(Hit { text: row_text(block, cells), json: Value::Array(cells.iter().map(cell_json).collect()), shape: Shape::Row });
    }
    let second = &path[1];
    let CoordStep::Key(name) = second else {
        return Err(format!("inside a row, a step names a column: write `[\"<column>\"]` rather than `{}`", step_text(second)));
    };
    if path.len() > 2 {
        return Err(format!("a cell takes no further step, so `{}` addresses nothing", path_text(path)));
    }
    let Some(ci) = column_index(table, name) else {
        return Err(format!("this table has no column `{name}` (it has {})", columns_list(table)));
    };
    let Some(cell) = cells.get(ci) else {
        return Err(format!("{what_row} has no cell in column `{name}`"));
    };
    Ok(Hit { text: cell.text.clone(), json: cell_json(cell), shape: Shape::Leaf })
}

fn describe(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Array(_) => "a sequence",
        Value::Object(_) => "a map",
        Value::String(_) => "a string",
        Value::Number(_) => "a number",
        Value::Bool(_) => "a boolean",
    }
}

/// A value tree walks by KEY into a map and by INDEX into a sequence
/// (0-based; rows above are 1-based).
pub fn project_value(value: &Value, path: &[CoordStep]) -> Result<Hit, String> {
    let mut cur = value;
    let mut walked: Vec<CoordStep> = Vec::new();
    for step in path {
        walked.push(step.clone());
        let so_far = path_text(&walked);
        match step {
            CoordStep::Word(w) => {
                return Err(format!("a value tree has no reserved names, so `{}` addresses nothing — quote it (`[\"{w}\"]`) to name a key", step_text(step)));
            }
            CoordStep::Key(k) => {
                let Value::Object(m) = cur else {
                    return Err(format!("`{so_far}` names a key, but what it steps into is {}", describe(cur)));
                };
                match m.iter().find(|(mk, _)| mk == k) {
                    Some((_, v)) => cur = v,
                    None => {
                        let above = path_text(&walked[..walked.len() - 1]);
                        return Err(format!(
                            "no key `{k}` {}",
                            if above.is_empty() { "at the root of this value tree".to_string() } else { format!("at `{above}`") }
                        ));
                    }
                }
            }
            CoordStep::Index(n) => {
                let Value::Array(a) = cur else {
                    return Err(format!("`{so_far}` names a position, but what it steps into is {}", describe(cur)));
                };
                let Some(v) = a.get(*n) else {
                    return Err(format!("`{so_far}` is out of range: that sequence has {} element{}", a.len(), if a.len() == 1 { "" } else { "s" }));
                };
                cur = v;
            }
        }
    }
    let shape = if matches!(cur, Value::Object(_) | Value::Array(_)) { Shape::Tree } else { Shape::Leaf };
    let text = match cur {
        Value::String(s) => s.clone(),
        other => to_json(other),
    };
    Ok(Hit { text, json: cur.clone(), shape })
}

fn no_value_tree(block: &Block) -> String {
    let fmt = attr_str(block, "format").unwrap_or_else(|| "json".to_string());
    if matches!(fmt.as_str(), "json" | "jsonl" | "yaml" | "edn") {
        format!("this `data` block's body did not parse as `{fmt}`, so it has no value tree to address")
    } else {
        format!("this `data` block declares `format={fmt}`, which this processor keeps raw — there is no value tree to address")
    }
}

fn no_units(block: &Block, path: &[CoordStep]) -> String {
    let why = format!(
        "`{}` carries no addressable units inside it — a coordinate needs a table, a `data` block, `meta` (GEP 0011), or a `form` (GEP 0008)",
        block.type_name
    );
    if block.type_name == "embed" {
        if let Some(src) = attr_str(block, "src") {
            if src.contains('#') {
                return format!("{why}; address it on the embed's source instead: `{src}{}`", path_text(path));
            }
        }
    }
    why
}

/// Project a coordinate onto the block its base resolved to.
pub fn project_coord(block: &Block, path: &[CoordStep]) -> Result<Hit, String> {
    if path.is_empty() {
        return Err("a coordinate needs at least one `[…]` step".to_string());
    }
    if block.type_name == "view" && block.table.as_ref().map_or(true, |t| t.columns.is_empty()) {
        return Err("this view's `src=` did not resolve, so it has no rows to address".to_string());
    }
    if block.type_name == "form" || block.type_name == "form-group" {
        return Err(format!("a {}'s fields are addressed on the reference implementation only here — not projected by this crate yet", block.type_name));
    }
    if let Some(t) = &block.table {
        return project_table(block, t, path);
    }
    if let Some(v) = &block.value {
        return project_value(v, path);
    }
    if block.mode == Mode::Data {
        return project_value(&Value::Object(block.data.clone()), path);
    }
    if block.type_name == "data" {
        return Err(no_value_tree(block));
    }
    Err(no_units(block, path))
}

// --------------------------------------------------------------------------
// Writes
// --------------------------------------------------------------------------

fn one_line(v: &str) -> bool {
    !v.contains(['\r', '\n'])
}

/// `JSON.stringify(v, null, 2)`.
pub fn pretty_json(v: &Value) -> String {
    fn write(v: &Value, depth: usize, out: &mut String) {
        let pad = "  ".repeat(depth);
        match v {
            Value::Array(a) if a.is_empty() => out.push_str("[]"),
            Value::Object(m) if m.is_empty() => out.push_str("{}"),
            Value::Array(a) => {
                out.push_str("[\n");
                for (i, x) in a.iter().enumerate() {
                    out.push_str(&pad);
                    out.push_str("  ");
                    write(x, depth + 1, out);
                    if i + 1 < a.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&pad);
                out.push(']');
            }
            Value::Object(m) => {
                out.push_str("{\n");
                for (i, (k, x)) in m.iter().enumerate() {
                    out.push_str(&pad);
                    out.push_str("  ");
                    out.push_str(&quote(k));
                    out.push_str(": ");
                    write(x, depth + 1, out);
                    if i + 1 < m.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&pad);
                out.push('}');
            }
            Value::String(s) => out.push_str(&quote(s)),
            Value::Number(n) => out.push_str(&es_string(*n)),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Null => out.push_str("null"),
        }
    }
    let mut out = String::new();
    write(v, 0, &mut out);
    out
}

/// A meta value as §4 writes one: a bare number or boolean, anything else quoted.
pub fn meta_literal(v: &Value) -> String {
    match v {
        Value::Number(_) | Value::Bool(_) => to_json(v),
        Value::String(s) => quote(s),
        other => quote(&to_json(other)),
    }
}

/// What the text a write puts into a value tree stands for: JSON when it
/// parses as JSON, a string when it does not — so `1.3.0` stays a string while
/// `42` and `{"a":1}` arrive as themselves. JSON the value domain excludes
/// (§3.2) is no value at all, and `Err` says why: a key twice in one map, a
/// lone surrogate, a number past binary64's range, a tree past `data-depth`
/// — judged on the text, before any tree is built.
/// With the value, the content's own JSON text — JSON's white space around it
/// dropped — when it is JSON: what a write puts in as written.
pub fn read_content(value: &str) -> Result<(Value, Option<String>), String> {
    if json::too_deep(value).is_some() {
        return Err(format!("nesting deeper than {} levels is outside what this processor reads", crate::bounds::DATA_DEPTH));
    }
    match json::parse(value) {
        Ok(v) => Ok((v, Some(value.trim_matches([' ', '\t', '\n', '\r']).to_string()))),
        Err(e) if json::is_json(value) => Err(format!("{}, which the value domain excludes (I-JSON)", e.message)),
        Err(_) => Ok((Value::String(value.to_string()), None)),
    }
}

/// Why a coordinate edit planned no new body.
#[derive(Debug)]
pub enum NotPlanned {
    /// An address the unit's shape does not admit (`bad-address`).
    Address(String),
    /// Content the value tree cannot hold: the block would carry
    /// `data-parse` (`broken-result`).
    Broken(String),
    /// An insertion's anchor is not there (`no-such-unit`).
    Missing(String),
    /// A removal whose target is not there: `delete` ensures absence, so
    /// there is nothing to do.
    Absent,
}

impl From<String> for NotPlanned {
    fn from(why: String) -> NotPlanned {
        NotPlanned::Address(why)
    }
}

/// What a coordinate's edit does at the end of its path: `set` puts a value
/// there (one past a sequence's last element appends, a key a map does not
/// have is added); `add --before/--after` inserts an element beside a
/// sequence's element; `delete` removes a member or an element.
#[derive(Clone, Debug)]
pub enum TreeEdit {
    Put(String),
    Insert { value: String, before: bool },
    Remove,
}

/// Plan the write of one meta key into a `meta` body: a key already there
/// keeps its spelling and spacing, only the value changes; a new key is
/// appended after the last non-blank line.
pub fn plan_meta_write(key: &str, value: &str, body: &[String]) -> Result<Vec<String>, String> {
    if !one_line(value) {
        return Err("a meta value is one line; the replacement spans several".to_string());
    }
    let (parsed, _) = read_content(value).map_err(|why| format!("a meta value is a string, a number or a boolean; this content is JSON with {why}"))?;
    // §4: a meta value is a scalar; a map or a sequence has no meta literal.
    if let Value::Array(_) | Value::Object(_) = parsed {
        let what = if matches!(parsed, Value::Array(_)) { "sequence" } else { "map" };
        return Err(format!("a meta value is a string, a number or a boolean; this content is a JSON {what}"));
    }
    let literal = meta_literal(&parsed);
    let mut out: Vec<String> = body.to_vec();
    let at = out.iter().position(|l| {
        let t = l.trim_start();
        t.strip_prefix(key).is_some_and(|rest| rest.trim_start().starts_with('='))
    });
    if let Some(i) = at {
        let line = &out[i];
        let eq = line.find('=').expect("found above");
        let after = &line[eq + 1..];
        let lead_ws = after.len() - after.trim_start().len();
        out[i] = format!("{}{literal}", &line[..eq + 1 + lead_ws]);
        return Ok(out);
    }
    let mut end = out.len();
    while end > 0 && out[end - 1].trim().is_empty() {
        end -= 1;
    }
    out.insert(end, format!("{key} = {literal}"));
    Ok(out)
}

/// The field extents of a delimited line, so a cell can be replaced without
/// rejoining the whole row.
fn replace_field(line: &str, sep: &str, ci: usize, value: &str) -> Option<String> {
    let mut parts: Vec<String> = line.split(sep).map(str::to_string).collect();
    let field = parts.get(ci)?.clone();
    let a = field.len() - field.trim_start().len();
    let b = field.trim_end().len().max(a);
    parts[ci] = format!("{}{value}{}", &field[..a], &field[b..]);
    Some(parts.join(sep))
}

/// Which body line each body row was parsed from: a visual grid's rows are
/// its `|` lines after the header and separator; a delimited body's are its
/// non-blank lines after the header.
/// The body line each body row was read from, by the rule the table was read
/// by (`crate::table`): a data form's lines after its header line, when it
/// has one; a pipe grid's lines after its first separator row, or all of them.
fn row_lines(block: &Block, body: &[String]) -> Vec<usize> {
    let kept: Vec<usize> = body.iter().enumerate().filter(|(_, l)| !crate::uni::trim_ws(l).is_empty()).map(|(i, _)| i).collect();
    let fmt = attr_str(block, "format");
    if matches!(fmt.as_deref(), Some("csv") | Some("tsv")) {
        let header = crate::table::header_wanted(block.attr("header"));
        return if header { kept.into_iter().skip(1).collect() } else { kept };
    }
    match kept.iter().position(|i| crate::table::is_separator(&crate::table::split_visual(&body[*i]))) {
        Some(s) => kept[s + 1..].to_vec(),
        None => kept,
    }
}

fn write_table(block: &Block, table: &Table, path: &[CoordStep], value: &str, body: &[String]) -> Result<Vec<String>, String> {
    let first = &path[0];
    let n = match first {
        CoordStep::Word(w) => {
            if w == "summary" {
                return Err("the summary row is declared in `summary=`, not written in the body — edit that attribute".to_string());
            }
            return Err(format!("`{}` is not a row this table has — `[summary]` is the only reserved row name", step_text(first)));
        }
        CoordStep::Key(k) => {
            return Err(format!("a column is one unit per row and `set` writes one — address a cell: `[<row>][\"{k}\"]`"));
        }
        CoordStep::Index(n) => *n,
    };
    if attr_str(block, "src").is_some() {
        return Err("these rows are not in this document — they arrive through `src=`, so edit the source they come from".to_string());
    }
    if n < 1 {
        return Err(format!("a row index starts at 1 (the header is not a row), so `{}` addresses nothing", step_text(first)));
    }
    let lines = row_lines(block, body);
    let (Some(cells), Some(&line_idx)) = (table.rows.get(n - 1), lines.get(n - 1)) else {
        let rows = table.rows.len();
        return Err(format!("this table has {rows} body row{}, so `{}` addresses nothing", if rows == 1 { "" } else { "s" }, step_text(first)));
    };
    let Some(line) = body.get(line_idx) else {
        return Err("that row has no line in this body — it was not parsed from one".to_string());
    };
    if !one_line(value) {
        return Err("a row is one line; the replacement spans several".to_string());
    }
    let mut out: Vec<String> = body.to_vec();
    if path.len() == 1 {
        let t = value.trim_start_matches([' ', '\t']);
        let fence = t.starts_with("===") && t[3..].trim_start_matches('=').chars().next().map_or(true, |c| c == ' ' || c == '\t');
        if fence || t.starts_with("%%") {
            return Err("a row cannot begin with a fence (`===`) or a hidden-line marker (`%%`) — the body would be re-read as block structure".to_string());
        }
        out[line_idx] = value.to_string();
        return Ok(out);
    }
    let CoordStep::Key(name) = &path[1] else {
        return Err(format!("inside a row, a step names a column: write `[\"<column>\"]` rather than `{}`", step_text(&path[1])));
    };
    if path.len() > 2 {
        return Err(format!("a cell takes no further step, so `{}` addresses nothing", path_text(path)));
    }
    let Some(ci) = column_index(table, name) else {
        return Err(format!("this table has no column `{name}` (it has {})", columns_list(table)));
    };
    let fmt = attr_str(block, "format");
    if matches!(fmt.as_deref(), Some("csv") | Some("tsv")) {
        let d = if fmt.as_deref() == Some("tsv") { "\t".to_string() } else { delim_of(block) };
        if value.contains(&d) {
            let shown = if d == "\t" { "a tab".to_string() } else { format!("`{d}`") };
            return Err(format!("that value contains {shown}, the delimiter this body splits on, so writing it would re-split the row — use a visual pipe grid, or `delim=` another character"));
        }
        let fields = line.split(d.as_str()).count();
        let Some(rewritten) = replace_field(line, &d, ci, value) else {
            return Err(format!("row {n} has {fields} field{}, so column {} has no cell to write", if fields == 1 { "" } else { "s" }, ci + 1));
        };
        out[line_idx] = rewritten;
        return Ok(out);
    }
    let mut texts: Vec<String> = cells.iter().map(|c| c.text.clone()).collect();
    if ci >= texts.len() {
        texts.resize(ci + 1, String::new());
    }
    texts[ci] = value.to_string();
    out[line_idx] = format!("| {} |", texts.iter().map(|t| escape_cell_pipes(t)).collect::<Vec<_>>().join(" | "));
    Ok(out)
}

fn get_mut<'a>(root: &'a mut Value, path: &[CoordStep]) -> Result<&'a mut Value, String> {
    let mut cur = root;
    let mut walked: Vec<CoordStep> = Vec::new();
    for step in path {
        walked.push(step.clone());
        let so_far = path_text(&walked);
        cur = match (step, cur) {
            (CoordStep::Word(w), _) => {
                return Err(format!("a value tree has no reserved names, so `[{w}]` addresses nothing — quote it (`[\"{w}\"]`) to name a key"));
            }
            (CoordStep::Key(k), Value::Object(m)) => match m.iter_mut().find(|(mk, _)| mk == k) {
                Some((_, v)) => v,
                None => return Err(format!("no key `{k}` at `{so_far}`")),
            },
            (CoordStep::Key(_), other) => return Err(format!("`{so_far}` names a key, but what it steps into is {}", describe(other))),
            (CoordStep::Index(n), Value::Array(a)) => {
                let len = a.len();
                match a.get_mut(*n) {
                    Some(v) => v,
                    None => return Err(format!("`{so_far}` is out of range: that sequence has {len} element{}", if len == 1 { "" } else { "s" })),
                }
            }
            (CoordStep::Index(_), other) => return Err(format!("`{so_far}` names a position, but what it steps into is {}", describe(other))),
        };
    }
    Ok(cur)
}

/// A value-tree edit. The target is found by the read projection, so the two
/// agree about a wrong turn; a json or jsonl body is edited by splicing its own
/// text — the new value goes where the old one stood, or beside its
/// neighbours — and every other byte stays: the neighbour a re-serialization
/// would have rounded, and the author's layout.
fn edit_value(block: &Block, path: &[CoordStep], edit: &TreeEdit, root: &Value, body: &[String]) -> Result<Vec<String>, NotPlanned> {
    let content = match edit {
        TreeEdit::Put(v) | TreeEdit::Insert { value: v, .. } => Some(read_content(v).map_err(|why| NotPlanned::Broken(format!("data: {why}")))?),
        TreeEdit::Remove => None,
    };
    let mut root = root.clone();
    project_value(&root, &path[..path.len() - 1])?;
    let cur = get_mut(&mut root, &path[..path.len() - 1])?;
    let last = &path[path.len() - 1];
    match (last, &*cur) {
        (CoordStep::Word(_), _) => return Err(format!("a value tree has no reserved names, so `{}` addresses nothing", step_text(last)).into()),
        (CoordStep::Key(k), Value::Object(m)) => {
            if matches!(edit, TreeEdit::Insert { .. }) {
                return Err(format!(
                    "`{}` names a map's member, and a map has no order to insert into — add a member by writing its key with `set`",
                    path_text(path)
                )
                .into());
            }
            if matches!(edit, TreeEdit::Remove) && !m.iter().any(|(mk, _)| mk == k) {
                return Err(NotPlanned::Absent);
            }
        }
        (CoordStep::Key(_), other) => return Err(format!("`{}` names a key, but what it steps into is {}", path_text(path), describe(other)).into()),
        (CoordStep::Index(n), Value::Array(a)) => {
            let len = a.len();
            let shown = format!("{len} element{}", if len == 1 { "" } else { "s" });
            match edit {
                TreeEdit::Remove if *n >= len => return Err(NotPlanned::Absent),
                TreeEdit::Insert { .. } if *n >= len => {
                    return Err(NotPlanned::Missing(format!(
                        "`{}` is out of range: that sequence has {shown}, so there is no element to insert beside",
                        path_text(path)
                    )))
                }
                TreeEdit::Put(_) if *n > len => {
                    return Err(format!(
                        "`{}` is out of range: that sequence has {shown} — `[{len}]` appends one, and `set` writes no further",
                        path_text(path)
                    )
                    .into())
                }
                _ => {}
            }
        }
        (CoordStep::Index(_), other) => return Err(format!("`{}` names a position, but what it steps into is {}", path_text(path), describe(other)).into()),
    }
    let fmt = attr_str(block, "format").unwrap_or_else(|| "json".to_string());
    match fmt.as_str() {
        // Written back AS EDN, the whole tree: an edit does not change a
        // block's format.
        "edn" => {
            let parsed = content.map(|(v, _)| v);
            match (last, cur) {
                (CoordStep::Key(k), Value::Object(m)) => match parsed {
                    None => m.retain(|(mk, _)| mk != k),
                    Some(v) => match m.iter_mut().find(|(mk, _)| mk == k) {
                        Some((_, slot)) => *slot = v,
                        None => m.push((k.clone(), v)),
                    },
                },
                (CoordStep::Index(n), Value::Array(a)) => match (edit, parsed) {
                    (TreeEdit::Remove, _) => {
                        a.remove(*n);
                    }
                    (TreeEdit::Insert { before, .. }, Some(v)) => a.insert(if *before { *n } else { *n + 1 }, v),
                    (_, Some(v)) if *n == a.len() => a.push(v),
                    (_, Some(v)) => a[*n] = v,
                    _ => unreachable!("a value for every edit but a removal"),
                },
                _ => unreachable!("checked above"),
            }
            Ok(crate::edn::serialize(&root))
        }
        "json" | "jsonl" => {
            // The new value's text: the content as written when it is JSON, a
            // string literal when it is not.
            let text = match (edit, content) {
                (TreeEdit::Put(v) | TreeEdit::Insert { value: v, .. }, Some((_, json_text))) => json_text.unwrap_or_else(|| quote(v)),
                _ => String::new(),
            };
            let with = |t: String| match edit {
                TreeEdit::Put(_) => TreeEdit::Put(t),
                TreeEdit::Insert { before, .. } => TreeEdit::Insert { value: t, before: *before },
                TreeEdit::Remove => TreeEdit::Remove,
            };
            if fmt == "json" {
                return Ok(edit_json(&body.join("\n"), path, &with(text)).split('\n').map(str::to_string).collect());
            }
            // One record per line: a record is added or removed as its line,
            // and an edit inside one changes that line only, the new value
            // folded onto it.
            let folded = with(fold_lines(&text));
            let CoordStep::Index(n) = path[0] else { unreachable!("a jsonl body is a sequence") };
            let records: Vec<usize> = body.iter().enumerate().filter(|(_, l)| !l.trim().is_empty()).map(|(i, _)| i).collect();
            let mut out = body.to_vec();
            if path.len() == 1 {
                match &folded {
                    TreeEdit::Remove => {
                        out.remove(records[n]);
                        return Ok(out);
                    }
                    TreeEdit::Insert { value, before } => {
                        out.insert(if *before { records[n] } else { records[n] + 1 }, value.clone());
                        return Ok(out);
                    }
                    TreeEdit::Put(value) if n == records.len() => {
                        out.insert(records.last().map_or(out.len(), |l| l + 1), value.clone());
                        return Ok(out);
                    }
                    TreeEdit::Put(_) => {}
                }
            }
            let at = records[n];
            let line = out[at].clone();
            let js_ws = |c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}');
            let from = line.len() - line.trim_start_matches(js_ws).len();
            let to = line.trim_end_matches(js_ws).len().max(from);
            let record = match (&folded, path.len()) {
                (TreeEdit::Put(v), 1) => v.clone(),
                _ => edit_json(&line[from..to], &path[1..], &folded),
            };
            out[at] = format!("{}{record}{}", &line[..from], &line[to..]);
            Ok(out)
        }
        other => Err(format!(
            "this processor reads `{other}` but does not write it, so a coordinate edit here would rewrite the body as JSON — edit the block's body instead"
        )
        .into()),
    }
}

/// Each run of white space holding a line break folded to one space.
fn fold_lines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = String::new();
    for c in s.chars() {
        if c.is_whitespace() {
            run.push(c);
            continue;
        }
        out.push_str(if run.contains('\n') { " " } else { &run });
        run.clear();
        out.push(c);
    }
    out.push_str(if run.contains('\n') { " " } else { &run });
    out
}

/// Where a value of a JSON text starts and ends, and — a map — where each
/// member's key does. Read off a text the parser already accepted, inside
/// `data-depth`, so the recursion is bounded.
struct Spot {
    start: usize,
    end: usize,
    items: Vec<Spot>,
    members: Vec<Member>,
    map: bool,
}

struct Member {
    key: String,
    key_start: usize,
    key_end: usize,
    value: Spot,
}

fn spot(text: &str, i: usize) -> Spot {
    let s = text.as_bytes();
    let ws = |mut k: usize| {
        while k < s.len() && matches!(s[k], b' ' | b'\t' | b'\n' | b'\r') {
            k += 1;
        }
        k
    };
    let string_end = |k: usize| {
        let mut j = k + 1;
        while s[j] != b'"' {
            j += if s[j] == b'\\' { 2 } else { 1 };
        }
        j + 1
    };
    let leaf = |end: usize| Spot { start: i, end, items: Vec::new(), members: Vec::new(), map: false };
    match s[i] {
        b'{' => {
            let mut members = Vec::new();
            let mut k = ws(i + 1);
            while s[k] != b'}' {
                let key_start = k;
                let key_end = string_end(k);
                let value = spot(text, ws(ws(key_end) + 1));
                let key = match json::parse(&text[key_start..key_end]) {
                    Ok(Value::String(key)) => key,
                    _ => unreachable!("a member name is a string"),
                };
                k = ws(value.end);
                members.push(Member { key, key_start, key_end, value });
                if s[k] == b',' {
                    k = ws(k + 1);
                }
            }
            Spot { start: i, end: k + 1, items: Vec::new(), members, map: true }
        }
        b'[' => {
            let mut items = Vec::new();
            let mut k = ws(i + 1);
            while s[k] != b']' {
                let item = spot(text, k);
                k = ws(item.end);
                items.push(item);
                if s[k] == b',' {
                    k = ws(k + 1);
                }
            }
            Spot { start: i, end: k + 1, items, members: Vec::new(), map: false }
        }
        b'"' => leaf(string_end(i)),
        _ => {
            let mut k = i;
            while k < s.len() && !matches!(s[k], b' ' | b'\t' | b'\n' | b'\r' | b',' | b']' | b'}') {
                k += 1;
            }
            leaf(k)
        }
    }
}

/// `text` with one edit at `path`. A new member or element goes after the
/// container's last one, or beside its anchor, separated the way its
/// neighbours are separated from each other — a sole one: on a line of its own
/// when it stands on one, else after `, `. A removed one takes the separator
/// after it (the one before it, when it is the last), and a container left
/// empty is `{}` or `[]`.
fn edit_json(text: &str, path: &[CoordStep], edit: &TreeEdit) -> String {
    let lead = text.len() - text.trim_start_matches([' ', '\t', '\n', '\r']).len();
    let root = spot(text, lead);
    let mut at = &root;
    for step in &path[..path.len() - 1] {
        at = match step {
            CoordStep::Key(k) => &at.members.iter().find(|m| &m.key == k).expect("found by the projection").value,
            CoordStep::Index(n) => &at.items[*n],
            CoordStep::Word(_) => unreachable!("refused by the projection"),
        };
    }
    let entries: Vec<(usize, usize)> =
        if at.map { at.members.iter().map(|m| (m.key_start, m.value.end)).collect() } else { at.items.iter().map(|s| (s.start, s.end)).collect() };
    let last = &path[path.len() - 1];
    let i = match last {
        CoordStep::Index(n) => Some(*n),
        CoordStep::Key(name) => at.members.iter().position(|m| &m.key == name),
        CoordStep::Word(_) => unreachable!("refused by the projection"),
    };
    let sep = |k: usize| -> String {
        if k > 0 {
            return text[entries[k - 1].1..entries[k].0].to_string();
        }
        if entries.len() > 1 {
            return text[entries[0].1..entries[1].0].to_string();
        }
        let before = &text[at.start + 1..entries[0].0];
        match before.rfind('\n') {
            Some(nl) => format!(",{}", &before[nl..]),
            None => ", ".to_string(),
        }
    };
    let (open_close, n) = (if at.map { "{}" } else { "[]" }, entries.len());
    match (edit, i) {
        (TreeEdit::Remove, Some(i)) => {
            if n == 1 {
                format!("{}{open_close}{}", &text[..at.start], &text[at.end..])
            } else if i + 1 < n {
                format!("{}{}", &text[..entries[i].0], &text[entries[i + 1].0..])
            } else {
                format!("{}{}", &text[..entries[i - 1].1], &text[entries[i].1..])
            }
        }
        (TreeEdit::Insert { value, before }, Some(i)) => {
            let (start, end) = entries[i];
            if *before {
                format!("{}{value}{}{}", &text[..start], sep(i), &text[start..])
            } else {
                format!("{}{}{value}{}", &text[..end], sep(i), &text[end..])
            }
        }
        (TreeEdit::Put(value), Some(i)) if i < n => {
            let target = if at.map { &at.members[i].value } else { &at.items[i] };
            format!("{}{value}{}", &text[..target.start], &text[target.end..])
        }
        (TreeEdit::Put(value), _) => {
            // Appended: an element past the last, or a member under a new key.
            let colon = at.members.last().map_or(": ", |m| &text[m.key_end..m.value.start]);
            let entry = match last {
                CoordStep::Key(name) => format!("{}{colon}{value}", quote(name)),
                _ => value.clone(),
            };
            if n == 0 {
                let (open, close) = open_close.split_at(1);
                return format!("{}{open}{entry}{close}{}", &text[..at.start], &text[at.end..]);
            }
            let tail = entries[n - 1].1;
            format!("{}{}{entry}{}", &text[..tail], sep(n - 1), &text[tail..])
        }
        _ => unreachable!("an edit's target was found by the projection"),
    }
}

/// Plan an insertion beside, or the removal of, the unit a coordinate names,
/// as the block's new body. Only a value tree's sequence takes an insertion;
/// a value tree's member or element, and a `meta` block's key, a removal.
pub fn plan_coord_edit(block: &Block, path: &[CoordStep], edit: &TreeEdit, body: &[String]) -> Result<Vec<String>, NotPlanned> {
    if let TreeEdit::Put(value) = edit {
        return plan_coord_write(block, path, value, body);
    }
    if path.is_empty() {
        return Err("a coordinate needs at least one `[…]` step".to_string().into());
    }
    let what = if matches!(edit, TreeEdit::Insert { .. }) {
        "an element is inserted into a `data` block's sequence"
    } else {
        "a member or an element is removed from a `data` block's value tree, or a key from a `meta` block"
    };
    if block.type_name == "data" {
        return match &block.value {
            Some(v) => edit_value(block, path, edit, v, body),
            None => Err(no_value_tree(block).into()),
        };
    }
    if block.type_name == "meta" && matches!(edit, TreeEdit::Remove) {
        if let [CoordStep::Key(k)] = path {
            return plan_meta_remove(k, body);
        }
        return Err("a meta key is removed as `[\"<key>\"]` — one quoted key, and nothing deeper".to_string().into());
    }
    Err(format!("{what}, and this is a `{}` block — edit its body instead", block.type_name).into())
}

/// The removal of one meta key's line from the body that defines it.
pub fn plan_meta_remove(key: &str, body: &[String]) -> Result<Vec<String>, NotPlanned> {
    let at = body.iter().position(|l| {
        let t = l.trim_start();
        t.strip_prefix(key).is_some_and(|rest| rest.trim_start().starts_with('='))
    });
    let Some(at) = at else { return Err(NotPlanned::Absent) };
    let mut out = body.to_vec();
    out.remove(at);
    Ok(out)
}

/// Plan a coordinate write as the block's new body lines: the same lines
/// with exactly one unit changed, or why not.
pub fn plan_coord_write(block: &Block, path: &[CoordStep], value: &str, body: &[String]) -> Result<Vec<String>, NotPlanned> {
    if path.is_empty() {
        return Err("a coordinate needs at least one `[…]` step".to_string().into());
    }
    if block.type_name == "view" {
        return Err("a view has no body rows to write — edit the source relation or this view's attributes".to_string().into());
    }
    if block.type_name == "form" || block.type_name == "form-group" {
        return Err("a form's field is a block of its own — give it an `{#id}` and edit it with `geml set '#<id>'`; a coordinate writes a unit inside a table or a `data` block".to_string().into());
    }
    if let Some(t) = &block.table {
        return Ok(write_table(block, t, path, value, body)?);
    }
    if let Some(v) = &block.value {
        return edit_value(block, path, &TreeEdit::Put(value.to_string()), v, body);
    }
    if block.mode == Mode::Data {
        if let [CoordStep::Key(k)] = path {
            return Ok(plan_meta_write(k, value, body)?);
        }
        return Err("a meta key is written as `[\"<key>\"]` — one quoted key, and nothing deeper".to_string().into());
    }
    if block.type_name == "data" {
        return Err(no_value_tree(block).into());
    }
    Err(no_units(block, path).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_writes() {
        let body = vec!["title = \"Doc\"".to_string(), "n = 1".to_string()];
        assert_eq!(plan_meta_write("title", "New", &body).unwrap(), vec!["title = \"New\"", "n = 1"]);
        assert_eq!(plan_meta_write("n", "2", &body).unwrap(), vec!["title = \"Doc\"", "n = 2"]);
        assert_eq!(plan_meta_write("k", "v", &body).unwrap(), vec!["title = \"Doc\"", "n = 1", "k = \"v\""]);
        assert!(plan_meta_write("k", "a\nb", &body).is_err());
    }

    #[test]
    fn pretty_matches_json_stringify() {
        let v = json::parse("{\"a\":[1,{\"b\":\"x\"}],\"c\":{}}").unwrap();
        assert_eq!(pretty_json(&v), "{\n  \"a\": [\n    1,\n    {\n      \"b\": \"x\"\n    }\n  ],\n  \"c\": {}\n}");
    }

    #[test]
    fn value_walks() {
        let v = json::parse("{\"a\":[10,{\"b\":\"x\"}]}").unwrap();
        assert_eq!(project_value(&v, &[CoordStep::Key("a".into()), CoordStep::Index(1), CoordStep::Key("b".into())]).unwrap().text, "x");
        assert_eq!(project_value(&v, &[CoordStep::Key("a".into()), CoordStep::Index(0)]).unwrap().text, "10");
        assert!(project_value(&v, &[CoordStep::Key("z".into())]).is_err());
        assert!(project_value(&v, &[CoordStep::Index(0)]).is_err());
        assert!(project_value(&v, &[CoordStep::Word("summary".into())]).is_err());
    }
}
