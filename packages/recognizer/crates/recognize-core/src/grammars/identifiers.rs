// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The `identifiers` family: names for a cell, a place or a statistical area, which stand in for a coordinate.
//!
//! - `h3.cell` and `h3.prefixed_cell`: an H3 cell index, 15 hexadecimal digits that start with `8`, bare or behind
//!   `h3:`. The bare form is whole-input only, and the prefixed form is also embedded.
//! - `geohash.prefixed`: one to twelve geohash characters behind `geohash:` or `gh:`, with optional white space after
//!   the colon. A bare hash is also a word, so no shape reads one.
//! - `wof.reference`: `wof:85633793`, `wof 85633793` and `whosonfirst:85633793`. `wof.spelunker_url`: a Spelunker
//!   place page. Both are whole-input only.
//! - `census.geoid_state`, `census.geoid_county`, `census.geoid_tract`, `census.geoid_block_group` and
//!   `census.geoid_block`: the Census GEOIDs of 2, 5, 11, 12 and 15 digits.
//! - `gnis.reference` and `gnis.summary_url`: a GNIS feature identifier behind `gnis:` or `gnis ` or in a summary page
//!   address.
//!
//! # Candidates
//!
//! A GEOID is a bare run of digits, and a bare run of digits is also a house number, a postcode, a count or a year.
//! The family therefore reads a GEOID in whole-input scope only. A recognition of a GEOID, or of a bare H3 cell, is a
//! candidate, and the validator answers only whether the digits have the structure of the identifier. Whether the code
//! names an area that exists is a membership question for the data that owns it. `isDeterministicIdentifier` in
//! `@mailwoman/recognizer/deterministic/identifiers` returns false for these shapes.
//!
//! A bare GNIS number has no shape, as the bare geohash has none. A GNIS feature identifier is an integer of up to ten
//! digits, so every house number and every postcode of up to ten digits is also one. A prefix is the only evidence the
//! text means a GNIS feature.
//!
//! # Ambiguity
//!
//! The digit-only shapes overlap each other where their lengths agree, the primitives' digit runs and decimals, and
//! the postcode shapes of other families. Each overlap is declared with its witness.

use crate::ast::{capture, choice, class, literal, one_or_more, optional, reference, repeat, sequence};
use crate::family::{shape, term, Family};
use crate::grammars::angles::whitespace;
use crate::grammars::coordinates::word_insensitive;
use crate::ir::{Boundary, CaptureType, Scope};

pub const FAMILY: &str = "identifiers";

/// `[\s:]+`, the divider between a prefix and its number.
fn divider() -> crate::ast::Node {
	one_or_more(choice([reference("whitespace"), literal(":")]))
}

/// Fifteen hexadecimal digits that start with `8`.
fn h3_digits() -> crate::ast::Node {
	sequence([class(&[('8', '8')]), repeat(reference("hex_digit"), 14, 14)])
}

/// `http` or `https` and the rest of an address, in either case.
fn web_address(rest: &str) -> crate::ast::Node {
	sequence([
		word_insensitive("http"),
		optional(class(&[('S', 'S'), ('s', 's')])),
		word_insensitive(rest),
	])
}

/// A GEOID shape: the digits of its parts, each a capture.
fn geoid(parts: &[(&str, u32)]) -> crate::ast::Node {
	sequence(
		parts
			.iter()
			.map(|(path, length)| capture(path, repeat(reference("digit"), *length, *length))),
	)
}

