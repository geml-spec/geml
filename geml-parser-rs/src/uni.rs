//! The Unicode properties the specification names, in one place.
//!
//! §4 derives heading ids from General Category L and N and from the
//! `White_Space` property; §5.3 decides flanking with General Category P and S;
//! §4 compares NAMEs after NFD. Each is looked up here rather than approximated:
//! `char::is_alphabetic` is the Alphabetic property, which is wider than
//! category L, and would let a mark survive a derivation the spec deletes it from.

use unicode_general_category::{get_general_category, GeneralCategory as G};
use unicode_normalization::UnicodeNormalization;

/// General Category L (Lu, Ll, Lt, Lm, Lo).
pub fn is_letter(c: char) -> bool {
    matches!(get_general_category(c), G::UppercaseLetter | G::LowercaseLetter | G::TitlecaseLetter | G::ModifierLetter | G::OtherLetter)
}

/// General Category N (Nd, Nl, No).
pub fn is_number(c: char) -> bool {
    matches!(get_general_category(c), G::DecimalNumber | G::LetterNumber | G::OtherNumber)
}

/// General Category M (Mn, Mc, Me).
pub fn is_mark(c: char) -> bool {
    matches!(get_general_category(c), G::NonspacingMark | G::SpacingMark | G::EnclosingMark)
}

/// General Category P or S: what §5.3 counts as punctuation for flanking.
pub fn is_punct_or_symbol(c: char) -> bool {
    matches!(
        get_general_category(c),
        G::ConnectorPunctuation
            | G::DashPunctuation
            | G::OpenPunctuation
            | G::ClosePunctuation
            | G::InitialPunctuation
            | G::FinalPunctuation
            | G::OtherPunctuation
            | G::MathSymbol
            | G::CurrencySymbol
            | G::ModifierSymbol
            | G::OtherSymbol
    )
}

/// The `White_Space` property. `char::is_whitespace` is defined as exactly
/// that property, so U+00A0 and U+0085 are in and U+FEFF is out.
pub fn is_ws(c: char) -> bool {
    c.is_whitespace()
}

/// Trim `White_Space` from both ends (§6's cell text, §4's step 5).
pub fn trim_ws(s: &str) -> &str {
    s.trim_matches(is_ws)
}

/// Trim what ECMAScript's `String.prototype.trim` removes — `White_Space`
/// with U+FEFF and without U+0085 — where the reference parser's reading
/// depends on it.
pub fn trim_js(s: &str) -> &str {
    s.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

/// A NAME character (§3.1): a letter, a digit, `-` or `_`. Numbers and marks
/// are admitted beside letters: a derived id keeps every General Category N
/// character (§4), and a name written in NFD carries its marks.
pub fn is_name_char(c: char) -> bool {
    c == '-' || c == '_' || c.is_ascii_digit() || is_letter(c) || is_number(c) || is_mark(c)
}

/// Whether `s` is a NAME: one or more NAME characters.
pub fn is_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(is_name_char)
}

/// The NFD form of a NAME, the key §4 compares names under.
pub fn nfd(s: &str) -> String {
    s.nfd().collect()
}

/// Compare two strings by UTF-16 code unit, the order §6.1 sorts text in and
/// the order map keys print in.
pub fn cmp_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categories() {
        assert!(is_letter('é') && is_letter('设') && !is_letter('²'));
        assert!(is_number('²') && is_number('Ⅳ') && is_number('½') && !is_number('a'));
        assert!(is_mark('\u{0301}') && !is_mark('a'));
        assert!(is_punct_or_symbol('“') && is_punct_or_symbol('$') && is_punct_or_symbol('，'));
        assert!(!is_punct_or_symbol('a'));
        assert!(is_ws('\u{00a0}') && is_ws('\u{0085}') && is_ws('\u{3000}') && !is_ws('\u{feff}'));
        assert_eq!(trim_ws("\u{3000}a\u{0085}"), "a");
        assert!(is_name("a-b_1") && is_name("设计") && !is_name("") && !is_name("a b"));
        assert_eq!(nfd("é"), "e\u{0301}");
        assert_eq!(cmp_utf16("10", "9"), std::cmp::Ordering::Less);
        // U+FF5E is above the surrogates in code-unit order, U+1F600 below it.
        assert_eq!(cmp_utf16("\u{1F600}", "\u{FF5E}"), std::cmp::Ordering::Less);
    }
}
