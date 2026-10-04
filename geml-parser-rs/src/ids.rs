//! §4: the id a heading derives from its text.

use crate::inline::{verbatim_spans, SpanKind};
use crate::uni::{is_letter, is_number, is_ws, nfd};

/// Derive a heading id from its text as written (before interpolation):
/// lower-case; NFD; delete code spans; keep letters, numbers, whitespace, `-`
/// and `_`; trim; each whitespace run becomes one `-`.
pub fn derive_id(text: &str) -> String {
    let lower = text.to_lowercase();
    let chars: Vec<char> = nfd(&lower).chars().collect();
    // Which characters a code span holds, marked once: asking every span at
    // every character is the square of a heading made of code spans.
    let mut in_code = vec![false; chars.len()];
    for (s, e, _) in verbatim_spans(&chars).into_iter().filter(|(_, _, k)| *k == SpanKind::Code) {
        in_code[s..e].fill(true);
    }
    let kept: String = chars
        .iter()
        .enumerate()
        .filter(|(i, c)| !in_code[*i] && (is_letter(**c) || is_number(**c) || is_ws(**c) || **c == '-' || **c == '_'))
        .map(|(_, c)| *c)
        .collect();
    let mut out = String::new();
    let mut gap = false;
    for c in kept.trim_matches(is_ws).chars() {
        if is_ws(c) {
            gap = true;
            continue;
        }
        if gap {
            out.push('-');
            gap = false;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives() {
        assert_eq!(derive_id("Use `foo()` in 2024 Design"), "use-in-2024-design");
        assert_eq!(derive_id("Ubytovací zařízení"), "ubytovaci-zarizeni");
        assert_eq!(derive_id("İstanbul"), "istanbul");
        assert_eq!(derive_id("Step ² and ½ and Ⅳ"), "step-²-and-½-and-ⅳ");
        assert_eq!(derive_id("a\u{feff}b"), "ab");
        assert_eq!(derive_id("设计\u{3000}说明"), "设计-说明");
        assert_eq!(derive_id("!!!"), "");
        assert_eq!(derive_id("$a`b$ and `c` d"), "ab-and-d");
        assert_eq!(derive_id("Release {{v}}"), "release-v");
        assert_eq!(derive_id("foo_bar"), "foo_bar");
    }
}
