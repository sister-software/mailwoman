// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The `coordinates` family: WGS84 points in the spellings a search field receives, each with a validator that builds
//! the same payload where the spelling is a pair: the latitude, the longitude and the order they were read in.
//!
//! - `coordinate.decimal_pair`: a signed decimal, a comma or semicolon with optional whitespace around it, a signed
//!   decimal. The captures are `first` and `second`, in the order written. The `WGS84Pair` validator decides which is
//!   the latitude (see [`crate::validators`]).
//! - `coordinate.decimal_pair_spaced`: the same two decimals divided by whitespace alone, in whole-input scope only,
//!   and with a decimal point in at least one of them. The grammar holds no capture, because "at least one of them" is
//!   a choice that would make each capture twice, and the `SpacedPair` validator splits the span at its whitespace. Embedded, the house number and the `5` of `350 5th Ave` would
//!   read as a pair, and `12 34` would be a pair, so the shape reads a whole text and needs the point.
//! - `coordinate.dms_pair`: two angles divided by a comma or a semicolon, at least one of them with a degree, minute
//!   or second mark, a hemisphere letter or the letters `d`, `m` and `s`. `coordinate.dms_pair_spaced`: two angles
//!   divided by whitespace alone, whole-input only. The grammar of an angle is in [`crate::grammars::angles`], and the
//!   `AnglePair` validator reads the span.
//! - `coordinate.labeled_pair`: `lat 48.85 lon 2.29` and `lng=2.29, lat=48.85`, with the labels `lat`, `latitude`,
//!   `lon`, `longitude` and `lng` in either order. The `LabeledPair` validator reads the axis from the labels.
//! - `coordinate.maps_segment`: the `@latitude,longitude,zoom` path segment of a Google Maps link, with the zoom
//!   optional. The `MapsSegment` validator fixes the order at latitude first.
//! - `coordinate.geo_uri`: the `geo:` URI of RFC 5870 section 3.3 with its coordinates, an optional altitude, the
//!   `crs` and `u` parameters in their places, and any further parameters. The `GeoURI` validator checks the ranges
//!   and refuses a coordinate reference system other than WGS84.
//!
//! Whitespace is the set JavaScript's `\s` matches, so the shapes read what `parsePointQuery` reads. An embedded
//! shape that begins or ends with a letter or a digit declares the `token` boundary, so it reports no match that sits
//! inside a longer token such as `flat 5 lon 6`.
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
//! A whitespace-only separator is admitted only in the two shapes with `spaced` in their names, and both are
//! whole-input only. In embedded scope the separator would read every pair of adjacent numbers in an address, such as
//! the house number and the `5` of `350 5th Ave`, as a coordinate candidate.
//!
//! # Ambiguity
//!
//! The shapes of this family accept disjoint languages. A pair of bare decimals is a `decimal_pair` or a
//! `decimal_pair_spaced`, and a pair with a mark or a hemisphere letter is a `dms_pair` or a `dms_pair_spaced`. The
//! family's shapes overlap shapes of other families, which each overlap declares with its witness. The ambiguity is also
//! between spans: `12.5, 45.2` is a pair and also two signed decimals of the `primitives` family, and `geo:40.7,-74.0`
//! holds a pair. The engine reports all of those spans and the consumer rule in the package documentation says when one
//! of them may be trusted without the address encoder.

use crate::ast::{capture, choice, class, literal, one_or_more, optional, reference, sequence, zero_or_more, Node};
use crate::family::{shape, term, Family};
use crate::grammars::angles::{dms_pair, dms_pair_spaced, whitespace};
use crate::grammars::primitives::signed_decimal;
use crate::ir::{Boundary, CaptureType, Scope};

pub const FAMILY: &str = "coordinates";

