//! One operation on one document, as the conformance suite's `edits-*.json`
//! cases state it — and as the WebAssembly surface takes it: the document,
//! its name, the other documents a reference may reach, a revert's sidecar,
//! and the operation.

use std::collections::HashMap;

use crate::host::MapHost;
use crate::json::{self, Value};
use crate::Options;

use super::add::{add, AddOptions};
use super::delete::delete;
use super::find::{find, FindOptions};
use super::get::{get, GetOptions, Part};
use super::list::list;
use super::rename::rename;
use super::replace::replace;
use super::revert::{revert, RevertOptions, Reverted};
use super::select::Indexed;
use super::set::set;
use super::{refuse, Outcome, Reason, Refusal, Unsupported};

/// The operation: the verb and whichever of its arguments the case gives.
#[derive(Clone, Debug, Default)]
pub struct Op {
    pub verb: String,
    pub address: Option<String>,
    pub part: Option<String>,
    pub within: Option<String>,
    pub pattern: Option<String>,
    pub case: bool,
    pub head: bool,
    pub content: Option<String>,
    pub old: Option<String>,
    pub new: Option<String>,
    pub append: bool,
    pub before: Option<String>,
    pub after: Option<String>,
    pub addresses: Vec<String>,
    pub rev: Option<String>,
    pub to: Option<String>,
    pub from: Option<String>,
    pub root: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Case {
    pub geml: String,
    pub file: String,
    pub files: Vec<(String, String)>,
    pub history: Option<String>,
    pub op: Op,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.scalar_text())
}

fn flag(v: &Value, key: &str) -> bool {
    matches!(v.get(key), Some(Value::Bool(true)))
}

/// A case from its JSON object; `Err` names what is missing or malformed.
pub fn case_from_json(v: &Value) -> Result<Case, String> {
    let geml = text(v, "geml").ok_or("case: `geml` is required")?;
    let file = text(v, "file").unwrap_or_else(|| "doc.geml".to_string());
    let mut files = Vec::new();
    if let Some(Value::Object(fs)) = v.get("files") {
        for (k, x) in fs {
            files.push((k.clone(), x.scalar_text().ok_or_else(|| format!("files.{k}: not text"))?));
        }
    }
    let history = text(v, "history");
    let o = v.get("op").ok_or("case: `op` is required")?;
    let addresses = match o.get("addresses") {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.scalar_text()).collect(),
        _ => Vec::new(),
    };
    let op = Op {
        verb: text(o, "verb").ok_or("op: `verb` is required")?,
        address: text(o, "address"),
        part: text(o, "part"),
        within: text(o, "within"),
        pattern: text(o, "pattern"),
        case: flag(o, "case"),
        head: flag(o, "head"),
        content: text(o, "content"),
        old: text(o, "old"),
        new: text(o, "new"),
        append: flag(o, "append"),
        before: text(o, "before"),
        after: text(o, "after"),
        addresses,
        rev: text(o, "rev"),
        to: text(o, "to"),
        from: text(o, "from"),
        root: text(o, "root"),
    };
    Ok(Case { geml, file, files, history, op })
}

/// One case given as JSON, its outcome as JSON — the shape the suite's
/// `_edits.mjs` compares: `{text}`, `{output}`, `{rows}`, `{hits}`,
/// `{diagnostics}`, `{unchanged: true}`, `{refused, message, diagnostics}`,
/// or `{unsupported}` for a case this crate cannot run yet.
pub fn run_json(case: &str) -> String {
    let obj = |fields: Vec<(&str, Value)>| json::to_json(&Value::Object(fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect()));
    let strs = |v: Vec<String>| Value::Array(v.into_iter().map(Value::String).collect());
    let c = match json::parse(case).map_err(|e| format!("{e:?}")).and_then(|v| case_from_json(&v).map_err(|e| e.to_string())) {
        Ok(c) => c,
        Err(e) => return obj(vec![("error", Value::String(e))]),
    };
    match run(&c) {
        Ok(Ok(Outcome::Text(t))) => obj(vec![("text", Value::String(t))]),
        Ok(Ok(Outcome::Output(t))) => obj(vec![("output", Value::String(t))]),
        Ok(Ok(Outcome::Rows(r))) => obj(vec![("rows", r)]),
        Ok(Ok(Outcome::Hits(h))) => obj(vec![("hits", h)]),
        Ok(Ok(Outcome::Diagnostics(d))) => obj(vec![("diagnostics", strs(d))]),
        Ok(Ok(Outcome::Unchanged)) => obj(vec![("unchanged", Value::Bool(true))]),
        Ok(Err(Unsupported(what))) => obj(vec![("unsupported", Value::String(what))]),
        Err(r) => {
            let codes = r.diagnostics.iter().map(|d| format!("{}:{}", d.code, d.severity.as_str())).collect();
            obj(vec![("refused", Value::String(r.reason.as_str().to_string())), ("message", Value::String(r.message)), ("diagnostics", strs(codes))])
        }
    }
}

