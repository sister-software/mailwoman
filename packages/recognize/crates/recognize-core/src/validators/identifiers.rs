// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The validators of the `identifiers` family: names for a cell, a place or a statistical area, which are not
//! coordinates but stand in for one.
//!
//! A validator checks the format and builds the canonical text. Whether the identifier names something that exists is a
//! membership question that the caller answers with the data that owns the identifier, so a validated recognition is a
//! candidate and never a confirmed place.
//!
//! # `H3Cell`
//!
//! A cell index is 64 bits: one reserved bit, four mode bits, three reserved bits, four resolution bits, seven base-cell
//! bits and fifteen three-bit digits (the H3 documentation, "H3 Cell Index"). A cell has mode 1, so its canonical string
//! is 15 lowercase hexadecimal digits that start with `8`. This validator checks that format and no more: the base cell
//! range and the digits that stand for resolutions below the cell's own belong to the H3 library.
//!
//! # `Geohash`
//!
//! A geohash is base 32 text over `0123456789bcdefghjkmnpqrstuvwxyz`, which omits `a`, `i`, `l` and `o`. The grammar
//! admits one to twelve characters behind a `geohash:` or `gh:` prefix. A bare hash is also a word, so the family has no
//! shape for one.
//!
//! # `WhosOnFirstID`
//!
//! A Who's On First identifier is a positive integer (the Who's On First documentation, "Portability", calls it a unique
//! 64-bit numeric ID). The validator keeps it to what a JavaScript number holds exactly, up to 2^53 - 1, because the
//! payload reaches a TypeScript consumer as a number.
//!
//! # `CensusGEOID`
//!
//! A Census GEOID concatenates the codes of its parents: the state is 2 digits, the county 3, the tract 6, the block
//! group 1 and the block 4, and the first digit of a block is its block group (the Census Bureau's "GEOID Structure for
//! Geographic Areas"). The GEOIDs of state, county, tract, block group and block are therefore 2, 5, 11, 12 and 15
//! digits. The validator checks the state code against the FIPS codes `@mailwoman/tiger` knows, which the generated
//! module `us_state_fips` holds, because `@mailwoman/recognize` cannot depend on that package.
//!
//! # `GNISFeatureID`
//!
//! A GNIS feature identifier is a positive integer. The Census Bureau's description of GNIS codes (the section "GNIS
//! Codes" of the same page) allows up to 10 digits, so the validator accepts 1 to 9,999,999,999. The USGS pages that
//! define the feature identifier returned no content when this module was written, so the length is the Census
//! Bureau's statement and not USGS's. `@mailwoman/tiger` and `@mailwoman/corpus` read GNIS identifiers as integers from
//! the USGS layer and hold no parser of identifier text, so there is no existing reader to reuse.

use serde::Serialize;

use crate::captures::Captures;
use crate::recognition::Rejection;
use crate::validators::us_state_fips::US_STATE_FIPS;
use crate::validators::{integer, required, FieldType, Integer, PayloadField, Validator};

/// An H3 cell index in its lowercase hexadecimal form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct H3Index {
	pub cell: String,
}

/// `H3Cell`: the `cell` capture is 15 hexadecimal digits that start with `8`.
pub struct H3Cell;

impl Validator for H3Cell {
	type Output = H3Index;

	const ID: &'static str = "H3Cell";

	const PAYLOAD: &'static [PayloadField] = &[PayloadField {
		name: "cell",
		kind: FieldType::Text,
		optional: false,
	}];

	const REJECTIONS: &'static [&'static str] = &["invalid_h3_index", "missing_capture"];

	fn validate(captures: &Captures<'_>) -> Result<H3Index, Rejection> {
		let cell = required(captures, "cell")?.to_ascii_lowercase();

		if cell.len() == 15 && cell.starts_with('8') && cell.chars().all(|digit| digit.is_ascii_hexdigit()) {
			Ok(H3Index { cell })
		} else {
			Err(Rejection::new(
				"invalid_h3_index",
				Some("cell"),
				format!("`{cell}` is not 15 hexadecimal digits that start with 8"),
			))
		}
	}
}

/// A geohash in lowercase.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GeohashText {
	pub hash: String,
}

/// The geohash base-32 alphabet.
const GEOHASH_ALPHABET: &str = "0123456789bcdefghjkmnpqrstuvwxyz";

/// `Geohash`: the `hash` capture is one to twelve characters of the geohash alphabet.
pub struct Geohash;

impl Validator for Geohash {
	type Output = GeohashText;

