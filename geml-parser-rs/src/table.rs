//! `table` (§6): the visual pipe form and the delimited data form, read into
//! one model.

use std::cell::Cell as Counter;

use crate::bounds::{BORROWED_CELLS, TABLE_CELLS};
use crate::diag::Diags;
use crate::host::Host;
use crate::json::Value;
use crate::model::{Block, Cell, Mode, Table};
use crate::uni::trim_ws;

/// Spreadsheet column letters: A … Z, AA, AB, ….
pub fn letter(mut i: usize) -> String {
    let mut s = Vec::new();
    loop {
        s.push((b'A' + (i % 26) as u8) as char);
        if i < 26 {
            break;
        }
        i = i / 26 - 1;
    }
    s.iter().rev().collect()
}

/// Split one visual row: outer pipes stripped, `\|` a literal pipe, every
/// other pipe a separator; each cell trimmed of `White_Space`.
fn split_visual(line: &str) -> Vec<String> {
    let t = trim_ws(line);
    let chars: Vec<char> = t.chars().collect();
    let mut cells = Vec::new();
    let mut cur = String::new();
    let mut i = usize::from(chars.first() == Some(&'|'));
    let mut ended_on_pipe = false;
    while i < chars.len() {
        ended_on_pipe = false;
        if chars[i] == '\\' && chars.get(i + 1) == Some(&'|') {
            cur.push('|');
            i += 2;
            continue;
        }
        if chars[i] == '|' {
            cells.push(std::mem::take(&mut cur));
            ended_on_pipe = true;
            i += 1;
            continue;
        }
        cur.push(chars[i]);
        i += 1;
    }
    if !ended_on_pipe {
        cells.push(cur);
    }
    cells.iter().map(|c| trim_ws(c).to_string()).collect()
}

fn is_separator(cells: &[String]) -> bool {
    !cells.is_empty()
        && cells.iter().all(|c| {
            let c = c.strip_prefix(':').unwrap_or(c);
            let c = c.strip_suffix(':').unwrap_or(c);
            !c.is_empty() && c.bytes().all(|b| b == b'-')
        })
}

/// Whether a `src=` names a block (`#id`, `doc.geml#id`) rather than a file.
pub fn names_block(src: &str) -> bool {
    src.starts_with('#') || src.to_ascii_lowercase().contains(".geml#")
}

/// Whether a data-form body's first row is its header (§6): `header=` is a
/// boolean, on by default; `false` and `0` turn it off, and any other value
/// reads as the default.
fn header_wanted(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) if *n == 0.0 => false,
        Some(Value::String(s)) if matches!(s.as_str(), "0" | "false") => false,
        _ => true,
    }
}

/// §9.2: the cells one document reads into its relations from anywhere but
/// its own text, summed against `BORROWED_CELLS`.
#[derive(Default)]
pub struct Borrowed(Counter<usize>);

impl Borrowed {
    /// Book `cells`, and say whether they fit. A relation that does not is
    /// `table-too-large` and keeps no rows.
    pub fn take(&self, cells: usize, line: usize, what: &str, diags: &mut Diags) -> bool {
        let total = self.0.get().saturating_add(cells);
        self.0.set(total);
        if total <= BORROWED_CELLS {
            return true;
        }
        diags.push("table-too-large", line, format!("{what} takes this document past {BORROWED_CELLS} cells read from elsewhere (§9.2); it keeps no rows"));
        false
    }

    /// Whether the budget is spent, in which case the relation is refused
    /// before its source is read or copied.
    pub fn spent(&self, line: usize, what: &str, diags: &mut Diags) -> bool {
        self.0.get() >= BORROWED_CELLS && !self.take(0, line, what, diags)
    }

    /// `t` booked: its rows kept when they fit, dropped when they do not.
    pub fn book(&self, mut t: Table, line: usize, what: &str, diags: &mut Diags) -> Table {
        if !self.take(t.columns.len().saturating_mul(t.rows.len()), line, what, diags) {
            t.rows.clear();
        }
        t
    }
}

