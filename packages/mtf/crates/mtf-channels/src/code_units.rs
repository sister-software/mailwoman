// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The code-unit channel: per-piece shape features for each digit run or alphanumeric code.
//!
//! A code unit is a run of ASCII letters and digits that holds a digit, with a hyphen kept between two digits
//! (`10118-0110`, `SW1A`, `1-9-1`). A piece overlapping a unit carries five features of the unit, with
//! confidence 1:
//!
//! 1. 1.0, marking the piece as part of a unit;
//! 2. the unit's length, capped at `CODE_UNIT_MAX_LENGTH` and divided by it;
//! 3. the share of the unit's characters that are ASCII letters;
//! 4. 1.0 when the unit holds a hyphen;
//! 5. the number of countries whose postcode syntax accepts the unit, capped at `CODE_UNIT_MAX_ACCEPTING` and
//!    divided by it.
//!
//! The segmentation reproduces the Python pattern
//! `(?<![A-Za-z0-9])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9]+(?:-(?=\d)[A-Za-z0-9]+)*(?![A-Za-z0-9])`, where `\d` is any
//! decimal digit. The acceptance count needs the postcode-syntax patterns, which the `finders` feature compiles.

use crate::channel::{Channel, Piece};
use crate::python_text::is_decimal;

pub const CODE_UNIT_FEATURE_DIM: usize = 5;
pub const CODE_UNIT_MAX_LENGTH: usize = 12;
pub const CODE_UNIT_MAX_ACCEPTING: usize = 32;

/// One code unit: its character range in the row and the number of countries whose postcode syntax accepts it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodeUnit {
	pub start: usize,
	pub end: usize,
	pub accepting: usize,
}

fn ascii_alnum(c: char) -> bool {
	c.is_ascii_alphanumeric()
}

/// The `(start, end)` of every code unit in `text`, left to right.
pub fn segment(text: &[char]) -> Vec<(usize, usize)> {
	let mut out = Vec::new();
	let mut p = 0;
	while p < text.len() {
		if !ascii_alnum(text[p]) || (p > 0 && ascii_alnum(text[p - 1])) {
			p += 1;
			continue;
		}
		// The lookahead: the run of ASCII letters, digits and hyphens from `p` holds an ASCII digit, or is
		// followed by any decimal digit.
		let run_end = (p..text.len())
			.find(|&i| !(ascii_alnum(text[i]) || text[i] == '-'))
			.unwrap_or(text.len());
		let digit_ahead =
			text[p..run_end].iter().any(char::is_ascii_digit) || text.get(run_end).is_some_and(|&c| is_decimal(c));
		if !digit_ahead {
			p += 1;
			continue;
		}
		let mut end = (p..text.len()).find(|&i| !ascii_alnum(text[i])).unwrap_or(text.len());
		while end + 1 < text.len() && text[end] == '-' && text[end + 1].is_ascii_digit() {
			end = (end + 1..text.len())
				.find(|&i| !ascii_alnum(text[i]))
				.unwrap_or(text.len());
		}
		out.push((p, end));
		p = end;
	}
	out
}

/// The five features of one unit.
pub fn unit_features(text: &[char], unit: &CodeUnit) -> [f64; CODE_UNIT_FEATURE_DIM] {
	let surface = &text[unit.start..unit.end];
	let length = surface.len();
	let letters = surface.iter().filter(|c| c.is_ascii_alphabetic()).count();
	[
		1.0,
		length.min(CODE_UNIT_MAX_LENGTH) as f64 / CODE_UNIT_MAX_LENGTH as f64,
		letters as f64 / length as f64,
		if surface.contains(&'-') { 1.0 } else { 0.0 },
		unit.accepting.min(CODE_UNIT_MAX_ACCEPTING) as f64 / CODE_UNIT_MAX_ACCEPTING as f64,
	]
}

/// The channel over the pieces: each piece takes the first unit it overlaps.
pub fn channel(text: &[char], pieces: &[(usize, usize)], units: &[CodeUnit]) -> Channel {
	let mut out = Channel::zeros(CODE_UNIT_FEATURE_DIM, pieces.len());
	for (i, &(begin, end)) in pieces.iter().enumerate() {
		if let Some(unit) = units.iter().find(|u| begin < u.end && u.start < end) {
			out.set(i, &unit_features(text, unit), 1.0);
		}
	}
	out
}

/// The piece ranges of a row's pieces.
pub fn piece_ranges(pieces: &[Piece]) -> Vec<(usize, usize)> {
	pieces.iter().map(|p| (p.begin, p.end)).collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn units(s: &str) -> Vec<String> {
		let text: Vec<char> = s.chars().collect();
		segment(&text)
			.into_iter()
			.map(|(a, b)| text[a..b].iter().collect())
			.collect()
	}

	#[test]
	fn segments_digit_runs_codes_and_hyphenated_numbers() {
		assert_eq!(
			units("350 5th Ave, New York, NY 10118-0110"),
			["350", "5th", "10118-0110"]
		);
		assert_eq!(units("10 Downing St, London SW1A 2AA"), ["10", "SW1A", "2AA"]);
		assert_eq!(units("1-9-1 Marunouchi"), ["1-9-1"]);
	}

	#[test]
	fn a_letter_run_is_a_unit_when_a_digit_follows_its_hyphenated_run() {
		// The lookahead reads past the hyphen, so "AB" holds a digit ahead although "C1" stays apart.
		assert_eq!(units("AB-C1"), ["AB", "C1"]);
		assert_eq!(units("AB-CD"), Vec::<String>::new());
	}

	#[test]
	fn a_non_ascii_digit_after_the_run_satisfies_the_lookahead() {
		assert_eq!(units("AB٣"), ["AB"]);
		assert_eq!(units("12-٣"), ["12"]);
		assert_eq!(units("x12"), ["x12"]);
		assert_eq!(units("é12"), ["12"]);
	}
}