	const ID: &'static str = "Geohash";

	const PAYLOAD: &'static [PayloadField] = &[PayloadField {
		name: "hash",
		kind: FieldType::Text,
		optional: false,
	}];

	const REJECTIONS: &'static [&'static str] =
		&["invalid_geohash_character", "invalid_geohash_length", "missing_capture"];

	fn validate(captures: &Captures<'_>) -> Result<GeohashText, Rejection> {
		let hash = required(captures, "hash")?.to_ascii_lowercase();

		if !(1..=12).contains(&hash.len()) {
			return Err(Rejection::new(
				"invalid_geohash_length",
				Some("hash"),
				format!("{} characters, and a geohash has one to twelve", hash.len()),
			));
		}

		match hash.chars().find(|character| !GEOHASH_ALPHABET.contains(*character)) {
			Some(character) => Err(Rejection::new(
				"invalid_geohash_character",
				Some("hash"),
				format!("`{character}` is not a geohash character"),
			)),
			None => Ok(GeohashText { hash }),
		}
	}
}

/// The largest integer a JavaScript number holds exactly.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// A Who's On First identifier.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WOFIdentifier {
	pub id: Integer,
}

/// `WhosOnFirstID`: the `id` capture is a positive integer a JavaScript number holds exactly.
pub struct WhosOnFirstID;

impl Validator for WhosOnFirstID {
	type Output = WOFIdentifier;

	const ID: &'static str = "WhosOnFirstID";

	const PAYLOAD: &'static [PayloadField] = &[PayloadField {
		name: "id",
		kind: FieldType::Integer,
		optional: false,
	}];

	const REJECTIONS: &'static [&'static str] = &["id_out_of_range", "missing_capture", "not_an_integer"];

	fn validate(captures: &Captures<'_>) -> Result<WOFIdentifier, Rejection> {
		let id = integer(captures, "id")?;

		if (1..=MAX_SAFE_INTEGER).contains(&id.get()) {
			Ok(WOFIdentifier { id })
		} else {
			Err(Rejection::new(
				"id_out_of_range",
				Some("id"),
				format!(
					"{} is not a positive integer a JavaScript number holds exactly",
					id.get()
				),
			))
		}
	}
}

/// A GNIS feature identifier.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GNISIdentifier {
	pub id: Integer,
}

/// The largest GNIS identifier: ten digits.
const MAX_GNIS_ID: i64 = 9_999_999_999;

/// `GNISFeatureID`: the `id` capture is a positive integer of at most ten digits.
pub struct GNISFeatureID;

impl Validator for GNISFeatureID {
	type Output = GNISIdentifier;

	const ID: &'static str = "GNISFeatureID";

	const PAYLOAD: &'static [PayloadField] = &[PayloadField {
		name: "id",
		kind: FieldType::Integer,
		optional: false,
	}];

	const REJECTIONS: &'static [&'static str] = &["id_out_of_range", "missing_capture", "not_an_integer"];

	fn validate(captures: &Captures<'_>) -> Result<GNISIdentifier, Rejection> {
		let id = integer(captures, "id")?;

		if (1..=MAX_GNIS_ID).contains(&id.get()) {
			Ok(GNISIdentifier { id })
		} else {
			Err(Rejection::new(
				"id_out_of_range",
				Some("id"),
				format!("{} is not a GNIS feature identifier of one to ten digits", id.get()),
			))
		}
	}
}

/// The parts of a Census GEOID the text held, with the level it stops at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CensusParts {
	/// `state`, `county`, `tract`, `block_group` or `block`.
	pub level: String,
	pub state: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub county: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub tract: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub block_group: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub block: Option<String>,
}

/// `CensusGEOID`: the captures `state`, `county`, `tract`, `block_group` and `block` a shape declares are the parts of
/// a GEOID, and the state is a known FIPS code.
pub struct CensusGEOID;

impl Validator for CensusGEOID {
	type Output = CensusParts;

	const ID: &'static str = "CensusGEOID";

