//! Files a document names (§3.2, §3.3, §6, §7.1), read through the host. A
//! source route is `<path>[#L<start>[-<end>]]`; it resolves document-relative,
//! then against the host's root — §3.3's resolution root, which the host is.

use crate::host::Host;

/// A route's path and the lines it narrows to (1-based, inclusive).
#[derive(Debug, Clone, PartialEq)]
pub struct Route {
    pub path: String,
    pub range: Option<(usize, usize)>,
}

/// Parse a route. `Err` holds a fragment that is not `L<start>[-<end>]`
/// naming a non-empty range from line 1 on.
pub fn parse(src: &str) -> Result<Route, String> {
    let (path, frag) = match src.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (src, None),
    };
    let range = match frag {
        None => None,
        Some(f) => Some(range(f).ok_or_else(|| f.to_string())?),
    };
    Ok(Route { path: path.to_string(), range })
}

fn range(frag: &str) -> Option<(usize, usize)> {
    let r = frag.strip_prefix('L')?;
    let num = |s: &str| -> Option<usize> {
        if !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) {
            s.parse().ok()
        } else {
            None
        }
    };
    let (a, b) = match r.split_once('-') {
        Some((a, b)) => (num(a)?, num(b)?),
        None => {
            let a = num(r)?;
            (a, a)
        }
    };
    (a >= 1 && b >= a).then_some((a, b))
}

/// The text of the file `path` names, document-relative first, then from the
/// root.
pub fn read(host: &dyn Host, from: &str, path: &str) -> Option<String> {
    crate::host::read_from(host, from, path)
}

/// A file's lines: LF or CRLF, a final line break ending the last line.
pub fn lines(text: &str) -> Vec<&str> {
    let mut v: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if v.last() == Some(&"") {
        v.pop();
    }
    v
}

/// The lines a range names, joined by LF; `Err` with the file's line count
/// when it no longer has them (a drifted route).
pub fn window(text: &str, range: Option<(usize, usize)>) -> Result<String, usize> {
    let all = lines(text);
    match range {
        None => Ok(all.join("\n")),
        Some((a, b)) if b <= all.len() => Ok(all[a - 1..b].join("\n")),
        Some(_) => Err(all.len()),
    }
}

/// The data format a file's extension names (§3.2), lowercase.
pub fn data_format(path: &str) -> Option<&'static str> {
    let p = path.to_ascii_lowercase();
    if p.ends_with(".jsonl") {
        Some("jsonl")
    } else if p.ends_with(".json") {
        Some("json")
    } else if p.ends_with(".yaml") || p.ends_with(".yml") {
        Some("yaml")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::MapHost;

    #[test]
    fn routes() {
        assert_eq!(parse("a.rs").unwrap(), Route { path: "a.rs".into(), range: None });
        assert_eq!(parse("a.rs#L3").unwrap().range, Some((3, 3)));
        assert_eq!(parse("a.rs#L3-9").unwrap().range, Some((3, 9)));
        for bad in ["a.rs#L0", "a.rs#L9-3", "a.rs#3", "a.rs#L", "a.rs#L1-", "a.rs#Lx", "a.rs#L1-2-3"] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        assert_eq!(lines("a\r\nb\n"), vec!["a", "b"]);
        assert_eq!(lines(""), Vec::<&str>::new());
        assert_eq!(lines("a\n\n"), vec!["a", ""]);
        assert_eq!(window("a\nb\nc\n", Some((2, 3))), Ok("b\nc".into()));
        assert_eq!(window("a\nb\n", Some((2, 3))), Err(2));
        assert_eq!(window("a\nb", None), Ok("a\nb".into()));
        assert_eq!(
            (data_format("x.JSON"), data_format("x.jsonl"), data_format("x.yml"), data_format("x.csv")),
            (Some("json"), Some("jsonl"), Some("yaml"), None)
        );
        let mut h = MapHost::default();
        h.files.insert("src/a.rs".into(), "fn a() {}".into());
        h.files.insert("docs/b.rs".into(), "fn b() {}".into());
        assert_eq!(read(&h, "docs/map.geml", "b.rs").as_deref(), Some("fn b() {}"));
        assert_eq!(read(&h, "docs/map.geml", "src/a.rs").as_deref(), Some("fn a() {}"));
        assert_eq!(read(&h, "map.geml", "gone.rs"), None);
    }
}
