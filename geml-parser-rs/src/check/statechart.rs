//! `geml-statechart/v1`'s checks (§3 of its profile): a statechart is one
//! `diagram` block, `format=geml-statechart`, whose body — or the `data` block
//! its `data=` names — is a JSON object holding `initial`, `states`,
//! `transitions` and `vars`. Every key the format does not reserve is an
//! attribute and is not checked.
//!
//! A guard is read in §4's JSON Schema subset. The variables it reads are the
//! keys of `properties` and the names in `required` at its top level and in
//! every `anyOf` / `oneOf` branch; a schema under a variable describes that
//! variable's value, so its own keys name no further variable. The warnings —
//! a state nothing reaches, a state with no way out — are held back while the
//! chart carries an error, since a broken edge would make them guesses.

use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use super::{addr, Out};
use crate::host::Host;
use crate::json::{self, Value};
use crate::model::{Block, Document, Item};
use crate::resolve::{Found, Index, Resolver, Target};
use crate::uni::is_name;
use crate::vocab::Level::{Error as E, Warning as W};

const TYPES: &[&str] = &["object", "array", "string", "number", "integer", "boolean", "null"];

pub fn check(doc: &Document, host: Option<&dyn Host>, out: &mut Out) {
    let r = Resolver::new(Rc::new(Index::of(doc)), host, &doc.name);
    walk(&doc.name, &r, &doc.children, out);
}

fn walk(name: &str, r: &Resolver, items: &[Item], out: &mut Out) {
    for it in items {
        let Item::Block(b) = it else { continue };
        if b.type_name == "diagram" && b.attr_text("format").as_deref() == Some("geml-statechart") {
            chart(name, r, b, out);
        }
        walk(name, r, &b.children, out);
    }
}

/// `doc.geml#id` or `#id`, split into its document and its anchor.
fn split_ref(s: &str) -> (Option<&str>, &str) {
    match s.split_once('#') {
        Some(("", id)) => (None, id),
        Some((d, id)) => (Some(d), id),
        None => (None, s),
    }
}

/// §2.5: a string starting with `#`, or of the form `doc.geml#id`, is a
/// reference; any other string is a sentence.
fn is_ref(s: &str) -> bool {
    if s.starts_with('#') {
        return true;
    }
    if s.chars().any(char::is_whitespace) {
        return false;
    }
    matches!(s.split_once('#'), Some((d, id)) if d.ends_with(".geml") && !id.is_empty())
}

/// What a reference to a definition or a guard reached.
enum Reached {
    /// A `data` block whose value is an object.
    Object(Vec<(String, Value)>),
    /// Something else, or nothing.
    Not,
    /// Another document, and no host to read it with: not checked.
    Unknown,
}

fn reach(r: &Resolver, reference: &str) -> Reached {
    let (d, id) = split_ref(reference.trim());
    match r.target(d, id) {
        Target::NoHost => Reached::Unknown,
        Target::Hit { index, found: Found::Block(i), coord: None, .. } => match &index.snaps[i] {
            s if s.type_name == "data" => match &s.value {
                Some(Value::Object(m)) => Reached::Object(m.clone()),
                _ => Reached::Not,
            },
            _ => Reached::Not,
        },
        _ => Reached::Not,
    }
}

fn get<'a>(m: &'a [(String, Value)], k: &str) -> Option<&'a Value> {
    m.iter().find(|(x, _)| x == k).map(|(_, v)| v)
}

struct Chart<'a> {
    at: String,
    out: &'a mut Out,
    errors: usize,
}

impl Chart<'_> {
    fn err(&mut self, code: &'static str, message: String) {
        self.errors += 1;
        self.out.push(code, E, self.at.clone(), message);
    }
}

