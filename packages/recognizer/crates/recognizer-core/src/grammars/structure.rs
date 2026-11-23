// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The `structure` family: the two partitions that split a text into tokens and into segments, at parity with
//! `@mailwoman/query-shape`.
//!
//! # Tokens
//!
//! The legacy tokenizer skips whitespace, punctuation and connectors where a token could start, and starts a token at
//! any other character. The first character's class decides what the token may contain, and the token runs until
//! whitespace, punctuation, or a character that the first character's class does not admit. Connectors stay inside the
//! token.
//!
//! * A Latin letter or a digit starts a token that continues over Latin letters, digits and connectors.
//! * A CJK, Cyrillic or Arabic character starts a token that continues over its own class and connectors.
//! * Any other character starts a token that continues over its own class, Latin letters, digits and connectors.
//!
//! Each rule is regular, so each is one shape of the `token` partition. The partition takes the longest match at each
//! position, which is the legacy loop's token, because every prefix of a token is itself a match. A run of skipped
//! characters is one `token.skip` piece.
//!
//! The class of a token and its script are not regular: a script is the majority of the codepoints' scripts, with a tie
//! decided by the first script to appear. The engine's structure pass computes both for each token from the tables in
//! `charset`, which also build this grammar's classes.
//!
//! # Segments
//!
//! The legacy splitter breaks at a comma, a semicolon, a line feed and a tab, then trims the JavaScript `\s` set from
//! each piece and drops a piece that is empty after the trim. The `segment` partition expresses that: a separator is a
//! piece, a run of the other white space is a piece, and a text piece runs from the first character that is neither to
//! the last such character before the next separator. The separator before a segment is the engine's state: the
//! structure pass carries the last separator it saw.

use crate::ast::{choice, class, negated_class, one_or_more, reference, sequence, zero_or_more};
use crate::charset::{
	Range, ALPHA, ARABIC, CJK, CONNECTOR, CYRILLIC, DIGIT, JS_WHITESPACE, PUNCT, SEGMENT_COMMA, SEGMENT_NEWLINE,
	SEGMENT_TAB, WHITESPACE,
};
use crate::family::{shape, term, Family};

pub const FAMILY: &str = "structure";

/// The partition of tokens.
pub const TOKEN: &str = "token";

/// The partition of segments.
pub const SEGMENT: &str = "segment";

fn chars(ranges: &[Range]) -> Vec<(char, char)> {
	ranges
		.iter()
		.map(|&(low, high)| {
			(
				char::from_u32(low).expect("a declared range starts on a scalar value"),
				char::from_u32(high).expect("a declared range ends on a scalar value"),
			)
		})
		.collect()
}

fn union(sets: &[&[Range]]) -> Vec<(char, char)> {
	chars(&sets.iter().flat_map(|set| set.iter().copied()).collect::<Vec<Range>>())
}

/// The ranges without the codepoints in `removed`, which may split a range.
fn without(ranges: &[Range], removed: &[u32]) -> Vec<Range> {
	let mut out = ranges.to_vec();

	for cp in removed {
		out = out
			.into_iter()
			.flat_map(|(low, high)| {
				if (low..=high).contains(cp) {
					let mut parts = Vec::new();

					if low < *cp {
						parts.push((low, cp - 1));
					}

					if *cp < high {
						parts.push((cp + 1, high));
					}

					parts
				} else {
					vec![(low, high)]
				}
			})
			.collect();
	}

	out
}

/// Builds the family. The grammars are valid by construction, and the module's tests hold that.
pub fn family() -> Family {
	let latin = union(&[DIGIT, ALPHA]);
	let every_class = union(&[DIGIT, ALPHA, WHITESPACE, CONNECTOR, PUNCT, CJK, CYRILLIC, ARABIC]);
	let separators = union(&[SEGMENT_COMMA, SEGMENT_NEWLINE, SEGMENT_TAB]);
	let inner_space = chars(&without(JS_WHITESPACE, &[0x09, 0x0a]));
	let space_and_separators = union(&[JS_WHITESPACE, SEGMENT_COMMA]);

	Family::new(FAMILY)
		.term(term("alphanumeric", class(&latin)))
		.term(term("arabic", class(&chars(ARABIC))))
		.term(term("boundary", class(&union(&[WHITESPACE, PUNCT]))))
		.term(term("cjk", class(&chars(CJK))))
		.term(term("connector", class(&chars(CONNECTOR))))
		.term(term("cyrillic", class(&chars(CYRILLIC))))
		.term(term("other", negated_class(&every_class)))
		.term(term("segment_character", negated_class(&space_and_separators)))
		.term(term("segment_inner", negated_class(&separators)))
		.term(term("separator_comma", class(&chars(SEGMENT_COMMA))))
		.term(term("separator_newline", class(&chars(SEGMENT_NEWLINE))))
		.term(term("separator_tab", class(&chars(SEGMENT_TAB))))
		.term(term("space", class(&inner_space)))
		.shape(
			shape("token.skip")
				.grammar(one_or_more(choice([reference("boundary"), reference("connector")])))
				.partition(TOKEN),
		)
		.shape(
			shape("token.latin")
				.grammar(sequence([
					reference("alphanumeric"),
					zero_or_more(choice([reference("alphanumeric"), reference("connector")])),
				]))
				.partition(TOKEN),
		)
		.shape(
			shape("token.cjk")
				.grammar(sequence([
					reference("cjk"),
					zero_or_more(choice([reference("cjk"), reference("connector")])),
				]))
				.partition(TOKEN),
		)
		.shape(
			shape("token.cyrillic")
				.grammar(sequence([
					reference("cyrillic"),
					zero_or_more(choice([reference("cyrillic"), reference("connector")])),
				]))
				.partition(TOKEN),
		)
		.shape(
			shape("token.arabic")
				.grammar(sequence([
					reference("arabic"),
					zero_or_more(choice([reference("arabic"), reference("connector")])),
				]))
				.partition(TOKEN),
		)
		.shape(
			shape("token.other")
				.grammar(sequence([
					reference("other"),
					zero_or_more(choice([
						reference("other"),
						reference("alphanumeric"),
						reference("connector"),
					])),
				]))
				.partition(TOKEN),
		)
		.shape(
			shape("segment.comma")
				.grammar(reference("separator_comma"))
				.partition(SEGMENT),
		)
		.shape(
			shape("segment.newline")
				.grammar(reference("separator_newline"))
				.partition(SEGMENT),
		)
		.shape(
			shape("segment.tab")
				.grammar(reference("separator_tab"))
				.partition(SEGMENT),
		)
		.shape(
			shape("segment.space")
				.grammar(one_or_more(reference("space")))
				.partition(SEGMENT),
		)
		.shape(
			shape("segment.text")
				.grammar(sequence([
					reference("segment_character"),
					crate::ast::optional(sequence([
						zero_or_more(reference("segment_inner")),
						reference("segment_character"),
					])),
				]))
				.partition(SEGMENT),
		)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_family_is_valid_and_sealed() {
		let document = family().build().expect("the structure family validates");

		assert_eq!(document.family, FAMILY);
		assert_eq!(document.shapes.len(), 11);
		assert_eq!(document.hash, document.content_hash());
		assert!(document
			.shapes
			.iter()
			.all(|shape| shape.partition.as_deref() == shape.id.split('.').next()));
	}

	#[test]
	fn removing_codepoints_splits_a_range() {
		assert_eq!(without(&[(9, 13), (32, 32)], &[9, 10]), vec![(11, 13), (32, 32)]);
		assert_eq!(without(&[(1, 5)], &[3]), vec![(1, 2), (4, 5)]);
	}
}
