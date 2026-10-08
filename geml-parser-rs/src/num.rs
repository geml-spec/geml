//! Numbers: how they are read, and every way the specification prints one.
//!
//! - `es_string` is ECMAScript's Number-to-String, which the conformance
//!   projection prints numbers with and §6 falls back to for display.
//! - `parse_bare_number` is §3.1's `number` production, the bare-word shape §4
//!   types as a number.
//! - `display` and `format_printf` are §6's display rules: twelve significant
//!   digits, or one of `%.Nf`, `%.Ne`, `%d`, `%.Ng`, rounded to nearest with
//!   ties away from zero on the EXACT binary value.

/// ECMAScript Number::toString(10) for a finite `x`.
pub fn es_string(x: f64) -> String {
    if x == 0.0 {
        return "0".to_string();
    }
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let neg = x < 0.0;
    // `{:e}` prints the shortest digits that round-trip, as `d.ddde±n`.
    let e = format!("{:e}", x.abs());
    let (mant, exp) = e.split_once('e').expect("exponent form");
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let exp: i32 = exp.parse().expect("exponent");
    let k = digits.len() as i32;
    let n = exp + 1;
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if n > 0 { '+' } else { '-' });
        out.push_str(&(n - 1).abs().to_string());
    }
    out
}

/// §3.1 `number`: `[+-]? (DIGITS ["." [DIGITS]] | "." DIGITS) [exp]`. Returns the
/// nearest binary64 value, or `None` when the word is not that shape or its
/// value is past binary64's range.
pub fn parse_bare_number(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let f = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - f;
    }
    if int_digits == 0 && frac_digits == 0 {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let e = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == e {
            return None;
        }
    }
    if i != b.len() {
        return None;
    }
    // Rust's float parser reads `5.` and `.5` and rounds correctly; the shape
    // check above is what keeps `inf` and `NaN` out.
    let v: f64 = s.parse().ok()?;
    if v.is_finite() {
        Some(v)
    } else {
        None
    }
}

/// The exact decimal expansion of a finite, non-negative f64, as its digit
/// string and the number of those digits that lie before the decimal point
/// (which may be zero or negative: `digits` then starts after leading zeros).
fn exact_decimal(x: f64) -> (Vec<u8>, i64) {
    debug_assert!(x.is_finite() && x >= 0.0);
    if x == 0.0 {
        return (vec![0], 1);
    }
    let bits = x.to_bits();
    let exp_bits = ((bits >> 52) & 0x7ff) as i64;
    let frac = bits & ((1u64 << 52) - 1);
    let (mant, exp) = if exp_bits == 0 { (frac, -1074) } else { (frac | (1u64 << 52), exp_bits - 1075) };
    // value = mant * 2^exp. Big integer in base 1e9, little-endian.
    let mut big: Vec<u64> = vec![mant % 1_000_000_000, mant / 1_000_000_000 % 1_000_000_000, mant / 1_000_000_000_000_000_000];
    let mul = |big: &mut Vec<u64>, m: u64| {
        let mut carry = 0u64;
        for limb in big.iter_mut() {
            let v = *limb * m + carry;
            *limb = v % 1_000_000_000;
            carry = v / 1_000_000_000;
        }
        while carry > 0 {
            big.push(carry % 1_000_000_000);
            carry /= 1_000_000_000;
        }
    };
    // How many of the digits lie after the point.
    let scale: i64 = if exp >= 0 {
        let mut k = exp;
        while k >= 29 {
            mul(&mut big, 1 << 29);
            k -= 29;
        }
        mul(&mut big, 1 << k);
        0
    } else {
        let mut k = -exp;
        while k >= 12 {
            mul(&mut big, 244_140_625); // 5^12
            k -= 12;
        }
        mul(&mut big, 5u64.pow(k as u32));
        -exp
    };
    while big.len() > 1 && *big.last().unwrap() == 0 {
        big.pop();
    }
    let mut s = big.last().unwrap().to_string();
    for limb in big.iter().rev().skip(1) {
        s.push_str(&format!("{:09}", limb));
    }
    let digits: Vec<u8> = s.bytes().map(|c| c - b'0').collect();
    let point = digits.len() as i64 - scale;
    // Strip leading zeros (only possible when the integer part is zero).
    let lead = digits.iter().take_while(|d| **d == 0).count();
    let digits = digits[lead..].to_vec();
    (digits, point - lead as i64)
}