fn chart(name: &str, r: &Resolver, b: &Block, out: &mut Out) {
    let mut c = Chart { at: addr(name, b), out, errors: 0 };
    let Some(def) = definition(r, b, &mut c) else { return };

    // States: every key of `states` is a state, whatever else is wrong with it,
    // so a transition into it is not also reported.
    let states: Option<Vec<String>> = match get(&def, "states") {
        Some(Value::Object(m)) => {
            for (id, v) in m {
                state(id, v, &mut c);
            }
            Some(m.iter().map(|(k, _)| k.clone()).collect())
        }
        _ => {
            c.err("statechart-state", "`states` is missing or is not an object".into());
            None
        }
    };
    let finals: HashSet<String> = match get(&def, "states") {
        Some(Value::Object(m)) => m.iter().filter(|(_, v)| matches!(v.get("final"), Some(Value::Bool(true)))).map(|(k, _)| k.clone()).collect(),
        _ => HashSet::new(),
    };
    let is_state = |s: &str| states.as_ref().is_some_and(|v| v.iter().any(|x| x == s));

    let initial = match get(&def, "initial") {
        Some(Value::String(s)) => {
            if states.is_some() && !is_state(s) {
                c.err("statechart-initial", format!("`initial` names `{s}`, which is not a state"));
            }
            Some(s.clone())
        }
        _ => {
            c.err("statechart-initial", "`initial` is missing or is not a string".into());
            None
        }
    };

    // Variables: `None` when `vars` itself is broken, so what reads one is not
    // reported a second time.
    let vars: Option<HashSet<String>> = match get(&def, "vars") {
        None => Some(HashSet::new()),
        Some(Value::Object(m)) => {
            let mut names = HashSet::new();
            for (k, v) in m {
                let mut ok = true;
                if !is_name(k) {
                    c.err("statechart-vars", format!("variable name {} is not a NAME", json::quote(k)));
                    ok = false;
                }
                match v {
                    Value::Object(o) if get(o, "default").is_some() => {}
                    Value::Object(_) => c.err("statechart-vars", format!("variable `{k}` has no `default`")),
                    _ => c.err("statechart-vars", format!("variable `{k}` is not an object")),
                }
                if ok {
                    names.insert(k.clone());
                }
            }
            Some(names)
        }
        Some(_) => {
            c.err("statechart-vars", "`vars` is not an object".into());
            None
        }
    };

    let mut edges: Vec<(String, String)> = Vec::new();
    match get(&def, "transitions") {
        Some(Value::Array(ts)) => {
            // How many transitions join each pair, for a label that tells them apart.
            let mut pairs: HashMap<(String, String), usize> = HashMap::new();
            for t in ts {
                if let (Some(Value::String(f)), Some(Value::String(to))) = (t.get("from"), t.get("to")) {
                    *pairs.entry((f.clone(), to.clone())).or_default() += 1;
                }
            }
            let mut seen: HashMap<(String, String), usize> = HashMap::new();
            for (i, t) in ts.iter().enumerate() {
                let n = i + 1;
                let Value::Object(_) = t else {
                    c.err("statechart-transition", format!("transition {n} is not an object"));
                    continue;
                };
                let from = match t.get("from") {
                    Some(Value::String(s)) => Some(s.clone()),
                    _ => None,
                };
                let to = match t.get("to") {
                    Some(Value::String(s)) => Some(s.clone()),
                    _ => None,
                };
                let label = match (&from, &to) {
                    (Some(f), Some(to)) => {
                        let key = (f.clone(), to.clone());
                        let k = seen.entry(key.clone()).or_default();
                        *k += 1;
                        if pairs[&key] > 1 && *k > 1 {
                            format!("{f}→{to}[{k}]")
                        } else {
                            format!("{f}→{to}")
                        }
                    }
                    _ => format!("transition {n}"),
                };
                let mut joined = true;
                for (key, end) in [("from", &from), ("to", &to)] {
                    match end {
                        None => {
                            c.err("statechart-transition", format!("{label}: `{key}` is missing"));
                            joined = false;
                        }
                        Some(s) if states.is_some() && !is_state(s) => {
                            c.err("statechart-transition", format!("{label}: `{key}` names `{s}`, which is not a state"));
                            joined = false;
                        }
                        Some(_) => {}
                    }
                }
                if t.get("event").is_some() {
                    c.err("statechart-transition", format!("{label} carries `event`, which v1 reserves for v2"));
                }
                if let Some(g) = t.get("guard") {
                    guard(r, g, &label, vars.as_ref(), &mut c);
                }
                if let Some(a) = t.get("actions") {
                    actions(a, &label, vars.as_ref(), &mut c);
                }
                if let (true, Some(f), Some(to)) = (joined && states.is_some(), from, to) {
                    if finals.contains(&f) {
                        c.err("statechart-final", format!("{label}: `{f}` is marked final, and a final state has no transition out"));
                    }
                    edges.push((f, to));
                }
            }
        }
        _ => c.err("statechart-transition", "`transitions` is missing or is not an array".into()),
    }

    if let Some(cur) = b.attr_text("current") {
        if states.is_some() && !is_state(&cur) {
            c.err("statechart-current", format!("`current={cur}` is not a state"));
        }
    }

    if c.errors > 0 {
        return;
    }
    let (Some(states), Some(initial)) = (states, initial) else { return };
    let mut reached: HashSet<&str> = HashSet::from([initial.as_str()]);
    let mut queue = VecDeque::from([initial.as_str()]);
    while let Some(s) = queue.pop_front() {
        for (f, t) in &edges {
            if f == s && reached.insert(t.as_str()) {
                queue.push_back(t.as_str());
            }
        }
    }
    for s in &states {
        if !reached.contains(s.as_str()) {
            c.out.push("statechart-unreachable", W, c.at.clone(), format!("state `{s}` cannot be reached from `{initial}`"));
        }
    }
    for s in &states {
        if !finals.contains(s) && !edges.iter().any(|(f, _)| f == s) {
            c.out.push("statechart-dead-end", W, c.at.clone(), format!("state `{s}` has no transition out and is not marked final"));
        }
    }
}

