// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Python 3.12's string semantics for the operations the encoder performs.
//!
//! The predicates and mappings read `tables.rs`, generated from the reference interpreter's Unicode database by
//! `python -m mailwoman_train.text.python_text_tables`. Rust's `char::is_whitespace`, `char::is_alphanumeric` and
//! `str::to_lowercase` follow a different Unicode version and different definitions: `is_alphanumeric` admits
//! `Other_Alphabetic` marks that Python's `isalnum` rejects, and Python's `isspace` admits U+001C..U+001F.

#[rustfmt::skip]
mod tables;

pub use tables::UNICODE_VERSION;

fn in_ranges(table: &[(u32, u32)], c: char) -> bool {
	let code = c as u32;
	table
		.binary_search_by(|&(start, end)| {
			if end < code {
				std::cmp::Ordering::Less
			} else if start > code {
				std::cmp::Ordering::Greater
			} else {
				std::cmp::Ordering::Equal
			}
		})
		.is_ok()
}

fn mapped(table: &'static [(u32, &'static str)], c: char) -> Option<&'static str> {
	table
		.binary_search_by_key(&(c as u32), |&(code, _)| code)
		.ok()
		.map(|i| table[i].1)
}

/// `str.isspace` for one character.
pub fn is_space(c: char) -> bool {
	in_ranges(tables::SPACE, c)
}

/// `str.isalnum` for one character.
pub fn is_alnum(c: char) -> bool {
	in_ranges(tables::ALNUM, c)
}

/// `str.isdecimal` for one character, which is also what `\d` matches in a `str` pattern.
pub fn is_decimal(c: char) -> bool {
	in_ranges(tables::DECIMAL, c)
}

/// What `\w` matches in a `str` pattern: an alphanumeric character or the underscore.
pub fn is_word(c: char) -> bool {
	c == '_' || is_alnum(c)
}

fn is_cased(c: char) -> bool {
	in_ranges(tables::CASED, c)
}

fn is_case_ignorable(c: char) -> bool {
	in_ranges(tables::CASE_IGNORABLE, c)
}

/// Whether the capital sigma at `i` is in the final-sigma context, by the rule of CPython's `handle_capital_sigma`.
fn is_final_sigma(text: &[char], i: usize) -> bool {
	let mut j = i;
	let before = loop {
		if j == 0 {
			break None;
		}
		j -= 1;
		if !is_case_ignorable(text[j]) {
			break Some(text[j]);
		}
	};
	let mut final_sigma = before.is_some_and(is_cased);
	if final_sigma && i + 1 < text.len() {
		let after = text[i + 1..].iter().copied().find(|&c| !is_case_ignorable(c));
		final_sigma = after.is_none_or(|c| !is_cased(c));
	}
	final_sigma
}

/// `str.lower`.
pub fn lower(text: &[char]) -> String {
	let mut out = String::with_capacity(text.len());
	for (i, &c) in text.iter().enumerate() {
		if c == '\u{3A3}' {
			out.push(if is_final_sigma(text, i) { '\u{3C2}' } else { '\u{3C3}' });
		} else if let Some(m) = mapped(tables::LOWER, c) {
			out.push_str(m);
		} else {
			out.push(c);
		}
	}
	out
}

/// `str.upper`.
pub fn upper(text: &[char]) -> String {
	let mut out = String::with_capacity(text.len());
	for &c in text {
		match mapped(tables::UPPER, c) {
			Some(m) => out.push_str(m),
			None => out.push(c),
		}
	}
	out
}

/// `str.strip()` with no argument, which removes leading and trailing `isspace` characters.
pub fn strip(text: &[char]) -> &[char] {
	let start = text.iter().position(|&c| !is_space(c)).unwrap_or(text.len());
	let end = text.iter().rposition(|&c| !is_space(c)).map_or(start, |i| i + 1);
	&text[start..end]
}

#[cfg(test)]
mod tests {
	use super::*;

	fn chars(s: &str) -> Vec<char> {
		s.chars().collect()
	}

	#[test]
	fn space_follows_python_rather_than_rust() {
		assert!(is_space('\u{1C}') && is_space('\u{1F}') && is_space('\u{A0}'));
		assert!(!is_space('\u{200B}'));
		assert!(!'\u{1C}'.is_whitespace());
	}

	#[test]
	fn alnum_rejects_a_spacing_vowel_sign() {
		// U+0940 DEVANAGARI VOWEL SIGN II is Mc: Rust calls it alphanumeric, Python's isalnum does not.
		assert!('\u{940}'.is_alphanumeric());
		assert!(!is_alnum('\u{940}'));
		assert!(is_alnum('\u{915}'));
	}

	#[test]
	fn decimal_covers_non_ascii_digits_only_in_nd() {
		assert!(is_decimal('٣') && is_decimal('7'));
		assert!(!is_decimal('²') && !is_decimal('Ⅳ'));
	}

	#[test]
	fn lower_applies_the_final_sigma_rule() {
		assert_eq!(lower(&chars("ΟΔΟΣ")), "οδος");
		assert_eq!(lower(&chars("ΟΔΟΣ Α")), "οδος α");
		assert_eq!(lower(&chars("ΣΑ")), "σα");
		assert_eq!(lower(&chars("Σ")), "σ");
		assert_eq!(lower(&chars("İ")), "i\u{307}");
	}

	#[test]
	fn upper_uses_full_mappings() {
		assert_eq!(upper(&chars("straße")), "STRASSE");
		assert_eq!(upper(&chars("ŉ")), "ʼN");
	}

	#[test]
	fn strip_removes_python_whitespace() {
		assert_eq!(strip(&chars("\u{1C} us\u{A0}")), &chars("us")[..]);
		assert_eq!(strip(&chars("  ")), &[] as &[char]);
	}
}