/// Round an exact expansion to keep `keep` digits from its start, ties away
/// from zero. Returns the new digits and point (the point moves when a carry
/// adds a digit).
fn round_keep(digits: &[u8], point: i64, keep: usize) -> (Vec<u8>, i64) {
    if digits.len() <= keep {
        let mut d = digits.to_vec();
        d.resize(keep.max(1), 0);
        return (d, point);
    }
    let mut d = digits[..keep].to_vec();
    let up = digits[keep] >= 5;
    let mut point = point;
    if up {
        let mut i = d.len();
        loop {
            if i == 0 {
                d.insert(0, 1);
                point += 1;
                break;
            }
            i -= 1;
            if d[i] == 9 {
                d[i] = 0;
            } else {
                d[i] += 1;
                break;
            }
        }
    }
    if d.is_empty() {
        d.push(0);
    }
    (d, point)
}

fn digits_str(d: &[u8]) -> String {
    d.iter().map(|x| (b'0' + x) as char).collect()
}

/// `%.Nf`: fixed with `prec` digits after the point.
fn fmt_fixed(x: f64, prec: usize) -> String {
    let neg = x.is_sign_negative() && x != 0.0;
    let (digits, point) = exact_decimal(x.abs());
    // Number of digits to keep = digits before the point + prec.
    let keep = point + prec as i64;
    let (d, p) = if keep < 0 {
        (vec![0], 1)
    } else if keep == 0 {
        // No digit is kept: the first one decides between zero and one unit
        // of the last kept place.
        if digits[0] >= 5 {
            (vec![1], point + 1)
        } else {
            (vec![0], 1)
        }
    } else {
        round_keep(&digits, point, keep as usize)
    };
    // d holds the digits from position p (digits before the point = p).
    let mut int_part = String::new();
    let mut frac_part = String::new();
    let total_before = p;
    if total_before <= 0 {
        int_part.push('0');
        for _ in 0..(-total_before) {
            frac_part.push('0');
        }
        frac_part.push_str(&digits_str(&d));
    } else {
        let tb = total_before as usize;
        if d.len() <= tb {
            int_part.push_str(&digits_str(&d));
            for _ in d.len()..tb {
                int_part.push('0');
            }
        } else {
            int_part.push_str(&digits_str(&d[..tb]));
            frac_part.push_str(&digits_str(&d[tb..]));
        }
    }
    let int_trim = int_part.trim_start_matches('0');
    let int_part = if int_trim.is_empty() { "0".to_string() } else { int_trim.to_string() };
    frac_part.truncate(prec);
    while frac_part.len() < prec {
        frac_part.push('0');
    }
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    out.push_str(&int_part);
    if prec > 0 {
        out.push('.');
        out.push_str(&frac_part);
    }
    out
}

/// Significant-digit rounding: the value's digits rounded to `sig` digits, and
/// its decimal exponent (the power of ten of the first digit).
fn round_sig(x: f64, sig: usize) -> (Vec<u8>, i64) {
    let (digits, point) = exact_decimal(x.abs());
    if x == 0.0 {
        return (vec![0; sig.max(1)], 0);
    }
    let (d, p) = round_keep(&digits, point, sig);
    (d, p - 1)
}

fn exp_suffix(e: i64) -> String {
    let sign = if e < 0 { '-' } else { '+' };
    format!("e{}{:02}", sign, e.abs())
}

/// `%.Ne`.
fn fmt_exp(x: f64, prec: usize) -> String {
    let neg = x.is_sign_negative() && x != 0.0;
    let (d, e) = round_sig(x, prec + 1);
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    out.push((b'0' + d[0]) as char);
    if prec > 0 {
        out.push('.');
        out.push_str(&digits_str(&d[1..prec + 1]));
    }
    out.push_str(&exp_suffix(e));
    out
}