/// The definition: the body, or the `data` block `data=` names (§2.8). `None`
/// when there is none to check — reported, or in a document no host reaches.
fn definition(r: &Resolver, b: &Block, c: &mut Chart) -> Option<Vec<(String, Value)>> {
    let body = b.raw.join("\n");
    let has_body = !body.trim().is_empty();
    if let Some(d) = b.attr_text("data") {
        if has_body {
            c.err("statechart-body", "the block has a body and `data=` at once".into());
            return None;
        }
        return match reach(r, &d) {
            Reached::Object(m) => Some(m),
            Reached::Unknown => None,
            Reached::Not => {
                c.err("statechart-body", format!("`data={d}` does not name a `data` block whose value is an object"));
                None
            }
        };
    }
    match json::parse(&body) {
        Ok(Value::Object(m)) => Some(m),
        Ok(_) => {
            c.err("statechart-body", "the body is not a JSON object".into());
            None
        }
        Err(_) => {
            c.err("statechart-body", "the body is not JSON".into());
            None
        }
    }
}

fn state(id: &str, v: &Value, c: &mut Chart) {
    if !is_name(id) {
        c.err("statechart-state", format!("state id {} is not a NAME", json::quote(id)));
    }
    let Value::Object(m) = v else {
        c.err("statechart-state", format!("state `{id}` is not an object"));
        return;
    };
    for k in ["states", "regions", "initial"] {
        if get(m, k).is_some() {
            c.err("statechart-state", format!("state `{id}` carries `{k}`, which v1 reserves for v2 (hierarchy and parallel regions)"));
        }
    }
    for k in ["title", "description"] {
        if matches!(get(m, k), Some(x) if !matches!(x, Value::String(_))) {
            c.err("statechart-state", format!("state `{id}`: `{k}` is not a string"));
        }
    }
    if matches!(get(m, "final"), Some(x) if !matches!(x, Value::Bool(_))) {
        c.err("statechart-state", format!("state `{id}`: `final` is not a boolean"));
    }
}

fn guard(r: &Resolver, g: &Value, label: &str, vars: Option<&HashSet<String>>, c: &mut Chart) {
    let (schema, at) = match g {
        Value::Object(_) => (g.clone(), "guard".to_string()),
        Value::String(s) if is_ref(s) => match reach(r, s) {
            Reached::Object(m) => (Value::Object(m), s.clone()),
            Reached::Unknown => return,
            Reached::Not => {
                c.err("statechart-guard", format!("{label}: `{s}` does not resolve to a `data` block whose value is an object"));
                return;
            }
        },
        Value::String(_) => return,
        _ => {
            c.err("statechart-guard", format!("{label}: `guard` is neither an object nor a string"));
            return;
        }
    };
    let mut reads = Vec::new();
    subset(&schema, &at, true, &mut reads, label, c);
    if let Some(vars) = vars {
        let mut told = HashSet::new();
        for v in reads {
            if !vars.contains(&v) && told.insert(v.clone()) {
                c.err("statechart-guard", format!("{label}: the guard reads `{v}`, which is not in `vars`"));
            }
        }
    }
}

fn is_scalar(v: &Value) -> bool {
    !matches!(v, Value::Array(_) | Value::Object(_))
}

fn fits(v: &Value, ty: &str) -> bool {
    match (ty, v) {
        ("string", Value::String(_)) | ("boolean", Value::Bool(_)) | ("null", Value::Null) | ("number", Value::Number(_)) => true,
        ("integer", Value::Number(n)) => n.fract() == 0.0,
        _ => false,
    }
}

