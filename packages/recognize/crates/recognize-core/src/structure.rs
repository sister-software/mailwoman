// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The `structure` pass: the engine's second half of the structural fields, after the two partitions have split the text.
//!
//! The partitions of [`crate::grammars::structure`] find the tokens and the segments. This module adds what no automaton
//! computes:
//!
//! * The class and the script of each token. The class is the set of the classes of the token's codepoints folded to one
//!   value. The script is the one the most codepoints have, and a tie goes to the script that appeared first. Both read
//!   the tables in [`crate::charset`] that the grammar's classes come from.
//! * The separator before each segment, which is the last separator the scan passed.
//! * The region abbreviations, which join the tokens and the segments: an uppercase two-letter token in a segment that a
//!   comma or a semicolon precedes, when the text has more than one segment.
//! * The script counts of the whole text, from which the caller ranks the scripts.
//!
//! Every value matches `computeQueryShape` of `@mailwoman/query-shape`, quirks included. The differential tests compare
//! the two.

use crate::charset::{class_of, script_at, CharClass, Script, SCRIPTS};
use crate::declared::structure::RecognitionKind;
use crate::declared::Kind;
use crate::engine::{Engine, SearchError};
use crate::grammars::structure::{SEGMENT, TOKEN};

/// The class of one token, as `TokenCharacterClass` names it. The discriminant is the code a result record carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum TokenClass {
	Digit = 0,
	Alpha = 1,
	Mixed = 2,
	Punct = 3,
	Cjk = 4,
	Cyrillic = 5,
	Arabic = 6,
}

/// The separator before a segment. The discriminant is the code a result record carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Separator {
	/// The first segment has no separator before it.
	None = 0,
	/// A comma or a semicolon.
	Comma = 1,
	Newline = 2,
	Tab = 3,
}

/// One token: a UTF-8 byte range, its class and its script.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Token {
	pub start: u32,
	pub end: u32,
	pub class: TokenClass,
	pub script: Script,
}

/// One segment: a UTF-8 byte range that excludes the white space around it, and the separator before it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Segment {
	pub start: u32,
	pub end: u32,
	pub separator: Separator,
}

/// The structural fields of one text. The vectors are reused across calls.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Structure {
	pub tokens: Vec<Token>,
	pub segments: Vec<Segment>,
	/// The position among the tokens of each region abbreviation, in order.
	pub regions: Vec<u32>,
	/// The number of codepoints of each script, in the order of [`Script`]. `Zyyy` is always zero, because the legacy
	/// count skips it.
	pub scripts: [u32; SCRIPTS],
}

/// Folds the classes of a token's codepoints to the token's class, in the legacy order: a CJK, Cyrillic or Arabic
/// codepoint decides first, then a digit with a letter is mixed, then a digit, a letter, punctuation, and anything else
/// is mixed.
fn token_class(digit: bool, alpha: bool, cjk: bool, cyrillic: bool, arabic: bool, punct: bool) -> TokenClass {
	if cjk {
		TokenClass::Cjk
	} else if cyrillic {
		TokenClass::Cyrillic
	} else if arabic {
		TokenClass::Arabic
	} else if digit && alpha {
		TokenClass::Mixed
	} else if digit {
		TokenClass::Digit
	} else if alpha {
		TokenClass::Alpha
	} else if punct {
		TokenClass::Punct
	} else {
		TokenClass::Mixed
	}
}

/// The class and the script of one token, and the script counts of its codepoints added to `totals`.
fn describe(piece: &str, totals: &mut [u32; SCRIPTS]) -> (TokenClass, Script) {
	let (mut digit, mut alpha, mut cjk, mut cyrillic, mut arabic, mut punct) =
		(false, false, false, false, false, false);
	let mut counts = [0u32; SCRIPTS];
	// The scripts in the order each first appeared, so a tie goes to the earliest.
	let mut order = [Script::Zyyy; SCRIPTS];
	let mut seen = 0;

	for character in piece.chars() {
		match class_of(character) {
			CharClass::Digit => digit = true,
			CharClass::Alpha => alpha = true,
			CharClass::Cjk => cjk = true,
			CharClass::Cyrillic => cyrillic = true,
			CharClass::Arabic => arabic = true,
			CharClass::Punct => punct = true,
			CharClass::Whitespace | CharClass::Connector | CharClass::Other => {}
		}

		let script = script_at(character);

		if script == Script::Zyyy {
			continue;
		}

		if counts[script as usize] == 0 {
			order[seen] = script;
			seen += 1;
		}

		counts[script as usize] += 1;
		totals[script as usize] += 1;
	}

	let mut best = Script::Zyyy;
	let mut best_count = 0;

	for script in &order[..seen] {
		if counts[*script as usize] > best_count {
			best = *script;
			best_count = counts[*script as usize];
		}
	}

	(token_class(digit, alpha, cjk, cyrillic, arabic, punct), best)
}