/// `%.Ng`: C's rule. With P significant digits (0 meaning 1) and X the decimal
/// exponent after rounding, fixed notation when P > X >= -4, otherwise
/// exponent notation; trailing zeros and a bare point are removed.
fn fmt_general(x: f64, prec: usize) -> String {
    let p = if prec == 0 { 1 } else { prec };
    if x == 0.0 {
        return if x.is_sign_negative() { "-0".into() } else { "0".into() };
    }
    let (_, e) = round_sig(x, p);
    let strip = |s: String| -> String {
        if let Some(dot) = s.find('.') {
            let (head, tail) = s.split_at(dot);
            let (frac, rest) = match tail.find('e') {
                Some(i) => (&tail[..i], &tail[i..]),
                None => (tail, ""),
            };
            let frac = frac.trim_end_matches('0');
            let frac = if frac == "." { "" } else { frac };
            format!("{}{}{}", head, frac, rest)
        } else {
            s
        }
    };
    if (p as i64) > e && e >= -4 {
        strip(fmt_fixed(x, ((p as i64 - 1 - e) as usize).min(MAX_PRECISION)))
    } else {
        strip(fmt_exp(x, p - 1))
    }
}

/// §6's unformatted display: twelve significant digits, then the shortest
/// round-trip form.
pub fn display(x: f64) -> String {
    if !x.is_finite() {
        return "-".to_string();
    }
    if x == 0.0 {
        return "0".to_string();
    }
    let (d, e) = round_sig(x, 12);
    let s = format!("{}{}.{}e{}", if x < 0.0 { "-" } else { "" }, d[0], digits_str(&d[1..]), e);
    let v: f64 = s.parse().unwrap_or(x);
    es_string(v)
}

/// The most digits a `[printf]` precision asks for (§6).
const MAX_PRECISION: usize = 100;

/// A `[printf]` display format (§6): numeric conversions `%.Nf`, `%.Ne`, `%d`,
/// `%.Ng`, and `%%` for a literal percent. Flags and width are read and
/// ignored; any other text in the format is copied through.
pub fn format_printf(fmt: &str, x: f64) -> String {
    if !x.is_finite() {
        return "-".to_string();
    }
    let chars: Vec<char> = fmt.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '%' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        if i + 1 < chars.len() && chars[i + 1] == '%' {
            out.push('%');
            i += 2;
            continue;
        }
        let mut j = i + 1;
        while j < chars.len() && "-+ #0".contains(chars[j]) {
            j += 1;
        }
        while j < chars.len() && chars[j].is_ascii_digit() {
            j += 1;
        }
        let mut prec: Option<usize> = None;
        if j < chars.len() && chars[j] == '.' {
            j += 1;
            let s = j;
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
            // Clamped as the reference clamps it: toFixed and toExponential
            // take at most 100 digits, and a precision past that is 100.
            let digits: String = chars[s..j].iter().collect();
            prec = Some(if digits.is_empty() { 0 } else { digits.parse::<usize>().map_or(MAX_PRECISION, |p| p.min(MAX_PRECISION)) });
        }
        if j >= chars.len() {
            // A dangling `%`: copied as written.
            out.extend(&chars[i..]);
            break;
        }
        match chars[j] {
            'f' | 'F' => out.push_str(&fmt_fixed(x, prec.unwrap_or(6))),
            'e' | 'E' => out.push_str(&fmt_exp(x, prec.unwrap_or(6))),
            'g' | 'G' => out.push_str(&fmt_general(x, prec.unwrap_or(6))),
            'd' | 'i' => out.push_str(&fmt_fixed(x, 0)),
            _ => out.extend(&chars[i..=j]),
        }
        i = j + 1;
    }
    out
}

