//! `view` (§6.1): a relation derived from another one, in SQL's logical order —
//! `src` loads, `compute=`'s per-row formulas, `where=`, `compute=`'s aggregate
//! formulas, `by=`/`aggregate=`, `order=`, `limit=`, `select=`, `summary=`.

use std::collections::HashMap;

use crate::diag::Diags;
use crate::expr::{parse_arith, parse_entry, parse_where, split_entries, split_names, Agg, Expr};
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
    Cell { text, num: Some(v) }
}

fn no_value(text: &str) -> Cell {
    Cell { text: text.to_string(), num: None }
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

/// Derive a view's relation from its source's (the source's summary row has
/// already been left behind).
pub fn derive(b: &Block, src: &Table, diags: &mut Diags) -> Table {
    let line = b.line;
    let mut cols: Vec<String> = src.columns.clone();
    let mut rows: Vec<Vec<Cell>> = src.rows.clone();
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
                    if i < src.columns.len() {
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
                    match col_index(&cols, name).filter(|i| visible[*i]) {
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
                            let i = col_index(&cols, name).expect("checked above");
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
        let keys = split_names(&by);
        let mut idx = Vec::new();
        for k in &keys {
            match col_index(&cols, k) {
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
            cols = new_cols;
            rows = new_rows;
        }
    } else if b.attr("aggregate").is_some() {
        diags.push("aggregate-without-by", line, "`aggregate=` describes groups and this view has no `by=`; one row over every row is `summary=`");
    }

    // order=
    if let Some(o) = b.attr_text("order") {
        let mut keys: Vec<(usize, bool)> = Vec::new();
        let mut ok = true;
        for k in split_names_raw(&o) {
            let (name, dir) = split_order_key(&k);
            let desc = match dir.as_deref().map(str::to_ascii_lowercase).as_deref() {
                None | Some("asc") => false,
                Some("desc") => true,
                Some(_) => {
                    diags.push("view-order-error", line, format!("`{k}` is not `<column>[ asc|desc]`"));
                    ok = false;
                    continue;
                }
            };
            if name.is_empty() {
                diags.push("view-order-error", line, format!("`{k}` is not `<column>[ asc|desc]`"));
                ok = false;
                continue;
            }
            match col_index(&cols, &name) {
                Some(i) => keys.push((i, desc)),
                None => {
                    diags.push("view-unknown-column", line, format!("`order=` names `{name}`, and the relation carries no such column"));
                    ok = false;
                }
            }
        }
        if ok {
            let numeric: Vec<bool> = keys.iter().map(|(i, _)| !rows.is_empty() && rows.iter().all(|r| r[*i].num.is_some())).collect();
            rows.sort_by(|a, b| {
                for ((i, desc), num) in keys.iter().zip(&numeric) {
                    let o = if *num {
                        a[*i].num.partial_cmp(&b[*i].num).unwrap_or(std::cmp::Ordering::Equal)
                    } else {
                        crate::uni::cmp_utf16(&a[*i].text, &b[*i].text)
                    };
                    let o = if *desc { o.reverse() } else { o };
                    if o != std::cmp::Ordering::Equal {
                        return o;
                    }
                }
                std::cmp::Ordering::Equal
            });
        }
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
        let names = split_names(&s);
        if names.iter().any(|n| n.contains('=')) {
            diags.push("view-select-expression", line, "`select=` names columns; deriving one is `compute=`'s job");
        } else {
            let mut idx = Vec::new();
            for n in &names {
                match col_index(&cols, n) {
                    Some(i) => idx.push(i),
                    None => diags.push("view-unknown-column", line, format!("`select=` names `{n}`, and the relation carries no such column")),
                }
            }
            cols = idx.iter().map(|i| cols[*i].clone()).collect();
            rows = rows.iter().map(|r| idx.iter().map(|i| r[*i].clone()).collect()).collect();
        }
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
            let Some(target) = cols.iter().position(|c| *c == e.name).or_else(|| col_index(&cols, &e.name)) else {
                if col_index(&pre_cols, &e.name).is_some() {
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
    Table { columns: cols, rows, summary }
}

/// Split `order=` on commas outside quotes, keeping each key's quotes.
fn split_names_raw(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in s.chars() {
        match c {
            '\'' => {
                quoted = !quoted;
                cur.push(c);
            }
            ',' if !quoted => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out.into_iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

/// `<column>[ asc|desc]`, the column possibly single-quoted.
fn split_order_key(k: &str) -> (String, Option<String>) {
    if let Some(rest) = k.strip_prefix('\'') {
        if let Some(end) = rest.find('\'') {
            let dir = rest[end + 1..].trim();
            return (rest[..end].to_string(), if dir.is_empty() { None } else { Some(dir.to_string()) });
        }
    }
    let mut parts = k.split_whitespace();
    let name = parts.next().unwrap_or("").to_string();
    let rest: Vec<&str> = parts.collect();
    let dir = if rest.is_empty() { None } else { Some(rest.join(" ")) };
    (name, dir)
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
        assert_eq!(split_order_key("'Unit Price' desc"), ("Unit Price".into(), Some("desc".into())));
        assert_eq!(split_order_key("'Unit Price'"), ("Unit Price".into(), None));
        assert_eq!(split_order_key("N"), ("N".into(), None));
        assert_eq!(split_names_raw("'a, b' asc, c"), vec!["'a, b' asc", "c"]);
    }
}