/// Run one case. `Ok(Err(Unsupported))` says this implementation cannot run
/// it yet — a harness counts that as skipped; `Err` is the operation's own
/// refusal, an answer in its own right.
pub fn run(case: &Case) -> Result<Result<Outcome, Unsupported>, Refusal> {
    let mut host = MapHost { complete: true, ..Default::default() };
    host.files = case.files.iter().cloned().collect::<HashMap<_, _>>();
    let opts = Options { name: case.file.clone(), host: Some(&host), markdown: crate::is_markdown_path(&case.file), ..Default::default() };
    let doc = crate::parse_with(&case.geml, &opts);
    let ix = Indexed::new(&case.geml, &case.file, doc, Some(&host));
    let op = &case.op;
    match op.verb.as_str() {
        "replace" => {
            let (old, new) = (op.old.clone().unwrap_or_default(), op.new.clone().unwrap_or_default());
            Ok(Ok(Outcome::Text(replace(&ix, &old, &new, op.within.as_deref())?)))
        }
        "set" => {
            let Some(part) = Part::parse(op.part.as_deref()) else {
                return refuse(Reason::BadAddress, format!("unknown part `{}`", op.part.clone().unwrap_or_default()));
            };
            let address = op.address.clone().unwrap_or_default();
            match set(&ix, &address, part, op.content.as_deref().unwrap_or(""))? {
                Ok(text) => Ok(Ok(Outcome::Text(text))),
                Err(u) => Ok(Err(u)),
            }
        }
        "add" => {
            let o = AddOptions { append: op.append, before: op.before.as_deref(), after: op.after.as_deref() };
            Ok(Ok(Outcome::Text(add(&ix, op.content.as_deref().unwrap_or(""), &o)?)))
        }
        "delete" => Ok(Ok(Outcome::Text(delete(&ix, &op.addresses)?.text))),
        "rename" => {
            let (old, new) = (op.old.clone().unwrap_or_default(), op.new.clone().unwrap_or_default());
            Ok(Ok(Outcome::Text(rename(&ix, &old, &new)?)))
        }
        "revert" => {
            let o = RevertOptions {
                rev: op.rev.as_deref().unwrap_or("-1"),
                head_only: op.head,
                before: op.before.as_deref(),
                after: op.after.as_deref(),
                append: op.append,
            };
            let address = op.address.clone().unwrap_or_default();
            match revert(&ix, &address, case.history.as_deref(), &o)? {
                Reverted::Unchanged => Ok(Ok(Outcome::Unchanged)),
                Reverted::Text(t) => Ok(Ok(Outcome::Text(t))),
            }
        }
        "list" => Ok(Ok(Outcome::Rows(list(&ix, op.within.as_deref())?))),
        "find" => {
            let pattern = op.pattern.clone().unwrap_or_default();
            let o = FindOptions { sensitive: op.case, with_line: op.head, within: op.within.as_deref() };
            Ok(Ok(Outcome::Hits(find(&ix, &pattern, &o)?)))
        }
        "get" => {
            let Some(part) = Part::parse(op.part.as_deref()) else {
                return refuse(Reason::BadAddress, format!("unknown part `{}`", op.part.clone().unwrap_or_default()));
            };
            let address = op.address.clone().unwrap_or_default();
            match get(&ix, &address, &GetOptions { part, within: op.within.as_deref() })? {
                Ok(out) => Ok(Ok(Outcome::Output(out))),
                Err(u) => Ok(Err(u)),
            }
        }
        "check" => Ok(Ok(Outcome::Diagnostics(super::check::check(&ix.doc)))),
        "to" => match super::to::to(&ix, op.from.as_deref(), op.to.as_deref().unwrap_or("geml"))? {
            Ok(out) => Ok(Ok(Outcome::Output(out))),
            Err(u) => Ok(Err(u)),
        },
        other => Ok(Err(Unsupported(format!("the `{other}` operation")))),
    }
}
