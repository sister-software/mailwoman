// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The coordinates family against the whole repository: a decimal pair or a `geo:` URI is found beside the readings
//! the `primitives` family gives the same text, and nothing in an ordinary address reads as a coordinate.

mod support;

use recognizer_build::{build_repository_families, Limits};
use recognizer_core::{Engine, ValidationResult};

use support::engine_for;

fn engine() -> Engine {
	engine_for(recognizer_core::grammars::families())
}

/// `(shape, start, end)` of every recognition, in the order of a search.
fn shapes(engine: &Engine, text: &str) -> Vec<(String, usize, usize)> {
	engine
		.recognize(text)
		.unwrap()
		.into_iter()
		.map(|recognition| {
			(
				recognition.candidate.shape.to_string(),
				recognition.candidate.start,
				recognition.candidate.end,
			)
		})
		.collect()
}

fn has(found: &[(String, usize, usize)], shape: &str, start: usize, end: usize) -> bool {
	found.iter().any(|entry| entry == &(shape.to_string(), start, end))
}

fn validation_of(engine: &Engine, text: &str, shape: &str) -> ValidationResult {
	engine
		.recognize(text)
		.unwrap()
		.into_iter()
		.find(|recognition| recognition.candidate.shape == shape)
		.unwrap_or_else(|| panic!("no `{shape}` in {text:?}"))
		.validation
}

#[test]
fn a_decimal_pair_is_returned_together_with_its_alternative_readings() {
	let engine = engine();
	let found = shapes(&engine, "12.5, 45.2");

	// The coordinate reading, validated and spanning the whole input.
	assert!(has(&found, "coordinate.decimal_pair", 0, 10));
	assert!(matches!(
		validation_of(&engine, "12.5, 45.2", "coordinate.decimal_pair"),
		ValidationResult::Validated(_)
	));

	// The same characters as two decimal numbers and as digit runs of the `primitives` family.
	assert!(has(&found, "number.signed_decimal", 0, 4));
	assert!(has(&found, "number.signed_decimal", 6, 10));
	assert!(has(&found, "number.digit_run", 0, 2));
	assert!(has(&found, "number.digit_run", 3, 4));
	assert!(has(&found, "number.digit_run", 6, 8));
	assert!(has(&found, "number.digit_run", 9, 10));
}

#[test]
fn a_house_number_reports_its_number_and_no_coordinate() {
	let engine = engine();
	let found = shapes(&engine, "12345 Main Street");

	assert!(has(&found, "number.signed_decimal", 0, 5));
	assert!(has(&found, "number.digit_run", 0, 5));
	assert!(has(&found, "word.ascii", 6, 10));
	assert!(
		!found.iter().any(|(shape, ..)| shape.starts_with("coordinate.")),
		"{found:?}"
	);
}

#[test]
fn ordinary_addresses_read_as_no_coordinate() {
	let engine = engine();

	for text in [
		"350 5th Ave, New York, NY 10118",
		"1600 Pennsylvania Avenue NW, Washington, DC 20500",
		"SW1A 1AA",
		"〒100-0001 東京都千代田区千代田1-1",
		"12 34",
	] {
		let found = shapes(&engine, text);

		assert!(
			!found.iter().any(|(shape, ..)| shape.starts_with("coordinate.")),
			"{text:?}: {found:?}"
		);
	}
}

#[test]
fn a_pair_inside_an_address_is_a_candidate_and_not_the_whole_input() {
	let engine = engine();
	let text = "Apt 4, 12 Main St";
	let found = shapes(&engine, text);

	// "4, 12" is a valid pair, and it covers a small part of the input.
	assert!(has(&found, "coordinate.decimal_pair", 4, 9));
	assert!(!has(&found, "coordinate.decimal_pair", 0, text.len()));
	assert!(matches!(
		validation_of(&engine, text, "coordinate.decimal_pair"),
		ValidationResult::Validated(_)
	));
}

