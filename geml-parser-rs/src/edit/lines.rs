//! Physical lines. An edit slices and splices a document by LINE, keeping
//! each line's own terminator, so a CRLF document stays CRLF and the bytes
//! outside the edited unit are the bytes that went in. §0.5 promises the
//! normalized stream has the same line count as the input, which is what lets
//! a span found on the model address the original text.

/// Split into physical lines, each keeping its terminator: a line ends at
/// `\n`, or at a lone `\r` (old-Mac style) — the same boundaries §0.5's
/// `\r\n?` → `\n` normalization sees, so an index here is an index there.
/// Joining the pieces back gives the input byte for byte.
pub fn split_physical(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                out.push(&text[start..=i]);
                start = i + 1;
            }
            b'\r' if i + 1 >= bytes.len() || bytes[i + 1] != b'\n' => {
                out.push(&text[start..=i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if start < bytes.len() {
        out.push(&text[start..]);
    }
    out
}

/// The document's newline style: CRLF when any line ends that way, else LF.
pub fn newline_of(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// `\r\n` and lone `\r` → `\n`.
pub fn to_lf(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

/// LF-normalize, then write every newline in the given style.
pub fn to_newline(text: &str, nl: &str) -> String {
    let lf = to_lf(text);
    if nl == "\n" {
        lf
    } else {
        lf.replace('\n', nl)
    }
}

/// The LF-normalized lines a span indexes: `split('\n')`, so text ending in a
/// newline has one more, empty, line — the count the span layer uses.
pub fn lf_lines(text: &str) -> Vec<String> {
    to_lf(text).split('\n').map(str::to_string).collect()
}

/// A line without its terminator.
pub fn strip_eol(line: &str) -> &str {
    line.strip_suffix("\r\n").or_else(|| line.strip_suffix('\n')).or_else(|| line.strip_suffix('\r')).unwrap_or(line)
}

/// Trailing spaces and tabs removed — exactly those two bytes.
pub fn trim_space_tab_end(s: &str) -> &str {
    s.trim_end_matches([' ', '\t'])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_lines_keep_their_terminators() {
        assert_eq!(split_physical("a\r\nb\nc\rd"), vec!["a\r\n", "b\n", "c\r", "d"]);
        assert_eq!(split_physical("a\nb\n"), vec!["a\n", "b\n"]);
        assert_eq!(split_physical(""), Vec::<&str>::new());
        assert_eq!(split_physical("a\r\nb\nc\rd").concat(), "a\r\nb\nc\rd");
    }

    #[test]
    fn newline_styles() {
        assert_eq!(newline_of("a\r\nb"), "\r\n");
        assert_eq!(newline_of("a\nb"), "\n");
        assert_eq!(to_lf("a\r\nb\rc\n"), "a\nb\nc\n");
        assert_eq!(to_newline("a\nb\r\n", "\r\n"), "a\r\nb\r\n");
        assert_eq!(lf_lines("a\nb\n"), vec!["a", "b", ""]);
        assert_eq!(strip_eol("x\r\n"), "x");
        assert_eq!(trim_space_tab_end("x \t "), "x");
    }
}
