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

/// The code points a character maps to in `table`, or `None` when it maps to itself.
fn mapped(table: &'static [(u32, &'static [u32])], c: char) -> Option<&'static [u32]> {
	table
		.binary_search_by_key(&(c as u32), |&(code, _)| code)
		.ok()
		.map(|i| table[i].1)
}

fn push_code_points(out: &mut String, code_points: &[u32]) {
	out.extend(
		code_points
			.iter()
			.map(|&code| char::from_u32(code).expect("the generated tables hold scalar values only")),
	);
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

/// `str.isalpha` for one character.
pub fn is_alpha(c: char) -> bool {
	in_ranges(tables::ALPHA, c)
}

/// `str.isdigit` for one character, which admits superscripts and other `Numeric_Type=Digit` characters that
/// `str.isdecimal` rejects.
pub fn is_digit(c: char) -> bool {
	in_ranges(tables::DIGIT, c)
}

/// Whether `unicodedata.name(c)` starts with `CJK UNIFIED`, `HIRAGANA`, `KATAKANA` or `HANGUL`.
pub fn is_cjk_named(c: char) -> bool {
	in_ranges(tables::CJK_NAMED, c)
}

/// The script blocks the tokenizer's byte-fallback report names, in the generator's `SCRIPT_NAME_PREFIXES` order.
pub const SCRIPT_BLOCKS: [&str; 9] = [
	"latin",
	"cjk",
	"cyrillic",
	"armenian",
	"arabic",
	"greek",
	"hebrew",
	"devanagari",
	"thai",
];

/// Whether the byte-fallback report skips the character: `str.isspace`, or a `unicodedata.category` starting with
/// `N`, `P`, `Z` or `S`.
pub fn is_script_skipped(c: char) -> bool {
	in_ranges(tables::SCRIPT_SKIPPED, c)
}

/// The [`SCRIPT_BLOCKS`] entry whose name prefix `unicodedata.name(c)` starts with, or `None` for a character with no
/// name or another name.
pub fn script_block(c: char) -> Option<&'static str> {
	let code = c as u32;
	tables::SCRIPT_BLOCK
		.binary_search_by(|&(start, end, _)| {
			if end < code {
				std::cmp::Ordering::Less
			} else if start > code {
				std::cmp::Ordering::Greater
			} else {
				std::cmp::Ordering::Equal
			}
		})
		.ok()
		.map(|i| SCRIPT_BLOCKS[tables::SCRIPT_BLOCK[i].2 as usize])
}

/// The writing systems [`letter_script`] names, in the generator's `LETTER_SCRIPTS` order.
pub const LETTER_SCRIPTS: [&str; 26] = [
	"Latin",
	"Han",
	"Hiragana",
	"Katakana",
	"Hangul",
	"Cyrillic",
	"Arabic",
	"Hebrew",
	"Greek",
	"Devanagari",
	"Thai",
	"Armenian",
	"Georgian",
	"Ethiopic",
	"Bengali",
	"Gurmukhi",
	"Gujarati",
	"Tamil",
	"Telugu",
	"Kannada",
	"Malayalam",
	"Sinhala",
	"Khmer",
	"Lao",
	"Myanmar",
	"Other",
];

/// The writing system of a letter, as the mixed-script audit's `character_script` named it, or `None` for a
/// character whose category is not a letter.
pub fn letter_script(c: char) -> Option<&'static str> {
	let code = c as u32;
	tables::LETTER_SCRIPT
		.binary_search_by(|&(start, end, _)| {
			if end < code {
				std::cmp::Ordering::Less
			} else if start > code {
				std::cmp::Ordering::Greater
			} else {
				std::cmp::Ordering::Equal
			}
		})
		.ok()
		.map(|i| LETTER_SCRIPTS[tables::LETTER_SCRIPT[i].2 as usize])
}

/// The consecutive runs of letter scripts in `text`, with every character that is not a letter skipped.
pub fn script_runs(text: &str) -> Vec<&'static str> {
	let mut runs: Vec<&'static str> = Vec::new();
	for script in text.chars().filter_map(letter_script) {
		if runs.last() != Some(&script) {
			runs.push(script);
		}
	}
	runs
}

/// The exposure phenomena's coarse script tag for a string: a [`SCRIPT_BLOCKS`] entry, `mixed` or `other`.
///
/// Characters [`is_script_skipped`] admits are not counted. A block holding 90% or more of the counted characters
/// is the string's tag. A character no block names counts as `other`.
pub fn detect_script(text: &str) -> &'static str {
	let mut counts: Vec<(&'static str, usize)> = Vec::new();
	for c in text.chars().filter(|&c| !is_script_skipped(c)) {
		let block = script_block(c).unwrap_or("other");
		match counts.iter_mut().find(|(name, _)| *name == block) {
			Some((_, n)) => *n += 1,
			None => counts.push((block, 1)),
		}
	}
	let total: usize = counts.iter().map(|(_, n)| n).sum();
	match counts.as_slice() {
		[] => "other",
		[(only, _)] => only,
		_ => {
			// `Counter.most_common(1)`: the largest count, the first counted among equals.
			let (top, n) = counts
				.iter()
				.fold(counts[0], |best, &entry| if entry.1 > best.1 { entry } else { best });
			if n as f64 / total as f64 >= 0.9 {
				top
			} else {
				"mixed"
			}
		}
	}
}

/// Whether `text` holds a letter and every letter it holds is Latin script, by Unicode name, as the trainer's
/// `address_systems.is_latin_text` reads it.
pub fn is_latin_text(text: &str) -> bool {
	let mut letters = text.chars().filter(|&c| is_alpha(c)).peekable();
	letters.peek().is_some() && letters.all(|c| script_block(c) == Some("latin"))
}

/// `str.casefold`.
pub fn casefold(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	for c in text.chars() {
		match mapped(tables::CASEFOLD, c) {
			Some(code_points) => push_code_points(&mut out, code_points),
			None => out.push(c),
		}
	}
	out
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
			push_code_points(&mut out, m);
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
			Some(m) => push_code_points(&mut out, m),
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
	fn decimal_covers_only_the_decimal_number_category() {
		assert!(is_decimal('٣') && is_decimal('7'));
		assert!(!is_decimal('²') && !is_decimal('Ⅳ'));
	}

	#[test]
	fn alpha_digit_and_cjk_names_follow_python() {
		assert!(is_alpha('é') && is_alpha('ア') && !is_alpha('1') && !is_alpha('\u{940}'));
		assert!(is_digit('²') && is_digit('7') && !is_decimal('²') && !is_digit('Ⅳ'));
		assert!(is_cjk_named('東') && is_cjk_named('あ') && is_cjk_named('ー') && is_cjk_named('한'));
		assert!(!is_cjk_named('ｱ') && !is_cjk_named('「') && !is_cjk_named('A'));
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
