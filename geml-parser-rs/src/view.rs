//! `view` (§6.1): a relation derived from another one, in SQL's logical order —
//! `src` loads, `compute=`'s per-row formulas, `where=`, `compute=`'s aggregate
//! formulas, `by=`/`aggregate=`, `order=`, `limit=`, `select=`, `summary=`.

use std::collections::HashMap;

use crate::diag::Diags;
use crate::expr::{column_list, column_name, parse_arith, parse_entry, parse_where, split_entries, Agg, Expr};
use crate::json::Value;
use crate::model::{Block, Cell, Table};
use crate::num::{display, format_printf};

/// Index of a column by name, or by spreadsheet letter.
pub fn col_index(cols: &[String], name: &str) -> Option<usize> {
    if let Some(i) = cols.iter().position(|c| c == name) {
        return Some(i);
    }
    if !name.is_empty() && name.bytes().all(|b| b.is_ascii_uppercase()) {
        let mut n = 0usize;
        for b in name.bytes() {
            n = n.checked_mul(26)?.checked_add((b - b'A' + 1) as usize)?;
        }
        if n >= 1 && n - 1 < cols.len() {
            return Some(n - 1);
        }
    }
    None
}

fn shown(v: f64, fmt: Option<&str>) -> Cell {
    let text = match fmt {
        Some(f) => format_printf(f, v),
        None => display(v),
    };
    Cell { text, num: Some(v), inlines: None }
}

fn no_value(text: &str) -> Cell {
    Cell { text: text.to_string(), num: None, inlines: None }
}

struct Formula {
    name: String,
    fmt: Option<String>,
    expr: Option<Expr>,
    agg_dep: bool,
    slot: usize,
}

/// Evaluate an expression over one row, with aggregates folding `agg_rows`.
#[allow(clippy::too_many_arguments)]
fn row_value(
    expr: &Expr,
    row: &[Cell],
    cols: &[String],
    visible: &[bool],
    agg_rows: Option<&[Vec<Cell>]>,
    cache: &mut HashMap<(Agg, usize), f64>,
    substituted: &mut Vec<usize>,
) -> Result<f64, String> {
    let lookup = |name: &str| -> Result<usize, String> {
        match col_index(cols, name) {
            Some(i) if visible[i] => Ok(i),
            _ => Err(format!("no column `{name}` is available here")),
        }
    };
    let mut col = |name: &str| -> Result<f64, String> {
        let i = lookup(name)?;
        match row[i].num {
            Some(v) => Ok(v),
            None => {
                substituted.push(i);
                Ok(0.0)
            }
        }
    };
    let mut agg = |a: Agg, name: &str| -> Result<f64, String> {
        let i = lookup(name)?;
        let Some(rows) = agg_rows else { return Err("an aggregate has no rows to fold here".into()) };
        Ok(*cache.entry((a, i)).or_insert_with(|| {
            let cells: Vec<(String, Option<f64>)> = rows.iter().map(|r| (r[i].text.clone(), r[i].num)).collect();
            a.fold(&cells)
        }))
    };
    expr.compute(&mut col, &mut agg)
}

