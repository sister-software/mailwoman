// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from Planetiler 0.10.2's Parse and Imposm3Parsers (Apache-2.0, Copyright Michael Barry).

//! Tag value parsing with Planetiler's rules.

/// A number as Java's `NumberFormat` returns it: a `Long` when the parsed value is integral and fits, else a `Double`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Parsed {
	Long(i64),
	Double(f64),
}

/// `NumberFormat.getNumberInstance(Locale.ROOT).parse`: the longest leading run of an optional minus sign, digits
/// with optional comma grouping, and an optional decimal part. Returns `None` when no digit leads the text.
fn number_prefix(text: &str) -> Option<Parsed> {
	let bytes = text.as_bytes();
	let mut index = 0;
	let negative = bytes.first() == Some(&b'-');
	if negative {
		index += 1;
	}
	let mut digits = String::new();
	let mut seen_digit = false;
	while index < bytes.len() {
		match bytes[index] {
			b'0'..=b'9' => {
				digits.push(bytes[index] as char);
				seen_digit = true;
			}
			b',' if seen_digit && bytes.get(index + 1).is_some_and(u8::is_ascii_digit) => {}
			_ => break,
		}
		index += 1;
	}
	let mut fraction = String::new();
	if bytes.get(index) == Some(&b'.') && bytes.get(index + 1).is_some_and(u8::is_ascii_digit) {
		index += 1;
		while index < bytes.len() && bytes[index].is_ascii_digit() {
			fraction.push(bytes[index] as char);
			index += 1;
		}
	}
	if !seen_digit {
		return None;
	}
	let integral = fraction.trim_end_matches('0').is_empty();
	if integral {
		if let Ok(value) = digits.parse::<i64>() {
			return Some(Parsed::Long(if negative { -value } else { value }));
		}
	}
	let text = format!(
		"{}{}.{}",
		if negative { "-" } else { "" },
		digits,
		if fraction.is_empty() { "0" } else { &fraction }
	);
	text.parse::<f64>().ok().map(Parsed::Double)
}

/// `Parse.parseIntOrNull`: Java's `Integer.parseInt`, else the leading number truncated to an `int` as Java's
/// `Number.intValue` does, else `None`.
pub fn parse_int_or_null(text: Option<&str>) -> Option<i32> {
	let text = text?;
	if let Ok(value) = text.parse::<i32>() {
		// Rust accepts a leading '+' as Java's parseInt does.
		return Some(value);
	}
	match number_prefix(text)? {
		Parsed::Long(value) => Some(value as i32),
		Parsed::Double(value) => Some(value as i32),
	}
}

/// `Parse.parseLong`: the value as a long, or 0 when it is missing or not a number.
pub fn parse_long(text: Option<&str>) -> i64 {
	let Some(text) = text else {
		return 0;
	};
	if let Ok(value) = text.parse::<i64>() {
		return value;
	}
	match number_prefix(text) {
		Some(Parsed::Long(value)) => value,
		Some(Parsed::Double(value)) => value as i64,
		None => 0,
	}
}

/// `Parse.bool`: false for a missing value, "", "0", "false" or "no", true otherwise.
pub fn bool(text: Option<&str>) -> bool {
	!matches!(text, None | Some("" | "0" | "false" | "no"))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn integers_fall_back_to_the_leading_number() {
		assert_eq!(parse_int_or_null(Some("-1")), Some(-1));
		assert_eq!(parse_int_or_null(Some("+2")), Some(2));
		assert_eq!(parse_int_or_null(Some("3;4")), Some(3));
		assert_eq!(parse_int_or_null(Some("1.9")), Some(1));
		assert_eq!(parse_int_or_null(Some("1,000")), Some(1000));
		assert_eq!(parse_int_or_null(Some("ground")), None);
		assert_eq!(parse_int_or_null(None), None);
		assert_eq!(parse_long(Some("12m")), 12);
		assert!(bool(Some("yes")) && !bool(Some("no")) && !bool(Some("")) && !bool(None));
	}
}