/// The decimal number a literal writes — sign, significant digits, exponent —
/// so that `0.10` and `0.1` compare equal, and `1e2` and `100`; `None`
/// for text that is not a decimal literal.
fn decimal_of(s: &str) -> Option<(bool, String, i128)> {
    let (neg, rest) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let (mant, exp) = match rest.find(['e', 'E']) {
        Some(i) => (&rest[..i], Some(&rest[i + 1..])),
        None => (rest, None),
    };
    let (int, frac) = mant.split_once('.').unwrap_or((mant, ""));
    let is_digits = |t: &str| t.bytes().all(|b| b.is_ascii_digit());
    if !is_digits(int) || !is_digits(frac) || int.len() + frac.len() == 0 {
        return None;
    }
    let e: i128 = match exp {
        None => 0,
        Some(e) => {
            let (sign, d) = match e.as_bytes().first() {
                Some(b'-') => (-1, &e[1..]),
                Some(b'+') => (1, &e[1..]),
                _ => (1, e),
            };
            if d.is_empty() || !is_digits(d) {
                return None;
            }
            // Past any exponent a binary64 can be read back at, a value is no
            // longer told apart: saturate rather than overflow.
            sign * d.bytes().fold(0i128, |a, b| (a * 10 + i128::from(b - b'0')).min(1_000_000_000_000_000_000))
        }
    };
    let all = format!("{int}{frac}");
    let lead = all.trim_start_matches('0');
    if lead.is_empty() {
        return Some((false, "0".to_string(), 0));
    }
    let digits = lead.trim_end_matches('0');
    Some((neg, digits.to_string(), e - frac.len() as i128 + (lead.len() - digits.len()) as i128))
}

/// The binary digits of a YAML hexadecimal or octal literal, leading zeros
/// dropped; `None` for any other text.
fn radix_bits(s: &str) -> Option<String> {
    let (bits, digits) = if let Some(h) = s.strip_prefix("0x") { (4, h) } else { (3, s.strip_prefix("0o")?) };
    if digits.is_empty() {
        return None;
    }
    let mut out = String::new();
    for c in digits.chars() {
        let v = c.to_digit(if bits == 4 { 16 } else { 8 })?;
        out.push_str(&format!("{v:0bits$b}"));
    }
    Some(out.trim_start_matches('0').to_string())
}

/// The binary digits of an integral binary64, leading zeros dropped.
fn integer_bits(v: f64) -> Option<String> {
    if v.fract() != 0.0 || v < 0.0 {
        return None;
    }
    let b = v.to_bits();
    let exp = ((b >> 52) & 0x7ff) as i64;
    if exp == 0 {
        return Some(String::new()); // zero: an integral subnormal is zero
    }
    let mant = (b & ((1u64 << 52) - 1)) | (1u64 << 52);
    let shift = exp - 1075;
    let bits = if shift >= 0 { format!("{mant:b}{}", "0".repeat(shift as usize)) } else { format!("{:b}", mant >> (-shift)) };
    Some(bits.trim_start_matches('0').to_string())
}

/// §3.2: a number is its nearest binary64 value. When that value, written back
/// the shortest way, is not the number the literal wrote — an integer past
/// 2^53, more significant digits than binary64 holds, a magnitude below its
/// smallest — the text it reads back as; `None` when the literal is exact.
pub fn inexact_number(literal: &str, value: f64) -> Option<String> {
    if !value.is_finite() {
        return None;
    }
    let shown = es_string(value);
    if let Some(bits) = radix_bits(literal) {
        return (integer_bits(value) != Some(bits)).then_some(shown);
    }
    let written = decimal_of(literal)?;
    (Some(written) != decimal_of(&shown)).then_some(shown)
}

/// A number an engine read: its 0-based line, its literal and its value.
pub type NumberRead = (usize, String, f64);

