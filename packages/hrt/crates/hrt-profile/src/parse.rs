// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from Planetiler 0.10.2's Parse and Imposm3Parsers (Apache-2.0, Copyright Michael Barry).

//! Tag value parsing with Planetiler's rules.

/// A number as Java's `NumberFormat` returns it: a `Long` when the parsed value is integral and fits, else a `Double`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Parsed {
	Long(i64),
	Double(f64),
}

/// The first code point of each run of ten that Java's `Character.digit(c, 10)` reads as 0 to 9, from JDK 21.
/// `DecimalFormat` reads text one UTF-16 code unit at a time, so digits outside the Basic Multilingual Plane, whose
/// code units are surrogates, are not digits to it.
const DIGIT_ZEROS: [u32; 37] = [
	0x0030, 0x0660, 0x06F0, 0x07C0, 0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6, 0x0C66, 0x0CE6, 0x0D66, 0x0DE6,
	0x0E50, 0x0ED0, 0x0F20, 0x1040, 0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0x1A80, 0x1A90, 0x1B50, 0x1BB0, 0x1C40,
	0x1C50, 0xA620, 0xA8D0, 0xA900, 0xA9D0, 0xA9F0, 0xAA50, 0xABF0, 0xFF10,
];

/// The value `DecimalFormat` gives `c` as a digit: an ASCII digit, or a decimal digit of another script, such as the
/// fullwidth `２` Japanese tags use.
fn java_digit(c: char) -> Option<char> {
	let code = c as u32;
	DIGIT_ZEROS
		.iter()
		.find(|&&zero| (zero..zero + 10).contains(&code))
		.and_then(|&zero| char::from_digit(code - zero, 10))
}