/// Builds the family. The grammars are valid by construction, and the module's tests hold that.
pub fn family() -> Family {
	let census = |id: &str, parts: &[(&str, u32)]| {
		// A digit run of the GEOID's length is also a digit run and a signed decimal. A block GEOID, 15 digits, is also
		// an H3 cell that holds only digits.
		let mut builder = shape(id)
			.grammar(geoid(parts))
			.validator("CensusGEOID")
			.scope(Scope::Whole)
			.may_overlap(if id == "census.geoid_block" {
				&["number.digit_run", "number.signed_decimal", "h3.cell"]
			} else {
				&["number.digit_run", "number.signed_decimal"]
			});

		for (path, _) in parts {
			builder = builder.capture(path, CaptureType::Text);
		}

		builder
	};

	Family::new(FAMILY)
		.term(term("digit", class(&[('0', '9')])))
		// The geohash base-32 alphabet in either case: digits and the letters except `a`, `i`, `l` and `o`.
		.term(term(
			"geohash_character",
			class(&[
				('0', '9'),
				('B', 'H'),
				('J', 'K'),
				('M', 'N'),
				('P', 'Z'),
				('b', 'h'),
				('j', 'k'),
				('m', 'n'),
				('p', 'z'),
			]),
		))
		.term(term("hex_digit", class(&[('0', '9'), ('A', 'F'), ('a', 'f')])))
		.term(term("whitespace", whitespace()))
		.shape(census(
			"census.geoid_block",
			&[("state", 2), ("county", 3), ("tract", 6), ("block", 4)],
		))
		.shape(census(
			"census.geoid_block_group",
			&[("state", 2), ("county", 3), ("tract", 6), ("block_group", 1)],
		))
		.shape(census("census.geoid_county", &[("state", 2), ("county", 3)]))
		.shape(census("census.geoid_state", &[("state", 2)]))
		.shape(census(
			"census.geoid_tract",
			&[("state", 2), ("county", 3), ("tract", 6)],
		))
		.shape(
			shape("geohash.prefixed")
				.grammar(sequence([
					choice([word_insensitive("geohash"), word_insensitive("gh")]),
					literal(":"),
					crate::ast::zero_or_more(reference("whitespace")),
					capture("hash", repeat(reference("geohash_character"), 1, 12)),
				]))
				.capture("hash", CaptureType::Text)
				.validator("Geohash")
				.scope(Scope::WholeOrEmbedded)
				.boundary(Boundary::Token),
		)
		.shape(
			shape("gnis.reference")
				.grammar(sequence([
					word_insensitive("gnis"),
					divider(),
					capture("id", repeat(reference("digit"), 1, 10)),
				]))
				.capture("id", CaptureType::Integer)
				.validator("GNISFeatureID")
				.scope(Scope::Whole),
		)
		.shape(
			shape("gnis.summary_url")
				.grammar(sequence([
					web_address("://edits.nationalmap.gov/apps/gaz-domestic/public/summary/"),
					capture("id", repeat(reference("digit"), 1, 10)),
					optional(literal("/")),
				]))
				.capture("id", CaptureType::Integer)
				.validator("GNISFeatureID")
				.scope(Scope::Whole),
		)
		.shape(
			shape("h3.cell")
				.grammar(capture("cell", h3_digits()))
				.capture("cell", CaptureType::Text)
				.validator("H3Cell")
				.scope(Scope::Whole)
				// A cell index of digits only is a digit run, a signed decimal and a block GEOID.
				.may_overlap(&["census.geoid_block", "number.digit_run", "number.signed_decimal"]),
		)
		.shape(
			shape("h3.prefixed_cell")
				.grammar(sequence([word_insensitive("h3:"), capture("cell", h3_digits())]))
				.capture("cell", CaptureType::Text)
				.validator("H3Cell")
				.scope(Scope::WholeOrEmbedded)
				.boundary(Boundary::Token),
		)
		.shape(
			shape("wof.reference")
				.grammar(sequence([
					choice([word_insensitive("whosonfirst"), word_insensitive("wof")]),
					divider(),
					capture("id", repeat(reference("digit"), 1, 16)),
				]))
				.capture("id", CaptureType::Integer)
				.validator("WhosOnFirstID")
				.scope(Scope::Whole),
		)
		.shape(
			shape("wof.spelunker_url")
				.grammar(sequence([
					web_address("://spelunker.whosonfirst.org/id/"),
					capture("id", repeat(reference("digit"), 1, 16)),
					optional(literal("/")),
				]))
				.capture("id", CaptureType::Integer)
				.validator("WhosOnFirstID")
				.scope(Scope::Whole),
		)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_family_is_valid_and_sealed() {
		let document = family().build().expect("the identifiers family validates");

		assert_eq!(document.family, FAMILY);
		assert_eq!(document.shapes.len(), 12);
		assert_eq!(document.hash, document.content_hash());
	}
}