/// Derive a view's relation from its source's, which it takes over: the
/// source's summary row has already been left behind, and a source of a
/// million cells is not copied again to be narrowed.
pub fn derive(b: &Block, src: Table, diags: &mut Diags) -> Table {
    let line = b.line;
    let source_width = src.columns.len();
    let mut cols: Vec<String> = src.columns;
    let mut rows: Vec<Vec<Cell>> = src.rows;
    // Indexed as the source's columns are: a column derived here has none.
    let mut align = src.align;
    let mut visible: Vec<bool> = vec![true; cols.len()];
    let grouping = b.attr("by").is_some();

    // compute=: read every formula, decide its pass, give it a column.
    let mut formulas: Vec<Formula> = Vec::new();
    if let Some(c) = b.attr_text("compute") {
        let mut agg_names: Vec<String> = Vec::new();
        for raw in split_entries(&c) {
            let Some(e) = parse_entry(&raw) else {
                diags.push("bad-compute-formula", line, format!("`{raw}` is not `Name = expr`"));
                continue;
            };
            let expr = match parse_arith(&e.rhs) {
                Ok(x) => Some(x),
                Err(m) => {
                    diags.push("compute-error", line, format!("`{}`: {m}", e.name));
                    None
                }
            };
            let mut named = Vec::new();
            if let Some(x) = &expr {
                x.all_cols(&mut named);
            }
            let has_agg = expr.as_ref().is_some_and(|x| x.has_agg());
            let agg_dep = has_agg || named.iter().any(|n| agg_names.contains(n));
            let expr = if grouping && has_agg {
                diags.push("grouping-compute-aggregate", line, format!("`{}` aggregates on a grouping view; the group's columns are `aggregate=`'s", e.name));
                None
            } else {
                expr
            };
            if agg_dep {
                agg_names.push(e.name.clone());
            }
            let slot = match cols.iter().position(|x| *x == e.name) {
                Some(i) => {
                    if i < source_width {
                        diags.push("shadowed-source-column", line, format!("`{}` is also a column of the source; the source's is unreachable here", e.name));
                    }
                    i
                }
                None => {
                    cols.push(e.name.clone());
                    visible.push(false);
                    for r in rows.iter_mut() {
                        r.push(no_value(""));
                    }
                    cols.len() - 1
                }
            };
            formulas.push(Formula { name: e.name, fmt: e.fmt, expr, agg_dep, slot });
        }
    }

    let run = |f: &Formula, rows: &mut Vec<Vec<Cell>>, cols: &[String], visible: &mut Vec<bool>, agg: bool, diags: &mut Diags| {
        let Some(expr) = &f.expr else {
            visible[f.slot] = true;
            return;
        };
        let snapshot: Option<Vec<Vec<Cell>>> = if agg { Some(rows.clone()) } else { None };
        let mut cache = HashMap::new();
        let mut failed = false;
        let mut nan_reported = false;
        let mut reported: Vec<(usize, usize)> = Vec::new();
        for (ri, row) in rows.iter_mut().enumerate() {
            let mut subs = Vec::new();
            let v = row_value(expr, row, cols, visible, snapshot.as_deref(), &mut cache, &mut subs);
            for ci in subs {
                if !reported.contains(&(ri, ci)) {
                    reported.push((ri, ci));
                    diags.push("compute-non-numeric-cell", line, format!("`{}` read row {} of `{}`, which is not a number, as 0", f.name, ri + 1, cols[ci]));
                }
            }
            row[f.slot] = match v {
                Ok(x) if x.is_finite() => shown(x, f.fmt.as_deref()),
                Ok(_) => {
                    if !nan_reported {
                        nan_reported = true;
                    }
                    diags.push("compute-not-a-number", line, format!("`{}` has no value in row {}", f.name, ri + 1));
                    no_value("-")
                }
                Err(m) => {
                    if !failed {
                        failed = true;
                        diags.push("compute-error", line, format!("`{}`: {m}", f.name));
                    }
                    no_value("")
                }
            };
        }
        visible[f.slot] = true;
    };

    // Pass 1: the per-row formulas.
    for f in formulas.iter().filter(|f| !f.agg_dep) {
        run(f, &mut rows, &cols, &mut visible, false, diags);
    }
    // A source is within the bound; its computed columns can take a view past it.
    if crate::table::too_large(visible.iter().filter(|v| **v).count(), rows.len(), line, diags) {
        let columns = cols.into_iter().zip(&visible).filter(|(_, v)| **v).map(|(c, _)| c).collect();
        return Table { columns, rows: vec![], summary: None, align };
    }

    // where=
    if let Some(w) = b.attr_text("where") {
        match parse_where(&w) {
            Err(m) => diags.push("view-where-error", line, format!("`where={w}`: {m}")),
            Ok(cond) => {
                let mut named = Vec::new();
                cond.cols(&mut named);
                let mut ok = true;
                for (name, numeric) in &named {
                    if let Some(f) = formulas.iter().find(|f| f.agg_dep && f.name == *name) {
                        diags.push("circular-view-filter", line, format!("`where=` names `{}`, which the aggregate formula `{} = …` derives", name, f.name));
                        ok = false;
                        continue;
                    }
                    match by_name(&cols, name).filter(|i| visible[*i]) {
                        None => {
                            diags.push("view-where-error", line, format!("`where=` names `{name}`, and no column carries it"));
                            ok = false;
                        }
                        Some(i) => {
                            if *numeric && !rows.iter().any(|r| r[i].num.is_some()) {
                                diags.push(
                                    "view-numeric-column-required",
                                    line,
                                    format!("`where=` compares `{name}` with a number, and no row of it holds one"),
                                );
                            }
                        }
                    }
                }
                if ok {
                    rows.retain(|r| {
                        cond.holds(&|name: &str| {
                            let i = by_name(&cols, name).expect("checked above");
                            (r[i].text.clone(), r[i].num)
                        })
                    });
                }
            }
        }
    }

    // Pass 2: the aggregate formulas, over the rows the filter kept.
    for f in formulas.iter().filter(|f| f.agg_dep) {
        run(f, &mut rows, &cols, &mut visible, true, diags);
    }

    // by= / aggregate=
    if let Some(by) = b.attr_text("by") {
        let keys: Vec<String> = column_list(&by).iter().map(|e| column_name(e).0.to_string()).collect();
        let mut idx = Vec::new();
        for k in &keys {
            match by_name(&cols, k) {
                Some(i) => idx.push(i),
                None => diags.push("view-unknown-column", line, format!("`by=` names `{k}`, and the relation carries no such column")),
            }
        }
        if idx.len() == keys.len() && !keys.is_empty() {
            let mut aggs: Vec<(String, Option<String>, Option<Expr>)> = Vec::new();
            if let Some(a) = b.attr_text("aggregate") {
                for raw in split_entries(&a) {
                    let Some(e) = parse_entry(&raw) else {
                        diags.push("bad-aggregate-entry", line, format!("`{raw}` is not `Name = fn(Column)`"));
                        continue;
                    };
                    match parse_arith(&e.rhs) {
                        Err(m) => {
                            diags.push("bad-aggregate-entry", line, format!("`{raw}`: {m}"));
                            aggs.push((e.name, e.fmt, None));
                        }
                        Ok(x) => {
                            let mut bare = Vec::new();
                            x.bare_cols(&mut bare);
                            let mut all = Vec::new();
                            x.all_cols(&mut all);
                            if let Some(c) = all.iter().find(|c| col_index(&cols, c).is_none()) {
                                diags.push("view-unknown-column", line, format!("`aggregate=` names `{c}`, and the relation carries no such column"));
                                aggs.push((e.name, e.fmt, None));
                            } else if !bare.is_empty() {
                                diags.push("aggregate-error", line, format!("`{}` reads `{}` without an aggregate", e.name, bare[0]));
                                aggs.push((e.name, e.fmt, None));
                            } else {
                                aggs.push((e.name, e.fmt, Some(x)));
                            }
                        }
                    }
                }
            }
            let mut groups: Vec<(Vec<String>, Vec<Vec<Cell>>)> = Vec::new();
            for r in rows.drain(..) {
                let key: Vec<String> = idx.iter().map(|i| r[*i].text.clone()).collect();
                match groups.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, g)) => g.push(r),
                    None => groups.push((key, vec![r])),
                }
            }
            let all_visible = vec![true; cols.len()];
            let mut new_rows = Vec::new();
            for (_, g) in &groups {
                let mut out: Vec<Cell> = idx.iter().map(|i| g[0][*i].clone()).collect();
                for (name, fmt, x) in &aggs {
                    out.push(match x {
                        None => no_value(""),
                        Some(x) => {
                            let mut cache = HashMap::new();
                            let mut subs = Vec::new();
                            match row_value(x, &g[0], &cols, &all_visible, Some(g), &mut cache, &mut subs) {
                                Ok(v) if v.is_finite() => shown(v, fmt.as_deref()),
                                Ok(_) => {
                                    diags.push("compute-not-a-number", line, format!("`{name}` has no value for a group"));
                                    no_value("-")
                                }
                                Err(m) => {
                                    diags.push("aggregate-error", line, format!("`{name}`: {m}"));
                                    no_value("")
                                }
                            }
                        }
                    });
                }
                new_rows.push(out);
            }
            let mut new_cols: Vec<String> = keys.clone();
            new_cols.extend(aggs.iter().map(|(n, _, _)| n.clone()));
            align = (0..new_cols.len()).map(|i| idx.get(i).and_then(|k| align.get(*k).copied().flatten())).collect();
            cols = new_cols;
            rows = new_rows;
        }
    } else if b.attr("aggregate").is_some() {
        diags.push("aggregate-without-by", line, "`aggregate=` describes groups and this view has no `by=`; one row over every row is `summary=`");
    }

    // order=: each key stands alone (§6.1); one in error contributes nothing.
    if let Some(o) = b.attr_text("order") {
        let mut keys: Vec<(usize, bool)> = Vec::new();
        for k in column_list(&o) {
            let (head, desc) = split_order_key(&k);
            let (name, _) = column_name(head);
            if name.is_empty() {
                diags.push("view-order-error", line, format!("`{k}` names no column"));
                continue;
            }
            match by_name(&cols, name) {
                Some(i) => keys.push((i, desc)),
                None => diags.push("view-unknown-column", line, format!("`order=` names `{name}`, and the relation carries no such column")),
            }
        }
        let numeric: Vec<bool> = keys.iter().map(|(i, _)| !rows.is_empty() && rows.iter().all(|r| r[*i].num.is_some())).collect();
        rows.sort_by(|a, b| {
            for ((i, desc), num) in keys.iter().zip(&numeric) {
                let o =
                    if *num { a[*i].num.partial_cmp(&b[*i].num).unwrap_or(std::cmp::Ordering::Equal) } else { crate::uni::cmp_utf16(&a[*i].text, &b[*i].text) };
                let o = if *desc { o.reverse() } else { o };
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
            }
            std::cmp::Ordering::Equal
        });
    }

    // limit=
    if let Some(l) = b.attr("limit") {
        let n = match l {
            Value::Number(n) => Some(*n),
            Value::String(s) => crate::num::parse_bare_number(s),
            _ => None,
        };
        match n {
            Some(n) if n >= 0.0 && n.fract() == 0.0 => rows.truncate(n.min(usize::MAX as f64) as usize),
            _ => diags.push("view-limit-error", line, format!("`limit={}` is not a non-negative integer", l.scalar_text().unwrap_or_default())),
        }
    }

    // select=
    let pre_cols = cols.clone();
    let pre_rows = rows.clone();
    if let Some(s) = b.attr_text("select") {
        // Each entry stands alone (§6.1): one in error contributes nothing, and
        // a `select=` with no valid entry leaves the view no columns.
        let mut idx = Vec::new();
        for entry in column_list(&s) {
            let (n, quoted) = column_name(&entry);
            if !quoted && n.contains('=') {
                diags.push("view-select-expression", line, format!("`select=` names columns, and `{n}` derives one; that is `compute=`'s job"));
                continue;
            }
            match by_name(&cols, n) {
                Some(i) => idx.push(i),
                None => diags.push("view-unknown-column", line, format!("`select=` names `{n}`, and the relation carries no such column")),
            }
        }
        cols = idx.iter().map(|i| cols[*i].clone()).collect();
        align = idx.iter().map(|i| align.get(*i).copied().flatten()).collect();
        rows = rows.iter().map(|r| idx.iter().map(|i| r[*i].clone()).collect()).collect();
    }

    // summary=
    let mut summary = None;
    if let Some(s) = b.attr_text("summary") {
        let mut cells: Vec<Cell> = vec![no_value(""); cols.len()];
        for raw in split_entries(&s) {
            let Some(e) = parse_entry(&raw) else {
                diags.push("bad-summary-entry", line, format!("`{raw}` is not `Cell = value`"));
                continue;
            };
            let Some(target) = by_name(&cols, &e.name) else {
                if by_name(&pre_cols, &e.name).is_some() {
                    diags.push("summary-projected-away", line, format!("`summary=` targets `{}`, which `select=` dropped", e.name));
                } else {
                    diags.push("summary-unknown-column", line, format!("`summary=` targets `{}`, and the table has no such column", e.name));
                }
                continue;
            };
            let rhs = e.rhs.trim();
            if let Ok(toks) = crate::expr::tokenize(rhs) {
                if let [crate::expr::Tok::Str(label)] = toks.as_slice() {
                    cells[target] = Cell::text(label.clone());
                    continue;
                }
            }
            if let Some(n) = crate::num::parse_bare_number(rhs) {
                cells[target] = shown(n, e.fmt.as_deref());
                continue;
            }
            let x = match parse_arith(rhs) {
                Ok(x) => x,
                Err(m) => {
                    diags.push("summary-error", line, format!("`{}`: {m}", e.name));
                    continue;
                }
            };
            let mut bare = Vec::new();
            x.bare_cols(&mut bare);
            if let Some(c) = bare.first() {
                diags.push("summary-error", line, format!("`{}` reads `{c}` without an aggregate, and a bare column has no value in the summary row", e.name));
                continue;
            }
            let all_visible = vec![true; pre_cols.len()];
            let empty: Vec<Cell> = vec![no_value(""); pre_cols.len()];
            let mut cache = HashMap::new();
            let mut subs = Vec::new();
            cells[target] = match row_value(&x, &empty, &pre_cols, &all_visible, Some(&pre_rows), &mut cache, &mut subs) {
                Ok(v) if v.is_finite() => shown(v, e.fmt.as_deref()),
                Ok(_) => {
                    diags.push("compute-not-a-number", line, format!("`{}` has no value in the summary row", e.name));
                    no_value("-")
                }
                Err(m) => {
                    diags.push("summary-error", line, format!("`{}`: {m}", e.name));
                    no_value("")
                }
            };
        }
        summary = Some(cells);
    }
    Table { columns: cols, rows, summary, align }
}