/// `NumberFormat.getNumberInstance(Locale.ROOT).parse`: the longest leading run of an optional minus sign, digits
/// with optional comma grouping, and an optional decimal part. Returns `None` when no digit leads the text.
fn number_prefix(text: &str) -> Option<Parsed> {
	let chars: Vec<char> = text.chars().collect();
	let is_digit = |index: usize| chars.get(index).is_some_and(|&c| java_digit(c).is_some());
	let mut index = 0;
	let negative = chars.first() == Some(&'-');
	if negative {
		index += 1;
	}
	let mut digits = String::new();
	let mut seen_digit = false;
	while index < chars.len() {
		if let Some(digit) = java_digit(chars[index]) {
			digits.push(digit);
			seen_digit = true;
		} else if !(chars[index] == ',' && seen_digit && is_digit(index + 1)) {
			break;
		}
		index += 1;
	}
	let mut fraction = String::new();
	if chars.get(index) == Some(&'.') && is_digit(index + 1) {
		index += 1;
		while let Some(digit) = chars.get(index).and_then(|&c| java_digit(c)) {
			fraction.push(digit);
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

/// Java's `Double.parseDouble` for decimal text: characters up to U+0020 trimmed from both ends, an optional sign,
/// `NaN` or `Infinity` exactly, or digits with an optional fraction and exponent and an optional `d` or `f` suffix.
/// Java also reads hexadecimal floats; this returns `None` for them, and the caller's prefix parse then reads the
/// leading `0`.
fn java_parse_double(text: &str) -> Option<f64> {
	let text = text.trim_matches(|c: char| c <= ' ');
	let (negative, body) = match text.as_bytes().first() {
		Some(b'-') => (true, &text[1..]),
		Some(b'+') => (false, &text[1..]),
		_ => (false, text),
	};
	let signed = |value: f64| if negative { -value } else { value };
	match body {
		"NaN" => return Some(f64::NAN),
		"Infinity" => return Some(signed(f64::INFINITY)),
		_ => {}
	}
	let body = body.strip_suffix(['d', 'D', 'f', 'F']).unwrap_or(body);
	let bytes = body.as_bytes();
	let mut index = 0;
	let mut digits = 0;
	while index < bytes.len() && bytes[index].is_ascii_digit() {
		index += 1;
		digits += 1;
	}
	if bytes.get(index) == Some(&b'.') {
		index += 1;
		while index < bytes.len() && bytes[index].is_ascii_digit() {
			index += 1;
			digits += 1;
		}
	}
	if digits == 0 {
		return None;
	}
	if matches!(bytes.get(index), Some(b'e' | b'E')) {
		index += 1;
		if matches!(bytes.get(index), Some(b'+' | b'-')) {
			index += 1;
		}
		let start = index;
		while index < bytes.len() && bytes[index].is_ascii_digit() {
			index += 1;
		}
		if index == start {
			return None;
		}
	}
	if index != bytes.len() {
		return None;
	}
	body.parse::<f64>().ok().map(signed)
}

/// How far Java's `NumberFormat.getInstance().parse(text, position)` advances, in UTF-16 code units, for an
/// English-locale format: an optional minus sign, digits with `,` grouping between digits, one `.` decimal separator,
/// and an exponent of `E`, an optional sign and digits. Digits are those `java_digit` reads. Text that starts with no
/// digit leaves the position at 0.
pub fn number_format_parse_length(text: &str) -> usize {
	let chars: Vec<char> = text.chars().collect();
	let is_digit = |index: usize| chars.get(index).is_some_and(|&c| java_digit(c).is_some());
	let mut index = usize::from(chars.first() == Some(&'-'));
	let mut saw_digit = false;
	let mut saw_decimal = false;
	while index < chars.len() {
		match chars[index] {
			c if java_digit(c).is_some() => saw_digit = true,
			',' if !saw_decimal && saw_digit && is_digit(index + 1) => {}
			'.' if !saw_decimal => saw_decimal = true,
			'E' if saw_digit => {
				let mut exponent = index + 1;
				if matches!(chars.get(exponent), Some('+' | '-')) {
					exponent += 1;
				}
				let digits = (exponent..chars.len()).take_while(|&i| is_digit(i)).count();
				if digits > 0 {
					index = exponent + digits;
				}
				break;
			}
			_ => break,
		}
		index += 1;
	}
	if saw_digit {
		// Every character consumed is in the Basic Multilingual Plane, so the character count is the UTF-16 count.
		index
	} else {
		0
	}
}

/// Java's `Double.parseDouble`, with `None` where Java throws `NumberFormatException`.
pub fn parse_double(text: &str) -> Option<f64> {
	java_parse_double(text)
}

/// `Parse.parseDoubleOrNull`: Java's `Double.parseDouble`, else the leading number, else `None`.
pub fn parse_double_or_null(text: Option<&str>) -> Option<f64> {
	let text = text?;
	if let Some(value) = java_parse_double(text) {
		return Some(value);
	}
	match number_prefix(text)? {
		Parsed::Long(value) => Some(value as f64),
		Parsed::Double(value) => Some(value),
	}
}

static DISTANCE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
	regex::Regex::new(
		r#"(?i)(?<value>-?[\d.]+)\s*((?<mi>mi)|(?<m>m|$)|(?<km>km|kilom)|(?<ft>ft|')|(?<in>in|")|(?<nmi>nmi|international nautical mile|nautical))"#,
	)
	.unwrap()
});

/// `Parse.meters`: a length with an optional unit (m, km, mi, nmi, ft or ', in or "), in meters; a bare number is
/// meters, and a value such as 15'3" adds the inches.
pub fn meters(text: Option<&str>) -> Option<f64> {
	let text = text?;
	let mut matches = DISTANCE.captures_iter(text);
	let first = matches.next()?;
	let mut value: f64 = first.name("value")?.as_str().parse().ok()?;
	if first.name("m").is_some() {
	} else if first.name("km").is_some() {
		value *= 1000.0;
	} else if first.name("mi").is_some() {
		value *= 1609.344;
	} else if first.name("nmi").is_some() {
		value *= 1852.0;
	} else if first.name("ft").is_some() {
		value *= 12.0 * 0.0254;
		if let Some(next) = matches.next() {
			if next.name("in").is_some() {
				value += next.name("value")?.as_str().parse::<f64>().ok()? * 0.0254;
			}
		}
	} else if first.name("in").is_some() {
		value *= 0.0254;
	} else {
		return None;
	}
	Some(value)
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

	#[test]
	fn doubles_follow_java_then_the_leading_number() {
		assert_eq!(parse_double_or_null(Some(" 1.5e3 ")), Some(1500.0));
		assert_eq!(parse_double_or_null(Some("-2d")), Some(-2.0));
		assert_eq!(parse_double_or_null(Some(".5")), Some(0.5));
		assert_eq!(parse_double_or_null(Some("12 MW")), Some(12.0));
		assert!(parse_double_or_null(Some("NaN")).is_some_and(f64::is_nan));
		assert_eq!(parse_double_or_null(Some("inf")), None);
		assert_eq!(parse_double_or_null(Some("about")), None);
	}

	#[test]
	fn the_leading_number_reads_digits_of_every_script_java_does() {
		// JDK 21's NumberFormat.getNumberInstance(Locale.ROOT) parses these to 2, 12, 12, 1200, -3.5 and an error.
		assert_eq!(parse_double_or_null(Some("２（店舗スペース）")), Some(2.0));
		assert_eq!(parse_int_or_null(Some("１２")), Some(12));
		assert_eq!(parse_double_or_null(Some("١٢٫٥")), Some(12.0));
		assert_eq!(parse_long(Some("1,２00")), 1200);
		assert_eq!(parse_double_or_null(Some("-３.５x")), Some(-3.5));
		assert_eq!(parse_double_or_null(Some("Ⅻ")), None);
		assert_eq!(number_format_parse_length("１２Ｆ"), 2);
		// A digit outside the Basic Multilingual Plane is two UTF-16 code units Java does not read as a digit.
		assert_eq!(number_format_parse_length("\u{1D7CE}"), 0);
	}

	#[test]
	fn lengths_convert_to_meters() {
		assert_eq!(meters(Some("3.5")), Some(3.5));
		assert_eq!(meters(Some("2 km")), Some(2000.0));
		// Java's `value *= 12 * 0.0254` multiplies by the product, which rounds differently from multiplying left to right.
		assert_eq!(meters(Some("10 ft")), Some(10.0 * (12.0 * 0.0254)));
		assert_eq!(meters(Some("5'6\"")), Some(5.0 * (12.0 * 0.0254) + 6.0 * 0.0254));
		assert_eq!(meters(Some("wide")), None);
	}
}