	const PAYLOAD: &'static [PayloadField] = &[
		PayloadField {
			name: "level",
			kind: FieldType::Text,
			optional: false,
		},
		PayloadField {
			name: "state",
			kind: FieldType::Text,
			optional: false,
		},
		PayloadField {
			name: "county",
			kind: FieldType::Text,
			optional: true,
		},
		PayloadField {
			name: "tract",
			kind: FieldType::Text,
			optional: true,
		},
		PayloadField {
			name: "block_group",
			kind: FieldType::Text,
			optional: true,
		},
		PayloadField {
			name: "block",
			kind: FieldType::Text,
			optional: true,
		},
	];

	const REJECTIONS: &'static [&'static str] = &["missing_capture", "unknown_state_fips"];

	fn validate(captures: &Captures<'_>) -> Result<CensusParts, Rejection> {
		let state = required(captures, "state")?;

		if !US_STATE_FIPS.contains(&state) {
			return Err(Rejection::new(
				"unknown_state_fips",
				Some("state"),
				format!("`{state}` is not the FIPS code of a state or territory"),
			));
		}

		let part = |path: &str| captures.get(path).map(str::to_string);
		let block = part("block");
		let level = ["block", "block_group", "tract", "county"]
			.into_iter()
			.find(|path| captures.get(path).is_some())
			.unwrap_or("state");

		// The first digit of a block is its block group, so a block-level GEOID names both.
		let block_group = part("block_group").or_else(|| block.as_ref().map(|block| block[..1].to_string()));

		Ok(CensusParts {
			level: level.to_string(),
			state: state.to_string(),
			county: part("county"),
			tract: part("tract"),
			block_group,
			block,
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn captures<'a>(entries: &[(&'a str, &'a str)]) -> Captures<'a> {
		Captures::from_entries("", entries)
	}

	#[test]
	fn a_cell_is_fifteen_hexadecimal_digits_that_start_with_eight() {
		assert_eq!(
			H3Cell::validate(&captures(&[("cell", "8928308280FFFFF")]))
				.unwrap()
				.cell,
			"8928308280fffff"
		);
		assert_eq!(
			H3Cell::validate(&captures(&[("cell", "7928308280fffff")]))
				.unwrap_err()
				.code,
			"invalid_h3_index"
		);
	}

	#[test]
	fn a_geohash_is_one_to_twelve_characters_of_its_alphabet() {
		assert_eq!(
			Geohash::validate(&captures(&[("hash", "EZS42")])).unwrap().hash,
			"ezs42"
		);
		assert_eq!(
			Geohash::validate(&captures(&[("hash", "ezsa2")])).unwrap_err().code,
			"invalid_geohash_character"
		);
		assert_eq!(
			Geohash::validate(&captures(&[("hash", "ezs42ezs42ez0")]))
				.unwrap_err()
				.code,
			"invalid_geohash_length"
		);
	}

	#[test]
	fn a_who_s_on_first_id_is_a_positive_safe_integer() {
		let id = |text: &'static str| WhosOnFirstID::validate(&captures(&[("id", text)]));

		assert_eq!(id("85633793").unwrap().id.get(), 85_633_793);
		assert_eq!(id("9007199254740991").unwrap().id.get(), MAX_SAFE_INTEGER);
		assert_eq!(id("9007199254740992").unwrap_err().code, "id_out_of_range");
		assert_eq!(id("0").unwrap_err().code, "id_out_of_range");
	}

	#[test]
	fn a_gnis_id_is_a_positive_integer_of_at_most_ten_digits() {
		let id = |text: &'static str| GNISFeatureID::validate(&captures(&[("id", text)]));

		assert_eq!(id("1234567").unwrap().id.get(), 1_234_567);
		assert_eq!(id("0").unwrap_err().code, "id_out_of_range");
		assert_eq!(id("10000000000").unwrap_err().code, "id_out_of_range");
	}

	#[test]
	fn a_geoid_names_its_parts_and_checks_the_state() {
		let block = CensusGEOID::validate(&captures(&[
			("state", "06"),
			("county", "037"),
			("tract", "204700"),
			("block", "1002"),
		]))
		.unwrap();

		assert_eq!(block.level, "block");
		assert_eq!(block.block_group.as_deref(), Some("1"));

		let county = CensusGEOID::validate(&captures(&[("state", "06"), ("county", "037")])).unwrap();

		assert_eq!((county.level.as_str(), county.tract), ("county", None));
		assert_eq!(
			CensusGEOID::validate(&captures(&[("state", "03")])).unwrap_err().code,
			"unknown_state_fips"
		);
		assert_eq!(
			CensusGEOID::validate(&captures(&[])).unwrap_err().code,
			"missing_capture"
		);
	}

	#[test]
	fn the_state_table_is_sorted_and_unique() {
		assert!(US_STATE_FIPS.windows(2).all(|pair| pair[0] < pair[1]));
		assert!(US_STATE_FIPS.iter().all(|code| code.len() == 2));
	}
}
