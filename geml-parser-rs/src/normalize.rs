//! §0.5: the normalized character stream every other rule is stated over.

/// §0.1: decode UTF-8, each maximal ill-formed subsequence becoming one
/// U+FFFD — the replacement Unicode recommends and user agents apply.
pub fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// §0.2–§0.4, in order: one leading U+FEFF removed, every line ending one
/// U+000A, U+0000 replaced with U+FFFD.
pub fn normalize(text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\0' => out.push('\u{fffd}'),
            c => out.push(c),
        }
    }
    out
}

/// The lines of a normalized stream (§0.3). A final line ending ends the last
/// line; it does not begin an empty one.
pub fn lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut v: Vec<String> = text.split('\n').map(str::to_string).collect();
    if text.ends_with('\n') {
        v.pop();
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        assert_eq!(normalize("\u{feff}\u{feff}a\r\nb\rc\0"), "\u{feff}a\nb\nc\u{fffd}");
        assert_eq!(decode(b"a\xc0\xafb"), "a\u{fffd}\u{fffd}b");
        assert_eq!(decode(b"\xef\xbb\xbfhi"), "\u{feff}hi");
        assert_eq!(lines("a\nb\n"), vec!["a", "b"]);
        assert_eq!(lines("a\n\n"), vec!["a", ""]);
        assert!(lines("").is_empty());
    }
}
