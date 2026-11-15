// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The `coordinates` family: decimal WGS84 pairs and `geo:` URIs, each in whole-input and embedded scope.
//!
//! - `coordinate.decimal_pair`: a signed decimal, a comma or semicolon with optional whitespace around it, a signed
//!   decimal. The captures are `first` and `second`, in the order written. The `WGS84Pair` validator decides which is
//!   the latitude (see [`crate::validators`]).
//! - `coordinate.geo_uri`: the `geo:` URI of RFC 5870 section 3.3 with its coordinates, an optional altitude, the
//!   `crs` and `u` parameters in their places, and any further parameters. The `GeoURI` validator checks the ranges
//!   and refuses a coordinate reference system other than WGS84.
//!
//! # What the grammar admits and what the validator refuses
//!
//! The grammar states syntax only. Each range, the reference system and the placement of `crs` and `u` are semantic
//! rules, so a span that breaks one is a candidate whose validation is a typed rejection. The grammar admits one thing
//! RFC 5870 does not: a coordinate with more integer digits than the section 3.3 limit of two for latitude and three
//! for longitude, as long as the number is in range, so `geo:040.5,0` is read as 40.5. The RFC bounds the digits only
//! for WGS84 and the reference system is not known until the parameters are read, so the grammar leaves the bound to
//! the range check.
//!
//! A whitespace-only separator is not admitted. In embedded scope it would read every pair of adjacent numbers in an
//! address, such as the house number and the `5` of `350 5th Ave`, as a coordinate candidate.
//!
//! # Ambiguity
//!
//! No two shapes of the repository's families accept the same text, so the overlap analysis finds no pair to declare.
//! The ambiguity is between spans and not languages: `12.5, 45.2` is a pair and also two signed decimals of the
//! `primitives` family, and `geo:40.7,-74.0` holds a pair. The engine reports all of those spans and the consumer rule
//! in the package documentation says when one of them may be trusted without the address encoder.

use crate::ast::{capture, choice, class, literal, one_or_more, optional, reference, sequence, zero_or_more, Node};
use crate::family::{shape, term, Family};
use crate::grammars::primitives::signed_decimal;
use crate::ir::{CaptureType, Scope};

pub const FAMILY: &str = "coordinates";

/// The letters of `text` in either case, as a sequence of two-letter classes.
fn word_insensitive(text: &str) -> Node {
	sequence(text.chars().map(|letter| {
		let (lower, upper) = (letter.to_ascii_lowercase(), letter.to_ascii_uppercase());

		class(&[(lower, lower), (upper, upper)])
	}))
}

/// RFC 5870 `pnum`: digits with an optional fraction.
fn unsigned_decimal() -> Node {
	sequence([
		one_or_more(reference("digit")),
		optional(sequence([literal("."), one_or_more(reference("digit"))])),
	])
}

/// RFC 5870 `num`: `pnum` with an optional leading minus.
fn geo_number() -> Node {
	sequence([optional(literal("-")), unsigned_decimal()])
}

/// RFC 5870 `paramchar`: an unreserved character, one of `[]:&+$`, or a percent-encoded octet.
fn parameter_character() -> Node {
	choice([
		reference("parameter_character_plain"),
		sequence([literal("%"), reference("hex_digit"), reference("hex_digit")]),
	])
}

/// One further parameter: `;`, a name, and an optional `=` and value.
fn parameter() -> Node {
	sequence([
		literal(";"),
		one_or_more(reference("label_character")),
		optional(sequence([literal("="), one_or_more(parameter_character())])),
	])
}

/// Builds the family. The grammar is valid by construction, and the module's tests hold that.
pub fn family() -> Family {
	Family::new(FAMILY)
		.term(term("ascii_whitespace", class(&[('\t', '\r'), (' ', ' ')])))
		.term(term("digit", class(&[('0', '9')])))
		.term(term("hex_digit", class(&[('0', '9'), ('A', 'F'), ('a', 'f')])))
		// RFC 5870 `labeltext` characters: alphanumerics and the hyphen.
		.term(term(
			"label_character",
			class(&[('-', '-'), ('0', '9'), ('A', 'Z'), ('a', 'z')]),
		))
		// RFC 5870 `unreserved` and `p-unreserved` without the percent-encoded form.
		.term(term(
			"parameter_character_plain",
			class(&[
				('!', '!'),
				('$', '$'),
				('&', '&'),
				// `'`, `(`, `)`, `*` and `+`, then `-` and `.`: the comma between them is not a parameter character.
				('\'', '+'),
				('-', '.'),
				('0', ':'),
				('A', 'Z'),
				('[', '['),
				(']', ']'),
				('_', '_'),
				('a', 'z'),
				('~', '~'),
			]),
		))
		.term(term("sign", class(&[('+', '+'), ('-', '-')])))
		.shape(
			shape("coordinate.decimal_pair")
				.grammar(sequence([
					capture("first", signed_decimal()),
					zero_or_more(reference("ascii_whitespace")),
					class(&[(',', ','), (';', ';')]),
					zero_or_more(reference("ascii_whitespace")),
					capture("second", signed_decimal()),
				]))
				.capture("first", CaptureType::Decimal)
				.capture("second", CaptureType::Decimal)
				.validator("WGS84Pair")
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(
			shape("coordinate.geo_uri")
				.grammar(sequence([
					word_insensitive("geo"),
					literal(":"),
					capture("latitude", geo_number()),
					literal(","),
					capture("longitude", geo_number()),
					optional(sequence([literal(","), capture("altitude", geo_number())])),
					optional(sequence([
						literal(";"),
						word_insensitive("crs"),
						literal("="),
						capture("crs", one_or_more(reference("label_character"))),
					])),
					optional(sequence([
						literal(";"),
						word_insensitive("u"),
						literal("="),
						capture("uncertainty", unsigned_decimal()),
					])),
					optional(capture("parameters", one_or_more(parameter()))),
				]))
				.capture("altitude", CaptureType::Decimal)
				.capture("crs", CaptureType::Text)
				.capture("latitude", CaptureType::Decimal)
				.capture("longitude", CaptureType::Decimal)
				.capture("parameters", CaptureType::Text)
				.capture("uncertainty", CaptureType::Decimal)
				.validator("GeoURI")
				.scope(Scope::WholeOrEmbedded),
		)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_family_is_valid_and_sealed() {
		let document = family().build().expect("the coordinates family validates");

		assert_eq!(document.family, FAMILY);
		assert_eq!(document.shapes.len(), 2);
		assert_eq!(document.hash, document.content_hash());
	}
}