/// Split `order=` on commas outside quotes, keeping each key's quotes.
/// A column a list, `where=` or an entry's left side names (§6.1): by its
/// name, never by spreadsheet letter — letters are a §6 expression's references.
fn by_name(cols: &[String], name: &str) -> Option<usize> {
    cols.iter().position(|c| c == name)
}

/// `<column>[ asc|desc]` (§6.1): the direction is a last word `asc` or `desc`,
/// in any case, set off by whitespace; the rest, trimmed, is the column.
fn split_order_key(k: &str) -> (&str, bool) {
    for (word, desc) in [("desc", true), ("asc", false)] {
        let Some(cut) = k.len().checked_sub(word.len()) else { continue };
        if k.is_char_boundary(cut) && k[cut..].eq_ignore_ascii_case(word) && k[..cut].ends_with(char::is_whitespace) {
            return (k[..cut].trim_end(), desc);
        }
    }
    (k, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        let cols: Vec<String> = ["Id", "N"].iter().map(|s| s.to_string()).collect();
        assert_eq!(col_index(&cols, "N"), Some(1));
        assert_eq!(col_index(&cols, "A"), Some(0));
        assert_eq!(col_index(&cols, "C"), None);
        assert_eq!(col_index(&cols, ""), None);
        assert_eq!(col_index(&cols, "x"), None);
        assert_eq!(split_order_key("'Unit Price' desc"), ("'Unit Price'", true));
        assert_eq!(split_order_key("Unit Price ASC"), ("Unit Price", false));
        assert_eq!(split_order_key("N sideways"), ("N sideways", false));
        assert_eq!(split_order_key("desc"), ("desc", false));
        assert_eq!(split_order_key("Ndesc"), ("Ndesc", false));
        assert_eq!(by_name(&cols, "A"), None);
    }
}
