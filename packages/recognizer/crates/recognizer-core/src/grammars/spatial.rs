// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The `spatial` family: the grid codes and documents that stand for a place on the globe.
//!
//! - `plus_code.token`: an Open Location Code, two to eight digits, `+`, and two or three digits, in either case. The
//!   `PlusCode` validator reads the count before the separator as a full code (eight) or a short code (two, four or
//!   six) and refuses the odd counts. It is whole-input and embedded, with the `token` boundary, so a code inside
//!   `Managua, VFQ6+92P, Nicaragua` is found and the tail of a longer alphanumeric run is not.
//! - `digipin.compact`: ten characters of the DIGIPIN alphabet, whole-input only. Ten digits from `2` to `9` are also
//!   a phone number, a postcode or a count, so no embedded search reads them. `digipin.display`: the display form with
//!   hyphens after the third and sixth characters, whole-input and embedded, because the hyphens make it a code. The
//!   `DIGIPIN` validator reads both.
//! - `geojson.object`: a GeoJSON text. The grammar is the cheap structural test: the text is a JSON object that holds a
//!   `"type"` member with the name of one of the nine GeoJSON objects. A finite automaton cannot check the nesting of
//!   brackets, so the `GeoJSON` validator parses the text with `serde_json`. It is whole-input only, and the engine
//!   refuses a text longer than the family's input limit of 65,536 bytes.
//!
//! Decoding a code to its cell is arithmetic on the grid and stays in `@mailwoman/spatial`.
//!
//! # Ambiguity
//!
//! A compact DIGIPIN is also a digit run, a signed decimal or a word when its characters allow, and it can be a
//! postcode. Each overlap is declared with its witness. A text holding a hyphenated DIGIPIN or a Plus Code is not
//! another family's shape, because both forms carry a character the other families do not combine with these
//! alphabets.

use crate::ast::{choice, class, literal, reference, repeat, sequence, zero_or_more, Node};
use crate::family::{shape, term, Family};
use crate::ir::{Boundary, Scope};

pub const FAMILY: &str = "spatial";

/// Any one character.
fn any() -> Node {
	class(&[('\0', char::MAX)])
}

/// The nine GeoJSON object types, case-sensitive (RFC 7946 section 1.4).
const GEOJSON_TYPES: [&str; 9] = [
	"Feature",
	"FeatureCollection",
	"GeometryCollection",
	"LineString",
	"MultiLineString",
	"MultiPoint",
	"MultiPolygon",
	"Point",
	"Polygon",
];

/// Builds the family. The grammars are valid by construction, and the module's tests hold that.
pub fn family() -> Family {
	let whitespace = || zero_or_more(reference("json_whitespace"));

	Family::new(FAMILY)
		// The Open Location Code alphabet in either case: `23456789CFGHJMPQRVWX`.
		.term(term(
			"olc_digit",
			class(&[
				('2', '9'),
				('C', 'C'),
				('F', 'H'),
				('J', 'J'),
				('M', 'M'),
				('P', 'R'),
				('V', 'X'),
				('c', 'c'),
				('f', 'h'),
				('j', 'j'),
				('m', 'm'),
				('p', 'r'),
				('v', 'x'),
			]),
		))
		// The DIGIPIN alphabet in either case: `23456789CJKLMPFT`.
		.term(term(
			"digipin_character",
			class(&[
				('2', '9'),
				('C', 'C'),
				('F', 'F'),
				('J', 'M'),
				('P', 'P'),
				('T', 'T'),
				('c', 'c'),
				('f', 'f'),
				('j', 'm'),
				('p', 'p'),
				('t', 't'),
			]),
		))
		// The white space JSON allows between tokens (RFC 8259 section 2).
		.term(term(
			"json_whitespace",
			class(&[('\t', '\n'), ('\r', '\r'), (' ', ' ')]),
		))
		.shape(
			shape("plus_code.token")
				.grammar(sequence([
					repeat(reference("olc_digit"), 2, 8),
					literal("+"),
					repeat(reference("olc_digit"), 2, 3),
				]))
				.validator("PlusCode")
				.scope(Scope::WholeOrEmbedded)
				.boundary(Boundary::Token),
		)
		.shape(
			shape("digipin.compact")
				.grammar(repeat(reference("digipin_character"), 10, 10))
				.validator("DIGIPIN")
				.scope(Scope::Whole)
				// Ten digits from 2 to 9 are a digit run and a signed decimal, and ten of the letters are a word.
				.may_overlap(&["number.digit_run", "number.signed_decimal", "word.ascii"]),
		)
		.shape(
			shape("digipin.display")
				.grammar(sequence([
					repeat(reference("digipin_character"), 3, 3),
					literal("-"),
					repeat(reference("digipin_character"), 3, 3),
					literal("-"),
					repeat(reference("digipin_character"), 4, 4),
				]))
				.validator("DIGIPIN")
				.scope(Scope::WholeOrEmbedded)
				.boundary(Boundary::Token),
		)
		.shape(
			shape("geojson.object")
				.grammar(sequence([
					whitespace(),
					literal("{"),
					zero_or_more(any()),
					literal("\"type\""),
					whitespace(),
					literal(":"),
					whitespace(),
					literal("\""),
					choice(GEOJSON_TYPES.map(literal)),
					literal("\""),
					zero_or_more(any()),
					literal("}"),
					whitespace(),
				]))
				.validator("GeoJSON")
				.scope(Scope::Whole),
		)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_family_is_valid_and_sealed() {
		let document = family().build().expect("the spatial family validates");

		assert_eq!(document.family, FAMILY);
		assert_eq!(document.shapes.len(), 4);
		assert_eq!(document.hash, document.content_hash());
	}
}
