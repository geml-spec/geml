//! The WebAssembly surface: each function takes text or bytes and returns
//! JSON, so a JavaScript host reads the model with `JSON.parse`.

use wasm_bindgen::prelude::*;

/// The document model as JSON: `children`, `diagnostics`, `meta`, `ids`,
/// `addresses`, `profiles`, `profileDiagnostics`.
#[wasm_bindgen]
pub fn parse(text: &str) -> String {
    crate::to_json(&crate::parse(text))
}

/// Parse bytes, decoding UTF-8 as §0.1 requires.
#[wasm_bindgen(js_name = parseBytes)]
pub fn parse_bytes(bytes: &[u8]) -> String {
    crate::to_json(&crate::parse_bytes(bytes))
}

/// §0.1's decoding on its own.
#[wasm_bindgen]
pub fn decode(bytes: &[u8]) -> String {
    crate::decode(bytes)
}

/// The conformance projection.
#[wasm_bindgen]
pub fn project(text: &str) -> String {
    crate::project(&crate::parse(text))
}

/// The conformance block tree.
#[wasm_bindgen(js_name = blocksOf)]
pub fn blocks_of(text: &str) -> String {
    crate::blocks_of(&crate::parse(text))
}

/// The addresses a listing gives, as a JSON array.
#[wasm_bindgen]
pub fn addresses(text: &str) -> String {
    let d = crate::parse(text);
    crate::json::to_json(&crate::json::Value::Array(d.addresses.into_iter().map(crate::json::Value::String).collect()))
}

/// Parse a document read under its name, with a host given as JSON —
/// `{"files": {path: text}, "hashes": {path: sha256}, "complete": bool}` — so cross-document
/// references resolve and the recognized vocabularies' checks run with it.
/// The model carries `profileDiagnostics`.
#[wasm_bindgen(js_name = parseIn)]
pub fn parse_in(name: &str, text: &str, host: &str) -> Result<String, JsError> {
    let h = crate::host::MapHost::from_json(host).map_err(|e| JsError::new(&e))?;
    Ok(crate::to_json(&crate::parse_with(text, &crate::Options { name: name.to_string(), host: Some(&h), ..Default::default() })))
}

fn read(h: &crate::host::MapHost, name: &str) -> Result<crate::Document, JsError> {
    let text = h.files.get(name).ok_or_else(|| JsError::new(&format!("`{name}` is not among the host's files")))?;
    Ok(crate::parse_with(text, &crate::Options { name: name.to_string(), host: Some(h), ..Default::default() }))
}

/// `geml style check`: the stylesheet `sheet` solved against the documents
/// `corpus` names (a JSON array of paths), all read from the host; the
/// registries are `{"components": [...], "handlers": [...]}` or empty. Returns
/// the view model (`geml-style/v1` §10).
#[wasm_bindgen(js_name = styleCheck)]
pub fn style_check(host: &str, sheet: &str, corpus: &str, registries: &str) -> Result<String, JsError> {
    let h = crate::host::MapHost::from_json(host).map_err(|e| JsError::new(&e))?;
    let reg = crate::check::style::Registries::from_json(registries).map_err(|e| JsError::new(&e))?;
    let names = match crate::json::parse(corpus) {
        Ok(crate::json::Value::Array(a)) => a.iter().map(|v| v.scalar_text().unwrap_or_default()).collect::<Vec<_>>(),
        _ => return Err(JsError::new("the corpus is not a JSON array of paths")),
    };
    let s = read(&h, sheet)?;
    let docs = names.iter().map(|n| read(&h, n)).collect::<Result<Vec<_>, _>>()?;
    let refs: Vec<&crate::Document> = docs.iter().collect();
    Ok(crate::check::style::check(&s, &refs, &reg, Some(&h)).to_json())
}

/// Verify a `.gemlhistory` sidecar, and the live file against its current
/// revision when its bytes are given.
#[wasm_bindgen(js_name = historyVerify)]
pub fn history_verify(sidecar: &str, live: Option<Vec<u8>>) -> String {
    crate::check::history::read(sidecar).verify(live.as_deref()).to_json()
}

/// One revision's content, reconstructed and checked against its hash.
#[wasm_bindgen(js_name = historyReconstruct)]
pub fn history_reconstruct(sidecar: &str, revision: &str) -> Result<String, JsError> {
    crate::check::history::read(sidecar).reconstruct(revision).map_err(|e| JsError::new(&e))
}

/// A codemap document's dangling references (`geml-codemap/v1` §5), the
/// documents it names read from the host.
#[wasm_bindgen(js_name = codemapVerify)]
pub fn codemap_verify(name: &str, host: &str) -> Result<String, JsError> {
    let h = crate::host::MapHost::from_json(host).map_err(|e| JsError::new(&e))?;
    let d = read(&h, name)?;
    Ok(crate::check::codemap::verify(&d, Some(&h)).to_json())
}

/// The crate's version.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