/// What an inexact number reads as, and what to do about it.
pub fn inexact_message(literal: &str, shown: &str) -> String {
    format!("the number `{literal}` reads as `{shown}`: binary64 holds 15 to 17 significant digits, so a value this long belongs in a string")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecmascript_number_to_string() {
        assert_eq!(es_string(1.0), "1");
        assert_eq!(es_string(-0.0), "0");
        assert_eq!(es_string(0.1), "0.1");
        assert_eq!(es_string(1.5), "1.5");
        assert_eq!(es_string(100.0), "100");
        assert_eq!(es_string(12345678901234567890.0), "12345678901234567000");
        assert_eq!(es_string(1e21), "1e+21");
        assert_eq!(es_string(1.5e21), "1.5e+21");
        assert_eq!(es_string(1e-7), "1e-7");
        assert_eq!(es_string(1.25e-7), "1.25e-7");
        assert_eq!(es_string(0.000001), "0.000001");
        assert_eq!(es_string(-2.5), "-2.5");
        assert_eq!(es_string(f64::NAN), "NaN");
        assert_eq!(es_string(f64::INFINITY), "Infinity");
        assert_eq!(es_string(f64::NEG_INFINITY), "-Infinity");
    }

    #[test]
    fn bare_numbers() {
        for (s, v) in [("42", 42.0), ("-1", -1.0), ("+1", 1.0), ("1.5", 1.5), ("1.", 1.0), (".5", 0.5), ("1e3", 1000.0), ("1.5e-2", 0.015), ("007", 7.0)] {
            assert_eq!(parse_bare_number(s), Some(v), "{s}");
        }
        for s in ["0x10", "1e", "1_000", "Infinity", "", ".", "+", "1.2.3", "1e400", "e5", "1e+"] {
            assert_eq!(parse_bare_number(s), None, "{s}");
        }
    }

    #[test]
    fn printf_rounds_ties_away_on_the_exact_value() {
        assert_eq!(format_printf("%.2f", 0.125), "0.13");
        assert_eq!(format_printf("%.2f", -0.125), "-0.13");
        assert_eq!(format_printf("%.2f", 2.675), "2.67");
        assert_eq!(format_printf("%.2f", 0.375), "0.38");
        assert_eq!(format_printf("%d", 0.5), "1");
        assert_eq!(format_printf("%d", -2.5), "-3");
        assert_eq!(format_printf("%.0f", 2.5), "3");
        assert_eq!(format_printf("%.0f", 0.4), "0");
        assert_eq!(format_printf("%.3e", 1.0 / 3.0), "3.333e-01");
        assert_eq!(format_printf("%.0e", 25.0), "3e+01");
        assert_eq!(format_printf("%.0e", 1.0), "1e+00");
        assert_eq!(format_printf("%.3g", 1234.0), "1.23e+03");
        assert_eq!(format_printf("%.3g", 100.0), "100");
        assert_eq!(format_printf("%.2g", 100.0), "1e+02");
        assert_eq!(format_printf("%.3g", 0.00001234), "1.23e-05");
        assert_eq!(format_printf("%.3g", 1234.0 / 3.0), "411");
        assert_eq!(format_printf("%.3g", 0.0), "0");
        assert_eq!(format_printf("%.0g", 5.0), "5");
        assert_eq!(format_printf("%8.1f", 1.0 / 3.0), "0.3");
        assert_eq!(format_printf("%+08.1f", 1.0 / 3.0), "0.3");
        assert_eq!(format_printf("%.1f%%", 100.0 / 3.0), "33.3%");
        assert_eq!(format_printf("$%.2f", 9.995), "$9.99");
        assert_eq!(format_printf("%f", 1.5), "1.500000");
        assert_eq!(format_printf("%e", 1.5), "1.500000e+00");
        assert_eq!(format_printf("%g", 1.5), "1.5");
        assert_eq!(format_printf("%q", 1.5), "%q");
        assert_eq!(format_printf("%.", 1.5), "%.");
        assert_eq!(format_printf("%.2f", f64::INFINITY), "-");
        assert_eq!(format_printf("%.2f", 999.999), "1000.00");
        assert_eq!(format_printf("%.2f", 0.004), "0.00");
        assert_eq!(format_printf("%.1f", 0.05), "0.1");
        assert_eq!(format_printf("%.2f", 1e-300), "0.00");
        assert_eq!(format_printf("%.2f", 123456.0), "123456.00");
        assert_eq!(format_printf("%.2f", 1e22), "10000000000000000000000.00");
        assert_eq!(format_printf("%.1e", 9.96), "1.0e+01");
        assert_eq!(format_printf("%.2f", 0.0), "0.00");
        assert_eq!(format_printf("%.3g", -0.0), "-0");
    }

    #[test]
    fn display_is_twelve_significant_digits_then_shortest() {
        assert_eq!(display(1.0 / 3.0), "0.333333333333");
        assert_eq!(display(2.0 / 3.0), "0.666666666667");
        assert_eq!(display(1e21), "1e+21");
        assert_eq!(display(0.1 + 0.2), "0.3");
        assert_eq!(display(11.0), "11");
        assert_eq!(display(0.0), "0");
        assert_eq!(display(-5.5), "-5.5");
        assert_eq!(display(f64::NAN), "-");
    }
}
