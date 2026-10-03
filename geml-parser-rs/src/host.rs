//! What a parse may ask of its host: a file's text — another document, a
//! table's data file, a code or data route — and a file's SHA-256. A parse
//! without a host reads nothing outside the document and says so where the
//! specification asks (`unchecked-cross-document-reference`); confinement to a
//! root (§9.4) is the host's to enforce, since only the host knows the file
//! system.

use std::collections::HashMap;

/// What a host knows about a file a document names.
#[derive(Debug, Clone, PartialEq)]
pub enum FileState {
    /// The file is there, with this SHA-256 (64 lowercase hex digits).
    Present(String),
    Missing,
}

pub trait Host {
    /// The text of the file `path` names, read relative to the document
    /// `from` (`""` reads from the root). `None` when it cannot be read or
    /// lies outside the root.
    fn read(&self, from: &str, path: &str) -> Option<String>;

    /// What is known about the file `path` names, relative to `from`. `None`
    /// when the host cannot look (the check is then skipped, not failed).
    fn file(&self, _from: &str, _path: &str) -> Option<FileState> {
        None
    }
}

/// Join `path` onto the directory of `from`, resolving `.` and `..`. A path
/// that climbs above the root yields `None`.
pub fn join(from: &str, path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    if !path.starts_with('/') {
        let dir = match from.rfind('/') {
            Some(i) => &from[..i],
            None => "",
        };
        parts.extend(dir.split('/').filter(|s| !s.is_empty()));
    }
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

/// §3.3: a relative path a document names resolves against the document's
/// directory, then against the root. The text it names, under that rule.
pub fn read_from(host: &dyn Host, from: &str, path: &str) -> Option<String> {
    host.read(from, path).or_else(|| if from.contains('/') { host.read("", path) } else { None })
}

/// The root-relative name a path resolves to under §3.3's rule, when a file
/// answers it — what a chain or a cache keys a document by.
pub fn locate(host: &dyn Host, from: &str, path: &str) -> Option<String> {
    if host.read(from, path).is_some() {
        return join(from, path);
    }
    if from.contains('/') && host.read("", path).is_some() {
        return join("", path);
    }
    None
}

/// What is known about the file a path names, under §3.3's rule.
pub fn file_from(host: &dyn Host, from: &str, path: &str) -> Option<FileState> {
    let near = host.file(from, path);
    if matches!(near, Some(FileState::Present(_))) || !from.contains('/') {
        return near;
    }
    match host.file("", path) {
        Some(FileState::Present(h)) => Some(FileState::Present(h)),
        _ => near,
    }
}

/// A host over files held in memory, keyed by root-relative path: what the
/// WebAssembly surface and the tests use.
#[derive(Default, Debug, Clone)]
pub struct MapHost {
    /// Text files — documents, data files, sources — by path.
    pub files: HashMap<String, String>,
    /// The SHA-256 of files given by hash alone (images, video, audio).
    pub hashes: HashMap<String, String>,
    /// Whether the host holds every file, so a path it lacks is missing.
    pub complete: bool,
}

impl MapHost {
    /// A host given as JSON — `{"files": {path: text}, "hashes": {path:
    /// sha256}, "complete": bool}`, every member optional — as the WebAssembly
    /// surface takes one.
    pub fn from_json(text: &str) -> Result<MapHost, String> {
        use crate::json::Value;
        let v = crate::json::parse(text).map_err(|e| format!("the host is not JSON: {}", e.message))?;
        let Value::Object(_) = v else { return Err("the host is not a JSON object".into()) };
        let mut h = MapHost::default();
        let map = |key: &str, into: &mut HashMap<String, String>| -> Result<(), String> {
            match v.get(key) {
                None => Ok(()),
                Some(Value::Object(m)) => {
                    for (k, x) in m {
                        let Value::String(t) = x else { return Err(format!("`{key}[\"{k}\"]` is not a string")) };
                        into.insert(k.clone(), t.clone());
                    }
                    Ok(())
                }
                Some(_) => Err(format!("`{key}` is not an object")),
            }
        };
        map("files", &mut h.files)?;
        map("hashes", &mut h.hashes)?;
        h.complete = match v.get("complete") {
            None => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err("`complete` is not a boolean".into()),
        };
        Ok(h)
    }
}

impl Host for MapHost {
    fn read(&self, from: &str, path: &str) -> Option<String> {
        self.files.get(&join(from, path)?).cloned()
    }

    fn file(&self, from: &str, path: &str) -> Option<FileState> {
        let p = join(from, path)?;
        if let Some(h) = self.hashes.get(&p) {
            return Some(FileState::Present(h.clone()));
        }
        match self.files.get(&p) {
            Some(t) => Some(FileState::Present(crate::sha256::hex(t.as_bytes()))),
            None if self.complete => Some(FileState::Missing),
            None => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins() {
        assert_eq!(join("a/b/doc.geml", "lib.geml").as_deref(), Some("a/b/lib.geml"));
        assert_eq!(join("a/b/doc.geml", "../c/x.geml").as_deref(), Some("a/c/x.geml"));
        assert_eq!(join("doc.geml", "./x.geml").as_deref(), Some("x.geml"));
        assert_eq!(join("a/doc.geml", "/r/x.geml").as_deref(), Some("r/x.geml"));
        assert_eq!(join("doc.geml", "../x.geml"), None);
        let mut h = MapHost::default();
        h.files.insert("a/x.geml".into(), "hi".into());
        h.hashes.insert("a/p.png".into(), "ab".into());
        assert_eq!(h.read("a/d.geml", "x.geml").as_deref(), Some("hi"));
        assert_eq!(h.read("a/d.geml", "../../x.geml"), None);
        assert_eq!(h.file("a/d.geml", "p.png"), Some(FileState::Present("ab".into())));
        assert_eq!(h.file("a/d.geml", "x.geml"), Some(FileState::Present(crate::sha256::hex(b"hi"))));
        assert_eq!(h.file("a/d.geml", "q.png"), None);
        h.complete = true;
        assert_eq!(h.file("a/d.geml", "q.png"), Some(FileState::Missing));
        assert_eq!(h.file("d.geml", "../q.png"), None);
        // A host that reads documents and cannot look at files.
        struct Docs;
        impl Host for Docs {
            fn read(&self, _: &str, _: &str) -> Option<String> {
                None
            }
        }
        assert_eq!((Docs.read("a", "b"), Docs.file("a", "b")), (None, None));
    }

    #[test]
    fn from_json() {
        let h = MapHost::from_json(r#"{"files": {"a.geml": "x"}, "hashes": {"p.png": "ab"}, "complete": true}"#).unwrap();
        assert_eq!((h.files["a.geml"].as_str(), h.hashes["p.png"].as_str(), h.complete), ("x", "ab", true));
        assert!(!MapHost::from_json(r#"{"files": {}}"#).unwrap().complete);
        assert_eq!(MapHost::from_json("{").unwrap_err(), "the host is not JSON: expected a member name");
        assert_eq!(MapHost::from_json("[]").unwrap_err(), "the host is not a JSON object");
        assert_eq!(MapHost::from_json(r#"{"files": []}"#).unwrap_err(), "`files` is not an object");
        assert_eq!(MapHost::from_json(r#"{"hashes": {"p": 1}}"#).unwrap_err(), "`hashes[\"p\"]` is not a string");
        assert_eq!(MapHost::from_json(r#"{"complete": 1}"#).unwrap_err(), "`complete` is not a boolean");
    }
}