/// §4's subset. `top` is a level whose `properties` keys and `required` names
/// are variables: the guard itself, and the branches of a combinator on it.
fn subset(s: &Value, at: &str, top: bool, reads: &mut Vec<String>, label: &str, c: &mut Chart) {
    let Value::Object(m) = s else {
        c.err("statechart-guard", format!("{label}: {at}: a schema must be an object"));
        return;
    };
    let ty = match get(m, "type") {
        Some(Value::String(t)) if TYPES.contains(&t.as_str()) => Some(t.as_str()),
        Some(_) => {
            c.err("statechart-guard", format!("{label}: {at}: `type` must be one of {}", TYPES.join(", ")));
            None
        }
        None => None,
    };
    for (k, v) in m {
        match k.as_str() {
            "type" | "default" | "examples" => {}
            "title" | "description" => {
                if !matches!(v, Value::String(_)) {
                    c.err("statechart-guard", format!("{label}: {at}: `{k}` must be a string"));
                }
            }
            "properties" => match v {
                Value::Object(ps) => {
                    for (p, sub) in ps {
                        if top {
                            reads.push(p.clone());
                        }
                        subset(sub, &format!("{at}.properties.{p}"), false, &mut Vec::new(), label, c);
                    }
                }
                _ => c.err("statechart-guard", format!("{label}: {at}: `properties` must be an object")),
            },
            "required" => match v {
                Value::Array(a) if a.iter().all(|x| matches!(x, Value::String(_))) => {
                    if top {
                        reads.extend(a.iter().filter_map(|x| x.scalar_text()));
                    }
                }
                _ => c.err("statechart-guard", format!("{label}: {at}: `required` must be an array of names")),
            },
            "additionalProperties" => {
                if !matches!(v, Value::Bool(_)) {
                    c.err("statechart-guard", format!("{label}: {at}: `additionalProperties` must be a boolean"));
                }
            }
            "items" => subset(v, &format!("{at}.items"), false, &mut Vec::new(), label, c),
            "enum" => match v {
                Value::Array(a) if !a.is_empty() && a.iter().all(is_scalar) => {
                    if let Some(t) = ty {
                        if !a.iter().all(|x| fits(x, t)) {
                            c.err("statechart-guard", format!("{label}: {at}: `enum` does not fit `type`"));
                        }
                    }
                }
                _ => c.err("statechart-guard", format!("{label}: {at}: `enum` must be a non-empty array of scalars")),
            },
            "const" => {
                if !is_scalar(v) {
                    c.err("statechart-guard", format!("{label}: {at}: `const` must be a scalar"));
                } else if ty.is_some_and(|t| !fits(v, t)) {
                    c.err("statechart-guard", format!("{label}: {at}: `const` does not fit `type`"));
                }
            }
            "anyOf" | "oneOf" => match v {
                Value::Array(a) if a.len() >= 2 => {
                    for (i, br) in a.iter().enumerate() {
                        subset(br, &format!("{at}.{k}[{i}]"), top, reads, label, c);
                    }
                }
                _ => c.err("statechart-guard", format!("{label}: {at}: `{k}` needs at least two branches")),
            },
            _ => c.err("statechart-guard", format!("{label}: {at}: unsupported keyword {}", json::quote(k))),
        }
    }
}

fn actions(a: &Value, label: &str, vars: Option<&HashSet<String>>, c: &mut Chart) {
    let Value::Array(list) = a else {
        c.err("statechart-actions", format!("{label}: `actions` is not an array"));
        return;
    };
    for x in list {
        let Value::Object(m) = x else { continue };
        if get(m, "set").is_some() {
            c.err("statechart-actions", format!("{label}: an action with `set` is reserved for v2"));
        }
        let Some(reset) = get(m, "reset") else { continue };
        match reset {
            Value::Array(names) if names.iter().all(|n| matches!(n, Value::String(_))) => {
                let Some(vars) = vars else { continue };
                for n in names.iter().filter_map(|n| n.scalar_text()) {
                    if !vars.contains(&n) {
                        c.err("statechart-actions", format!("{label}: `reset` names `{n}`, which is not in `vars`"));
                    }
                }
            }
            _ => c.err("statechart-actions", format!("{label}: `reset` is not an array of names")),
        }
    }
}