/// Read a `table` block into its model. A local `src=` file is read through
/// the host at build time and parsed as the body would be (§6); `None` when the
/// data is remote (the renderer fetches it), when there is no host to read it
/// through, or when it cannot be read.
pub fn read_table(b: &Block, diags: &mut Diags, host: Option<(&dyn Host, &str)>, budget: &Borrowed) -> Option<Table> {
    let line = b.line;
    if let Some(src) = b.attr_text("src") {
        if b.has_body() {
            diags.push("table-src-and-body", line, "a table carries both `src=` and an inline body");
        }
        if names_block(&src) {
            diags.push("table-source-is-block", line, format!("`src={src}` names a block; a relation derived from another block is a `view`"));
            return None;
        }
        let what = format!("`src={src}`");
        if host.is_some() && budget.spent(line, &what, diags) {
            return Some(Table { columns: vec![], rows: vec![], summary: None });
        }
        return match read_data_file("src", &src, host, line, diags) {
            Some(text) => table_from_lines(b, &file_lines(&text), None, diags).map(|t| budget.book(t, line, &what, diags)),
            // §6: a file that cannot be read, or a disallowed scheme, leaves the
            // table empty; a remote file is the renderer's, and a parse with no
            // host reads nothing, so neither has a model yet.
            None => unread(&src, host),
        };
    }
    table_from_lines(b, &b.raw, Some(b.body_start), diags)
}

/// The model of a table whose data file was not read: empty when it was
/// refused or could not be read (§6), absent when it is remote or there is no
/// host to read it through.
fn unread(src: &str, host: Option<(&dyn Host, &str)>) -> Option<Table> {
    let remote = matches!(crate::inline::scheme_of(src).as_deref(), Some("http") | Some("https"));
    (!remote && host.is_some()).then(|| Table { columns: vec![], rows: vec![], summary: None })
}

fn file_lines(text: &str) -> Vec<String> {
    text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect()
}

/// The text of a data file a table, a view or a chart names (§6): `None` for
/// a remote one (the renderer fetches it) and for a local one with no host to
/// read it through; `None` with `unresolvable-table-source` for a disallowed
/// scheme or a file that cannot be read. The suffix does not matter — what
/// decides how the text is read is `format=`, or for a view's or a chart's
/// file the suffix rule of `table_from_file`. `attr` names the attribute for
/// the message (`src`, `data`).
pub fn read_data_file(attr: &str, src: &str, host: Option<(&dyn Host, &str)>, line: usize, diags: &mut Diags) -> Option<String> {
    match crate::inline::scheme_of(src) {
        Some(sch) if sch == "http" || sch == "https" => None,
        Some(_) => {
            diags.push("unresolvable-table-source", line, format!("`{attr}={src}` names a URL scheme a table source may not use"));
            None
        }
        None => {
            let (host, from) = host?;
            let text = crate::host::read_from(host, from, src);
            if text.is_none() {
                diags.push("unresolvable-table-source", line, format!("`{attr}={src}` could not be read"));
            }
            text
        }
    }
}

/// A delimited file read as a relation (§6.1, §7.1): its format from its
/// suffix, its first row the header, parsed as a table body would be.
pub fn table_from_file(attr: &str, src: &str, host: Option<(&dyn Host, &str)>, line: usize, diags: &mut Diags) -> Option<Table> {
    let text = read_data_file(attr, src, host, line, diags)?;
    let format = if src.to_ascii_lowercase().ends_with(".tsv") { "tsv" } else { "csv" };
    let b = Block {
        type_name: "table".into(),
        id: None,
        classes: vec![],
        attrs: vec![("format".into(), Value::String(format.into()))],
        mode: Mode::Raw,
        raw: vec![],
        children: vec![],
        data: vec![],
        value: None,
        table: None,
        line,
        body_start: line,
        body_end: line,
        end: line,
    };
    table_from_lines(&b, &file_lines(&text), None, diags)
}

/// §6, §9.2: a table or view holds at most `TABLE_CELLS` cells — its columns
/// times its body rows, padded cells included. One that would hold more is
/// `table-too-large` and keeps no rows: a header of a few thousand columns over
/// a few thousand one-cell rows is a few kilobytes of input and, padded, a few
/// hundred megabytes of cells.
pub fn too_large(columns: usize, rows: usize, line: usize, diags: &mut Diags) -> bool {
    let over = columns.saturating_mul(rows) > TABLE_CELLS;
    if over {
        diags.push("table-too-large", line, format!("{columns} columns × {rows} rows is more than {TABLE_CELLS} cells; no rows are kept"));
    }
    over
}