/// The letters of `text` in either case, as a sequence of two-letter classes.
pub(crate) fn word_insensitive(text: &str) -> Node {
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

/// A decimal that holds a decimal point, with an optional sign: `12.5`, `-.5`.
fn pointed_decimal() -> Node {
	sequence([
		optional(reference("sign")),
		choice([
			sequence([
				one_or_more(reference("digit")),
				literal("."),
				one_or_more(reference("digit")),
			]),
			sequence([literal("."), one_or_more(reference("digit"))]),
		]),
	])
}

/// The label of an axis: `lat` or `latitude`, `lon` or `longitude`, `lng`.
fn axis_label(path: &str) -> Node {
	capture(
		path,
		choice([
			sequence([word_insensitive("lat"), optional(word_insensitive("itude"))]),
			sequence([word_insensitive("lon"), optional(word_insensitive("gitude"))]),
			word_insensitive("lng"),
		]),
	)
}

/// A label, an optional `:` or `=`, and a value with an optional minus and no plus.
fn labeled_value(label: &str, value: &str) -> Node {
	sequence([
		axis_label(label),
		zero_or_more(reference("whitespace")),
		optional(class(&[(':', ':'), ('=', '=')])),
		zero_or_more(reference("whitespace")),
		capture(value, geo_number()),
	])
}

/// Builds the family. The grammar is valid by construction, and the module's tests hold that.
pub fn family() -> Family {
	Family::new(FAMILY)
		.term(term("whitespace", whitespace()))
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
					zero_or_more(reference("whitespace")),
					class(&[(',', ','), (';', ';')]),
					zero_or_more(reference("whitespace")),
					capture("second", signed_decimal()),
				]))
				.capture("first", CaptureType::Decimal)
				.capture("second", CaptureType::Decimal)
				.validator("WGS84Pair")
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(
			shape("coordinate.decimal_pair_spaced")
				.grammar(choice([
					sequence([
						pointed_decimal(),
						one_or_more(reference("whitespace")),
						signed_decimal(),
					]),
					sequence([
						signed_decimal(),
						one_or_more(reference("whitespace")),
						pointed_decimal(),
					]),
				]))
				.validator("SpacedPair")
				.scope(Scope::Whole),
		)
		.shape(
			shape("coordinate.dms_pair")
				.grammar(dms_pair())
				.validator("AnglePair")
				.scope(Scope::WholeOrEmbedded)
				.boundary(Boundary::Token),
		)
		.shape(
			shape("coordinate.dms_pair_spaced")
				.grammar(dms_pair_spaced())
				.validator("AnglePair")
				.scope(Scope::Whole),
		)
		.shape(
			shape("coordinate.labeled_pair")
				.grammar(sequence([
					labeled_value("first_label", "first_value"),
					zero_or_more(reference("whitespace")),
					choice([class(&[(',', ','), (';', ';')]), reference("whitespace")]),
					zero_or_more(reference("whitespace")),
					labeled_value("second_label", "second_value"),
				]))
				.capture("first_label", CaptureType::Text)
				.capture("first_value", CaptureType::Decimal)
				.capture("second_label", CaptureType::Text)
				.capture("second_value", CaptureType::Decimal)
				.validator("LabeledPair")
				.scope(Scope::WholeOrEmbedded)
				.boundary(Boundary::Token),
		)
		.shape(
			shape("coordinate.maps_segment")
				.grammar(sequence([
					literal("@"),
					capture("first", geo_number()),
					literal(","),
					capture("second", geo_number()),
					optional(sequence([
						literal(","),
						one_or_more(class(&[('.', '.'), ('0', '9')])),
						class(&[('Z', 'Z'), ('z', 'z')]),
					])),
				]))
				.capture("first", CaptureType::Decimal)
				.capture("second", CaptureType::Decimal)
				.validator("MapsSegment")
				.scope(Scope::WholeOrEmbedded)
				.boundary(Boundary::Token),
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
		assert_eq!(document.shapes.len(), 7);
		assert_eq!(document.hash, document.content_hash());
	}
}