#[test]
fn a_geo_uri_is_found_whole_and_embedded_with_its_nested_pair() {
	let engine = engine();
	let uri = "geo:40.7128,-74.0060";
	let whole = shapes(&engine, uri);

	assert!(has(&whole, "coordinate.geo_uri", 0, uri.len()));
	// The pair inside the URI is a second, nested reading of the same characters.
	assert!(has(&whole, "coordinate.decimal_pair", 4, uri.len()));

	let text = "see geo:40.7128,-74.0060;u=5 for the place";
	let embedded = shapes(&engine, text);

	assert!(has(&embedded, "coordinate.geo_uri", 4, 28), "{embedded:?}");
	assert!(matches!(
		validation_of(&engine, text, "coordinate.geo_uri"),
		ValidationResult::Validated(_)
	));
}

#[test]
fn the_geo_uri_grammar_follows_rfc_5870() {
	let engine = engine();

	for (text, accepted) in [
		("geo:0,0", true),
		("GEO:-90,180", true),
		("geo:48.2010,16.3695,183", true),
		("geo:48.2010,16.3695,-12.5;crs=wgs84;u=40", true),
		("geo:13.4125,103.8667;crs=Moon-2011;u=1;x-y=a%20b", true),
		("geo:1,2;u=1;a=b;c", true),
		// No plus sign, no bare fraction, no exponent, no missing part, no space.
		("geo:+1,2", false),
		("geo:.5,2", false),
		("geo:1e3,2", false),
		("geo:1", false),
		("geo:1,", false),
		("geo: 1,2", false),
		("geo:1, 2", false),
		("geo:1,2;", false),
		("geo:1,2;u=", false),
		("geo:1,2;a=b c", false),
		("geo:1,2;a=%2", false),
		("geo:,1,2", false),
	] {
		let found = shapes(&engine, text);
		let whole = has(&found, "coordinate.geo_uri", 0, text.len());

		assert_eq!(whole, accepted, "{text:?}: {found:?}");
	}
}

#[test]
fn a_geo_uri_that_is_not_wgs84_or_out_of_range_matches_and_is_rejected() {
	let engine = engine();

	for (text, code) in [
		("geo:48.2,16.3;crs=Moon-2011", "unsupported_crs"),
		("geo:94,0", "latitude_out_of_range"),
		("geo:0,181", "longitude_out_of_range"),
		("geo:1,2;x=1;crs=wgs84", "misplaced_parameter"),
		// A negative uncertainty is no `pnum`, so the grammar reads `u=-1` as a further parameter named `u`.
		("geo:1,2;u=-1", "misplaced_parameter"),
	] {
		match validation_of(&engine, text, "coordinate.geo_uri") {
			ValidationResult::Rejected(rejection) => assert_eq!(rejection.code, code, "{text}"),
			other => panic!("{text}: expected a rejection, got {other:?}"),
		}
	}
}

#[test]
fn a_whitespace_only_separator_is_a_pair_in_whole_input_scope_and_never_embedded() {
	let engine = engine();

	for text in ["12.5 45.2", "40.7128 -74.0060"] {
		let found = shapes(&engine, text);

		assert!(has(&found, "coordinate.decimal_pair_spaced", 0, text.len()), "{text}");
		assert!(!has(&found, "coordinate.decimal_pair", 0, text.len()), "{text}");
	}

	// Embedded, the house number and the `5` of `350 5th Ave` would read as a pair; and without a decimal point `12 34` is
	// a house number and a postcode.
	for text in ["350 5th Ave", "12 34", "see 12.5 45.2 now", "Apt 4.5 12 Main St"] {
		assert!(
			!shapes(&engine, text)
				.iter()
				.any(|(shape, ..)| shape == "coordinate.decimal_pair_spaced"),
			"{text}"
		);
	}
}

#[test]
fn the_overlap_analysis_finds_no_language_the_coordinates_family_shares_with_another_recognize_family() {
	let build = build_repository_families(&Limits::default()).unwrap();
	let involved: Vec<_> = build
		.analysis
		.overlaps
		.iter()
		.filter(|overlap| overlap.a.family == "coordinates" || overlap.b.family == "coordinates")
		.collect();

	// The ambiguity of `12.5, 45.2` is between spans, which the engine reports together, and not between languages.
	assert!(involved.is_empty(), "{involved:?}");

	// Every overlap that exists is declared, so none is left without its witness.
	assert!(build.analysis.overlaps.iter().all(|overlap| overlap.declared));
	assert!(build.analysis.unreachable.is_empty());
}
