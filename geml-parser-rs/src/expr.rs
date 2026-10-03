//! The closed expression grammar of §6 and §6.1: `compute=`, `summary=` and
//! `aggregate=` formulas over `+ - * / ( )` and the aggregates `sum avg min
//! max count`, and `where=` comparisons combined with `not`, `and`, `or`.
//! Nothing here runs document text: it is a fixed arithmetic over cells.

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    Num(f64),
    Str(String),
    Name(String),
    Op(&'static str),
    LParen,
    RParen,
}

pub fn tokenize(s: &str) -> Result<Vec<Tok>, String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        match c {
            '\'' => {
                let mut v = String::new();
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err("an unclosed quote".into()),
                        Some('\'') if chars.get(i + 1) == Some(&'\'') => {
                            v.push('\'');
                            i += 2;
                        }
                        Some('\'') => {
                            i += 1;
                            break;
                        }
                        Some(x) => {
                            v.push(*x);
                            i += 1;
                        }
                    }
                }
                out.push(Tok::Str(v));
            }
            '(' => {
                out.push(Tok::LParen);
                i += 1;
            }
            ')' => {
                out.push(Tok::RParen);
                i += 1;
            }
            '<' | '>' | '!' | '=' => {
                let two: String = chars[i..(i + 2).min(chars.len())].iter().collect();
                let op = match two.as_str() {
                    "<=" => "<=",
                    ">=" => ">=",
                    "!=" => "!=",
                    _ => match c {
                        '<' => "<",
                        '>' => ">",
                        '=' => "=",
                        _ => return Err("`!` is not an operator".into()),
                    },
                };
                i += op.len();
                out.push(Tok::Op(op));
            }
            '+' | '-' | '*' | '/' => {
                out.push(Tok::Op(match c {
                    '+' => "+",
                    '-' => "-",
                    '*' => "*",
                    _ => "/",
                }));
                i += 1;
            }
            c if c.is_ascii_digit() || (c == '.' && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit())) => {
                let s0 = i;
                while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                    i += 1;
                }
                if i < chars.len() && (chars[i] == 'e' || chars[i] == 'E') {
                    let save = i;
                    i += 1;
                    if i < chars.len() && (chars[i] == '+' || chars[i] == '-') {
                        i += 1;
                    }
                    if !chars.get(i).is_some_and(|d| d.is_ascii_digit()) {
                        i = save;
                    }
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                let lit: String = chars[s0..i].iter().collect();
                match crate::num::parse_bare_number(&lit) {
                    Some(v) => out.push(Tok::Num(v)),
                    None => return Err(format!("`{lit}` is not a number")),
                }
            }
            _ => {
                let s0 = i;
                while i < chars.len() && !chars[i].is_whitespace() && !"()+-*/=<>!'".contains(chars[i]) {
                    i += 1;
                }
                out.push(Tok::Name(chars[s0..i].iter().collect()));
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Agg {
    Sum,
    Avg,
    Min,
    Max,
    Count,
}

impl Agg {
    pub fn from_name(s: &str) -> Option<Agg> {
        match s {
            "sum" => Some(Agg::Sum),
            "avg" => Some(Agg::Avg),
            "min" => Some(Agg::Min),
            "max" => Some(Agg::Max),
            "count" => Some(Agg::Count),
            _ => None,
        }
    }

    /// Fold a column: `count` tallies non-empty cells, the others read the
    /// numeric ones and skip the rest.
    pub fn fold(self, cells: &[(String, Option<f64>)]) -> f64 {
        let nums: Vec<f64> = cells.iter().filter_map(|(_, n)| *n).collect();
        match self {
            Agg::Count => cells.iter().filter(|(t, _)| !t.trim().is_empty()).count() as f64,
            Agg::Sum => nums.iter().sum(),
            Agg::Avg => {
                if nums.is_empty() {
                    f64::NAN
                } else {
                    nums.iter().sum::<f64>() / nums.len() as f64
                }
            }
            Agg::Min => nums.iter().copied().fold(f64::NAN, |a, b| if a.is_nan() || b < a { b } else { a }),
            Agg::Max => nums.iter().copied().fold(f64::NAN, |a, b| if a.is_nan() || b > a { b } else { a }),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Num(f64),
    Col(String),
    Neg(Box<Expr>),
    Bin(char, Box<Expr>, Box<Expr>),
    Agg(Agg, String),
}

impl Expr {
    pub fn has_agg(&self) -> bool {
        match self {
            Expr::Agg(..) => true,
            Expr::Neg(e) => e.has_agg(),
            Expr::Bin(_, a, b) => a.has_agg() || b.has_agg(),
            _ => false,
        }
    }

    /// Column names read outside an aggregate.
    pub fn bare_cols(&self, out: &mut Vec<String>) {
        match self {
            Expr::Col(c) => out.push(c.clone()),
            Expr::Neg(e) => e.bare_cols(out),
            Expr::Bin(_, a, b) => {
                a.bare_cols(out);
                b.bare_cols(out);
            }
            _ => {}
        }
    }

    /// Every column named, inside an aggregate or not.
    pub fn all_cols(&self, out: &mut Vec<String>) {
        match self {
            Expr::Col(c) | Expr::Agg(_, c) => out.push(c.clone()),
            Expr::Neg(e) => e.all_cols(out),
            Expr::Bin(_, a, b) => {
                a.all_cols(out);
                b.all_cols(out);
            }
            Expr::Num(_) => {}
        }
    }

    /// The arithmetic value, with `col` reading a bare column and `agg`
    /// folding one.
    pub fn compute(&self, col: &mut dyn FnMut(&str) -> Result<f64, String>, agg: &mut dyn FnMut(Agg, &str) -> Result<f64, String>) -> Result<f64, String> {
        Ok(match self {
            Expr::Num(n) => *n,
            Expr::Col(c) => col(c)?,
            Expr::Agg(a, c) => agg(*a, c)?,
            Expr::Neg(e) => -e.compute(col, agg)?,
            Expr::Bin(op, a, b) => {
                let x = a.compute(col, agg)?;
                let y = b.compute(col, agg)?;
                match op {
                    '+' => x + y,
                    '-' => x - y,
                    '*' => x * y,
                    _ => x / y,
                }
            }
        })
    }
}

struct Cursor {
    toks: Vec<Tok>,
    i: usize,
}

impl Cursor {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.i)
    }

    fn take(&mut self) -> Option<Tok> {
        let t = self.toks.get(self.i).cloned();
        self.i += 1;
        t
    }
}

/// Parse an arithmetic expression; a single-quoted string is a column name.
pub fn parse_arith(s: &str) -> Result<Expr, String> {
    let mut c = Cursor { toks: tokenize(s)?, i: 0 };
    let e = arith(&mut c)?;
    if c.i != c.toks.len() {
        return Err("unexpected text after the expression".into());
    }
    Ok(e)
}

fn arith(c: &mut Cursor) -> Result<Expr, String> {
    let mut e = term(c)?;
    while let Some(Tok::Op(op @ ("+" | "-"))) = c.peek().cloned() {
        c.take();
        let r = term(c)?;
        e = Expr::Bin(op.chars().next().unwrap_or('+'), Box::new(e), Box::new(r));
    }
    Ok(e)
}

fn term(c: &mut Cursor) -> Result<Expr, String> {
    let mut e = unary(c)?;
    while let Some(Tok::Op(op @ ("*" | "/"))) = c.peek().cloned() {
        c.take();
        let r = unary(c)?;
        e = Expr::Bin(op.chars().next().unwrap_or('*'), Box::new(e), Box::new(r));
    }
    Ok(e)
}

fn unary(c: &mut Cursor) -> Result<Expr, String> {
    if c.peek() == Some(&Tok::Op("-")) {
        c.take();
        return Ok(Expr::Neg(Box::new(unary(c)?)));
    }
    primary(c)
}

fn col_name(t: Option<Tok>) -> Result<String, String> {
    match t {
        Some(Tok::Name(n)) | Some(Tok::Str(n)) => Ok(n),
        _ => Err("expected a column".into()),
    }
}

fn primary(c: &mut Cursor) -> Result<Expr, String> {
    match c.take() {
        Some(Tok::Num(n)) => Ok(Expr::Num(n)),
        Some(Tok::Str(s)) => Ok(Expr::Col(s)),
        Some(Tok::LParen) => {
            let e = arith(c)?;
            if c.take() != Some(Tok::RParen) {
                return Err("an unclosed parenthesis".into());
            }
            Ok(e)
        }
        Some(Tok::Name(n)) => {
            if c.peek() == Some(&Tok::LParen) {
                let Some(a) = Agg::from_name(&n) else { return Err(format!("`{n}` is not an aggregate")) };
                c.take();
                let col = col_name(c.take())?;
                if c.take() != Some(Tok::RParen) {
                    return Err("an aggregate takes one column".into());
                }
                return Ok(Expr::Agg(a, col));
            }
            Ok(Expr::Col(n))
        }
        _ => Err("expected a value".into()),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Lit {
    Num(f64),
    Str(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Cond {
    Cmp(String, &'static str, Lit),
    Not(Box<Cond>),
    And(Box<Cond>, Box<Cond>),
    Or(Box<Cond>, Box<Cond>),
}

impl Cond {
    /// Each column compared, and whether against a number.
    pub fn cols(&self, out: &mut Vec<(String, bool)>) {
        match self {
            Cond::Cmp(c, _, l) => out.push((c.clone(), matches!(l, Lit::Num(_)))),
            Cond::Not(x) => x.cols(out),
            Cond::And(a, b) | Cond::Or(a, b) => {
                a.cols(out);
                b.cols(out);
            }
        }
    }

    /// Whether one row passes: `cell(column)` gives its text and number. A
    /// cell that is not a number never matches a numeric comparison.
    pub fn holds(&self, cell: &dyn Fn(&str) -> (String, Option<f64>)) -> bool {
        match self {
            Cond::Cmp(c, op, lit) => {
                let (text, num) = cell(c);
                let ord = match lit {
                    Lit::Num(n) => match num {
                        Some(v) => v.partial_cmp(n),
                        None => return false,
                    },
                    Lit::Str(s) => Some(crate::uni::cmp_utf16(&text, s)),
                };
                let Some(o) = ord else { return false };
                use std::cmp::Ordering::*;
                match *op {
                    "=" => o == Equal,
                    "!=" => o != Equal,
                    "<" => o == Less,
                    "<=" => o != Greater,
                    ">" => o == Greater,
                    _ => o != Less,
                }
            }
            Cond::Not(x) => !x.holds(cell),
            Cond::And(a, b) => a.holds(cell) && b.holds(cell),
            Cond::Or(a, b) => a.holds(cell) || b.holds(cell),
        }
    }
}

fn kw(t: Option<&Tok>, w: &str) -> bool {
    matches!(t, Some(Tok::Name(n)) if n.eq_ignore_ascii_case(w))
}

/// Parse a `where=` expression.
pub fn parse_where(s: &str) -> Result<Cond, String> {
    let mut c = Cursor { toks: tokenize(s)?, i: 0 };
    let e = or(&mut c)?;
    if c.i != c.toks.len() {
        return Err("unexpected text after the condition".into());
    }
    Ok(e)
}

fn or(c: &mut Cursor) -> Result<Cond, String> {
    let mut e = and(c)?;
    while kw(c.peek(), "or") {
        c.take();
        e = Cond::Or(Box::new(e), Box::new(and(c)?));
    }
    Ok(e)
}

fn and(c: &mut Cursor) -> Result<Cond, String> {
    let mut e = not(c)?;
    while kw(c.peek(), "and") {
        c.take();
        e = Cond::And(Box::new(e), Box::new(not(c)?));
    }
    Ok(e)
}

fn not(c: &mut Cursor) -> Result<Cond, String> {
    if kw(c.peek(), "not") {
        c.take();
        return Ok(Cond::Not(Box::new(not(c)?)));
    }
    if c.peek() == Some(&Tok::LParen) {
        c.take();
        let e = or(c)?;
        if c.take() != Some(Tok::RParen) {
            return Err("an unclosed parenthesis".into());
        }
        return Ok(e);
    }
    let col = match c.take() {
        Some(Tok::Name(n)) | Some(Tok::Str(n)) => n,
        _ => return Err("expected a column".into()),
    };
    let op = match c.take() {
        Some(Tok::Op(op)) if matches!(op, "=" | "!=" | "<" | "<=" | ">" | ">=") => op,
        _ => return Err(format!("expected a comparison after `{col}`")),
    };
    let lit = match c.take() {
        Some(Tok::Num(n)) => Lit::Num(n),
        Some(Tok::Op("-")) => match c.take() {
            Some(Tok::Num(n)) => Lit::Num(-n),
            _ => return Err("expected a number after `-`".into()),
        },
        Some(Tok::Str(s)) => Lit::Str(s),
        _ => return Err(format!("expected a value after `{col} {op}`")),
    };
    Ok(Cond::Cmp(col, op, lit))
}

/// One `Name [fmt] = expr` entry.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub name: String,
    pub fmt: Option<String>,
    pub rhs: String,
}

/// Split on `;` outside single quotes.
pub fn split_entries(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in s.chars() {
        match c {
            '\'' => {
                quoted = !quoted;
                cur.push(c);
            }
            ';' if !quoted => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out.into_iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

/// Split comma-separated column names, a name with spaces single-quoted.
pub fn split_names(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in s.chars() {
        match c {
            '\'' => quoted = !quoted,
            ',' if !quoted => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out.into_iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

/// Read one entry: the left side (a name and an optional `[printf]` format —
/// the LAST `[…]` group, ending the side, holding a `%` and no `]`) and the
/// expression. `None` when it is not `Name = expr`.
pub fn parse_entry(s: &str) -> Option<Entry> {
    let mut quoted = false;
    let mut eq = None;
    for (i, c) in s.char_indices() {
        match c {
            '\'' => quoted = !quoted,
            '=' if !quoted => {
                eq = Some(i);
                break;
            }
            _ => {}
        }
    }
    let eq = eq?;
    let left = s[..eq].trim();
    let rhs = s[eq + 1..].trim();
    if left.is_empty() || rhs.is_empty() {
        return None;
    }
    let (mut name, fmt) = match left.rfind('[') {
        Some(o) if left.ends_with(']') && left[o + 1..left.len() - 1].contains('%') && !left[o + 1..left.len() - 1].contains(']') => {
            (left[..o].trim().to_string(), Some(left[o + 1..left.len() - 1].to_string()))
        }
        _ => (left.to_string(), None),
    };
    if name.len() >= 2 && name.starts_with('\'') && name.ends_with('\'') {
        name = name[1..name.len() - 1].to_string();
    }
    if name.is_empty() {
        return None;
    }
    Some(Entry { name, fmt, rhs: rhs.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens() {
        let t = tokenize("'Unit Price' >= -1.5e2 and x != 'a''b' (y<=2)").unwrap();
        assert_eq!(t[0], Tok::Str("Unit Price".into()));
        assert_eq!(t[1], Tok::Op(">="));
        assert_eq!(t[2], Tok::Op("-"));
        assert_eq!(t[3], Tok::Num(150.0));
        assert_eq!(t[7], Tok::Str("a'b".into()));
        assert!(tokenize("'x").is_err());
        assert!(tokenize("a ! b").is_err());
        assert!(tokenize("1.2.3").is_err());
        assert_eq!(tokenize("2e").unwrap(), vec![Tok::Num(2.0), Tok::Name("e".into())]);
        assert_eq!(tokenize("a+b-c*d/e<f>g").unwrap().len(), 13);
    }

    #[test]
    fn arithmetic() {
        let e = parse_arith("(sum(FY) - sum(PriorFY)) * 100 / sum('Prior FY') + -A").unwrap();
        assert!(e.has_agg());
        let mut bare = vec![];
        e.bare_cols(&mut bare);
        assert_eq!(bare, vec!["A"]);
        let mut all = vec![];
        e.all_cols(&mut all);
        assert_eq!(all.len(), 4);
        let v = parse_arith("1 + 2 * 3 - 4 / 2").unwrap().compute(&mut |_| Ok(0.0), &mut |_, _| Ok(0.0)).unwrap();
        assert_eq!(v, 5.0);
        assert!(!parse_arith("-(1)").unwrap().has_agg());
        for bad in ["(1", "foo(x)", "sum(x, y)", "sum(1)", "1 +", "1 2", ""] {
            assert!(parse_arith(bad).is_err(), "{bad}");
        }
        let cells = vec![("1".to_string(), Some(1.0)), ("x".into(), None), ("".into(), None), ("4".into(), Some(4.0))];
        assert_eq!(Agg::Count.fold(&cells), 3.0);
        assert_eq!(Agg::Sum.fold(&cells), 5.0);
        assert_eq!(Agg::Avg.fold(&cells), 2.5);
        assert_eq!(Agg::Min.fold(&cells), 1.0);
        assert_eq!(Agg::Max.fold(&cells), 4.0);
        assert!(Agg::Avg.fold(&[]).is_nan());
        assert!(Agg::from_name("median").is_none());
    }

    #[test]
    fn conditions() {
        let c = parse_where("not S = 'shut' and N > 1 or N = 1").unwrap();
        let row = |n: f64, s: &str| {
            let s = s.to_string();
            move |col: &str| if col == "N" { (n.to_string(), Some(n)) } else { (s.clone(), None) }
        };
        assert!(c.holds(&row(1.0, "open")) && c.holds(&row(5.0, "open")) && !c.holds(&row(9.0, "shut")));
        let c = parse_where("(N <= -1 or N >= 3) and N != 4 and 'a b' < 'z'").unwrap();
        let mut cols = vec![];
        c.cols(&mut cols);
        assert_eq!(cols.len(), 4);
        assert!(c.holds(&|col: &str| if col == "N" { ("5".into(), Some(5.0)) } else { ("a".into(), None) }));
        assert!(!parse_where("N > 1").unwrap().holds(&|_| ("x".into(), None)));
        for bad in ["N >", "N", "> 1", "N > - x", "(N > 1", "N > 1 junk", "N + 1"] {
            assert!(parse_where(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn entries() {
        assert_eq!(split_entries("a = 1; b = 'x;y' ;; "), vec!["a = 1", "b = 'x;y'"]);
        assert_eq!(split_names("S, 'Unit, Price' ,Id"), vec!["S", "Unit, Price", "Id"]);
        let e = parse_entry("YoY [%.1f%%] = (FY - P) * 100").unwrap();
        assert_eq!((e.name.as_str(), e.fmt.as_deref(), e.rhs.as_str()), ("YoY", Some("%.1f%%"), "(FY - P) * 100"));
        let e = parse_entry("[Data] = A + B").unwrap();
        assert_eq!((e.name.as_str(), e.fmt.as_deref()), ("[Data]", None));
        let e = parse_entry("[Data] [%.1f] = A").unwrap();
        assert_eq!((e.name.as_str(), e.fmt.as_deref()), ("[Data]", Some("%.1f")));
        let e = parse_entry("'Unit Total' = 'x=y'").unwrap();
        assert_eq!((e.name.as_str(), e.rhs.as_str()), ("Unit Total", "'x=y'"));
        assert!(parse_entry("no equals").is_none() && parse_entry("= 1").is_none() && parse_entry("a =").is_none() && parse_entry("[%d] = 1").is_none());
    }
}