/// A table body — the block's own lines, or a data file's — read into the
/// model under the block's `format=`, `header=` and `delim=`. `rows_from` is
/// the 1-based line of the first body line, or `None` when the lines come from
/// a file and every row diagnostic points at the block.
fn table_from_lines(b: &Block, body_lines: &[String], rows_from: Option<usize>, diags: &mut Diags) -> Option<Table> {
    let line = b.line;
    let format = b.attr_text("format");
    let natural = match format.as_deref() {
        Some("csv") => Some(','),
        Some("tsv") => Some('\t'),
        None => None,
        Some(other) => {
            diags.push("unknown-table-format", line, format!("`format={other}` is not a table format; the body is read as a pipe grid"));
            None
        }
    };
    let delim = match (b.attr("delim"), natural) {
        (None, d) => d,
        (Some(_), None) => {
            diags.push("ignored-table-delimiter", line, "`delim=` applies to a data format; this table has none");
            None
        }
        (Some(v), Some(nat)) => {
            let s = v.scalar_text().unwrap_or_default();
            let mut cs = s.chars();
            match (cs.next(), cs.next()) {
                (Some(c), None) => Some(c),
                _ => {
                    diags.push("bad-table-delimiter", line, format!("`delim={s}` is not exactly one character"));
                    Some(nat)
                }
            }
        }
    };
    // (row text cells, line number)
    let mut rows: Vec<(Vec<String>, usize)> = Vec::new();
    for (k, l) in body_lines.iter().enumerate() {
        if trim_ws(l).is_empty() {
            continue;
        }
        let cells = match delim {
            Some(d) => l.split(d).map(|c| trim_ws(c).to_string()).collect(),
            None => split_visual(l),
        };
        rows.push((cells, rows_from.map_or(line, |s| s + k)));
    }
    type Rows = Vec<(Vec<String>, usize)>;
    let (header, body): (Option<Vec<String>>, Rows) = if delim.is_some() {
        if header_wanted(b.attr("header")) && !rows.is_empty() {
            let h = rows.remove(0).0;
            (Some(h), rows)
        } else {
            (None, rows)
        }
    } else {
        match rows.iter().position(|(c, _)| is_separator(c)) {
            None => (None, rows),
            Some(0) => (None, rows.into_iter().skip(1).filter(|(c, _)| !is_separator(c)).collect()),
            Some(_) => {
                let mut it = rows.into_iter();
                let h = it.next().expect("a header row").0;
                (Some(h), it.filter(|(c, _)| !is_separator(c)).collect())
            }
        }
    };
    let width = match &header {
        Some(h) => h.len(),
        None => body.iter().map(|(c, _)| c.len()).max().unwrap_or(0),
    };
    let columns: Vec<String> = match header {
        Some(h) => h,
        None => (0..width).map(letter).collect(),
    };
    // Judged before a cell is padded or a row is said to be ragged: the rows are not kept.
    if too_large(columns.len(), body.len(), line, diags) {
        return Some(Table { columns, rows: vec![], summary: None });
    }
    let mut out_rows = Vec::new();
    for (mut cells, at) in body {
        if cells.len() != width {
            diags.push("ragged-table-row", at, format!("this row has {} cells and the table has {} columns", cells.len(), width));
            cells.resize(width, String::new());
        }
        out_rows.push(cells.into_iter().map(Cell::text).collect());
    }
    Some(Table { columns, rows: out_rows, summary: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_and_rows() {
        assert_eq!(letter(0), "A");
        assert_eq!(letter(25), "Z");
        assert_eq!(letter(26), "AA");
        assert_eq!(letter(27), "AB");
        assert_eq!(letter(701), "ZZ");
        assert_eq!(letter(702), "AAA");
        assert_eq!(split_visual("| `asc \\| desc` | b |"), vec!["`asc | desc`", "b"]);
        assert_eq!(split_visual("a | b"), vec!["a", "b"]);
        assert_eq!(split_visual("| a | b \\|"), vec!["a", "b |"]);
        assert!(is_separator(&["---".into(), ":-:".into(), "--:".into()]));
        assert!(!is_separator(&["-a-".into()]) && !is_separator(&[]) && !is_separator(&[":".into()]));
        assert!(names_block("#t") && names_block("x.geml#t") && !names_block("rows.csv"));
        assert!(header_wanted(Some(&Value::String("yes".into()))) && !header_wanted(Some(&Value::String("0".into()))));
        assert!(!header_wanted(Some(&Value::String("false".into()))) && !header_wanted(Some(&Value::Number(0.0))));
        assert!(header_wanted(Some(&Value::Bool(true))) && !header_wanted(Some(&Value::Bool(false))));
        // §6: any other value reads as the default, which is on.
        assert!(header_wanted(None) && header_wanted(Some(&Value::Null)) && header_wanted(Some(&Value::String("no".into()))));
    }
}
