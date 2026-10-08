//! `to`: the document projected into a format — `geml` (the canonical
//! serialization), `md` (the Markdown export) or `json` (the document model,
//! as `parse` returns it; the suite reads it through its own projection, so
//! its layout is this crate's). Input is GEML, or that model JSON read back
//! (`from_json`), or Markdown converted to GEML (`from_md`). HTML output is not
//! provided here.

use super::select::Indexed;
use super::{refuse, Reason, Refusal, Unsupported};

fn in_format(file: &str, from: Option<&str>) -> String {
    if let Some(f) = from {
        return f.to_string();
    }
    let lower = file.to_ascii_lowercase();
    if lower.ends_with(".md") || lower.ends_with(".markdown") {
        "md".to_string()
    } else if lower.ends_with(".json") {
        "json".to_string()
    } else {
        "geml".to_string()
    }
}

pub fn to(ix: &Indexed, from: Option<&str>, out: &str) -> Result<Result<String, Unsupported>, Refusal> {
    let loaded;
    let doc = match in_format(ix.file, from).as_str() {
        "geml" => &ix.doc,
        // Markdown converts to GEML; that GEML is the `geml` output as it
        // stands, and any other output reads it again.
        "md" => {
            let (geml, _notes) = super::from_md::md_to_geml(ix.text);
            if out == "geml" {
                return Ok(Ok(geml));
            }
            loaded = crate::parse_with(
                &geml,
                &crate::Options { name: ix.file.to_string(), host: ix.host, markdown: crate::is_markdown_path(ix.file), ..Default::default() },
            );
            &loaded
        }
        // This crate's own model JSON, read back; GEML is written from it, and
        // any other output is made from that GEML read again.
        "json" => {
            let children = match crate::from_json::document(ix.text) {
                Ok(c) => c,
                Err(e) => return refuse(Reason::BadContent, format!("{} is not a document model: {e}", ix.whereof())),
            };
            let geml = super::serialize::serialize(&children);
            if out == "geml" {
                return Ok(Ok(geml));
            }
            loaded = crate::parse_with(&geml, &crate::Options { name: ix.file.to_string(), host: ix.host, ..Default::default() });
            &loaded
        }
        other => return refuse(Reason::BadContent, format!("unknown input format `{other}`")),
    };
    match out {
        "geml" => Ok(Ok(super::serialize::serialize(&doc.children))),
        "md" => Ok(Ok(super::to_md::to_md_from(doc, ix.file, ix.text, ix.host).0)),
        "json" => Ok(Ok(crate::to_json(doc))),
        "html" => Ok(Err(Unsupported("`html` output".into()))),
        other => refuse(Reason::BadContent, format!("unknown output format `{other}`")),
    }
}