/// Whether a token's text is the shape of a region abbreviation: two uppercase ASCII letters.
fn is_region_abbreviation(piece: &str) -> bool {
	matches!(piece.as_bytes(), [first, second] if first.is_ascii_uppercase() && second.is_ascii_uppercase())
}

/// Finds the region abbreviations among the tokens: for each segment that a comma precedes, the tokens inside it that are
/// class `alpha` and two uppercase letters. Fewer than two segments have none.
///
/// The walk keeps one pointer into the tokens, as the legacy walk does, and stops at the first token that ends past
/// the segment. A token that a trimmed space reaches into can end past it, so the stop is not a skip.
fn region_abbreviations(text: &str, tokens: &[Token], segments: &[Segment], out: &mut Vec<u32>) {
	if segments.len() < 2 {
		return;
	}

	let mut next = 0;

	for segment in segments {
		while next < tokens.len() && tokens[next].start < segment.start {
			next += 1;
		}

		if segment.separator != Separator::Comma {
			continue;
		}

		let mut position = next;

		while position < tokens.len() && tokens[position].end <= segment.end {
			let token = &tokens[position];

			if token.class == TokenClass::Alpha
				&& is_region_abbreviation(&text[token.start as usize..token.end as usize])
			{
				out.push(position as u32);
			}

			position += 1;
		}
	}
}

impl Engine {
	/// Computes the structural fields of `text` with the `structure` family at position `family` in load order.
	///
	/// Fails when the text is longer than the family admits, or the family declares no `token` and `segment` partitions.
	pub fn structure(&self, family: usize, text: &str, out: &mut Structure) -> Result<(), SearchError> {
		out.tokens.clear();
		out.segments.clear();
		out.regions.clear();
		out.scripts = [0; SCRIPTS];

		let Structure {
			tokens,
			segments,
			scripts,
			..
		} = out;

		self.scan(family, TOKEN, text, |_, kind, start, end| {
			let Some(Kind::Structure(kind)) = kind else { return };

			if kind == RecognitionKind::TokenSkip {
				return;
			}

			let (class, script) = describe(&text[start..end], scripts);

			tokens.push(Token {
				start: start as u32,
				end: end as u32,
				class,
				script,
			});
		})?;

		let mut separator = Separator::None;

		self.scan(family, SEGMENT, text, |_, kind, start, end| {
			let Some(Kind::Structure(kind)) = kind else { return };

			match kind {
				RecognitionKind::SegmentComma => separator = Separator::Comma,
				RecognitionKind::SegmentNewline => separator = Separator::Newline,
				RecognitionKind::SegmentTab => separator = Separator::Tab,
				RecognitionKind::SegmentText => segments.push(Segment {
					start: start as u32,
					end: end as u32,
					separator,
				}),
				_ => {}
			}
		})?;

		region_abbreviations(text, &out.tokens, &out.segments, &mut out.regions);

		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn describe_alone(piece: &str) -> (TokenClass, Script, [u32; SCRIPTS]) {
		let mut totals = [0; SCRIPTS];
		let (class, script) = describe(piece, &mut totals);

		(class, script, totals)
	}

	#[test]
	fn a_tie_between_scripts_goes_to_the_one_seen_first() {
		// The legacy token rule is first-seen-wins on a tie, so `北a` is Han and `a北` is Latin.
		assert_eq!(describe_alone("北a").1, Script::Hani);
		assert_eq!(describe_alone("a北").1, Script::Latn);
	}

	#[test]
	fn a_token_with_no_known_class_is_mixed_and_its_script_is_unknown() {
		let (class, script, totals) = describe_alone("Αθήνα");

		assert_eq!((class, script), (TokenClass::Mixed, Script::Zzzz));
		assert_eq!(totals[Script::Zzzz as usize], 5);
	}

	#[test]
	fn region_abbreviations_are_two_uppercase_ascii_letters() {
		assert!(is_region_abbreviation("NY"));
		assert!(!is_region_abbreviation("Ny"));
		assert!(!is_region_abbreviation("NYC"));
		assert!(!is_region_abbreviation("Ñ"));
	}
}
